import { createHash, X509Certificate } from "node:crypto";
import { describeKeyRing } from "./key-ring.js";
import type { AppConfig, SourceMap } from "./load.js";
import { isPrivateHost } from "./network.js";
import {
  aiSelfHostedOverridesPublicHost,
  ENV_KEYS,
  effectiveAiHosting,
  pemBlocks,
  type RawEnv,
  SECRET_KEYS,
} from "./schema.js";
import { pgTransportOf } from "./transport.js";

export interface DoctorRow {
  readonly key: string;
  /** Already redacted. Safe to print or log. */
  readonly value: string;
  readonly source: SourceMap[string];
}

export interface DoctorReport {
  readonly rows: readonly DoctorRow[];
  /** Log-safe summary lines that don't map to a single env var. */
  readonly derived: readonly DoctorRow[];
  /** Legal-but-dangerous combinations. See `configWarnings`. */
  readonly warnings: readonly DoctorWarning[];
}

/**
 * A configuration that loads, validates and is genuinely wanted by somebody, but whose
 * consequences reach outside the app — so `crossFieldRules` cannot refuse it (that would be
 * refusing a supported deployment) and nothing else would ever mention it.
 */
export interface DoctorWarning {
  readonly key: string;
  readonly message: string;
}

/**
 * Combinations worth saying out loud. Deliberately *not* `crossFieldRules`: every one of
 * these is a valid configuration, and the rule it breaks lives in a file the app does not
 * read (a proxy config, a DNS zone), so the app can warn and must not refuse.
 */
/**
 * When `@fundroom/http`'s vendored `CLOUDFLARE_IP_RANGES` were fetched (E3.10). Kept here as a
 * copy because config depends on nothing but zod; a server test pins the two dates together.
 */
export const CLOUDFLARE_IP_RANGES_FETCHED_AT = "2026-09-27";

/** How old the vendored Cloudflare ranges may get before `doctor` says so. */
export const CLOUDFLARE_IP_RANGES_MAX_AGE_DAYS = 180;

/**
 * The deprecation warning for a key read through its old name (A-2). Shared with the
 * standalone readers (`fundroom-audit`) so every surface says the same thing.
 */
export function legacyEnvWarning(use: {
  readonly key: string;
  readonly legacy: string;
  readonly sameAs?: string;
}): DoctorWarning {
  if (use.sameAs !== undefined) {
    return {
      key: use.legacy,
      message: `deprecated name, set to the same value as ${use.sameAs}, which is used. Remove ${use.legacy} once no image older than this release can run against this data: an older image reads only ${use.legacy} and, without it, generates a new key.`,
    };
  }
  const renamed = use.legacy.endsWith("_FILE") ? `${use.key}_FILE` : use.key;
  return {
    key: use.legacy,
    message: `deprecated name: it has been renamed ${renamed}. Set ${renamed} to the same value, keep ${use.legacy} as well while an image older than this release may still run (older images read only the old name), then remove ${use.legacy}. The old name still works for now but will be removed in a future release; setting both to different values is an error.`,
  };
}

/**
 * The `core.cell` origin shape (`cell_public_origin_shape`): https, a lower-case DNS name or IPv4
 * address, an optional port, no path. Mirrors `@fundroom/control-plane`'s check (config depends
 * on nothing but zod); a server test pins the two together.
 */
const CELL_ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/u;

/** Whether `origin` (as `URL.origin` gives it) can be a `core.cell` public origin. */
export function isCellOrigin(origin: string): boolean {
  return CELL_ORIGIN_RE.test(origin.toLowerCase());
}

export interface OwnCellOrigin {
  /** What the start-up creates the own cell row with ('' = this install). */
  readonly origin: string;
  /** Why: BASE_URL's origin, or why not. */
  readonly basis: "base_url" | "control_plane_off" | "not_a_cell_origin";
}

