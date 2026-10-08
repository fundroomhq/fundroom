import { randomBytes } from "node:crypto";
import type { AuditRecorder } from "@fundroom/audit";
import type { OfferingStatus, TenantContext, Tx } from "@fundroom/db";
import type { InviteGrant } from "@fundroom/domain";
import { describe, expect, it } from "vitest";
import { isShareLinkError, type ShareLinkErrorCode } from "../errors.js";
import {
  type LinkPolicy,
  normalizeLinkPolicy,
  PASSCODE_LOCK_MS,
  PASSCODE_MAX_ATTEMPTS,
  type ShareLinkStatus,
} from "../policy.js";
import { type CodeKeyRing, hashPasscode, mintToken, tokenHash } from "../token.js";
import { createShareLinkAccess, createShareLinkService } from "./links.js";
import {
  createMemoryViewSessionLedger,
  type LinkRecord,
  type LinkSummary,
  type LinkVisit,
  type ShareLinkStore,
  type ViewSessionLedger,
  type VisitClaim,
  type WriteLinkGrantsInput,
} from "./types.js";

/*
 * The service's hard parts, none of which needs a database to pin down:
 *
 *  - the counters. `max_uses` is the number an attacker wants to beat, and the only reason it
 *    holds is that the guard and the increment are one statement. The fake store below models
 *    that faithfully — a yield *before* the statement, none inside it — so a service that decided
 *    the cap from a row it had read earlier fails the concurrency test rather than passing it.
 *  - the refusal collapse. Paused, revoked, expired and exhausted must be one answer.
 *  - the passcode counter, which is spent before the comparison and reset by the lock.
 *  - the context guard (work package A's A4/A5): under an `external` context these reads return
 *    zero rows through RLS and raise nothing, so the service refuses that context up front.
 */

const WS = "01930000-0000-7000-8000-0000000000a1";
const LINK = "01930000-0000-7000-8000-0000000000c1";
const STAFF = "01930000-0000-7000-8000-0000000000b1";
const VISITOR = "01930000-0000-7000-8000-0000000000b2";
const VISITOR_2 = "01930000-0000-7000-8000-0000000000b3";
const SESSION = "01930000-0000-7000-8000-0000000000d1";
const FOLDER = "01930000-0000-7000-8000-0000000000e1";
const NOW = new Date("2026-09-14T12:00:00Z");

const staffCtx: TenantContext = { workspaceId: WS, actorKind: "staff", membershipId: STAFF };
const systemCtx: TenantContext = { workspaceId: WS, actorKind: "system" };
const externalCtx: TenantContext = {
  workspaceId: WS,
  actorKind: "external",
  membershipId: VISITOR,
};
const tx = {} as Tx;

const KEY = randomBytes(32);
const keyRing: CodeKeyRing = (() => {
  const entry = { id: "v1", key: KEY, fingerprint: "sha256:test" };
  return {
    current: entry,
    entries: [entry],
    get: (id: string) => (id === "v1" ? entry : undefined),
  };
})();

const GRANT: InviteGrant = {
  resource: { kind: "folder", id: FOLDER },
  capabilities: ["view"],
};

interface State {
  id: string;
  label: string;
  status: ShareLinkStatus;
  policy: LinkPolicy;
  grants: readonly InviteGrant[];
  groupIds: readonly string[];
  tokenHash: Uint8Array | null;
  passcodeHash: Uint8Array | null;
  passcodeAttempts: number;
  passcodeLockedUntil: Date | null;
  maxUses: number | null;
  uses: number;
  maxViews: number | null;
  views: number;
  expiresAt: Date | null;
  createdBy: string | null;
  revokedAt: Date | null;
}

function stateOf(over: Partial<State> = {}): State {
  return {
    id: LINK,
    label: "Series A room",
    status: "active",
    policy: normalizeLinkPolicy({}),
    grants: [GRANT],
    groupIds: [],
    tokenHash: null,
    passcodeHash: null,
    passcodeAttempts: 0,
    passcodeLockedUntil: null,
    maxUses: null,
    uses: 0,
    maxViews: null,
    views: 0,
    expiresAt: null,
    createdBy: STAFF,
    revokedAt: null,
    ...over,
  };
}

interface VisitState {
  id: string;
  membershipId: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  views: number;
  revokedAt: Date | null;
}

interface Harness {
  readonly state: State;
  readonly visits: Map<string, VisitState>;
  /** `core.share_link_view`: the (link, membership, session) triples already counted. */
  readonly viewSessions: Set<string>;
  readonly audited: string[];
  readonly auditMeta: Record<string, unknown>[];
  readonly store: ShareLinkStore;
  /** Every `writeLinkGrants` call, in order: the link's grants as rules on the link (§2). */
  readonly linkGrantWrites: WriteLinkGrantsInput[];
  aclBumps: number;
  aclCauses: string[];
  offering: OfferingStatus;
  /** Set true to model the bug the concurrency test exists to prevent. */
  capFromSnapshot: boolean;
}

/**
 * An in-memory `ShareLinkStore` with the semantics of the SQL it stands in for. The three
 * `claim*` methods `await` **before** deciding and then check-and-write with no `await` between,
 * which is what `UPDATE … WHERE uses < max_uses RETURNING` gives you: concurrent callers
 * interleave freely up to the statement and are serialised inside it.
 */
