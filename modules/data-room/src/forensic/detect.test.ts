import { describe, expect, it } from "vitest";
import { WorkspaceSlots } from "./detect.js";

describe("WorkspaceSlots (FIX2 D9)", () => {
  it("holds one detection per workspace; other workspaces are unaffected", () => {
    const slots = new WorkspaceSlots();
    const a = slots.tryAcquire("ws-a");
    expect(a).toBeDefined();
    expect(slots.tryAcquire("ws-a")).toBeUndefined();
    const b = slots.tryAcquire("ws-b");
    expect(b).toBeDefined();
    a?.();
    a?.(); // idempotent: a double release never frees someone else's slot
    const again = slots.tryAcquire("ws-a");
    expect(again).toBeDefined();
    a?.();
    expect(slots.tryAcquire("ws-a")).toBeUndefined();
    b?.();
    again?.();
  });
});
