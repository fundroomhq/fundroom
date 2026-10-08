import { ApiError, createApi, type OpenAPIHono } from "@fundroom/contracts";
import type { Database, TenantContext } from "@fundroom/db";
import { systemContext } from "@fundroom/db";
import type { AuthService, LoginResult } from "@fundroom/identity";
import { buildBootstrap, createModuleRegistry, isDisabledForOffering } from "@fundroom/module-kit";
import type {
  AdmissionRefusal,
  LinkRecord,
  ResolvedLink,
  ShareLinkAccess,
  ShareLinkDeps,
  ShareLinkService,
  ShareLinkStore,
} from "@fundroom/share-links";
import { createShareLinkAccess, createShareLinkService, tokenHash } from "@fundroom/share-links";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "../env.js";
import { apiErrorHandler } from "../middleware/errors.js";
import { SHARE_LINKS_DISABLED_WHEN, shareLinksModule } from "../modules.js";
import type { ApiDeps } from "./deps.js";
import {
  admissionError,
  emailHintOf,
  passcodeRefusal,
  registerLinkRoutes,
  shareLinkUrl,
} from "./links.js";

const CTX: TenantContext = systemContext("0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a");

function linkWith(policy: Partial<ResolvedLink["policy"]> = {}): ResolvedLink {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-000000000001",
    workspaceId: CTX.workspaceId,
    status: "active",
    policy: { domains: [], emails: [], forceWatermark: false, ...policy },
    passcodeRequired: false,
    passcodeAttempts: 0,
    passcodeLockedUntil: null,
    maxUses: null,
    uses: 0,
    maxViews: null,
    views: 0,
    expiresAt: null,
    revokedAt: null,
  };
}

/*
 * The one ordering in `routes/links.ts` that is a security property rather than a style (contract
 * B7): `checkPasscode` counts the attempt on `core.share_link` **inside the transaction it is
 * handed**, so the refusal has to leave that transaction alive and be turned into a response
 * afterwards. A handler that threw from inside the callback would roll the counter back with it
 * and hand a guesser unlimited tries.
 *
 * The fake below models exactly that and nothing else: a transaction that commits when its
 * callback resolves and rolls back when it throws, and a service that spends an attempt before
 * answering. Reverting `passcodeRefusal` to `throw` inside the callback makes the first assertion
 * read `attempts: 0` — which is the bug, stated as a number.
 */
function fakeTransactor(): {
  readonly db: Pick<Database, "withTenant">;
  readonly committed: () => number;
  readonly rolledBack: () => number;
} {
  let committed = 0;
  let rolledBack = 0;
  return {
    db: {
      withTenant: (async (_ctx: TenantContext, fn: (tx: unknown) => Promise<unknown>) => {
        try {
          const value = await fn({});
          committed += 1;
          return value;
        } catch (error) {
          rolledBack += 1;
          throw error;
        }
      }) as Pick<Database, "withTenant">["withTenant"],
    },
    committed: () => committed,
    rolledBack: () => rolledBack,
  };
}

/** A passcode checker that spends an attempt before deciding, as the real one does. */
function fakeChecker(verdict: AdmissionRefusal | undefined): {
  readonly service: Pick<ShareLinkService, "checkPasscode">;
  /** Attempts that SURVIVED — i.e. were part of a committed transaction. */
  readonly persisted: () => number;
  readonly settle: (committed: boolean) => void;
} {
  let pending = 0;
  let persisted = 0;
  return {
    service: {
      checkPasscode: async () => {
        pending += 1;
        return verdict;
      },
    },
    persisted: () => persisted,
    settle: (committed) => {
      if (committed) persisted += pending;
      pending = 0;
    },
  };
}

