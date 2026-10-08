import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLOUDFLARE_IP_RANGES_FETCHED_AT, configWarnings } from "./doctor.js";
import { tryLoadConfig } from "./load.js";

/* E3.10: `CLOUDFLARE_TRUSTED_PROXY` doctor lines — the vendored ranges' age, and the no-op case. */

const KEY = randomBytes(32).toString("base64");

function config(extra: Record<string, string>) {
  const r = tryLoadConfig({
    env: {
      BASE_URL: "https://portal.example.com",
      DATABASE_URL: "postgres://seedhost:pw@db:5432/seedhost",
      FUNDROOM_SECRET_KEY: KEY,
      ...extra,
    },
  });
  if (!r.ok) throw r.error;
  return r.config;
}

const fetched = Date.parse(`${CLOUDFLARE_IP_RANGES_FETCHED_AT}T00:00:00Z`);
const daysAfter = (d: number) => new Date(fetched + d * 86_400_000);
const cf = (w: readonly { key: string; message: string }[]) =>
  w.filter((x) => x.key === "CLOUDFLARE_TRUSTED_PROXY").map((x) => x.message);

describe("CLOUDFLARE_TRUSTED_PROXY doctor warnings", () => {
  const on = config({ CLOUDFLARE_TRUSTED_PROXY: "on", TRUST_PROXY: "true" });

  it("says nothing while the vendored ranges are under 180 days old", () => {
    expect(cf(configWarnings(on, daysAfter(180)))).toEqual([]);
  });

  it("warns once they are older than 180 days", () => {
    const [message] = cf(configWarnings(on, daysAfter(181)));
    expect(message).toMatch(/181 days old/u);
    expect(message).toContain(CLOUDFLARE_IP_RANGES_FETCHED_AT);
  });

  it("does not warn about the ranges when Cloudflare is not trusted at all", () => {
    expect(cf(configWarnings(config({ TRUST_PROXY: "true" }), daysAfter(400)))).toEqual([]);
  });

  it("warns that it does nothing without TRUST_PROXY", () => {
    const off = config({ CLOUDFLARE_TRUSTED_PROXY: "on" });
    expect(cf(configWarnings(off, daysAfter(1)))).toEqual([
      expect.stringMatching(/no effect without TRUST_PROXY=true/u),
    ]);
  });
});