function harness(initial: Partial<State> = {}): Harness {
  const state = stateOf(initial);
  const visits = new Map<string, VisitState>();
  const viewSessions = new Set<string>();
  const audited: string[] = [];
  const auditMeta: Record<string, unknown>[] = [];
  const linkGrantWrites: WriteLinkGrantsInput[] = [];
  let visitSeq = 0;

  const h: Harness = {
    state,
    visits,
    viewSessions,
    audited,
    auditMeta,
    linkGrantWrites,
    aclBumps: 0,
    aclCauses: [],
    offering: "506c",
    capFromSnapshot: false,
    store: {
      async create(values) {
        state.label = values.label;
        state.tokenHash = values.tokenHash;
        state.policy = values.policy;
        state.grants = values.grants;
        state.groupIds = values.groupIds;
        state.passcodeHash = values.passcodeHash;
        state.maxUses = values.maxUses;
        state.maxViews = values.maxViews;
        state.expiresAt = values.expiresAt;
        state.createdBy = values.createdBy;
        return record(state);
      },
      async byId(id) {
        return id === state.id ? record(state) : undefined;
      },
      async byTokenHash(hash) {
        const stored = state.tokenHash;
        if (stored === null) return undefined;
        return Buffer.from(stored).equals(Buffer.from(hash)) ? record(state) : undefined;
      },
      async list() {
        const live = [...visits.values()].filter((v) => v.revokedAt === null).length;
        return [summary(state, live)];
      },
      async claimUse(id, now) {
        await Promise.resolve();
        if (id !== state.id || !liveNow(state, now)) return undefined;
        if (!h.capFromSnapshot && state.maxUses !== null && state.uses >= state.maxUses) {
          return undefined;
        }
        state.uses += 1;
        return state.uses;
      },
      async claimView(id, now) {
        await Promise.resolve();
        if (id !== state.id || !liveNow(state, now)) return undefined;
        if (state.maxViews !== null && state.views >= state.maxViews) return undefined;
        state.views += 1;
        return state.views;
      },
      async upsertVisit(input) {
        await Promise.resolve();
        const existing = visits.get(input.membershipId);
        if (existing !== undefined) {
          existing.lastSeenAt = input.now;
          return { visitId: existing.id, inserted: false, revokedAt: existing.revokedAt };
        }
        visitSeq += 1;
        const created: VisitState = {
          id: `01930000-0000-7000-8000-0000000000f${visitSeq}`,
          membershipId: input.membershipId,
          firstSeenAt: input.now,
          lastSeenAt: input.now,
          views: 0,
          revokedAt: null,
        };
        visits.set(input.membershipId, created);
        const claim: VisitClaim = { visitId: created.id, inserted: true, revokedAt: null };
        return claim;
      },
      async claimViewSession(input) {
        // `INSERT … ON CONFLICT DO NOTHING RETURNING`: the yield is *before* the statement, and
        // the membership test and the write have no `await` between them, so two callers with
        // the same triple interleave up to the statement and exactly one of them wins.
        await Promise.resolve();
        const key = `${input.linkId}:${input.membershipId}:${input.sessionId}`;
        if (viewSessions.has(key)) return false;
        viewSessions.add(key);
        return true;
      },
      async countVisitView(_linkId, membershipId, now) {
        const visit = visits.get(membershipId);
        if (visit === undefined || visit.revokedAt !== null) return false;
        visit.views += 1;
        visit.lastSeenAt = now;
        return true;
      },
      async setPasscodeHash(id, hash) {
        if (id !== state.id) return undefined;
        state.passcodeHash = hash;
        return record(state);
      },
      async recordPasscodeAttempt(id, now) {
        await Promise.resolve();
        if (id !== state.id || !liveNow(state, now)) return undefined;
        state.passcodeAttempts += 1;
        return state.passcodeAttempts;
      },
      async lockPasscode(_id, until) {
        state.passcodeLockedUntil = until;
        state.passcodeAttempts = 0;
      },
      async clearPasscodeAttempts() {
        state.passcodeAttempts = 0;
        state.passcodeLockedUntil = null;
      },
      async revoke(id, at, by) {
        if (id !== state.id || state.revokedAt !== null) return undefined;
        state.status = "revoked";
        state.revokedAt = at;
        state.createdBy = state.createdBy ?? by;
        return record(state);
      },
      async setPaused(id, paused) {
        const from: ShareLinkStatus = paused ? "active" : "paused";
        if (id !== state.id || state.status !== from || state.revokedAt !== null) return undefined;
        state.status = paused ? "paused" : "active";
        return record(state);
      },
      async revokeVisit(_linkId, membershipId, at) {
        const visit = visits.get(membershipId);
        if (visit === undefined || visit.revokedAt !== null) return false;
        visit.revokedAt = at;
        return true;
      },
      async visits() {
        return [...visits.values()]
          .filter((v) => v.revokedAt === null)
          .map(
            (v): LinkVisit => ({
              id: v.id,
              membershipId: v.membershipId,
              firstSeenAt: v.firstSeenAt,
              lastSeenAt: v.lastSeenAt,
              views: v.views,
              revokedAt: v.revokedAt,
            }),
          );
      },
      async writeLinkGrants(input) {
        // The real thing is `GrantRepo.upsert` against `core.access_grant` with
        // `subject_kind='link'`; what matters here is that it happened, once, with the link as
        // the subject — so the fake records the calls and the count.
        h.linkGrantWrites.push(input);
        return input.grants.reduce((n, g) => n + g.capabilities.length, 0);
      },
      async offeringStatus() {
        return h.offering;
      },
      async bumpAcl(cause: string) {
        h.aclBumps += 1;
        h.aclCauses.push(cause);
      },
    },
  };
  return h;
}

function liveNow(state: State, now: Date): boolean {
  if (state.status !== "active" || state.revokedAt !== null) return false;
  return state.expiresAt === null || state.expiresAt.getTime() > now.getTime();
}

