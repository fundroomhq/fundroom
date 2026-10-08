import type { AuditRecorder } from "@fundroom/audit";
import {
  type CustomDomain,
  type Database,
  pgErrorCode,
  pgErrorMessage,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import type {
  CustomDomainProviderPort,
  DirectoryPort,
  DnsAnswer,
  DnsInstruction,
  DnsResolverPort,
  JobQueuePort,
  JsonObject,
  ProviderCallContext,
} from "@fundroom/ports";
import { type CustomDomainRejection, checkHostname } from "../hostname.js";
import { CHALLENGE_LABEL, LEGACY_CHALLENGE_LABEL } from "../records.js";
import {
  type AttemptFacts,
  CustomDomainRepo,
  type DomainAnswerRecord,
  type ProviderFacts,
} from "../repos/domains-repo.js";
import { type CustomDomainStatus, nextState, VERIFY_DEADLINE_MS } from "../state.js";
import { challengeToken } from "../token.js";
import { type DnsVerdict, evaluate, txtCarriesToken } from "../verify.js";

/*
 * The admin operations behind §1.9's routes: list, add, verify now, remove — plus `check()`, the
 * single verification pass both jobs share so a poll and a button cannot disagree about what DNS
 * means.
 *
 * Three things this file is responsible for that are easy to get wrong:
 *
 * 1. **Context.** Everything here runs in *tenant* context (`withTenant`): these are a
 *    workspace's own rows, read and written by its own admins, and the audit row has to be
 *    written in the same transaction as the change it records. The host-context reads live in
 *    `lookup.ts` and `jobs.ts`, where there is no workspace yet. Getting this backwards gives
 *    either zero rows or a fence that no longer fences.
 * 2. **Two unique indexes, both SQLSTATE 23505, opposite meanings** (E2.1 §7). A raw constraint
 *    violation must never escape as a 500, and the two must never be conflated: one means
 *    *somebody else* holds the verified claim, the other means *this workspace* already has a
 *    verified hostname. The first must not name the other workspace — that is a tenancy leak.
 * 3. **Cache invalidation on every state change.** The lookup cache answers `ask` and the tenant
 *    classifier for 60 s, and the single-tenant workspace resolver caches the whole
 *    `ResolvedWorkspace` — including `primaryHost` — for 30 s. A status change that does not
 *    invalidate both serves a stale origin, or a hostname whose claim has moved.
 */

/** What the service needs from a `Database`; the composition root passes the whole thing. */
export type CustomDomainDb = Pick<Database, "withTenant">;

/** Just the invalidation half of `CustomDomainLookup` / `WorkspaceResolver`. */
export interface DomainCaches {
  /** The hostname → workspace cache in `lookup.ts`. */
  readonly lookup: { invalidate(hostname?: string): void };
  /** The single-tenant `ResolvedWorkspace` cache, which now holds `primaryHost` (E2.1 §6.5). */
  readonly workspaces: { invalidate(): void };
}

/** Who is making the change; mirrors `@fundroom/compliance`'s `Actor`. */
export interface Actor {
  readonly membershipId?: string | undefined;
  readonly userId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly sessionId?: string | undefined;
}

/** The repo surface the service uses. A seam: unit tests pass a fake, the default is the repo. */
export interface CustomDomainStore {
  list(): Promise<CustomDomain[]>;
  byId(id: string): Promise<CustomDomain | undefined>;
  byHostname(hostname: string): Promise<CustomDomain | undefined>;
  verified(): Promise<CustomDomain | undefined>;
  create(values: {
    readonly hostname: string;
    readonly token: string;
    readonly firstAttemptAt: Date;
    readonly createdBy?: string | null | undefined;
  }): Promise<CustomDomain>;
  recordAttempt(
    id: string,
    facts: AttemptFacts & { readonly consecutiveFailures: number },
  ): Promise<CustomDomain | undefined>;
  markDnsOk(id: string, facts: AttemptFacts): Promise<CustomDomain | undefined>;
  markActive(id: string, facts: AttemptFacts): Promise<CustomDomain | undefined>;
  /** `dns_ok → active` on a served request; writes no DNS facts. See the repo. */
  markServing(id: string, at: Date): Promise<CustomDomain | undefined>;
  markFailed(
    id: string,
    facts: AttemptFacts & { readonly consecutiveFailures: number },
  ): Promise<CustomDomain | undefined>;
  demote(id: string, facts: AttemptFacts): Promise<CustomDomain | undefined>;
  reopen(id: string, at: Date): Promise<CustomDomain | undefined>;
  softDelete(id: string, at: Date): Promise<boolean>;
  /** Replaces `last_answer.provider` only (E3.10). See the repo. */
  recordProvider(id: string, provider: ProviderFacts): Promise<CustomDomain | undefined>;
  /** The per-hostname advisory lock shared with the release job (E3.10 FR3). See the repo. */
  lockHostname(hostname: string): Promise<void>;
}

export interface CustomDomainDeps {
  readonly db: CustomDomainDb;
  readonly audit: Pick<AuditRecorder, "record">;
  readonly resolver: DnsResolverPort;
  readonly provider: CustomDomainProviderPort;
  readonly caches: DomainCaches;
  /** `config.canonicalHost`: the host we already serve, which no workspace may claim. */
  readonly canonicalHost: string;
  /**
   * `CUSTOM_DOMAIN_CNAME_TARGET` — what a customer's CNAME must point at. Defaults to the
   * canonical host on a self-hosted install; on a `manual` install it is the operator's own
   * edge, which is only ever shown as guidance because `manual` does not check the CNAME.
   *
   * **May not be empty when `provider.requires.cname` is true** — see the construction guard
   * below. An empty target makes `cnameOk` permanently false, so every domain on the install
   * would be unverifiable with nothing wrong in anybody's zone.
   */
  readonly cnameTarget: string;
  /** HMAC key for `challengeToken`. Rotating it invalidates every outstanding challenge. */
  readonly tokenKey: Uint8Array;
  /**
   * **Optional override** (`CUSTOM_DOMAIN_EDGE_ADDRESSES`) for the addresses a zone apex may
   * point at, for an apex that cannot hold a CNAME (design/07 §2.3(a)).
   *
   * Left empty — the normal case, and the one that needs no operator knowledge — the verifier
   * resolves `cnameTarget`'s own `A`/`AAAA` through the same resolver and accepts the apex when
   * the address sets intersect. That is what CNAME flattening *is*, it needs no configuration,
   * and it stays correct when the edge's address changes. Set the override only when the edge
   * answers on stable anycast addresses that its own DNS does not describe.
   */
  readonly edgeAddresses?: readonly string[] | undefined;
  /**
   * How long a resolved set of edge addresses is reused. Every row in a sweep has the same edge,
   * so this is what makes the target lookup cost one query per sweep rather than one per row.
   * 60 s by default, which is shorter than the 5-minute verify tick.
   */
  readonly edgeAddressTtlMs?: number | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
  /** Test seam. Defaults to `new CustomDomainRepo(ctx, tx)`. */
  readonly store?: ((ctx: TenantContext, tx: Tx) => CustomDomainStore) | undefined;
  /**
   * Where a provider release (`deactivate`) is queued (E3.10 FR1). With a provider that keeps
   * state of its own (`status()` present — `cloudflare-saas`), a demotion, failure or removal
   * enqueues `domains.provider-release` in the SAME transaction as the status change (the outbox),
   * and that job retries until the provider confirms the hostname gone — a release that failed
   * once must not leave a certificate being served for a name we no longer verify. Absent (unit
   * tests): the provider is told directly after the commit, best effort, as before.
   */
  readonly queue?: Pick<JobQueuePort, "sendInTransaction"> | undefined;
  /**
   * Plan quota (E3.10, `ModuleServices.quota`): `add` checks `customDomains` on its transaction,
   * and so does "Verify now" when it reopens a `failed` row (a failed row does not count against
   * the plan, a reopened one does), and lets the 402 `plan_limit` error through. Absent:
   * unlimited (every self-hosted install).
   */
  readonly quota?:
    | {
        check(
          tx: Tx,
          input: { workspaceId: string; kind: "customDomains"; delta: number },
        ): Promise<void>;
      }
    | undefined;
  /**
   * E3.11: the cell directory, where a VERIFIED hostname is claimed across every cell. A row
   * entering a verified state (`dns_ok`) claims it before the local write; `taken` (another
   * cell's workspace holds it) refuses the promotion exactly like the local claim index does —
   * never naming the holder — and an unreachable directory refuses it as a failed attempt too.
   * A row leaving the verified states, or removed while verified, releases it after the commit
   * (best effort; the directory's reconcile sweep repairs a miss). Absent / local mode: no-ops.
   */
  readonly directory?: Pick<DirectoryPort, "claimHost" | "releaseHost"> | undefined;
  /**
   * E3.11 RR1-8: make the workspace's directory entry live now (what the reconcile sweep would
   * do), when a claim is refused for want of one. Throws what the directory throws.
   */
  readonly repairEntry?: ((workspaceId: string) => Promise<void>) | undefined;
}

export const CUSTOM_DOMAIN_ERROR_CODES = [
  "not_found",
  /** `checkHostname` refused the input; `details.reason` is the `CustomDomainRejection`. */
  "invalid_hostname",
  /** This workspace already has a live row for that hostname. */
  "duplicate",
  /** This workspace already has a verified hostname; `details.hostname` names it. */
  "workspace_already_verified",
  /** Another workspace holds the verified claim. Never names it. */
  "claimed_elsewhere",
] as const;
export type CustomDomainErrorCode = (typeof CUSTOM_DOMAIN_ERROR_CODES)[number];

export class CustomDomainError extends Error {
  override readonly name = "CustomDomainError";
  constructor(
    readonly code: CustomDomainErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export function isCustomDomainError(e: unknown): e is CustomDomainError {
  return e instanceof CustomDomainError;
}

/**
 * E3.11 RR1-8: the directory refused the claim because this workspace has no live entry
 * (`no_entry`) or its cell belongs to another database (`cell_conflict`) — an answer about us,
 * not a failure to answer.
 */
function isEntryProblem(error: unknown): boolean {
  const reason = (error as { details?: { reason?: unknown } } | null)?.details?.reason;
  return reason === "no_entry" || reason === "cell_conflict";
}

/**
 * "Another workspace holds the verified claim" — one sentence for the local claim index and the
 * cell directory alike (E3.11 R2-11), naming neither the workspace nor where it lives.
 */
function claimedElsewhere(hostname: string): CustomDomainError {
  return new CustomDomainError(
    "claimed_elsewhere",
    `${hostname} is already verified for another workspace on this install. It has to be released there before it can be verified here.`,
    { hostname },
  );
}

/** The three unique indexes of `core.custom_domain`, and what each one means. */
export const CUSTOM_DOMAIN_CONSTRAINTS = [
  "custom_domain_claim_idx",
  "custom_domain_one_per_workspace_idx",
  "custom_domain_ws_host_idx",
] as const;
export type CustomDomainConstraint = (typeof CUSTOM_DOMAIN_CONSTRAINTS)[number];

/**
 * Which of our unique indexes a failed write violated, or `undefined` when the error is not one
 * of ours and must be rethrown.
 *
 * The **code is not enough**: all three are `23505`, and two of them mean opposite things (E2.1
 * §7). `pg` puts the index name in `constraint`; drizzle wraps the driver error, so the cause
 * chain is walked, and the message is scanned as a fallback because the wrapped message carries
 * `… violates unique constraint "custom_domain_claim_idx"` verbatim.
 */
export function uniqueViolationOf(error: unknown): CustomDomainConstraint | undefined {
  if (pgErrorCode(error) !== "23505") return undefined;
  const name = constraintNameOf(error);
  return CUSTOM_DOMAIN_CONSTRAINTS.find((c) => c === name);
}

/**
 * The constraint name a failed write violated, from wherever the driver put it.
 *
 * `pg` sets `constraint`; drizzle wraps the driver error, so the cause chain is walked, and the
 * message is scanned as a fallback because the wrapped message carries
 * `… violates unique constraint "custom_domain_claim_idx"` verbatim.
 */
function constraintNameOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    const name = (current as { constraint?: unknown }).constraint;
    if (typeof name === "string" && name !== "") return name;
    current = (current as { cause?: unknown }).cause;
  }
  return /violates [a-z ]*constraint "([^"]+)"/u.exec(pgErrorMessage(error))?.[1];
}

