import { randomBytes } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { tryLoadConfig } from "./load.js";
import { ENV_KEYS, envSchema, LEGACY_ENV_NAMES, SECRET_KEYS } from "./schema.js";

/*
 * Env-name drift guard (E2.9 decision 4). Every environment variable name a deploy artifact sets
 * or references must be a key of the config schema (or its `<KEY>_FILE` twin), or a name that is
 * not the app's at all and is listed below with the reason. A typo in a template (`SMTP_URI`) is
 * otherwise silently ignored by the app, which then boots with a default.
 *
 * Also: every template sets what the schema requires, and every PaaS process environment in
 * deploy/platforms/source.mjs passes the real config loader (cross-field rules included).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** Names that are not FundRoom config keys, and why they may appear in a deploy artifact. */
const NOT_APP_KEYS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^POSTGRES_[A-Z_]+$/u, "the postgres image's own initialisation variables"],
  [/^PGBACKREST_[A-Z0-9_]+$/u, "pgBackRest configuration (compose.backup.yaml)"],
  [/^SERVICE_[A-Z0-9_]+$/u, "Coolify's generated values (SERVICE_URL_*, SERVICE_PASSWORD_*, …)"],
  [/^RAILWAY_[A-Z_]+$/u, "variables Railway provides to a service (RAILWAY_PUBLIC_DOMAIN)"],
  [
    /^(?:FUNDROOM_DOMAIN|ACME_EMAIL|ACME_CA|ACME_CA_ROOT|SSL_CERT_FILE|EDGE_EXPOSE_METRICS|EDGE_TRUSTED_PROXIES|FUNDROOM_BASE_PATH|SEEDHOST_BASE_PATH)$/u,
    "Caddy's environment",
  ],
  [/^FUNDROOM_IMAGE$/u, "Compose interpolation: which image tag to run"],
  [
    /^(?:SEEDHOST_DOMAIN|SEEDHOST_IMAGE)$/u,
    "Compose interpolation: pre-rename names, read when FUNDROOM_DOMAIN / FUNDROOM_IMAGE are unset (A-2)",
  ],
  [
    /^FUNDROOM_CNPG_URI$/u,
    "Helm: the CNPG app Secret's uri, expanded into DATABASE_URL with sslmode",
  ],
  [/^COMPOSE_PROFILES$/u, "Compose's own profile selector"],
];

/** Schema keys plus their pre-rename names, which the loader still reads (LEGACY_ENV_NAMES). */
const KNOWN = new Set<string>([...ENV_KEYS, ...Object.values(LEGACY_ENV_NAMES)]);

function isKnown(name: string): boolean {
  if (KNOWN.has(name)) return true;
  if (name.endsWith("_FILE") && KNOWN.has(name.slice(0, -"_FILE".length))) return true;
  return NOT_APP_KEYS.some(([re]) => re.test(name));
}

const NAME = "[A-Z][A-Z0-9_]*";

function matchAll(text: string, re: RegExp): string[] {
  return [...text.matchAll(re)].map((m) => m[1] as string);
}

/** `${VAR}`, `${VAR:-x}`, `${VAR:?}`, `$VAR`, and Railway's `${{service.VAR}}`. */
function interpolations(text: string): string[] {
  return [
    ...matchAll(text, new RegExp(`\\$\\{(${NAME})(?::?[-?+][^}]*)?\\}`, "gu")),
    ...matchAll(text, new RegExp(`\\$\\{\\{[A-Za-z0-9_-]+\\.(${NAME})\\}\\}`, "gu")),
    ...matchAll(text, new RegExp(`\\$\\{\\{(${NAME})\\}\\}`, "gu")),
  ];
}

const BEGIN = "<!-- BEGIN GENERATED";
const END = "<!-- END GENERATED -->";

/** Names in a README's generated block: table rows, `NAME=value`, `NAME="…"`, references. */
function readmeNames(text: string): string[] {
  const start = text.indexOf(BEGIN);
  const end = text.indexOf(END);
  if (start < 0 || end < start) return [];
  const block = text.slice(start, end);
  return [
    ...matchAll(block, new RegExp(`^\\| \`(${NAME})\``, "gmu")),
    ...matchAll(block, new RegExp(`^\\s+(${NAME})="`, "gmu")),
    ...matchAll(block, new RegExp(`\`(${NAME})=`, "gu")),
    ...interpolations(block),
  ];
}

/** Render Blueprint: `key: NAME` and `envVarKey: NAME`. */
function renderNames(text: string): string[] {
  return [
    ...matchAll(text, new RegExp(`^\\s*(?:- )?key: "?(${NAME})"?$`, "gmu")),
    ...matchAll(text, new RegExp(`^\\s*envVarKey: "?(${NAME})"?$`, "gmu")),
  ];
}