describe("passcodeRefusal (contract B7)", () => {
  it("commits the counted attempt and returns the refusal for the caller to map", async () => {
    const t = fakeTransactor();
    const checker = fakeChecker("passcode_wrong");
    const refusal = await passcodeRefusal(t.db, CTX, checker.service, "link", "hunter2");
    checker.settle(t.committed() === 1);

    expect(refusal).toBe("passcode_wrong");
    // The transaction closed *successfully*, which is the whole point: the attempt is on the row.
    expect(t.committed()).toBe(1);
    expect(t.rolledBack()).toBe(0);
    expect(checker.persisted()).toBe(1);
  });

  it("a wrong passcode costs an attempt every time, so five tries reach the lockout", async () => {
    const t = fakeTransactor();
    const checker = fakeChecker("passcode_wrong");
    for (let i = 0; i < 5; i += 1) {
      await passcodeRefusal(t.db, CTX, checker.service, "link", `guess-${i}`);
      checker.settle(true);
    }
    // If the refusal were thrown before the commit, this would be 0 and PASSCODE_MAX_ATTEMPTS
    // would never be reached however long the guessing went on.
    expect(checker.persisted()).toBe(5);
  });

  it("a genuine failure still rolls back, so the seam has not simply swallowed errors", async () => {
    const t = fakeTransactor();
    const boom: Pick<ShareLinkService, "checkPasscode"> = {
      checkPasscode: async () => {
        throw new Error("connection lost");
      },
    };
    await expect(passcodeRefusal(t.db, CTX, boom, "link", "x")).rejects.toThrow("connection lost");
    expect(t.committed()).toBe(0);
    expect(t.rolledBack()).toBe(1);
  });
});

describe("admissionError", () => {
  it("collapses every question about the link's existence into one 404", () => {
    const e = admissionError("not_found");
    expect(e.code).toBe("not_found");
    expect(e.status).toBe(404);
  });

  it("tells apart only what a holder of a resolvable token has earned", () => {
    expect(admissionError("passcode_required").status).toBe(403);
    expect(admissionError("passcode_wrong").status).toBe(403);
    expect(admissionError("passcode_locked").status).toBe(429);
    expect(admissionError("email_not_allowed").status).toBe(403);
    for (const refusal of [
      "passcode_required",
      "passcode_wrong",
      "passcode_locked",
      "email_not_allowed",
    ] as const) {
      expect(admissionError(refusal).details["reason"]).toBe(refusal);
    }
  });

  it("never names the link, the workspace or the target in the message", () => {
    for (const refusal of [
      "not_found",
      "passcode_required",
      "passcode_wrong",
      "passcode_locked",
      "email_not_allowed",
    ] as const) {
      expect(admissionError(refusal).message).not.toMatch(/0192f1a0|acme/iu);
    }
  });
});

describe("emailHintOf", () => {
  it("masks the one address a single-contact link names", () => {
    expect(emailHintOf(linkWith({ emails: ["ada@acme.com"] }))).toMatch(/^a.*@acme\.com$/u);
    expect(emailHintOf(linkWith({ emails: ["ada@acme.com"] }))).not.toContain("ada@");
  });

  it("reveals nothing for a link with no named contact, or with more than one", () => {
    expect(emailHintOf(linkWith())).toBeUndefined();
    expect(emailHintOf(linkWith({ domains: ["acme.com"] }))).toBeUndefined();
    // A link naming twenty contacts would be a directory; it gets to reveal none of them.
    expect(emailHintOf(linkWith({ emails: ["ada@acme.com", "bob@acme.com"] }))).toBeUndefined();
  });
});

describe("shareLinkUrl", () => {
  const deps = {
    baseUrl: new URL("https://portal.example.test"),
    tenancy: "multi" as const,
  } as ApiDeps;

  it("mints the URL on the workspace's own origin", () => {
    expect(shareLinkUrl(deps, { slug: "acme", primaryHost: null } as never, "tok")).toBe(
      "https://acme.portal.example.test/s/tok",
    );
    // E2.1 decision 5: a verified custom domain is the workspace's primary origin, and that is
    // where the visitor's session cookie will live. A link minted on the canonical subdomain
    // would sign them in somewhere the portal no longer answers.
    expect(
      shareLinkUrl(deps, { slug: "acme", primaryHost: "investors.acme.com" } as never, "tok"),
    ).toBe("https://investors.acme.com/s/tok");
  });
});

