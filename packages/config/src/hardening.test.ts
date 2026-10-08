import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { tryLoadConfig } from "./load.js";
import { isPrivateHost } from "./network.js";
import { hstsIncludeSubDomains, metricsEnabled } from "./schema.js";

/* E2.10 wave 1b (ASVS L2 findings F-01, F-07, F-08, F-09, F-11, F-15): the transport and exposure
 * rules config refuses in staging/prod. */

const KEY = randomBytes(32).toString("base64");

/** A prod environment that loads: every rule below starts from here and breaks one thing. */
const prod: Record<string, string> = {
  APP_ENV: "prod",
  BASE_URL: "https://ir.example.com",
  DATABASE_URL: "postgres://u:p@db:5432/seedhost",
  FUNDROOM_SECRET_KEY: KEY,
  MAIL_FROM: "ir@example.com",
  SMTP_URL: "smtps://u:p@smtp.example.com:465",
  AV_ACCEPT_UNSCANNED: "true",
};

function issues(env: Record<string, string | undefined>) {
  const r = tryLoadConfig({ env });
  return r.ok ? [] : r.error.issues;
}
const keysOf = (env: Record<string, string | undefined>) => issues(env).map((i) => i.key);

describe("E2.10 hardening rules", () => {
  it("the baseline prod environment loads", () => {
    expect(issues(prod)).toEqual([]);
  });

  describe("F-01 /metrics", () => {
    it("is off in prod/staging without a token, on with one, on in dev/test", () => {
      const load = (env: Record<string, string>) => {
        const r = tryLoadConfig({ env });
        if (!r.ok) throw r.error;
        return metricsEnabled(r.config.raw);
      };
      expect(load(prod)).toBe(false);
      expect(load({ ...prod, APP_ENV: "staging" })).toBe(false);
      expect(load({ ...prod, METRICS_TOKEN: "t".repeat(24) })).toBe(true);
      expect(load({ ...prod, APP_ENV: "dev" })).toBe(true);
      expect(load({ ...prod, APP_ENV: "test", METRICS_ENABLED: "false" })).toBe(false);
    });
    it("refuses METRICS_ENABLED=true without METRICS_TOKEN in prod/staging", () => {
      expect(keysOf({ ...prod, METRICS_ENABLED: "true" })).toEqual(["METRICS_TOKEN"]);
      expect(keysOf({ ...prod, APP_ENV: "staging", METRICS_ENABLED: "true" })).toEqual([
        "METRICS_TOKEN",
      ]);
      expect(keysOf({ ...prod, METRICS_ENABLED: "true", METRICS_TOKEN: "t".repeat(24) })).toEqual(
        [],
      );
      expect(keysOf({ ...prod, APP_ENV: "dev", METRICS_ENABLED: "true" })).toEqual([]);
    });
  });

  describe("F-07 client address", () => {
    it("defaults to one hop and takes a platform header only behind a trusted proxy", () => {
      const r = tryLoadConfig({ env: { ...prod, TRUST_PROXY: "true" } });
      expect(r.ok && r.config.raw.TRUST_PROXY_HOPS).toBe(1);
      expect(keysOf({ ...prod, TRUST_PROXY: "true", CLIENT_IP_HEADER: "Fly-Client-IP" })).toEqual(
        [],
      );
      expect(keysOf({ ...prod, CLIENT_IP_HEADER: "Fly-Client-IP" })).toEqual(["CLIENT_IP_HEADER"]);
      expect(keysOf({ ...prod, TRUST_PROXY: "true", CLIENT_IP_HEADER: "X-Forwarded-For" })).toEqual(
        ["CLIENT_IP_HEADER"],
      );
      expect(keysOf({ ...prod, TRUST_PROXY: "true", CLIENT_IP_HEADER: "a b" })).toEqual([
        "CLIENT_IP_HEADER",
      ]);
      expect(keysOf({ ...prod, TRUST_PROXY_HOPS: "0" })).toEqual(["TRUST_PROXY_HOPS"]);
    });
  });

  describe("F-08 SMTP transport", () => {
    it.each([
      ["smtps://u:p@smtp.example.com:465", true],
      ["smtp://u:p@smtp.example.com:587?requireTLS=true", true],
      ["smtp://u:p@smtp.example.com:587", false],
      ["smtp://u:p@smtp.example.com:587?requireTLS=false", false],
      ["smtp://u:p@smtp.example.com:587?requireTLS=true&ignoreTLS=true", false],
      ["smtps://u:p@smtp.example.com:465?tls.rejectUnauthorized=false", false],
      // A relay on the private network may be plain SMTP, but never unverified TLS.
      ["smtp://postfix:25", true],
      ["smtp://10.0.0.25:25", true],
      ["smtp://mail.internal:25?tls.rejectUnauthorized=false", false],
    ])("prod %s → accepted=%s", (url, accepted) => {
      expect(keysOf({ ...prod, SMTP_URL: url })).toEqual(accepted ? [] : ["SMTP_URL"]);
    });
    it("is not enforced in dev/test (Mailpit)", () => {
      expect(keysOf({ ...prod, APP_ENV: "dev", SMTP_URL: "smtp://mail.example.com:25" })).toEqual(
        [],
      );
    });
  });

  describe("F-09 database transport", () => {
    it.each([
      ["postgres://u:p@db:5432/x", true],
      ["postgres://u:p@10.1.2.3:5432/x", true],
      ["postgres://u:p@postgres.railway.internal:5432/x", true],
      ["postgres://u:p@seed-db-rw.seed.svc.cluster.local:5432/x", true],
      ["postgres://u:p@pgbouncer.abc.flympg.net/x", true],
      ["postgres://u:p@db.example.com:5432/x?sslmode=verify-full", true],
      ["postgres://u:p@db.example.com:5432/x?sslmode=verify-ca&sslrootcert=/ca.pem", true],
      ["postgres://u:p@db.example.com:5432/x", false],
      ["postgres://u:p@db.example.com:5432/x?sslmode=require", false],
      ["postgres://u:p@db.example.com:5432/x?sslmode=no-verify", false],
      ["postgres://u:p@203.0.113.5:5432/x?sslmode=prefer", false],
    ])("prod %s → accepted=%s", (url, accepted) => {
      expect(keysOf({ ...prod, DATABASE_URL: url })).toEqual(accepted ? [] : ["DATABASE_URL"]);
    });
    it("has an explicit escape hatch, and dev/test are not enforced", () => {
      const pub = "postgres://u:p@db.example.com:5432/x?sslmode=require";
      expect(
        keysOf({ ...prod, DATABASE_URL: pub, DATABASE_ACCEPT_UNVERIFIED_TLS: "true" }),
      ).toEqual([]);
      expect(keysOf({ ...prod, APP_ENV: "test", DATABASE_URL: pub })).toEqual([]);
    });
  });

  describe("F-11 virus scanning", () => {
    it("prod/staging need clamd or an explicit AV_ACCEPT_UNSCANNED", () => {
      const noAck = { ...prod, AV_ACCEPT_UNSCANNED: undefined };
      expect(keysOf(noAck)).toEqual(["AV_DRIVER"]);
      expect(keysOf({ ...noAck, APP_ENV: "staging" })).toEqual(["AV_DRIVER"]);
      expect(keysOf({ ...noAck, AV_DRIVER: "clamd", CLAMD_HOST: "clamav" })).toEqual([]);
      expect(keysOf({ ...noAck, APP_ENV: "dev" })).toEqual([]);
    });
  });

  describe("F-15 HSTS includeSubDomains", () => {
    const eff = (env: Record<string, string>) => {
      const r = tryLoadConfig({ env: { ...prod, ...env } });
      if (!r.ok) throw r.error;
      return hstsIncludeSubDomains(r.config.raw);
    };
    it("defaults on for a host-mounted install, off when path-mounted", () => {
      expect(eff({})).toBe(true);
      expect(eff({ BASE_URL: "https://acme.com/investors", BASE_PATH: "/investors" })).toBe(false);
      expect(eff({ HSTS_INCLUDE_SUBDOMAINS: "false" })).toBe(false);
    });
    it("E3.9 FR2: defaults off when served under a path (BASE_PATH or a BASE_URL path)", () => {
      expect(
        eff({ BASE_URL: "https://acme.com/investors", PATH_MOUNTS: "https://acme.com/investors" }),
      ).toBe(false);
      expect(eff({ BASE_URL: "https://portal.acme.com/" })).toBe(true);
      // PATH_MOUNTS alone: the portal's host is still its own (mounted responses omit HSTS).
      expect(eff({ PATH_MOUNTS: "https://acme.com/investors" })).toBe(true);
    });
    it("E3.9 FR2: refuses includeSubDomains / preload only when the install owns no host", () => {
      const pathOnly = {
        BASE_URL: "https://acme.com/investors",
        PATH_MOUNTS: "https://acme.com/investors",
      };
      expect(keysOf({ ...prod, ...pathOnly, HSTS_INCLUDE_SUBDOMAINS: "true" })).toEqual([
        "HSTS_INCLUDE_SUBDOMAINS",
      ]);
      expect(keysOf({ ...prod, ...pathOnly, HSTS_PRELOAD: "true" })).toEqual(["HSTS_PRELOAD"]);
      const mountsOnly = { PATH_MOUNTS: "https://acme.com/investors" };
      expect(keysOf({ ...prod, ...mountsOnly, HSTS_INCLUDE_SUBDOMAINS: "true" })).toEqual([]);
      expect(keysOf({ ...prod, ...mountsOnly, HSTS_PRELOAD: "true" })).toEqual([]);
      expect(keysOf({ ...prod, HSTS_INCLUDE_SUBDOMAINS: "true" })).toEqual([]);
    });
    it("refuses the contradictions", () => {
      expect(keysOf({ ...prod, HSTS_PRELOAD: "true", HSTS_INCLUDE_SUBDOMAINS: "false" })).toEqual([
        "HSTS_INCLUDE_SUBDOMAINS",
      ]);
      expect(
        keysOf({
          ...prod,
          BASE_URL: "https://acme.com/investors",
          BASE_PATH: "/investors",
          HSTS_INCLUDE_SUBDOMAINS: "true",
        }),
      ).toEqual(["HSTS_INCLUDE_SUBDOMAINS"]);
    });
  });
});

