import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { coreSchema, workspace } from "./core.js";
import { bytea, membership } from "./identity.js";

/*
 * Share links and the visits they admit (EXECUTION_PLAN §7 and §11, design/05 §5, ADR-0014,
 * ADR-0032, ADR-0041, E2.3).
 *
 * Typed view of `migrations/core/0008_share_links.sql`; the SQL is authoritative (ADR-0004) —
 * the fences, the `set_updated_at` trigger and the `core.policy_target_kind += 'link'` value
 * all live there. The admission rules and the token minting live in `@fundroom/share-links`.
 *
 * Kernel, not a module table: the link is a *grant subject* (`core.access_grant.subject_kind`
 * has held `'link'` since 0004), and `core.share_link_visit` is the authorization edge
 * `PrincipalRepo` walks to emit that subject for a membership, and `core.share_link_view` is the
 * per-session ledger that makes a view cap mean "unique sessions" rather than "unique sessions
 * since this process last started". All three are facts a disabled module must not be able to
 * take away.
 */

export const shareLinkStatus = coreSchema.enum("share_link_status", [
  "active",
  "paused",
  "revoked",
]);

export const SHARE_LINK_STATUSES = shareLinkStatus.enumValues;
export type ShareLinkStatus = (typeof SHARE_LINK_STATUSES)[number];

/** The statuses that may admit a visitor; `paused` and `revoked` answer the same 404 (D7). */
export const SHARE_LINK_ADMITTING_STATUSES = [
  "active",
] as const satisfies readonly ShareLinkStatus[];

/**
 * One link an admin minted: the token digest, the admission controls (domain/named-email
 * policy, passcode, expiry, use and view ceilings) and the grants a redeemer receives.
 *
 * The plaintext token is returned by `mint()` once and never stored. `passcode_hash` is a
 * *keyed* HMAC rather than a bare digest, because a human-chosen passcode has too little
 * entropy for an unkeyed hash to survive a stolen dump.
 */
export const shareLink = coreSchema.table(
  "share_link",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    /** What the admin calls it; shown in the links list and in every audit row. */
    label: text("label").notNull(),
    /** `sha256(randomToken())`; the plaintext is never stored. */
    tokenHash: bytea("token_hash").notNull(),
    status: shareLinkStatus("status").notNull().default("active"),
    /** `LinkPolicy`: domain allowlist, named emails, forced watermark. */
    policy: jsonb("policy").notNull().default({}),
    policySchemaVersion: integer("policy_schema_version").notNull().default(1),
    /** The grants a redeemer receives, reusing the invite's `InviteGrantsSchema`. */
    grants: jsonb("grants").notNull().default([]),
    grantsSchemaVersion: integer("grants_schema_version").notNull().default(1),
    /** Target group(s), applied on membership creation exactly as an invite's are. */
    groupIds: uuid("group_ids").array().notNull().default(sql`'{}'`),
    /** Keyed HMAC-SHA256 of the passcode; null when the link has none. */
    passcodeHash: bytea("passcode_hash"),
    /** Guesses counted on the row being guessed, never on a client IP (D7, ADR-0039 §4). */
    passcodeAttempts: integer("passcode_attempts").notNull().default(0),
    passcodeLockedUntil: timestamp("passcode_locked_until", { withTimezone: true }),
    /** Ceiling on distinct memberships admitted; null = unlimited. */
    maxUses: integer("max_uses"),
    uses: integer("uses").notNull().default(0),
    /** Ceiling on distinct view sessions (design/05:175); null = unlimited. */
    maxViews: integer("max_views"),
    views: integer("views").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    /** Membership id of the staff member who minted it. */
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedBy: uuid("revoked_by"),
  },
  (t) => [
    // THE lookup. Deliberately global and deliberately not partial: a revoked or expired link
    // must still be *found*, so the route answers the same 404 an unknown token gets after the
    // same work. A partial index over live rows would make "revoked" a faster miss.
    uniqueIndex("share_link_token_hash_idx").on(t.tokenHash),
    // The admin list: newest first, live rows only.
    index("share_link_ws_idx")
      .on(t.workspaceId, t.createdAt.desc())
      .where(sql`${t.revokedAt} IS NULL`),
    // §13.2's revocation cascade reads exactly this: the live links one staff member minted.
    index("share_link_creator_idx")
      .on(t.workspaceId, t.createdBy)
      .where(sql`${t.revokedAt} IS NULL`),
    check("share_link_label_length", sql`char_length(${t.label}) BETWEEN 1 AND 200`),
    // A backstop against a direct SQL write: a short value means somebody stored a prefix.
    check("share_link_token_hash_length", sql`octet_length(${t.tokenHash}) = 32`),
    check(
      "share_link_passcode_hash_length",
      sql`${t.passcodeHash} IS NULL OR octet_length(${t.passcodeHash}) = 32`,
    ),
    check("share_link_max_uses_positive", sql`${t.maxUses} IS NULL OR ${t.maxUses} > 0`),
    check("share_link_max_views_positive", sql`${t.maxViews} IS NULL OR ${t.maxViews} > 0`),
    check(
      "share_link_counters_nonnegative",
      sql`${t.uses} >= 0 AND ${t.views} >= 0 AND ${t.passcodeAttempts} >= 0`,
    ),
  ],
);

