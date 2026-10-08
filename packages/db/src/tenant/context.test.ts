import { describe, expect, it } from "vitest";
import { assertTenantContext, isViewingAs, systemContext, TenantContextError } from "./context.js";

const WS = "01920000-0000-7000-8000-000000000001";
const M = "01920000-0000-7000-8000-000000000002";

describe("assertTenantContext", () => {
  it("accepts staff/external with a membership and system without", () => {
    expect(() =>
      assertTenantContext({ workspaceId: WS, actorKind: "staff", membershipId: M }),
    ).not.toThrow();
    expect(() =>
      assertTenantContext({ workspaceId: WS, actorKind: "external", membershipId: M }),
    ).not.toThrow();
    expect(() => assertTenantContext(systemContext(WS))).not.toThrow();
  });

  it("rejects non-UUID ids (nothing user-controlled reaches set_config)", () => {
    expect(() => assertTenantContext({ workspaceId: "1 OR 1=1", actorKind: "system" })).toThrow(
      TenantContextError,
    );
    expect(() =>
      assertTenantContext({ workspaceId: WS, actorKind: "staff", membershipId: "nope" }),
    ).toThrow(/membershipId/u);
    expect(() => assertTenantContext({ workspaceId: WS, actorKind: "system", userId: "" })).toThrow(
      /userId/u,
    );
  });

  it("rejects host as a tenant actor and unknown kinds", () => {
    expect(() =>
      assertTenantContext({ workspaceId: WS, actorKind: "host" as never, membershipId: M }),
    ).toThrow(/actorKind/u);
    expect(() =>
      assertTenantContext({ workspaceId: WS, actorKind: "admin" as never, membershipId: M }),
    ).toThrow(/actorKind/u);
  });

  it("requires a membership for staff and external", () => {
    expect(() => assertTenantContext({ workspaceId: WS, actorKind: "staff" })).toThrow(
      /membershipId/u,
    );
  });

  it("accepts viewAs only on an external context with UUID ids", () => {
    const viewAs = { staffMembershipId: M, staffUserId: M };
    const ext = { workspaceId: WS, actorKind: "external" as const, membershipId: M, viewAs };
    expect(() => assertTenantContext(ext)).not.toThrow();
    expect(isViewingAs(ext)).toBe(true);
    expect(isViewingAs(systemContext(WS))).toBe(false);
    expect(() =>
      assertTenantContext({ workspaceId: WS, actorKind: "staff", membershipId: M, viewAs }),
    ).toThrow(/viewAs/u);
    expect(() =>
      assertTenantContext({ ...ext, viewAs: { staffMembershipId: "x", staffUserId: M } }),
    ).toThrow(/viewAs/u);
  });
});
