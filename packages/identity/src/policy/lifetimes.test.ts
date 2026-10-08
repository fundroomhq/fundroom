import { describe, expect, it } from "vitest";
import {
  DEFAULT_LIFETIMES,
  PLATFORM_BOUNDS,
  requiredAuthLevelFor,
  resolveLifetimes,
} from "./lifetimes.js";

const HOUR = 3600_000;
const DAY = 24 * HOUR;

describe("resolveLifetimes", () => {
  it("returns the §6.3 defaults per population", () => {
    expect(resolveLifetimes("external")).toEqual(DEFAULT_LIFETIMES.external);
    expect(DEFAULT_LIFETIMES.external.idleMs).toBe(24 * HOUR);
    expect(DEFAULT_LIFETIMES.external.absoluteMs).toBe(14 * DAY);
    expect(DEFAULT_LIFETIMES.staff.idleMs).toBe(12 * HOUR);
    expect(DEFAULT_LIFETIMES.operator).toEqual({
      idleMs: HOUR,
      absoluteMs: 12 * HOUR,
      rememberedAbsoluteMs: 12 * HOUR,
      maxConcurrent: 3,
    });
  });

  it("clamps overrides to platform bounds", () => {
    const r = resolveLifetimes("external", {
      idleMs: 365 * DAY,
      absoluteMs: 10,
      rememberedAbsoluteMs: 1,
      maxConcurrent: 999,
    });
    expect(r.idleMs).toBe(PLATFORM_BOUNDS.maxIdleMs);
    expect(r.absoluteMs).toBe(PLATFORM_BOUNDS.minAbsoluteMs);
    // remembered can never be shorter than absolute
    expect(r.rememberedAbsoluteMs).toBe(r.absoluteMs);
    expect(r.maxConcurrent).toBe(PLATFORM_BOUNDS.maxConcurrent);
  });
});

describe("requiredAuthLevelFor", () => {
  it("owners and admins always need MFA; others follow the workspace policy", () => {
    expect(requiredAuthLevelFor("owner")).toBe(2);
    expect(requiredAuthLevelFor("admin")).toBe(2);
    expect(requiredAuthLevelFor("editor")).toBe(1);
    expect(requiredAuthLevelFor("investor")).toBe(1);
    expect(requiredAuthLevelFor("investor", true)).toBe(2);
    expect(requiredAuthLevelFor(undefined)).toBe(1);
  });
});
