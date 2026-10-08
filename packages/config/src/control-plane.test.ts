import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configWarnings, doctorReport } from "./doctor.js";
import { loadConfig, tryLoadConfig } from "./load.js";
import { parseCidr, SECRET_KEYS } from "./schema.js";

/*
 * The managed-host control plane's configuration (E3.10, ADR-0058). What these pin: a self-host
 * with default config is untouched (everything `off`/`none`), every control-plane feature refuses
 * to run without CONTROL_PLANE=on (which refuses to run without TENANCY_MODE=multi), the vendor
 * test seams cannot be repointed in production, and the vendor secrets are redacted.
 */
const KEY = randomBytes(32).toString("base64");
const minimal = {
  BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  FUNDROOM_SECRET_KEY: KEY,
};
const multi = { ...minimal, TENANCY_MODE: "multi", CONTROL_PLANE: "on" };

function problems(env: Record<string, string>): Record<string, string> {
  const r = tryLoadConfig({ env });
  if (r.ok) return {};
  return Object.fromEntries(r.error.issues.map((i) => [i.key, i.message]));
}

describe("control plane config (E3.10)", () => {
  it("defaults to everything off", () => {
    const c = loadConfig({ env: minimal });
    expect(c.raw.CONTROL_PLANE).toBe("off");
    expect(c.raw.CELL_ID).toBe("default");
    expect(c.raw.PLATFORM_OPERATOR_CIDRS).toBeUndefined();
    expect(c.raw.SIGNUP_MODE).toBe("off");
    expect(c.raw.BILLING_DRIVER).toBe("none");
    expect(c.raw.BILLING_GRACE_DAYS).toBe(14);
    expect(c.raw.SANCTIONS_DRIVER).toBe("none");
    expect(c.raw.SANCTIONS_MATCH_THRESHOLD).toBe(0.88);
    expect(c.raw.SANCTIONS_OFAC_URL).toBe(
      "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/",
    );
    expect(c.raw.STRIPE_API_BASE).toBe("https://api.stripe.com");
    expect(c.raw.CLOUDFLARE_API_BASE).toBe("https://api.cloudflare.com/client/v4");
    expect(c.raw.CLOUDFLARE_TRUSTED_PROXY).toBe("off");
    expect(c.raw.CENTRAL_AUTH).toBe("off");
    expect(c.raw.CUSTOM_DOMAIN_DRIVER).toBe("caddy-ask");
  });

  it("CONTROL_PLANE=on requires TENANCY_MODE=multi", () => {
    expect(problems({ ...minimal, CONTROL_PLANE: "on" })["CONTROL_PLANE"]).toMatch(
      /TENANCY_MODE=multi/u,
    );
    expect(loadConfig({ env: multi }).raw.CONTROL_PLANE).toBe("on");
  });

  it("every control-plane feature requires CONTROL_PLANE=on", () => {
    const off = { ...minimal, TENANCY_MODE: "multi" };
    expect(
      problems({ ...off, SIGNUP_MODE: "open", SIGNUP_DEFAULT_PLAN: "starter" }),
    ).toHaveProperty("SIGNUP_MODE");
    expect(problems({ ...off, BILLING_DRIVER: "manual" })).toHaveProperty("BILLING_DRIVER");
    expect(problems({ ...off, SANCTIONS_DRIVER: "ofac" })).toHaveProperty("SANCTIONS_DRIVER");
    // Central auth and the Cloudflare driver are not control-plane features.
    expect(problems({ ...minimal, CENTRAL_AUTH: "on" })).toEqual({});
  });

  it("SIGNUP_MODE=open requires a default plan id", () => {
    expect(problems({ ...multi, SIGNUP_MODE: "open" })).toHaveProperty("SIGNUP_DEFAULT_PLAN");
    expect(problems({ ...multi, SIGNUP_MODE: "open", SIGNUP_DEFAULT_PLAN: "starter" })).toEqual({});
    expect(problems({ ...multi, SIGNUP_DEFAULT_PLAN: "Not A Plan" })).toHaveProperty(
      "SIGNUP_DEFAULT_PLAN",
    );
  });

  it("stripe needs both secrets, each with the right prefix", () => {
    const stripe = { ...multi, BILLING_DRIVER: "stripe" };
    expect(Object.keys(problems(stripe)).sort()).toEqual([
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ]);
    expect(
      problems({ ...stripe, STRIPE_SECRET_KEY: "pk_live_abc", STRIPE_WEBHOOK_SECRET: "whsec_x" }),
    ).toHaveProperty("STRIPE_SECRET_KEY");
    expect(
      problems({ ...stripe, STRIPE_SECRET_KEY: "sk_test_abc", STRIPE_WEBHOOK_SECRET: "wh_x" }),
    ).toHaveProperty("STRIPE_WEBHOOK_SECRET");
    expect(
      problems({ ...stripe, STRIPE_SECRET_KEY: "rk_live_abc", STRIPE_WEBHOOK_SECRET: "whsec_x1" }),
    ).toEqual({});
  });

  it("opensanctions needs a URL; the threshold is bounded", () => {
    expect(problems({ ...multi, SANCTIONS_DRIVER: "opensanctions" })).toHaveProperty(
      "SANCTIONS_OPENSANCTIONS_URL",
    );
    expect(problems({ ...multi, SANCTIONS_MATCH_THRESHOLD: "0.4" })).toHaveProperty(
      "SANCTIONS_MATCH_THRESHOLD",
    );
    expect(problems({ ...multi, BILLING_GRACE_DAYS: "61" })).toHaveProperty("BILLING_GRACE_DAYS");
  });

  it("cloudflare-saas needs a token and a zone id", () => {
    const cf = { ...minimal, CUSTOM_DOMAIN_DRIVER: "cloudflare-saas" };
    expect(Object.keys(problems(cf)).sort()).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ZONE_ID",
    ]);
    expect(
      problems({
        ...cf,
        CLOUDFLARE_API_TOKEN: "tok",
        CLOUDFLARE_ZONE_ID: "023e105f4ecef8ad9ca31a8372d0c353",
      }),
    ).toEqual({});
  });

  it("refuses a repointed vendor API base in production only", () => {
    const prod = {
      ...minimal,
      APP_ENV: "prod",
      BASE_URL: "https://portal.example.com",
      DATABASE_URL: "postgres://u:p@db:5432/db",
      MAIL_FROM: "ir@example.com",
      SMTP_URL: "smtps://u:p@smtp.example.com:465",
      AV_ACCEPT_UNSCANNED: "true",
    };
    expect(problems(prod)).toEqual({});
    expect(problems({ ...prod, STRIPE_API_BASE: "http://127.0.0.1:9999" })).toHaveProperty(
      "STRIPE_API_BASE",
    );
    expect(problems({ ...prod, CLOUDFLARE_API_BASE: "http://127.0.0.1:9999" })).toHaveProperty(
      "CLOUDFLARE_API_BASE",
    );
    expect(problems({ ...minimal, STRIPE_API_BASE: "http://127.0.0.1:9999" })).toEqual({});
  });

  it("SANCTIONS_OFAC_URL must be https in staging and prod", () => {
    const staging = {
      ...minimal,
      APP_ENV: "staging",
      BASE_URL: "https://portal.example.com",
      DATABASE_URL: "postgres://u:p@db:5432/db",
      MAIL_FROM: "ir@example.com",
      SMTP_URL: "smtps://u:p@smtp.example.com:465",
      AV_ACCEPT_UNSCANNED: "true",
    };
    expect(problems(staging)).toEqual({});
    expect(
      problems({ ...staging, SANCTIONS_OFAC_URL: "http://ofac.example/exports/" }),
    ).toHaveProperty("SANCTIONS_OFAC_URL");
    expect(
      problems({ ...staging, APP_ENV: "prod", SANCTIONS_OFAC_URL: "http://o.example/" }),
    ).toHaveProperty("SANCTIONS_OFAC_URL");
    expect(problems({ ...minimal, SANCTIONS_OFAC_URL: "http://127.0.0.1:9/" })).toEqual({});
  });

  it("the OpenSanctions API key goes only to the hosted API or a host named for it", () => {
    const os = {
      ...multi,
      SANCTIONS_DRIVER: "opensanctions",
      SANCTIONS_OPENSANCTIONS_API_KEY: "k",
    };
    expect(
      problems({ ...os, SANCTIONS_OPENSANCTIONS_URL: "https://api.opensanctions.org" }),
    ).toEqual({});
    expect(
      problems({ ...os, SANCTIONS_OPENSANCTIONS_URL: "http://yente.internal:8000" }),
    ).toHaveProperty("SANCTIONS_OPENSANCTIONS_API_KEY");
    expect(
      problems({
        ...os,
        SANCTIONS_OPENSANCTIONS_URL: "https://proxy.internal",
        SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS: "proxy.internal",
      }),
    ).toEqual({});
    // A key, or the hosted API, over plain http is refused (RR2-5).
    expect(
      problems({
        ...os,
        SANCTIONS_OPENSANCTIONS_URL: "http://proxy.internal",
        SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS: "proxy.internal",
      }),
    ).toHaveProperty("SANCTIONS_OPENSANCTIONS_URL");
    const { SANCTIONS_OPENSANCTIONS_API_KEY: _key, ...noKey } = os;
    expect(
      problems({ ...noKey, SANCTIONS_OPENSANCTIONS_URL: "http://api.opensanctions.org" }),
    ).toHaveProperty("SANCTIONS_OPENSANCTIONS_URL");
    // No key: any yente is fine.
    const { SANCTIONS_OPENSANCTIONS_API_KEY: _k, ...keyless } = os;
    expect(
      problems({ ...keyless, SANCTIONS_OPENSANCTIONS_URL: "http://yente.internal:8000" }),
    ).toEqual({});
  });

  it("CELL_ID and PLATFORM_OPERATOR_CIDRS are validated", () => {
    expect(problems({ ...minimal, CELL_ID: "EU_1" })).toHaveProperty("CELL_ID");
    expect(problems({ ...minimal, PLATFORM_OPERATOR_CIDRS: "10.0.0.0/33" })).toHaveProperty(
      "PLATFORM_OPERATOR_CIDRS",
    );
    expect(
      loadConfig({ env: { ...minimal, PLATFORM_OPERATOR_CIDRS: "203.0.113.0/24, 2001:db8::/48" } })
        .raw.PLATFORM_OPERATOR_CIDRS,
    ).toEqual(["203.0.113.0/24", "2001:db8::/48"]);
  });

  it("parseCidr reads addresses and prefixes", () => {
    expect(parseCidr("198.51.100.7")).toEqual({
      address: "198.51.100.7",
      prefix: 32,
      family: "ipv4",
    });
    expect(parseCidr("2001:db8::/32")).toEqual({
      address: "2001:db8::",
      prefix: 32,
      family: "ipv6",
    });
    expect(parseCidr("10.0.0.0/8/1")).toBeUndefined();
    expect(parseCidr("example.com/8")).toBeUndefined();
    expect(parseCidr("::/129")).toBeUndefined();
  });

  it("redacts the vendor secrets", () => {
    for (const k of [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "SANCTIONS_OPENSANCTIONS_API_KEY",
      "CLOUDFLARE_API_TOKEN",
    ]) {
      expect(SECRET_KEYS.has(k), k).toBe(true);
    }
    const r = tryLoadConfig({
      env: {
        ...multi,
        BILLING_DRIVER: "stripe",
        STRIPE_SECRET_KEY: "sk_live_supersecret",
        STRIPE_WEBHOOK_SECRET: "whsec_supersecret",
      },
    });
    if (!r.ok) throw r.error;
    const report = doctorReport(r.config, r.sources);
    expect(JSON.stringify(report)).not.toContain("supersecret");
    expect(report.derived.find((d) => d.key === "controlPlane")?.value).toBe(
      "on (cell default, billing stripe, sanctions none, signup off)",
    );
  });

  it("doctor warns about an unscreened production control plane and the OpenSanctions licence", () => {
    const prod = {
      ...multi,
      APP_ENV: "prod",
      BASE_URL: "https://portal.example.com",
      DATABASE_URL: "postgres://u:p@db:5432/db",
      MAIL_FROM: "ir@example.com",
      SMTP_URL: "smtps://u:p@smtp.example.com:465",
      AV_ACCEPT_UNSCANNED: "true",
    };
    const unscreened = tryLoadConfig({ env: prod });
    if (!unscreened.ok) throw unscreened.error;
    expect(configWarnings(unscreened.config).map((w) => w.key)).toContain("SANCTIONS_DRIVER");
    const screened = tryLoadConfig({ env: { ...prod, SANCTIONS_DRIVER: "ofac" } });
    if (!screened.ok) throw screened.error;
    expect(configWarnings(screened.config).map((w) => w.key)).not.toContain("SANCTIONS_DRIVER");
    const os = tryLoadConfig({
      env: {
        ...prod,
        SANCTIONS_DRIVER: "opensanctions",
        SANCTIONS_OPENSANCTIONS_URL: "https://api.opensanctions.org",
      },
    });
    if (!os.ok) throw os.error;
    expect(configWarnings(os.config).find((w) => w.key === "SANCTIONS_DRIVER")?.message).toMatch(
      /commercial data licence/u,
    );
  });
});