/** fly.toml: the `[env]` table plus the `# secret: NAME` lines. */
function flyNames(text: string): string[] {
  const names = matchAll(text, new RegExp(`^# secret: (${NAME}) `, "gmu"));
  let inEnv = false;
  for (const line of text.split("\n")) {
    if (/^\[/u.test(line)) inEnv = line.trim() === "[env]";
    const m = inEnv ? new RegExp(`^(${NAME})\\s*=`, "u").exec(line) : null;
    if (m) names.push(m[1] as string);
  }
  return names;
}

/**
 * Compose `environment:` entries — map form (`NAME: value`) or list form (`- NAME=value`,
 * `- NAME`) — of the services `only` names (all when omitted), plus the `x-…env…` anchors those
 * services merge. Interpolations (`${NAME}`) are collected too when `withInterpolations` is set.
 */
function composeEnvNames(
  text: string,
  only?: readonly string[],
  withInterpolations = false,
): string[] {
  const names: string[] = [];
  let top = "";
  let service = "";
  let envIndent = -1;
  for (const raw of text.split("\n")) {
    if (/^\s*(?:#|$)/u.test(raw)) continue;
    const indent = raw.length - raw.trimStart().length;
    const key = /^\s*([A-Za-z0-9_.-]+):/u.exec(raw)?.[1];
    if (indent === 0 && key) {
      top = key;
      service = "";
      envIndent = -1;
      continue;
    }
    if (top === "services" && indent === 2 && key) {
      service = key;
      envIndent = -1;
      continue;
    }
    const wanted = top === "services" && (only === undefined || only.includes(service));
    const envAnchor = top.startsWith("x-") && top.includes("env");
    if (wanted && key === "environment") {
      envIndent = indent;
      continue;
    }
    if (envIndent >= 0 && indent <= envIndent) envIndent = -1;
    const inEnv = (wanted && envIndent >= 0) || (envAnchor && indent === 2);
    if (!inEnv) continue;
    const name = new RegExp(`^\\s*(?:- )?"?(${NAME})(?:[:=]|"?$)`, "u").exec(raw)?.[1];
    if (name) names.push(name);
    if (withInterpolations) names.push(...interpolations(raw));
  }
  return names;
}

/** The app's own services in the reference Compose files; db, caddy, backup, … are not the app. */
const composeAppNames = (text: string) => composeEnvNames(text, ["app", "worker", "migrate"]);

/** Helm: `- name: NAME` env entries and `NAME: value` ConfigMap/Secret data keys. */
function helmNames(text: string): string[] {
  const names: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#") || line.startsWith("{{/*") || line.startsWith("{{- /*")) continue;
    const env = new RegExp(`^-?\\s*name:\\s*"?(${NAME})"?\\s*$`, "u").exec(line)?.[1];
    const data = new RegExp(`^(${NAME}):\\s`, "u").exec(line)?.[1];
    for (const n of [env, data]) if (n !== undefined && n.length > 2) names.push(n);
  }
  return names;
}

function filesIn(dir: string, pattern: RegExp): string[] {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => pattern.test(f))
    .sort()
    .map((f) => relative(ROOT, join(abs, f)));
}

interface Artifact {
  readonly path: string;
  readonly names: readonly string[];
  /** What the drift-free template must set (checked for the templates, not the overlays). */
  readonly mustSet: readonly string[];
}

/** Schema keys with no default that must be present. */
const SCHEMA_REQUIRED = ENV_KEYS.filter(
  (k) => !envSchema.shape[k as keyof typeof envSchema.shape].safeParse(undefined).success,
);
/** Plus the cross-field ones every template needs: the master key, and mail in APP_ENV=prod. */
const PAAS_REQUIRED = [...SCHEMA_REQUIRED, "FUNDROOM_SECRET_KEY", "MAIL_FROM", "SMTP_URL"];

function artifacts(): Artifact[] {
  const out: Artifact[] = [];
  const add = (path: string, names: string[], mustSet: readonly string[] = []) =>
    out.push({ path, names, mustSet });

  add("deploy/render/render.yaml", renderNames(read("deploy/render/render.yaml")), PAAS_REQUIRED);
  add("deploy/fly/fly.toml", flyNames(read("deploy/fly/fly.toml")), PAAS_REQUIRED);
  for (const path of filesIn("deploy/coolify", /\.ya?ml$/u)) {
    add(path, composeEnvNames(read(path), undefined, true), PAAS_REQUIRED);
  }
  for (const dir of ["deploy/render", "deploy/railway", "deploy/fly", "deploy/coolify"]) {
    for (const path of filesIn(dir, /\.md$/u)) {
      add(path, readmeNames(read(path)), dir === "deploy/railway" ? PAAS_REQUIRED : []);
    }
  }
  for (const path of filesIn("deploy/compose", /\.ya?ml$/u)) {
    add(path, composeAppNames(read(path)), path.endsWith("/compose.yaml") ? SCHEMA_REQUIRED : []);
  }
  const chart = "deploy/helm/fundroom";
  if (existsSync(join(ROOT, chart))) {
    const helm = [
      `${chart}/values.yaml`,
      ...filesIn(`${chart}/templates`, /\.(?:ya?ml|tpl)$/u),
    ].filter((p) => existsSync(join(ROOT, p)));
    const names = helm.flatMap((p) => helmNames(read(p)));
    add(chart, names, [...SCHEMA_REQUIRED, "FUNDROOM_SECRET_KEY"]);
  }
  return out;
}

describe("deploy artifacts use only config keys", () => {
  const all = artifacts();

  it("finds the artifacts and the names in them", () => {
    // Guards the extractors: a regex that stops matching would make every assertion vacuous.
    expect(SCHEMA_REQUIRED.sort()).toEqual(["BASE_URL", "DATABASE_URL"]);
    for (const a of all) {
      if (a.mustSet.length > 0) expect(a.names.length, a.path).toBeGreaterThan(5);
    }
    expect(all.map((a) => a.path)).toEqual(
      expect.arrayContaining([
        "deploy/render/render.yaml",
        "deploy/fly/fly.toml",
        "deploy/coolify/compose.coolify.yaml",
        "deploy/coolify/compose.coolify-caddy.yaml",
        "deploy/railway/README.md",
        "deploy/compose/compose.yaml",
      ]),
    );
  });

  it.each(all.map((a) => [a.path, a] as const))("%s names only known keys", (_path, a) => {
    const unknown = [...new Set(a.names)].filter((n) => !isKnown(n)).sort();
    expect(unknown, "not in ENV_KEYS, not <KEY>_FILE, not allowlisted in this test").toEqual([]);
  });

  it.each(all.filter((a) => a.mustSet.length > 0).map((a) => [a.path, a] as const))(
    "%s sets every required key",
    (_path, a) => {
      const names = new Set(a.names);
      // The master key under its new name, the ring, or (A-2 FIX: Render's Blueprint, one minor
      // release) its old name, which the loader still reads.
      const missing = a.mustSet.filter(
        (k) =>
          !names.has(k) &&
          !(
            k === "FUNDROOM_SECRET_KEY" &&
            (names.has("SECRET_KEY_RING") || names.has(LEGACY_ENV_NAMES[k] as string))
          ),
      );
      expect(missing).toEqual([]);
    },
  );

  it("the compose worker profile is a valid worker process", () => {
    const worker = composeAppNames(read("deploy/compose/compose.yaml"));
    expect(worker).toContain("ROLES");
    const block = read("deploy/compose/compose.yaml").split(/^ {2}worker:$/mu)[1] ?? "";
    const service = block.split(/^ {2}[a-z]+:$/mu)[0] ?? "";
    expect(service).toMatch(/^\s+ROLES: worker$/mu);
    // ROLES=worker + WORKER_MODE=external is rejected by crossFieldRules.
    expect(service).not.toMatch(/^\s+WORKER_MODE:/mu);
  });
});

// --- every PaaS process environment passes the real loader --------------------------------------

interface EnvVar {
  name: string;
  formerly?: string;
  formerlySet?: "both" | "old";
  kind: "literal" | "generate" | "prompt" | "database" | "baseUrl";
  processes: Array<"web" | "worker">;
  bytes?: number;
  example?: string;
  value?: string | Partial<Record<"web" | "worker", string>>;
}
interface Source {
  envFor(platform: string): EnvVar[];
  literalFor(entry: EnvVar, process: "web" | "worker"): string | undefined;
  PLATFORMS: Record<string, { processes: Array<"web" | "worker"> }>;
}

// Dynamic import: the source is a plain .mjs outside this package (no build step, no types).
const source = (await import(
  pathToFileURL(join(ROOT, "deploy/platforms/source.mjs")).href
)) as Source;

/** A value of the shape each platform generates for a secret. */
function generated(platform: string, e: EnvVar): string {
  const bytes = e.bytes ?? 32;
  if (platform === "render") return randomBytes(32).toString("base64"); // generateValue
  if (platform === "railway") return randomBytes(bytes).toString("hex"); // secret(2n, hex)
  if (platform.startsWith("coolify")) {
    return {
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"), // SERVICE_REALBASE64_*
      SESSION_SECRET: "a1B2".repeat(16), // SERVICE_PASSWORD_64_*
      SETUP_TOKEN: randomBytes(16).toString("hex"), // SERVICE_HEX_32_*
      METRICS_TOKEN: "a1B2".repeat(8), // SERVICE_PASSWORD_*
    }[e.name] as string;
  }
  // fly: the README's openssl commands
  return e.name === "FUNDROOM_SECRET_KEY"
    ? randomBytes(bytes).toString("base64")
    : randomBytes(bytes).toString("hex");
}

const PROMPTED: Readonly<Record<string, string>> = {
  S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  S3_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  S3_ENDPOINT: "https://0123456789abcdef.r2.cloudflarestorage.com",
};

describe("PaaS process environments load", () => {
  const cases = Object.keys(source.PLATFORMS).flatMap((platform) =>
    source.PLATFORMS[platform]!.processes.map((proc) => [platform, proc] as const),
  );

  it.each(cases)("%s %s", (platform, proc) => {
    const env: Record<string, string> = {};
    for (const e of source.envFor(platform)) {
      if (!e.processes.includes(proc)) continue;
      const value = {
        literal: () => source.literalFor(e, proc) as string,
        generate: () => generated(platform, e),
        prompt: () => PROMPTED[e.name] ?? (e.example as string),
        database: () => "postgres://seedhost:secret@db:5432/seedhost",
        baseUrl: () => "https://investors.example.com",
      }[e.kind]();
      // A-2 FIX: the names the template sets (render-deploy-templates.mjs `templateNames`): the
      // old one only (Render), or both with one value (Coolify), which the loader must accept.
      const names =
        e.formerly === undefined || e.formerlySet === undefined
          ? [e.name]
          : e.formerlySet === "old"
            ? [e.formerly]
            : [e.name, e.formerly];
      for (const name of names) env[name] = value;
    }
    // Fly passes roles as `serve --roles …` because its [env] is app-wide.
    if (platform === "fly") env["ROLES"] = proc === "web" ? "api,web" : "worker";
    const result = tryLoadConfig({ env });
    expect(result.ok ? [] : result.error.issues).toEqual([]);
    if (result.ok) {
      expect([...result.config.roles].sort()).toEqual(
        proc === "worker"
          ? ["worker"]
          : platform.startsWith("coolify")
            ? ["api", "web", "worker"]
            : ["api", "web"],
      );
      expect(result.config.appEnv).toBe("prod");
      expect(result.config.raw.MIGRATE_ON_START).toBe(false);
    }
  });
});

// --- the Helm README quickstart boots under the prod rules -----------------------------------

/** The values file the Helm README's Install section writes (`cat > fundroom-values.yaml <<'EOF'`). */
function helmQuickstartValues(): Record<string, string> {
  const readme = read("deploy/helm/fundroom/README.md");
  const block = /^cat > fundroom-values\.yaml <<'EOF'\n([\s\S]*?)^EOF$/mu.exec(readme)?.[1];
  if (block === undefined) throw new Error("Helm README quickstart block not found");
  return flatValues(block);
}

/** A flat reading of a nested values map: `a.b.c` → scalar. Scalars only (no lists). */
function flatValues(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const path: string[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\s+#.*$/u, "");
    if (/^\s*(?:#|$)/u.test(line)) continue;
    const m = /^( *)([A-Za-z0-9_]+):\s*(.*)$/u.exec(line);
    if (!m) throw new Error(`unexpected values line: ${raw}`);
    const depth = (m[1] as string).length / 2;
    path.length = depth;
    path.push(m[2] as string);
    const value = (m[3] as string).replace(/^"(.*)"$/u, "$1");
    if (value !== "") out[path.join(".")] = value;
  }
  return out;
}

/** How the chart maps each quickstart value onto the app env (templates/_helpers.tpl). */
const HELM_VALUE_ENV: Readonly<Record<string, string | null>> = {
  "config.baseUrl": "BASE_URL",
  "config.mail.from": "MAIL_FROM",
  "config.av.acceptUnscanned": "AV_ACCEPT_UNSCANNED",
  "secrets.secretKey": "FUNDROOM_SECRET_KEY",
  "secrets.smtpUrl": "SMTP_URL",
  "storage.s3.bucket": "S3_BUCKET",
  "storage.s3.region": "S3_REGION",
  "storage.s3.accessKeyId": "S3_ACCESS_KEY_ID",
  "storage.s3.secretAccessKey": "S3_SECRET_ACCESS_KEY",
  "postgresql.external.url": "DATABASE_URL",
  "ingress.enabled": null,
  "ingress.className": null,
  "ingress.clusterIssuer": null,
};

describe("Helm README quickstart", () => {
  it("loads with the chart's defaults (APP_ENV=prod) in the server, worker and migrate env", () => {
    const values = helmQuickstartValues();
    const unmapped = Object.keys(values).filter((k) => !(k in HELM_VALUE_ENV));
    expect(unmapped, "map new quickstart values in HELM_VALUE_ENV").toEqual([]);
    // values.yaml defaults for everything the quickstart leaves alone.
    const env: Record<string, string> = {
      APP_ENV: "prod",
      MAILER_DRIVER: "smtp",
      STORAGE_DRIVER: "s3",
      AV_DRIVER: "noop",
      TRUST_PROXY: "true",
    };
    for (const [key, value] of Object.entries(values)) {
      const name = HELM_VALUE_ENV[key];
      if (name) env[name] = value;
    }
    env["FUNDROOM_SECRET_KEY"] = randomBytes(32).toString("base64"); // "<openssl rand -base64 32>"
    for (const roles of ["api,web", "worker"]) {
      const result = tryLoadConfig({ env: { ...env, ROLES: roles } });
      expect(result.ok ? [] : result.error.issues).toEqual([]);
    }
  });
});

// --- upgrading a pre-E2.10 install: every refusal says what to add ---------------------------

describe("E2.10 upgrade path", () => {
  /** A Compose `.env` as written before E2.10: plain STARTTLS, no AV decision. */
  const before: Record<string, string> = {
    APP_ENV: "prod",
    BASE_URL: "https://investors.example.com",
    DATABASE_URL: "postgres://seedhost:seedhost@db:5432/seedhost",
    // Written before the A-2 rename too: the old name still loads (with a warning).
    SEEDHOST_SECRET_KEY: randomBytes(32).toString("base64"),
    SMTP_URL: "smtp://user:pass@smtp.example.com:587",
    MAIL_FROM: "investors@example.com",
    AV_DRIVER: "noop",
  };

  it("names the exact line to add for each new refusal", () => {
    const managedDb = "postgres://u:p@db.example.com:5432/seedhost";
    const r = tryLoadConfig({ env: { ...before, DATABASE_URL: managedDb } });
    expect(r.ok).toBe(false);
    const byKey = new Map(r.ok ? [] : r.error.issues.map((i) => [i.key, i.message] as const));
    expect([...byKey.keys()].sort()).toEqual(["AV_DRIVER", "DATABASE_URL", "SMTP_URL"]);
    expect(byKey.get("AV_DRIVER")).toContain("AV_ACCEPT_UNSCANNED=true");
    expect(byKey.get("SMTP_URL")).toContain("?requireTLS=true");
    expect(byKey.get("DATABASE_URL")).toContain("sslmode=verify-full");
    for (const message of byKey.values()) expect(message).toContain("install-and-upgrade.md");
  });

  it("compose.yaml tells an upgrader which POSTGRES_PASSWORD their volume has", () => {
    const compose = read("deploy/compose/compose.yaml");
    const messages = [...compose.matchAll(/\$\{POSTGRES_PASSWORD:\?([^}]*)\}/gu)].map((m) => m[1]);
    expect(messages.length).toBeGreaterThanOrEqual(2);
    for (const m of messages) {
      expect(m).toContain("seedhost"); // the pre-E2.10 default the pgdata volume was created with
      expect(m).toContain("install-and-upgrade.md");
      expect(m).not.toMatch(/: /u); // a ": " inside a plain YAML scalar breaks the whole file
    }
  });

  it("the upgrade runbook lists every refusal with the line to add", () => {
    const runbook = read("docs/runbooks/install-and-upgrade.md");
    const section =
      runbook.split("## Upgrading to the security-hardening release")[1]?.split("\n## ")[0] ?? "";
    for (const line of [
      "AV_ACCEPT_UNSCANNED=true",
      "config.av.acceptUnscanned: true",
      "SMTP_URL=smtps://",
      "?requireTLS=true",
      "sslmode=verify-full",
      "postgresql.external.caSecret",
      "METRICS_TOKEN=",
      "POSTGRES_PASSWORD=seedhost",
      "RATE_LIMIT_MULTIPLIER",
      "CLIENT_IP_HEADER",
      "EDGE_TRUSTED_PROXIES",
    ]) {
      expect(section, line).toContain(line);
    }
  });
});

describe("E3.10 control plane in compose.yaml", () => {
  /** Every E3.10 key an operator sets; the vendor test seams (`*_API_BASE`) are left out. */
  const E310 = [
    "CONTROL_PLANE",
    "CELL_ID",
    "PLATFORM_OPERATOR_CIDRS",
    "SIGNUP_MODE",
    "SIGNUP_DEFAULT_PLAN",
    "BILLING_DRIVER",
    "BILLING_GRACE_DAYS",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "SANCTIONS_DRIVER",
    "SANCTIONS_OFAC_URL",
    "SANCTIONS_OPENSANCTIONS_URL",
    "SANCTIONS_OPENSANCTIONS_API_KEY",
    "SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS",
    "SANCTIONS_MATCH_THRESHOLD",
    "CLOUDFLARE_API_TOKEN",
    "CLOUDFLARE_ZONE_ID",
    "CLOUDFLARE_TRUSTED_PROXY",
    "CENTRAL_AUTH",
  ];
  const SECRETS = [
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "SANCTIONS_OPENSANCTIONS_API_KEY",
    "CLOUDFLARE_API_TOKEN",
  ];
  const anchor = (
    read("deploy/compose/compose.yaml").split(/^x-app-env: &app-env$/mu)[1] ?? ""
  ).split(/^\S/mu)[0] as string;
  /** `KEY: ${KEY:-default}` lines of the shared app environment → default (`undefined`: absent). */
  const defaults = new Map(
    [...anchor.matchAll(/^ {2}([A-Z][A-Z0-9_]*): \$\{\1:-([^}]*)\}$/gmu)].map(
      (m) => [m[1] as string, m[2] as string] as const,
    ),
  );

  it("passes every key (and each secret's _FILE form) through with an empty default", () => {
    for (const key of [...E310, ...SECRETS.map((k) => `${k}_FILE`)]) {
      expect(defaults.get(key), key).toBe("");
    }
  });

  it("the compose defaults keep a self-host exactly as it was (everything off)", () => {
    const env: Record<string, string> = {
      BASE_URL: "http://localhost:3000",
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      TENANCY_MODE: defaults.get("TENANCY_MODE") ?? "",
      CUSTOM_DOMAIN_DRIVER: defaults.get("CUSTOM_DOMAIN_DRIVER") ?? "",
    };
    for (const key of E310) env[key] = defaults.get(key) ?? "";
    const loaded = tryLoadConfig({ env });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config.raw).toMatchObject({
      CONTROL_PLANE: "off",
      SIGNUP_MODE: "off",
      BILLING_DRIVER: "none",
      SANCTIONS_DRIVER: "none",
      CENTRAL_AUTH: "off",
      CLOUDFLARE_TRUSTED_PROXY: "off",
      CUSTOM_DOMAIN_DRIVER: "caddy-ask",
    });
  });
});

