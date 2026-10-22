import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLAMD_MAX_DEADLINE_MS,
  configWarnings,
  doctorReport,
  formatDoctorReport,
  isCellOrigin,
  ownCellOrigin,
  redactUrlCredentials,
} from "./doctor.js";
import { tryLoadConfig } from "./load.js";
import { uploadCeilingBytes } from "./schema.js";

const KEY = randomBytes(32).toString("base64");

describe("doctor", () => {
  const r = tryLoadConfig({
    env: {
      BASE_URL: "http://localhost:3000",
      DATABASE_URL: "postgres://seedhost:hunter2@db:5432/seedhost",
      FUNDROOM_SECRET_KEY: KEY,
      SMTP_URL: "smtp://mailer:p%40ss@smtp.example.com:587",
      ERROR_REPORTING_DSN: "https://abc123@glitchtip.example.com/1",
      ROLES: "api,web",
    },
  });
  if (!r.ok) throw r.error;
  const report = doctorReport(r.config, r.sources);
  const text = formatDoctorReport(report);
  const row = (key: string) => report.rows.find((x) => x.key === key);

  it("never contains secret material", () => {
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("p@ss");
    expect(text).not.toContain("p%40ss");
    expect(text).not.toContain("abc123");
    expect(text).not.toContain(KEY.slice(0, 10));
  });

  it("keeps the useful, non-secret parts of URLs", () => {
    expect(row("DATABASE_URL")?.value).toBe("postgres://seedhost:••••••••@db:5432/seedhost");
    expect(row("SMTP_URL")?.value).toBe("smtp://mailer:••••••••@smtp.example.com:587");
    expect(row("ERROR_REPORTING_DSN")?.value).toBe("https://••••••••@glitchtip.example.com/1");
  });

  it("shows key fingerprints and value sources", () => {
    expect(row("FUNDROOM_SECRET_KEY")?.value).toMatch(/^v1 \(sha256:[0-9a-f]{12}\)$/u);
    expect(row("FUNDROOM_SECRET_KEY")?.source).toBe("env");
    expect(row("PORT")).toEqual({ key: "PORT", value: "3000", source: "default" });
    expect(row("S3_BUCKET")).toEqual({ key: "S3_BUCKET", value: "(unset)", source: "unset" });
    expect(row("ROLES")?.value).toBe("api,web");
    expect(report.derived.find((d) => d.key === "modules")?.value).toBe("(all)");
    expect(text).toContain("Resolved configuration (secrets redacted):");
    expect(text).toContain("Derived:");
  });
});

describe("configWarnings", () => {
  const load = (env: Record<string, string>) => {
    const r = tryLoadConfig({
      env: {
        BASE_URL: "https://portal.example.com",
        DATABASE_URL: "postgres://seedhost:pw@db:5432/seedhost",
        FUNDROOM_SECRET_KEY: KEY,
        ...env,
      },
    });
    if (!r.ok) throw r.error;
    return r;
  };

  it("says nothing for the shipped configuration", () => {
    const r = load({});
    expect(configWarnings(r.config)).toEqual([]);
    expect(formatDoctorReport(doctorReport(r.config, r.sources))).not.toContain("Warnings:");
  });

  it("warns that BASE_PATH breaks custom-domain certificate issuance", () => {
    // Not a `crossFieldRules` error: path-mount mode is supported (ADR-0022) and so are custom
    // domains, but the two halves of `/internal/*` — Caddy's hard-coded `ask` URL and its
    // refusal matcher — both live in a file the app does not read, and both stop matching when
    // the real path becomes `/x/internal/tls/ask`. Nothing else would ever mention it.
    const r = load({ BASE_URL: "https://portal.example.com/x", BASE_PATH: "/x" });
    const warnings = configWarnings(r.config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.key).toBe("BASE_PATH");
    expect(warnings[0]?.message).toContain("http://app:3000/x/internal/tls/ask");
    expect(warnings[0]?.message).toContain("/x/internal/*");
    // E3.9: the shipped Caddyfile reads the prefix from the edge's own environment.
    expect(warnings[0]?.message).toContain("FUNDROOM_BASE_PATH=/x");
    const report = doctorReport(r.config, r.sources);
    expect(report.warnings).toEqual(warnings);
    expect(formatDoctorReport(report)).toContain("Warnings:");
  });

  it("warns when MAIL_IGNORE_FOREIGN_SENDERS is on without MAIL_FROM (E-UP-24)", () => {
    const keyed = (env: Record<string, string>) =>
      configWarnings(load(env).config).filter((w) => w.key === "MAIL_IGNORE_FOREIGN_SENDERS");
    expect(load({}).config.raw.MAIL_IGNORE_FOREIGN_SENDERS).toBe(false);
    expect(keyed({ MAIL_IGNORE_FOREIGN_SENDERS: "true" })).toHaveLength(1);
    expect(keyed({ MAIL_IGNORE_FOREIGN_SENDERS: "true" })[0]?.message).toContain("MAIL_FROM");
    expect(
      keyed({ MAIL_IGNORE_FOREIGN_SENDERS: "true", MAIL_FROM: "no-reply@mail.example.com" }),
    ).toEqual([]);
    expect(keyed({ MAIL_IGNORE_FOREIGN_SENDERS: "false" })).toEqual([]);
  });
});