/**
 * E-UP-13: the public origin the server gives its own cell row when it creates it at start-up:
 * BASE_URL's origin under the control plane, unless it cannot be a cell origin (plain http);
 * '' (this install) then and without a control plane, where nothing routes between cells.
 * `doctor` shows the same answer. (BASE_URL cannot be a path mount's address here: PATH_MOUNTS is
 * refused with TENANCY_MODE=multi, which the control plane requires.)
 */
export function ownCellOrigin(config: AppConfig): OwnCellOrigin {
  if (config.raw.CONTROL_PLANE !== "on") return { origin: "", basis: "control_plane_off" };
  const origin = config.baseUrl.origin.toLowerCase();
  if (!isCellOrigin(origin)) return { origin: "", basis: "not_a_cell_origin" };
  return { origin, basis: "base_url" };
}

export function configWarnings(
  config: AppConfig,
  now: Date = new Date(),
): readonly DoctorWarning[] {
  const warnings: DoctorWarning[] = config.legacyEnv.map(legacyEnvWarning);
  const raw = config.raw;
  if (raw.AUDIT_ANCHOR_DRIVERS.includes("rekor") && raw.AUDIT_ANCHOR_REKOR_ORIGIN === undefined) {
    // E3.13 FIX3 L-B: the default origin is the URL's host; a rotation must keep it pinned.
    const url = raw.AUDIT_ANCHOR_REKOR_URL;
    const host = url !== undefined && URL.canParse(url) ? new URL(url).hostname : "?";
    warnings.push({
      key: "AUDIT_ANCHOR_REKOR_ORIGIN",
      message: `unset: Rekor receipts are pinned to the origin "${host}" (the URL's host). Set it explicitly; when the shard rotates, keep the old origin listed after the new one (with its log key), or old receipts become "unverified origin".`,
    });
  }
  const basePath = config.raw.BASE_PATH;
  if (basePath !== "") {
    /*
     * `BASE_PATH` and custom domains (E2.1/ADR-0039 decision 8, ADR-0022). The classifier strips
     * the base path before it matches the ops route table, so the `ask` endpoint lives at
     * `<BASE_PATH>/internal/tls/ask`. Since E3.9 the shipped `deploy/caddy/Caddyfile` builds its
     * `ask` URL and its `/internal/*` + `/metrics` refusals from `FUNDROOM_BASE_PATH` — an
     * environment variable of the *edge*, which this process cannot see. Unset there, the ask
     * 404s (no custom domain ever gets a certificate) and the refusal stops matching (the ask
     * endpoint, a domain-enumeration oracle, becomes public). So say it once, loudly.
     */
    warnings.push({
      key: "BASE_PATH",
      message:
        `the reverse proxy must know BASE_PATH=${basePath}: with the shipped deploy/caddy/Caddyfile set ` +
        `FUNDROOM_BASE_PATH=${basePath} on the caddy service; any other edge must point its on-demand-TLS ` +
        `ask at http://app:3000${basePath}/internal/tls/ask and refuse ${basePath}/internal/* and ` +
        `${basePath}/metrics. Otherwise no custom domain can get a certificate and the ask endpoint ` +
        "is reachable from the internet.",
    });
  }
  {
    /*
     * E3.9 FR2: BASE_URL is itself a mount (a stripping/replacing proxy in front). Every request
     * that reaches the app through that proxy must carry `X-Forwarded-Prefix`; one that does not
     * is presented as the portal's own origin and base (links, cookies, the CSRF origin).
     */
    const base = config.baseUrl;
    const basePathOfUrl = base.pathname.replace(/\/+$/u, "");
    const own = config.pathMounts.find(
      (m) => m.origin === base.origin && m.prefix === basePathOfUrl,
    );
    if (own !== undefined) {
      warnings.push({
        key: "PATH_MOUNTS",
        message:
          `BASE_URL is the mount ${own.origin}${own.prefix}: the proxy must send X-Forwarded-Prefix: ${own.prefix} ` +
          "for every request, otherwise pages are presented as the portal's own origin.",
      });
    }
  }
  if (!config.raw.TRUST_PROXY) {
    /*
     * E3.9: several mounts with one prefix can only be told apart by a believed
     * X-Forwarded-Host; without TRUST_PROXY none of them is ever matched (fail closed).
     */
    const byPrefix = new Map<string, string[]>();
    for (const m of config.pathMounts) {
      byPrefix.set(m.prefix, [...(byPrefix.get(m.prefix) ?? []), m.origin]);
    }
    for (const [prefix, origins] of byPrefix) {
      if (origins.length < 2) continue;
      warnings.push({
        key: "PATH_MOUNTS",
        message:
          `${origins.join(", ")} share the prefix ${prefix}; requests through them are only told apart ` +
          "by X-Forwarded-Host, which is read with TRUST_PROXY=true only, so with TRUST_PROXY off none of " +
          "them is ever treated as mounted. Set TRUST_PROXY=true (and let the edge keep the host proxies' " +
          "X-Forwarded-Host, e.g. EDGE_TRUSTED_PROXIES), or give each host its own prefix.",
      });
    }
  }
  // E3.10: a managed host that screens nobody. Legal (a host may screen out of band), but the
  // control plane then admits every signup and operator-created workspace unchecked.
  if (
    config.raw.CONTROL_PLANE === "on" &&
    config.appEnv === "prod" &&
    config.raw.SANCTIONS_DRIVER === "none"
  ) {
    warnings.push({
      key: "SANCTIONS_DRIVER",
      message:
        "CONTROL_PLANE=on with SANCTIONS_DRIVER=none: new workspaces are not screened against sanctions lists. Set SANCTIONS_DRIVER=ofac (or opensanctions) unless you screen tenants another way.",
    });
  }
  // E-UP-11: the first-run wizard is off under the control plane, so the token is never read.
  if (config.raw.CONTROL_PLANE === "on" && config.raw.SETUP_TOKEN !== undefined) {
    warnings.push({
      key: "SETUP_TOKEN",
      message:
        "ignored: CONTROL_PLANE=on turns the first-run wizard and its setup token off (workspaces come from signup and the operator API). Remove SETUP_TOKEN.",
    });
  }
  // E-UP-13: the own cell row is created at start-up with BASE_URL's origin, when it can be one.
  if (config.raw.CONTROL_PLANE === "on" && config.raw.CELL_ID !== "default") {
    const own = ownCellOrigin(config);
    if (own.basis === "not_a_cell_origin") {
      warnings.push({
        key: "CELL_ID",
        message: `CELL_ID=${config.raw.CELL_ID}: BASE_URL's origin ${config.baseUrl.origin} cannot be a cell origin (https with a DNS name or IPv4 address only), so the cell row created at start-up gets none and edges and other cells cannot send this cell's tenants here. Set one with: fundroom cell set-origin ${config.raw.CELL_ID} https://<host>`,
      });
    }
  }
  // E-UP-4: a signup must tick "I accept the terms"; without TERMS_URL there is nothing to read.
  if (config.raw.SIGNUP_MODE === "open" && config.raw.TERMS_URL === undefined) {
    warnings.push({
      key: "TERMS_URL",
      message: `SIGNUP_MODE=open without TERMS_URL: signup accepts terms nobody can read (recorded as platform-terms:v${config.raw.SIGNUP_TERMS_VERSION}). Set TERMS_URL to your published terms of service.`,
    });
  }
  if (config.raw.CLOUDFLARE_TRUSTED_PROXY === "on") {
    // E3.10: the client address is only as good as the list of addresses allowed to name it. A
    // stale list misses new Cloudflare edges (their visitors all share the edge's address in
    // rate limits and audit rows) and keeps trusting ranges Cloudflare may have given back.
    const ageDays = Math.floor(
      (now.getTime() - Date.parse(`${CLOUDFLARE_IP_RANGES_FETCHED_AT}T00:00:00Z`)) / 86_400_000,
    );
    if (ageDays > CLOUDFLARE_IP_RANGES_MAX_AGE_DAYS) {
      warnings.push({
        key: "CLOUDFLARE_TRUSTED_PROXY",
        message: `the vendored Cloudflare IP ranges are ${ageDays} days old (fetched ${CLOUDFLARE_IP_RANGES_FETCHED_AT}); upgrade FundRoom, or compare https://www.cloudflare.com/ips-v4 and /ips-v6 with @fundroom/http's CLOUDFLARE_IP_RANGES.`,
      });
    }
    if (!config.raw.TRUST_PROXY) {
      // It rides on the proxy trust (`proxyTrustOf`): without TRUST_PROXY nothing reads it.
      warnings.push({
        key: "CLOUDFLARE_TRUSTED_PROXY",
        message:
          "CLOUDFLARE_TRUSTED_PROXY=on has no effect without TRUST_PROXY=true: set TRUST_PROXY (and TRUST_PROXY_HOPS for the proxies between Cloudflare and this process).",
      });
    }
  }
  // E-UP-7: an edge-forwarded request is always https with the forwarded host, whatever
  // TRUST_PROXY says; what TRUST_PROXY=false breaks is everything else on the same process.
  if (config.raw.FORWARDED_HOST_HEADER !== undefined && !config.raw.TRUST_PROXY) {
    warnings.push({
      key: "FORWARDED_HOST_HEADER",
      message:
        "edge forwarding is on but TRUST_PROXY=false: edge-forwarded requests are unaffected (always https, with the forwarded host), but direct requests that do not come through the edge get their scheme, host and accepted origins from the socket rather than the platform's proxy, and an edge request without a client IP header is recorded with the proxy's address. Set TRUST_PROXY=true (and TRUST_PROXY_HOPS / CLIENT_IP_HEADER for the platform's own proxy).",
    });
  }
  // E-UP-7: without the IP header, every visitor through the edge is the edge's egress address.
  if (
    config.raw.FORWARDED_HOST_HEADER !== undefined &&
    config.raw.FORWARDED_CLIENT_IP_HEADER === undefined
  ) {
    warnings.push({
      key: "FORWARDED_CLIENT_IP_HEADER",
      message:
        "edge forwarding is on without FORWARDED_CLIENT_IP_HEADER: every custom-domain visitor shares the edge's egress address in per-IP rate limits, IP allowlists and audit rows. Set it to the header your edge puts the visitor's IP in (X-Fundroom-Client-IP).",
    });
  }
  // E-UP-7: names that look swapped load fine (both are valid X-Fundroom-* headers), but the
  // edge then puts the address where the app expects a hostname and every request is refused.
  const edgeHost = config.raw.FORWARDED_HOST_HEADER?.toLowerCase();
  const edgeIp = config.raw.FORWARDED_CLIENT_IP_HEADER?.toLowerCase();
  if (edgeHost?.includes("ip") === true && edgeIp?.includes("host") === true) {
    warnings.push({
      key: "FORWARDED_HOST_HEADER",
      message: `FORWARDED_HOST_HEADER (${config.raw.FORWARDED_HOST_HEADER}) looks like an IP header and FORWARDED_CLIENT_IP_HEADER (${config.raw.FORWARDED_CLIENT_IP_HEADER}) like a host header: if they are swapped, every edge request would answer 400 (the address is not a hostname). The FundRoom edge sends X-Fundroom-Forwarded-Host and X-Fundroom-Client-IP.`,
    });
  }
  if (config.raw.EDGE_SHARED_SECRET_PREVIOUS !== undefined) {
    warnings.push({
      key: "EDGE_SHARED_SECRET_PREVIOUS",
      message:
        "an edge secret rotation is in progress: the previous secret is still accepted. Finish the rotation: once every edge sends the new EDGE_SHARED_SECRET, unset EDGE_SHARED_SECRET_PREVIOUS.",
    });
  }
  // E3.11: a managed host that declares no data region shows tenants "not declared" everywhere
  // (residency page, DPA annex) and cannot join a cell directory.
  if (config.raw.CONTROL_PLANE === "on" && config.raw.DATA_REGION === undefined) {
    warnings.push({
      key: "DATA_REGION",
      message:
        "CONTROL_PLANE=on without DATA_REGION: tenants see their data location as not declared. Set DATA_REGION (and DATA_REGION_LABEL, DATA_REGION_JURISDICTION) to the region this cell's database and storage live in.",
    });
  }
  if (config.raw.SANCTIONS_DRIVER === "opensanctions") {
    warnings.push({
      key: "SANCTIONS_DRIVER",
      message:
        "OpenSanctions data is licensed CC BY-NC: screening your customers as a business needs a commercial data licence from OpenSanctions (for yente and for the hosted API alike).",
    });
  }
  if (aiSelfHostedOverridesPublicHost(config.raw)) {
    warnings.push({
      key: "AI_HOSTING",
      message: `self_hosted is declared for ${new URL(config.raw.AI_BASE_URL as string).hostname}, which is not evidently operator-run: tenants are told the model runs on your infrastructure, it is not listed as a sub-processor, and no store:false is sent. Only declare it for a server you run.`,
    });
  }
  return warnings;
}