describe("the offering-mode switch (contract S4)", () => {
  it("the manifest and the route guard read one list", () => {
    expect(shareLinksModule.offeringStatusRules?.disabledWhen).toEqual([
      ...SHARE_LINKS_DISABLED_WHEN,
    ]);
  });

  /*
   * The manifest's declaration and the route guard now say the same thing, and both halves are
   * load-bearing (work package H, defect 2).
   *
   * `isDisabledForOffering` used to short-circuit to `false` for any `required` manifest, which
   * made `disabledWhen` silently inert on every kernel manifest — so the routes 404'd (thanks to
   * `requireOffering`) while the bootstrap went on emitting the manifest's `admin.nav` slot, and
   * an `informational` workspace's admin nav offered a "Share links" item leading to a 404. The
   * short-circuit is gone; see `packages/module-kit/src/enablement.ts` for why `required` was
   * answering the wrong question.
   *
   * `requireOffering` stays, and for a reason the change does not touch: kernel routes are
   * registered directly on the API app, above `api.ts`'s per-module enablement middleware, which
   * only ever wraps routes a *module package* mounts.
   */
  it("flows through isDisabledForOffering, required manifest or not", () => {
    expect(shareLinksModule.required).toBe(true);
    for (const status of SHARE_LINKS_DISABLED_WHEN) {
      expect(isDisabledForOffering(shareLinksModule, status)).toBe(true);
    }
    for (const status of ["506b", "506c", "non_us"] as const) {
      expect(isDisabledForOffering(shareLinksModule, status)).toBe(false);
    }
  });

  it("emits no admin nav item where the routes 404, and the item where they do not", () => {
    const registry = createModuleRegistry([shareLinksModule]);
    const modules = {
      workspaceId: WORKSPACE_ID,
      enabled: new Set(["share-links"]),
      flags: new Map<string, boolean>(),
    };
    const staff = { id: "m", kind: "staff", role: "owner", status: "active" };
    const navOf = (offeringStatus: string) =>
      buildBootstrap({
        registry,
        workspace: { id: WORKSPACE_ID, slug: "acme", name: "Acme", offeringStatus } as never,
        modules,
        membership: staff as never,
        permissions: [],
      }).modules.find((m) => m.id === "share-links");

    for (const status of SHARE_LINKS_DISABLED_WHEN) {
      expect(navOf(status)).toMatchObject({ enabled: false, slots: {} });
    }
    const live = navOf("506c");
    expect(live).toMatchObject({ enabled: true });
    expect(live?.slots["admin.nav"]).toHaveLength(1);
  });
});

/*
 * ---------------------------------------------------------------------------------------------
 * The public three, over a real router (work package H, defect 1).
 *
 * What broke: `ShareLinkService.resolve` applied `isLive` — open **plus** the use and view caps —
 * and it is the only token → link mapping these routes have. So the moment a link reached
 * `max_uses`, `GET /links/{token}` and `POST /links/{token}/start` answered 404 *before* `redeem`
 * (which correctly uses `isOpen`, work package B's B4) could run, and a visitor the link had
 * already admitted could not sign in again from a new device or after their session expired —
 * while `PrincipalRepo` went on emitting the link's subject for them (A6). A use cap limits how
 * many people may come in, not how long the ones who did may stay.
 *
 * What must not break while fixing it: `POST …/start` holds an email address, so it *could* tell
 * a returning visitor from a new one out loud — and must not, or anyone ever forwarded the link
 * could ask it "has <address> been let into this room?". The reply is therefore identical either
 * way, and the difference lives where it is invisible: whether a code is mailed at all. The seat
 * is spent, or refused, by `claimUse` inside `verify`.
 *
 * The fakes are the thinnest things that can carry those claims. The store is the SQL's semantics
 * in memory — `claimUse` decides and increments with no `await` between, exactly as
 * `UPDATE … WHERE uses < max_uses RETURNING` does. The OTP fake is `checkEligibility`'s rule
 * (`packages/identity/src/services/login.ts`: a live membership, **or** the link admits the
 * address) behind `emailOtp.start`'s constant reply, plus `establishFromLink`'s single call to
 * `ShareLinkAccess.bind`. The same flow against real Postgres is work package G's
 * (`apps/server/src/share-links.integration.test.ts`).
 */