const REJECTION_MESSAGES: Readonly<Record<CustomDomainRejection, string>> = {
  empty: "enter a hostname",
  not_a_hostname: "that is not a hostname",
  ip_literal: "enter a hostname, not an IP address",
  wildcard: "wildcards are not supported: add the exact hostname you want the portal served on",
  too_long: "that hostname is too long (63 characters per label, 253 in total)",
  public_suffix: "that is a public suffix, not a hostname you can own",
  reserved: "that name is reserved and can never be issued a certificate",
  canonical_host: "that is this install's own hostname",
  canonical_subdomain: "that is a subdomain of this install's own hostname and already routes",
};

export interface CustomDomainView {
  readonly id: string;
  readonly hostname: string;
  readonly status: CustomDomainStatus;
  /** Derived on every read, never stored (E2.1 decision 4). */
  readonly records: readonly DnsInstruction[];
  /** The last resolver answers, for the "last resolver answer shown in UI" (§9.2). */
  readonly answer: DomainAnswerRecord | null;
  /** One operator-facing sentence naming what DNS actually said. */
  readonly detail: string | null;
  readonly consecutiveFailures: number;
  readonly firstAttemptAt: Date;
  /** When a `pending` row gives up: `first_attempt_at + VERIFY_DEADLINE_MS`. */
  readonly deadlineAt: Date;
  readonly lastCheckedAt: Date | null;
  readonly dnsOkAt: Date | null;
  readonly activatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  /**
   * E3.10: what a certificate-issuing provider (`cloudflare-saas`) last said, and the extra
   * records it asks for. Absent for `caddy-ask` / `manual`, and until the provider was asked.
   */
  readonly providerState?: ProviderFacts["state"] | undefined;
  readonly providerRecords?: readonly DnsInstruction[] | undefined;
}

