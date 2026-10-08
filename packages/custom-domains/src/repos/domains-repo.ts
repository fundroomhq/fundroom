import {
  CUSTOM_DOMAIN_ISSUABLE_STATUSES,
  type CustomDomain,
  core,
  type TenantContext,
  TenantRepo,
  type Tx,
} from "@fundroom/db";
import type { DnsAnswer, DnsInstruction } from "@fundroom/ports";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

const { customDomain, workspace } = core;

/*
 * Data access over `core.custom_domain` (migration `core/0007_custom_domains.sql`).
 *
 * This is the only file in the package allowed to import drizzle (the `only-repos-touch-drizzle`
 * rule); everything else goes through these methods.
 *
 * Two traps this file exists to close, both learned the hard way:
 *
 * 1. **The query builder, never `tx.execute`.** The raw path returns `timestamptz` as *text*, so
 *    a `Date`-typed field silently becomes a string at runtime while the unit tests, which never
 *    touch a database, stay green (ADR-0036, learned in E1.5). `first_attempt_at` is the column
 *    the 72 h deadline is measured against and `last_checked_at` is what the admin screen shows,
 *    so a string where a `Date` is expected here is a wrong verdict, not a formatting bug.
 * 2. **A demotion must reset `first_attempt_at`.** There is deliberately no generic status
 *    setter. `pending → failed` is measured from `first_attempt_at`, so demoting an `active` row
 *    (months-old `first_attempt_at`) without resetting that column flips it straight to `failed`
 *    on the next sweep — the row would go from "serving" to "dead" in one 5-minute tick. The only
 *    way to reach `pending` from another status is `demote()`, which resets it in the same
 *    statement, and `reopen()` for an admin retry, which does the same.
 *
 * `TenantRepo.scope()` adds `workspace_id = ctx.workspaceId` on top of RLS, so the planner uses
 * the workspace-leading indexes and a foreign workspace cannot even be expressed.
 *
 * `updated_at` is never written here: `custom_domain_set_updated_at` is a BEFORE UPDATE trigger.
 */

/**
 * `last_answer.provider` (schema version 2, E3.10): what a certificate-issuing provider
 * (`cloudflare-saas`) last said about the hostname. It lives in `last_answer` rather than a
 * column of its own because it is the same kind of fact — the last thing an outside party
 * answered about this name — and it is written and read with the DNS answers.
 */
export interface ProviderFacts {
  readonly state: "pending" | "active" | "failed";
  /** The provider's operator-facing reason; never a credential. */
  readonly detail: string | null;
  /** Extra records the provider asks for (Cloudflare's ownership / DCV TXT records). */
  readonly records: readonly DnsInstruction[];
  /**
   * The provider accepted the hostname (`activate` succeeded). Until it has, the verify sweep
   * retries `activate` instead of asking for a status that cannot exist yet.
   */
  readonly registered: boolean;
  /** ISO time of the last provider call, successful or not. */
  readonly checkedAt: string;
  /** Set when that call failed (rate limit, network): `state`/`records` are then the older ones. */
  readonly error?: string | undefined;
  /**
   * The provider's own id for the hostname (Cloudflare's custom hostname id, E3.10 FR1), from
   * `activate` or a later `status`. `status` and `deactivate` address the hostname by it; absent
   * on rows registered before it was stored, which fall back to a search.
   */
  readonly ref?: string | undefined;
}

/** `last_answer` jsonb: the resolver answers a verdict was formed from. */
export interface DomainAnswerRecord {
  readonly cname?: DnsAnswer | undefined;
  readonly txt?: DnsAnswer | undefined;
  /** Consulted only for an apex whose CNAME did not match (flattening — design/07 §2.3(a)). */
  readonly a?: DnsAnswer | undefined;
  readonly aaaa?: DnsAnswer | undefined;
  /** Version 2 (E3.10): only for a provider with `status()`. */
  readonly provider?: ProviderFacts | undefined;
}

/** Bumped only when the shape above changes; the column defaults to 1. 2 = `provider` (E3.10). */
export const LAST_ANSWER_SCHEMA_VERSION = 2;

/** `custom_domain_detail_length` CHECKs 1000; clamped here so a long sentence cannot 23514. */
const DETAIL_MAX = 1000;

/** What one verification pass has to write, whatever the state machine then decides. */
export interface AttemptFacts {
  readonly checkedAt: Date;
  readonly detail?: string | null | undefined;
  readonly answer?: DomainAnswerRecord | undefined;
}

interface AttemptColumns {
  readonly lastCheckedAt: Date;
  readonly lastDetail?: string | null;
  readonly lastAnswer?: DomainAnswerRecord;
  readonly lastAnswerSchemaVersion?: number;
}