/**
 * `routes/links.ts` builds its own `ShareLinkService` (contract E6) and has nowhere to pass a
 * store, so the seam the service already has — `ShareLinkDeps.store`, which exists precisely so
 * this package can be exercised without a database — is reached through the module mock rather
 * than by adding a test-only parameter to a production signature.
 */
const injected = vi.hoisted(() => ({ store: undefined as ShareLinkStore | undefined }));

vi.mock("@fundroom/share-links", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@fundroom/share-links")>();
  return {
    ...actual,
    createShareLinkService: (deps: ShareLinkDeps) => {
      const store = injected.store;
      return actual.createShareLinkService(
        store === undefined ? deps : { ...deps, store: () => store },
      );
    },
  };
});

const WORKSPACE_ID = CTX.workspaceId;
const LINK_ID = "0192f1a0-5c3e-7d2a-9a3b-000000000001";
const RETURNING = "0192f1a0-5c3e-7d2a-9a3b-0000000000a1";
const NEWCOMER = "0192f1a0-5c3e-7d2a-9a3b-0000000000a2";
/** An existing member of the workspace who was never admitted through *this* link. */
const OUTSIDER = "0192f1a0-5c3e-7d2a-9a3b-0000000000a3";
const MEMBERSHIPS: ReadonlyMap<string, string> = new Map([
  ["ada@acme.com", RETURNING],
  ["bob@acme.com", OUTSIDER],
]);
const NOW = new Date("2026-09-14T12:00:00.000Z");
const TOKEN = "t".repeat(43);

interface Fixture {
  readonly store: ShareLinkStore;
  readonly link: { maxUses: number | null; uses: number; status: "active" | "paused" | "revoked" };
  readonly bound: Set<string>;
}

/** `core.share_link` + `core.share_link_visit`, with the two claims' statement semantics. */
function memoryStore(over: Partial<Fixture["link"]> = {}): Fixture {
  const link = { maxUses: null as number | null, uses: 0, status: "active" as const, ...over };
  const bound = new Set<string>();
  const record = (): LinkRecord => ({
    id: LINK_ID,
    workspaceId: WORKSPACE_ID,
    label: "Series A room",
    status: link.status,
    policy: { domains: [], emails: [], forceWatermark: false },
    grants: [],
    groupIds: [],
    passcodeHash: null,
    passcodeAttempts: 0,
    passcodeLockedUntil: null,
    maxUses: link.maxUses,
    uses: link.uses,
    maxViews: null,
    views: 0,
    expiresAt: null,
    createdBy: null,
    createdAt: NOW,
    revokedAt: link.status === "revoked" ? NOW : null,
  });
  const open = () => link.status === "active";
  const store: ShareLinkStore = {
    create: () => Promise.reject(new Error("not used")),
    byId: async (id) => (id === LINK_ID ? record() : undefined),
    byTokenHash: async (hash) =>
      Buffer.from(hash).equals(Buffer.from(tokenHash(TOKEN))) ? record() : undefined,
    list: async () => [],
    // One statement: the cap is read and the counter written with no `await` between, which is
    // what `UPDATE … WHERE uses < max_uses RETURNING` gives and the only reason the cap holds.
    claimUse: async (id) => {
      await Promise.resolve();
      if (id !== LINK_ID || !open()) return undefined;
      if (link.maxUses !== null && link.uses >= link.maxUses) return undefined;
      link.uses += 1;
      return link.uses;
    },
    claimView: async () => undefined,
    upsertVisit: async (input) => {
      await Promise.resolve();
      const inserted = !bound.has(input.membershipId);
      bound.add(input.membershipId);
      return { visitId: `visit-${input.membershipId}`, inserted, revokedAt: null };
    },
    claimViewSession: async () => true,
    countVisitView: async () => false,
    setPasscodeHash: async () => undefined,
    recordPasscodeAttempt: async () => undefined,
    lockPasscode: async () => {},
    clearPasscodeAttempts: async () => {},
    revoke: async () => undefined,
    setPaused: async () => undefined,
    revokeVisit: async () => false,
    visits: async () => [],
    // The route tests never mint a link, so the only honest fake is one that refuses: a stub
    // returning 0 would let a future test assert "no grants were written" and pass for the
    // wrong reason.
    writeLinkGrants: () => Promise.reject(new Error("not used")),
    offeringStatus: async () => "506c",
    bumpAcl: async () => {},
  };
  return { store, link, bound };
}

