import { isApiError } from "@fundroom/contracts";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../env.js";
import { sessionServesWorkspace, ssoBlocks, ssoRequiredError } from "./auth.js";
import { requireMember, requirePermission } from "./authz.js";

/*
 * Staff SSO (E3.8 decisions 5 and 8): which sessions a workspace may see, and which staff
 * memberships enforced SSO holds out. The integration file (`sso-session.integration.test.ts`)
 * proves the same rules through the real chain; this pins the decision table.
 */
const WS = "01920000-0000-7000-8000-00000000aa01";
const OTHER = "01920000-0000-7000-8000-00000000aa02";
const CONN = "01920000-0000-7000-8000-00000000cc01";
const bound = { workspaceId: WS, connectionId: CONN, connectionVersion: 3 };
const live = (id: string, connectionId: string | null = CONN, version: number | null = 3) => ({
  id,
  ssoConnectionId: connectionId,
  ssoConnectionVersion: version,
});

describe("sessionServesWorkspace", () => {
  it("serves an unbound session anywhere", () => {
    expect(sessionServesWorkspace({}, live(WS))).toBe(true);
    // E3.10: an operator session never serves a tenant request, whatever the workspace.
    expect(sessionServesWorkspace({ population: "operator" }, live(WS))).toBe(false);
    expect(sessionServesWorkspace({ population: "operator" }, undefined)).toBe(false);
    expect(sessionServesWorkspace({}, undefined)).toBe(true);
  });

  it("serves an SSO-bound session only in its own workspace", () => {
    expect(sessionServesWorkspace({ sso: bound }, live(WS))).toBe(true);
    expect(sessionServesWorkspace({ sso: bound }, live(OTHER))).toBe(false);
    expect(sessionServesWorkspace({ sso: bound }, undefined)).toBe(false);
  });

  it("serves a central-auth bound session only in its own workspace (E3.10)", () => {
    expect(sessionServesWorkspace({ boundWorkspaceId: WS }, live(WS))).toBe(true);
    expect(sessionServesWorkspace({ boundWorkspaceId: WS }, live(WS, null, null))).toBe(true);
    expect(sessionServesWorkspace({ boundWorkspaceId: WS }, live(OTHER))).toBe(false);
    // Not the canonical host either.
    expect(sessionServesWorkspace({ boundWorkspaceId: WS }, undefined)).toBe(false);
  });

  it("serves it only while its connection is the live one at the version it was minted under", () => {
    expect(sessionServesWorkspace({ sso: bound }, live(WS, null, null))).toBe(false);
    expect(sessionServesWorkspace({ sso: bound }, live(WS, OTHER, 3))).toBe(false);
    expect(sessionServesWorkspace({ sso: bound }, live(WS, CONN, 4))).toBe(false);
    expect(sessionServesWorkspace({ sso: { workspaceId: WS, connectionId: CONN } }, live(WS))).toBe(
      false,
    );
  });
});

describe("ssoBlocks", () => {
  const on = { id: WS, ssoEnforced: true };
  const off = { id: WS, ssoEnforced: false };
  const staff = (role: string) => ({ kind: "staff", role }) as never;

  it("never blocks when enforcement is off", () => {
    expect(ssoBlocks(off, staff("editor"), { authLevel: 1 })).toBe(false);
  });

  it("blocks staff without a session from this workspace's SSO", () => {
    for (const role of ["admin", "editor", "viewer", "finance", "legal"]) {
      expect(ssoBlocks(on, staff(role), { authLevel: 2 })).toBe(true);
    }
  });

  it("admits staff whose session this workspace's SSO minted", () => {
    expect(ssoBlocks(on, staff("editor"), { authLevel: 1, sso: bound })).toBe(false);
  });

  it("admits an owner at auth level 2 (break-glass), not at level 1", () => {
    expect(ssoBlocks(on, staff("owner"), { authLevel: 2 })).toBe(false);
    expect(ssoBlocks(on, staff("owner"), { authLevel: 1 })).toBe(true);
  });

  it("never blocks external members", () => {
    expect(ssoBlocks(on, { kind: "external", role: "investor" } as never, { authLevel: 1 })).toBe(
      false,
    );
    expect(ssoBlocks(on, { kind: "external", role: "delegate" } as never, { authLevel: 0 })).toBe(
      false,
    );
  });
});

function ctxWith(vars: Record<string, unknown>): Context<AppEnv> {
  return { get: (key: string) => vars[key] } as unknown as Context<AppEnv>;
}

const session = { sessionId: "s", authLevel: 1, user: { mfaEnrolled: false } };

async function outcome(
  guard: (c: Context<AppEnv>, next: () => Promise<void>) => Promise<unknown>,
  vars: Record<string, unknown>,
): Promise<{ code?: string; status?: number; details?: unknown; reached: boolean }> {
  let reached = false;
  try {
    await guard(ctxWith(vars), async () => {
      reached = true;
    });
    return { reached };
  } catch (error) {
    if (!isApiError(error)) throw error;
    return { reached, code: error.code, status: error.status, details: error.details };
  }
}

describe("guards under enforcement", () => {
  it("answer 403 sso_required with the break-glass hint for an owner", async () => {
    const guard = requireMember() as never;
    expect(await outcome(guard, { session, ssoRequired: { breakGlass: false } })).toEqual({
      reached: false,
      code: "sso_required",
      status: 403,
      details: { reason: "enforced" },
    });
    const owner = await outcome(guard, { session, ssoRequired: { breakGlass: true } });
    expect(owner.details).toEqual({ reason: "enforced", breakGlass: true });
    const perm = requirePermission({ authz: () => ({}) as never }, "sso.read") as never;
    expect((await outcome(perm, { session, ssoRequired: { breakGlass: false } })).code).toBe(
      "sso_required",
    );
  });

  it("leave everything else to the ordinary answers", async () => {
    expect(ssoRequiredError(ctxWith({}))).toBeUndefined();
    expect((await outcome(requireMember() as never, { session })).code).toBe("not_found");
    expect((await outcome(requireMember() as never, {})).code).toBe("unauthenticated");
  });
});