describe("doctor: renamed variables (A-2)", () => {
  it("warns at doctor and boot when the master key is read from SEEDHOST_SECRET_KEY", () => {
    const r = tryLoadConfig({
      env: {
        BASE_URL: "http://localhost:3000",
        DATABASE_URL: "postgres://u:p@db:5432/db",
        SEEDHOST_SECRET_KEY: KEY,
      },
    });
    if (!r.ok) throw r.error;
    const warnings = configWarnings(r.config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.key).toBe("SEEDHOST_SECRET_KEY");
    expect(warnings[0]?.message).toContain("renamed FUNDROOM_SECRET_KEY");
    expect(warnings[0]?.message).not.toContain(KEY);
    const report = doctorReport(r.config, r.sources);
    // The row is the new name and still shows the fingerprint, not the value.
    expect(report.rows.find((x) => x.key === "FUNDROOM_SECRET_KEY")?.value).toMatch(
      /^v1 \(sha256:[0-9a-f]{12}\)$/u,
    );
    const text = formatDoctorReport(report);
    expect(text).toContain("SEEDHOST_SECRET_KEY: deprecated name");
    expect(text).not.toContain(KEY);
  });

  it("warns that the old name can go once no older image runs, when both names hold the same value", () => {
    const r = tryLoadConfig({
      env: {
        BASE_URL: "http://localhost:3000",
        DATABASE_URL: "postgres://u:p@db:5432/db",
        FUNDROOM_SECRET_KEY: KEY,
        SEEDHOST_SECRET_KEY: KEY,
      },
    });
    if (!r.ok) throw r.error;
    const warnings = configWarnings(r.config);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.key).toBe("SEEDHOST_SECRET_KEY");
    expect(warnings[0]?.message).toContain("same value as FUNDROOM_SECRET_KEY");
    expect(warnings[0]?.message).toContain(
      "Remove SEEDHOST_SECRET_KEY once no image older than this release can run",
    );
    expect(warnings[0]?.message).not.toContain(KEY);
    expect(formatDoctorReport(doctorReport(r.config, r.sources))).toContain(
      "SEEDHOST_SECRET_KEY: deprecated name, set to the same value",
    );
  });

  it("names the _FILE spelling when that is what was read", () => {
    const r = tryLoadConfig({
      env: {
        BASE_URL: "http://localhost:3000",
        DATABASE_URL: "postgres://u:p@db:5432/db",
        SEEDHOST_SECRET_KEY_FILE: "/data/secret.key",
      },
      readFile: () => KEY,
    });
    if (!r.ok) throw r.error;
    expect(configWarnings(r.config)).toEqual([
      expect.objectContaining({
        key: "SEEDHOST_SECRET_KEY_FILE",
        message: expect.stringContaining("renamed FUNDROOM_SECRET_KEY_FILE"),
      }),
    ]);
  });
});