interface OtpFake {
  readonly emailOtp: AuthService["emailOtp"];
  /** Addresses a code was actually minted for. An empty set is "no mail was sent". */
  readonly mailed: Set<string>;
}

/**
 * `emailOtp` as the share-link routes use it: `start` decides eligibility the way
 * `checkEligibility` does and answers the same body either way, and `verify` refuses a code that
 * was never minted, then runs `establishFromLink`'s one call into the link — `bind`.
 */
function otpFake(deps: {
  readonly links: () => ShareLinkAccess;
  readonly members: ReadonlySet<string>;
  readonly membershipIdOf: (email: string) => string;
  readonly db: Pick<Database, "withTenant">;
}): OtpFake {
  const mailed = new Set<string>();
  const ctx = systemContext(WORKSPACE_ID);
  const emailOtp = {
    async start(input: { email: string; linkId?: string | undefined }) {
      const eligible =
        deps.members.has(input.email) ||
        (input.linkId !== undefined &&
          (await deps.db.withTenant(ctx, (tx) =>
            deps.links().admits(ctx, tx, input.linkId as string, input.email),
          )));
      if (eligible) mailed.add(input.email);
      // `emailOtp.start`'s whole design: same body, same floor, mail or no mail.
      return { status: "sent" as const, emailHint: "a***@acme.com", ttlMinutes: 10 };
    },
    async verify(input: { email: string; code: string; linkId?: string | undefined }) {
      if (!mailed.has(input.email)) {
        throw new ApiError("invalid_code", "that code is not right");
      }
      const membershipId = deps.membershipIdOf(input.email);
      if (input.linkId !== undefined) {
        await deps.db.withTenant(ctx, (tx) =>
          deps.links().bind(ctx, tx, { linkId: input.linkId as string, membershipId }),
        );
      }
      return loginResult(membershipId);
    },
  };
  return { emailOtp: emailOtp as unknown as AuthService["emailOtp"], mailed };
}

function loginResult(membershipId: string): LoginResult {
  return {
    token: "session-token",
    deviceToken: "device-token",
    session: {
      sessionId: "0192f1a0-5c3e-7d2a-9a3b-0000000000f1",
      userId: "0192f1a0-5c3e-7d2a-9a3b-0000000000f2",
      deviceId: undefined,
      population: "external",
      context: "first_party",
      authLevel: 1,
      authTime: NOW,
      createdAt: NOW,
      idleExpiresAt: new Date(NOW.getTime() + 3_600_000),
      absoluteExpiresAt: new Date(NOW.getTime() + 86_400_000),
      lastWorkspaceId: WORKSPACE_ID,
      user: { displayName: "Ada", mfaEnrolled: false },
    },
    isNewDevice: true,
    isNewUser: true,
    membership: { id: membershipId, kind: "external", role: "investor", status: "active" },
  };
}