function record(state: State): LinkRecord {
  return {
    id: state.id,
    workspaceId: WS,
    label: state.label,
    status: state.status,
    policy: state.policy,
    grants: state.grants,
    groupIds: state.groupIds,
    passcodeHash: state.passcodeHash,
    passcodeAttempts: state.passcodeAttempts,
    passcodeLockedUntil: state.passcodeLockedUntil,
    maxUses: state.maxUses,
    uses: state.uses,
    maxViews: state.maxViews,
    views: state.views,
    expiresAt: state.expiresAt,
    createdBy: state.createdBy,
    createdAt: NOW,
    revokedAt: state.revokedAt,
  };
}

function summary(state: State, visits: number): LinkSummary {
  const r = record(state);
  return {
    id: r.id,
    label: r.label,
    status: r.status,
    policy: r.policy,
    grants: r.grants,
    groupIds: r.groupIds,
    passcodeRequired: r.passcodeHash !== null,
    maxUses: r.maxUses,
    uses: r.uses,
    maxViews: r.maxViews,
    views: r.views,
    expiresAt: r.expiresAt,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
    revokedAt: r.revokedAt,
    visits,
  };
}

function serviceOn(
  h: Harness,
  options: {
    readonly now?: Date;
    readonly resourceKinds?: readonly string[];
    readonly viewSessions?: ViewSessionLedger;
  } = {},
) {
  const audit = {
    async record(_t: Tx, _c: TenantContext, input: { action: string; meta?: unknown }) {
      h.audited.push(input.action);
      h.auditMeta.push((input.meta ?? {}) as Record<string, unknown>);
      return undefined as never;
    },
  } as unknown as Pick<AuditRecorder, "record">;
  const kinds = options.resourceKinds;
  const ledger = options.viewSessions;
  return createShareLinkService({
    audit,
    keyRing,
    now: () => options.now ?? NOW,
    store: () => h.store,
    ...(kinds === undefined ? {} : { resourceKinds: () => kinds }),
    ...(ledger === undefined ? {} : { viewSessions: ledger }),
  });
}

async function codeOf(run: () => Promise<unknown>): Promise<ShareLinkErrorCode | "no-throw"> {
  try {
    await run();
    return "no-throw";
  } catch (e) {
    if (isShareLinkError(e)) return e.code;
    throw e;
  }
}

describe("mint", () => {
  it("returns the plaintext token once and stores only its digest", async () => {
    const h = harness();
    const minted = await serviceOn(h).mint(staffCtx, tx, { label: "Series A room" });
    expect(minted.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const stored = h.state.tokenHash;
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error("unreachable");
    expect(Buffer.from(stored).equals(tokenHash(minted.token))).toBe(true);
    expect(Buffer.from(stored).toString("utf8")).not.toContain(minted.token);
  });

  it("writes the link's grants ONCE, against the LINK, never against a visitor (contract §2)", async () => {
    /*
     * The whole revocation model is this line. §2: "The link remains the grant subject. Grants
     * are written once against `subject_kind='link', subject_id=<link id>` — never copied per
     * visitor… Revoking the link stops emitting the subject, so one write revokes everyone it
     * admitted." Write them per visitor instead and pause, expiry, unbinding and revoke all
     * become writes that change no access, because the copy outlives the link.
     */
    const h = harness();
    const s = serviceOn(h);
    await s.mint(staffCtx, tx, {
      label: "Series A room",
      grants: [{ resource: { kind: "folder", id: FOLDER }, capabilities: ["view", "download"] }],
      actor: { membershipId: STAFF },
    });
    expect(h.linkGrantWrites).toHaveLength(1);
    const write = h.linkGrantWrites[0];
    expect(write?.linkId).toBe(LINK);
    expect(write?.note).toBe(`link:${LINK}`);
    expect(write?.createdBy).toBe(STAFF);
    expect(write?.grants).toEqual([
      { resource: { kind: "folder", id: FOLDER }, capabilities: ["view", "download"] },
    ]);
    // Two capabilities, two rules, and the audit row says so.
    expect(h.auditMeta.at(-1)?.["grantRules"]).toBe(2);
  });

  it("redeeming does not write a second set of grants: the link keeps being the subject", async () => {
    const h = harness();
    const s = serviceOn(h);
    await s.mint(staffCtx, tx, { label: "L", grants: [GRANT] });
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR_2 });
    expect(h.linkGrantWrites).toHaveLength(1);
  });

  it("normalises the policy on the way in, so the stored form is the compared form", async () => {
    const h = harness();
    await serviceOn(h).mint(staffCtx, tx, {
      label: "Series A room",
      policy: { domains: ["@ACME.com", "acme.com."], emails: ["Jane@Acme.com"] },
    });
    expect(h.state.policy.domains).toEqual(["acme.com"]);
    expect(h.state.policy.emails).toEqual(["jane@acme.com"]);
  });

  it("writes the passcode as a keyed HMAC after the row exists, never as plaintext", async () => {
    const h = harness();
    const minted = await serviceOn(h).mint(staffCtx, tx, {
      label: "Series A room",
      passcode: "swordfish",
    });
    const stored = h.state.passcodeHash;
    if (stored === null) throw new Error("no passcode stored");
    expect(Buffer.from(stored).equals(hashPasscode(keyRing, "swordfish", LINK))).toBe(true);
    expect(minted.link.passcodeRequired).toBe(true);
    // The summary a route serialises must not carry the digest at all.
    expect(Object.keys(minted.link)).not.toContain("passcodeHash");
  });

  it("refuses an empty or over-long label, which the row's CHECK would refuse anyway", async () => {
    const h = harness();
    const s = serviceOn(h);
    expect(await codeOf(() => s.mint(staffCtx, tx, { label: "  " }))).toBe("validation_failed");
    expect(await codeOf(() => s.mint(staffCtx, tx, { label: "x".repeat(201) }))).toBe(
      "validation_failed",
    );
  });

  it("refuses a cap that is not a positive whole number", async () => {
    const h = harness();
    const s = serviceOn(h);
    expect(await codeOf(() => s.mint(staffCtx, tx, { label: "L", maxUses: 0 }))).toBe(
      "validation_failed",
    );
    expect(await codeOf(() => s.mint(staffCtx, tx, { label: "L", maxViews: -1 }))).toBe(
      "validation_failed",
    );
    expect(await codeOf(() => s.mint(staffCtx, tx, { label: "L", maxUses: 1.5 }))).toBe(
      "validation_failed",
    );
  });

  it("refuses an expiry that is already past, rather than minting a dead link", async () => {
    const h = harness();
    expect(
      await codeOf(() =>
        serviceOn(h).mint(staffCtx, tx, { label: "L", expiresAt: new Date(NOW.getTime() - 1) }),
      ),
    ).toBe("validation_failed");
  });

  it("refuses a passcode too short to survive the lockout budget", async () => {
    const h = harness();
    expect(
      await codeOf(() => serviceOn(h).mint(staffCtx, tx, { label: "L", passcode: "abc" })),
    ).toBe("validation_failed");
  });

  it("refuses a grant naming a resource kind no module registered (S3)", async () => {
    const h = harness();
    const s = serviceOn(h, { resourceKinds: ["folder", "document"] });
    expect(
      await codeOf(() =>
        s.mint(staffCtx, tx, {
          label: "L",
          grants: [{ resource: { kind: "content", id: FOLDER }, capabilities: ["view"] }],
        }),
      ),
    ).toBe("unsupported");
    await expect(s.mint(staffCtx, tx, { label: "L", grants: [GRANT] })).resolves.toBeDefined();
  });

  it("refuses every link under `none` and `informational` (D6)", async () => {
    for (const status of ["none", "informational"] as const) {
      const h = harness();
      h.offering = status;
      expect(
        await codeOf(() =>
          serviceOn(h).mint(staffCtx, tx, { label: "L", policy: { domains: ["acme.com"] } }),
        ),
      ).toBe("links_not_permitted");
    }
  });

  it("refuses an unrestricted 506(b) link and permits an allowlisted one (D6)", async () => {
    const open = harness();
    open.offering = "506b";
    expect(await codeOf(() => serviceOn(open).mint(staffCtx, tx, { label: "L" }))).toBe(
      "audience_too_open",
    );
    const named = harness();
    named.offering = "506b";
    await expect(
      serviceOn(named).mint(staffCtx, tx, { label: "L", policy: { emails: ["jane@acme.com"] } }),
    ).resolves.toBeDefined();
  });

  it("treats a workspace it cannot read as the most restrictive status, not the most open", async () => {
    const h = harness();
    const store: ShareLinkStore = { ...h.store, offeringStatus: async () => undefined };
    const s = serviceOn({ ...h, store });
    expect(await codeOf(() => s.mint(staffCtx, tx, { label: "L" }))).toBe("links_not_permitted");
  });

  it("audits the creation with counts and flags, never with the addresses themselves", async () => {
    const h = harness();
    await serviceOn(h).mint(staffCtx, tx, {
      label: "Series A room",
      policy: { domains: ["acme.com"], emails: ["jane@acme.com"] },
      actor: { membershipId: STAFF },
    });
    expect(h.audited).toEqual(["share_link.created"]);
    const meta = h.auditMeta[0] ?? {};
    expect(meta["domains"]).toBe(1);
    expect(meta["emails"]).toBe(1);
    expect(JSON.stringify(meta)).not.toContain("jane@acme.com");
    expect(JSON.stringify(meta)).not.toContain("acme.com");
  });
});