/**
 * Builds the "resolved configuration" table printed by `fundroom doctor` and at
 * boot (debug level). Secrets are never present in the output: URLs with
 * credentials keep host/db and lose the password; keys become fingerprints.
 */
export function doctorReport(config: AppConfig, sources: SourceMap): DoctorReport {
  const rows: DoctorRow[] = ENV_KEYS.map((key) => ({
    key,
    value: renderValue(key, config.raw[key], config),
    source: sources[key] ?? "unset",
  }));

  const derived: DoctorRow[] = [
    { key: "roles", value: [...config.roles].join(","), source: "default" },
    {
      key: "modules",
      value: config.modules === undefined ? "(all)" : config.modules.join(","),
      source: "default",
    },
    { key: "keyRing", value: describeKeyRing(config.keyRing), source: "default" },
    {
      key: "pathMounts",
      value:
        config.pathMounts.length === 0
          ? "(none)"
          : config.pathMounts.map((m) => `${m.origin} prefix ${m.prefix}`).join(", "),
      source: "default",
    },
    {
      key: "controlPlane",
      value:
        config.raw.CONTROL_PLANE === "on"
          ? `on (cell ${config.raw.CELL_ID}, billing ${config.raw.BILLING_DRIVER}, sanctions ${config.raw.SANCTIONS_DRIVER}, signup ${config.raw.SIGNUP_MODE})`
          : "off",
      source: "default",
    },
    {
      key: "firstRunSetup",
      value:
        config.raw.CONTROL_PLANE === "on"
          ? "off (CONTROL_PLANE=on: no setup token; workspaces come from signup and the operator API)"
          : `wizard until the first workspace exists (token from ${config.raw.SETUP_TOKEN === undefined ? "DATA_DIR/setup-token or the logs" : "SETUP_TOKEN"})`,
      source: "default",
    },
    {
      key: "ownCell",
      value:
        config.raw.CELL_ID === "default"
          ? "default (the seeded row)"
          : `${config.raw.CELL_ID}: its core.cell row is created at start-up when missing (region ${config.raw.DATA_REGION ?? "placeholder"}, origin ${describeOwnCellOrigin(ownCellOrigin(config))}); an existing row is never changed, a difference is logged (cell.own_differs). Check with: fundroom cell list; correct with: fundroom cell set-origin`,
      source: "default",
    },
    {
      key: "dataResidency",
      value:
        config.raw.DATA_REGION === undefined
          ? "region not declared"
          : `region ${config.raw.DATA_REGION}${config.raw.DATA_REGION_LABEL === undefined ? "" : ` (${config.raw.DATA_REGION_LABEL})`}, jurisdiction ${config.raw.DATA_REGION_JURISDICTION ?? "not declared"}`,
      source: "default",
    },
    {
      key: "backupLocation",
      value: config.raw.BACKUP_LOCATION ?? "not declared",
      source: "default",
    },
    {
      key: "directory",
      value:
        config.raw.DIRECTORY_DATABASE_URL === undefined
          ? "local"
          : `shared (${directoryTransport(config.raw.DIRECTORY_DATABASE_URL, config.raw.DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS)})`,
      source: "default",
    },
    {
      key: "aiAssist",
      value:
        config.raw.AI_PROVIDER === "none"
          ? "off"
          : `${config.raw.AI_PROVIDER} (${effectiveAiHosting(config.raw)}, ${config.raw.AI_MODEL ?? "no model"})`,
      source: "default",
    },
    { key: "auditAnchoring", value: describeAuditAnchoring(config.raw), source: "default" },
    { key: "authzEngine", value: describeAuthzEngine(config.raw), source: "default" },
  ];

  return { rows, derived, warnings: configWarnings(config) };
}