describe("E3.11 data residency in compose.yaml", () => {
  const E311 = [
    "DATA_REGION",
    "DATA_REGION_LABEL",
    "DATA_REGION_JURISDICTION",
    "BACKUP_LOCATION",
    "DIRECTORY_DATABASE_URL",
    "DIRECTORY_DATABASE_POOL_MAX",
    "DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS",
    "MOVE_SOURCE_RETENTION_HOURS",
    "MOVE_MAX_BUNDLE_BYTES",
  ];
  const anchor = (
    read("deploy/compose/compose.yaml").split(/^x-app-env: &app-env$/mu)[1] ?? ""
  ).split(/^\S/mu)[0] as string;
  const defaults = new Map(
    [...anchor.matchAll(/^ {2}([A-Z][A-Z0-9_]*): \$\{\1:-([^}]*)\}$/gmu)].map(
      (m) => [m[1] as string, m[2] as string] as const,
    ),
  );

  it("passes every key (and the directory URL's _FILE form) through with an empty default", () => {
    for (const key of [...E311, "DIRECTORY_DATABASE_URL_FILE"]) {
      expect(defaults.get(key), key).toBe("");
    }
  });

  it("the compose defaults keep a self-host exactly as it was (nothing declared, local directory)", () => {
    const env: Record<string, string> = {
      BASE_URL: "http://localhost:3000",
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
    };
    for (const key of E311) env[key] = defaults.get(key) ?? "";
    const loaded = tryLoadConfig({ env });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config.raw.DATA_REGION).toBeUndefined();
    expect(loaded.config.raw.DIRECTORY_DATABASE_URL).toBeUndefined();
  });
});

