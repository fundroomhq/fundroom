import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConfigError } from "./errors.js";
import { loadConfig, tryLoadConfig } from "./load.js";
import { SECRET_KEYS } from "./schema.js";

const KEY = randomBytes(32).toString("base64");
const KEY2 = randomBytes(32).toString("base64");

const minimal = {
  BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  FUNDROOM_SECRET_KEY: KEY,
};

function issuesOf(env: Record<string, string | undefined>, readFile?: (p: string) => string) {
  const r = tryLoadConfig({ env, ...(readFile ? { readFile } : {}) });
  if (r.ok) throw new Error("expected failure");
  return r.error.issues;
}

describe("loadConfig", () => {
  it("applies defaults for a minimal dev environment", () => {
    const c = loadConfig({ env: minimal });
    expect(c.appEnv).toBe("dev");
    expect(c.isProduction).toBe(false);
    expect(c.baseUrl.origin).toBe("http://localhost:3000");
    expect(c.basePath).toBe("");
    expect([...c.roles].sort()).toEqual(["api", "web", "worker"]);
    expect(c.modules).toBeUndefined();
    expect(c.keyRing.current.id).toBe("v1");
    expect(c.raw.PORT).toBe(3000);
    expect(c.raw.ROBOTS).toBe("noindex");
    expect(c.raw.MIGRATE_ON_START).toBe(true);
    expect(c.raw.TENANCY_MODE).toBe("single");
    expect(c.raw.DATABASE_STATEMENT_TIMEOUT_MS).toBe(30_000);
    expect(c.raw.STORAGE_DRIVER).toBe("fs");
  });

  it("collects every problem in one ConfigError with actionable text", () => {
    let err: unknown;
    try {
      loadConfig({ env: { PORT: "99999", APP_ENV: "moon" } });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const ce = err as ConfigError;
    const keys = ce.issues.map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(["BASE_URL", "DATABASE_URL", "PORT", "APP_ENV"]));
    expect(ce.message).toContain("Invalid configuration (4 problems):");
    expect(ce.message).toContain(
      "DATABASE_URL: required. Example: postgres://seedhost:secret@db:5432/seedhost",
    );
    expect(ce.message).toContain("NAME_FILE=/run/secrets/name");
  });

  it("requires exactly one of FUNDROOM_SECRET_KEY / SECRET_KEY_RING", () => {
    const none = issuesOf({ ...minimal, FUNDROOM_SECRET_KEY: undefined });
    expect(none).toEqual([
      expect.objectContaining({
        key: "FUNDROOM_SECRET_KEY",
        message: expect.stringMatching(/^required \(or SECRET_KEY_RING/u),
      }),
    ]);

    const both = issuesOf({ ...minimal, SECRET_KEY_RING: `v2:${KEY2}` });
    expect(both.map((i) => i.key)).toEqual(["SECRET_KEY_RING"]);
  });

  describe("SEEDHOST_SECRET_KEY, the master key's old name (A-2)", () => {
    const { FUNDROOM_SECRET_KEY: _, ...withoutKey } = minimal;

    it("is read when FUNDROOM_SECRET_KEY is unset, gives the same key ring, and is recorded", () => {
      const viaNew = loadConfig({ env: minimal });
      const viaOld = loadConfig({ env: { ...withoutKey, SEEDHOST_SECRET_KEY: KEY } });
      expect(viaOld.keyRing.current.fingerprint).toBe(viaNew.keyRing.current.fingerprint);
      expect(viaOld.raw.FUNDROOM_SECRET_KEY).toBe(KEY);
      expect(viaOld.legacyEnv).toEqual([
        { key: "FUNDROOM_SECRET_KEY", legacy: "SEEDHOST_SECRET_KEY" },
      ]);
      expect(viaNew.legacyEnv).toEqual([]);
    });

    it("is read through SEEDHOST_SECRET_KEY_FILE too", () => {
      const r = tryLoadConfig({
        env: { ...withoutKey, SEEDHOST_SECRET_KEY_FILE: "/data/secret.key" },
        readFile: (p) => (p === "/data/secret.key" ? `${KEY}\n` : ""),
      });
      if (!r.ok) throw r.error;
      expect(r.config.keyRing.current.fingerprint).toBe(
        loadConfig({ env: minimal }).keyRing.current.fingerprint,
      );
      expect(r.sources["FUNDROOM_SECRET_KEY"]).toBe("file");
      expect(r.config.legacyEnv).toEqual([
        { key: "FUNDROOM_SECRET_KEY", legacy: "SEEDHOST_SECRET_KEY_FILE" },
      ]);
    });

    it("set together with FUNDROOM_SECRET_KEY to a different value refuses to start, naming both with doctor's fingerprints only", () => {
      const issues = issuesOf({ ...minimal, SEEDHOST_SECRET_KEY: KEY2 });
      expect(issues).toHaveLength(1);
      const message = issues[0]?.message ?? "";
      expect(issues[0]?.key).toBe("FUNDROOM_SECRET_KEY");
      // The same fingerprints `doctor` / the boot log print for each key's ring (v1 (sha256:…)).
      const viaNew = loadConfig({ env: minimal }).keyRing.current.fingerprint;
      const viaOld = loadConfig({ env: { ...minimal, FUNDROOM_SECRET_KEY: KEY2 } }).keyRing.current
        .fingerprint;
      expect(message).toContain(
        `FUNDROOM_SECRET_KEY (key ${viaNew}) and SEEDHOST_SECRET_KEY (key ${viaOld})`,
      );
      expect(message).toContain("SEEDHOST_SECRET_KEY normally holds the key");
      expect(message).not.toContain(KEY);
      expect(message).not.toContain(KEY2);
      const error = tryLoadConfig({ env: { ...minimal, SEEDHOST_SECRET_KEY: KEY2 } });
      expect(error.ok).toBe(false);
      if (!error.ok) {
        expect(error.error.message).not.toContain(KEY);
        expect(error.error.message).not.toContain(KEY2);
      }
    });

    it("set as a file together with the new name to a different value refuses, fingerprinting the file's key", () => {
      const issues = issuesOf(
        { ...minimal, SEEDHOST_SECRET_KEY_FILE: "/data/secret.key" },
        () => `${KEY2}\n`,
      );
      expect(issues.map((i) => i.key)).toEqual(["FUNDROOM_SECRET_KEY"]);
      expect(issues[0]?.message).toContain(
        "SEEDHOST_SECRET_KEY_FILE (/data/secret.key, key sha256:",
      );
      expect(issues[0]?.message).not.toContain(KEY);
      expect(issues[0]?.message).not.toContain(KEY2);
    });

    it("set together with FUNDROOM_SECRET_KEY to the same value is accepted (templates set both for one minor) and recorded", () => {
      const both = loadConfig({ env: { ...minimal, SEEDHOST_SECRET_KEY: KEY } });
      expect(both.keyRing.current.fingerprint).toBe(
        loadConfig({ env: minimal }).keyRing.current.fingerprint,
      );
      expect(both.legacyEnv).toEqual([
        {
          key: "FUNDROOM_SECRET_KEY",
          legacy: "SEEDHOST_SECRET_KEY",
          sameAs: "FUNDROOM_SECRET_KEY",
        },
      ]);
      // A mounted file with a trailing newline is the same value as the plain variable.
      const r = tryLoadConfig({
        env: { ...minimal, SEEDHOST_SECRET_KEY_FILE: "/data/secret.key" },
        readFile: () => `${KEY}\n`,
      });
      if (!r.ok) throw r.error;
      expect(r.sources["FUNDROOM_SECRET_KEY"]).toBe("env");
      expect(r.config.legacyEnv).toEqual([
        {
          key: "FUNDROOM_SECRET_KEY",
          legacy: "SEEDHOST_SECRET_KEY_FILE",
          sameAs: "FUNDROOM_SECRET_KEY",
        },
      ]);
    });

    it("with SECRET_KEY_RING, the error names the variable actually set", () => {
      const { FUNDROOM_SECRET_KEY: _k, ...base } = minimal;
      const ring = `v2:${KEY2}`;
      expect(issuesOf({ ...base, SECRET_KEY_RING: ring, SEEDHOST_SECRET_KEY: KEY })).toEqual([
        expect.objectContaining({
          key: "SECRET_KEY_RING",
          message: expect.stringMatching(/^set together with SEEDHOST_SECRET_KEY;/u),
        }),
      ]);
      expect(
        issuesOf({ ...base, SECRET_KEY_RING: ring, FUNDROOM_SECRET_KEY_FILE: "/k" }, () => KEY)[0]
          ?.message,
      ).toMatch(/^set together with FUNDROOM_SECRET_KEY_FILE;/u);
      expect(
        issuesOf({
          ...base,
          SECRET_KEY_RING: ring,
          FUNDROOM_SECRET_KEY: KEY,
          SEEDHOST_SECRET_KEY: KEY,
        })[0]?.message,
      ).toMatch(/^set together with FUNDROOM_SECRET_KEY and SEEDHOST_SECRET_KEY;/u);
      expect(issuesOf({ ...minimal, SECRET_KEY_RING: ring })[0]?.message).toMatch(
        /^set together with FUNDROOM_SECRET_KEY;/u,
      );
    });
  });

  it("builds the key ring from SECRET_KEY_RING, newest first", () => {
    const c = loadConfig({
      env: { ...minimal, FUNDROOM_SECRET_KEY: undefined, SECRET_KEY_RING: `v2:${KEY2},v1:${KEY}` },
    });
    expect(c.keyRing.current.id).toBe("v2");
    expect(c.keyRing.get("v1")?.key).toEqual(Uint8Array.from(Buffer.from(KEY, "base64")));
  });

  it("surfaces key ring parse errors as config issues", () => {
    const issues = issuesOf({
      ...minimal,
      FUNDROOM_SECRET_KEY: undefined,
      SECRET_KEY_RING: `v1:${randomBytes(8).toString("base64")}`,
    });
    expect(issues[0]?.key).toBe("SECRET_KEY_RING");
    expect(issues[0]?.message).toMatch(/need at least 32/u);
  });

  it("resolves *_FILE secrets and reports the source", () => {
    const r = tryLoadConfig({
      env: { ...minimal, DATABASE_URL: undefined, DATABASE_URL_FILE: "/run/secrets/db" },
      readFile: (p) => (p === "/run/secrets/db" ? "postgres://file:x@db/seedhost\n" : ""),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.config.raw.DATABASE_URL).toBe("postgres://file:x@db/seedhost");
    expect(r.sources["DATABASE_URL"]).toBe("file");
    expect(r.sources["BASE_URL"]).toBe("env");
    expect(r.sources["PORT"]).toBe("default");
    expect(r.sources["S3_BUCKET"]).toBe("unset");
  });

  it("enforces production hardening rules", () => {
    const issues = issuesOf({ ...minimal, APP_ENV: "prod" });
    const byKey = Object.fromEntries(issues.map((i) => [i.key, i.message]));
    expect(byKey["BASE_URL"]).toBe("must use https in APP_ENV=prod.");
    expect(byKey["MAIL_FROM"]).toBe("required in APP_ENV=prod.");
    expect(byKey["SMTP_URL"]).toMatch(/required when MAILER_DRIVER=smtp/u);

    const ok = tryLoadConfig({
      env: {
        ...minimal,
        APP_ENV: "prod",
        BASE_URL: "https://investors.example.com",
        MAIL_FROM: "ir@example.com",
        SMTP_URL: "smtps://u:p@smtp.example.com:465",
        AV_ACCEPT_UNSCANNED: "true",
      },
    });
    expect(ok.ok).toBe(true);
  });

  it("requires S3 settings when STORAGE_DRIVER=s3", () => {
    const issues = issuesOf({ ...minimal, STORAGE_DRIVER: "s3" });
    expect(issues.map((i) => i.key).sort()).toEqual([
      "S3_ACCESS_KEY_ID",
      "S3_BUCKET",
      "S3_REGION",
      "S3_SECRET_ACCESS_KEY",
    ]);
    const withEndpoint = tryLoadConfig({
      env: {
        ...minimal,
        STORAGE_DRIVER: "s3",
        S3_BUCKET: "b",
        S3_ACCESS_KEY_ID: "a",
        S3_SECRET_ACCESS_KEY: "s",
        S3_ENDPOINT: "https://garage.local",
      },
    });
    expect(withEndpoint.ok).toBe(true);
  });

  it("requires driver-specific mail settings", () => {
    const from = { MAIL_FROM: "investors@example.com" };
    expect(issuesOf({ ...minimal, MAILER_DRIVER: "resend" }).map((i) => i.key)).toEqual([
      "MAIL_FROM",
      "RESEND_API_KEY",
    ]);
    expect(issuesOf({ ...minimal, ...from, MAILER_DRIVER: "ses" }).map((i) => i.key)).toEqual([
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
    ]);
    expect(issuesOf({ ...minimal, ...from, MAILER_DRIVER: "postmark" }).map((i) => i.key)).toEqual([
      "POSTMARK_SERVER_TOKEN",
    ]);
    expect(
      issuesOf({
        ...minimal,
        ...from,
        MAILER_DRIVER: "postmark",
        POSTMARK_SERVER_TOKEN: "t",
        POSTMARK_WEBHOOK_USER: "hook",
      }).map((i) => i.key),
    ).toEqual(["POSTMARK_WEBHOOK_PASSWORD"]);
    expect(
      issuesOf({
        ...minimal,
        ...from,
        MAILER_DRIVER: "ses",
        AWS_REGION: "eu-west-1",
        AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
        AWS_SECRET_ACCESS_KEY: "s",
        SES_SNS_TOPIC_ARNS: "arn:aws:sns:eu-west-1:123456789012:ses-events",
      }).map((i) => i.key),
    ).toEqual(["SES_CONFIGURATION_SET"]);
  });

  it("requires each integrations OAuth client ID/SECRET pair together and redacts the secret", () => {
    expect(
      issuesOf({ ...minimal, INTEGRATIONS_QUICKBOOKS_CLIENT_ID: "qb" }).map((i) => i.key),
    ).toEqual(["INTEGRATIONS_QUICKBOOKS_CLIENT_SECRET"]);
    expect(
      issuesOf({ ...minimal, INTEGRATIONS_XERO_CLIENT_SECRET: "xs" }).map((i) => i.key),
    ).toEqual(["INTEGRATIONS_XERO_CLIENT_ID"]);
    const c = loadConfig({
      env: {
        ...minimal,
        INTEGRATIONS_SLACK_CLIENT_ID: "1.2",
        INTEGRATIONS_SLACK_CLIENT_SECRET: "ss",
        INTEGRATIONS_QUICKBOOKS_ENVIRONMENT: "sandbox",
      },
    });
    expect(c.raw.INTEGRATIONS_SLACK_CLIENT_SECRET).toBe("ss");
    expect(c.raw.INTEGRATIONS_QUICKBOOKS_ENVIRONMENT).toBe("sandbox");
    for (const k of [
      "INTEGRATIONS_QUICKBOOKS_CLIENT_SECRET",
      "INTEGRATIONS_XERO_CLIENT_SECRET",
      "INTEGRATIONS_SLACK_CLIENT_SECRET",
    ]) {
      expect(SECRET_KEYS.has(k)).toBe(true);
    }
  });

  it("parses the ESP driver settings and redacts their secrets", () => {
    const c = loadConfig({
      env: {
        ...minimal,
        MAIL_FROM: "investors@example.com",
        MAILER_DRIVER: "ses",
        AWS_REGION: "eu-west-1",
        AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
        AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        SES_CONFIGURATION_SET: "fundroom",
        SES_SNS_TOPIC_ARNS:
          " arn:aws:sns:eu-west-1:123456789012:a , arn:aws:sns:eu-west-1:123456789012:b ",
      },
    });
    expect(c.raw.SES_SNS_TOPIC_ARNS).toEqual([
      "arn:aws:sns:eu-west-1:123456789012:a",
      "arn:aws:sns:eu-west-1:123456789012:b",
    ]);
    expect(c.raw.POSTMARK_BROADCAST_STREAM).toBe("broadcast");
    for (const k of [
      "RESEND_API_KEY",
      "RESEND_WEBHOOK_SECRET",
      "POSTMARK_SERVER_TOKEN",
      "POSTMARK_WEBHOOK_PASSWORD",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
    ]) {
      expect(SECRET_KEYS.has(k)).toBe(true);
    }
    expect(
      issuesOf({ ...minimal, AWS_REGION: "Europe", RESEND_WEBHOOK_SECRET: "nope" }).map(
        (i) => i.key,
      ),
    ).toEqual(expect.arrayContaining(["AWS_REGION", "RESEND_WEBHOOK_SECRET"]));
  });

  it("parses lists, booleans, and WORKER_MODE shorthand", () => {
    const c = loadConfig({
      env: {
        ...minimal,
        ROLES: " api , web ",
        WORKER_MODE: "embedded",
        MODULES: "access,data-room",
        TRUST_PROXY: "yes",
        UPDATE_CHECK: "0",
      },
    });
    expect([...c.roles].sort()).toEqual(["api", "web", "worker"]);
    expect(c.modules).toEqual(["access", "data-room"]);
    expect(c.raw.TRUST_PROXY).toBe(true);
    expect(c.raw.UPDATE_CHECK).toBe(false);

    const off = loadConfig({ env: { ...minimal, WORKER_MODE: "off" } });
    expect(off.roles.has("worker")).toBe(false);

    const contradictory = issuesOf({ ...minimal, ROLES: "worker", WORKER_MODE: "external" });
    expect(contradictory[0]?.key).toBe("WORKER_MODE");
  });

  it("AUTH_HIBP_FAIL_MODE and CSP_TRUSTED_TYPES are closed enums with secure defaults (E3.2)", () => {
    const c = loadConfig({ env: minimal });
    expect(c.raw.AUTH_HIBP_FAIL_MODE).toBe("open");
    expect(c.raw.CSP_TRUSTED_TYPES).toBe("enforce");
    const set = loadConfig({
      env: { ...minimal, AUTH_HIBP_FAIL_MODE: "closed", CSP_TRUSTED_TYPES: "report" },
    });
    expect(set.raw.AUTH_HIBP_FAIL_MODE).toBe("closed");
    expect(set.raw.CSP_TRUSTED_TYPES).toBe("report");
    expect(issuesOf({ ...minimal, AUTH_HIBP_FAIL_MODE: "reject" }).map((i) => i.key)).toContain(
      "AUTH_HIBP_FAIL_MODE",
    );
    expect(issuesOf({ ...minimal, CSP_TRUSTED_TYPES: "off" }).map((i) => i.key)).toContain(
      "CSP_TRUSTED_TYPES",
    );
  });

  it("validates the identity keys (OIDC pairing, passkey RP id)", () => {
    const c = loadConfig({ env: minimal });
    expect(c.raw.AUTH_PASSWORD_ENABLED).toBe(false);
    expect(c.raw.AUTH_HIBP_CHECK).toBe(true);
    expect(c.raw.AUTH_HIBP_FAIL_MODE).toBe("open");
    expect(c.raw.AUTH_MAGIC_LINK_ENABLED).toBe(true);
    expect(c.raw.PASSKEY_RP_NAME).toBe("FundRoom");
    expect(c.raw.OIDC_ISSUER_URL).toBeUndefined();

    const half = issuesOf({ ...minimal, OIDC_ISSUER_URL: "https://accounts.google.com" });
    expect(half.map((i) => i.key)).toContain("OIDC_CLIENT_ID");
    const secretOnly = issuesOf({ ...minimal, OIDC_CLIENT_SECRET: "s" });
    expect(secretOnly.map((i) => i.key)).toContain("OIDC_CLIENT_SECRET");
    const httpIssuer = issuesOf({
      ...minimal,
      OIDC_ISSUER_URL: "http://idp.local",
      OIDC_CLIENT_ID: "x",
    });
    expect(httpIssuer.map((i) => i.key)).toContain("OIDC_ISSUER_URL");
    const full = tryLoadConfig({
      env: {
        ...minimal,
        OIDC_ISSUER_URL: "https://accounts.google.com",
        OIDC_CLIENT_ID: "x",
        OIDC_CLIENT_SECRET: "y",
        OIDC_ALLOWED_DOMAINS: "acme.com, Example.org",
      },
    });
    expect(full.ok && full.config.raw.OIDC_ALLOWED_DOMAINS).toEqual(["acme.com", "Example.org"]);

    const rp = issuesOf({ ...minimal, PASSKEY_RP_ID: "other.example" });
    expect(rp.map((i) => i.key)).toEqual(["PASSKEY_RP_ID"]);
    expect(
      tryLoadConfig({
        env: { ...minimal, BASE_URL: "https://investors.acme.com", PASSKEY_RP_ID: "acme.com" },
      }).ok,
    ).toBe(true);
  });

  it("validates BASE_PATH against BASE_URL", () => {
    const bad = issuesOf({ ...minimal, BASE_PATH: "/investors" });
    expect(bad[0]).toEqual({
      key: "BASE_PATH",
      message:
        "BASE_URL path should end with BASE_PATH (/investors), or BASE_URL should be one of the PATH_MOUNTS URLs.",
    });
    const good = loadConfig({
      env: { ...minimal, BASE_URL: "http://localhost:3000/investors/", BASE_PATH: "/investors" },
    });
    expect(good.basePath).toBe("/investors");
    expect(issuesOf({ ...minimal, BASE_PATH: "investors/" })[0]?.key).toBe("BASE_PATH");
  });

  describe("PATH_MOUNTS (E3.9)", () => {
    const mountsOf = (value: string, extra: Record<string, string> = {}) =>
      loadConfig({ env: { ...minimal, PATH_MOUNTS: value, ...extra } }).pathMounts;
    const problems = (value: string, extra: Record<string, string> = {}) =>
      issuesOf({ ...minimal, PATH_MOUNTS: value, ...extra }).filter((i) => i.key === "PATH_MOUNTS");

    it("is empty when unset", () => {
      expect(loadConfig({ env: minimal }).pathMounts).toEqual([]);
      expect(mountsOf("")).toEqual([]);
      expect(mountsOf(" , ")).toEqual([]);
    });

    it("splits each URL into a normalised origin and a prefix", () => {
      expect(
        mountsOf(
          " https://acme.com/investors , https://WWW.Acme.com:443/investors,http://localhost:8080/a/b.c_d~e-f",
        ),
      ).toEqual([
        { origin: "https://acme.com", prefix: "/investors" },
        { origin: "https://www.acme.com", prefix: "/investors" },
        { origin: "http://localhost:8080", prefix: "/a/b.c_d~e-f" },
      ]);
      // Several origins may share a prefix, and one origin may have several prefixes.
      expect(mountsOf("https://a.test/x,https://b.test/x,https://a.test/y")).toHaveLength(3);
      const c = loadConfig({ env: { ...minimal, PATH_MOUNTS: "https://ACME.com/investors" } });
      expect(c.raw.PATH_MOUNTS).toEqual(["https://acme.com/investors"]);
    });

    it("refuses anything that is not a plain origin + prefix, one problem per entry, with an example", () => {
      const bad = [
        "acme.com/investors",
        "/investors",
        "ftp://acme.com/investors",
        "javascript://acme.com/investors",
        "https://acme.com",
        "https://acme.com/",
        "https://acme.com/investors/",
        "https://acme.com/investors?x=1",
        "https://acme.com/investors?",
        "https://acme.com/investors#top",
        "https://user:pw@acme.com/investors",
        "https://user@acme.com/investors",
        "https://acme.com/investors/../x",
        "https://acme.com/./investors",
        "https://acme.com//investors",
        "https://acme.com/%69nvestors",
        "https://acme.com/inv estors",
        "https://acme.com/inv;estors",
        "https://acme.com/ïnvestors",
        "https://acme.com\\investors",
        "https://acme.com:99999/investors",
        "https:///investors",
      ];
      for (const entry of bad) {
        const issues = problems(entry);
        expect(issues, entry).toHaveLength(1);
        expect(issues[0]?.example).toBe(
          "https://acme.com/investors,https://www.acme.com/investors",
        );
        expect(issues[0]?.message).toMatch(/\.$/u);
      }
      // Every bad entry is reported in one pass (plus the length cap, 22 > 16).
      const issues = problems(bad.join(","));
      expect(issues).toHaveLength(bad.length + 1);
      expect(issues[0]?.message).toContain("is not an absolute URL");
      expect(problems("https://acme.com")[0]?.message).toContain("needs a path prefix");
      expect(problems("https://acme.com/investors/")[0]?.message).toContain(
        "must not end with a slash",
      );
      expect(problems("https://u:p@acme.com/investors")[0]?.message).toContain(
        "user name or password",
      );
      expect(problems("https://acme.com/x?y")[0]?.message).toContain("query or fragment");
      // An overlong entry is shown truncated.
      const long = `https://acme.com/${"a".repeat(5000)}?`;
      expect(problems(long)[0]?.message.length).toBeLessThan(400);
    });

    it("holds at most 16 mounts", () => {
      const list = (n: number) =>
        Array.from({ length: n }, (_, i) => `https://h${i}.test/investors`).join(",");
      expect(mountsOf(list(16))).toHaveLength(16);
      expect(problems(list(17))).toEqual([
        expect.objectContaining({ key: "PATH_MOUNTS", message: "lists at most 16 mounts." }),
      ]);
    });

    it("refuses the same mount listed twice", () => {
      expect(problems("https://acme.com/investors,https://ACME.com:443/investors")).toEqual([
        expect.objectContaining({
          message: "lists https://acme.com/investors more than once; give each mount once.",
        }),
      ]);
    });

    it("refuses TENANCY_MODE=multi (per-workspace mounts are the managed-host control plane)", () => {
      const [issue] = problems("https://acme.com/investors", { TENANCY_MODE: "multi" });
      expect(issue?.message).toContain("TENANCY_MODE=multi");
      expect(issue?.message).toContain("managed-host control plane");
      expect(tryLoadConfig({ env: { ...minimal, TENANCY_MODE: "multi" } }).ok).toBe(true);
    });

    it("requires https in staging/prod, allows http in dev/test", () => {
      for (const APP_ENV of ["staging", "prod"]) {
        const issues = issuesOf({
          ...minimal,
          APP_ENV,
          BASE_URL: "https://portal.acme.com",
          PATH_MOUNTS: "https://acme.com/investors,http://www.acme.com/investors",
        }).filter((i) => i.key === "PATH_MOUNTS");
        expect(issues).toHaveLength(1);
        expect(issues[0]?.message).toContain(`must use https in APP_ENV=${APP_ENV}`);
        expect(issues[0]?.message).toContain("http://www.acme.com/investors");
        expect(issues[0]?.message).not.toContain("https://acme.com/investors");
      }
      expect(mountsOf("http://localhost:8080/x", { APP_ENV: "test" })).toHaveLength(1);
    });

    it("refuses a trailing-dot host (E3.9 FR1 A6)", () => {
      for (const entry of ["https://acme.com./investors", "https://acme.com.:443/investors"]) {
        expect(problems(entry)[0]?.message, entry).toContain(
          "must not end its host name with a dot",
        );
      }
    });

    it("refuses CORS_ALLOWED_ORIGINS naming a mount origin (E3.9 FR1 A4)", () => {
      const cors = issuesOf({
        ...minimal,
        PATH_MOUNTS: "https://acme.com/investors,https://www.acme.com/ir",
        CORS_ALLOWED_ORIGINS: "https://app.acme.com,https://WWW.acme.com/,https://acme.com:443",
      }).filter((i) => i.key === "CORS_ALLOWED_ORIGINS");
      expect(cors).toHaveLength(1);
      expect(cors[0]?.message).toContain("https://acme.com, https://www.acme.com");
      expect(cors[0]?.message).not.toContain("app.acme.com");
      expect(
        mountsOf("https://acme.com/investors", { CORS_ALLOWED_ORIGINS: "https://app.acme.com" }),
      ).toHaveLength(1);
    });

    it("does not require TRUST_PROXY", () => {
      const c = loadConfig({
        env: { ...minimal, TRUST_PROXY: "false", PATH_MOUNTS: "https://acme.com/investors" },
      });
      expect(c.raw.TRUST_PROXY).toBe(false);
      expect(c.pathMounts).toHaveLength(1);
    });

    it("lets BASE_URL be a mount URL instead of ending in BASE_PATH", () => {
      // Replace shape: acme.com/investors → portal/portal-base, BASE_URL is the public mount.
      const c = loadConfig({
        env: {
          ...minimal,
          BASE_URL: "https://acme.com/investors",
          BASE_PATH: "/app",
          PATH_MOUNTS: "https://acme.com/investors",
        },
      });
      expect(c.baseUrl.href).toBe("https://acme.com/investors");
      // Strip shape at the root: nothing to check.
      expect(
        loadConfig({
          env: {
            ...minimal,
            BASE_URL: "https://acme.com/investors",
            PATH_MOUNTS: "https://acme.com/investors",
          },
        }).basePath,
      ).toBe("");
      // A mount on another origin (or with another prefix) does not make BASE_URL valid.
      for (const PATH_MOUNTS of ["https://www.acme.com/investors", "https://acme.com/ir"]) {
        expect(
          issuesOf({
            ...minimal,
            BASE_URL: "https://acme.com/investors",
            BASE_PATH: "/app",
            PATH_MOUNTS,
          }).map((i) => i.key),
        ).toEqual(["BASE_PATH"]);
      }
      // E3.9 FR1 A5: at the root, a BASE_URL path must be a mount (a stripping proxy).
      for (const env of [
        { BASE_URL: "https://acme.com/investors" },
        { BASE_URL: "https://acme.com/investors", PATH_MOUNTS: "https://acme.com/ir" },
        { BASE_URL: "https://acme.com/investors", PATH_MOUNTS: "https://www.acme.com/investors" },
      ]) {
        const issues = issuesOf({ ...minimal, ...env });
        expect(issues.map((i) => i.key)).toEqual(["BASE_URL"]);
        expect(issues[0]?.message).toContain("BASE_PATH is unset");
      }
      expect(loadConfig({ env: { ...minimal, BASE_URL: "https://acme.com/" } }).basePath).toBe("");
      // BASE_URL path equal to BASE_PATH still works without any mount.
      expect(
        loadConfig({
          env: { ...minimal, BASE_URL: "https://portal.test/investors", BASE_PATH: "/investors" },
        }).pathMounts,
      ).toEqual([]);
    });
  });

  it("validates the E0.5 keys (KMS driver, SSRF allow-list, HSTS preload)", () => {
    const c = loadConfig({ env: minimal });
    expect(c.raw.KMS_DRIVER).toBe("local");
    expect(c.raw.OUTBOUND_HTTP_ALLOW_PRIVATE).toBe(false);
    expect(c.raw.HSTS).toBe(true);
    expect(c.raw.HSTS_PRELOAD).toBe(false);
    expect(c.raw.UPLOAD_MAX_BYTES).toBe(5 * 1024 ** 3);

    const dev = loadConfig({
      env: {
        ...minimal,
        OUTBOUND_HTTP_ALLOW_PRIVATE: "true",
        OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: "keycloak.internal, 10.0.0.5",
        MAIL_FROM_NAME: "Acme IR",
      },
    });
    expect(dev.raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS).toEqual(["keycloak.internal", "10.0.0.5"]);
    expect(dev.raw.MAIL_FROM_NAME).toBe("Acme IR");

    const prod = {
      ...minimal,
      APP_ENV: "prod",
      BASE_URL: "https://ir.example.com",
      MAIL_FROM: "ir@example.com",
      SMTP_URL: "smtp://mail.example.com:587?requireTLS=true",
      AV_ACCEPT_UNSCANNED: "true",
    };
    const open = issuesOf({ ...prod, OUTBOUND_HTTP_ALLOW_PRIVATE: "true" });
    expect(open.map((i) => i.key)).toEqual(["OUTBOUND_HTTP_ALLOW_PRIVATE"]);
    expect(
      loadConfig({
        env: {
          ...prod,
          OUTBOUND_HTTP_ALLOW_PRIVATE: "true",
          OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: "keycloak.internal",
        },
      }).raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS,
    ).toEqual(["keycloak.internal"]);

    // E3.4: webhooks' own allow-list — default empty, never inherits the OUTBOUND one, and prod
    // refuses loopback / unspecified / wildcard targets (webhook URLs are tenant-chosen).
    expect(c.raw.WEBHOOK_ALLOW_PRIVATE_HOSTS).toBeUndefined();
    expect(dev.raw.WEBHOOK_ALLOW_PRIVATE_HOSTS).toBeUndefined();
    expect(
      loadConfig({ env: { ...minimal, WEBHOOK_ALLOW_PRIVATE_HOSTS: "127.0.0.1, hooks.internal" } })
        .raw.WEBHOOK_ALLOW_PRIVATE_HOSTS,
    ).toEqual(["127.0.0.1", "hooks.internal"]);
    for (const bad of [
      "127.0.0.1",
      "localhost",
      "*",
      "::1",
      "0.0.0.0",
      // Fix R6: the forms the guard normalises to the same host.
      "localhost.",
      "LOCALHOST",
      "127.0.0.1.",
      "127.1.2.3",
      "0.0.0.0.",
      "::",
      "[::1]",
      "::ffff:7f00:1",
      "[::ffff:7f00:1]",
      "::ffff:127.0.0.1",
      "foo.localhost",
      "foo.localhost.",
    ]) {
      expect(
        issuesOf({ ...prod, WEBHOOK_ALLOW_PRIVATE_HOSTS: `hooks.internal,${bad}` }).map(
          (i) => i.key,
        ),
        bad,
      ).toEqual(["WEBHOOK_ALLOW_PRIVATE_HOSTS"]);
    }
    expect(
      loadConfig({ env: { ...prod, WEBHOOK_ALLOW_PRIVATE_HOSTS: "hooks.internal,10.0.0.7" } }).raw
        .WEBHOOK_ALLOW_PRIVATE_HOSTS,
    ).toEqual(["hooks.internal", "10.0.0.7"]);

    expect(issuesOf({ ...prod, HSTS: "false", HSTS_PRELOAD: "true" }).map((i) => i.key)).toEqual([
      "HSTS_PRELOAD",
    ]);
    expect(
      issuesOf({
        ...prod,
        BASE_URL: "https://acme.com/investors",
        BASE_PATH: "/investors",
        HSTS_PRELOAD: "true",
      }).map((i) => i.key),
    ).toEqual(["HSTS_PRELOAD"]);
    expect(issuesOf({ ...minimal, KMS_DRIVER: "vault" }).map((i) => i.key)).toEqual(["KMS_DRIVER"]);
  });

  it("defaults accreditation verification to the manual driver and refuses any other id", () => {
    // `manual` is the only driver FundRoom ships (E2.5 D6) and the default an operator never
    // has to think about; an unknown id must fail at load rather than at the first 506(c)
    // verification, which is months later and in front of an investor.
    expect(loadConfig({ env: minimal }).raw.ACCREDITATION_DRIVER).toBe("manual");
    expect(
      loadConfig({ env: { ...minimal, ACCREDITATION_DRIVER: "manual" } }).raw.ACCREDITATION_DRIVER,
    ).toBe("manual");
    expect(issuesOf({ ...minimal, ACCREDITATION_DRIVER: "bureau" }).map((i) => i.key)).toEqual([
      "ACCREDITATION_DRIVER",
    ]);
  });

  it("offers both accreditation vendors by default, `none` turns them off, refuses unknown ids (E3.7)", () => {
    const both = ["verifyinvestor", "parallel-markets"];
    expect(loadConfig({ env: minimal }).raw.ACCREDITATION_DRIVERS).toEqual(both);
    // An empty variable is an unset one (the loader's rule for every key): the default.
    expect(
      loadConfig({ env: { ...minimal, ACCREDITATION_DRIVERS: "" } }).raw.ACCREDITATION_DRIVERS,
    ).toEqual(both);
    expect(
      loadConfig({ env: { ...minimal, ACCREDITATION_DRIVERS: " None " } }).raw
        .ACCREDITATION_DRIVERS,
    ).toEqual([]);
    expect(
      loadConfig({ env: { ...minimal, ACCREDITATION_DRIVERS: " parallel-markets " } }).raw
        .ACCREDITATION_DRIVERS,
    ).toEqual(["parallel-markets"]);
    expect(
      issuesOf({ ...minimal, ACCREDITATION_DRIVERS: "verifyinvestor,manual" }).map((i) => i.key),
    ).toEqual(["ACCREDITATION_DRIVERS"]);
  });

  it("takes ACCREDITATION_ALLOW_PRIVATE_HOSTS and refuses loopback in prod/staging (E3.7)", () => {
    const prod = {
      ...minimal,
      APP_ENV: "prod",
      BASE_URL: "https://ir.example.com",
      MAIL_FROM: "ir@example.com",
      SMTP_URL: "smtp://mail.example.com:587?requireTLS=true",
      AV_ACCEPT_UNSCANNED: "true",
    };
    expect(loadConfig({ env: minimal }).raw.ACCREDITATION_ALLOW_PRIVATE_HOSTS).toBeUndefined();
    expect(
      loadConfig({
        env: { ...minimal, ACCREDITATION_ALLOW_PRIVATE_HOSTS: "127.0.0.1, rig.internal" },
      }).raw.ACCREDITATION_ALLOW_PRIVATE_HOSTS,
    ).toEqual(["127.0.0.1", "rig.internal"]);
    for (const bad of ["127.0.0.1", "localhost", "*", "::1", "0.0.0.0", "[::1]"]) {
      expect(
        issuesOf({ ...prod, ACCREDITATION_ALLOW_PRIVATE_HOSTS: `rig.internal,${bad}` }).map(
          (i) => i.key,
        ),
        bad,
      ).toEqual(["ACCREDITATION_ALLOW_PRIVATE_HOSTS"]);
    }
    expect(
      loadConfig({ env: { ...prod, ACCREDITATION_ALLOW_PRIVATE_HOSTS: "rig.internal,10.0.0.10" } })
        .raw.ACCREDITATION_ALLOW_PRIVATE_HOSTS,
    ).toEqual(["rig.internal", "10.0.0.10"]);
  });

  it("offers both SSO protocols by default, `none` turns SSO off, refuses unknown ids (E3.8)", () => {
    const both = ["oidc", "saml"];
    expect(loadConfig({ env: minimal }).raw.SSO_PROTOCOLS).toEqual(both);
    expect(loadConfig({ env: { ...minimal, SSO_PROTOCOLS: "" } }).raw.SSO_PROTOCOLS).toEqual(both);
    expect(loadConfig({ env: { ...minimal, SSO_PROTOCOLS: " None " } }).raw.SSO_PROTOCOLS).toEqual(
      [],
    );
    expect(loadConfig({ env: { ...minimal, SSO_PROTOCOLS: " saml " } }).raw.SSO_PROTOCOLS).toEqual([
      "saml",
    ]);
    expect(issuesOf({ ...minimal, SSO_PROTOCOLS: "oidc,ldap" }).map((i) => i.key)).toEqual([
      "SSO_PROTOCOLS",
    ]);
  });

  it("turns SCIM on by default and reads SCIM_ENABLED as a boolean (E3.8)", () => {
    expect(loadConfig({ env: minimal }).raw.SCIM_ENABLED).toBe(true);
    expect(loadConfig({ env: { ...minimal, SCIM_ENABLED: "false" } }).raw.SCIM_ENABLED).toBe(false);
    expect(issuesOf({ ...minimal, SCIM_ENABLED: "maybe" }).map((i) => i.key)).toEqual([
      "SCIM_ENABLED",
    ]);
  });

  it("takes SSO_ALLOW_PRIVATE_HOSTS and refuses loopback in prod/staging (E3.8)", () => {
    const prod = {
      ...minimal,
      APP_ENV: "prod",
      BASE_URL: "https://ir.example.com",
      MAIL_FROM: "ir@example.com",
      SMTP_URL: "smtp://mail.example.com:587?requireTLS=true",
      AV_ACCEPT_UNSCANNED: "true",
    };
    expect(loadConfig({ env: minimal }).raw.SSO_ALLOW_PRIVATE_HOSTS).toBeUndefined();
    expect(
      loadConfig({ env: { ...minimal, SSO_ALLOW_PRIVATE_HOSTS: "127.0.0.1, idp.internal" } }).raw
        .SSO_ALLOW_PRIVATE_HOSTS,
    ).toEqual(["127.0.0.1", "idp.internal"]);
    for (const bad of ["127.0.0.1", "localhost", "*", "::1", "0.0.0.0", "[::1]"]) {
      expect(
        issuesOf({ ...prod, SSO_ALLOW_PRIVATE_HOSTS: `idp.internal,${bad}` }).map((i) => i.key),
        bad,
      ).toEqual(["SSO_ALLOW_PRIVATE_HOSTS"]);
    }
    expect(
      loadConfig({ env: { ...prod, SSO_ALLOW_PRIVATE_HOSTS: "idp.internal,10.0.0.11" } }).raw
        .SSO_ALLOW_PRIVATE_HOSTS,
    ).toEqual(["idp.internal", "10.0.0.11"]);
  });

  it("takes the E2.1 custom-domain keys and refuses a single DoH resolver in prod", () => {
    const dev = loadConfig({ env: minimal });
    expect(dev.raw.CUSTOM_DOMAIN_DRIVER).toBe("caddy-ask");
    // Unset: the composition root substitutes the canonical host, so the schema stays unaware
    // of BASE_URL, and the adapter substitutes its own endpoint list.
    expect(dev.raw.CUSTOM_DOMAIN_CNAME_TARGET).toBeUndefined();
    expect(dev.raw.DOH_ENDPOINTS).toBeUndefined();
    // Unset is the normal case for the apex override: the verifier resolves the CNAME target's
    // own A/AAAA instead, which needs no operator knowledge (E2.1 S1).
    expect(dev.raw.CUSTOM_DOMAIN_EDGE_ADDRESSES).toBeUndefined();

    const set = loadConfig({
      env: {
        ...minimal,
        CUSTOM_DOMAIN_DRIVER: "manual",
        CUSTOM_DOMAIN_CNAME_TARGET: "customers.fundroom.app",
        CUSTOM_DOMAIN_EDGE_ADDRESSES: "203.0.113.10, 2001:db8::10",
        DOH_ENDPOINTS: "https://1.1.1.1/dns-query, https://8.8.8.8/resolve",
      },
    }).raw;
    expect(set.CUSTOM_DOMAIN_DRIVER).toBe("manual");
    expect(set.CUSTOM_DOMAIN_CNAME_TARGET).toBe("customers.fundroom.app");
    expect(set.CUSTOM_DOMAIN_EDGE_ADDRESSES).toEqual(["203.0.113.10", "2001:db8::10"]);
    expect(set.DOH_ENDPOINTS).toEqual(["https://1.1.1.1/dns-query", "https://8.8.8.8/resolve"]);
    // IP literals only; a hostname there would be a name we would have to resolve to check an
    // address, which is what leaving it unset already does properly.
    expect(() =>
      loadConfig({ env: { ...minimal, CUSTOM_DOMAIN_EDGE_ADDRESSES: "edge.acme.com" } }),
    ).toThrow();

    expect(
      issuesOf({ ...minimal, CUSTOM_DOMAIN_CNAME_TARGET: "https://edge.example.com" }).map(
        (i) => i.key,
      ),
    ).toEqual(["CUSTOM_DOMAIN_CNAME_TARGET"]);

    // Decision 7 needs two resolvers to agree; the adapter clamps its quorum instead of
    // refusing, so one endpoint in prod is a silent downgrade and is a config error here.
    const prod = {
      ...minimal,
      APP_ENV: "prod",
      BASE_URL: "https://ir.example.com",
      MAIL_FROM: "ir@example.com",
      SMTP_URL: "smtp://mail.example.com:587?requireTLS=true",
      AV_ACCEPT_UNSCANNED: "true",
    };
    const one = issuesOf({ ...prod, DOH_ENDPOINTS: "https://1.1.1.1/dns-query" });
    expect(one.map((i) => i.key)).toEqual(["DOH_ENDPOINTS"]);
    expect(one[0]?.message).toContain("at least two *distinct* resolvers");
    // Counted by DISTINCT HOST (E2.1 S4): the same endpoint twice is two entries and one
    // resolver, and it used to pass this rule and then satisfy a quorum of two out of a single
    // cache — decision 6's guarantee gone, silently.
    const twice = issuesOf({
      ...prod,
      DOH_ENDPOINTS: "https://1.1.1.1/dns-query,https://1.1.1.1/dns-query",
    });
    expect(twice.map((i) => i.key)).toEqual(["DOH_ENDPOINTS"]);
    expect(twice[0]?.message).toContain("all 1.1.1.1");
    // Two paths on one host is still one host.
    expect(
      issuesOf({
        ...prod,
        DOH_ENDPOINTS: "https://1.1.1.1/dns-query,https://1.1.1.1/resolve",
      }).map((i) => i.key),
    ).toEqual(["DOH_ENDPOINTS"]);
    // Two is fine in prod, and one is still fine in dev.
    expect(
      loadConfig({
        env: { ...prod, DOH_ENDPOINTS: "https://1.1.1.1/dns-query,https://8.8.8.8/resolve" },
      }).raw.DOH_ENDPOINTS,
    ).toHaveLength(2);
    expect(
      loadConfig({ env: { ...minimal, DOH_ENDPOINTS: "https://127.0.0.1:8053/dns-query" } }).raw
        .DOH_ENDPOINTS,
    ).toEqual(["https://127.0.0.1:8053/dns-query"]);
  });

  it("UPDATE_CHECK_URL (E2.9): defaults to the release CDN, https outside dev/test, no identifiers", () => {
    expect(loadConfig({ env: minimal }).raw.UPDATE_CHECK_URL).toBe(
      "https://releases.fundroom.com/index.json",
    );
    // A local test server over http is fine in test/dev.
    expect(
      loadConfig({
        env: { ...minimal, APP_ENV: "test", UPDATE_CHECK_URL: "http://127.0.0.1:4010/index.json" },
      }).raw.UPDATE_CHECK_URL,
    ).toBe("http://127.0.0.1:4010/index.json");
    const prod = {
      ...minimal,
      APP_ENV: "prod",
      BASE_URL: "https://ir.example.com",
      MAIL_FROM: "ir@example.com",
      SMTP_URL: "smtp://mail.example.com:587?requireTLS=true",
      AV_ACCEPT_UNSCANNED: "true",
    };
    const insecure = issuesOf({
      ...prod,
      UPDATE_CHECK_URL: "http://mirror.example.com/index.json",
    });
    expect(insecure.map((i) => i.key)).toEqual(["UPDATE_CHECK_URL"]);
    expect(insecure[0]?.message).toContain("https");
    expect(
      issuesOf({
        ...prod,
        APP_ENV: "staging",
        UPDATE_CHECK_URL: "http://mirror.example.com/index.json",
      }).map((i) => i.key),
    ).toEqual(["UPDATE_CHECK_URL"]);
    // Opted out, the URL is never fetched, so its scheme is not an error.
    expect(
      loadConfig({
        env: {
          ...prod,
          UPDATE_CHECK: "false",
          UPDATE_CHECK_URL: "http://mirror.example.com/i.json",
        },
      }).raw.UPDATE_CHECK,
    ).toBe(false);
    expect(
      loadConfig({ env: { ...prod, UPDATE_CHECK_URL: "https://mirror.example.com/index.json" } })
        .raw.UPDATE_CHECK_URL,
    ).toBe("https://mirror.example.com/index.json");
    // Nothing that could identify the install rides along.
    for (const bad of [
      "https://releases.example.com/index.json?instance=acme",
      "https://releases.example.com/index.json#acme",
      "https://acme:secret@releases.example.com/index.json",
      "ftp://releases.example.com/index.json",
      "not a url",
    ]) {
      expect(
        issuesOf({ ...minimal, UPDATE_CHECK_URL: bad }).map((i) => i.key),
        bad,
      ).toEqual(["UPDATE_CHECK_URL"]);
    }
  });

  it("adds the first-run keys (E0.8): DATA_DIR, SETUP_TOKEN, DATABASE_WAIT_TIMEOUT_MS", () => {
    const c = loadConfig({ env: minimal });
    expect(c.raw.DATA_DIR).toBe("/data");
    expect(c.raw.SETUP_TOKEN).toBeUndefined();
    expect(c.raw.DATABASE_WAIT_TIMEOUT_MS).toBe(60_000);
    expect(
      loadConfig({
        env: {
          ...minimal,
          DATA_DIR: "/var/lib/fundroom",
          SETUP_TOKEN: "0123456789abcdef0123",
          DATABASE_WAIT_TIMEOUT_MS: "0",
        },
      }).raw,
    ).toMatchObject({
      DATA_DIR: "/var/lib/fundroom",
      SETUP_TOKEN: "0123456789abcdef0123",
      DATABASE_WAIT_TIMEOUT_MS: 0,
    });
    expect(issuesOf({ ...minimal, SETUP_TOKEN: "short" }).map((i) => i.key)).toEqual([
      "SETUP_TOKEN",
    ]);
  });
});