function describeOwnCellOrigin(own: OwnCellOrigin): string {
  switch (own.basis) {
    case "base_url":
      return own.origin;
    case "control_plane_off":
      return "'' (this install)";
    case "not_a_cell_origin":
      return "'' (this install: BASE_URL's origin cannot be a cell origin)";
  }
}

/** E3.13: the anchors in use, their endpoints and the pinned trust (fingerprints only). */
export function describeAuditAnchoring(raw: RawEnv): string {
  const verifyOnly: string[] = [];
  if (!raw.AUDIT_ANCHOR_DRIVERS.includes("rfc3161") && raw.AUDIT_ANCHOR_TSA_CERTS !== undefined)
    verifyOnly.push(`rfc3161 ${describePem(raw.AUDIT_ANCHOR_TSA_CERTS, "CERTIFICATE")}`);
  if (!raw.AUDIT_ANCHOR_DRIVERS.includes("rekor") && raw.AUDIT_ANCHOR_REKOR_LOG_KEY !== undefined)
    verifyOnly.push(`rekor ${describePem(raw.AUDIT_ANCHOR_REKOR_LOG_KEY, "PUBLIC KEY")}`);
  const pinsOnly =
    verifyOnly.length > 0 ? `; verification-only pins: ${verifyOnly.join(", ")}` : "";
  if (raw.AUDIT_ANCHOR_DRIVERS.length === 0) return `off${pinsOnly}`;
  const parts: string[] = [];
  for (const driver of raw.AUDIT_ANCHOR_DRIVERS) {
    if (driver === "rfc3161") {
      const hosts = (raw.AUDIT_ANCHOR_TSA_URLS ?? []).map(hostOf).join(", ");
      parts.push(
        `rfc3161 (TSAs ${hosts || "none"}; ${describePem(raw.AUDIT_ANCHOR_TSA_CERTS, "CERTIFICATE")})`,
      );
    } else {
      parts.push(
        `rekor (${raw.AUDIT_ANCHOR_REKOR_URL === undefined ? "no url" : hostOf(raw.AUDIT_ANCHOR_REKOR_URL)}; origins ${(raw.AUDIT_ANCHOR_REKOR_ORIGIN ?? []).join(", ") || "url host"}; ${describePem(raw.AUDIT_ANCHOR_REKOR_LOG_KEY, "PUBLIC KEY")})`,
      );
    }
  }
  return `${parts.join(", ")}, timeout ${raw.AUDIT_ANCHOR_TIMEOUT_MS} ms${pinsOnly}`;
}