describe("E3.12 AI assist in compose.yaml", () => {
  const E312 = [
    "AI_PROVIDER",
    "AI_BASE_URL",
    "AI_API_KEY",
    "AI_MODEL",
    "AI_HOSTING",
    "AI_PROVIDER_LABEL",
    "AI_PROVIDER_LOCATION",
    "AI_PROVIDER_JURISDICTION",
    "AI_JSON_MODE",
    "AI_TOKEN_PARAM",
    "AI_TIMEOUT_MS",
    "AI_MAX_OUTPUT_TOKENS",
    "AI_MAX_INPUT_CHARS",
    "AI_CONCURRENCY",
    "AI_MONTHLY_TOKEN_BUDGET",
    "AI_REQUESTS_PER_USER_HOUR",
    "AI_RESULT_RETENTION_HOURS",
  ];
  const anchor = (
    read("deploy/compose/compose.yaml").split(/^x-app-env: &app-env$/mu)[1] ?? ""
  ).split(/^\S/mu)[0] as string;
  const defaults = new Map(
    [...anchor.matchAll(/^ {2}([A-Z][A-Z0-9_]*): \$\{\1:-([^}]*)\}$/gmu)].map(
      (m) => [m[1] as string, m[2] as string] as const,
    ),
  );

  it("passes every key (and the API key's _FILE form) through with an empty default", () => {
    for (const key of [...E312, "AI_API_KEY_FILE"]) {
      expect(defaults.get(key), key).toBe("");
    }
  });

  it("the compose defaults keep a self-host exactly as it was (AI off)", () => {
    const env: Record<string, string> = {
      BASE_URL: "http://localhost:3000",
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
    };
    for (const key of E312) env[key] = defaults.get(key) ?? "";
    const loaded = tryLoadConfig({ env });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config.raw.AI_PROVIDER).toBe("none");
    expect(loaded.config.raw.AI_MODEL).toBeUndefined();
  });
});

