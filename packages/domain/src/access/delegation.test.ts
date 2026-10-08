import { describe, expect, it } from "vitest";
import { delegationAdmitsModule } from "./delegation.js";

describe("delegationAdmitsModule (F3: what a delegate's scope admits, by module)", () => {
  it("admits every module for a non-delegate and for scope `all`", () => {
    for (const scope of [null, undefined, "all"])
      for (const m of ["round", "metrics", "updates", "content", "data-room"])
        expect(delegationAdmitsModule(scope, m)).toBe(true);
  });

  it("`data_room` admits the data room only; round and metrics are `all`-only", () => {
    expect(delegationAdmitsModule("data_room", "data-room")).toBe(true);
    for (const m of ["round", "metrics", "updates", "content"])
      expect(delegationAdmitsModule("data_room", m)).toBe(false);
  });

  it("`updates` admits updates and content pages, nothing else", () => {
    expect(delegationAdmitsModule("updates", "updates")).toBe(true);
    expect(delegationAdmitsModule("updates", "content")).toBe(true);
    for (const m of ["round", "metrics", "data-room"])
      expect(delegationAdmitsModule("updates", m)).toBe(false);
  });

  it("refuses an unknown scope (deny-safe)", () => {
    expect(delegationAdmitsModule("everything", "updates")).toBe(false);
  });
});