/** E3.13: which engine answers external checks. Never prints the API token. */
export function describeAuthzEngine(raw: RawEnv): string {
  if (raw.AUTHZ_ENGINE === "postgres") return "postgres";
  const where = raw.AUTHZ_OPENFGA_URL === undefined ? "no url" : hostOf(raw.AUTHZ_OPENFGA_URL);
  const mode =
    raw.AUTHZ_OPENFGA_MODE === "shadow"
      ? `shadow, sample ${raw.AUTHZ_OPENFGA_SHADOW_SAMPLE}`
      : "enforce";
  return `openfga ${mode} (${where}${raw.AUTHZ_OPENFGA_API_TOKEN === undefined ? "" : ", token set"}, timeout ${raw.AUTHZ_OPENFGA_TIMEOUT_MS} ms)`;
}

function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).host : "(invalid url)";
}

/** `2 pinned CERTIFICATE (sha256 ab12cd34…, ef56…)` — fingerprints of the DER, never the PEM. */
function describePem(text: string | undefined, label: "CERTIFICATE" | "PUBLIC KEY"): string {
  if (text === undefined) return `no pinned ${label.toLowerCase()}`;
  const fps = pemBlocks(text, label).map((block) => {
    if (label === "CERTIFICATE") {
      try {
        return new X509Certificate(block).fingerprint256
          .replaceAll(":", "")
          .slice(0, 16)
          .toLowerCase();
      } catch {
        return "unparseable";
      }
    }
    const b64 = block.replace(/-----[^-]+-----|\s+/gu, "");
    return createHash("sha256").update(Buffer.from(b64, "base64")).digest("hex").slice(0, 16);
  });
  return `${fps.length} pinned ${label.toLowerCase()}${fps.length === 1 ? "" : "s"} (sha256 ${fps.join(", ")})`;
}