describe("E-UP-7 edge forwarding in the deploy surfaces", () => {
  const E_UP_7 = [
    "FORWARDED_HOST_HEADER",
    "FORWARDED_CLIENT_IP_HEADER",
    "EDGE_SHARED_SECRET",
    "EDGE_SHARED_SECRET_PREVIOUS",
  ];
  const SECRETS = ["EDGE_SHARED_SECRET", "EDGE_SHARED_SECRET_PREVIOUS"];
  const anchor = (
    read("deploy/compose/compose.yaml").split(/^x-app-env: &app-env$/mu)[1] ?? ""
  ).split(/^\S/mu)[0] as string;
  const defaults = new Map(
    [...anchor.matchAll(/^ {2}([A-Z][A-Z0-9_]*): \$\{\1:-([^}]*)\}$/gmu)].map(
      (m) => [m[1] as string, m[2] as string] as const,
    ),
  );

  it("the secrets are config secrets (redacted, refused in Helm config.extra)", () => {
    for (const key of SECRETS) expect(SECRET_KEYS.has(key), key).toBe(true);
    for (const key of E_UP_7) expect(ENV_KEYS, key).toContain(key);
  });

  it("compose passes every key (and each secret's _FILE form) through with an empty default", () => {
    for (const key of [...E_UP_7, ...SECRETS.map((k) => `${k}_FILE`)]) {
      expect(defaults.get(key), key).toBe("");
    }
  });

  it("the compose defaults keep a self-host exactly as it was (edge forwarding off)", () => {
    const env: Record<string, string> = {
      BASE_URL: "http://localhost:3000",
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
    };
    for (const key of [...E_UP_7, ...SECRETS.map((k) => `${k}_FILE`)]) {
      env[key] = defaults.get(key) ?? "";
    }
    const loaded = tryLoadConfig({ env });
    expect(loaded.ok ? [] : loaded.error.issues).toEqual([]);
    if (!loaded.ok) return;
    expect(loaded.config.raw.FORWARDED_HOST_HEADER).toBeUndefined();
    expect(loaded.config.raw.EDGE_SHARED_SECRET).toBeUndefined();
  });

  it("the Helm values say where each key goes (config.extra / secrets.extra, no own values)", () => {
    const values = read("deploy/helm/fundroom/values.yaml");
    const comment = (lead: string) => values.split(lead)[1]?.split(/^ {2}extra: \{\}$/mu)[0] ?? "";
    const configExtra = comment("# -- Any other non-secret env keys");
    const secretsExtra = comment("# -- Any other secret env keys");
    for (const key of E_UP_7) expect(configExtra, `config.extra: ${key}`).toContain(key);
    for (const key of SECRETS) expect(secretsExtra, `secrets.extra: ${key}`).toContain(key);
    // No first-class value: the chart's templates never render the keys themselves.
    const templates = filesIn("deploy/helm/fundroom/templates", /\.(?:ya?ml|tpl)$/u)
      .map(read)
      .join("\n");
    for (const key of ["FORWARDED_HOST_HEADER", "FORWARDED_CLIENT_IP_HEADER"]) {
      expect(templates, key).not.toContain(key);
    }
  });

  it(".env.example documents every key as a commented line", () => {
    const example = read(".env.example");
    for (const key of E_UP_7) expect(example).toMatch(new RegExp(`^#${key}=`, "mu"));
  });

  it("the generated PaaS templates do not set them", () => {
    const generated = artifacts().filter((x) =>
      /^deploy\/(?:render|railway|fly|coolify)\//u.test(x.path),
    );
    expect(generated.length).toBeGreaterThan(4);
    for (const a of generated) {
      for (const key of E_UP_7) expect(a.names, `${a.path} ${key}`).not.toContain(key);
    }
  });
});

