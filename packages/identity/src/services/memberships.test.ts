import type { Membership } from "@fundroom/db";
import { describe, expect, it } from "vitest";
import { AuthError } from "../errors.js";
import { completeLogin, ssoAdmits } from "./login.js";
import {
  createMembershipService,
  isSystemActor,
  provisionDecision,
  suspendRefusal,
} from "./memberships.js";
import type { SessionService } from "./sessions.js";
import type { IdentityDeps } from "./types.js";

/*
 * E3.8 staff SSO / SCIM: the membership rules the SSO finish and SCIM call, stated as pure
 * functions, and the refusals that must happen before anything touches the database.
 */
const WS = "01920000-0000-7000-8000-00000000aa01";
const OTHER_WS = "01920000-0000-7000-8000-00000000aa02";
const CONN = "01920000-0000-7000-8000-00000000cc01";
const SCIM = { kind: "system", label: "scim:01920000-0000-7000-8000-00000000dd01" } as const;

/** Deps whose database fails the test if any code path reaches it. */
function untouchable(): IdentityDeps {
  const boom = () => {
    throw new Error("the database must not be reached");
  };
  return {
    db: { withHost: boom, withTenant: boom },
    audit: { record: boom, recordDetached: boom },
  } as unknown as IdentityDeps;
}

const noSessions = {} as unknown as SessionService;

function m(over: Partial<Membership>): Pick<Membership, "kind" | "role" | "status"> {
  return { kind: "staff", role: "editor", status: "active", ...over } as Membership;
}

describe("provisionDecision", () => {
  it("creates a membership when the person holds none here", () => {
    expect(provisionDecision(undefined, "active")).toBe("create");
    expect(provisionDecision(undefined, "suspended")).toBe("create");
  });

  it("adopts an existing staff membership without changing it", () => {
    for (const status of ["active", "dormant", "suspended"] as const) {
      expect(provisionDecision(m({ status }), "active")).toBe("adopt");
    }
  });

  it("activates an invited staff membership, unless the provisioner asked for a suspended one", () => {
    expect(provisionDecision(m({ status: "invited" }), "active")).toBe("adopt_activate");
    expect(provisionDecision(m({ status: "invited" }), "suspended")).toBe("adopt");
  });

  it("refuses an external member (an investor is never turned into staff by an IdP)", () => {
    expect(provisionDecision(m({ kind: "external", role: "investor" }), "active")).toBe("conflict");
    expect(provisionDecision(m({ kind: "external", role: "delegate" }), "active")).toBe("conflict");
  });
});

describe("suspendRefusal", () => {
  it("never suspends an owner", () => {
    expect(suspendRefusal(m({ role: "owner" }))).toBe("owner_protected");
  });

  it("answers not_found for a missing or revoked membership", () => {
    expect(suspendRefusal(undefined)).toBe("not_found");
    expect(suspendRefusal(m({ status: "revoked" }))).toBe("not_found");
  });

  it("allows staff of any other role and external members", () => {
    for (const role of ["admin", "editor", "viewer", "finance", "legal"] as const) {
      expect(suspendRefusal(m({ role }))).toBeUndefined();
    }
    expect(suspendRefusal(m({ kind: "external", role: "investor" }))).toBeUndefined();
    expect(suspendRefusal(m({ status: "suspended" }))).toBeUndefined();
  });
});

describe("isSystemActor", () => {
  it("tells the SCIM actor from a person", () => {
    expect(isSystemActor(SCIM)).toBe(true);
    expect(isSystemActor({ membershipId: CONN, userId: CONN, role: "owner" } as const)).toBe(false);
    expect(isSystemActor(undefined)).toBe(false);
  });
});

describe("provisionStaff refusals (before any write)", () => {
  const service = createMembershipService(untouchable(), noSessions);
  const ctx = { workspaceId: WS, actorKind: "system" } as const;

  it("refuses to provision an owner", async () => {
    const err = await service
      .provisionStaff(ctx, { email: "a@acme.test", role: "owner", source: "scim" }, SCIM)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).code).toBe("forbidden");
    expect((err as AuthError).details["reason"]).toBe("owner_protected");
  });

  it("refuses a role that is not a staff role", async () => {
    const err = await service
      .provisionStaff(ctx, { email: "a@acme.test", role: "investor" as never, source: "sso" }, SCIM)
      .catch((e: unknown) => e);
    expect((err as AuthError).code).toBe("invalid_request");
  });

  it("refuses something that is not an email address", async () => {
    const err = await service
      .provisionStaff(ctx, { email: "not-an-address", role: "viewer", source: "scim" }, SCIM)
      .catch((e: unknown) => e);
    expect((err as AuthError).code).toBe("validation_failed");
  });
});

describe("ssoAdmits", () => {
  it("admits a staff membership or a staff invitation only", () => {
    expect(ssoAdmits({ membership: m({}) as Membership, invite: undefined })).toBe(true);
    expect(
      ssoAdmits({
        membership: m({ kind: "external", role: "investor" }) as Membership,
        invite: undefined,
      }),
    ).toBe(false);
    expect(ssoAdmits({ membership: undefined, invite: { kind: "staff" } as never })).toBe(true);
    expect(ssoAdmits({ membership: undefined, invite: { kind: "external" } as never })).toBe(false);
    expect(ssoAdmits({ membership: undefined, invite: undefined })).toBe(false);
  });
});

describe("completeLogin SSO binding checks (before any read)", () => {
  const base = { email: "a@acme.test", authLevel: 1 as const };
  const attempt = (input: Parameters<typeof completeLogin>[2]) =>
    completeLogin(untouchable(), noSessions, input).then(
      () => ({ code: "no error" }),
      (e: unknown) => e as AuthError,
    );

  it("needs the binding with method sso, and refuses it with any other method", async () => {
    expect((await attempt({ ...base, workspaceId: WS, method: "sso" })).code).toBe(
      "invalid_request",
    );
    expect(
      (
        await attempt({
          ...base,
          workspaceId: WS,
          method: "email_otp",
          sso: { workspaceId: WS, connectionId: CONN },
        })
      ).code,
    ).toBe("invalid_request");
  });

  it("refuses a binding for another workspace, or with no workspace at all", async () => {
    const sso = { workspaceId: OTHER_WS, connectionId: CONN };
    expect((await attempt({ ...base, workspaceId: WS, method: "sso", sso })).code).toBe(
      "invalid_request",
    );
    expect((await attempt({ ...base, method: "sso", sso })).code).toBe("invalid_request");
  });

  it("refuses the embed", async () => {
    const sso = { workspaceId: WS, connectionId: CONN };
    expect(
      (await attempt({ ...base, workspaceId: WS, method: "sso", sso, embed: true })).code,
    ).toBe("invalid_request");
  });
});
