import { describe, expect, it } from "vitest";
import { diffOf, hashField } from "./redact.js";

describe("diffOf", () => {
  const policy = { copy: ["role", "status", "expiresAt"], hash: ["email"] };

  it("keeps only allowlisted fields that changed", () => {
    const d = diffOf(
      { role: "viewer", status: "active", email: "a@x.io", token: "secret", expiresAt: null },
      { role: "admin", status: "active", email: "a@x.io", token: "other", expiresAt: null },
      policy,
    );
    expect(d).toEqual({ before: { role: "viewer" }, after: { role: "admin" } });
  });

  it("hashes designated fields so equality is provable but the value is not", () => {
    const d = diffOf({ email: "a@x.io" }, { email: "b@x.io" }, policy);
    expect(d?.before["email"]).toBe(hashField("a@x.io"));
    expect(d?.after["email"]).toBe(hashField("b@x.io"));
    expect(String(d?.after["email"])).toMatch(/^sha256:[0-9a-f]{16}$/u);
    expect(JSON.stringify(d)).not.toContain("@x.io");
  });

  it("returns undefined when nothing allowlisted changed", () => {
    expect(diffOf({ role: "a", token: "1" }, { role: "a", token: "2" }, policy)).toBeUndefined();
    expect(diffOf(null, null, policy)).toBeUndefined();
  });

  it("handles creation, deletion, dates and bigints", () => {
    const created = diffOf(undefined, { role: "viewer", expiresAt: new Date(0) }, policy);
    expect(created).toEqual({
      before: {},
      after: { role: "viewer", expiresAt: "1970-01-01T00:00:00.000Z" },
    });
    const deleted = diffOf({ role: "viewer" }, null, policy);
    expect(deleted).toEqual({ before: { role: "viewer" }, after: {} });
    const big = diffOf({ role: 1n }, { role: 2n }, policy);
    expect(big).toEqual({ before: { role: "1" }, after: { role: "2" } });
  });
});