describe("resolve", () => {
  it("returns the admission snapshot for a live link", async () => {
    const h = harness();
    const s = serviceOn(h);
    const minted = await s.mint(staffCtx, tx, { label: "L" });
    const resolved = await s.resolve(systemCtx, tx, minted.token);
    expect(resolved?.id).toBe(LINK);
  });

  it("never consumes: resolving twice changes no counter", async () => {
    const h = harness({ maxUses: 1 });
    const s = serviceOn(h);
    const minted = await s.mint(staffCtx, tx, { label: "L", maxUses: 1 });
    await s.resolve(systemCtx, tx, minted.token);
    await s.resolve(systemCtx, tx, minted.token);
    expect(h.state.uses).toBe(0);
    expect(h.state.views).toBe(0);
  });

  it("refuses an implausible token without hashing it or reading the store", async () => {
    let reads = 0;
    const h = harness();
    const store: ShareLinkStore = {
      ...h.store,
      byTokenHash: async (hash) => {
        reads += 1;
        return h.store.byTokenHash(hash);
      },
    };
    const s = serviceOn({ ...h, store });
    for (const junk of ["", "short", "a".repeat(42), `${"a".repeat(42)}+`]) {
      expect(await s.resolve(systemCtx, tx, junk)).toBeUndefined();
    }
    expect(reads).toBe(0);
  });

  it("answers undefined for an unknown token of the right shape", async () => {
    const h = harness();
    const s = serviceOn(h);
    await s.mint(staffCtx, tx, { label: "L" });
    expect(await s.resolve(systemCtx, tx, mintToken())).toBeUndefined();
  });

  it("collapses paused, revoked and expired into the same undefined", async () => {
    const cases: readonly Partial<State>[] = [
      { status: "paused" },
      { status: "revoked", revokedAt: NOW },
      { expiresAt: NOW },
    ];
    for (const over of cases) {
      const h = harness();
      const s = serviceOn(h);
      const minted = await s.mint(staffCtx, tx, { label: "L" });
      Object.assign(h.state, over);
      expect(await s.resolve(systemCtx, tx, minted.token)).toBeUndefined();
    }
  });

  /*
   * The half of the collapse that was WRONG, and the bug it caused.
   *
   * `resolve` is the only token -> link mapping the public routes have, so applying `isLive`
   * here — `isOpen` **plus** the use and view caps — 404'd `GET /links/{token}` and
   * `POST /links/{token}/start` the moment the link filled up, *before* `redeem` (which uses
   * `isOpen`, work package B's B4) could run. A visitor the link had already admitted could
   * not sign in again from a new device or after their session expired, while `PrincipalRepo`
   * went on emitting the link's subject for them (A6): the link had stopped letting its own
   * people back in while still granting them everything.
   *
   * A cap limits how many people may come in, not how long the ones who did may stay. The two
   * spent-cap cases therefore resolve, and the caps are asked — separately, and one step later —
   * by `admits`, which is the "may somebody NEW come in?" question.
   */
  it("still resolves a link whose caps are spent, because its own people must come back", async () => {
    for (const over of [
      { maxUses: 1, uses: 1 },
      { maxViews: 1, views: 1 },
    ] as const) {
      const h = harness();
      const s = serviceOn(h);
      const minted = await s.mint(staffCtx, tx, { label: "L" });
      Object.assign(h.state, over);
      const resolved = await s.resolve(systemCtx, tx, minted.token);
      expect(resolved?.id).toBe(LINK);
      // And the cap still refuses a new visitor, asked of the same resolved snapshot.
      expect(s.admits(resolved as NonNullable<typeof resolved>, "jane@acme.com")).toBe("not_found");
    }
  });

  it("stops resolving the moment the link is revoked, exactly as PrincipalRepo stops granting", async () => {
    const h = harness({ maxUses: 1 });
    const s = serviceOn(h);
    const minted = await s.mint(staffCtx, tx, { label: "L", maxUses: 1 });
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    expect(await s.resolve(systemCtx, tx, minted.token)).toBeDefined();
    await s.revoke(staffCtx, tx, { linkId: LINK });
    expect(await s.resolve(systemCtx, tx, minted.token)).toBeUndefined();
  });
});

