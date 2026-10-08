import { describe, expect, it } from "vitest";
import { applyServeFlags } from "./serve-flags.js";

describe("applyServeFlags", () => {
  it("overrides ROLES from --roles and leaves the env alone without it", () => {
    const env: NodeJS.ProcessEnv = { ROLES: "api,web,worker" };
    expect(applyServeFlags([], env)).toBeNull();
    expect(env["ROLES"]).toBe("api,web,worker");
    expect(applyServeFlags(["--roles", "worker"], env)).toBeNull();
    expect(env["ROLES"]).toBe("worker");
  });

  it("refuses a missing value instead of swallowing the next flag", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(applyServeFlags(["--roles"], env)).toMatch(/comma-separated/);
    expect(applyServeFlags(["--roles", "--other"], env)).toMatch(/comma-separated/);
    expect(env["ROLES"]).toBeUndefined();
  });
});