/** How the directory connection is protected (E3.11 R2-1): never prints the URL itself. */
function directoryTransport(url: string, acceptUnverified: boolean): string {
  const { host, sslmode } = pgTransportOf(url);
  if (sslmode === "verify-full" || sslmode === "verify-ca") return `tls ${sslmode}`;
  if (host !== undefined && isPrivateHost(host)) return "private host";
  return acceptUnverified ? "UNVERIFIED TLS accepted" : `sslmode ${sslmode ?? "none"}`;
}

/** Aligned two-column text rendering with the source in a third column. */
export function formatDoctorReport(report: DoctorReport): string {
  const all = [...report.rows, ...report.derived];
  const keyWidth = Math.max(...all.map((r) => r.key.length));
  const valueWidth = Math.min(72, Math.max(...all.map((r) => r.value.length)));
  const line = (r: DoctorRow) =>
    `  ${r.key.padEnd(keyWidth)}  ${r.value.padEnd(valueWidth)}  ${r.source}`;
  return [
    "Resolved configuration (secrets redacted):",
    ...report.rows.map(line),
    "",
    "Derived:",
    ...report.derived.map(line),
    ...(report.warnings.length === 0
      ? []
      : ["", "Warnings:", ...report.warnings.map((w) => `  ${w.key}: ${w.message}`)]),
  ].join("\n");
}

