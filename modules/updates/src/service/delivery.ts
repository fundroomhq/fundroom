import {
  findWorkspaceById,
  systemContext,
  type TenantContext,
  type Tx,
  workspaceIsActive,
} from "@fundroom/db";
import { delegationAdmitsModule, parseWorkspaceSettings } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import { MembershipRepo, maskEmail, recipientLocale } from "@fundroom/identity";
import {
  disclaimerPayload,
  type PageDoc,
  type RenderedBlock,
  slugOf,
} from "@fundroom/module-content";
import type { BlockHydrationContext, ModuleServices } from "@fundroom/module-kit";
import { type JsonObject, MailSuppressedError, type OutboundEmail } from "@fundroom/ports";
import {
  type Audience,
  parseAudience,
  parseSectionRules,
  type Reader,
  sectionVisible,
} from "../model.js";
import { renderUpdateEmail } from "../render/email.js";
import {
  PostRepo,
  RecipientRepo,
  SendRepo,
  UnsubscribeRepo,
  VersionRepo,
} from "../repos/updates-repo.js";
import type { PostVersion, Recipient, Send } from "../schema/updates.js";
import { indexPost } from "../search.js";
import { createSendingDomainService } from "./domains.js";
import { SEND_BATCH, SEND_RETRY_WINDOW_HOURS, SEND_TRANSIENT_STREAK } from "./names.js";
import { createSubscriptionService } from "./subscriptions.js";

/**
 * Whether a send failure is the kernel's suppression wrapper refusing the address (E2.6
 * decision 3) rather than a delivery error. `instanceof` alone is not enough: two copies of
 * `@fundroom/ports` in one process (a stale `dist/`, a hoisting accident) make two classes,
 * and a suppressed address marked `failed` would be retried by nobody and alarm everybody. The
 * `code` is the contract; the class is the convenience.
 */
export function isSuppressed(error: unknown): boolean {
  if (error instanceof MailSuppressedError) return true;
  try {
    return (
      typeof error === "object" &&
      error !== null &&
      (error as { readonly code?: unknown }).code === "suppressed"
    );
  } catch {
    return false;
  }
}

/** Socket/DNS-level failure codes: nothing reached a mail server that could say no. */
const TRANSIENT_NET_CODES = new Set([
  "ECONNECTION",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ESOCKET",
  "EDNS",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
]);
/** Adapter/port codes that mean "try again later" (`MailerError` of every email adapter). */
const TRANSIENT_CODES = new Set(["connection_failed", "rate_limited", "timeout"]);

/**
 * SMTP stages that are about the relay, the session or our sender — never about this recipient.
 * nodemailer names the command that drew the reply (`CONN` for the greeting, `AUTH PLAIN`, …);
 * `RCPT TO` and `DATA` are the per-recipient and per-message stages and are not here.
 */
const RELAY_COMMAND_RE = /^(?:CONN|EHLO|HELO|LHLO|STARTTLS|AUTH\b|MAIL FROM)/iu;
/** Adapter and nodemailer codes that mean "the relay would not take mail from us at all". */
const RELAY_CODES = new Set(["EAUTH", "ENOAUTH", "ETLS", "unauthorized"]);

/**
 * Whether a failure is the **relay's** refusal rather than this recipient's (review E2.10
 * R1-A8): bad SMTP credentials (535), a greeting or HELO refused (554), our sender refused at
 * `MAIL FROM`, TLS failing, an ESP refusing the API key. A 5xx there says "no" to every message
 * on the list, not to this address — marking recipients `failed` for it would fail the whole
 * list for good over one configuration mistake. Never throws.
 */