describe("checkPasscode", () => {
  async function withPasscode(over: Partial<State> = {}) {
    const h = harness(over);
    const s = serviceOn(h);
    await s.mint(staffCtx, tx, { label: "L", passcode: "swordfish" });
    return { h, s };
  }

  it("is satisfied when the link carries no passcode", async () => {
    const h = harness();
    const s = serviceOn(h);
    await s.mint(staffCtx, tx, { label: "L" });
    expect(await s.checkPasscode(systemCtx, tx, LINK, "")).toBeUndefined();
    expect(h.state.passcodeAttempts).toBe(0);
  });

  it("accepts the right passcode and clears the counter, so typos do not accumulate", async () => {
    const { h, s } = await withPasscode();
    await s.checkPasscode(systemCtx, tx, LINK, "wrong-one");
    expect(h.state.passcodeAttempts).toBe(1);
    expect(await s.checkPasscode(systemCtx, tx, LINK, "swordfish")).toBeUndefined();
    expect(h.state.passcodeAttempts).toBe(0);
  });

  it("counts a wrong guess against the link row, not against a client IP (D7)", async () => {
    const { h, s } = await withPasscode();
    expect(await s.checkPasscode(systemCtx, tx, LINK, "nope")).toBe("passcode_wrong");
    expect(h.state.passcodeAttempts).toBe(1);
  });

  it("asks for the passcode when nothing was typed, without spending an attempt", async () => {
    const { h, s } = await withPasscode();
    expect(await s.checkPasscode(systemCtx, tx, LINK, "")).toBe("passcode_required");
    expect(h.state.passcodeAttempts).toBe(0);
  });

  it("locks on the attempt that spends the last one, and resets the counter with the lock", async () => {
    const { h, s } = await withPasscode();
    const answers: (string | undefined)[] = [];
    for (let i = 0; i < PASSCODE_MAX_ATTEMPTS; i++) {
      answers.push(await s.checkPasscode(systemCtx, tx, LINK, "nope"));
    }
    expect(answers.slice(0, -1).every((a) => a === "passcode_wrong")).toBe(true);
    expect(answers.at(-1)).toBe("passcode_locked");
    expect(h.state.passcodeLockedUntil?.getTime()).toBe(NOW.getTime() + PASSCODE_LOCK_MS);
    // The lock is the punishment; a counter left at the ceiling would re-lock instantly forever.
    expect(h.state.passcodeAttempts).toBe(0);
  });

  it("answers locked without spending an attempt while the lock stands", async () => {
    const { h, s } = await withPasscode({
      passcodeLockedUntil: new Date(NOW.getTime() + 60_000),
    });
    expect(await s.checkPasscode(systemCtx, tx, LINK, "swordfish")).toBe("passcode_locked");
    expect(h.state.passcodeAttempts).toBe(0);
  });

  it("accepts the right passcode again once the lock has expired", async () => {
    const { h, s } = await withPasscode({ passcodeLockedUntil: NOW });
    expect(await s.checkPasscode(systemCtx, tx, LINK, "swordfish")).toBeUndefined();
    expect(h.state.passcodeLockedUntil).toBeNull();
  });

  it("answers not_found for a link that is not open, giving nothing about the passcode away", async () => {
    for (const over of [
      { status: "paused" as const },
      { status: "revoked" as const, revokedAt: NOW },
      { expiresAt: NOW },
    ]) {
      const { h, s } = await withPasscode();
      Object.assign(h.state, over);
      expect(await s.checkPasscode(systemCtx, tx, LINK, "swordfish")).toBe("not_found");
    }
  });

  /*
   * `checkPasscode` runs *after* `resolve`, on a link the caller already holds, so it has to
   * agree with `resolve` about what "still there" means. With `isLive` here, a returning visitor
   * on a spent link got past `resolve` and was then refused by the passcode check — the same
   * lock-out one step further in, and a link whose passcode had become unanswerable.
   */
  it("still answers for a link whose caps are spent, because resolve let the visitor this far", async () => {
    const { h, s } = await withPasscode();
    // After `mint`, because `store.create` writes the caps the mint asked for over the harness's.
    Object.assign(h.state, { maxUses: 1, uses: 1 });
    expect(await s.checkPasscode(systemCtx, tx, LINK, "swordfish")).toBeUndefined();
    expect(await s.checkPasscode(systemCtx, tx, LINK, "nope")).toBe("passcode_wrong");
    expect(h.state.passcodeAttempts).toBe(1);
  });

  it("answers not_found for an unknown link id", async () => {
    const { s } = await withPasscode();
    expect(await s.checkPasscode(systemCtx, tx, VISITOR, "swordfish")).toBe("not_found");
  });

  it("audits each refusal so the admin screen sees what the wire refuses to say", async () => {
    const { h, s } = await withPasscode();
    await s.checkPasscode(systemCtx, tx, LINK, "nope");
    expect(h.audited.at(-1)).toBe("share_link.admission_refused");
    expect(h.auditMeta.at(-1)?.["reason"]).toBe("passcode_wrong");
  });
});

