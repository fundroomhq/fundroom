import type { AuditRecorder } from "@fundroom/audit";
import type { OfferingStatus, TenantContext, Tx } from "@fundroom/db";
import type { InviteGrant } from "@fundroom/domain";
import type { LinkPolicy, ResolvedLink, ShareLinkStatus } from "../policy.js";
import type { CodeKeyRing } from "../token.js";

/*
 * What the share-link service is given, and the shape of the data it moves.
 *
 * Every method takes `(ctx, tx, …)` rather than opening its own transaction — the same rule
 * `@fundroom/compliance` follows and for the same reason. Redeeming a link is one transaction
 * that claims a use, writes the binding, creates a membership, applies groups and grants, bumps
 * `acl_version` and writes an audit row; a service that opened its own transaction could not be
 * composed with the identity flow that owns the rest of it.
 *
 * The row types here are **this package's**, not work package A's drizzle types. The repository
 * maps `core.share_link` onto them. That keeps the service and its tests off the schema (a fake
 * store is six fields, not twenty-three) and means a column added by A is a change in one file.
 */

/** A `core.share_link` row, as this package uses it. */
export interface LinkRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly label: string;
  readonly status: ShareLinkStatus;
  readonly policy: LinkPolicy;
  readonly grants: readonly InviteGrant[];
  readonly groupIds: readonly string[];
  /** The keyed HMAC, or `null` when the link has no passcode. Never leaves the server. */
  readonly passcodeHash: Uint8Array | null;
  readonly passcodeAttempts: number;
  readonly passcodeLockedUntil: Date | null;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly maxViews: number | null;
  readonly views: number;
  readonly expiresAt: Date | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
}

/** What the admin list shows. Never the token hash, never the passcode hash. */
export interface LinkSummary {
  readonly id: string;
  readonly label: string;
  readonly status: ShareLinkStatus;
  readonly policy: LinkPolicy;
  readonly grants: readonly InviteGrant[];
  readonly groupIds: readonly string[];
  /** Whether a passcode is set — never the passcode, and never its hash. */
  readonly passcodeRequired: boolean;
  readonly maxUses: number | null;
  readonly uses: number;
  readonly maxViews: number | null;
  readonly views: number;
  readonly expiresAt: Date | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly revokedAt: Date | null;
  /** Live bindings: memberships this link admitted and has not had individually revoked. */
  readonly visits: number;
}

/** One membership's binding to one link (`core.share_link_visit`). */
export interface LinkVisit {
  readonly id: string;
  readonly membershipId: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly views: number;
  readonly revokedAt: Date | null;
}

export interface CreateShareLinkValues {
  readonly label: string;
  readonly tokenHash: Uint8Array;
  readonly policy: LinkPolicy;
  readonly grants: readonly InviteGrant[];
  readonly groupIds: readonly string[];
  readonly passcodeHash: Uint8Array | null;
  readonly maxUses: number | null;
  readonly maxViews: number | null;
  readonly expiresAt: Date | null;
  readonly createdBy: string | null;
}

/** What one `upsertVisit` says: the binding, and whether *this* call created it. */
export interface VisitClaim {
  readonly visitId: string;
  readonly inserted: boolean;
  readonly revokedAt: Date | null;
}

export interface ListFilter {
  readonly status?: ShareLinkStatus | undefined;
  /** Default 200, the ceiling `InviteService.list` uses. */
  readonly limit?: number | undefined;
  /** Include revoked links. Default false: the admin list is about live sharing. */
  readonly includeRevoked?: boolean | undefined;
}

/**
 * The data access the service needs. A seam, exactly as `CustomDomainStore` is: unit tests pass a
 * fake, the default is `ShareLinkRepo`.
 *
 * The three `claim*` methods are the load-bearing ones. Each is **one SQL statement** whose
 * `WHERE` carries the cap and whose `SET` carries the increment, so the guard and the write
 * cannot be separated by another transaction. A fake that implements them as check-then-set
 * without an intervening `await` models that faithfully; a service that decided a cap from a row
 * it read earlier would fail such a test, which is the point of it.
 */