describe("E-UP-4 signup terms and footer links in the deploy surfaces", () => {
  const E_UP_4 = ["SIGNUP_TERMS_VERSION", "TERMS_URL", "PRIVACY_URL", "SUPPORT_URL", "STATUS_URL"];
  const anchor = (
    read("deploy/compose/compose.yaml").split(/^x-app-env: &app-env$/mu)[1] ?? ""
  ).split(/^\S/mu)[0] as string;
  const defaults = new Map(
    [...anchor.matchAll(/^ {2}([A-Z][A-Z0-9_]*): \$\{\1:-([^}]*)\}$/gmu)].map(
      (m) => [m[1] as string, m[2] as string] as const,
    ),
  );

  it("are config keys and none is a secret (plain config.extra values)", () => {
    for (const key of E_UP_4) {
      expect(ENV_KEYS, key).toContain(key);
      expect(SECRET_KEYS.has(key), key).toBe(false);
    }
  });

  it("compose passes every key through with an empty default", () => {
    for (const key of E_UP_4) expect(defaults.get(key), key).toBe("");
  });

  it("the compose defaults keep a self-host exactly as it was (no links, terms v1)", () => {
    const env: Record<string, string> = {
      BASE_URL: "http://localhost:3000",
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
    };
    for (const key of E_UP_4) env[key] = defaults.get(key) ?? "";
    const loaded = tryLoadConfig({ env });
    expect(loaded.ok ? [] : loaded.error.issues).toEqual([]);
    if (!loaded.ok) return;
    expect(loaded.config.raw.SIGNUP_TERMS_VERSION).toBe(1);
    for (const key of ["TERMS_URL", "PRIVACY_URL", "SUPPORT_URL", "STATUS_URL"] as const) {
      expect(loaded.config.raw[key], key).toBeUndefined();
    }
  });

  it("the Helm values say they go in config.extra (no own values)", () => {
    const values = read("deploy/helm/fundroom/values.yaml");
    const configExtra =
      values.split("# -- Any other non-secret env keys")[1]?.split(/^ {2}extra: \{\}$/mu)[0] ?? "";
    for (const key of E_UP_4) expect(configExtra, `config.extra: ${key}`).toContain(key);
    const templates = filesIn("deploy/helm/fundroom/templates", /\.(?:ya?ml|tpl)$/u)
      .map(read)
      .join("\n");
    for (const key of E_UP_4) expect(templates, key).not.toContain(key);
  });

  it(".env.example documents every key as a commented line", () => {
    const example = read(".env.example");
    for (const key of E_UP_4) expect(example).toMatch(new RegExp(`^#${key}=`, "mu"));
  });

  it("the generated PaaS templates do not set them", () => {
    const generated = artifacts().filter((x) =>
      /^deploy\/(?:render|railway|fly|coolify)\//u.test(x.path),
    );
    expect(generated.length).toBeGreaterThan(4);
    for (const a of generated) {
      for (const key of E_UP_4) expect(a.names, `${a.path} ${key}`).not.toContain(key);
    }
  });
});

describe("Helm chart secret keys", () => {
  const tpl = read("deploy/helm/fundroom/templates/_helpers.tpl");
  /** Secret keys under every name the loader reads (A-2: the old names are secrets too). */
  const secretNames = [
    ...SECRET_KEYS,
    ...Object.entries(LEGACY_ENV_NAMES)
      .filter(([key]) => SECRET_KEYS.has(key))
      .map(([, old]) => old as string),
  ].sort();

  it("mirrors SECRET_KEYS and their old names exactly (config.extra must refuse every secret)", () => {
    const line =
      /fundroom\.secretEnvKeys" -\}\}\s*\{\{- list ((?:"[A-Z0-9_]+" ?)+)\| toJson -\}\}/u.exec(tpl);
    expect(line, "the secretEnvKeys list in _helpers.tpl").not.toBeNull();
    const chart = matchAll(line?.[1] ?? "", /"([A-Z0-9_]+)"/gu).sort();
    expect(chart).toEqual(secretNames);
  });

  it("the chart's Secrets carry the master key under both names, one value (A-2 FIX)", () => {
    // An old-ReplicaSet pod restarted mid-rollout (or a rollback) runs an image that reads only
    // SEEDHOST_SECRET_KEY; without it, it would generate a throwaway key into /data.
    for (const define of ["fundroom.secretData", "fundroom.migrateSecretData"]) {
      const body = tpl.split(`{{- define "${define}" -}}`)[1]?.split("{{- end -}}")[0] ?? "";
      expect(body, define).toMatch(/^FUNDROOM_SECRET_KEY: \{\{ \$s\.secretKey \| quote \}\}$/mu);
      expect(body, define).toMatch(/^SEEDHOST_SECRET_KEY: \{\{ \$s\.secretKey \| quote \}\}$/mu);
    }
  });

  it("reserves both names of the master key (secrets.extra cannot smuggle in a second key)", () => {
    const reserved = /fundroom\.reservedEnvKeys" -\}\}\s*\{\{- list([\s\S]*?)\| toJson -\}\}/u.exec(
      tpl,
    )?.[1];
    expect(reserved, "the reservedEnvKeys list in _helpers.tpl").toBeDefined();
    const names = new Set(matchAll(reserved ?? "", /"([A-Z0-9_]+)"/gu));
    expect(names.has("FUNDROOM_SECRET_KEY")).toBe(true);
    expect(names.has("SEEDHOST_SECRET_KEY")).toBe(true);
  });
});