interface Rig {
  readonly app: OpenAPIHono<AppEnv>;
  readonly fixture: Fixture;
  readonly otp: OtpFake;
}

function rig(
  options: {
    readonly link?: Partial<Fixture["link"]>;
    readonly members?: ReadonlySet<string>;
    readonly offeringStatus?: "none" | "informational" | "506b" | "506c" | "non_us";
  } = {},
): Rig {
  const fixture = memoryStore(options.link ?? {});
  injected.store = fixture.store;

  const db: Pick<Database, "withTenant"> = {
    withTenant: (async (_ctx: TenantContext, fn: (tx: unknown) => Promise<unknown>) =>
      fn({})) as Pick<Database, "withTenant">["withTenant"],
  };
  // The service the routes build is the one under test; this second handle over the same store is
  // what the OTP fake uses, exactly as `container.ts` wires `createShareLinkAccess` into identity.
  const access = createShareLinkAccess(
    createShareLinkService({
      audit: { record: async () => undefined } as unknown as ShareLinkDeps["audit"],
      keyRing: {
        current: { id: "v1", key: Buffer.alloc(32), fingerprint: "sha256:test" },
      } as never,
      now: () => NOW,
      store: () => fixture.store,
    }),
  );
  const otp = otpFake({
    links: () => access,
    members: options.members ?? new Set<string>(),
    membershipIdOf: (email) => MEMBERSHIPS.get(email) ?? NEWCOMER,
    db,
  });

  const deps = {
    db,
    audit: { record: async () => undefined },
    auth: { emailOtp: otp.emailOtp },
    identityDeps: {
      keyRing: { current: { id: "v1", key: Buffer.alloc(32), fingerprint: "sha256:test" } },
    },
    rateLimiter: { hit: async () => ({ allowed: true, retryAfterMs: 0 }) },
    registry: { resourceKinds: {} },
    log: () => {},
    trustProxy: false,
    basePath: "",
    baseUrl: new URL("https://portal.example.test"),
    tenancy: "multi",
    authz: {},
  } as unknown as ApiDeps;

  const app = createApi<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("workspace", {
      id: WORKSPACE_ID,
      slug: "acme",
      name: "Acme",
      offeringStatus: options.offeringStatus ?? "506c",
      primaryHost: null,
    } as never);
    await next();
  });
  registerLinkRoutes(app, deps);
  app.onError(apiErrorHandler(() => {}));
  return { app, fixture, otp };
}

