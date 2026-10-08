import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configWarnings, doctorReport } from "./doctor.js";
import { loadConfig, tryLoadConfig } from "./load.js";
import { EXAMPLES, SECRET_KEYS } from "./schema.js";

/*
 * Signup terms and the footer links (E-UP-4). What these pin: the terms version is a bounded
 * integer defaulting to 1, the four links accept only what is safe in an `href` (https, http for
 * localhost, mailto for support), none of them is a secret, and doctor says so when an open
 * signup asks people to accept terms that have no URL.
 */
const minimal = {
  BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
};
const open = {
  ...minimal,
  TENANCY_MODE: "multi",
  CONTROL_PLANE: "on",
  SIGNUP_MODE: "open",
  SIGNUP_DEFAULT_PLAN: "starter",
};
const LINKS = ["TERMS_URL", "PRIVACY_URL", "SUPPORT_URL", "STATUS_URL"] as const;

function problems(env: Record<string, string>): Record<string, string> {
  const r = tryLoadConfig({ env });
  if (r.ok) return {};
  return Object.fromEntries(r.error.issues.map((i) => [i.key, i.message]));
}

describe("SIGNUP_TERMS_VERSION (E-UP-4)", () => {
  it("defaults to 1", () => {
    expect(loadConfig({ env: minimal }).raw.SIGNUP_TERMS_VERSION).toBe(1);
  });

  it("accepts an integer from 1 to 10000", () => {
    expect(loadConfig({ env: { ...minimal, SIGNUP_TERMS_VERSION: "3" } }).raw).toMatchObject({
      SIGNUP_TERMS_VERSION: 3,
    });
    expect(problems({ ...minimal, SIGNUP_TERMS_VERSION: "10000" })).toEqual({});
  });

  it.each(["0", "10001", "1.5", "-1", "v2"])("refuses %s", (value) => {
    expect(problems({ ...minimal, SIGNUP_TERMS_VERSION: value })).toHaveProperty(
      "SIGNUP_TERMS_VERSION",
    );
  });
});

describe("footer links (E-UP-4)", () => {
  it("are unset by default and not secrets", () => {
    const raw = loadConfig({ env: minimal }).raw;
    for (const key of LINKS) {
      expect(raw[key], key).toBeUndefined();
      expect(SECRET_KEYS.has(key), key).toBe(false);
    }
  });

  it("their examples load", () => {
    const env = { ...minimal, ...Object.fromEntries(LINKS.map((k) => [k, EXAMPLES[k] ?? ""])) };
    expect(problems(env)).toEqual({});
  });

  it.each(LINKS)("%s accepts https, and http only for localhost", (key) => {
    for (const ok of [
      "https://www.example.com/terms",
      "https://example.com",
      "http://localhost:5173/terms",
      "http://app.localhost/terms",
      "http://127.0.0.1:3000/x",
    ]) {
      expect(problems({ ...minimal, [key]: ok }), ok).toEqual({});
    }
    for (const bad of [
      "http://example.com/terms",
      "javascript:alert(1)",
      "data:text/html,hi",
      "/terms",
      "example.com/terms",
      "ftp://example.com/terms",
      "https://exa mple.com",
    ]) {
      expect(problems({ ...minimal, [key]: bad }), bad).toHaveProperty(key);
    }
  });

  it.each(LINKS)("%s needs the literal https:// prefix (M3), case-insensitively", (key) => {
    // `new URL()` normalises these, but in an href a browser reads them as relative paths.
    for (const bad of [
      "https:example.com",
      "https:/example.com",
      "https:\\\\example.com",
      "http:localhost/terms",
      "//example.com/terms",
    ]) {
      expect(problems({ ...minimal, [key]: bad }), bad).toHaveProperty(key);
    }
    expect(problems({ ...minimal, [key]: "HTTPS://Example.com/Terms" })).toEqual({});
  });

  it.each(LINKS)("%s is served normalised: what is validated is what is linked", (key) => {
    const raw = loadConfig({
      env: { ...minimal, [key]: "HTTPS://WWW.Example.COM:443/a/../terms" },
    }).raw;
    expect(raw[key]).toBe("https://www.example.com/terms");
    expect(loadConfig({ env: { ...minimal, [key]: "https://example.com" } }).raw[key]).toBe(
      "https://example.com/",
    );
  });

  it.each(LINKS)("%s refuses a user name or password (L4)", (key) => {
    for (const bad of [
      "https://user@example.com/terms",
      "https://user:pass@example.com/terms",
      "https://:pass@example.com/terms",
      "http://user@localhost/terms",
    ]) {
      expect(problems({ ...minimal, [key]: bad }), bad).toHaveProperty(key);
    }
  });

  it("SUPPORT_URL takes a bare mailto: in any case, normalised, with no query (L5)", () => {
    expect(
      loadConfig({ env: { ...minimal, SUPPORT_URL: "MAILTO:help@example.com" } }).raw,
    ).toMatchObject({ SUPPORT_URL: "mailto:help@example.com" });
    for (const bad of [
      "mailto:help@example.com?cc=a@b.c",
      "mailto:help@example.com?body=hi",
      "mailto:help@example.com#x",
      "mailto:?to=help@example.com",
      "mailto:a@b@c",
      "mailto:",
    ]) {
      expect(problems({ ...minimal, SUPPORT_URL: bad }), bad).toHaveProperty("SUPPORT_URL");
    }
  });

  it("SUPPORT_URL alone also accepts a mailto: address", () => {
    expect(problems({ ...minimal, SUPPORT_URL: "mailto:support@example.com" })).toEqual({});
    expect(problems({ ...minimal, SUPPORT_URL: "mailto:nobody" })).toHaveProperty("SUPPORT_URL");
    for (const key of ["TERMS_URL", "PRIVACY_URL", "STATUS_URL"]) {
      expect(problems({ ...minimal, [key]: "mailto:support@example.com" }), key).toHaveProperty(
        key,
      );
    }
  });

  it("doctor shows the values (they are not redacted)", () => {
    const config = loadConfig({ env: { ...minimal, TERMS_URL: "https://example.com/terms" } });
    const row = doctorReport(config, {}).rows.find((r) => r.key === "TERMS_URL");
    expect(row?.value).toBe("https://example.com/terms");
  });
});

describe("doctor: open signup without TERMS_URL (E-UP-4)", () => {
  const terms = (env: Record<string, string>) =>
    configWarnings(loadConfig({ env })).filter((w) => w.key === "TERMS_URL");

  it("warns when SIGNUP_MODE=open and TERMS_URL is unset", () => {
    const [warning, ...rest] = terms({ ...open, SIGNUP_TERMS_VERSION: "2" });
    expect(rest).toEqual([]);
    expect(warning?.message).toMatch(/terms nobody can read/u);
    expect(warning?.message).toContain("platform-terms:v2");
  });

  it("is quiet with TERMS_URL set, or with signup off", () => {
    expect(terms({ ...open, TERMS_URL: "https://example.com/terms" })).toEqual([]);
    expect(terms(minimal)).toEqual([]);
  });
});