export function isRelayMailError(error: unknown): boolean {
  try {
    let at: unknown = error;
    for (let depth = 0; depth < 5 && typeof at === "object" && at !== null; depth++) {
      const e = at as Record<string, unknown>;
      const code = e["code"];
      const command = e["command"];
      if (typeof code === "string" && RELAY_CODES.has(code)) return true;
      if (typeof command === "string" && RELAY_COMMAND_RE.test(command)) return true;
      at = e["cause"];
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Whether a send failure is worth retrying later rather than final (pen test / E2.10: an SMTP
 * outage used to mark every remaining recipient `failed` for good).
 *
 * Transient: a relay-level refusal (`isRelayMailError`, any reply code), the ESP adapters'
 * `retryable` flag, their `connection_failed`/`rate_limited` code,
 * a socket or DNS error anywhere in the `cause` chain, or an SMTP **4xx** reply (RFC 5321
 * §4.2.1: "transient negative completion"). Permanent: an SMTP **5xx** reply anywhere in the
 * chain (checked first, so a wrapper's optimistic flag cannot override the server's "no"), and
 * everything unrecognised — an unknown failure is final, as it always was, so a bug cannot turn
 * into an unbounded retry loop. A suppression is neither: the caller handles it before this.
 * Never throws.
 */
export function isTransientMailError(error: unknown): boolean {
  try {
    // A relay-level refusal (R1-A8) is retried whatever its reply code: it is not this address.
    if (isRelayMailError(error)) return true;
    const chain: Record<string, unknown>[] = [];
    let at: unknown = error;
    for (let depth = 0; depth < 5 && typeof at === "object" && at !== null; depth++) {
      chain.push(at as Record<string, unknown>);
      at = (at as { cause?: unknown }).cause;
    }
    const reply = (e: Record<string, unknown>): number | undefined =>
      typeof e["responseCode"] === "number" ? (e["responseCode"] as number) : undefined;
    if (chain.some((e) => (reply(e) ?? 0) >= 500)) return false;
    return chain.some((e) => {
      const code = e["code"];
      const r = reply(e);
      return (
        e["retryable"] === true ||
        (typeof code === "string" &&
          (TRANSIENT_CODES.has(code) || TRANSIENT_NET_CODES.has(code))) ||
        (r !== undefined && r >= 400 && r < 500)
      );
    });
  } catch {
    return false;
  }
}

/**
 * A run that left recipients `queued` for later: the job fails on purpose so pg-boss retries it
 * with backoff (`jobs.ts`), and the dispatcher re-enqueues it past that budget
 * (`SEND_STALE_MINUTES`) until `SEND_RETRY_WINDOW_HOURS` makes the failures final.
 */
export class DeliveryDeferredError extends Error {
  override readonly name = "DeliveryDeferredError";
  constructor(
    readonly deferred: number,
    readonly busy: number,
  ) {
    super(
      `updates.send: ${deferred} recipient(s) deferred after a transient mail failure, ${busy} held by another run; retrying`,
    );
  }
}

/** What `deliver` did with one recipient. */
type Outcome = "done" | "deferred" | "busy";

/**
 * Whether this recipient's message asks the provider for open/click tracking (E2.6 decision 1).
 *
 * Both halves must hold: the workspace chose `engagement` — the only analytics tier that records
 * opens and clicks at all — *and* this member's `email_tracking` purpose is allowed right now
 * (the kernel folds consent mode, their answer and, at request time, GPC; a send job has no
 * request, so GPC was folded into the stored answer when they gave it). A test send, a
 * recipient with no membership and anything outside `engagement` never track, and the consent
 * question is not even asked for them: a purpose lookup per recipient is a read we only pay for
 * when the answer could be yes.
 */
export async function trackingFor(
  services: Pick<ModuleServices, "legal">,
  tx: Tx,
  ctx: TenantContext,
  input: {
    readonly analyticsMode: "off" | "essential" | "engagement";
    readonly sendKind: Send["kind"];
    readonly membershipId: string | null;
  },
): Promise<OutboundEmail["tracking"]> {
  if (input.analyticsMode !== "engagement") return undefined;
  if (input.sendKind !== "live" || input.membershipId === null) return undefined;
  const allowed = await services.legal.allowsPurpose(tx, ctx, input.membershipId, "email_tracking");
  return allowed ? { opens: true, clicks: true } : undefined;
}

/*
 * The send job body (E1.4, §13.3): resolve the audience into recipient rows (idempotent:
 * re-running a crashed job continues where it stopped), render one email per recipient
 * (sections filtered by that reader's groups), hand it to `MailerPort`, record status,
 * close the send and move the post to `sent`. Test sends go to the addresses given and
 * never touch the post's state.
 */
export interface Candidate {
  readonly membershipId: string;
  readonly email: string | null;
  readonly kind: "staff" | "external";
  readonly groupIds: readonly string[];
}

export interface SendResult {
  readonly sendId: string;
  readonly total: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
}

const ELIGIBLE = ["invited", "active", "dormant"] as const;

function membershipLapsed(expiresAt: Date | null | undefined, at: Date): boolean {
  return expiresAt != null && expiresAt.getTime() <= at.getTime();
}

/** A delegate's scope, `null` for every other membership (E3.2). */
function delegateScopeOf(m: {
  readonly role?: string | undefined;
  readonly delegateScope?: string | null | undefined;
}): "all" | "data_room" | "updates" | null {
  if (m.role !== "delegate") return null;
  const s = m.delegateScope;
  // A delegate row always has a scope (CHECK membership_delegate_scope); refuse rather than widen.
  return s === "all" || s === "data_room" || s === "updates" ? s : "data_room";
}

/**
 * Why this recipient must no longer get the update, checked **when the message is sent**, not
 * when the list was built (review E2.10 R1-A3): a live send is retried for up to
 * `SEND_RETRY_WINDOW_HOURS`, and in that time a member can be revoked, run past `expires_at`, or
 * leave the groups the update is addressed to. `undefined`: still eligible.
 */
export function ineligibleReason(
  member:
    | {
        readonly kind: string;
        readonly status: string;
        readonly expiresAt?: Date | null;
        readonly role?: string | undefined;
        readonly delegateScope?: string | null | undefined;
      }
    | undefined,
  audience: Audience,
  groupIds: readonly string[],
  at: Date,
): string | undefined {
  if (member === undefined) return "no longer a member";
  if (!(ELIGIBLE as readonly string[]).includes(member.status))
    return `membership ${member.status}`;
  if (membershipLapsed(member.expiresAt, at)) return "membership expired";
  // F3: updates are "updates" content; a `data_room` delegate is in no update's audience.
  if (!delegationAdmitsModule(delegateScopeOf(member), "updates"))
    return "no longer in the audience";
  const inAudience =
    audience.kind === "all"
      ? member.kind === "external"
      : audience.groupIds.some((g) => groupIds.includes(g));
  return inAudience ? undefined : "no longer in the audience";
}

/**
 * Reference block types the **send path** hydrates, as opposed to the every-type generality of
 * the web archive (`posts.ts` → `renderSections`).
 *
 * It is a list and not "every type with a registered hydrator" because of what this path can
 * honestly supply: hydration here happens once per *audience*, not once per person, so the
 * context carries the reader's groups and neither their membership id nor their
 * `RequestFacts`. `document_list` wants both — it resolves per-viewer grants and session-bound
 * gates — and hydrating it with an empty `RequestFacts` would evaluate `min_auth_level` and
 * `ip_allowlist` against nothing, which fails *open* (`manifest.ts`'s own warning about two
 * hand-rolled copies of that object). It also renders as an archive link either way, so the
 * read would buy a risk and nothing else. A block joins this set when the email can render it
 * from audience-shaped data alone.
 */
export const EMAIL_HYDRATED_BLOCKS: ReadonlySet<string> = new Set(["metric_grid"]);

/**
 * Every error this file turns into a string, and it must never throw.
 *
 * `error instanceof Error ? error.message : String(error)` — what this path used to spell
 * inline — throws on three values a `throw` statement is perfectly entitled to produce:
 * `String(Symbol())` is a `TypeError`, so is `String(Object.create(null))`, and so is any
 * object whose `toString`/`Symbol.toPrimitive` throws. Throwing *inside* a `catch` on this
 * path is how a failure that was meant to degrade takes the whole send down instead, so the
 * narrowing has to be total rather than merely usual.
 */
export function describeError(error: unknown): string {
  try {
    if (error instanceof Error) {
      const message: unknown = error.message;
      if (typeof message === "string") return message;
    }
    if (typeof error === "string") return error;
    if (typeof error === "symbol") return error.toString();
    if (error === null) return "null";
    if (error === undefined) return "undefined";
    return String(error);
  } catch {
    // A symbol, a null-prototype object, or a hostile `toString`. Fall through to a shape.
  }
  try {
    return Object.prototype.toString.call(error);
  } catch {
    return "unknown error";
  }
}

/**
 * The one instant a send renders "as of" — the send row's `created_at`, and the column is the
 * decision.
 *
 * D5 says every recipient in one audience receives a byte-identical `<img src>`, and the chart
 * token carries an `asOf` (§9.1). That property therefore holds only if the instant is a
 * function of the **send**, not of the moment a worker happened to reach a given recipient.
 * `updates.send` is retried (`jobs.ts`, `retryLimit: 5`) and a stalled send is re-enqueued
 * after `SEND_STALE_MINUTES`, and a resumed run renders exactly the recipients still `queued`
 * — so an instant taken from `now()` would hand those readers a different URL from the ones
 * delivered before the crash, splitting one audience into retry cohorts. Nobody would see a
 * bug; they would see two `<img src>` values where D5 promises one.
 *
 * `created_at` is the only timestamp on the row a retry cannot move. It is `NOT NULL DEFAULT
 * now()` at insert and `SendRepo.update`'s patch type does not include it, so no code path can
 * rewrite it; `started_at` is stamped on the `queued → running` transition and is null before
 * it; `finished_at` does not exist while the send is still running. It is also the column
 * `SendRepo.stale` already treats as the send's own clock.
 */
export function sendInstant(s: Pick<Send, "createdAt">): Date {
  return s.createdAt;
}

/**
 * The identity of a reader's audience (E2.4 §12 C4) — the memo key, and the same fact as
 * decision D5's shared chart URL: two readers that key alike see the same metrics, so they
 * share one hydrated payload and one `<img src>`.
 *
 * `kind` is part of the key and C4 does not mention it, which would have been a real defect:
 * a staff reader carries no group ids (`deliver` builds them that way and `audienceIncludes`
 * short-circuits on staff), so keying on the sorted groups alone would collide a staff
 * recipient — who sees every metric — with an external recipient in no group, who sees only
 * the ones published to everyone. One send can contain both: a `groups` audience admits staff
 * who belong to the group. The first of the two to be delivered would have decided what the
 * other saw.
 */
export function hydrationKey(reader: Reader): string {
  // The delegate scope is part of what a reader may see (F3: a KPI block is `all`-scope content).
  const scope = reader.delegateScope ?? "";
  return `${reader.kind}:${scope}:${[...reader.groupIds].sort().join(",")}`;
}

/**
 * One recipient's view of the update: sections their groups admit, with each reference block
 * carrying the payload resolved for them.
 *
 * Pure, and module-level rather than a closure, so the shared-URL property of decision D5 can
 * be asserted end to end in a unit test without a database: hydrate two readers, render, and
 * compare the `<img src>` each is handed.
 */
export function sectionsFor(
  version: PostVersion,
  reader: Reader,
  disclaimers: ReadonlyMap<string, JsonObject>,
  hydratedBlocks: ReadonlyMap<string, JsonObject>,
) {
  const rules = parseSectionRules(version.visibility);
  const doc = version.doc as PageDoc;
  return doc.sections
    .filter((sec) => sectionVisible(rules[sec.key] ?? { mode: "authenticated" }, reader))
    .map((sec) => ({
      key: sec.key,
      title: sec.title,
      blocks: sec.blocks.map((b): RenderedBlock => {
        const data = b.data as RenderedBlock["data"];
        /*
         * `disclaimer` keeps its own send-level map: its text is the same for everyone on the
         * list (see `disclaimersFor`), so paying for it per audience would be waste. Every
         * other reference block is resolved per audience, because what a reader may see is
         * decided by their groups.
         */
        const hydrated =
          b.type === "disclaimer"
            ? disclaimers.get(slugOf(b.data as JsonObject) ?? "")
            : hydratedBlocks.get(b.id);
        return {
          id: b.id,
          type: b.type,
          schemaVersion: b.schemaVersion,
          data: hydrated === undefined ? data : { ...data, hydrated },
        };
      }),
    }));
}

/**
 * Reference blocks hydrated for one reader, keyed by block id — the send path's half of
 * E2.4 §10. Runs the **registered** hydrator through `services.registry.blockHydrators`,
 * exactly as the web archive does (`posts.ts` → `renderSections`): the metrics module
 * registers `metric_grid` and this file never imports it. Modules communicate through the
 * kernel, never by importing each other (ADR-0007, `.dependency-cruiser.cjs`).
 *
 * A hydrator that throws is logged and skipped, and the block keeps the archive link it has
 * always had. An update that failed to deliver because a KPI chart could not be drawn would be
 * a far worse bug than a missing chart, so every failure on this path degrades and none of
 * them propagates.
 */
async function hydrateBlocksFor(
  services: ModuleServices,
  ctx: TenantContext,
  doc: PageDoc,
  reader: Reader,
  enabled: ReadonlySet<string>,
  asOf: Date,
): Promise<ReadonlyMap<string, JsonObject>> {
  /*
   * Deliberately **no `membershipId` and no `facts`**, and the omission is the boundary of
   * what may be hydrated here. Both are per-person, and this result is memoised across every
   * recipient who shares an audience (C4) — so carrying one recipient's identity into it would
   * hand the first recipient's id to all of them. A block whose payload depends on the person
   * rather than on their groups therefore cannot be hydrated on this path, which is what
   * `EMAIL_HYDRATED_BLOCKS` says and why it is a list rather than "everything with a hydrator".
   */
  const context: BlockHydrationContext = {
    tenant: ctx,
    viewer: { kind: reader.kind, groupIds: reader.groupIds, delegateScope: reader.delegateScope },
    facts: {},
    // The message leaves the building, so a hydrator may hand back a capability URL its web
    // payload would not carry (E2.4 C-G.1): a mail client has no session to authenticate with.
    medium: "email",
    /*
     * One instant for the whole send (`sendInstant`), never `now()`. A hydrator that stamps its
     * own clock stamps it at millisecond precision, which makes the chart token a function of
     * *when* a recipient was reached rather than of *who* may see the numbers — and a resumed
     * send reaches half its recipients half an hour later. D5's shared URL has to survive that,
     * so the instant comes down from here and a retry of the same send reproduces it exactly.
     */
    asOf,
  };
  const out = new Map<string, JsonObject>();
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (!EMAIL_HYDRATED_BLOCKS.has(block.type)) continue;
      const provider = services.registry.blockHydrators.get(block.type);
      if (provider === undefined || !enabled.has(provider.module)) continue;
      try {
        out.set(block.id, await provider.hydrator.hydrate(block.data as JsonObject, context));
      } catch (error) {
        services.log("updates.block_hydration_failed", {
          level: "warn",
          blockType: block.type,
          module: provider.module,
          error: describeError(error),
        });
      }
    }
  }
  return out;
}

/**
 * The per-send memo (E2.4 §12 C4). `sectionsFor` runs once per recipient and a hydrator call
 * is a database read, so resolving a `metric_grid` per recipient would be one read per person
 * on the list. The key is the reader's audience — and that is the same fact as decision D5's
 * shared URL: recipients who key alike see the same metrics, so they share one hydrated payload
 * and therefore one `<img src>`, which is what keeps the image from being a tracking pixel. If
 * this memo ever stops being keyed on the audience, that property goes with it.
 *
 * Promises are memoised, not results: recipients are delivered one at a time today, but a batch
 * that ever runs concurrently must not start the same read twice.
 *
 * **A rejection is never the memoised answer, and never propagates.** `hydrateBlocksFor`
 * already catches what a hydrator throws, so a rejection here is pathological — the logger
 * threw, the narrowing threw, something outside the per-block guard did. Memoising it would
 * make one poison value the permanent answer for that whole audience (every recipient in it
 * fails identically, their rows stay `queued`, and each of the five retries re-runs the same
 * pill), and letting it propagate would abandon the send. So the failure is recorded, the key
 * is dropped so the next reader — or the next run — may try again, and this reader is handed
 * an empty map: their KPI block falls back to the archive link it has always had. An update
 * that failed to deliver because a KPI chart could not be drawn would be a far worse bug than
 * a missing chart.
 */
export function blockHydration(
  services: ModuleServices,
  ctx: TenantContext,
  doc: PageDoc,
  enabled: ReadonlySet<string>,
  asOf: Date,
): (reader: Reader) => Promise<ReadonlyMap<string, JsonObject>> {
  const memo = new Map<string, Promise<ReadonlyMap<string, JsonObject>>>();
  return (reader) => {
    const key = hydrationKey(reader);
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const pending: Promise<ReadonlyMap<string, JsonObject>> = hydrateBlocksFor(
      services,
      ctx,
      doc,
      reader,
      enabled,
      asOf,
    ).catch((error: unknown) => {
      if (memo.get(key) === pending) memo.delete(key);
      try {
        services.log("updates.block_hydration_failed", {
          level: "warn",
          reason: "hydration rejected outside the per-block guard",
          error: describeError(error),
        });
      } catch {
        // A logger that throws is not allowed to be the thing that stops a send either.
      }
      return EMPTY_HYDRATION;
    });
    memo.set(key, pending);
    return pending;
  };
}

const EMPTY_HYDRATION: ReadonlyMap<string, JsonObject> = new Map();

export function createDeliveryService(services: ModuleServices) {
  const { db, mailer } = services;
  const domains = createSendingDomainService(services);
  const subscriptions = createSubscriptionService(services);
  const now = () => services.now();

  /** Members of the audience with their live group ids (externals only for `all`). */
  async function candidates(ctx: TenantContext, tx: Tx, audience: Audience): Promise<Candidate[]> {
    const members = new MembershipRepo(ctx, tx);
    const out = new Map<string, Candidate>();
    const pages = async (groupId?: string) => {
      let cursor: string | undefined;
      do {
        const page = await members.listPeople({
          ...(audience.kind === "all" ? { kind: "external" } : {}),
          statuses: [...ELIGIBLE],
          ...(groupId !== undefined ? { groupId } : {}),
          limit: 500,
          ...(cursor !== undefined ? { cursor } : {}),
        });
        for (const row of page.items) {
          // An expired membership is not a member (P1-01); `listPeople` filters status only.
          if (membershipLapsed(row.membership.expiresAt, now())) continue;
          // F3: no update is a `data_room` delegate's to receive, whatever its audience.
          if (!delegationAdmitsModule(delegateScopeOf(row.membership), "updates")) continue;
          out.set(row.membership.id, {
            membershipId: row.membership.id,
            email: row.email,
            kind: row.membership.kind,
            groupIds: row.groups.map((g) => g.id),
          });
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
    };
    if (audience.kind === "all") await pages();
    else for (const g of audience.groupIds) await pages(g);
    return [...out.values()];
  }

  async function ensureRecipients(
    ctx: TenantContext,
    s: Send,
    version: PostVersion,
    testTo: readonly string[],
  ): Promise<void> {
    await db.withTenant(ctx, async (tx) => {
      const recipients = new RecipientRepo(ctx, tx);
      if ((await recipients.forSend(s.id)).length > 0) return;
      const rows: Parameters<RecipientRepo["createMany"]>[0][number][] = [];
      if (s.kind === "test") {
        for (const email of new Set(testTo.map((e) => e.trim().toLowerCase()))) {
          rows.push({ sendId: s.id, membershipId: s.requestedBy, email });
        }
      } else {
        const list = await candidates(ctx, tx, parseAudience(version.audience));
        const unsubscribed = await new UnsubscribeRepo(ctx, tx).membershipIds();
        const seen = new Set<string>();
        for (const c of list) {
          if (c.email === null) {
            rows.push({
              sendId: s.id,
              membershipId: c.membershipId,
              email: `${c.membershipId}@no-email.invalid`,
              status: "skipped",
              error: "no email address",
            });
            continue;
          }
          const email = c.email.toLowerCase();
          if (seen.has(email)) continue;
          seen.add(email);
          if (unsubscribed.has(c.membershipId)) {
            rows.push({
              sendId: s.id,
              membershipId: c.membershipId,
              email,
              status: "skipped",
              error: "unsubscribed",
            });
            continue;
          }
          rows.push({ sendId: s.id, membershipId: c.membershipId, email });
        }
      }
      await recipients.createMany(rows);
      await new SendRepo(ctx, tx).update(s.id, { total: rows.length });
    });
  }

  /**
   * Disclaimer blocks are hydrated once per send, not once per recipient: the legal text is
   * the same for everyone on the list, and an email that only linked to it would defeat the
   * point of putting the legend under the update. The key is the block's slug, or the empty
   * string for "the workspace default".
   */
  async function disclaimersFor(
    ctx: TenantContext,
    doc: PageDoc,
  ): Promise<ReadonlyMap<string, JsonObject>> {
    const slugs = new Set<string>();
    for (const section of doc.sections) {
      for (const block of section.blocks) {
        if (block.type === "disclaimer") slugs.add(slugOf(block.data as JsonObject) ?? "");
      }
    }
    if (slugs.size === 0) return new Map();
    return db.withTenant(ctx, async (tx) => {
      const out = new Map<string, JsonObject>();
      for (const slug of slugs) {
        const resolved = await services.legal.resolveDisclaimer(
          tx,
          ctx,
          slug === "" ? undefined : slug,
        );
        if (resolved !== undefined) out.set(slug, disclaimerPayload(resolved));
      }
      return out;
    });
  }

  /** Enabled module ids, or an empty set: a registry we cannot read hydrates nothing. */
  async function enabledModules(ctx: TenantContext): Promise<ReadonlySet<string>> {
    try {
      return (await services.enablement.get(db, ctx)).enabled;
    } catch (error) {
      services.log("updates.enablement_unavailable", {
        level: "warn",
        workspaceId: ctx.workspaceId,
        error: describeError(error),
      });
      return new Set<string>();
    }
  }

  return {
    candidates,

    /** Runs (or resumes) one send. Safe to call again after a crash. */
    async run(
      workspaceId: string,
      sendId: string,
      testTo: readonly string[],
      signal?: AbortSignal,
    ): Promise<SendResult> {
      const ctx = systemContext(workspaceId);
      const workspace = await findWorkspaceById(db, workspaceId);
      if (workspace === undefined) throw new Error(`workspace ${workspaceId} is gone`);
      const parsedSettings = parseWorkspaceSettings(workspace.settings);
      const settings = parsedSettings.updates;
      // Read once per run: a mode flipped mid-send applies from the next send, not mid-list.
      const analyticsMode = parsedSettings.analytics.mode;

      const loaded = await db.withTenant(ctx, async (tx) => {
        const s = await new SendRepo(ctx, tx).byId(sendId);
        if (s === undefined) return undefined;
        const version = await new VersionRepo(ctx, tx).byId(s.versionId);
        const post = await new PostRepo(ctx, tx).live(s.postId);
        return version === undefined ? undefined : { s, version, post };
      });
      if (loaded === undefined) throw new Error(`send ${sendId} not found`);
      const { version, post } = loaded;
      let s = loaded.s;
      if (s.status === "finished")
        return { sendId, total: s.total, sent: s.sent, failed: s.failed, skipped: s.skipped };
      /*
       * E3.10 FR1: a held or suspended workspace sends nothing. The send is left as it is
       * (`queued` / `running`, recipients untouched) — deferred, not dropped: `updates.dispatch`,
       * which walks active workspaces only, re-enqueues it as stale once the workspace is active
       * again. Checked here and before every batch, so a suspension mid-send stops the rest.
       */
      const held = (): SendResult => {
        services.log("updates.send_held", { workspaceId, sendId });
        return { sendId, total: s.total, sent: s.sent, failed: s.failed, skipped: s.skipped };
      };
      if (!(await db.withTenant(ctx, (tx) => workspaceIsActive(tx, workspaceId)))) return held();
      if (s.status === "queued") {
        s =
          (await db.withTenant(ctx, (tx) =>
            new SendRepo(ctx, tx).setStatus(sendId, "queued", "running", { startedAt: now() }),
          )) ?? s;
      }
      await ensureRecipients(ctx, s, version, testTo);

      // Sender identity, reply-to and the DKIM signer are fixed for the whole send.
      const sender = await db.withTenant(ctx, async (tx) => {
        const signer = await domains.signer(tx, ctx);
        const names = post?.authorMembershipId
          ? await new MembershipRepo(ctx, tx).namesFor([post.authorMembershipId])
          : new Map();
        const author = post?.authorMembershipId ? names.get(post.authorMembershipId) : undefined;
        return {
          from: signer
            ? {
                address: `${settings.fromLocalPart}@${signer.domain}`,
                name: settings.fromName ?? workspace.name,
              }
            : undefined,
          dkim: signer?.dkim,
          replyTo: settings.replyTo ?? author?.email ?? undefined,
          fromName: settings.fromName ?? workspace.name,
        };
      });
      const slug = post?.slug ?? s.postId;
      const archiveUrl = services.workspaceUrl(workspace, `/updates/${slug}`).href;
      const disclaimers = await disclaimersFor(ctx, version.doc as PageDoc);
      /*
       * Enablement is read once per send and only when the document actually carries a block
       * this path hydrates: a workspace with the metrics module switched off, or an update
       * with no `metric_grid` in it, pays nothing for any of this.
       */
      const doc = version.doc as PageDoc;
      const hydrates = doc.sections.some((sec) =>
        sec.blocks.some((b) => EMAIL_HYDRATED_BLOCKS.has(b.type)),
      );
      const hydrateFor = blockHydration(
        services,
        ctx,
        doc,
        hydrates ? await enabledModules(ctx) : new Set<string>(),
        // Not `now()`: the memo below is rebuilt on every run, so the send's own timestamp is
        // the only thing that makes a resumed run reproduce the URL the first one sent (D5).
        sendInstant(s),
      );

      /*
       * Rows this run tried and left `queued`: `deferred` after a transient failure, `busy`
       * when another run of this send holds the row. Neither is read again by this run, and
       * either one means the send is not finished yet — the run throws instead of closing it.
       */
      const deferred = new Set<string>();
      const busy = new Set<string>();
      let streak = 0;
      /** The run stopped on a transient streak (transport down) rather than at the list's end. */
      let stoppedEarly = false;
      const retryUntil = s.createdAt.getTime() + SEND_RETRY_WINDOW_HOURS * 3_600_000;
      batches: for (;;) {
        if (signal?.aborted) throw new Error("send aborted");
        const batch = await db.withTenant(ctx, async (tx) =>
          (await workspaceIsActive(tx, workspaceId))
            ? new RecipientRepo(ctx, tx).queued(sendId, SEND_BATCH, [...deferred, ...busy])
            : undefined,
        );
        if (batch === undefined) return held();
        if (batch.length === 0) break;
        for (const r of batch) {
          if (signal?.aborted) throw new Error("send aborted");
          const outcome = await deliver(
            ctx,
            r,
            s,
            version,
            workspace,
            settings,
            sender,
            archiveUrl,
            disclaimers,
            hydrateFor,
            analyticsMode,
            now().getTime() < retryUntil,
          );
          if (outcome === "deferred") {
            deferred.add(r.id);
            // The transport is down, not one mailbox: stop here rather than wait out a
            // connection timeout for every name left on the list.
            if (++streak >= SEND_TRANSIENT_STREAK) {
              stoppedEarly = true;
              break batches;
            }
          } else if (outcome === "busy") {
            busy.add(r.id);
          } else {
            streak = 0;
          }
        }
      }
      if (deferred.size > 0 || busy.size > 0) {
        services.log("updates.send_deferred", {
          level: "warn",
          workspaceId,
          sendId,
          deferred: deferred.size,
          busy: busy.size,
        });
        /*
         * Every recipient has been tried and some mail went out: the post goes into the archive
         * now, not when the last deferred address finally takes it (review R1-A4). One mailbox
         * answering 4xx for a day used to keep the post `sending` — and the "view on the web"
         * link in every mail already delivered answering 404 — for up to 24 h. Not when the run
         * stopped on a transport outage: then most of the list has not been tried yet.
         */
        if (!stoppedEarly && s.kind === "live" && post !== undefined) {
          await db.withTenant(ctx, async (tx) => {
            const c = await new RecipientRepo(ctx, tx).counts(sendId);
            if (c.sent + c.delivered + c.bounced + c.complained === 0) return;
            const published = await new PostRepo(ctx, tx).transition(post.id, "sending", "sent", {
              sentAt: now(),
            });
            if (published !== undefined) await indexPost(services, tx, ctx, published);
          });
        }
        throw new DeliveryDeferredError(deferred.size, busy.size);
      }

      const result = await db.withTenant(ctx, async (tx) => {
        const counts = await new RecipientRepo(ctx, tx).counts(sendId);
        const sends = new SendRepo(ctx, tx);
        /*
         * `sent` is what the provider *accepted*. A webhook can outrun this line — a recipient
         * reported delivered (or bounced) before the last batch closed has already moved past
         * `sent` — so every rung above it on the feedback ladder counts as sent too. The
         * delivered/bounced/complained counters themselves belong to the subscriber and are
         * not written here.
         */
        const accepted = counts.sent + counts.delivered + counts.bounced + counts.complained;
        const finished = await sends.update(sendId, {
          status: "finished",
          sent: accepted,
          failed: counts.failed,
          skipped: counts.skipped,
          finishedAt: now(),
        });
        const total = finished?.total ?? accepted + counts.failed + counts.skipped;
        if (s.kind === "live" && post !== undefined) {
          const sent = await new PostRepo(ctx, tx).transition(post.id, "sending", "sent", {
            sentAt: now(),
          });
          // Searchable from the moment the archive serves it, in the same transaction.
          if (sent !== undefined) await indexPost(services, tx, ctx, sent);
        }
        await services.audit.record(tx, ctx, {
          action: s.kind === "live" ? "update.sent" : "update.test_sent",
          resourceKind: "post",
          resourceId: s.postId,
          ...(s.requestedBy ? { actorMembershipId: s.requestedBy } : {}),
          meta: {
            sendId,
            versionId: version.id,
            total,
            sent: accepted,
            failed: counts.failed,
            skipped: counts.skipped,
          },
        });
        await publish(tx, ctx, "update.sent", {
          postId: s.postId,
          sendId,
          kind: s.kind,
          sent: accepted,
          failed: counts.failed,
        });
        return { sendId, total, sent: accepted, failed: counts.failed, skipped: counts.skipped };
      });
      services.log("updates.send_finished", { workspaceId, kind: s.kind, ...result });
      return result;
    },
  };

  async function deliver(
    ctx: TenantContext,
    r: Recipient,
    s: Send,
    version: PostVersion,
    workspace: { slug: string; name: string; primaryHost: string | null },
    settings: ReturnType<typeof parseWorkspaceSettings>["updates"],
    sender: {
      from: OutboundEmail["from"];
      dkim: OutboundEmail["dkim"];
      replyTo: string | undefined;
      fromName: string;
    },
    archiveUrl: string,
    disclaimers: ReadonlyMap<string, JsonObject>,
    hydrateFor: (reader: Reader) => Promise<ReadonlyMap<string, JsonObject>>,
    analyticsMode: "off" | "essential" | "engagement",
    mayRetry: boolean,
  ): Promise<Outcome> {
    const { reader, tracking, locale, ineligible } = await db.withTenant(ctx, async (tx) => {
      const tracking = await trackingFor(services, tx, ctx, {
        analyticsMode,
        sendKind: s.kind,
        membershipId: r.membershipId,
      });
      // E2.8: the recipient's language (`user.locale ?? workspace.default_locale ?? "en"`). A
      // test send goes to the requesting staff member, whose membership is on the row.
      const members =
        r.membershipId === null ? [] : await new MembershipRepo(ctx, tx).byIds([r.membershipId]);
      const locale = await recipientLocale(tx, {
        userId: members[0]?.userId,
        workspaceId: ctx.workspaceId,
      });
      if (s.kind === "test" || r.membershipId === null) {
        return {
          reader: { kind: "staff", groupIds: [] } as Reader,
          tracking,
          locale,
          ineligible: undefined,
        };
      }
      const { GroupRepo } = await import("@fundroom/identity");
      const member = members[0];
      const kind = member?.kind ?? "external";
      const groupIds = await new GroupRepo(ctx, tx).groupIdsFor(r.membershipId);
      const reader: Reader = {
        kind,
        groupIds: kind === "staff" ? [] : groupIds,
        delegateScope: member === undefined ? null : delegateScopeOf(member),
      };
      const ineligible = ineligibleReason(member, parseAudience(version.audience), groupIds, now());
      return { reader, tracking, locale, ineligible };
    });
    if (ineligible !== undefined) {
      // Skipped under the same row lock a send takes, so a concurrent run cannot send it either.
      return db.withTenant(ctx, async (tx): Promise<Outcome> => {
        const recipients = new RecipientRepo(ctx, tx);
        if ((await recipients.claimQueued(r.id)) === undefined)
          return (await recipients.statusOf(r.id)) === "queued" ? "busy" : "done";
        services.log("updates.recipient_ineligible", { sendId: s.id, reason: ineligible });
        await recipients.mark(r.id, { status: "skipped", error: ineligible, lastEventAt: now() });
        return "done";
      });
    }
    const unsubscribeToken =
      s.kind === "live" && r.membershipId !== null && reader.kind === "external"
        ? await db.withTenant(ctx, (tx) => subscriptions.token(tx, ctx, r.membershipId as string))
        : undefined;
    const unsubscribePage = unsubscribeToken
      ? services.workspaceUrl(
          workspace,
          `/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`,
        ).href
      : undefined;
    const oneClick = unsubscribeToken
      ? services.workspaceUrl(
          workspace,
          `/api/v1/updates/unsubscribe?token=${encodeURIComponent(unsubscribeToken)}`,
        ).href
      : undefined;
    /*
     * Hydration, rendering and the message literal all live **inside** the guard, and the
     * awaited memo above all.
     *
     * It used to be awaited out here, one statement above the `try`. Everything on this path
     * degrades — `blockHydration` never rejects and a hydrator that throws is logged and
     * skipped — but "everything" was resting on no unforeseen throw ever escaping, and one
     * did: the old narrowing threw on a pathological throw value. A rejection out here is not
     * this recipient failing, it is `deliver` throwing, which is `run` throwing, which leaves
     * every remaining recipient row `queued` for a retry that will do the same thing five more
     * times. Inside the guard the worst case is one recipient marked `failed` with the reason
     * on their row, and the send carries on down the list.
     */
    let message: OutboundEmail;
    try {
      const rendered = renderUpdateEmail({
        title: version.title,
        sections: sectionsFor(version, reader, disclaimers, await hydrateFor(reader)),
        workspaceName: workspace.name,
        archiveUrl,
        unsubscribeUrl: unsubscribePage,
        postalAddress: settings.postalAddress,
        footerNote: settings.footerNote,
        test: s.kind === "test",
        locale,
      });
      message = {
        to: r.email,
        // An update is always sent on behalf of its workspace (E1.7). The HTML is rendered here
        // rather than from a mail template, so the brand resolver does not restyle it; the field
        // still belongs on the message so adapters and delivery logs agree on the sender.
        workspaceId: ctx.workspaceId,
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
        tags: ["updates", s.kind],
        idempotencyKey: `updates:${s.id}:${r.id}`,
        /*
         * E2.6: an update is bulk mail, so the kernel's suppression wrapper applies to it, and
         * `ref` is what lets a delivery webhook find this recipient row again. A test send
         * carries no membership on its ref: the address was typed by staff, the membership on
         * the row is the requester's, and analytics must not credit them with an "open".
         */
        stream: "broadcast",
        ref: {
          kind: "post",
          id: s.postId,
          ...(s.kind === "live" && r.membershipId !== null ? { membershipId: r.membershipId } : {}),
        },
        ...(tracking !== undefined ? { tracking } : {}),
        headers: {
          "List-Id": `${workspace.name} investor updates <updates.${workspace.slug}.${services.baseUrl.host}>`,
          ...(oneClick
            ? {
                "List-Unsubscribe": `<${oneClick}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              }
            : {}),
          "Auto-Submitted": "auto-generated",
        },
        ...(sender.replyTo !== undefined ? { replyTo: sender.replyTo } : {}),
        ...(sender.from !== undefined ? { from: sender.from } : {}),
        ...(sender.dkim !== undefined ? { dkim: sender.dkim } : {}),
      };
    } catch (error) {
      // Rendering is ours and deterministic: a throw here fails the same way on every retry.
      const reason = describeError(error);
      services.log("updates.recipient_failed", {
        level: "warn",
        sendId: s.id,
        to: maskEmail(r.email),
        error: reason,
      });
      await db.withTenant(ctx, (tx) =>
        new RecipientRepo(ctx, tx).mark(r.id, {
          status: "failed",
          error: reason.slice(0, 1000),
          lastEventAt: now(),
        }),
      );
      return "done";
    }

    /*
     * Claim, send and record in **one** transaction (exactly once per recipient). The row is
     * locked `FOR UPDATE SKIP LOCKED` while it is still `queued`; a concurrent run of the same
     * send skips it (`busy`) and a later one finds it no longer `queued`. Holding a main-pool
     * connection across `mailer.send` is the documented pattern (`apps/server/src/mail/
     * feedback.ts`: the kernel mailer's own reads run on a pool of their own). The residual
     * at-least-once window is the one every mail system has: the provider accepted the message
     * and this commit then failed — the row stays `queued` and the retry sends it again, with
     * the same `idempotencyKey` for adapters that honour one.
     */
    return db.withTenant(ctx, async (tx): Promise<Outcome> => {
      const recipients = new RecipientRepo(ctx, tx);
      const claimed = await recipients.claimQueued(r.id);
      if (claimed === undefined) {
        // Sent, failed or skipped by another run since this batch was read (done: it will not
        // be read again), or being sent by one right now (busy: this run must not close the send).
        return (await recipients.statusOf(r.id)) === "queued" ? "busy" : "done";
      }
      try {
        const sent = await mailer.send(message);
        await recipients.mark(r.id, {
          status: "sent",
          messageId: sent.messageId,
          sentAt: sent.acceptedAt,
          lastEventAt: sent.acceptedAt,
          error: null,
        });
        return "done";
      } catch (error) {
        if (isSuppressed(error)) {
          /*
           * The workspace suppressed this address after a hard bounce or a complaint (E2.6
           * decision 3). That is a decision, not a failure: `skipped`, like an unsubscribe, and
           * never retried. The reason string is fixed — the wrapper's message is not ours to
           * store.
           */
          services.log("updates.recipient_suppressed", { sendId: s.id, to: maskEmail(r.email) });
          await recipients.mark(r.id, {
            status: "skipped",
            error: "suppressed",
            lastEventAt: now(),
          });
          return "done";
        }
        const reason = describeError(error);
        if (mayRetry && isTransientMailError(error)) {
          /*
           * Nothing was accepted (the server was unreachable, timed out or answered 4xx), so the
           * row stays `queued` — the only state a later run sends from — with the reason on it
           * for the admin view. The run defers and the job is retried.
           */
          services.log("updates.recipient_deferred", {
            level: "warn",
            sendId: s.id,
            to: maskEmail(r.email),
            error: reason,
          });
          await recipients.mark(r.id, {
            error: `retrying: ${reason}`.slice(0, 1000),
            lastEventAt: now(),
          });
          return "deferred";
        }
        services.log("updates.recipient_failed", {
          level: "warn",
          sendId: s.id,
          to: maskEmail(r.email),
          error: reason,
        });
        await recipients.mark(r.id, {
          status: "failed",
          error: reason.slice(0, 1000),
          lastEventAt: now(),
        });
        return "done";
      }
    });
  }
}

export type DeliveryService = ReturnType<typeof createDeliveryService>;
