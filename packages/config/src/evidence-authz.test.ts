import { generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { configWarnings, doctorReport } from "./doctor.js";
import { loadConfig, tryLoadConfig } from "./load.js";
import { pemBlocks, type RawEnv, SECRET_KEYS } from "./schema.js";

/*
 * E3.13 configuration: external audit anchoring (AUDIT_ANCHOR_*) and the optional OpenFGA authz
 * engine (AUTHZ_ENGINE / AUTHZ_OPENFGA_*). What these pin: nothing set = both off with no new
 * refusal; each driver's required keys; keys for a driver that is not enabled are refused; the PEM
 * keys load through *_FILE; prod-like endpoints are https unless operator-run; the OpenFGA token is
 * a redacted secret; doctor prints one summary row each with fingerprints, never PEM text.
 */
const KEY = randomBytes(32).toString("base64");
const minimal = {
  BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  FUNDROOM_SECRET_KEY: KEY,
};
const prod = {
  ...minimal,
  APP_ENV: "prod",
  BASE_URL: "https://portal.example.com",
  DATABASE_URL: "postgres://u:p@db:5432/db",
  MAIL_FROM: "ir@example.com",
  SMTP_URL: "smtps://u:p@smtp.example.com:465",
  AV_ACCEPT_UNSCANNED: "true",
};
const CERT = `-----BEGIN CERTIFICATE-----
MIICCjCCAbACCQC39B9IWCSdBjAKBggqhkjOPQQDAjATMREwDwYDVQQDDAh0ZXN0
IHRzYTAeFw0yNjEwMDExNzU5MzRaFw0zNjA5MjgxNzU5MzRaMBMxETAPBgNVBAMM
CHRlc3QgdHNhMIIBSzCCAQMGByqGSM49AgEwgfcCAQEwLAYHKoZIzj0BAQIhAP//
//8AAAABAAAAAAAAAAAAAAAA////////////////MFsEIP////8AAAABAAAAAAAA
AAAAAAAA///////////////8BCBaxjXYqjqT57PrvVV2mIa8ZR0GsMxTsPY7zjw+
J9JgSwMVAMSdNgiG5wSTamZ44ROdJreBn36QBEEEaxfR8uEsQkf4vOblY6RA8ncD
fYEt6zOg9KE5RdiYwpZP40Li/hp/m47n60p8D54WK84zV2sxXs7LtkBoN79R9QIh
AP////8AAAAA//////////+85vqtpxeehPO5ysL8YyVRAgEBA0IABE062T5ANUmN
GjstHapx+ZKSZiQqyp0X23cfEP7O6PQzsglOnMPZpheK6LWsNfmugrIgI6aAqoqs
gxKe1oVpTW4wCgYIKoZIzj0EAwIDSAAwRQIgH7pgscyYTT2C51p4mtRwV2r1dWCJ
8/8kaVWMrOkkwYgCIQC7DHU0x+Qt4KkhlqMy4GP/UG9JNrrVtrZaW2nQUoa7+Q==
-----END CERTIFICATE-----`;
const LOG_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEG002WERbD3uamKYCZ824v5HKLnML
4YU2KhnMrr+58SXfNRt3Cgki7shj2GZjRbAvAwhjo7TkHhh9NGOR4ZRJgw==
-----END PUBLIC KEY-----`;
const rfc3161 = {
  AUDIT_ANCHOR_DRIVERS: "rfc3161",
  AUDIT_ANCHOR_TSA_URLS: "https://timestamp.sigstore.dev/api/v1/timestamp,https://freetsa.org/tsr",
  AUDIT_ANCHOR_TSA_CERTS: CERT,
};
const rekor = {
  AUDIT_ANCHOR_DRIVERS: "rekor",
  AUDIT_ANCHOR_REKOR_URL: "https://log2025-1.rekor.sigstore.dev",
  AUDIT_ANCHOR_REKOR_LOG_KEY: LOG_KEY,
};
const openfga = { AUTHZ_ENGINE: "openfga", AUTHZ_OPENFGA_URL: "http://openfga:8080" };

function problems(env: Record<string, string>): Partial<Record<keyof RawEnv, string>> {
  const r = tryLoadConfig({ env });
  if (r.ok) return {};
  return Object.fromEntries(r.error.issues.map((i) => [i.key, i.message]));
}

function derived(env: Record<string, string>, key: string): string | undefined {
  const c = loadConfig({ env });
  return doctorReport(c, {}).derived.find((r) => r.key === key)?.value;
}

describe("audit anchoring config (E3.13)", () => {
  it("defaults: off, 15 s timeout, no refusal", () => {
    const c = loadConfig({ env: minimal });
    expect(c.raw.AUDIT_ANCHOR_DRIVERS).toEqual([]);
    expect(c.raw.AUDIT_ANCHOR_TIMEOUT_MS).toBe(15_000);
    expect(derived(minimal, "auditAnchoring")).toBe("off");
    expect(problems(prod)).toEqual({});
  });

  it("rfc3161 needs TSA urls and pinned certs", () => {
    const p = problems({ ...minimal, AUDIT_ANCHOR_DRIVERS: "rfc3161" });
    expect(p.AUDIT_ANCHOR_TSA_URLS).toMatch(/required/u);
    expect(p.AUDIT_ANCHOR_TSA_CERTS).toMatch(/required/u);
    expect(problems({ ...minimal, ...rfc3161 })).toEqual({});
  });

  it("rekor needs the shard url and the log key", () => {
    const p = problems({ ...minimal, AUDIT_ANCHOR_DRIVERS: "rekor" });
    expect(p.AUDIT_ANCHOR_REKOR_URL).toMatch(/required/u);
    expect(p.AUDIT_ANCHOR_REKOR_LOG_KEY).toMatch(/required/u);
    expect(problems({ ...minimal, ...rekor })).toEqual({});
    expect(
      problems({ ...minimal, ...rfc3161, ...rekor, AUDIT_ANCHOR_DRIVERS: "rfc3161,rekor" }),
    ).toEqual({});
  });

  it("refuses unknown and repeated drivers", () => {
    expect(problems({ ...minimal, AUDIT_ANCHOR_DRIVERS: "opentimestamps" })).toHaveProperty(
      "AUDIT_ANCHOR_DRIVERS",
    );
    expect(
      problems({ ...minimal, ...rekor, AUDIT_ANCHOR_DRIVERS: "rekor,rekor" }).AUDIT_ANCHOR_DRIVERS,
    ).toMatch(/more than once/u);
  });

  it("refuses a driver's keys when that driver is not enabled", () => {
    const p = problems({
      ...minimal,
      AUDIT_ANCHOR_TSA_URLS: rfc3161.AUDIT_ANCHOR_TSA_URLS,
      AUDIT_ANCHOR_REKOR_URL: rekor.AUDIT_ANCHOR_REKOR_URL,
    });
    expect(p.AUDIT_ANCHOR_TSA_URLS).toMatch(/only applies/u);
    expect(p.AUDIT_ANCHOR_REKOR_URL).toMatch(/only applies/u);
  });

  it("refuses PEM text without the expected blocks", () => {
    expect(problems({ ...minimal, ...rfc3161, AUDIT_ANCHOR_TSA_CERTS: LOG_KEY })).toHaveProperty(
      "AUDIT_ANCHOR_TSA_CERTS",
    );
    expect(problems({ ...minimal, ...rekor, AUDIT_ANCHOR_REKOR_LOG_KEY: CERT })).toHaveProperty(
      "AUDIT_ANCHOR_REKOR_LOG_KEY",
    );
  });

  it("accepts several Rekor log keys (shard rotation), and pins without their driver (FIX1 A9)", () => {
    expect(
      problems({
        ...minimal,
        ...rekor,
        AUDIT_ANCHOR_REKOR_LOG_KEY: `${LOG_KEY}\n${LOG_KEY}`,
        AUDIT_ANCHOR_REKOR_ORIGIN: "a,b",
      }),
    ).toEqual({});
    const pinsOnly = {
      ...minimal,
      AUDIT_ANCHOR_TSA_CERTS: CERT,
      AUDIT_ANCHOR_REKOR_LOG_KEY: `${LOG_KEY}\n${LOG_KEY}`,
      AUDIT_ANCHOR_REKOR_ORIGIN: "a,b",
    };
    expect(problems(pinsOnly)).toEqual({});
    expect(derived(pinsOnly, "auditAnchoring")).toMatch(
      /^off; verification-only pins: rfc3161 1 pinned certificate .*, rekor 2 pinned public key/u,
    );
  });

  it("refuses PEM blocks that do not parse, naming the block (FIX2 A14)", () => {
    const junkKey = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----";
    const junkCert = "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----";
    expect(
      problems({ ...minimal, ...rekor, AUDIT_ANCHOR_REKOR_LOG_KEY: `${LOG_KEY}\n${junkKey}` })
        .AUDIT_ANCHOR_REKOR_LOG_KEY,
    ).toMatch(/block 2 does not parse/u);
    expect(
      problems({ ...minimal, ...rfc3161, AUDIT_ANCHOR_TSA_CERTS: `${junkCert}\n${CERT}` })
        .AUDIT_ANCHOR_TSA_CERTS,
    ).toMatch(/block 1 does not parse/u);
  });

  it("Rekor origins: csv, shown by doctor; only with the driver or its verification-only key (FIX2 A15)", () => {
    const env = {
      ...minimal,
      ...rekor,
      AUDIT_ANCHOR_REKOR_ORIGIN: "log2026-1.example,log2025-1.example",
    };
    expect(problems(env)).toEqual({});
    expect(loadConfig({ env }).raw.AUDIT_ANCHOR_REKOR_ORIGIN).toEqual([
      "log2026-1.example",
      "log2025-1.example",
    ]);
    expect(derived(env, "auditAnchoring")).toMatch(
      /origins log2026-1\.example, log2025-1\.example/u,
    );
    expect(
      problems({ ...minimal, AUDIT_ANCHOR_REKOR_ORIGIN: "x" }).AUDIT_ANCHOR_REKOR_ORIGIN,
    ).toMatch(/only applies/u);
    expect(
      problems({ ...minimal, AUDIT_ANCHOR_REKOR_LOG_KEY: LOG_KEY, AUDIT_ANCHOR_REKOR_ORIGIN: "x" }),
    ).toEqual({});
    expect(
      problems({ ...minimal, ...rekor, AUDIT_ANCHOR_REKOR_ORIGIN: "has space" }),
    ).toHaveProperty("AUDIT_ANCHOR_REKOR_ORIGIN");
  });

  it("refuses a Rekor log key of an unusable type, naming the block (FIX3 L-A)", () => {
    const x25519 = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "pem" });
    expect(
      problems({
        ...minimal,
        ...rekor,
        AUDIT_ANCHOR_REKOR_LOG_KEY: `${LOG_KEY}\n${x25519}`,
        AUDIT_ANCHOR_REKOR_ORIGIN: "a,b",
      }).AUDIT_ANCHOR_REKOR_LOG_KEY,
    ).toMatch(/block 2 is a x25519 key; a Rekor log key must be Ed25519, ECDSA or RSA/u);
  });

  it("requires AUDIT_ANCHOR_REKOR_ORIGIN with several log keys or verification-only keys, and warns when defaulted (FIX3 L-B)", () => {
    expect(
      problems({ ...minimal, ...rekor, AUDIT_ANCHOR_REKOR_LOG_KEY: `${LOG_KEY}\n${LOG_KEY}` })
        .AUDIT_ANCHOR_REKOR_ORIGIN,
    ).toMatch(/pins 2 log keys/u);
    expect(
      problems({ ...minimal, AUDIT_ANCHOR_REKOR_LOG_KEY: LOG_KEY }).AUDIT_ANCHOR_REKOR_ORIGIN,
    ).toMatch(/without the rekor driver/u);
    expect(
      problems({ ...minimal, AUDIT_ANCHOR_REKOR_LOG_KEY: LOG_KEY, AUDIT_ANCHOR_REKOR_ORIGIN: "o" }),
    ).toEqual({});
    expect(problems({ ...minimal, ...rekor })).toEqual({});
    const warned = configWarnings(loadConfig({ env: { ...minimal, ...rekor } }));
    expect(warned.find((w) => w.key === "AUDIT_ANCHOR_REKOR_ORIGIN")?.message).toMatch(
      /pinned to the origin "log2025-1\.rekor\.sigstore\.dev"/u,
    );
    expect(
      configWarnings(
        loadConfig({
          env: { ...minimal, ...rekor, AUDIT_ANCHOR_REKOR_ORIGIN: "log2025-1.rekor.sigstore.dev" },
        }),
      ).some((w) => w.key === "AUDIT_ANCHOR_REKOR_ORIGIN"),
    ).toBe(false);
  });

  it("refuses anchor URLs with credentials, a query or a fragment (FIX1 A10)", () => {
    for (const bad of [
      "https://user:pw@tsa.example.com/tsr",
      "https://tsa.example.com/tsr?token=x",
      "https://tsa.example.com/tsr#x",
    ]) {
      expect(
        problems({ ...minimal, ...rfc3161, AUDIT_ANCHOR_TSA_URLS: bad }).AUDIT_ANCHOR_TSA_URLS,
        bad,
      ).toMatch(/must not carry/u);
      expect(
        problems({ ...minimal, ...rekor, AUDIT_ANCHOR_REKOR_URL: bad.replace("/tsr", "") })
          .AUDIT_ANCHOR_REKOR_URL,
        bad,
      ).toMatch(/must not carry/u);
    }
  });

  it("reads the PEM bundles through *_FILE", () => {
    const files: Record<string, string> = {
      "/s/tsa.pem": `${CERT}\n${CERT}\n`,
      "/s/rekor.pub": LOG_KEY,
    };
    const c = loadConfig({
      env: {
        ...minimal,
        AUDIT_ANCHOR_DRIVERS: "rfc3161,rekor",
        AUDIT_ANCHOR_TSA_URLS: rfc3161.AUDIT_ANCHOR_TSA_URLS,
        AUDIT_ANCHOR_TSA_CERTS_FILE: "/s/tsa.pem",
        AUDIT_ANCHOR_REKOR_URL: rekor.AUDIT_ANCHOR_REKOR_URL,
        AUDIT_ANCHOR_REKOR_LOG_KEY_FILE: "/s/rekor.pub",
      },
      readFile: (path) => files[path] as string,
    });
    expect(pemBlocks(c.raw.AUDIT_ANCHOR_TSA_CERTS as string, "CERTIFICATE")).toHaveLength(2);
    expect(c.raw.AUDIT_ANCHOR_REKOR_LOG_KEY).toBe(LOG_KEY);
  });

  it("prod-like: endpoints are https unless operator-run", () => {
    const plain = {
      ...prod,
      ...rfc3161,
      AUDIT_ANCHOR_TSA_URLS: "http://freetsa.org/tsr",
    };
    expect(problems(plain).AUDIT_ANCHOR_TSA_URLS).toMatch(/https/u);
    expect(problems({ ...plain, AUDIT_ANCHOR_TSA_URLS: "http://tsa.internal/tsr" })).toEqual({});
    expect(problems({ ...plain, APP_ENV: "dev" })).toEqual({});
    expect(
      problems({ ...prod, ...rekor, AUDIT_ANCHOR_REKOR_URL: "http://rekor.example.com" })
        .AUDIT_ANCHOR_REKOR_URL,
    ).toMatch(/https/u);
  });

  it("doctor: one row with hosts and fingerprints, never the PEM", () => {
    const env = { ...minimal, ...rfc3161, ...rekor, AUDIT_ANCHOR_DRIVERS: "rfc3161,rekor" };
    const row = derived(env, "auditAnchoring") as string;
    expect(row).toMatch(
      /^rfc3161 \(TSAs timestamp\.sigstore\.dev, freetsa\.org; 1 pinned certificate \(sha256 [0-9a-f]{16}\)\)/u,
    );
    expect(row).toMatch(
      /rekor \(log2025-1\.rekor\.sigstore\.dev; origins url host; 1 pinned public key \(sha256 [0-9a-f]{16}\)\)/u,
    );
    const report = doctorReport(loadConfig({ env }), {});
    expect(JSON.stringify(report)).not.toContain("BEGIN");
    expect(report.rows.find((r) => r.key === "AUDIT_ANCHOR_TSA_CERTS")?.value).toBe(
      "1 PEM certificate(s)",
    );
  });
});

describe("authz engine config (E3.13)", () => {
  it("defaults: postgres, shadow, sample 1, 1500 ms", () => {
    const c = loadConfig({ env: minimal });
    expect(c.raw.AUTHZ_ENGINE).toBe("postgres");
    expect(c.raw.AUTHZ_OPENFGA_MODE).toBe("shadow");
    expect(c.raw.AUTHZ_OPENFGA_SHADOW_SAMPLE).toBe(1);
    expect(c.raw.AUTHZ_OPENFGA_TIMEOUT_MS).toBe(1500);
    expect(derived(minimal, "authzEngine")).toBe("postgres");
  });

  it("openfga needs a url", () => {
    expect(problems({ ...minimal, AUTHZ_ENGINE: "openfga" }).AUTHZ_OPENFGA_URL).toMatch(
      /required/u,
    );
    expect(problems({ ...minimal, ...openfga })).toEqual({});
  });

  it("refuses OpenFGA keys with the postgres engine", () => {
    const p = problems({
      ...minimal,
      AUTHZ_OPENFGA_URL: "http://openfga:8080",
      AUTHZ_OPENFGA_API_TOKEN: "t",
      AUTHZ_OPENFGA_MODE: "enforce",
    });
    expect(Object.keys(p).sort()).toEqual([
      "AUTHZ_OPENFGA_API_TOKEN",
      "AUTHZ_OPENFGA_MODE",
      "AUTHZ_OPENFGA_URL",
    ]);
  });

  it("validates the sample and timeout ranges", () => {
    expect(problems({ ...minimal, ...openfga, AUTHZ_OPENFGA_SHADOW_SAMPLE: "1.5" })).toHaveProperty(
      "AUTHZ_OPENFGA_SHADOW_SAMPLE",
    );
    expect(problems({ ...minimal, ...openfga, AUTHZ_OPENFGA_TIMEOUT_MS: "50" })).toHaveProperty(
      "AUTHZ_OPENFGA_TIMEOUT_MS",
    );
  });

  it("prod-like: https unless the engine is operator-run", () => {
    const authed = { ...prod, ...openfga, AUTHZ_OPENFGA_API_TOKEN: "k".repeat(24) };
    expect(problems(authed)).toEqual({});
    expect(
      problems({ ...authed, AUTHZ_OPENFGA_URL: "http://fga.example.com" }).AUTHZ_OPENFGA_URL,
    ).toMatch(/https/u);
    expect(problems({ ...authed, AUTHZ_OPENFGA_URL: "https://fga.example.com" })).toEqual({});
  });

  it("prod-like requires the API token; test/dev do not (FIX1 R3-5)", () => {
    expect(problems({ ...prod, ...openfga }).AUTHZ_OPENFGA_API_TOKEN).toMatch(/preshared/u);
    expect(problems({ ...prod, APP_ENV: "staging", ...openfga }).AUTHZ_OPENFGA_API_TOKEN).toMatch(
      /required/u,
    );
    expect(problems({ ...minimal, ...openfga })).toEqual({});
  });

  it("refuses credentials in the engine URL (FIX1 R3-5)", () => {
    expect(
      problems({ ...minimal, ...openfga, AUTHZ_OPENFGA_URL: "https://u:secret@fga.example.com" })
        .AUTHZ_OPENFGA_URL,
    ).toMatch(/credentials/u);
  });

  it("the token is a secret; doctor summarises without it", () => {
    expect(SECRET_KEYS.has("AUTHZ_OPENFGA_API_TOKEN")).toBe(true);
    const env = {
      ...minimal,
      ...openfga,
      AUTHZ_OPENFGA_API_TOKEN: "s3cret-token",
      AUTHZ_OPENFGA_MODE: "enforce",
    };
    expect(derived(env, "authzEngine")).toBe(
      "openfga enforce (openfga:8080, token set, timeout 1500 ms)",
    );
    expect(
      derived({ ...minimal, ...openfga, AUTHZ_OPENFGA_SHADOW_SAMPLE: "0.25" }, "authzEngine"),
    ).toBe("openfga shadow, sample 0.25 (openfga:8080, timeout 1500 ms)");
    expect(JSON.stringify(doctorReport(loadConfig({ env }), {}))).not.toContain("s3cret-token");
  });
});