export interface ShareLinkStore {
  create(values: CreateShareLinkValues): Promise<LinkRecord>;
  byId(id: string): Promise<LinkRecord | undefined>;
  byTokenHash(hash: Uint8Array): Promise<LinkRecord | undefined>;
  list(filter?: ListFilter): Promise<readonly LinkSummary[]>;
  /** `+1 use` if and only if the link is live and under `max_uses`. `undefined` = refused. */
  claimUse(id: string, now: Date): Promise<number | undefined>;
  /** `+1 view` if and only if the link is live and under `max_views`. `undefined` = refused. */
  claimView(id: string, now: Date): Promise<number | undefined>;
  upsertVisit(input: {
    readonly linkId: string;
    readonly membershipId: string;
    readonly now: Date;
    readonly passcodeOkAt?: Date | null | undefined;
  }): Promise<VisitClaim>;
  /**
   * Claims `(link, membership, session)` against the view budget. True when this session had not
   * been counted before and now has been; false when it had. One statement
   * (`INSERT … ON CONFLICT DO NOTHING RETURNING`), so it is also the concurrency answer.
   */
  claimViewSession(input: ViewSessionKey): Promise<boolean>;
  /** `+1 view` on one membership's binding. False when there is no live binding to count it on. */
  countVisitView(linkId: string, membershipId: string, now: Date): Promise<boolean>;
  /** Writes the keyed HMAC after the row exists; its scope contains the link id. */
  setPasscodeHash(id: string, hash: Uint8Array): Promise<LinkRecord | undefined>;
  recordPasscodeAttempt(id: string, now: Date): Promise<number | undefined>;
  /** Locks the link **and resets the counter**: the lock is the punishment, not the counter. */
  lockPasscode(id: string, until: Date): Promise<void>;
  clearPasscodeAttempts(id: string): Promise<void>;
  revoke(id: string, at: Date, by: string | null): Promise<LinkRecord | undefined>;
  setPaused(id: string, paused: boolean): Promise<LinkRecord | undefined>;
  revokeVisit(linkId: string, membershipId: string, at: Date): Promise<boolean>;
  visits(linkId: string): Promise<readonly LinkVisit[]>;
  /**
   * Writes the link's own `core.access_grant` rows, **against the link** (contract §2).
   *
   * One row per (resource, capability), `subject_kind = 'link'`, `subject_id = <link id>`, written
   * once when the link is minted and never copied onto a visitor. Returns how many rows were
   * written. See `ShareLinkService.mint` for why this is the only place they are written and
   * `revoke` for why nothing ever has to unwrite them.
   */
  writeLinkGrants(input: WriteLinkGrantsInput): Promise<number>;
  /** `core.workspace.offering_status`, for the shape rule (D6). */
  offeringStatus(): Promise<OfferingStatus | undefined>;
  /** Bumps `core.workspace.acl_version` and publishes `acl.changed` (D8; E3.13 R3-6). */
  bumpAcl(cause: string): Promise<void>;
}

/** What one `writeLinkGrants` call writes: the link's promise, as grant rows on the link. */
export interface WriteLinkGrantsInput {
  readonly linkId: string;
  readonly grants: readonly InviteGrant[];
  /** `link:<id>`, so the access screen can say where a rule came from. */
  readonly note: string;
  readonly createdBy: string | null;
}

/** The triple a view is deduped on, plus the clock the claim is stamped with. */
export interface ViewSessionKey {
  readonly linkId: string;
  readonly membershipId: string;
  /** `core.session.id`. A uuid: the column it lands in is one, and the service checks. */
  readonly sessionId: string;
  readonly now: Date;
}

/**
 * Which `(link, membership, session)` triples have already been counted against a view budget.
 *
 * `design/05` §4.4 says a view limit "counts *unique sessions*, not requests", so a visitor who
 * reloads a document forty times in one sitting has spent one view — and something has to
 * remember which sessions were counted. **The default is the database**
 * (`core.share_link_view`, migration `0008`): one row per counted session, claimed with
 * `INSERT … ON CONFLICT DO NOTHING RETURNING`, so the memory outlives the process and is shared
 * by every node.
 *
 * It stays an interface because it was one when the durable table did not exist yet, and the
 * seam turned out to be worth keeping for the test that proves the table earns its place — see
 * `createMemoryViewSessionLedger` below.
 */
export interface ViewSessionLedger {
  /**
   * True when this triple had not been counted before, and is now.
   *
   * Takes the store rather than closing over one: the claim runs in the *caller's* transaction,
   * so the ledger cannot hold a connection of its own — `noteView` is one unit of work with the
   * increment it gates, and a claim that committed separately could count a view the
   * transaction then rolled back.
   */
  claim(store: ShareLinkStore, key: ViewSessionKey): Promise<boolean>;
}

