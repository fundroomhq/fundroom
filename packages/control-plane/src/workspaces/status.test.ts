import type { WorkspaceHold } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { applyHold, deriveWorkspaceStatus, holdAction } from "./status.js";

/*
 * Workspace holds (E3.10, fix round 1). Each writer (operator, billing, sanctions) owns one flag,
 * so none can undo another's; the status is derived from the flags (the same rule the 0023 trigger
 * applies — `workspace-status.integration.test.ts` checks the two agree).
 */

describe("deriveWorkspaceStatus", () => {
  it("is active with no holds and held with only a sanctions review", () => {
    expect(deriveWorkspaceStatus([])).toEqual({ status: "active", reason: null });
    expect(deriveWorkspaceStatus(["sanctions_review"])).toEqual({
      status: "pending_review",
      reason: null,
    });
  });

  it("ranks relocation (E3.11) right below operator", () => {
    expect(deriveWorkspaceStatus(["relocation"])).toEqual({
      status: "suspended",
      reason: "relocation",
    });
    expect(deriveWorkspaceStatus(["billing", "relocation"])).toEqual({
      status: "suspended",
      reason: "relocation",
    });
    expect(deriveWorkspaceStatus(["operator", "relocation"])).toEqual({
      status: "suspended",
      reason: "operator",
    });
    expect(deriveWorkspaceStatus(["relocation", "sanctions_review"])).toEqual({
      status: "suspended",
      reason: "relocation",
    });
  });

  it("suspends for any suspension flag, naming the highest (sanctions > operator > billing)", () => {
    expect(deriveWorkspaceStatus(["billing"])).toEqual({ status: "suspended", reason: "billing" });
    expect(deriveWorkspaceStatus(["billing", "operator"])).toEqual({
      status: "suspended",
      reason: "operator",
    });
    expect(deriveWorkspaceStatus(["billing", "operator", "sanctions"])).toEqual({
      status: "suspended",
      reason: "sanctions",
    });
    // A suspension outranks the review hold.
    expect(deriveWorkspaceStatus(["billing", "sanctions_review"])).toEqual({
      status: "suspended",
      reason: "billing",
    });
  });
});

describe("applyHold", () => {
  it("sets and clears one flag, leaving the others", () => {
    const held: WorkspaceHold[] = ["sanctions_review"];
    const both = applyHold(held, "operator", true);
    expect(both).toEqual(["operator", "sanctions_review"]);
    // R3-M1: an operator's unsuspend over a review hold keeps the hold.
    expect(deriveWorkspaceStatus(applyHold(both, "operator", false))).toEqual({
      status: "pending_review",
      reason: null,
    });
    // Paid again under an operator suspension: still suspended for the operator.
    expect(deriveWorkspaceStatus(applyHold(["billing", "operator"], "billing", false))).toEqual({
      status: "suspended",
      reason: "operator",
    });
  });

  it("is idempotent", () => {
    expect(applyHold(["operator"], "operator", true)).toEqual(["operator"]);
    expect(applyHold([], "billing", false)).toEqual([]);
  });
});

describe("holdAction", () => {
  it("records the review hold as hold / release and the others as suspend / unsuspend", () => {
    expect(holdAction("sanctions_review", true)).toBe("workspace.hold");
    expect(holdAction("sanctions_review", false)).toBe("workspace.release");
    expect(holdAction("operator", true)).toBe("workspace.suspend");
    expect(holdAction("billing", false)).toBe("workspace.unsuspend");
    expect(holdAction("sanctions", true)).toBe("workspace.suspend");
  });
});