describe("doctor: path mounts (E3.9)", () => {
  it("lists PATH_MOUNTS as given and split into origin + prefix", () => {
    const r = tryLoadConfig({
      env: {
        BASE_URL: "https://portal.example.com",
        DATABASE_URL: "postgres://seedhost:pw@db:5432/seedhost",
        FUNDROOM_SECRET_KEY: KEY,
        PATH_MOUNTS: "https://acme.com/investors, https://WWW.acme.com/ir/portal",
      },
    });
    if (!r.ok) throw r.error;
    const report = doctorReport(r.config, r.sources);
    expect(report.rows.find((x) => x.key === "PATH_MOUNTS")).toEqual({
      key: "PATH_MOUNTS",
      value: "https://acme.com/investors,https://www.acme.com/ir/portal",
      source: "env",
    });
    expect(report.derived.find((x) => x.key === "pathMounts")?.value).toBe(
      "https://acme.com prefix /investors, https://www.acme.com prefix /ir/portal",
    );
    expect(report.warnings).toEqual([]);
  });

  it("warns when mounts share a prefix and TRUST_PROXY is off (E3.9 FR1 A3)", () => {
    const load = (TRUST_PROXY: string, PATH_MOUNTS: string) => {
      const r = tryLoadConfig({
        env: {
          BASE_URL: "https://portal.example.com",
          DATABASE_URL: "postgres://seedhost:pw@db:5432/seedhost",
          FUNDROOM_SECRET_KEY: KEY,
          TRUST_PROXY,
          PATH_MOUNTS,
        },
      });
      if (!r.ok) throw r.error;
      return configWarnings(r.config);
    };
    const shared = "https://acme.com/investors,https://www.acme.com/investors,https://b.test/x";
    const off = load("false", shared);
    expect(off).toHaveLength(1);
    expect(off[0]?.key).toBe("PATH_MOUNTS");
    expect(off[0]?.message).toContain(
      "https://acme.com, https://www.acme.com share the prefix /investors",
    );
    expect(load("true", shared)).toEqual([]);
    expect(load("false", "https://acme.com/investors,https://www.acme.com/ir")).toEqual([]);
  });

  it("notes that X-Forwarded-Prefix is mandatory when BASE_URL is itself a mount (E3.9 FR2 A9)", () => {
    const load = (BASE_URL: string, extra: Record<string, string> = {}) => {
      const r = tryLoadConfig({
        env: {
          BASE_URL,
          DATABASE_URL: "postgres://seedhost:pw@db:5432/seedhost",
          FUNDROOM_SECRET_KEY: KEY,
          PATH_MOUNTS: "https://acme.com/investors",
          ...extra,
        },
      });
      if (!r.ok) throw r.error;
      return configWarnings(r.config);
    };
    for (const url of ["https://acme.com/investors", "https://acme.com/investors/"]) {
      const notes = load(url);
      expect(notes).toHaveLength(1);
      expect(notes[0]?.key).toBe("PATH_MOUNTS");
      expect(notes[0]?.message).toContain("X-Forwarded-Prefix: /investors for every request");
      expect(notes[0]?.message).toContain("presented as the portal's own origin");
    }
    expect(load("https://portal.acme.com")).toEqual([]);
  });

  it("says (none) without mounts", () => {
    const r = tryLoadConfig({
      env: {
        BASE_URL: "http://localhost:3000",
        DATABASE_URL: "postgres://seedhost:pw@db:5432/seedhost",
        FUNDROOM_SECRET_KEY: KEY,
      },
    });
    if (!r.ok) throw r.error;
    expect(
      doctorReport(r.config, r.sources).derived.find((x) => x.key === "pathMounts")?.value,
    ).toBe("(none)");
  });
});

describe("redactUrlCredentials", () => {
  it("fully redacts unparseable values", () => {
    expect(redactUrlCredentials("not a url")).toBe("••••••••");
  });
  it("leaves credential-free URLs alone", () => {
    expect(redactUrlCredentials("https://example.com/x")).toBe("https://example.com/x");
  });
});