function attemptColumns(facts: AttemptFacts): AttemptColumns {
  return {
    lastCheckedAt: facts.checkedAt,
    ...(facts.detail === undefined
      ? {}
      : { lastDetail: facts.detail === null ? null : facts.detail.slice(0, DETAIL_MAX) }),
    ...(facts.answer === undefined
      ? {}
      : { lastAnswer: facts.answer, lastAnswerSchemaVersion: LAST_ANSWER_SCHEMA_VERSION }),
  };
}

/** One row of the hostname → workspace answer `ask` and the tenant classifier need. */
export interface IssuableDomain {
  readonly id: string;
  readonly workspaceId: string;
  readonly slug: string;
  readonly hostname: string;
  readonly status: CustomDomain["status"];
}

/** A row a sweep may have to act on, with the workspace it belongs to. */
export interface SweepRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly hostname: string;
  readonly status: CustomDomain["status"];
  readonly consecutiveFailures: number;
  readonly firstAttemptAt: Date;
  readonly lastCheckedAt: Date | null;
  /** When the row reached `dns_ok`: the provider-poll backoff grows from here (E3.10). */
  readonly dnsOkAt: Date | null;
}

export class CustomDomainRepo extends TenantRepo<typeof customDomain> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(customDomain, ctx, tx);
  }

  /** The workspace's live rows, verified first then newest: the admin list order. */
  async list(): Promise<CustomDomain[]> {
    return this.tx
      .select()
      .from(customDomain)
      .where(this.scope(isNull(customDomain.deletedAt)))
      .orderBy(
        sql`CASE ${customDomain.status} WHEN 'active' THEN 0 WHEN 'dns_ok' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END`,
        asc(customDomain.hostname),
      );
  }

  async byId(id: string): Promise<CustomDomain | undefined> {
    const rows = await this.tx
      .select()
      .from(customDomain)
      .where(this.scope(and(eq(customDomain.id, id), isNull(customDomain.deletedAt))))
      .limit(1);
    return rows[0];
  }

  /** `hostname` is `citext`, so this is case-insensitive in the database, not here. */
  async byHostname(hostname: string): Promise<CustomDomain | undefined> {
    const rows = await this.tx
      .select()
      .from(customDomain)
      .where(this.scope(and(eq(customDomain.hostname, hostname), isNull(customDomain.deletedAt))))
      .limit(1);
    return rows[0];
  }

  /**
   * The workspace's verified row, if it has one. `custom_domain_one_per_workspace_idx` makes it
   * at most one — this is the hostname a 409 names when a second one is attempted, which is why
   * the service reads it rather than guessing from the list.
   */
  async verified(): Promise<CustomDomain | undefined> {
    const rows = await this.tx
      .select()
      .from(customDomain)
      .where(
        this.scope(
          and(
            isNull(customDomain.deletedAt),
            inArray(customDomain.status, [...CUSTOM_DOMAIN_ISSUABLE_STATUSES]),
          ),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /**
   * A new `pending` row. `firstAttemptAt` defaults to `now()` in the database; it is passed
   * explicitly so the service's injected clock, not the database's, owns the 72 h deadline.
   */
  async create(values: {
    readonly hostname: string;
    readonly token: string;
    readonly firstAttemptAt: Date;
    readonly createdBy?: string | null | undefined;
  }): Promise<CustomDomain> {
    return this.insertOne({
      hostname: values.hostname,
      token: values.token,
      status: "pending",
      firstAttemptAt: values.firstAttemptAt,
      createdBy: values.createdBy ?? null,
    });
  }

  /**
   * Records what DNS said without touching the status: the verdict agreed with the row's current
   * state. `consecutiveFailures` still moves, because it is what the grace counts.
   */
  async recordAttempt(
    id: string,
    facts: AttemptFacts & { readonly consecutiveFailures: number },
  ): Promise<CustomDomain | undefined> {
    return this.write(id, {
      ...attemptColumns(facts),
      consecutiveFailures: facts.consecutiveFailures,
    });
  }

  /** `pending|failed → dns_ok`: DNS proved out. `dns_ok_at` is stamped once, on the first pass. */
  async markDnsOk(id: string, facts: AttemptFacts): Promise<CustomDomain | undefined> {
    return this.write(id, {
      ...attemptColumns(facts),
      status: "dns_ok",
      consecutiveFailures: 0,
      dnsOkAt: facts.checkedAt,
    });
  }

  /** `dns_ok → active`: serving. This is the row `ResolvedWorkspace.primaryHost` reads. */
  async markActive(id: string, facts: AttemptFacts): Promise<CustomDomain | undefined> {
    return this.write(id, {
      ...attemptColumns(facts),
      status: "active",
      consecutiveFailures: 0,
      activatedAt: facts.checkedAt,
    });
  }

  /**
   * `dns_ok → active` driven by a request having been served on the hostname (E2.1 S2), which is
   * the only evidence that a certificate exists.
   *
   * Distinct from `markActive` because **no DNS was resolved**: `last_checked_at`, `last_detail`
   * and `last_answer` are left exactly as the verifier wrote them. Moving `last_checked_at`
   * forward would claim a check that never happened, and overwriting the last resolver answer
   * would erase the sentence §9.2 puts on the admin screen. The `WHERE status = 'dns_ok'` is
   * the idempotency: two concurrent requests race to the same single row update.
   */
  async markServing(id: string, at: Date): Promise<CustomDomain | undefined> {
    const rows = await this.tx
      .update(customDomain)
      .set({ status: "active", consecutiveFailures: 0, activatedAt: at })
      .where(
        this.scope(
          and(
            eq(customDomain.id, id),
            eq(customDomain.status, "dns_ok"),
            isNull(customDomain.deletedAt),
          ),
        ),
      )
      .returning();
    return rows[0];
  }

  /** `pending → failed`: still not resolving at the deadline. An admin retry reopens it. */
  async markFailed(
    id: string,
    facts: AttemptFacts & { readonly consecutiveFailures: number },
  ): Promise<CustomDomain | undefined> {
    return this.write(id, {
      ...attemptColumns(facts),
      status: "failed",
      consecutiveFailures: facts.consecutiveFailures,
    });
  }

  /**
   * `active|dns_ok → pending` after the re-verify grace ran out — **the only way to reach
   * `pending` from a verified status, and it resets `first_attempt_at` in the same statement.**
   *
   * Without that reset the row carries the date it was first added, the next 5-minute sweep finds
   * it months past `VERIFY_DEADLINE_MS`, and a domain that had one bad DoH week goes straight to
   * `failed` instead of being retried. `dns_ok_at` / `activated_at` are cleared for the same
   * reason they were set: the row is no longer verified, and a stale `activated_at` would make
   * the admin screen claim it is still serving.
   */
  async demote(id: string, facts: AttemptFacts): Promise<CustomDomain | undefined> {
    return this.write(id, {
      ...attemptColumns(facts),
      status: "pending",
      consecutiveFailures: 0,
      firstAttemptAt: facts.checkedAt,
      dnsOkAt: null,
      activatedAt: null,
    });
  }

  /**
   * `failed → pending`: an admin asked for another go. Same reset as `demote`, for the same
   * reason — a fresh deadline is what "retry" means, and without it the row fails again on the
   * next tick without ever having been re-checked.
   */
  async reopen(id: string, at: Date): Promise<CustomDomain | undefined> {
    return this.write(id, {
      status: "pending",
      consecutiveFailures: 0,
      firstAttemptAt: at,
      lastDetail: null,
      dnsOkAt: null,
      activatedAt: null,
    });
  }

  /**
   * Replaces `last_answer.provider` and nothing else (E3.10): the outcome of an `activate` that ran
   * after the status write committed. No `last_checked_at`, for `markServing`'s reason — no DNS
   * was resolved — and no status change. `||` on jsonb replaces the one key, keeping the DNS
   * answers beside it.
   */
  /** `lockHostname` on this transaction (E3.10 FR3). */
  async lockHostname(hostname: string): Promise<void> {
    await lockHostname(this.tx, hostname);
  }

  async recordProvider(id: string, provider: ProviderFacts): Promise<CustomDomain | undefined> {
    return this.write(id, {
      lastAnswer: sql`coalesce(${customDomain.lastAnswer}, '{}'::jsonb) || jsonb_build_object('provider', ${JSON.stringify(provider)}::jsonb)`,
      lastAnswerSchemaVersion: LAST_ANSWER_SCHEMA_VERSION,
    });
  }

  /**
   * Soft delete. The row stays for the audit trail and so the same hostname can be re-added
   * later: both unique indexes are `WHERE deleted_at IS NULL`, so this releases the claim.
   */
  async softDelete(id: string, at: Date): Promise<boolean> {
    const rows = await this.tx
      .update(customDomain)
      .set({ deletedAt: at })
      .where(this.scope(and(eq(customDomain.id, id), isNull(customDomain.deletedAt))))
      .returning({ id: customDomain.id });
    return rows.length > 0;
  }

  /** The one place an UPDATE is issued, so every status write goes through the same fence. */
  private async write(
    id: string,
    values: Partial<typeof customDomain.$inferInsert>,
  ): Promise<CustomDomain | undefined> {
    const rows = await this.tx
      .update(customDomain)
      .set(values)
      .where(this.scope(and(eq(customDomain.id, id), isNull(customDomain.deletedAt))))
      .returning();
    return rows[0];
  }
}

/*
 * Host-context reads. These are functions rather than repo methods because they have no
 * workspace: `ask` and the tenant classifier answer from a hostname alone, before any workspace
 * is known, and the sweeps look at every workspace's rows in one query. The table's fence admits
 * the `host` actor kind for exactly this reason (see the migration's RLS block), so every caller
 * must be inside `db.withHost(...)` — under `withTenant` these return zero rows.
 */

/**
 * The hostname → workspace answer, for `dns_ok` and `active` only. `active` is not a
 * precondition: a certificate cannot exist before the first handshake, so `ask` has to answer
 * 200 for `dns_ok` too (E2.1 decision 3). Served by `custom_domain_claim_idx`, which is both the
 * claim and this lookup.
 *
 * The workspace's own `deleted_at` is checked as well: a soft-deleted workspace keeps its rows
 * for the retention window, and resolving a request to one would revive a closed portal.
 */
export async function findIssuableByHostname(
  tx: Tx,
  hostname: string,
): Promise<IssuableDomain | undefined> {
  const rows = await tx
    .select({
      id: customDomain.id,
      workspaceId: customDomain.workspaceId,
      slug: workspace.slug,
      hostname: customDomain.hostname,
      status: customDomain.status,
    })
    .from(customDomain)
    .innerJoin(workspace, eq(customDomain.workspaceId, workspace.id))
    .where(
      and(
        eq(customDomain.hostname, hostname),
        isNull(customDomain.deletedAt),
        isNull(workspace.deletedAt),
        inArray(customDomain.status, [...CUSTOM_DOMAIN_ISSUABLE_STATUSES]),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * The per-hostname advisory lock (E3.10 FR3) that serialises a provider release with a provider
 * registration of the same name: the release job holds it from its "is anyone still verified on
 * this hostname" read through the provider call, and a registration takes it (and waits out any
 * release in flight) before asking the provider to create. Namespace 24303 (24301 = audit chain,
 * 24302 = access). A feature advisory lock: taken before any row lock, and the transactions that
 * take it take nothing else. Any context: the lock is not a row.
 */
export async function lockHostname(tx: Tx, hostname: string): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(24303, hashtext(${hostname}))`);
}

/**
 * Whether a verified (`dns_ok` / `active`) row still holds `hostname` — including a row of a
 * soft-deleted workspace, which can be restored inside its window and must not come back to a
 * hostname the provider has forgotten (E3.10 FR3; contrast `findIssuableByHostname`, which answers
 * for routing and so ignores those). HOST context.
 */
export async function isHostnameHeld(tx: Tx, hostname: string): Promise<boolean> {
  const rows = await tx
    .select({ id: customDomain.id })
    .from(customDomain)
    .where(
      and(
        eq(customDomain.hostname, hostname),
        isNull(customDomain.deletedAt),
        inArray(customDomain.status, [...CUSTOM_DOMAIN_ISSUABLE_STATUSES]),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Rows in one of `statuses` across every live workspace, least-recently-checked first
 * (never-checked first of all) — `custom_domain_check_idx`. `workspaceId` narrows it to one
 * workspace, which is what a job's `data.workspaceId` is for.
 *
 * The backoff is applied by the caller rather than in SQL: at one or two rows per workspace the
 * filter is free in JavaScript, and there it is a pure function a unit test can pin down.
 */
export async function listDomainsForSweep(
  tx: Tx,
  input: {
    readonly statuses: readonly CustomDomain["status"][];
    readonly limit: number;
    readonly workspaceId?: string | undefined;
  },
): Promise<SweepRow[]> {
  if (input.statuses.length === 0) return [];
  return tx
    .select({
      id: customDomain.id,
      workspaceId: customDomain.workspaceId,
      hostname: customDomain.hostname,
      status: customDomain.status,
      consecutiveFailures: customDomain.consecutiveFailures,
      firstAttemptAt: customDomain.firstAttemptAt,
      lastCheckedAt: customDomain.lastCheckedAt,
      dnsOkAt: customDomain.dnsOkAt,
    })
    .from(customDomain)
    .innerJoin(workspace, eq(customDomain.workspaceId, workspace.id))
    .where(
      and(
        isNull(customDomain.deletedAt),
        isNull(workspace.deletedAt),
        inArray(customDomain.status, [...input.statuses]),
        input.workspaceId === undefined
          ? undefined
          : eq(customDomain.workspaceId, input.workspaceId),
      ),
    )
    .orderBy(sql`${customDomain.lastCheckedAt} ASC NULLS FIRST`, asc(customDomain.id))
    .limit(input.limit);
}