/**
 * The default: one row in `core.share_link_view` per counted session.
 *
 * There is nothing to configure, so it is a value rather than a factory.
 */
export const databaseViewSessionLedger: ViewSessionLedger = {
  claim: (store, key) => store.claimViewSession(key),
};

/** Cap on the in-process ledger. Cleared wholesale when full, like the domain lookup cache. */
export const VIEW_SESSION_LEDGER_MAX = 10_000;

/**
 * The per-process ledger, kept **only as the negative control** and never wired by default.
 *
 * It is what `noteView` used before `core.share_link_view` existed, and it is wrong in one
 * specific way: a restart or a second node has an empty set, so a session already counted gets
 * counted again and a `max_views` budget shortens itself on every redeploy. The integration test
 * that proves the durable ledger works injects *this* one first and watches the cap break; take
 * it away and the proof becomes "the code does what it does". That is the whole of its job —
 * no production wiring should reach for it.
 *
 * Its error was always in the safe direction (a budget reached sooner, never later), which is
 * why it was acceptable for one work package and is not acceptable now.
 */
export function createMemoryViewSessionLedger(max = VIEW_SESSION_LEDGER_MAX): ViewSessionLedger {
  const seen = new Set<string>();
  return {
    async claim(_store, key) {
      const k = `${key.linkId}:${key.membershipId}:${key.sessionId}`;
      if (seen.has(k)) return false;
      // Clear-on-full rather than TTL: the key contains a session id, so an attacker who can
      // start sessions chooses how many entries exist. Losing the set costs at most one
      // over-count per live session, which is the safe direction.
      if (seen.size >= max) seen.clear();
      seen.add(k);
      return true;
    },
  };
}

export interface ShareLinkDeps {
  readonly audit: Pick<AuditRecorder, "record">;
  /**
   * The operator's key ring. Only ever used to HMAC a passcode — the link token is a plain
   * digest, because 256 bits of entropy has no dictionary behind it (see `token.ts`).
   */
  readonly keyRing: CodeKeyRing;
  /**
   * The merged, globally-unique set of registered resource kinds
   * (`registry.resourceKinds`, contract S3). A grant naming a kind no module registered can never
   * be satisfied by anybody, so it is refused at mint time rather than written as a grant that
   * silently grants nothing. Left undefined — in a unit test, or before the registry is built —
   * the check is skipped, because refusing every kind would be worse than refusing none.
   */
  readonly resourceKinds?: (() => Iterable<string>) | undefined;
  readonly now?: (() => Date) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
  /**
   * Where "this session was already counted" is remembered. Default:
   * `databaseViewSessionLedger`, one row in `core.share_link_view` per counted session.
   */
  readonly viewSessions?: ViewSessionLedger | undefined;
  /** Test seam. Defaults to `new ShareLinkRepo(ctx, tx)`. */
  readonly store?: ((ctx: TenantContext, tx: Tx) => ShareLinkStore) | undefined;
}

export function nowOf(deps: ShareLinkDeps): Date {
  return deps.now?.() ?? new Date();
}

/**
 * The admission snapshot of a row: everything the pure rules need and nothing that would let a
 * caller learn what the link points at before they are admitted (D7). Lives here, beside the row
 * shape it narrows, so that both the repository and the service can reach it without either
 * importing the other.
 */
export function toResolvedLink(record: LinkRecord): ResolvedLink {
  return {
    id: record.id,
    workspaceId: record.workspaceId,
    status: record.status,
    policy: record.policy,
    passcodeRequired: record.passcodeHash !== null,
    passcodeAttempts: record.passcodeAttempts,
    passcodeLockedUntil: record.passcodeLockedUntil,
    maxUses: record.maxUses,
    uses: record.uses,
    maxViews: record.maxViews,
    views: record.views,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  };
}

/** What the admin list shows. The passcode hash is reduced to a boolean and never leaves here. */
export function toLinkSummary(record: LinkRecord, visits: number): LinkSummary {
  return {
    id: record.id,
    label: record.label,
    status: record.status,
    policy: record.policy,
    grants: record.grants,
    groupIds: record.groupIds,
    passcodeRequired: record.passcodeHash !== null,
    maxUses: record.maxUses,
    uses: record.uses,
    maxViews: record.maxViews,
    views: record.views,
    expiresAt: record.expiresAt,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    revokedAt: record.revokedAt,
    visits,
  };
}

export type { TenantContext, Tx };
