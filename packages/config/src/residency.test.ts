import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configWarnings, doctorReport } from "./doctor.js";
import { loadConfig, tryLoadConfig } from "./load.js";
import { SECRET_KEYS } from "./schema.js";

/*
 * Per-tenant data residency configuration (E3.11). What these pin: an install that sets none of
 * the new keys loads exactly as before (no new refusal), the region's label and jurisdiction need
 * the region, the shared directory needs the control plane plus a declared region (and s3 storage
 * in prod-like), its URL is a redacted secret, and doctor prints the declared facts.
 */
const KEY = randomBytes(32).toString("base64");
const minimal = {
  BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  FUNDROOM_SECRET_KEY: KEY,
};
const multi = { ...minimal, TENANCY_MODE: "multi", CONTROL_PLANE: "on" };
const DIR = "postgres://u:secretpw@directory.internal:5432/directory";

function problems(env: Record<string, string>): Record<string, string> {
  const r = tryLoadConfig({ env });
  if (r.ok) return {};
  return Object.fromEntries(r.error.issues.map((i) => [i.key, i.message]));
}

describe("data residency config (E3.11)", () => {
  it("defaults: nothing declared, local directory, no refusal", () => {
    const c = loadConfig({ env: minimal });
    expect(c.raw.DATA_REGION).toBeUndefined();
    expect(c.raw.DATA_REGION_LABEL).toBeUndefined();
    expect(c.raw.DATA_REGION_JURISDICTION).toBeUndefined();
    expect(c.raw.BACKUP_LOCATION).toBeUndefined();
    expect(c.raw.DIRECTORY_DATABASE_URL).toBeUndefined();
    expect(c.raw.DIRECTORY_DATABASE_POOL_MAX).toBe(4);
    expect(c.raw.MOVE_SOURCE_RETENTION_HOURS).toBe(0);
    expect(c.raw.MOVE_MAX_BUNDLE_BYTES).toBe(53_687_091_200);
    expect(loadConfig({ env: multi }).raw.CONTROL_PLANE).toBe("on");
  });

  it("validates the region code and jurisdiction", () => {
    expect(problems({ ...minimal, DATA_REGION: "EU" })).toHaveProperty("DATA_REGION");
    expect(problems({ ...minimal, DATA_REGION: "1eu" })).toHaveProperty("DATA_REGION");
    expect(problems({ ...minimal, DATA_REGION: "eu-central-1" })).toEqual({});
    expect(
      problems({ ...minimal, DATA_REGION: "eu", DATA_REGION_JURISDICTION: "mars" }),
    ).toHaveProperty("DATA_REGION_JURISDICTION");
    expect(
      problems({ ...minimal, DATA_REGION: "eu", DATA_REGION_LABEL: "x".repeat(121) }),
    ).toHaveProperty("DATA_REGION_LABEL");
  });

  it("label and jurisdiction require DATA_REGION", () => {
    expect(problems({ ...minimal, DATA_REGION_LABEL: "Frankfurt" })["DATA_REGION_LABEL"]).toMatch(
      /DATA_REGION/u,
    );
    expect(problems({ ...minimal, DATA_REGION_JURISDICTION: "eu" })).toHaveProperty(
      "DATA_REGION_JURISDICTION",
    );
    expect(
      problems({
        ...minimal,
        DATA_REGION: "eu",
        DATA_REGION_LABEL: "Frankfurt",
        DATA_REGION_JURISDICTION: "eu",
        BACKUP_LOCATION: "Frankfurt",
      }),
    ).toEqual({});
  });

  it("DIRECTORY_DATABASE_URL requires the control plane and a declared region", () => {
    const p = problems({ ...minimal, TENANCY_MODE: "multi", DIRECTORY_DATABASE_URL: DIR });
    expect(p["DIRECTORY_DATABASE_URL"]).toMatch(/CONTROL_PLANE=on/u);
    expect(p).toHaveProperty("DATA_REGION");
    expect(p).toHaveProperty("DATA_REGION_JURISDICTION");
    expect(
      problems({
        ...multi,
        DIRECTORY_DATABASE_URL: DIR,
        DATA_REGION: "eu",
        DATA_REGION_JURISDICTION: "eu",
      }),
    ).toEqual({});
    expect(problems({ ...multi, DIRECTORY_DATABASE_URL: "mysql://x" })).toHaveProperty(
      "DIRECTORY_DATABASE_URL",
    );
  });

  it("in prod-like the directory needs s3 storage", () => {
    const env = {
      ...multi,
      DIRECTORY_DATABASE_URL: DIR,
      DATA_REGION: "eu",
      DATA_REGION_JURISDICTION: "eu",
      APP_ENV: "staging",
      BASE_URL: "https://investors.example.com",
    };
    expect(problems(env)["STORAGE_DRIVER"]).toMatch(/s3/u);
  });

  it("bounds the pool and move limits", () => {
    expect(problems({ ...minimal, DIRECTORY_DATABASE_POOL_MAX: "21" })).toHaveProperty(
      "DIRECTORY_DATABASE_POOL_MAX",
    );
    expect(problems({ ...minimal, MOVE_SOURCE_RETENTION_HOURS: "721" })).toHaveProperty(
      "MOVE_SOURCE_RETENTION_HOURS",
    );
    expect(problems({ ...minimal, MOVE_MAX_BUNDLE_BYTES: "10" })).toHaveProperty(
      "MOVE_MAX_BUNDLE_BYTES",
    );
  });

  it("the directory URL is a redacted secret", () => {
    expect(SECRET_KEYS.has("DIRECTORY_DATABASE_URL")).toBe(true);
    const c = loadConfig({
      env: {
        ...multi,
        DIRECTORY_DATABASE_URL: DIR,
        DATA_REGION: "eu",
        DATA_REGION_JURISDICTION: "eu",
      },
    });
    const row = doctorReport(c, {}).rows.find((r) => r.key === "DIRECTORY_DATABASE_URL");
    expect(row?.value).not.toContain("secretpw");
  });

  it("doctor prints the declared facts and the directory mode", () => {
    const c = loadConfig({
      env: {
        ...multi,
        DATA_REGION: "eu",
        DATA_REGION_LABEL: "European Union (Frankfurt, Germany)",
        DATA_REGION_JURISDICTION: "eu",
        BACKUP_LOCATION: "Frankfurt",
      },
    });
    const derived = Object.fromEntries(doctorReport(c, {}).derived.map((r) => [r.key, r.value]));
    expect(derived["dataResidency"]).toBe(
      "region eu (European Union (Frankfurt, Germany)), jurisdiction eu",
    );
    expect(derived["backupLocation"]).toBe("Frankfurt");
    expect(derived["directory"]).toBe("local");
    expect(configWarnings(c).map((w) => w.key)).not.toContain("DATA_REGION");
  });

  it("doctor warns when the control plane runs without a declared region", () => {
    const keys = configWarnings(loadConfig({ env: multi })).map((w) => w.key);
    expect(keys).toContain("DATA_REGION");
    expect(configWarnings(loadConfig({ env: minimal })).map((w) => w.key)).not.toContain(
      "DATA_REGION",
    );
    const derived = Object.fromEntries(
      doctorReport(loadConfig({ env: minimal }), {}).derived.map((r) => [r.key, r.value]),
    );
    expect(derived["dataResidency"]).toBe("region not declared");
  });
});