/** How a check was triggered (E3.10 FR3): which of the provider's call budgets it draws on. */
export interface CheckOptions {
  /** `interactive` for "Verify now"; the sweeps are `background` (the default). */
  readonly priority?: "background" | "interactive" | undefined;
}

export interface CustomDomainService {
  /** Which provider is configured; the admin screen explains `manual` differently. */
  readonly driver: string;
  /**
   * E3.10: the provider has `status()`, so `dns_ok → active` is the provider's verdict (polled
   * by the verify sweep, which then also sweeps `dns_ok` rows) and never the serving path's.
   */
  readonly pollsProvider: boolean;
  list(ctx: TenantContext): Promise<readonly CustomDomainView[]>;
  add(
    ctx: TenantContext,
    input: { readonly hostname: string; readonly actor?: Actor | undefined },
  ): Promise<CustomDomainView>;
  /** "Verify now". Reopens a `failed` row first, so the button always means something. */
  verifyNow(ctx: TenantContext, id: string, actor?: Actor): Promise<CustomDomainView>;
  remove(ctx: TenantContext, id: string, actor?: Actor): Promise<boolean>;
  /**
   * One verification pass over one row: resolve, judge, apply the state machine, audit, invalidate.
   * Shared by "Verify now" and both jobs. `undefined` when the row is gone (a sweep races a
   * removal). Never throws for a DNS problem — that is a verdict, not an error.
   */
  check(
    ctx: TenantContext,
    id: string,
    actor?: Actor,
    options?: CheckOptions,
  ): Promise<CustomDomainView | undefined>;
  /**
   * `dns_ok → active`: a request was actually served on the hostname (E2.1 S2).
   *
   * The **only** writer of `active`, and it does no DNS work: the evidence is that the classifier
   * routed a live request through the hostname, which means the TLS handshake completed and a
   * certificate exists. A DNS verdict cannot establish that — the zone may carry a CAA record
   * excluding our CA, or the ACME account may be rate-limited — and `active` is what
   * `primaryHost` keys off, so every emailed link depends on this being true rather than likely.
   *
   * Idempotent and quiet: a row that is not `dns_ok` is left alone and reported as `false`.
   */
  markServing(ctx: TenantContext, id: string): Promise<boolean>;
}

/** The provider's id for a row's hostname, when one was stored (E3.10 FR1). */
function providerRefOf(row: CustomDomain): string | undefined {
  return (row.lastAnswer as DomainAnswerRecord | null)?.provider?.ref;
}

function isIpv4(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(value);
}

/** See `edgeAddressTtlMs`: one target lookup per sweep, not per row. */
export const EDGE_ADDRESS_TTL_MS = 60_000;

/**
 * A provider is not asked about the same domain twice within this long (E3.10 FR1): "Verify now"
 * pressed repeatedly answers from the facts stored by the last call instead of spending the
 * install's Cloudflare budget. Well under the verify sweep's 5-minute provider poll.
 */
export const PROVIDER_RECHECK_MS = 60_000;

/** The outbox job that releases a hostname at the provider (see `CustomDomainDeps.queue`). */
export const JOB_PROVIDER_RELEASE = "domains.provider-release";

/** `domains.provider-release` payload. `workspaceId` scopes the dead-letter view (E2.7). */
export interface ProviderReleaseJob {
  readonly workspaceId: string;
  readonly domainId: string;
  readonly hostname: string;
  readonly ref?: string | undefined;
}