const REDACTED = "••••••••";

function renderValue(key: string, value: unknown, config: AppConfig): string {
  if (value === undefined) return "(unset)";
  if (SECRET_KEYS.has(key)) return redactSecret(key, value, config);
  // E3.13: a PEM bundle is one row, not forty lines; the derived auditAnchoring row has fingerprints.
  if (key === "AUDIT_ANCHOR_TSA_CERTS" && typeof value === "string")
    return `${pemBlocks(value, "CERTIFICATE").length} PEM certificate(s)`;
  if (key === "AUDIT_ANCHOR_REKOR_LOG_KEY" && typeof value === "string")
    return `${pemBlocks(value, "PUBLIC KEY").length} PEM public key(s)`;
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

function redactSecret(key: string, value: unknown, config: AppConfig): string {
  if (typeof value !== "string") return REDACTED;
  switch (key) {
    case "FUNDROOM_SECRET_KEY":
    case "SECRET_KEY_RING":
      return describeKeyRing(config.keyRing);
    case "DATABASE_URL":
    case "SMTP_URL":
    case "ERROR_REPORTING_DSN":
      return redactUrlCredentials(value);
    default:
      return REDACTED;
  }
}

/** `postgres://user:pass@host/db` → `postgres://user:••••••••@host/db`. Unparseable → fully redacted. */
export function redactUrlCredentials(value: string): string {
  try {
    const url = new URL(value);
    if (url.password !== "") url.password = REDACTED;
    if (
      url.username !== "" &&
      url.password === "" &&
      !/^(postgres(ql)?|smtps?):$/u.test(url.protocol)
    ) {
      // DSNs like https://<key>@host carry the secret in the username.
      url.username = REDACTED;
    }
    return decodeURIComponent(url.toString());
  } catch {
    return REDACTED;
  }
}