/**
 * The membership ↔ link binding, and the reason `link` grants resolve for anybody:
 * `PrincipalRepo.listActive()` walks the live rows here to emit `{ kind: "link", id }` for a
 * membership, which is what materialises the link's grants into `core.effective_access`.
 *
 * Writing a row is therefore equivalent to granting access, which is why the migration's RLS
 * lets only `staff` and `system` write it, and lets an external member read its own rows only.
 */
export const shareLinkVisit = coreSchema.table(
  "share_link_visit",
  {
    id: uuid("id").primaryKey().default(sql`core.uuidv7()`),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    linkId: uuid("link_id")
      .notNull()
      .references(() => shareLink.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    views: integer("views").notNull().default(0),
    passcodeOkAt: timestamp("passcode_ok_at", { withTimezone: true }),
    /** Unbinds one visitor without revoking the link for everybody else. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    // One binding per (link, membership): `uses` counts distinct memberships, so a returning
    // visitor re-resolving their own link must not burn another use.
    uniqueIndex("share_link_visit_pair_idx").on(t.linkId, t.membershipId),
    // The join `PrincipalRepo` walks on every rebuild: membership-leading, live rows only.
    index("share_link_visit_membership_idx")
      .on(t.workspaceId, t.membershipId)
      .where(sql`${t.revokedAt} IS NULL`),
    check("share_link_visit_views_nonnegative", sql`${t.views} >= 0`),
  ],
);

/**
 * One row per `(link, membership, session)` already counted against a link's view budget.
 *
 * `design/05` §4.4 defines a view limit as counting **unique sessions, not requests**, and this
 * table is where "unique" is decided: the claim is a single
 * `INSERT … ON CONFLICT DO NOTHING RETURNING`, so a returned row means the session had not been
 * counted and the `share_link.views` increment may proceed, and no row means it had. One
 * statement, no read-then-write window, and — the point of the table — an answer that survives a
 * restart and is shared by every node.
 *
 * `sessionId` is `core.session.id` as a plain uuid with no foreign key, following
 * `audit.event.session_id`: the id is a surrogate, not the bearer secret (that is
 * `core.session.token_hash`), and sessions are *deleted* once dead, so a cascade would refund
 * view budgets on a timer. The migration argues both at length.
 */
export const shareLinkView = coreSchema.table(
  "share_link_view",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    linkId: uuid("link_id")
      .notNull()
      .references(() => shareLink.id, { onDelete: "cascade" }),
    membershipId: uuid("membership_id")
      .notNull()
      .references(() => membership.id, { onDelete: "cascade" }),
    /** `core.session.id`. Deliberately unreferenced — see above. */
    sessionId: uuid("session_id").notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The primary key *is* the dedup, and the only access path: three equalities, one probe.
    // Leading with linkId also gives the `share_link` cascade something to probe. No second
    // index — nothing lists these rows, and an index per cascading FK would tax the hot write
    // to speed up a delete each row sees at most once.
    primaryKey({ columns: [t.linkId, t.membershipId, t.sessionId] }),
  ],
);

export type ShareLink = typeof shareLink.$inferSelect;
export type NewShareLink = typeof shareLink.$inferInsert;
export type ShareLinkVisit = typeof shareLinkVisit.$inferSelect;
export type NewShareLinkVisit = typeof shareLinkVisit.$inferInsert;
export type ShareLinkView = typeof shareLinkView.$inferSelect;
export type NewShareLinkView = typeof shareLinkView.$inferInsert;