export function createCustomDomainService(deps: CustomDomainDeps): CustomDomainService {
  const requires = deps.provider.requires;

  // Two invariants worth failing startup over rather than discovering from a founder's support
  // ticket 72 hours later.
  //
  // 1. A provider that requires no TXT challenge would verify a hostname on no proof of
  //    control at all, which is a tenant-resolution bypass: whoever can point a CNAME at us
  //    could claim somebody else's name. Neither shipped provider does this; the guard exists
  //    so a future one cannot do it by omission.
  if (!requires.txt) {
    throw new Error(
      `custom domain provider "${deps.provider.driver}" requires no TXT challenge; ownership of a hostname cannot be established without one`,
    );
  }
  // 2. `cnameOk` is `false` for every possible answer when the target is empty, so a provider
  //    that gates on the CNAME plus an unset target means "no domain on this install can ever
  //    verify" — silently, and only visible as a 72-hour timeout. Refused here rather than
  //    typed away: the value arrives from the environment as a `string`, so a non-empty type
  //    would only move the same runtime check to the config boundary and leave this one
  //    trusting a cast. `manual` is unaffected, which is what lets it run with no target.
  if (requires.cname && deps.cnameTarget.trim() === "") {
    throw new Error(
      `custom domain provider "${deps.provider.driver}" verifies the CNAME record, but CUSTOM_DOMAIN_CNAME_TARGET is empty: set it to the hostname customers should CNAME at, or use the "manual" driver to verify ownership only`,
    );
  }

  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const storeFor = deps.store ?? ((ctx: TenantContext, tx: Tx) => new CustomDomainRepo(ctx, tx));
  const edgeOverride = (deps.edgeAddresses ?? []).map((a) => a.trim().toLowerCase());
  const edgeAddressTtlMs = deps.edgeAddressTtlMs ?? EDGE_ADDRESS_TTL_MS;
  /** `A` and `AAAA` of the CNAME target, memoised for a sweep. */
  const edgeCache = new Map<"A" | "AAAA", { addresses: readonly string[]; until: number }>();

  /**
   * The addresses an apex is allowed to point at, for one address family.
   *
   * Two sources, in order (E2.1 S1):
   *
   *  1. `CUSTOM_DOMAIN_EDGE_ADDRESSES`, when the operator set it. For a stable anycast edge whose
   *     own DNS does not name the addresses traffic actually arrives on.
   *  2. Otherwise **the CNAME target's own `A`/`AAAA`, resolved through the same DoH resolvers**.
   *     This is the path that ships by default and the reason apex domains work at all: an
   *     operator should not have to know their edge's addresses, and a hard-coded list is wrong
   *     the day the edge moves. One extra lookup per family per sweep — the answer is identical
   *     for every row, so it is cached for `edgeAddressTtlMs`, which is shorter than the
   *     5-minute tick.
   *
   * An empty result means this family cannot be checked (no override, and the target published
   * no record of that type), which leaves `cnameOk` false and the stored sentence saying what
   * DNS actually said.
   */
  async function edgeAddressesFor(type: "A" | "AAAA"): Promise<readonly string[]> {
    if (edgeOverride.length > 0) {
      return edgeOverride.filter((a) => isIpv4(a) === (type === "A"));
    }
    const target = deps.cnameTarget.trim().toLowerCase();
    if (target === "") return [];
    const at = now().getTime();
    const hit = edgeCache.get(type);
    if (hit !== undefined && hit.until > at) return hit.addresses;
    const answer = await deps.resolver.resolve(target, type);
    // Only an `ok` answer describes the edge; a SERVFAIL or a no-quorum answer must not become
    // an empty allow-list that reads as "the apex is wrong".
    const addresses = answer.rcode === "ok" ? answer.values.map((v) => v.toLowerCase()) : [];
    edgeCache.set(type, { addresses, until: at + edgeAddressTtlMs });
    if (addresses.length === 0) {
      log("domains.edge_addresses_unknown", {
        level: "warn",
        target,
        type,
        rcode: answer.rcode,
        resolver: answer.resolver,
      });
    }
    return addresses;
  }

  function view(row: CustomDomain): CustomDomainView {
    const provider = (row.lastAnswer as DomainAnswerRecord | null)?.provider;
    return {
      id: row.id,
      hostname: row.hostname,
      status: row.status,
      records: deps.provider.instructions({ hostname: row.hostname, token: row.token }),
      answer: (row.lastAnswer as DomainAnswerRecord | null) ?? null,
      detail: row.lastDetail,
      consecutiveFailures: row.consecutiveFailures,
      firstAttemptAt: row.firstAttemptAt,
      deadlineAt: new Date(row.firstAttemptAt.getTime() + VERIFY_DEADLINE_MS),
      lastCheckedAt: row.lastCheckedAt,
      dnsOkAt: row.dnsOkAt,
      activatedAt: row.activatedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(provider === undefined
        ? {}
        : { providerState: provider.state, providerRecords: provider.records }),
    };
  }

  /** `status?` present: the provider issues certificates itself and has a view of its own. */
  const pollsProvider = typeof deps.provider.status === "function";

  function errorText(error: unknown): string {
    return (error instanceof Error ? error.message : String(error)).slice(0, 300);
  }

  /**
   * Registers the hostname with the provider and returns what to store (E3.10). Never throws: a
   * failure is recorded (`registered: false`) and the next verify sweep retries it, because an
   * `activate` that failed once — a 429, a timeout — must not strand the row in `dns_ok`.
   */
  async function register(
    ctx: TenantContext,
    hostname: string,
    previous: ProviderFacts | undefined,
    call: ProviderCallContext,
  ) {
    const at = now().toISOString();
    try {
      // Wait out any `domains.provider-release` of this hostname in flight (FR3): it holds this
      // lock from its "still held?" read through its DELETE, and this row is verified (committed)
      // by now, so a release that starts after this sees it and stands down.
      await deps.db.withTenant(ctx, (tx) => storeFor(ctx, tx).lockHostname(hostname));
      const out = await deps.provider.activate(hostname, call);
      const ref = out === undefined ? undefined : out.ref;
      const facts: ProviderFacts = {
        state: "pending",
        detail: null,
        records: (out === undefined ? undefined : out.records) ?? [],
        registered: true,
        checkedAt: at,
        ...(ref === undefined ? {} : { ref }),
      };
      return facts;
    } catch (error) {
      log("domains.provider_failed", {
        level: "warn",
        hostname,
        status: "dns_ok",
        error: errorText(error),
      });
      const facts: ProviderFacts = {
        state: previous?.state ?? "pending",
        detail: previous?.detail ?? null,
        records: previous?.records ?? [],
        registered: false,
        checkedAt: at,
        error: errorText(error),
        ...(previous?.ref === undefined ? {} : { ref: previous.ref }),
      };
      return facts;
    }
  }

  /**
   * One provider interaction for a verified row (E3.10): register it if that never succeeded,
   * else ask for its status. Exactly one of the two per check, so a sweep never calls the provider
   * more than once per domain per run (Cloudflare: 1 200 requests / 5 min). A failed call —
   * including a rate limit, which the adapter answers locally without a request until
   * `retry-after` — keeps the previous facts and records the error: "we could not ask" is not
   * "the provider said no", and must never fail or promote the domain.
   */
  async function consultProvider(
    ctx: TenantContext,
    hostname: string,
    previous: ProviderFacts | undefined,
    call: ProviderCallContext,
  ): Promise<{ facts: ProviderFacts; said: ProviderFacts["state"] | undefined }> {
    // Asked less than a minute ago (registered or not): answer from what it said then. Nothing is
    // acted on — whatever that answer warranted was already done by the check that got it.
    if (previous !== undefined) {
      const last = Date.parse(previous.checkedAt);
      if (Number.isFinite(last) && now().getTime() - last < PROVIDER_RECHECK_MS) {
        return { facts: previous, said: undefined };
      }
    }
    if (previous?.registered !== true) {
      const facts = await register(ctx, hostname, previous, call);
      // A fresh registration is `pending` by definition; nothing to act on until the next poll.
      return { facts, said: undefined };
    }
    const at = now().toISOString();
    try {
      // biome-ignore lint/style/noNonNullAssertion: only called when `pollsProvider`
      const status = await deps.provider.status!(hostname, previous.ref, call);
      const ref = status.ref ?? previous.ref;
      return {
        facts: {
          state: status.state,
          detail: status.detail,
          records: status.records,
          registered: true,
          checkedAt: at,
          ...(ref === undefined ? {} : { ref }),
        },
        said: status.state,
      };
    } catch (error) {
      log("domains.provider_status_failed", {
        level: "warn",
        hostname,
        error: errorText(error),
      });
      return { facts: { ...previous, checkedAt: at, error: errorText(error) }, said: undefined };
    }
  }

  /** The outbox path for provider releases; see `CustomDomainDeps.queue`. */
  const queuedRelease = pollsProvider && deps.queue !== undefined;

  /** Enqueues `domains.provider-release` on the caller's transaction (the outbox). */
  async function enqueueRelease(
    tx: Tx,
    input: { workspaceId: string; domainId: string; hostname: string; ref: string | undefined },
  ): Promise<void> {
    const job: ProviderReleaseJob & JsonObject = {
      workspaceId: input.workspaceId,
      domainId: input.domainId,
      hostname: input.hostname,
      ...(input.ref === undefined ? {} : { ref: input.ref }),
    };
    // biome-ignore lint/style/noNonNullAssertion: only called when `queuedRelease`
    await deps.queue!.sendInTransaction(tx, JOB_PROVIDER_RELEASE, job);
  }

  /**
   * Both caches, after the transaction has committed. Before the commit another reader could
   * repopulate the entry we just dropped from the pre-commit snapshot.
   */
  function invalidate(hostname: string): void {
    deps.caches.lookup.invalidate(hostname);
    deps.caches.workspaces.invalidate();
  }

  /** Translates a 23505 into the one honest answer for that index, or rethrows. */
  async function mapViolation(
    ctx: TenantContext,
    error: unknown,
    hostname: string,
  ): Promise<CustomDomainError> {
    /*
     * A CHECK violation is a 400, defensively (E2.1 M6).
     *
     * `normalizeHostname` is aligned with `custom_domain_hostname_format`, so this branch should
     * be unreachable — but that alignment is two regexes in two languages in two files, and the
     * last time they diverged (`q.123abc` passed the validator and violated the CHECK) a
     * mismatch escaped as a **500** on a request whose honest answer was "that is not a
     * hostname". A constraint that fires means the caller's data broke a stated rule, which is a
     * 400 whichever rule it was, so a future divergence degrades to an honest error instead of
     * an internal one.
     */
    if (pgErrorCode(error) === "23514") {
      const constraint = constraintNameOf(error);
      return new CustomDomainError(
        "invalid_hostname",
        constraint === "custom_domain_hostname_format" || constraint === undefined
          ? `${hostname} is not a hostname this install can store`
          : `that value is not one this install can store (${constraint})`,
        constraint === "custom_domain_hostname_format" || constraint === undefined
          ? { reason: "not_a_hostname" }
          : { constraint },
      );
    }
    const constraint = uniqueViolationOf(error);
    if (constraint === undefined) throw error;
    switch (constraint) {
      case "custom_domain_claim_idx":
        // §9.2's domain-move case. The other workspace has to release it or lose it on
        // re-verification; we do not tell this admin to delete something of theirs, and we do
        // NOT name the other workspace — which workspace holds a hostname is not their business.
        return claimedElsewhere(hostname);
      case "custom_domain_one_per_workspace_idx": {
        // Their own row, so naming it is not a leak — it is the only actionable answer.
        const existing = await deps.db.withTenant(ctx, (tx) => storeFor(ctx, tx).verified());
        return new CustomDomainError(
          "workspace_already_verified",
          existing === undefined
            ? "this workspace already has a verified domain; remove it first"
            : `this workspace already has a verified domain (${existing.hostname}); remove it first`,
          existing === undefined ? {} : { hostname: existing.hostname },
        );
      }
      case "custom_domain_ws_host_idx":
        return new CustomDomainError("duplicate", `${hostname} is already on this list`, {
          hostname,
        });
      default:
        throw error;
    }
  }

  /**
   * The TXT answer the verdict is judged on, and the label it was looked up under (A-2).
   *
   * The rule: **the domain is proven if either label carries this row's token** —
   * `_fundroom-challenge` first, `_seedhost-challenge` (`LEGACY_CHALLENGE_LABEL`) only when the
   * current label did not carry it, whatever the reason (NXDOMAIN, no TXT, a SERVFAIL or a
   * resolver split, or a different token). Both names sit under the customer's hostname, so only
   * whoever controls that zone can publish either, and the token is per workspace and hostname:
   * the two are the same proof under two names. A wrong value under the new label therefore
   * neither blocks nor helps — it is not "rescued" by the old label, the old label is checked on
   * its own merits and passes only if it holds the right token.
   *
   * What the fallback must not weaken:
   *  - **Quorum.** Each label is one `resolver.resolve` call, so each is a whole quorum decision
   *    by the adapter (distinct resolvers agreeing on that name). Answers are never merged across
   *    labels: a verdict rests on exactly one answer that met quorum by itself, and a positive one
   *    still needs `rcode === "ok"` (`txtCarriesToken`).
   *  - **The DoH budget.** The second lookup is made only when the first did not verify, so a
   *    domain on the current label costs what it always did; one still on the old label costs one
   *    extra TXT query per check.
   *  - **What the row records.** The stored `answer.txt` and the sentence are the answer that
   *    decided: the legacy one on a legacy match (so the screen names the record that is doing the
   *    work), otherwise the current label's — a failure is described against the label the
   *    instructions show, which is the one the customer should fix.
   */
  async function proofOfControl(
    hostname: string,
    token: string,
    current: DnsAnswer,
  ): Promise<{ txt: DnsAnswer; txtLabel: string }> {
    if (txtCarriesToken(current, token)) return { txt: current, txtLabel: CHALLENGE_LABEL };
    const legacy = await deps.resolver.resolve(`${LEGACY_CHALLENGE_LABEL}.${hostname}`, "TXT");
    return txtCarriesToken(legacy, token)
      ? { txt: legacy, txtLabel: LEGACY_CHALLENGE_LABEL }
      : { txt: current, txtLabel: CHALLENGE_LABEL };
  }

  /**
   * Resolve and judge. Never throws for a DNS-level problem: `DnsResolverPort` reports a
   * transport failure as `rcode: "other"`, which `evaluate` turns into a sentence.
   */
  async function judge(
    hostname: string,
    token: string,
  ): Promise<{ verdict: DnsVerdict; answer: DomainAnswerRecord }> {
    const target = deps.cnameTarget;
    // The `requires.cname` half is guarded at construction, so this can only be a `manual`
    // install with no edge host configured — where an empty target is correct and not a
    // problem, because nothing is matched against it.
    const [cname, current] = await Promise.all([
      // The CNAME is resolved even when it is not required: it is the answer the admin screen
      // shows ("last resolver answer", §9.2), and "where does this name actually point" is the
      // first thing an operator asks. It just does not gate the verdict on a `manual` install.
      deps.resolver.resolve(hostname, "CNAME"),
      deps.resolver.resolve(`${CHALLENGE_LABEL}.${hostname}`, "TXT"),
    ]);
    const { txt, txtLabel } = await proofOfControl(hostname, token, current);
    let verdict = evaluate({ cname, txt, token, cnameTarget: target, requires, txtLabel });
    const answer: {
      -readonly [K in keyof Omit<DomainAnswerRecord, "provider">]: DnsAnswer | undefined;
    } = {
      cname,
      txt,
    };
    // Apex flattening only exists to satisfy a required CNAME, so a provider that does not
    // require one must not spend more DoH queries per check looking for it.
    if (!requires.cname || verdict.cnameOk) return { verdict, answer };
    // A name that answered NXDOMAIN does not exist at all, and a name that *has* a CNAME (to
    // somewhere else) cannot also hold address records — DNS forbids it. Neither can be a
    // flattened apex, so neither is worth two more lookups.
    if (cname.rcode === "nxdomain" || cname.values.length > 0) return { verdict, answer };

    // Apex flattening (design/07 §2.3(a)): the name holds A/AAAA records instead of a CNAME
    // because a zone apex cannot hold one. `evaluate` is pure and cannot look anything up, so
    // the address records are resolved here and each acceptable edge address is passed as the
    // expected `cnameTarget`. Where those addresses come from is `edgeAddressesFor`'s business:
    // the operator's override if there is one, otherwise the CNAME target's own addresses.
    // The best sentence the apex attempt produced, used when it did not match: "acme.com
    // resolves to 1.2.3.4, not 203.0.113.10" is actionable, where the CNAME answer's "add a
    // CNAME (on an apex, an ALIAS record)" would tell a customer who already published one that
    // nothing is there.
    let apex: DnsVerdict | undefined;
    for (const type of ["A", "AAAA"] as const) {
      const wanted = await edgeAddressesFor(type);
      if (wanted.length === 0) continue;
      const addresses = await deps.resolver.resolve(hostname, type);
      answer[type === "A" ? "a" : "aaaa"] = addresses;
      for (const address of wanted) {
        const alternative = evaluate({
          cname: addresses,
          txt,
          token,
          cnameTarget: address,
          requires,
          txtLabel,
        });
        if (alternative.cnameOk) {
          verdict = alternative;
          break;
        }
        if (addresses.values.length > 0) apex = alternative;
      }
      if (verdict.cnameOk) break;
    }
    return { verdict: verdict.cnameOk ? verdict : (apex ?? verdict), answer };
  }

  async function auditStatus(
    ctx: TenantContext,
    tx: Tx,
    row: CustomDomain,
    next: CustomDomainStatus,
    detail: string,
    actor: Actor | undefined,
  ): Promise<void> {
    // A demotion is audited as `custom_domain.failed` with `demoted` in the meta: §1.9 freezes
    // the five action names and none of them is `demoted`, and "this domain stopped being
    // verified" is the fact an auditor is looking for either way.
    const action =
      next === "dns_ok"
        ? "custom_domain.verified"
        : next === "active"
          ? "custom_domain.activated"
          : "custom_domain.failed";
    await deps.audit.record(tx, ctx, {
      action,
      resourceKind: "custom_domain",
      resourceId: row.id,
      ...(actor?.membershipId === undefined ? {} : { actorMembershipId: actor.membershipId }),
      ...(actor?.requestId === undefined ? {} : { requestId: actor.requestId }),
      // A demotion (`next === "pending"`) is a failure, not a success. It was recorded as a
      // success while carrying the `custom_domain.failed` action, so an auditor filtering on
      // failed outcomes — which is how you would look for "did a portal stop being reachable"
      // — saw every demotion as fine. The `demoted` meta flag below still separates the two.
      outcome: next === "failed" || next === "pending" ? "failure" : "success",
      meta: {
        hostname: row.hostname,
        from: row.status,
        to: next,
        detail: detail.slice(0, 500),
        ...(next === "pending" ? { demoted: true } : {}),
      },
    });
  }

  /** Whether a status holds the verified claim (`custom_domain_claim_idx`'s states). */
  function isVerified(status: CustomDomainStatus): boolean {
    return status === "dns_ok" || status === "active";
  }

  /**
   * E3.11: claims a hostname in the cell directory before a row is promoted into a verified
   * state. `undefined` = claimed (or no directory); `unavailable` = the directory did not answer
   * (not a verdict: the attempt is not counted); else the refusal to record — WORD FOR WORD the
   * local claim index's (R2-11), so the tenant cannot tell another cell from this one.
   */
  async function claimInDirectory(
    ctx: TenantContext,
    hostname: string,
  ): Promise<CustomDomainError | "unavailable" | undefined> {
    const directory = deps.directory;
    if (directory === undefined) return undefined;
    const claim = async (): Promise<CustomDomainError | undefined> =>
      (await directory.claimHost({ hostname, workspaceId: ctx.workspaceId })) === "claimed"
        ? undefined
        : claimedElsewhere(hostname);
    try {
      return await claim();
    } catch (error) {
      log("domains.directory_claim_failed", {
        level: "warn",
        workspaceId: ctx.workspaceId,
        hostname,
        error: errorText(error),
      });
      // RR1-8: the directory answered, but this workspace has no usable entry (never swept, or
      // its cell is another database's). Not an outage: repair the entry once and ask again;
      // still refused → a COUNTED failed attempt (the deadline applies), never a free retry.
      if (!isEntryProblem(error)) return "unavailable";
      try {
        await deps.repairEntry?.(ctx.workspaceId);
        return await claim();
      } catch (retry) {
        if (!isEntryProblem(retry)) return "unavailable";
        return new CustomDomainError(
          "claimed_elsewhere",
          `${hostname} could not be claimed for this workspace yet (its routing record is incomplete); it will be tried again.`,
          { hostname },
        );
      }
    }
  }

  /** E3.11: gives a hostname's directory claim back, after a commit. Never throws. */
  async function releaseInDirectory(ctx: TenantContext, hostname: string): Promise<void> {
    if (deps.directory === undefined) return;
    try {
      await deps.directory.releaseHost({ hostname, workspaceId: ctx.workspaceId });
    } catch (error) {
      log("domains.directory_release_failed", {
        level: "warn",
        workspaceId: ctx.workspaceId,
        hostname,
        error: errorText(error),
      });
    }
  }

  const service: CustomDomainService = {
    driver: deps.provider.driver,
    pollsProvider,

    async list(ctx) {
      const rows = await deps.db.withTenant(ctx, (tx) => storeFor(ctx, tx).list());
      return rows.map(view);
    },

    async add(ctx, input) {
      const checked = checkHostname(input.hostname, deps.canonicalHost);
      if (!checked.ok) {
        throw new CustomDomainError("invalid_hostname", REJECTION_MESSAGES[checked.reason], {
          reason: checked.reason,
        });
      }
      const hostname = checked.hostname;
      const token = challengeToken(deps.tokenKey, ctx.workspaceId, hostname);
      const at = now();

      let created: CustomDomain;
      try {
        created = await deps.db.withTenant(ctx, async (tx) => {
          const store = storeFor(ctx, tx);
          // Pre-checks so the ordinary cases are an honest 409 rather than a caught constraint.
          // The catch below is still the authority: two admins can race.
          if ((await store.byHostname(hostname)) !== undefined) {
            throw new CustomDomainError("duplicate", `${hostname} is already on this list`, {
              hostname,
            });
          }
          // A second *pending* row is legal in the schema (a founder fixing a typo needs one),
          // but a second *verified* one never can be: `custom_domain_one_per_workspace_idx`
          // would refuse the promotion, so refusing the add is the honest moment to say so
          // (E2.1 §6.2). Two verified hostnames would be two `__Host-` cookie jars, not aliases.
          const verified = await store.verified();
          if (verified !== undefined) {
            throw new CustomDomainError(
              "workspace_already_verified",
              `this workspace already has a verified domain (${verified.hostname}); remove it first`,
              { hostname: verified.hostname },
            );
          }
          // E3.10 plan quota, before the row and the audit (the check takes the workspace row).
          await deps.quota?.check(tx, {
            workspaceId: ctx.workspaceId,
            kind: "customDomains",
            delta: 1,
          });
          const row = await store.create({
            hostname,
            token,
            firstAttemptAt: at,
            createdBy: input.actor?.membershipId ?? null,
          });
          await deps.audit.record(tx, ctx, {
            action: "custom_domain.created",
            resourceKind: "custom_domain",
            resourceId: row.id,
            ...(input.actor?.membershipId === undefined
              ? {}
              : { actorMembershipId: input.actor.membershipId }),
            ...(input.actor?.requestId === undefined ? {} : { requestId: input.actor.requestId }),
            meta: { hostname, driver: deps.provider.driver },
          });
          return row;
        });
      } catch (error) {
        if (isCustomDomainError(error)) throw error;
        throw await mapViolation(ctx, error, hostname);
      }
      log("domains.added", { workspaceId: ctx.workspaceId, hostname });
      return view(created);
    },

    async verifyNow(ctx, id, actor) {
      const row = await deps.db.withTenant(ctx, (tx) => storeFor(ctx, tx).byId(id));
      if (row === undefined) throw new CustomDomainError("not_found", "no such domain");
      // A `failed` row is dead until an admin retries, and a retry means a fresh 72 h deadline
      // (`state.ts`'s `failed → pending`). Reopening first is what makes the button do something
      // rather than re-confirm the failure.
      if (row.status === "failed") {
        await deps.db.withTenant(ctx, async (tx) => {
          // A failed row is not counted against the plan; the reopened one is (E3.10 FR1).
          // Before the write, like `add`: the check takes the workspace row.
          await deps.quota?.check(tx, {
            workspaceId: ctx.workspaceId,
            kind: "customDomains",
            delta: 1,
          });
          await storeFor(ctx, tx).reopen(id, now());
        });
      }
      const updated = await service.check(ctx, id, actor, { priority: "interactive" });
      if (updated === undefined) throw new CustomDomainError("not_found", "no such domain");
      return updated;
    },

    async check(ctx, id, actor, options) {
      /** Which provider budgets this check's calls draw on (FR3). */
      const call: ProviderCallContext = {
        workspaceId: ctx.workspaceId,
        priority: options?.priority ?? "background",
      };
      const row = await deps.db.withTenant(ctx, (tx) => storeFor(ctx, tx).byId(id));
      if (row === undefined) return undefined;

      const judged = await judge(row.hostname, row.token);
      const verdict = judged.verdict;
      const at = now();
      let answer: DomainAnswerRecord = judged.answer;
      let detail = verdict.detail;
      let next = nextState({
        status: row.status,
        ok: verdict.ok,
        firstAttemptAt: row.firstAttemptAt,
        now: at,
        consecutiveFailures: row.consecutiveFailures,
      });

      /*
       * E3.10: a provider that issues certificates itself (`cloudflare-saas`) has the final say on
       * `dns_ok → active`, and only it: DNS being right says nothing about whether Cloudflare
       * validated the hostname and deployed a certificate. It is consulted only for a row whose
       * DNS still verifies (so it is never asked about a name nobody proved they control), and
       * its facts ride along in `last_answer.provider` for the admin screen. A row leaving the
       * verified states drops them — a re-verified row registers afresh.
       */
      const previous = (row.lastAnswer as DomainAnswerRecord | null)?.provider;
      const verifiedRow = row.status === "dns_ok" || row.status === "active";
      if (pollsProvider && verifiedRow && verdict.ok) {
        const { facts: provider, said } = await consultProvider(ctx, row.hostname, previous, call);
        answer = { ...answer, provider };
        if (row.status === "dns_ok" && said === "active") {
          next = { status: "active", consecutiveFailures: 0 };
          detail = `${verdict.detail} The provider reports the hostname active.`;
        } else if (said === "failed") {
          const reason = provider.detail ?? "The provider reports the hostname as failed.";
          detail = `${verdict.detail} ${reason}`;
          // `dns_ok`: it will not become active on its own, so the row fails now (with the
          // provider's reason) and an admin retry re-registers it. `active`: treated as a failed
          // check, so the re-verify grace decides — one bad answer must not take a serving portal
          // offline.
          next =
            row.status === "dns_ok"
              ? { status: "failed", consecutiveFailures: row.consecutiveFailures + 1 }
              : nextState({
                  status: row.status,
                  ok: false,
                  firstAttemptAt: row.firstAttemptAt,
                  now: at,
                  consecutiveFailures: row.consecutiveFailures,
                });
        } else if (provider.error !== undefined) {
          detail = `${verdict.detail} The provider could not be asked just now (${provider.error}); it will be asked again.`;
        } else if (provider.state === "pending" && provider.detail !== null) {
          detail = `${verdict.detail} ${provider.detail}`;
        }
      } else if (pollsProvider && verifiedRow && previous !== undefined) {
        // DNS did not verify this time; keep what the provider last said beside the new answer.
        answer = { ...answer, provider: previous };
      }
      const facts: AttemptFacts = { checkedAt: at, detail, answer };

      if (next.status === row.status) {
        const same = await deps.db.withTenant(ctx, (tx) =>
          storeFor(ctx, tx).recordAttempt(id, {
            ...facts,
            consecutiveFailures: next.consecutiveFailures,
          }),
        );
        // No audit row: a 5-minute poll that logged every unchanged verdict would bury the
        // transitions an auditor is actually reading for.
        return same === undefined ? undefined : view(same);
      }

      /*
       * A promotion refused by a claim — the local claim index or (E3.11) the cell directory:
       * the row does not advance, but the refusal IS a failed attempt (E2.1 M7).
       *
       * It used to be recorded with `consecutiveFailures` unincremented, and `nextState`'s
       * deadline only applies when `ok === false`, so a row whose verdict was `ok` and whose
       * promotion was permanently refused never reached `failed`: the backoff never grew,
       * `isDueForVerify` bypasses backoff entirely past 72 h, and the row resolved the
       * customer's nameservers every five minutes forever with nothing in the audit log to
       * tell an operator why. Re-running the state machine with `ok: false` gives the attempt
       * its cost and the 72 h deadline its terminal state.
       */
      const refuse = async (mapped: CustomDomainError): Promise<CustomDomainView | undefined> => {
        const refused = nextState({
          status: row.status,
          ok: false,
          firstAttemptAt: row.firstAttemptAt,
          now: at,
          consecutiveFailures: row.consecutiveFailures,
        });
        const conflictDetail = `${verdict.detail} ${mapped.message}`;
        const kept = await deps.db.withTenant(ctx, async (tx) => {
          const store = storeFor(ctx, tx);
          const facts = { checkedAt: at, detail: conflictDetail, answer };
          if (refused.status === "failed" && row.status !== "failed") {
            const written = await store.markFailed(id, {
              ...facts,
              consecutiveFailures: refused.consecutiveFailures,
            });
            // The operator signal the old path had none of: "this domain gave up, and it was the
            // claim that refused it, not DNS".
            if (written !== undefined) {
              await auditStatus(ctx, tx, row, "failed", conflictDetail, actor);
            }
            return written;
          }
          // Any other outcome leaves the status alone: a demotion driven by a claim conflict
          // would take a serving portal offline over somebody else's row.
          return store.recordAttempt(id, {
            ...facts,
            consecutiveFailures: refused.consecutiveFailures,
          });
        });
        log("domains.claim_conflict", {
          level: "warn",
          workspaceId: ctx.workspaceId,
          hostname: row.hostname,
          // NOT `code`: the logger redacts every field with that name (login codes, OTPs), so
          // the one diagnostic this line exists for printed as "[redacted]" every time.
          conflict: mapped.code,
          from: row.status,
          to: kept?.status ?? row.status,
        });
        if (kept !== undefined && kept.status !== row.status) invalidate(row.hostname);
        return kept === undefined ? undefined : view(kept);
      };

      // E3.11: entering the verified states claims the hostname across cells first — outside
      // the cell transaction (another database answers), and before the local write.
      const entersVerified = !isVerified(row.status) && isVerified(next.status);
      const leavesVerified = isVerified(row.status) && !isVerified(next.status);
      if (entersVerified) {
        const refusal = await claimInDirectory(ctx, row.hostname);
        if (refusal === "unavailable") {
          // "We could not ask" is not "no" (R2-11): the row stays where it is and the attempt is
          // not counted, so a directory outage never runs a domain into its 72 h deadline. The
          // next sweep asks again.
          const kept = await deps.db.withTenant(ctx, (tx) =>
            storeFor(ctx, tx).recordAttempt(id, {
              checkedAt: at,
              detail: `${verdict.detail} The address could not be claimed just now; it will be tried again.`,
              answer,
              consecutiveFailures: row.consecutiveFailures,
            }),
          );
          return kept === undefined ? undefined : view(kept);
        }
        if (refusal !== undefined) return refuse(refusal);
      }

      let updated: CustomDomain | undefined;
      try {
        updated = await deps.db.withTenant(ctx, async (tx) => {
          const store = storeFor(ctx, tx);
          const written =
            next.status === "dns_ok"
              ? await store.markDnsOk(id, facts)
              : next.status === "active"
                ? await store.markActive(id, facts)
                : next.status === "failed"
                  ? await store.markFailed(id, {
                      ...facts,
                      consecutiveFailures: next.consecutiveFailures,
                    })
                  : // The only route to `pending` from another status, and it resets
                    // `first_attempt_at` — see the repo. A demotion that kept the original date
                    // would be `failed` on the next tick.
                    await store.demote(id, facts);
          if (written === undefined) return undefined;
          await auditStatus(ctx, tx, row, next.status, detail, actor);
          if (queuedRelease && (next.status === "pending" || next.status === "failed")) {
            await enqueueRelease(tx, {
              workspaceId: ctx.workspaceId,
              domainId: id,
              hostname: row.hostname,
              ref: answer.provider?.ref ?? previous?.ref,
            });
          }
          return written;
        });
      } catch (error) {
        /*
         * A verified claim moved between the verdict and the write, or this workspace verified
         * another hostname in the meantime. Neither is this row's DNS being wrong, so the row
         * does not advance — but a refused promotion **is a failed attempt** (`refuse`). The
         * write above rolled back, so this is a fresh transaction rather than a poisoned one,
         * and the directory claim just taken goes back.
         */
        const mapped = await mapViolation(ctx, error, row.hostname);
        if (entersVerified) await releaseInDirectory(ctx, row.hostname);
        return refuse(mapped);
      }
      if (updated === undefined) {
        // Removed (or changed) under us: nothing was promoted, so nothing stays claimed.
        if (entersVerified) await releaseInDirectory(ctx, row.hostname);
        return undefined;
      }
      // E3.11: no longer verified here → no longer this cell's to route.
      if (leavesVerified) await releaseInDirectory(ctx, row.hostname);

      // Committed: the answer `ask`, the classifier and `primaryHost` give may have changed.
      invalidate(row.hostname);
      log("domains.status_changed", {
        workspaceId: ctx.workspaceId,
        hostname: row.hostname,
        from: row.status,
        to: next.status,
      });

      // The provider is told after the commit, not before: `caddy-ask` is a no-op (the `ask`
      // endpoint is the mechanism), but a provider that registers a hostname with an edge must
      // not be told about a state the database rolled back.
      try {
        if (next.status === "dns_ok" && pollsProvider) {
          // Registration (E3.10): its outcome — the provider's extra records, or the failure the
          // next sweep retries — is stored beside the DNS answers.
          const facts = await register(ctx, row.hostname, undefined, call);
          const stored = await deps.db.withTenant(ctx, (tx) =>
            storeFor(ctx, tx).recordProvider(id, facts),
          );
          if (stored !== undefined) updated = stored;
        } else if (next.status === "dns_ok") await deps.provider.activate(row.hostname, call);
        else if ((next.status === "pending" || next.status === "failed") && !queuedRelease) {
          // Queued in the transaction above instead when the provider keeps state of its own.
          await deps.provider.deactivate(row.hostname, answer.provider?.ref ?? previous?.ref, call);
        }
      } catch (error) {
        log("domains.provider_failed", {
          level: "warn",
          hostname: row.hostname,
          status: next.status,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return view(updated);
    },

    async markServing(ctx, id) {
      // E3.10: with a provider that terminates TLS itself, a request reaching us proves nothing
      // about the certificate — Cloudflare routes the hostname (HTTP included) before its
      // certificate is active. `active` is then the provider's verdict, written by `check()`.
      if (pollsProvider) return false;
      const at = now();
      const row = await deps.db.withTenant(ctx, async (tx) => {
        const store = storeFor(ctx, tx);
        const existing = await store.byId(id);
        // Not `dns_ok` any more: already `active` (the common case — the lookup cache expired
        // before the invalidate landed), or demoted, or removed under us. Nothing to do, and
        // certainly nothing to force.
        if (existing?.status !== "dns_ok") return undefined;
        // No DNS was resolved here, so `markServing` (not `markActive`) leaves `last_checked_at`,
        // `last_detail` and `last_answer` exactly as the verifier wrote them: claiming a check
        // that never happened would erase the last resolver answer §9.2 puts on screen.
        const written = await store.markServing(id, at);
        if (written === undefined) return undefined;
        await deps.audit.record(tx, ctx, {
          action: "custom_domain.activated",
          resourceKind: "custom_domain",
          resourceId: id,
          meta: { hostname: existing.hostname, from: "dns_ok", to: "active", served: true },
        });
        return written;
      });
      if (row === undefined) return false;
      // `primaryHost` has just appeared, and the lookup's own entry now says `dns_ok`.
      invalidate(row.hostname);
      log("domains.activated", {
        workspaceId: ctx.workspaceId,
        hostname: row.hostname,
        reason: "served",
      });
      return true;
    },

    async remove(ctx, id, actor) {
      const at = now();
      const row = await deps.db.withTenant(ctx, async (tx) => {
        const store = storeFor(ctx, tx);
        const existing = await store.byId(id);
        if (existing === undefined) return undefined;
        if (!(await store.softDelete(id, at))) return undefined;
        await deps.audit.record(tx, ctx, {
          action: "custom_domain.deleted",
          resourceKind: "custom_domain",
          resourceId: id,
          ...(actor?.membershipId === undefined ? {} : { actorMembershipId: actor.membershipId }),
          ...(actor?.requestId === undefined ? {} : { requestId: actor.requestId }),
          meta: { hostname: existing.hostname, status: existing.status },
        });
        if (queuedRelease) {
          await enqueueRelease(tx, {
            workspaceId: ctx.workspaceId,
            domainId: id,
            hostname: existing.hostname,
            ref: providerRefOf(existing),
          });
        }
        return existing;
      });
      if (row === undefined) return false;

      // Soft delete releases both claims (`WHERE deleted_at IS NULL`), so the hostname stops
      // resolving and stops being `primaryHost`. Invalidate before reporting success.
      invalidate(row.hostname);
      // E3.11: and the cross-cell claim, when it held one.
      if (isVerified(row.status)) await releaseInDirectory(ctx, row.hostname);
      if (!queuedRelease) {
        try {
          await deps.provider.deactivate(row.hostname, providerRefOf(row), {
            workspaceId: ctx.workspaceId,
            priority: "interactive",
          });
        } catch (error) {
          log("domains.provider_failed", {
            level: "warn",
            hostname: row.hostname,
            status: "deleted",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      log("domains.removed", { workspaceId: ctx.workspaceId, hostname: row.hostname });
      return true;
    },
  };
  return service;
}