describe("admits", () => {
  it("is the same pure rule the async half asks", async () => {
    const h = harness();
    const s = serviceOn(h);
    await s.mint(staffCtx, tx, { label: "L", policy: { domains: ["acme.com"] } });
    const resolved = await s.resolve(systemCtx, tx, "x".repeat(43));
    expect(resolved).toBeUndefined();
    expect(await s.admitsEmail(systemCtx, tx, LINK, "jane@acme.com")).toBe(true);
    expect(await s.admitsEmail(systemCtx, tx, LINK, "mallory@evil-acme.com")).toBe(false);
  });

  it("answers false for an unknown link, the same collapse the wire makes", async () => {
    const h = harness();
    expect(await serviceOn(h).admitsEmail(systemCtx, tx, VISITOR, "jane@acme.com")).toBe(false);
  });

  it("answers false for a link that is no longer live, so eligibility cannot outlive it", async () => {
    const h = harness({ status: "revoked", revokedAt: NOW });
    expect(await serviceOn(h).admitsEmail(systemCtx, tx, LINK, "jane@acme.com")).toBe(false);
  });
});

describe("redeem", () => {
  it("binds the membership, spends one use and hands back the groups and grants", async () => {
    const h = harness({ groupIds: [STAFF], maxUses: 5 });
    const result = await serviceOn(h).redeem(systemCtx, tx, {
      linkId: LINK,
      membershipId: VISITOR,
    });
    expect(result.firstRedemption).toBe(true);
    expect(result.grants).toEqual([GRANT]);
    expect(result.groupIds).toEqual([STAFF]);
    expect(h.state.uses).toBe(1);
    expect(h.audited).toEqual(["share_link.redeemed"]);
  });

  it("does not spend a second seat when the same membership comes back on another device", async () => {
    const h = harness({ maxUses: 1 });
    const s = serviceOn(h);
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    const again = await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    expect(again.firstRedemption).toBe(false);
    expect(h.state.uses).toBe(1);
  });

  it("lets a bound visitor back in after the link filled up, because they spend no seat (A6)", async () => {
    const h = harness({ maxUses: 1 });
    const s = serviceOn(h);
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    expect(h.state.uses).toBe(1);
    const again = await s.redeem(systemCtx, tx, {
      linkId: LINK,
      membershipId: VISITOR,
      email: "jane@acme.com",
    });
    expect(again.firstRedemption).toBe(false);
    expect(h.state.uses).toBe(1);
  });

  it("still refuses a NEW membership once the link is full, decided by the claim alone", async () => {
    const h = harness({ maxUses: 1 });
    const s = serviceOn(h);
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    expect(
      await codeOf(() => s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR_2 })),
    ).toBe("not_found");
    expect(h.state.uses).toBe(1);
  });

  it("carries the link's forced watermark through to the caller", async () => {
    const h = harness({ policy: normalizeLinkPolicy({ forceWatermark: true }) });
    const result = await serviceOn(h).redeem(systemCtx, tx, {
      linkId: LINK,
      membershipId: VISITOR,
    });
    expect(result.forceWatermark).toBe(true);
  });

  it("refuses an address the policy does not admit, and says which refusal it was", async () => {
    const h = harness({ policy: normalizeLinkPolicy({ domains: ["acme.com"] }) });
    const s = serviceOn(h);
    await expect(
      s.redeem(systemCtx, tx, {
        linkId: LINK,
        membershipId: VISITOR,
        email: "mallory@evil-acme.com",
      }),
    ).rejects.toMatchObject({ code: "forbidden", details: { reason: "email_not_allowed" } });
    expect(h.state.uses).toBe(0);
  });

  it("re-checks the policy at redemption, because the allowlist may have narrowed since OTP start", async () => {
    const h = harness();
    const s = serviceOn(h);
    h.state.policy = normalizeLinkPolicy({ domains: ["acme.com"] });
    await expect(
      s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR, email: "bob@other.test" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("answers not_found for every liveness refusal, never naming which one", async () => {
    for (const over of [
      { status: "paused" as const },
      { status: "revoked" as const, revokedAt: NOW },
      { expiresAt: NOW },
    ]) {
      const h = harness(over);
      expect(
        await codeOf(() =>
          serviceOn(h).redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR }),
        ),
      ).toBe("not_found");
    }
  });

  it("refuses a visitor whose binding an admin revoked, rather than resurrecting it", async () => {
    const h = harness();
    const s = serviceOn(h);
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    const visit = h.visits.get(VISITOR);
    if (visit === undefined) throw new Error("no visit");
    visit.revokedAt = NOW;
    expect(
      await codeOf(() => s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR })),
    ).toBe("not_found");
    expect(visit.revokedAt).not.toBeNull();
  });

  /*
   * The race. Five distinct memberships redeem a link capped at two, all of them having read
   * `uses = 0`. Only the conditional UPDATE can settle it, and `capFromSnapshot` turns that guard
   * off to prove the test is load-bearing: with it on, all five get in.
   */
  it("holds max_uses under concurrent redemption: exactly the cap is admitted", async () => {
    const h = harness({ maxUses: 2 });
    const s = serviceOn(h);
    const members = [VISITOR, VISITOR_2, STAFF, FOLDER, SESSION];
    const results = await Promise.allSettled(
      members.map((membershipId) => s.redeem(systemCtx, tx, { linkId: LINK, membershipId })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(3);
    expect(h.state.uses).toBe(2);
  });

  it("would over-admit if the cap were decided from the row the caller had already read", async () => {
    const h = harness({ maxUses: 2 });
    h.capFromSnapshot = true;
    const s = serviceOn(h);
    const members = [VISITOR, VISITOR_2, STAFF, FOLDER, SESSION];
    const results = await Promise.allSettled(
      members.map((membershipId) => s.redeem(systemCtx, tx, { linkId: LINK, membershipId })),
    );
    // Proof the assertion above is about the claim and not about the snapshot check: with the
    // conditional UPDATE's guard removed, every one of the five gets in.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(h.state.uses).toBe(5);
  });
});