describe("RL-1 RATE_LIMIT_MULTIPLIER", () => {
  it("needs APP_ENV set explicitly to a non-production value", () => {
    const x = { ...prod, RATE_LIMIT_MULTIPLIER: "50" };
    expect(keysOf(x)).toEqual(["RATE_LIMIT_MULTIPLIER"]);
    expect(keysOf({ ...x, APP_ENV: undefined })).toEqual(["RATE_LIMIT_MULTIPLIER"]);
    for (const appEnv of ["dev", "test", "staging"]) {
      expect(keysOf({ ...x, APP_ENV: appEnv, SMTP_URL: "smtps://u:p@smtp.example.com" })).toEqual(
        [],
      );
    }
    expect(keysOf({ ...prod, APP_ENV: undefined })).toEqual([]);
  });
});

describe("F-04 OIDC MFA keys (for WP-G)", () => {
  it("parse, default off, and need a provider", () => {
    const oidc = { OIDC_ISSUER_URL: "https://idp.example.com", OIDC_CLIENT_ID: "c" };
    const r = tryLoadConfig({ env: { ...prod, ...oidc, OIDC_MFA_ACR: "mfa, urn:acme:loa:2" } });
    expect(r.ok && r.config.raw.OIDC_TRUST_MFA).toBe(false);
    expect(r.ok && r.config.raw.OIDC_MFA_ACR).toEqual(["mfa", "urn:acme:loa:2"]);
    expect(keysOf({ ...prod, OIDC_TRUST_MFA: "true" })).toEqual(["OIDC_TRUST_MFA"]);
    expect(keysOf({ ...prod, OIDC_MFA_ACR: "mfa" })).toEqual(["OIDC_MFA_ACR"]);
  });
});

describe("isPrivateHost", () => {
  it.each([
    ["localhost", true],
    ["", true],
    ["db", true],
    ["127.0.0.1", true],
    ["10.0.0.1", true],
    ["172.16.0.1", true],
    ["172.31.255.255", true],
    ["192.168.1.1", true],
    ["100.64.0.1", true],
    ["[::1]", true],
    ["[fd00::1]", true],
    ["[fe80::1]", true],
    ["[::ffff:10.0.0.1]", true],
    ["postgres.railway.internal", true],
    ["app.flycast", true],
    ["svc.ns.svc.cluster.local", true],
    ["172.32.0.1", false],
    ["8.8.8.8", false],
    ["[2001:db8::1]", false],
    ["[::ffff:8.8.8.8]", false],
    ["db.example.com", false],
    ["internal.example.com", false],
    ["999.1.1.1", false],
    ["10.0.0.1.nip.io", false],
    ["0x0a000001", false],
    ["2130706433", false],
    ["010.0.0.1", false],
    ["10.0.0.01", false],
  ])("%s → %s", (host, expected) => {
    expect(isPrivateHost(host)).toBe(expected);
  });
});