async function post(app: OpenAPIHono<AppEnv>, path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("the public link routes on a link whose seats are spent (defect 1)", () => {
  afterEach(() => {
    injected.store = undefined;
  });

  it("still resolves the token, because the link is still granting the people it admitted", async () => {
    const { app } = rig({ link: { maxUses: 1, uses: 1 } });
    const res = await app.request(`/links/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ valid: true, workspaceName: "Acme" });
  });

  it("goes on collapsing revoked and paused into the same 404 an unknown token gets", async () => {
    for (const status of ["revoked", "paused"] as const) {
      const { app } = rig({ link: { status } });
      expect((await app.request(`/links/${TOKEN}`)).status).toBe(404);
    }
    const { app } = rig();
    expect((await app.request(`/links/${"x".repeat(43)}`)).status).toBe(404);
  });

  /*
   * The anti-oracle assertion, and the reason the fix is not "look the address up".
   *
   * Byte-identical replies for an address the link already admitted and one it never has. The
   * only difference is the `mailed` set, which lives in a mailbox the caller has to control to
   * read — so an attacker holding a forwarded link learns nothing about who is in the room.
   */
  it("answers a returning visitor and a stranger identically, and mails only the first", async () => {
    const { app, otp } = rig({
      link: { maxUses: 1, uses: 1 },
      members: new Set(["ada@acme.com"]),
    });
    const returning = await post(app, `/links/${TOKEN}/start`, { email: "ada@acme.com" });
    const stranger = await post(app, `/links/${TOKEN}/start`, { email: "mallory@evil.test" });

    expect(returning.status).toBe(200);
    expect(stranger.status).toBe(returning.status);
    expect(await stranger.text()).toBe(await returning.text());
    expect([...otp.mailed]).toEqual(["ada@acme.com"]);
  });

  it("lets the returning visitor sign in, and spends no second seat doing it", async () => {
    const { app, fixture } = rig({
      link: { maxUses: 1, uses: 1 },
      members: new Set(["ada@acme.com"]),
    });
    // Ada was admitted while the link still had its seat; the binding is already there.
    fixture.bound.add(RETURNING);
    await post(app, `/links/${TOKEN}/start`, { email: "ada@acme.com" });
    const back = await post(app, `/links/${TOKEN}/verify`, {
      email: "ada@acme.com",
      code: "123456",
      rememberDevice: false,
    });
    expect(back.status).toBe(200);
    // `upsertVisit` updated rather than inserted, so `claimUse` never ran: `max_uses` counts
    // distinct memberships admitted, and Ada was already one of them.
    expect(fixture.link.uses).toBe(1);
  });

  it("a stranger gets no code at all, so verify refuses them without touching the link", async () => {
    const { app, fixture } = rig({ link: { maxUses: 1, uses: 1 } });
    await post(app, `/links/${TOKEN}/start`, { email: "mallory@evil.test" });
    const res = await post(app, `/links/${TOKEN}/verify`, {
      email: "mallory@evil.test",
      code: "123456",
      rememberDevice: false,
    });
    // `invalid_code`, the ordinary answer to a code that was never minted — not a 404 that would
    // have said "this link is spent", and not a seat.
    expect(res.status).toBe(400);
    expect(fixture.link.uses).toBe(1);
    expect(fixture.bound.size).toBe(0);
  });

  /*
   * The cap, still enforced, by the only check that can enforce it under concurrency.
   *
   * Bob is already a member of this workspace by some other route, so `checkEligibility` mails
   * him a code whatever the link says — the link is only one of three eligibility sources. He has
   * never been admitted *through this link*, so his `upsertVisit` inserts, `claimUse` runs, and
   * the conditional `UPDATE` refuses. He learns nothing he did not already know: he proved
   * control of his own mailbox to be told about his own membership.
   */
  it("still refuses a membership the link never admitted, decided by claimUse", async () => {
    const { app, fixture } = rig({
      link: { maxUses: 1, uses: 1 },
      members: new Set(["bob@acme.com"]),
    });
    const start = await post(app, `/links/${TOKEN}/start`, { email: "bob@acme.com" });
    expect(start.status).toBe(200);
    const res = await post(app, `/links/${TOKEN}/verify`, {
      email: "bob@acme.com",
      code: "123456",
      rememberDevice: false,
    });
    expect(res.status).toBe(404);
    expect(fixture.link.uses).toBe(1);
  });

  it("admits a new visitor while a seat is left, and the seat is spent by the claim", async () => {
    const { app, fixture } = rig({ link: { maxUses: 1, uses: 0 } });
    await post(app, `/links/${TOKEN}/start`, { email: "mallory@evil.test" });
    const first = await post(app, `/links/${TOKEN}/verify`, {
      email: "mallory@evil.test",
      code: "123456",
      rememberDevice: false,
    });
    expect(first.status).toBe(200);
    expect(fixture.link.uses).toBe(1);
  });

  it("is still switched off entirely by the offering status, spent seats or not", async () => {
    const { app } = rig({ link: { maxUses: 1, uses: 1 }, offeringStatus: "informational" });
    expect((await app.request(`/links/${TOKEN}`)).status).toBe(404);
    expect((await post(app, `/links/${TOKEN}/start`, { email: "ada@acme.com" })).status).toBe(404);
  });
});