describe("doctor under the control plane (E-UP-11, E-UP-13)", () => {
  const base = {
    DATABASE_URL: "postgres://seedhost:hunter2@db:5432/seedhost",
    FUNDROOM_SECRET_KEY: KEY,
    TENANCY_MODE: "multi",
  };
  const load = (env: Record<string, string>) => {
    const r = tryLoadConfig({ env: { ...base, ...env } });
    if (!r.ok) throw r.error;
    return {
      config: r.config,
      report: doctorReport(r.config, r.sources),
      warnings: configWarnings(r.config),
    };
  };
  const derived = (report: ReturnType<typeof doctorReport>, key: string) =>
    report.derived.find((d) => d.key === key)?.value;

  it("says the first-run wizard and its token are off, and that a SETUP_TOKEN is ignored", () => {
    const on = load({
      BASE_URL: "https://app.example.com",
      CONTROL_PLANE: "on",
      SETUP_TOKEN: "0123456789abcdef0123",
    });
    expect(derived(on.report, "firstRunSetup")).toMatch(/^off \(CONTROL_PLANE=on: no setup token/u);
    expect(on.warnings).toContainEqual({
      key: "SETUP_TOKEN",
      message: expect.stringMatching(/^ignored: CONTROL_PLANE=on/u),
    });
    const off = load({ BASE_URL: "https://app.example.com", SETUP_TOKEN: "0123456789abcdef0123" });
    expect(derived(off.report, "firstRunSetup")).toMatch(/^wizard until .*SETUP_TOKEN\)$/u);
    expect(off.warnings.map((w) => w.key)).not.toContain("SETUP_TOKEN");
  });

  it("says the own cell row is created at start-up, with BASE_URL's origin under the control plane", () => {
    const on = load({
      BASE_URL: "https://app.example.com/",
      CONTROL_PLANE: "on",
      CELL_ID: "us-1",
      DATA_REGION: "us",
    });
    expect(derived(on.report, "ownCell")).toMatch(
      /^us-1: its core\.cell row is created at start-up when missing \(region us, origin https:\/\/app\.example\.com\); an existing row is never changed/u,
    );
    expect(on.warnings.map((w) => w.key)).not.toContain("CELL_ID");
    expect(derived(load({ BASE_URL: "https://app.example.com" }).report, "ownCell")).toBe(
      "default (the seeded row)",
    );
    // Plain http: not a cell origin, so the row gets none.
    const bad = load({ BASE_URL: "http://app.example.com", CONTROL_PLANE: "on", CELL_ID: "us-1" });
    expect(bad.warnings).toContainEqual({
      key: "CELL_ID",
      message: expect.stringMatching(
        /^CELL_ID=us-1: BASE_URL's origin http:\/\/app\.example\.com cannot be a cell origin.*fundroom cell set-origin us-1/u,
      ),
    });
    expect(derived(bad.report, "ownCell")).toContain(
      "origin '' (this install: BASE_URL's origin cannot be a cell origin)",
    );
    // A port and upper case are fine (the origin is what the row stores).
    expect(
      ownCellOrigin(load({ BASE_URL: "https://App.Example.com:8443", CONTROL_PLANE: "on" }).config),
    ).toEqual({ origin: "https://app.example.com:8443", basis: "base_url" });
    // The shape itself (pinned to @fundroom/control-plane's in a server test).
    expect(isCellOrigin("https://app.example.com")).toBe(true);
    expect(isCellOrigin("https://10.0.0.1:8443")).toBe(true);
    expect(isCellOrigin("https://[2001:db8::1]:8443")).toBe(false);
    expect(isCellOrigin("http://app.example.com")).toBe(false);
    // Without a control plane nothing routes between cells.
    expect(ownCellOrigin(load({ BASE_URL: "https://app.example.com" }).config)).toEqual({
      origin: "",
      basis: "control_plane_off",
    });
  });
});