describe("noteView", () => {
  it("counts one view per session, however many requests that session makes", async () => {
    const h = harness({ maxViews: 5 });
    const s = serviceOn(h);
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    for (let i = 0; i < 4; i++) await s.noteView(systemCtx, tx, LINK, VISITOR, SESSION);
    expect(h.state.views).toBe(1);
    expect(h.visits.get(VISITOR)?.views).toBe(1);
  });

  it("counts a second session separately", async () => {
    const h = harness({ maxViews: 5 });
    const s = serviceOn(h);
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    await s.noteView(systemCtx, tx, LINK, VISITOR, SESSION);
    await s.noteView(systemCtx, tx, LINK, VISITOR, STAFF);
    expect(h.state.views).toBe(2);
  });

  it("counts nothing for a membership with no live binding", async () => {
    const h = harness({ maxViews: 5 });
    await serviceOn(h).noteView(systemCtx, tx, LINK, VISITOR, SESSION);
    expect(h.state.views).toBe(0);
  });

  it("stops at max_views; the link still resolves but admits nobody new", async () => {
    const h = harness({ maxViews: 1 });
    const s = serviceOn(h);
    const minted = await s.mint(staffCtx, tx, { label: "L", maxViews: 1 });
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    await s.noteView(systemCtx, tx, LINK, VISITOR, SESSION);
    await s.noteView(systemCtx, tx, LINK, VISITOR, STAFF);
    expect(h.state.views).toBe(1);
    // The budget is spent, so no *new* visitor is eligible ...
    expect(await s.admitsEmail(systemCtx, tx, LINK, "jane@acme.com")).toBe(false);
    // ... and the visitor who burned it can still open the link and come back in.
    expect((await s.resolve(systemCtx, tx, minted.token))?.id).toBe(LINK);
    expect(
      (await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR })).firstRedemption,
    ).toBe(false);
  });

  /*
   * The dedup is the database's, not the process's (contract §10 note B5's durable fix). Two
   * assertions carry that, and they are the reason `core.share_link_view` exists:
   *
   *  - the claim goes to the *store*, so it is a row and not a `Set` on a heap that dies with
   *    the process;
   *  - a **second service instance over the same store** — a restarted node, or the other node
   *    behind the load balancer — does not re-count a session the first one already counted.
   *    Against the per-process ledger that second instance starts empty and counts it again,
   *    which is exactly the bug; `links.integration.test.ts` runs the same shape against real
   *    Postgres.
   */
  it("claims the session in the store, not in the process", async () => {
    const h = harness({ maxViews: 5 });
    const s = serviceOn(h);
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    await s.noteView(systemCtx, tx, LINK, VISITOR, SESSION);
    expect([...h.viewSessions]).toEqual([`${LINK}:${VISITOR}:${SESSION}`]);
  });

  it("does not re-count a session for a fresh service instance over the same store", async () => {
    const h = harness({ maxViews: 2 });
    await serviceOn(h).redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    await serviceOn(h).noteView(systemCtx, tx, LINK, VISITOR, SESSION);
    // Everything in-process is gone; the store is not.
    await serviceOn(h).noteView(systemCtx, tx, LINK, VISITOR, SESSION);
    expect(h.state.views).toBe(1);
    expect(h.visits.get(VISITOR)?.views).toBe(1);

    // And the per-process ledger, injected deliberately, is how we know the claim above is
    // load-bearing rather than incidental: a fresh instance with a fresh set counts twice.
    const h2 = harness({ maxViews: 2 });
    await serviceOn(h2).redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    for (const _ of [0, 1]) {
      await serviceOn(h2, { viewSessions: createMemoryViewSessionLedger() }).noteView(
        systemCtx,
        tx,
        LINK,
        VISITOR,
        SESSION,
      );
    }
    expect(h2.state.views).toBe(2);
  });

  it("refuses a session id that is not a uuid, before it can abort the caller's transaction", async () => {
    const h = harness({ maxViews: 5 });
    const s = serviceOn(h);
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    expect(await codeOf(() => s.noteView(systemCtx, tx, LINK, VISITOR, "not-a-uuid"))).toBe(
      "validation_failed",
    );
    expect(h.state.views).toBe(0);
    expect(h.viewSessions.size).toBe(0);
  });

  it("uses the injected ledger, so the database default can be swapped out", async () => {
    const claimed: string[] = [];
    const ledger: ViewSessionLedger = {
      async claim(_store, key) {
        claimed.push(`${key.linkId}:${key.membershipId}:${key.sessionId}`);
        return false;
      },
    };
    const h = harness();
    const s = serviceOn(h, { viewSessions: ledger });
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    await s.noteView(systemCtx, tx, LINK, VISITOR, SESSION);
    expect(claimed).toEqual([`${LINK}:${VISITOR}:${SESSION}`]);
    expect(h.state.views).toBe(0);
  });
});