// --- A-2: renamed variables keep an upgraded Compose install's values --------------------------

describe("A-2 renamed variables in compose.yaml", () => {
  const compose = read("deploy/compose/compose.yaml");
  const anchor = (compose.split(/^x-app-env: &app-env$/mu)[1] ?? "").split(/^\S/mu)[0] as string;

  it("passes the master key through under both names, each with an empty default", () => {
    // Folding the old name into the new one (${FUNDROOM_SECRET_KEY:-${SEEDHOST_SECRET_KEY:-}})
    // would hide which one an .env uses, so doctor could not warn and both-set could not refuse.
    expect(anchor).toMatch(/^ {2}FUNDROOM_SECRET_KEY: \$\{FUNDROOM_SECRET_KEY:-\}$/mu);
    expect(anchor).toMatch(/^ {2}SEEDHOST_SECRET_KEY: \$\{SEEDHOST_SECRET_KEY:-\}$/mu);
  });

  it("an .env from before the rename keeps its key (and is told to rename it)", () => {
    const key = randomBytes(32).toString("base64");
    // What Compose hands the app for an .env that only sets the old name.
    const env = {
      BASE_URL: "http://localhost:3000",
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
      FUNDROOM_SECRET_KEY: "",
      SEEDHOST_SECRET_KEY: key,
    };
    const loaded = tryLoadConfig({ env });
    expect(loaded.ok ? [] : loaded.error.issues).toEqual([]);
    if (!loaded.ok) return;
    expect(loaded.config.raw.FUNDROOM_SECRET_KEY).toBe(key);
    expect(loaded.config.legacyEnv).toEqual([
      { key: "FUNDROOM_SECRET_KEY", legacy: "SEEDHOST_SECRET_KEY" },
    ]);
  });

  it("falls back to the old edge/image names when the new ones are unset", () => {
    expect(compose).toContain("image: ${FUNDROOM_IMAGE:-${SEEDHOST_IMAGE:-");
    expect(anchor).toContain(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a Compose interpolation, not a JS template.
      "BASE_URL: ${BASE_URL:-https://${FUNDROOM_DOMAIN:-${SEEDHOST_DOMAIN:-localhost}}}",
    );
    expect(compose).toMatch(
      /^ {6}FUNDROOM_DOMAIN: \$\{FUNDROOM_DOMAIN:-\$\{SEEDHOST_DOMAIN:-localhost\}\}$/mu,
    );
  });

  it("the Caddyfile honours the old edge names too, so an old edge keeps its refusals (A-2 FIX)", () => {
    // Compose hands Caddy the new names, but a Caddy run elsewhere may still set only the old
    // ones (the pre-rename doctor told operators to set SEEDHOST_BASE_PATH on the edge). Without
    // the old prefix in the matchers, `<base>/internal/*` and `<base>/metrics` became public.
    // The CI "Edge config is valid" step proves the adapted config with only SEEDHOST_* set.
    const caddyfile = read("deploy/caddy/Caddyfile");
    expect(caddyfile).toMatch(/^\{\$FUNDROOM_DOMAIN\} \{\$SEEDHOST_DOMAIN\} \{$/mu);
    expect(caddyfile).toMatch(
      /@internal path \/internal\/\* \{\$FUNDROOM_BASE_PATH\}\/internal\/\* \{\$SEEDHOST_BASE_PATH\}\/internal\/\*$/mu,
    );
    for (const p of ["/metrics", "/metrics/"]) {
      expect(caddyfile).toContain(`{$SEEDHOST_BASE_PATH}${p}`);
      expect(caddyfile).toContain(`{$FUNDROOM_BASE_PATH}${p}`);
    }
    expect(caddyfile).toContain(
      "ask http://app:3000{$FUNDROOM_BASE_PATH}{$SEEDHOST_BASE_PATH}/internal/tls/ask",
    );
    expect(caddyfile).toContain("health_uri {$FUNDROOM_BASE_PATH}{$SEEDHOST_BASE_PATH}/healthz");
    // …and refuses to parse with both base-path names set (the prefix would be doubled).
    expect(caddyfile).toMatch(
      /^\t@base_path_set_twice header_regexp \S+ \S+ \{\$FUNDROOM_BASE_PATH\} \{\$SEEDHOST_BASE_PATH\}$/mu,
    );
  });
});

// --- E3.11: the Helm chart's residency values ---------------------------------------------------

describe("E3.11 data residency in the Helm chart", () => {
  const E311 = [
    "DATA_REGION",
    "DATA_REGION_LABEL",
    "DATA_REGION_JURISDICTION",
    "BACKUP_LOCATION",
    "DIRECTORY_DATABASE_URL",
    "DIRECTORY_DATABASE_POOL_MAX",
    "DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS",
    "MOVE_SOURCE_RETENTION_HOURS",
    "MOVE_MAX_BUNDLE_BYTES",
  ];
  const chart = "deploy/helm/fundroom";
  const tpl = read(`${chart}/templates/_helpers.tpl`);
  /** The body of one `{{- define "fundroom.<name>" -}}` block. */
  const define = (name: string) =>
    tpl.split(`{{- define "fundroom.${name}" -}}`)[1]?.split(/^\{\{- end -\}\}$/mu)[0] ?? "";

  it("renders every residency key from a dedicated value", () => {
    const rendered = new Set([
      ...helmNames(define("configData")),
      ...helmNames(define("secretData")),
    ]);
    for (const key of E311) expect(rendered.has(key), key).toBe(true);
  });

  it("refuses the residency keys in config.extra and secrets.extra (the chart sets them)", () => {
    const reserved = matchAll(define("reservedEnvKeys"), /"([A-Z0-9_]+)"/gu);
    for (const key of E311) expect(reserved, key).toContain(key);
  });

  it("sizes the server/worker /data scratch by a value (exports and moves spool there)", () => {
    // Before E3.11 it was a fixed 64Mi emptyDir, so any export or move bundle past that evicted
    // the worker mid-job.
    expect(define("volumes")).toContain("$root.Values.dataScratchSizeLimit");
    const limit = /^dataScratchSizeLimit: (\S+)$/mu.exec(read(`${chart}/values.yaml`))?.[1];
    expect(limit).toMatch(/^[0-9]+Gi$/u);
  });

  it("gives the migrate hook the directory URL (migrate applies the directory's migrations)", () => {
    expect(helmNames(define("migrateSecretData"))).toContain("DIRECTORY_DATABASE_URL");
    // …and from residency.directory.existingSecret, in every pod including the hook.
    expect(define("databaseEnv")).toMatch(
      /- name: DIRECTORY_DATABASE_URL\n\s+valueFrom:\n\s+secretKeyRef:/u,
    );
  });

  /**
   * The env each process of the CI fixture `ci/residency-values.yaml` gets under the chart's
   * defaults: ConfigMap for every process, the chart Secret for server/worker, the hook Secret plus
   * the migrate Job's literal overrides for the hook.
   */
  function fixtureEnv(hookBranch: "directory" | "none") {
    const values = flatValues(read(`${chart}/ci/residency-values.yaml`));
    const VALUE_ENV: Readonly<Record<string, readonly [string, "config" | "secret" | "hook"]>> = {
      "config.baseUrl": ["BASE_URL", "config"],
      "config.mail.from": ["MAIL_FROM", "config"],
      "config.av.acceptUnscanned": ["AV_ACCEPT_UNSCANNED", "config"],
      "config.tenancyMode": ["TENANCY_MODE", "config"],
      "storage.s3.bucket": ["S3_BUCKET", "config"],
      "storage.s3.region": ["S3_REGION", "config"],
      "storage.s3.accessKeyId": ["S3_ACCESS_KEY_ID", "secret"],
      "storage.s3.secretAccessKey": ["S3_SECRET_ACCESS_KEY", "secret"],
      "secrets.secretKey": ["FUNDROOM_SECRET_KEY", "hook"],
      "secrets.smtpUrl": ["SMTP_URL", "secret"],
      "postgresql.external.url": ["DATABASE_URL", "hook"],
      "residency.region": ["DATA_REGION", "config"],
      "residency.regionLabel": ["DATA_REGION_LABEL", "config"],
      "residency.jurisdiction": ["DATA_REGION_JURISDICTION", "config"],
      "residency.backupLocation": ["BACKUP_LOCATION", "config"],
      "residency.directory.databaseUrl": ["DIRECTORY_DATABASE_URL", "hook"],
      "residency.moves.sourceRetentionHours": ["MOVE_SOURCE_RETENTION_HOURS", "config"],
    };
    const config: Record<string, string> = {
      APP_ENV: "prod",
      MAILER_DRIVER: "smtp",
      STORAGE_DRIVER: "s3",
      AV_DRIVER: "noop",
      TRUST_PROXY: "true",
    };
    const secret: Record<string, string> = {};
    const hookSecret: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (key.startsWith("config.extra.")) {
        config[key.slice("config.extra.".length)] = value;
        continue;
      }
      const mapped = VALUE_ENV[key];
      if (mapped === undefined) throw new Error(`map ${key} in this test`);
      const [name, where] = mapped;
      if (where === "config") config[name] = value;
      else {
        secret[name] = value;
        if (where === "hook") hookSecret[name] = value;
      }
    }
    // The migrate Job's literal `- name: X / value: "Y"` overrides, with the directory branch
    // of its `fundroom.directoryEnabled` conditional taken (or the other one).
    const job = read(`${chart}/templates/migrate-job.yaml`);
    const [before = "", rest = ""] = job.split(
      /^\s*\{\{- if include "fundroom\.directoryEnabled" \. \}\}$/mu,
    );
    expect(rest, "the migrate Job's directoryEnabled conditional").not.toBe("");
    const [ifBranch = "", elseAndAfter = ""] = rest.split(/^\s*\{\{- else \}\}$/mu);
    const [elseBranch = "", after = ""] = elseAndAfter.split(/^\s*\{\{- end \}\}$/mu);
    const pairs = (text: string) =>
      Object.fromEntries(
        [...text.matchAll(/- name: ([A-Z0-9_]+)\n\s+value: "([^"]*)"/gu)].map(
          (m) => [m[1] as string, m[2] as string] as const,
        ),
      );
    const overrides = {
      ...pairs(before.split('args: ["migrate"]')[1] ?? ""),
      ...pairs(hookBranch === "directory" ? ifBranch : elseBranch),
      ...pairs(after.split("fundroom.databaseEnv")[0] ?? ""),
    };
    return {
      server: { ...config, ...secret, ROLES: "api,web" },
      worker: { ...config, ...secret, ROLES: "worker" },
      hook: { ...config, ...hookSecret, ...overrides },
      overrides,
    };
  }

  it("a directory cell's server, worker and migrate hook all load under the prod rules", () => {
    const env = fixtureEnv("directory");
    expect(env.overrides).toMatchObject({ ROLES: "api", MIGRATE_ON_START: "false" });
    for (const [proc, e] of Object.entries({
      server: env.server,
      worker: env.worker,
      hook: env.hook,
    })) {
      const result = tryLoadConfig({ env: e });
      expect(result.ok ? [] : result.error.issues, proc).toEqual([]);
      if (result.ok) {
        expect(result.config.raw.DIRECTORY_DATABASE_URL, proc).toMatch(/^postgres:/u);
        expect(result.config.raw.DATA_REGION, proc).toBe("eu");
      }
    }
  });

  it("the hook's usual fs override would be refused with a directory (why the branch exists)", () => {
    const { hook } = fixtureEnv("none");
    const result = tryLoadConfig({ env: hook });
    expect(result.ok ? [] : result.error.issues.map((i) => i.key)).toContain("STORAGE_DRIVER");
  });
});