describe("doctor: virus-scan limits (E-UP-25)", () => {
  const load = (env: Record<string, string>) => {
    const r = tryLoadConfig({
      env: {
        BASE_URL: "https://portal.example.com",
        DATABASE_URL: "postgres://seedhost:pw@db:5432/seedhost",
        FUNDROOM_SECRET_KEY: KEY,
        ...env,
      },
    });
    if (!r.ok) throw r.error;
    return r.config;
  };
  const avKeys = (env: Record<string, string>) =>
    configWarnings(load(env))
      .map((w) => w.key)
      .filter((k) =>
        [
          "AV_MAX_SCAN_BYTES",
          "UPLOAD_MAX_BYTES",
          "CLAMD_MIN_BYTES_PER_SECOND",
          "CLAMD_TIMEOUT_MS",
          "ESIGN_MAX_ARTIFACT_BYTES",
        ].includes(k),
      );
  const MiB = 1024 * 1024;

  it("asks for AV_MAX_SCAN_BYTES with clamd, and says nothing with noop", () => {
    const warning = configWarnings(load({ AV_DRIVER: "clamd", CLAMD_HOST: "clamav" })).find(
      (w) => w.key === "AV_MAX_SCAN_BYTES",
    );
    expect(warning?.message).toContain("StreamMaxLength");
    expect(avKeys({ AV_MAX_SCAN_BYTES: String(MiB) })).toEqual([]);
    expect(avKeys({})).toEqual([]);
  });

  it("says the upload ceiling is capped when UPLOAD_MAX_BYTES is larger", () => {
    const env = { AV_DRIVER: "clamd", CLAMD_HOST: "clamav", AV_MAX_SCAN_BYTES: String(100 * MiB) };
    const warning = configWarnings(load(env)).find((w) => w.key === "UPLOAD_MAX_BYTES");
    expect(warning?.message).toContain("capped to AV_MAX_SCAN_BYTES");
    expect(avKeys({ ...env, UPLOAD_MAX_BYTES: String(100 * MiB) })).toEqual([]);
  });

  it("warns when the scaled scan deadline passes 20 minutes", () => {
    const env = {
      AV_DRIVER: "clamd",
      CLAMD_HOST: "clamav",
      AV_MAX_SCAN_BYTES: String(1024 * MiB),
      UPLOAD_MAX_BYTES: String(1024 * MiB),
    };
    // 1 GiB at 768 KiB/s = 1366 s + 120 s > 20 min.
    expect(avKeys({ ...env, CLAMD_MIN_BYTES_PER_SECOND: String(768 * 1024) })).toEqual([
      "CLAMD_MIN_BYTES_PER_SECOND",
    ]);
    // 1 GiB at 4 MiB/s = 256 s + 120 s.
    expect(avKeys({ ...env, CLAMD_MIN_BYTES_PER_SECOND: String(4 * MiB) })).toEqual([]);
    // A fixed deadline past the cap.
    expect(avKeys({ ...env, CLAMD_TIMEOUT_MS: String(21 * 60_000) })).toEqual(["CLAMD_TIMEOUT_MS"]);
    expect(CLAMD_MAX_DEADLINE_MS).toBe(20 * 60_000);
    // AV_MAX_SCAN_BYTES unset: the largest scan is UPLOAD_MAX_BYTES (1 GiB here).
    const unset = {
      AV_DRIVER: "clamd",
      CLAMD_HOST: "clamav",
      UPLOAD_MAX_BYTES: String(1024 * MiB),
    };
    const slow = { ...unset, CLAMD_MIN_BYTES_PER_SECOND: String(768 * 1024) };
    expect(avKeys(slow)).toEqual(["AV_MAX_SCAN_BYTES", "CLAMD_MIN_BYTES_PER_SECOND"]);
    expect(
      configWarnings(load(slow)).find((w) => w.key === "CLAMD_MIN_BYTES_PER_SECOND")?.message,
    ).toContain("UPLOAD_MAX_BYTES / CLAMD_MIN_BYTES_PER_SECOND");
    expect(avKeys({ ...unset, CLAMD_MIN_BYTES_PER_SECOND: String(4 * MiB) })).toEqual([
      "AV_MAX_SCAN_BYTES",
    ]);
  });

  it("warns when e-sign artifacts may be larger than the scanner reads", () => {
    const env = {
      AV_DRIVER: "clamd",
      CLAMD_HOST: "clamav",
      AV_MAX_SCAN_BYTES: String(10 * MiB),
      UPLOAD_MAX_BYTES: String(10 * MiB),
    };
    // ESIGN_MAX_ARTIFACT_BYTES defaults to 25 MiB.
    const warning = configWarnings(load(env)).find((w) => w.key === "ESIGN_MAX_ARTIFACT_BYTES");
    expect(warning?.message).toContain("unscannable");
    expect(avKeys({ ...env, ESIGN_MAX_ARTIFACT_BYTES: String(10 * MiB) })).toEqual([]);
    // noop: no scanner limit applies.
    expect(avKeys({ AV_MAX_SCAN_BYTES: String(10 * MiB) })).toEqual([]);
  });

  it("caps the upload ceiling only with clamd and AV_MAX_SCAN_BYTES", () => {
    const max = String(100 * MiB);
    expect(uploadCeilingBytes(load({}).raw)).toBe(5 * 1024 ** 3);
    expect(uploadCeilingBytes(load({ AV_MAX_SCAN_BYTES: max }).raw)).toBe(5 * 1024 ** 3);
    const clamd = { AV_DRIVER: "clamd", CLAMD_HOST: "clamav" };
    expect(uploadCeilingBytes(load(clamd).raw)).toBe(5 * 1024 ** 3);
    expect(uploadCeilingBytes(load({ ...clamd, AV_MAX_SCAN_BYTES: max }).raw)).toBe(100 * MiB);
    expect(
      uploadCeilingBytes(
        load({ ...clamd, AV_MAX_SCAN_BYTES: max, UPLOAD_MAX_BYTES: String(MiB) }).raw,
      ),
    ).toBe(MiB);
  });

  it("parses the new keys with their defaults and bounds", () => {
    const raw = load({}).raw;
    expect(raw.CLAMD_CONNECT_TIMEOUT_MS).toBe(5000);
    expect(raw.CLAMD_MIN_BYTES_PER_SECOND).toBe(0);
    expect(raw.AV_MAX_SCAN_BYTES).toBeUndefined();
    const bad = (env: Record<string, string>) =>
      tryLoadConfig({
        env: {
          BASE_URL: "https://portal.example.com",
          DATABASE_URL: "postgres://seedhost:pw@db:5432/seedhost",
          FUNDROOM_SECRET_KEY: KEY,
          ...env,
        },
      }).ok;
    expect(bad({ AV_MAX_SCAN_BYTES: "1000" })).toBe(false);
    expect(bad({ CLAMD_CONNECT_TIMEOUT_MS: "50" })).toBe(false);
    expect(bad({ CLAMD_MIN_BYTES_PER_SECOND: "-1" })).toBe(false);
  });
});