describe("revoke and pause", () => {
  it("revokes once, bumps acl_version and audits, and is idempotent afterwards", async () => {
    const h = harness();
    const s = serviceOn(h);
    await s.revoke(staffCtx, tx, { linkId: LINK, actor: { membershipId: STAFF } });
    expect(h.state.status).toBe("revoked");
    expect(h.state.revokedAt).toEqual(NOW);
    expect(h.aclBumps).toBe(1);
    expect(h.audited).toEqual(["share_link.revoked"]);
    await s.revoke(staffCtx, tx, { linkId: LINK });
    expect(h.aclBumps).toBe(1);
    expect(h.audited).toEqual(["share_link.revoked"]);
  });

  it("leaves the bindings alone unless the admin asks, because that is a separate decision", async () => {
    const h = harness();
    const s = serviceOn(h);
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    await s.revoke(staffCtx, tx, { linkId: LINK });
    expect(h.visits.get(VISITOR)?.revokedAt).toBeNull();
  });

  it("revokes every live binding when the admin does ask, and counts them in the audit row", async () => {
    const h = harness();
    const s = serviceOn(h);
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    await s.redeem(systemCtx, tx, { linkId: LINK, membershipId: VISITOR_2 });
    await s.revoke(staffCtx, tx, { linkId: LINK, revokeVisitors: true });
    expect(h.visits.get(VISITOR)?.revokedAt).toEqual(NOW);
    expect(h.visits.get(VISITOR_2)?.revokedAt).toEqual(NOW);
    expect(h.auditMeta.at(-1)?.["visitorsRevoked"]).toBe(2);
  });

  it("refuses to revoke a link that does not exist", async () => {
    const h = harness();
    expect(await codeOf(() => serviceOn(h).revoke(staffCtx, tx, { linkId: VISITOR }))).toBe(
      "not_found",
    );
  });

  it("pauses and resumes, bumping acl_version each way because a pause suspends access (A6)", async () => {
    const h = harness();
    const s = serviceOn(h);
    await s.setPaused(staffCtx, tx, LINK, true);
    expect(h.state.status).toBe("paused");
    expect(h.aclBumps).toBe(1);
    await s.setPaused(staffCtx, tx, LINK, false);
    expect(h.state.status).toBe("active");
    expect(h.aclBumps).toBe(2);
    expect(h.audited).toEqual(["share_link.paused", "share_link.resumed"]);
    expect(h.aclCauses).toEqual(["share_link.paused", "share_link.resumed"]);
  });

  it("answers conflict, not not_found, when the link is already in the state asked for", async () => {
    const h = harness({ status: "paused" });
    expect(await codeOf(() => serviceOn(h).setPaused(staffCtx, tx, LINK, true))).toBe("conflict");
  });
});

describe("the external-context guard (A4 / A5)", () => {
  /*
   * `core.share_link` has no permissive policy for `external`, so under a visitor's own context
   * every read returns zero rows and raises nothing — indistinguishable from "no such link". The
   * service refuses that context loudly instead.
   */
  it("refuses every method called as external, rather than silently seeing nothing", async () => {
    const h = harness();
    const s = serviceOn(h);
    const calls: readonly (() => Promise<unknown>)[] = [
      () => s.mint(externalCtx, tx, { label: "L" }),
      () => s.resolve(externalCtx, tx, mintToken()),
      () => s.checkPasscode(externalCtx, tx, LINK, "x"),
      () => s.admitsEmail(externalCtx, tx, LINK, "jane@acme.com"),
      () => s.redeem(externalCtx, tx, { linkId: LINK, membershipId: VISITOR }),
      () => s.noteView(externalCtx, tx, LINK, VISITOR, SESSION),
      () => s.revoke(externalCtx, tx, { linkId: LINK }),
      () => s.setPaused(externalCtx, tx, LINK, true),
      () => s.list(externalCtx, tx),
      () => s.visits(externalCtx, tx, LINK),
      () => s.bind(externalCtx, tx, { linkId: LINK, membershipId: VISITOR }),
    ];
    for (const call of calls) {
      expect(await codeOf(call)).toBe("forbidden");
    }
  });

  it("permits both privileged contexts, because the public routes run as system", async () => {
    const h = harness();
    const s = serviceOn(h);
    await expect(s.list(systemCtx, tx)).resolves.toHaveLength(1);
    await expect(s.list(staffCtx, tx)).resolves.toHaveLength(1);
  });
});

describe("createShareLinkAccess", () => {
  it("exposes exactly the two methods identity declares, wired to the service", async () => {
    const h = harness({ policy: normalizeLinkPolicy({ domains: ["acme.com"] }) });
    const s = serviceOn(h);
    const access = createShareLinkAccess(s);
    expect(await access.admits(systemCtx, tx, LINK, "jane@acme.com")).toBe(true);
    expect(await access.admits(systemCtx, tx, LINK, "mallory@evil.test")).toBe(false);
    const bound = await access.bind(systemCtx, tx, { linkId: LINK, membershipId: VISITOR });
    expect(bound.grants).toEqual([GRANT]);
    expect(h.state.uses).toBe(1);
  });
});
