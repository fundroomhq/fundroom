import { createPublicKey, X509Certificate } from "node:crypto";
import { BlockList, isIPv4, isIPv6 } from "node:net";
import { z } from "zod";
import { isPrivateHost } from "./network.js";
import { pgTransportOf, smtpTransportOf } from "./transport.js";

/*
 * Kernel environment schema. Modules extend configuration through their own
 * `settingsSchema` (per workspace, stored in the DB) — this file is only what
 * the process needs before it can talk to the database.
 *
 * Conventions:
 *  - Every key here is resolvable from `KEY_FILE` (see secrets.ts).
 *  - Keys listed in SECRET_KEYS are redacted in `doctor` output and logs.
 *  - Booleans accept true/false/1/0/yes/no/on/off (case-insensitive).
 *  - Lists are comma-separated.
 */

const bool = z.stringbool();

const csv = <T extends z.ZodType<unknown, string>>(item: T) =>
  z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    )
    .pipe(z.array(item));

const port = z.coerce.number().int().min(1).max(65535);

export const APP_ENVS = ["dev", "test", "staging", "prod"] as const;
export const LOG_LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
export const ROLES = ["api", "web", "worker"] as const;
export const WORKER_MODES = ["embedded", "external", "off"] as const;
export const STORAGE_DRIVERS = ["fs", "s3"] as const;
export const MAILER_DRIVERS = ["smtp", "resend", "postmark", "ses"] as const;
export const ROBOTS_MODES = ["noindex", "index"] as const;
/** `CSP_TRUSTED_TYPES` (E3.2): enforce Trusted Types in the document CSP, or only report. */
export const CSP_TRUSTED_TYPES_MODES = ["enforce", "report"] as const;
/** `AUTH_HIBP_FAIL_MODE` (E3.2, F-21): accept or refuse a password when HIBP is unreachable. */
export const HIBP_FAIL_MODES = ["open", "closed"] as const;
export const TENANCY_MODES = ["single", "multi"] as const;
export const KMS_DRIVERS = ["local"] as const;
export const AV_DRIVERS = ["noop", "clamd"] as const;
/**
 * Mirrors `ACCREDITATION_DRIVERS` in `@fundroom/ports` (E2.5 decision D6). Repeated rather than
 * imported for the same reason every other driver list here is: this package depends on `zod`
 * and nothing else, so an operator's `.env` can be validated by the CLI without pulling the
 * adapter graph in behind it. The container is where the two meet, and its test is what would
 * notice them disagreeing: an id here that no adapter answers to fails `createAccreditationProvider`.
 */
export const ACCREDITATION_DRIVERS = ["manual"] as const;
/**
 * Mirrors `ESIGN_DRIVERS` in `@fundroom/ports` (E3.5, ADR-0053), repeated for the reason
 * `ACCREDITATION_DRIVERS` is. `ESIGN_DRIVERS` (the env key) chooses which of these a workspace
 * admin is offered.
 */
export const ESIGN_DRIVER_IDS = ["documenso", "docuseal", "docusign", "dropbox-sign"] as const;
/**
 * Mirrors `ACCREDITATION_VENDOR_DRIVERS` in `@fundroom/ports` (E3.7), repeated for the reason
 * `ACCREDITATION_DRIVERS` is. `ACCREDITATION_DRIVERS` (the env key) chooses which of these a
 * workspace admin is offered; `manual` is always available and is not listed here.
 */
export const ACCREDITATION_VENDOR_DRIVERS = ["verifyinvestor", "parallel-markets"] as const;
/**
 * Staff SSO protocols (E3.8, ADR-0056) a workspace admin may configure a connection with.
 * Mirrors `SsoProtocol` in `@fundroom/sso`, repeated for the reason `ACCREDITATION_DRIVERS` is.
 */
export const SSO_PROTOCOL_IDS = ["oidc", "saml"] as const;
/**
 * The managed-host control plane (E3.10, ADR-0058). Every list here is repeated from the package
 * that implements it (`@fundroom/billing`, `@fundroom/sanctions`, the custom-domain adapters) for
 * the reason `ACCREDITATION_DRIVERS` is.
 */
export const CONTROL_PLANE_MODES = ["off", "on"] as const;
export const SIGNUP_MODES = ["off", "open"] as const;
export const BILLING_DRIVERS = ["none", "manual", "stripe"] as const;
/** A Stripe billing-meter `event_name` as this app sends it (BILLING_METER_*_EVENT). */
export const STRIPE_METER_EVENT_RE = /^[A-Za-z0-9_]{1,100}$/u;
export const SANCTIONS_DRIVERS = ["none", "ofac", "opensanctions"] as const;
export const CUSTOM_DOMAIN_DRIVERS = ["caddy-ask", "manual", "cloudflare-saas"] as const;
/** The operator's AI model provider (E3.12). `openai-compatible` covers self-hosted servers. */
export const AI_PROVIDERS = ["none", "openai-compatible", "anthropic"] as const;
export const AI_HOSTINGS = ["self_hosted", "third_party"] as const;
export const AI_JSON_MODES = ["json_schema", "json_object", "prompt"] as const;
export const AI_TOKEN_PARAMS = ["max_tokens", "max_completion_tokens"] as const;
export const DEFAULT_ANTHROPIC_API_BASE = "https://api.anthropic.com";
/**
 * External audit anchoring drivers (E3.13, ADR-0061). Mirrors the adapters
 * `@fundroom/anchor-rfc3161` and `@fundroom/anchor-rekor`, repeated for the reason
 * `ACCREDITATION_DRIVERS` is.
 */
export const AUDIT_ANCHOR_DRIVER_IDS = ["rfc3161", "rekor"] as const;
/** Which engine answers external-principal `check`/`listAccessible` (E3.13). */
export const AUTHZ_ENGINES = ["postgres", "openfga"] as const;
export const AUTHZ_OPENFGA_MODES = ["shadow", "enforce"] as const;
/** A cell id (E3.10): what `core.cell.id` and `core.workspace.cell_id` hold. */
export const CELL_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/u;
/**
 * Per-tenant data residency (E3.11). Jurisdictions mirror `JURISDICTIONS` in `@fundroom/ports`
 * (repeated for the reason `ACCREDITATION_DRIVERS` is); a region code is what `core.cell.region`
 * holds once declared.
 */
export const DATA_JURISDICTIONS = ["eu", "uk", "ch", "us", "ca", "au", "other"] as const;
export const DATA_REGION_RE = /^[a-z][a-z0-9-]{0,31}$/u;
/** A plan id (E3.10): what `core.plan.id` holds (`SIGNUP_DEFAULT_PLAN`). */
export const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/u;
/** The OFAC Sanctions List Service export directory; the `ofac` adapter appends file names. */
export const DEFAULT_SANCTIONS_OFAC_URL =
  "https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/";
export const DEFAULT_STRIPE_API_BASE = "https://api.stripe.com";
export const DEFAULT_CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

export type AppEnv = (typeof APP_ENVS)[number];
export type Role = (typeof ROLES)[number];
export type TenancyMode = (typeof TENANCY_MODES)[number];

/** BASE_PATH's shape; a path mount's prefix is the same shape, non-empty. */
const BASE_PATH_RE = /^(\/[A-Za-z0-9._~-]+)*$/u;
/** `PATH_MOUNTS` holds at most this many entries (E3.9). */
export const MAX_PATH_MOUNTS = 16;

/** A path mount (E3.9, ADR-0057): a public origin and the path prefix the portal is served under. */
export interface PathMountEntry {
  /** `URL.origin`: lower-case scheme and host, default port dropped, no trailing slash. */
  readonly origin: string;
  /** Non-empty, BASE_PATH-shaped: `/seg[/seg…]`, no trailing slash. */
  readonly prefix: string;
}

/**
 * Parses one `PATH_MOUNTS` entry (`https://acme.com/investors`) into its origin and prefix, or
 * answers why it is refused. Strict on purpose — the prefix is compared byte for byte with a
 * proxy's `X-Forwarded-Prefix` and becomes a cookie `Path` — so nothing the URL parser would
 * normalise (dot segments, percent-encoding, a trailing slash, a query) is accepted silently.
 */
export function parsePathMount(entry: string): PathMountEntry | string {
  const shown = entry.length > 200 ? `${entry.slice(0, 200)}…` : entry;
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(.*)$/u.exec(entry);
  if (m === null)
    return `${JSON.stringify(shown)} is not an absolute URL such as https://acme.com/investors`;
  const [, scheme = "", authority = "", rawPath = "", rest = ""] = m;
  if (!/^https?$/iu.test(scheme))
    return `${JSON.stringify(shown)} must use https (or http in dev/test)`;
  if (authority.includes("@"))
    return `${JSON.stringify(shown)} must not carry a user name or password`;
  if (rest !== "") return `${JSON.stringify(shown)} must not have a query or fragment`;
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return `${JSON.stringify(shown)} is not a valid URL`;
  }
  if (url.hostname.endsWith(".")) {
    return `${JSON.stringify(shown)} must not end its host name with a dot (acme.com. and acme.com are different origins to a browser)`;
  }
  if (url.hostname === "" || !z.regexes.hostname.test(url.hostname.replace(/^\[.*\]$/u, "ip6"))) {
    return `${JSON.stringify(shown)} has no valid host name`;
  }
  if (rawPath === "" || rawPath === "/") {
    return `${JSON.stringify(shown)} needs a path prefix (the mount at the root of a host is a custom domain, not a path mount)`;
  }
  if (rawPath.endsWith("/")) return `${JSON.stringify(shown)} must not end with a slash`;
  if (
    !BASE_PATH_RE.test(rawPath) ||
    rawPath.split("/").some((seg) => seg === "." || seg === "..")
  ) {
    return `${JSON.stringify(shown)} has a path that is not a plain prefix (letters, digits and . _ ~ - per segment; no dot segments or percent-encoding)`;
  }
  if (url.pathname !== rawPath)
    return `${JSON.stringify(shown)} has a path that is not a plain prefix`;
  return { origin: url.origin, prefix: rawPath };
}

const pathMountItem = z.string().transform((entry, ctx) => {
  const parsed = parsePathMount(entry);
  if (typeof parsed === "string") {
    ctx.addIssue({ code: "custom", message: parsed });
    return z.NEVER;
  }
  return `${parsed.origin}${parsed.prefix}`;
});

/**
 * One `PLATFORM_OPERATOR_CIDRS` entry: an IPv4 or IPv6 address with an optional prefix length
 * (`203.0.113.0/24`, `2001:db8::/32`, `198.51.100.7`). A bare address is a /32 or /128.
 */
export function parseCidr(
  entry: string,
):
  | { readonly address: string; readonly prefix: number; readonly family: "ipv4" | "ipv6" }
  | undefined {
  const [address = "", bits, ...rest] = entry.trim().split("/");
  if (rest.length > 0) return undefined;
  const family = isIPv4(address) ? "ipv4" : isIPv6(address) ? "ipv6" : undefined;
  if (family === undefined) return undefined;
  const max = family === "ipv4" ? 32 : 128;
  if (bits === undefined) return { address, prefix: max, family };
  if (!/^\d{1,3}$/u.test(bits)) return undefined;
  const prefix = Number(bits);
  return prefix > max ? undefined : { address, prefix, family };
}

/**
 * Header names an edge-forwarding header (E-UP-7) may not take: ones a proxy between the edge and
 * this process writes or rewrites itself (so the value would not be the edge's), the HTTP host,
 * and the fixed secret header. Compared lower-case.
 */
function isReservedEdgeHeader(name: string): boolean {
  const h = name.toLowerCase();
  return (
    h === "host" ||
    h === "forwarded" ||
    h === "x-real-ip" ||
    h === "x-fundroom-edge" ||
    h.startsWith("x-forwarded-") ||
    h.startsWith("cf-")
  );
}

/**
 * The namespace of the headers the edge Worker writes (E-UP-7). The Worker strips every inbound
 * `X-Fundroom-*` header before setting its own, so a header in it can never carry a visitor's
 * value; outside it, a header the Worker neither sets nor strips passes through from the visitor,
 * even under a valid secret.
 */
const EDGE_HEADER_PREFIX = "x-fundroom-";

/** Why `name` cannot be an edge-forwarding header, or `undefined` when it can. */
function edgeHeaderProblem(name: string, example: string): string | undefined {
  if (isReservedEdgeHeader(name)) {
    return `must be a private header only your edge sets, such as ${example}: Host, Forwarded, X-Forwarded-*, X-Real-IP and CF-* are written by the proxies in between, and X-Fundroom-Edge carries the shared secret`;
  }
  if (
    !name.toLowerCase().startsWith(EDGE_HEADER_PREFIX) ||
    name.length <= EDGE_HEADER_PREFIX.length
  ) {
    return `must start with X-Fundroom-, such as ${example}: the edge strips every inbound X-Fundroom-* header before setting its own, so only a header in that namespace can never come from the visitor`;
  }
  return undefined;
}

/** An HTTP header name as the config accepts one (`CLIENT_IP_HEADER`, the edge headers). */
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/u;

/** A header the edge Worker writes (E-UP-7): an `X-Fundroom-*` name that no proxy rewrites. */
const edgeHeaderName = (example: string) =>
  z
    .string()
    .regex(HEADER_NAME_RE, `must be an HTTP header name such as ${example}`)
    .superRefine((h, ctx) => {
      // Zod runs this even when the format check failed; one accurate message is enough.
      if (!HEADER_NAME_RE.test(h)) return;
      const problem = edgeHeaderProblem(h, example);
      if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
    });

/**
 * The edge's shared secret (E-UP-7): sent as a header value, so visible ASCII only (a space or
 * control character would be trimmed or refused on the way and never match).
 */
const edgeSharedSecret = z
  .string()
  .min(32, "must be at least 32 characters (openssl rand -hex 32)")
  .max(256, "must be at most 256 characters")
  .regex(/^[\x21-\x7E]+$/u, "must be printable ASCII without spaces (openssl rand -hex 32)");

/**
 * A link shown to visitors (E-UP-4: TERMS_URL, PRIVACY_URL, SUPPORT_URL, STATUS_URL): an absolute
 * https URL, plain http only for a localhost host (a dev stack), and, for a contact link, a bare
 * mailto: address. Anything else (javascript:, data:, a relative path) would land in an `href`.
 *
 * The literal `https://` prefix is required: `https:example.com` parses, but a browser resolves
 * the raw string in an `href` as a same-origin relative path. The value is served normalised
 * (`url.href`), so what is validated is what the page links. No credentials in the URL, and no
 * `?` on a mailto: (cc/bcc/body headers would prefill a message on the visitor's behalf).
 */
const publicLinkUrl = (mailto: boolean) => {
  const expected = mailto
    ? "must be an https:// URL or a bare mailto: address"
    : "must be an absolute https:// URL";
  return z.string().transform((value, ctx) => {
    const fail = (message = expected) => {
      ctx.addIssue({ code: "custom", message });
      return z.NEVER;
    };
    // Whitespace and control characters: the URL parser would silently strip some of them.
    if (/\s/u.test(value) || [...value].some((ch) => ch < " " || ch === "\u007f")) return fail();
    if (mailto && /^mailto:/iu.test(value)) {
      const address = value.slice("mailto:".length);
      if (!/^[^@?#%<>"/\\]+@[^@?#%<>"/\\]+$/u.test(address)) {
        return fail(
          "must be a bare mailto: address such as mailto:support@example.com (no ?query)",
        );
      }
      return `mailto:${address}`;
    }
    const https = /^https:\/\//iu.test(value);
    if (!https && !/^http:\/\//iu.test(value)) return fail();
    if (!URL.canParse(value)) return fail();
    const url = new URL(value);
    if (url.hostname === "") return fail();
    if (url.username !== "" || url.password !== "")
      return fail("must not carry a user name or password");
    if (!https) {
      const host = url.hostname.toLowerCase();
      const local =
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host === "127.0.0.1" ||
        host === "[::1]";
      if (!local) return fail();
    }
    return url.href;
  });
};

/** Raw (pre-cross-field) schema. Field-level rules only; see `crossFieldRules` for the rest. */
export const envSchema = z.object({
  // --- process -------------------------------------------------------------
  APP_ENV: z.enum(APP_ENVS).default("dev"),
  LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  HOST: z.string().min(1).default("0.0.0.0"),
  PORT: port.default(3000),
  /** Which roles this process runs (ADR-0001). All-in-one by default. */
  ROLES: csv(z.enum(ROLES)).default(["api", "web", "worker"]),
  /** Convenience over ROLES: embedded adds `worker`, external/off remove it. */
  WORKER_MODE: z.enum(WORKER_MODES).optional(),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(5),
  /** Compiled-in modules to load; omit for all. Validated by module-kit at boot. */
  MODULES: csv(z.string().regex(/^[a-z][a-z0-9-]*$/u, "module ids are kebab-case")).optional(),

  // --- public identity -----------------------------------------------------
  BASE_URL: z.url({ protocol: /^https?$/u, hostname: z.regexes.hostname }),
  /** Path-mount prefix (ADR-0022). Leading slash, no trailing slash. */
  BASE_PATH: z
    .string()
    .regex(BASE_PATH_RE, "must start with / and have no trailing slash")
    .default(""),
  /**
   * Path mounts (E3.9, ADR-0057): the public `origin + prefix` URLs a reverse proxy on another
   * site serves the portal under, comma-separated, e.g. `https://acme.com/investors`. A request
   * whose `X-Forwarded-Prefix` names one of these prefixes byte for byte is presented under it
   * (router base, asset URLs, cookie Path, the CSRF-accepted origin); any other value is ignored.
   * The list is the gate, so TRUST_PROXY is not required. Several origins may share a prefix: only
   * a believed X-Forwarded-Host (TRUST_PROXY on) picks among them, and a request it does not
   * resolve is not mounted (fail closed; doctor warns when TRUST_PROXY is off). CORS_ALLOWED_ORIGINS
   * may not name a mount origin. Kept here normalised (`URL.origin` + prefix);
   * `AppConfig.pathMounts` has them split. Single-tenant installs only.
   */
  PATH_MOUNTS: z
    .string()
    .transform((s) =>
      s
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x.length > 0),
    )
    .pipe(z.array(pathMountItem).max(MAX_PATH_MOUNTS, `lists at most ${MAX_PATH_MOUNTS} mounts`))
    .optional(),
  TRUST_PROXY: bool.default(false),
  /**
   * With TRUST_PROXY=true: how many proxies in front of this process *append* to
   * `X-Forwarded-For` (E2.10 F-07). The client address is the entry this many places from the
   * right, because everything to the left of it was written by the client and is spoofable.
   * 1 = one proxy (the shipped Caddy, Traefik, ingress-nginx); 2 = a CDN in front of that one.
   * `X-Forwarded-Host`/`-Proto` are read from their rightmost entry, which the nearest proxy wrote.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(1).max(10).default(1),
  /**
   * With TRUST_PROXY=true: read the client address from this single-valued header, which the
   * platform's edge overwrites on every request, instead of counting `X-Forwarded-For` hops.
   * Fly: `Fly-Client-IP`. Render: `True-Client-IP`. Railway: `X-Real-IP`. Cloudflare in front:
   * `CF-Connecting-IP`. A request without it (one that did not come through that edge) uses the
   * socket address, never `X-Forwarded-For`. Never an `X-Fundroom-*` header (E-UP-7: those are
   * the edge's, believed only under its shared secret).
   */
  CLIENT_IP_HEADER: z
    .string()
    .regex(HEADER_NAME_RE, "must be an HTTP header name such as Fly-Client-IP")
    .refine(
      (h) => h.toLowerCase() !== "x-forwarded-for",
      "X-Forwarded-For is multi-valued; leave CLIENT_IP_HEADER unset and set TRUST_PROXY_HOPS",
    )
    // E-UP-7: the edge's headers are believed only under its shared secret; this one is read on
    // every request, so naming one of them here would let any client choose its own address.
    .refine(
      (h) => !h.toLowerCase().startsWith(EDGE_HEADER_PREFIX),
      "must not be an X-Fundroom-* header: those are the edge's, believed only under EDGE_SHARED_SECRET, and CLIENT_IP_HEADER is read on every request, so any client could set its own address. Name the header your platform's proxy overwrites (Railway: X-Real-IP), and the edge's in FORWARDED_CLIENT_IP_HEADER",
    )
    .optional(),
  /**
   * Edge forwarding (E-UP-7, ADR-0064): an edge (a Cloudflare Worker) in front of a PaaS that
   * routes by Host and overwrites `X-Forwarded-Host` passes the visitor's hostname in this
   * private header instead, e.g. `X-Fundroom-Forwarded-Host`. It is believed only on a request
   * whose `X-Fundroom-Edge` header carries EDGE_SHARED_SECRET (a wrong one is refused with 403;
   * without one the header is ignored). Requires EDGE_SHARED_SECRET; refused with PATH_MOUNTS.
   * Must start with `X-Fundroom-` (the namespace the edge strips from inbound requests, so the
   * visitor can never supply it); X-Fundroom-Edge and proxy-written names are refused.
   * TRUST_PROXY still governs direct (non-edge) traffic and the client IP when the edge sends
   * none (doctor warns when it is off).
   */
  FORWARDED_HOST_HEADER: edgeHeaderName("X-Fundroom-Forwarded-Host").optional(),
  /**
   * With FORWARDED_HOST_HEADER: the private header the edge puts the visitor's IP address in,
   * e.g. `X-Fundroom-Client-IP`, read under the same secret check (an IP literal only; anything
   * else is ignored). Same naming rules; must differ from FORWARDED_HOST_HEADER. Unset, every
   * custom-domain visitor shares the edge's egress address (doctor warns).
   */
  FORWARDED_CLIENT_IP_HEADER: edgeHeaderName("X-Fundroom-Client-IP").optional(),
  /**
   * The secret the edge sends in `X-Fundroom-Edge` (E-UP-7), 32+ characters
   * (`openssl rand -hex 32`); the edge holds the same value. Compared in constant time; never
   * logged.
   */
  EDGE_SHARED_SECRET: edgeSharedSecret.optional(),
  /**
   * During a rotation only: the secret being replaced, still accepted next to EDGE_SHARED_SECRET
   * until every edge sends the new one. Must differ from it; doctor warns while it is set.
   */
  EDGE_SHARED_SECRET_PREVIOUS: edgeSharedSecret.optional(),
  ROBOTS: z.enum(ROBOTS_MODES).default("noindex"),
  /**
   * Trusted Types for the HTML documents (the investor app, `/admin`, `/embed`). `enforce` puts
   * `require-trusted-types-for 'script'; trusted-types default ProseMirrorClipboard` in the
   * enforced CSP, so a string reaching an injection sink is refused by the browser; `report`
   * sends the same directives in a report-only header instead (a rollback switch for a
   * regression, and what E2.10 shipped). Never affects API or asset responses.
   */
  CSP_TRUSTED_TYPES: z.enum(CSP_TRUSTED_TYPES_MODES).default("enforce"),
  /**
   * RFC 9116 `/.well-known/security.txt` (E2.10). CONTACT is a comma-separated
   * list of `mailto:`/`https:` URIs for *this instance's* operator; unset falls
   * back to the FundRoom project's own disclosure contacts. POLICY is an https
   * URL. SECURITY_TXT=false answers 404.
   */
  SECURITY_TXT: bool.default(true),
  SECURITY_TXT_CONTACT: csv(
    z.string().regex(/^(mailto:\S+@\S+|https:\/\/\S+)$/u, "must be a mailto: or https: URI"),
  ).optional(),
  SECURITY_TXT_POLICY: z.url({ protocol: /^https$/u }).optional(),
  /**
   * Multiplies every rate-limit ceiling (E2.10), for k6 and ZAP runs against a
   * dev/test/staging stack. Refused above 1 in APP_ENV=prod, and whenever APP_ENV is not set
   * explicitly (it only defaults to dev; RL-1).
   */
  RATE_LIMIT_MULTIPLIER: z.coerce.number().int().min(1).max(1000).default(1),
  /** Shown in emails, the TOTP issuer and the web shell title. Workspaces brand on top (E1.7). */
  INSTANCE_NAME: z.string().min(1).max(120).default("FundRoom"),
  /**
   * Extra origins allowed to call `/api/v1` with credentials (exact match, scheme + host
   * [+ port]). The canonical origin is always allowed; per-workspace embed origins are E2.2.
   */
  CORS_ALLOWED_ORIGINS: csv(z.url().transform((u) => new URL(u).origin)).optional(),
  /** Built web app to serve for the `web` role (E0.7); a placeholder page is served when unset or missing. */
  WEB_DIST_PATH: z.string().min(1).optional(),
  /** How long `SIGTERM` waits for in-flight requests and jobs before exiting. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).default(25_000),
  /**
   * Persistent directory of an all-in-one install (E0.8, ADR-0018): the generated
   * `secret.key`, the `setup-token` file, and the default `STORAGE_FS_PATH` live here.
   * The container image mounts a volume at `/data`.
   */
  DATA_DIR: z.string().min(1).default("/data"),
  /**
   * Fixes the first-run setup token instead of generating one (deploy templates that cannot
   * show logs). Ignored once setup is complete; never reused as a session secret.
   */
  SETUP_TOKEN: z.string().min(16).max(256).optional(),

  // --- database ------------------------------------------------------------
  DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//u, "must be a postgres:// or postgresql:// URL"),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  /** Per-statement timeout inside withTenant()/withHost() transactions; 0 disables. */
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).max(3_600_000).default(30_000),
  /**
   * `single`: every request routes to the sole workspace (the "few clicks" install).
   * `multi`: workspaces resolve by slug from the Host header or path. Same schema either way.
   */
  TENANCY_MODE: z.enum(TENANCY_MODES).default("single"),
  /**
   * Accept a DATABASE_URL to a public host without `sslmode=verify-full`/`verify-ca` in
   * staging/prod (E2.10 F-09). For a private network whose hostname the loader cannot recognise as
   * private (see network.ts); prefer `sslmode=verify-full&sslrootcert=<ca.pem>`.
   */
  DATABASE_ACCEPT_UNVERIFIED_TLS: bool.default(false),
  MIGRATE_ON_START: bool.default(true),
  BACKUP_BEFORE_MIGRATE: bool.default(false),
  /** How long `serve`/`migrate` wait for the database to accept connections at boot (Compose ordering). */
  DATABASE_WAIT_TIMEOUT_MS: z.coerce.number().int().min(0).max(600_000).default(60_000),

  // --- secrets / crypto ----------------------------------------------------
  /**
   * Single master key (id `v1`). Use SECRET_KEY_RING instead once you rotate. Formerly
   * `SEEDHOST_SECRET_KEY`, which is still read (with a warning) when this is unset; see
   * `LEGACY_ENV_NAMES`.
   */
  FUNDROOM_SECRET_KEY: z.string().min(1).optional(),
  /** `v2:<base64>,v1:<base64>` newest first. Exactly one of this or FUNDROOM_SECRET_KEY. */
  SECRET_KEY_RING: z.string().min(1).optional(),
  /** Optional; when unset, session signing keys are derived from the key ring. */
  SESSION_SECRET: z.string().min(32).optional(),
  /** Key-encryption key provider for per-workspace DEKs (ADR-0016). `local` = the key ring. */
  KMS_DRIVER: z.enum(KMS_DRIVERS).default("local"),

  // --- identity (E0.3) -----------------------------------------------------
  /** Password login is off by default (ADR-0012); staff normally use OIDC or OTP + passkey/TOTP. */
  AUTH_PASSWORD_ENABLED: bool.default(false),
  /** Breached-password check via Have I Been Pwned k-anonymity when passwords are enabled. */
  AUTH_HIBP_CHECK: bool.default(true),
  /**
   * What a password change does when HIBP cannot be reached (F-21, ASVS 6.2.12). `open` accepts
   * the password unchecked (availability first: HIBP is a third party); `closed` refuses it with
   * `breach_check_unavailable` (503) until the check works again. Both audit
   * `auth.password_breach_check_skipped` and count a security event.
   */
  AUTH_HIBP_FAIL_MODE: z.enum(HIBP_FAIL_MODES).default("open"),
  /** Host-level kill switch; workspaces additionally opt in per §6.2. */
  AUTH_MAGIC_LINK_ENABLED: bool.default(true),
  /** WebAuthn relying-party id; defaults to the BASE_URL hostname. */
  PASSKEY_RP_ID: z.string().regex(z.regexes.hostname, "must be a hostname").optional(),
  PASSKEY_RP_NAME: z.string().min(1).default("FundRoom"),
  /** Generic OIDC for staff (§6.2). Per-workspace providers come with E1.x; this is the install-wide one. */
  OIDC_ISSUER_URL: z.url({ protocol: /^https$/u }).optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(1).optional(),
  /** Link an OIDC login to an existing account on a verified email match (only for the company's own IdP). */
  OIDC_TRUST_EMAIL: bool.default(false),
  /** Comma-separated email domains the OIDC provider may assert, e.g. `acme.com`. */
  OIDC_ALLOWED_DOMAINS: csv(z.string().regex(z.regexes.hostname, "must be a domain")).optional(),
  /**
   * Treat every login from this IdP as multi-factor (auth level 2) (E2.10 F-04). Only for an IdP
   * that enforces MFA on every sign-in but does not say so in the ID token (Google Workspace emits
   * no `amr`). Default: level 2 only when the ID token's `amr`/`acr` show MFA.
   */
  OIDC_TRUST_MFA: bool.default(false),
  /** `acr` values that mean "MFA was performed" at this IdP (comma-separated). */
  OIDC_MFA_ACR: csv(z.string().min(1).max(256)).optional(),

  // --- audit, outbox, jobs (E0.4) ------------------------------------------
  /** Months of audit.event partitions kept before the maintenance job drops them (ADR-0017). */
  AUDIT_RETENTION_MONTHS: z.coerce.number().int().min(12).max(1200).default(84),
  /** Store IPs as /24 (v4) or /48 (v6) networks in the audit log (design/02 §6). */
  AUDIT_IP_TRUNCATE: bool.default(true),
  /** Idle poll interval of the outbox relay; batches drain back-to-back. */
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  /** Worker poll interval for job queues (pg-boss). */
  JOBS_POLL_INTERVAL_MS: z.coerce.number().int().min(500).max(60_000).default(2000),

  // --- object storage ------------------------------------------------------
  STORAGE_DRIVER: z.enum(STORAGE_DRIVERS).default("fs"),
  STORAGE_FS_PATH: z.string().min(1).default("/data/storage"),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: bool.default(false),
  /** Largest single upload the kernel accepts (bytes). Default 5 GiB; workspaces may set lower. */
  UPLOAD_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(5 * 1024 ** 4)
    .default(5 * 1024 ** 3),
  /** Largest blob the worker loads into memory to sanitise, extract text and rasterise (bytes). Default 200 MiB. */
  RENDER_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(4 * 1024 ** 3)
    .default(200 * 1024 ** 2),

  // --- virus scanning (E1.3) -----------------------------------------------
  /** `noop` marks uploads `skipped` (admin-visible warning); `clamd` streams them to ClamAV. */
  AV_DRIVER: z.enum(AV_DRIVERS).default("noop"),
  /**
   * Run staging/prod without a virus scanner (E2.10 F-11): required with AV_DRIVER=noop there.
   * Uploads are then stored `skipped`, and each workspace decides whether unscanned files are
   * servable (`dataRoom.allowUnscanned`, off by default).
   */
  AV_ACCEPT_UNSCANNED: bool.default(false),
  CLAMD_HOST: z.string().min(1).optional(),
  CLAMD_PORT: port.default(3310),
  CLAMD_TIMEOUT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(120_000),

  // --- email ---------------------------------------------------------------
  MAILER_DRIVER: z.enum(MAILER_DRIVERS).default("smtp"),
  MAIL_FROM: z.email().optional(),
  /** Display name for the sender, e.g. `Acme Investor Relations`. */
  MAIL_FROM_NAME: z.string().min(1).max(200).optional(),
  /**
   * smtps://user:pass@host:465, or smtp://user:pass@host:587?requireTLS=true (staging/prod refuse
   * plain STARTTLS-if-offered to a public relay, F-08); Mailpit in dev is smtp://localhost:1025
   */
  SMTP_URL: z
    .string()
    .regex(/^smtps?:\/\//u, "must be an smtp:// or smtps:// URL")
    .optional(),
  // ESP-native drivers (E2.6). Each one sends over the HTTPS API and parses its own webhook
  // (`POST /webhooks/email/<driver>`) into bounces, complaints, deliveries, opens and clicks.
  /** Resend API key (`re_…`). */
  RESEND_API_KEY: z.string().min(1).optional(),
  /** Resend webhook signing secret (`whsec_…`, Svix). Unset = the webhook answers 404. */
  RESEND_WEBHOOK_SECRET: z
    .string()
    .regex(/^whsec_[A-Za-z0-9+/=]+$/u, "must be the whsec_… signing secret Resend shows")
    .optional(),
  /** Postmark server API token (`X-Postmark-Server-Token`). */
  POSTMARK_SERVER_TOKEN: z.string().min(1).optional(),
  /** Postmark message stream for `broadcast` mail (investor updates); others use `outbound`. */
  POSTMARK_BROADCAST_STREAM: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/u, "must be a Postmark message stream id")
    .default("broadcast"),
  /** Basic-auth credentials you put into the Postmark webhook URL. Both or neither. */
  POSTMARK_WEBHOOK_USER: z.string().min(1).max(200).optional(),
  POSTMARK_WEBHOOK_PASSWORD: z.string().min(16).max(200).optional(),
  /** SES v2 region, e.g. `eu-west-1`. */
  AWS_REGION: z
    .string()
    .regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u, "must be an AWS region such as eu-west-1")
    .optional(),
  AWS_ACCESS_KEY_ID: z.string().min(16).max(128).optional(),
  AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  /** Only for temporary credentials (STS); leave unset for an IAM user's long-lived key. */
  AWS_SESSION_TOKEN: z.string().min(1).optional(),
  /** SES configuration set whose event destination publishes to SNS (opens/clicks/bounces). */
  SES_CONFIGURATION_SET: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/u, "must be an SES configuration set name")
    .optional(),
  /** SNS topic ARNs whose notifications the SES webhook accepts; every other topic is refused. */
  SES_SNS_TOPIC_ARNS: csv(
    z.string().regex(/^arn:aws(?:-[a-z]+)?:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/u, {
      message: "must be SNS topic ARNs (arn:aws:sns:<region>:<account>:<topic>)",
    }),
  ).optional(),

  // --- outbound HTTP / security headers (E0.5) ------------------------------
  /**
   * Let the SSRF guard reach private, loopback and link-local addresses (webhooks to an
   * internal host, an OIDC issuer on the LAN, dev tooling). Refused in prod unless
   * OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS names the hosts.
   */
  OUTBOUND_HTTP_ALLOW_PRIVATE: bool.default(false),
  /** Hostnames or IP literals the guard may reach even when they resolve privately. */
  OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: csv(z.string().min(1)).optional(),
  /**
   * Outbound webhooks' own private-host allow-list (E3.4). Webhook URLs are chosen by workspace
   * admins, not by the operator, so they never inherit OUTBOUND_HTTP_ALLOW_PRIVATE[_HOSTS]: only
   * the hosts named here may be reached on a private address (and over plain http). Default empty.
   * Refused in prod for loopback / unspecified addresses (a tenant could then probe the instance
   * itself).
   */
  WEBHOOK_ALLOW_PRIVATE_HOSTS: csv(z.string().min(1)).optional(),
  /** Send `Strict-Transport-Security` on https responses. */
  HSTS: bool.default(true),
  /** Add `preload` (and `includeSubDomains`) to HSTS. Only for standalone domains you own. */
  HSTS_PRELOAD: bool.default(false),
  /**
   * Add `includeSubDomains` to HSTS (ASVS 3.4.1, E2.10 F-15). Unset = on for a host-mounted
   * install, off for one served under a path (BASE_PATH or a BASE_URL path set — see
   * `ownsNoHost`), where the host is not ours to pin; `true` is refused there. Responses served
   * through a PATH_MOUNTS mount never carry HSTS.
   * See `hstsIncludeSubDomains()`.
   */
  HSTS_INCLUDE_SUBDOMAINS: bool.optional(),

  // --- custom domains (E2.1) -----------------------------------------------
  /**
   * How a workspace's verified custom domain gets its certificate. `caddy-ask` answers Caddy's
   * on-demand TLS `ask` endpoint, so the edge in front of this process issues on the first
   * handshake; `manual` verifies DNS only and tells the operator they terminate TLS themselves.
   */
  CUSTOM_DOMAIN_DRIVER: z.enum(CUSTOM_DOMAIN_DRIVERS).default("caddy-ask"),
  /**
   * Hostname customers point their CNAME at. Unset means the canonical host (the BASE_URL
   * host), because a self-hoster's edge *is* their own host; a managed host points this at a
   * dedicated edge instead. The default is applied in the composition root, which is where the
   * canonical host is already derived.
   */
  CUSTOM_DOMAIN_CNAME_TARGET: z.string().regex(z.regexes.hostname, "must be a domain").optional(),
  /**
   * **Override** for the addresses a zone apex may point at, as a csv of IP literals.
   *
   * A zone apex cannot hold a CNAME, so a customer who wants `acme.com` itself served publishes
   * `A`/`AAAA` records — either through their DNS host's ALIAS/CNAME-flattening feature or by
   * copying our edge's addresses by hand (design/07 §2.3(a)). Unset (the normal case, and the
   * one that needs no operator knowledge) the verifier resolves `CUSTOM_DOMAIN_CNAME_TARGET`'s
   * own `A`/`AAAA` through the same DoH resolvers and accepts the apex when the address sets
   * intersect — which stays correct when the edge moves. Set this only when the edge's addresses
   * are stable anycast ones that DNS does not describe (a load balancer whose A record is not the
   * address traffic arrives on); it is then used instead of resolving the target.
   */
  CUSTOM_DOMAIN_EDGE_ADDRESSES: csv(z.union([z.ipv4(), z.ipv6()])).optional(),
  /**
   * DoH JSON endpoints used to verify custom and sending domains, in order. Unset means the
   * adapter's defaults (1.1.1.1 then 8.8.8.8, by address, so no system resolver sits between us
   * and the customer's zone). Two or more are required in prod-like environments — see
   * `crossFieldRules`.
   */
  DOH_ENDPOINTS: csv(z.url()).optional(),
  /**
   * `cloudflare-saas` (E3.10): a Cloudflare for SaaS API token with "SSL and Certificates Write" on
   * the zone below. Required with that driver.
   */
  CLOUDFLARE_API_TOKEN: z.string().min(1).optional(),
  /** The Cloudflare zone (32 hex) that holds the custom hostnames. Required with `cloudflare-saas`. */
  CLOUDFLARE_ZONE_ID: z
    .string()
    .regex(/^[0-9a-f]{32}$/u, "must be a 32-character Cloudflare zone id")
    .optional(),
  /** Test seam: the Cloudflare API base. Any other value is refused in APP_ENV=prod. */
  CLOUDFLARE_API_BASE: z.url({ protocol: /^https?$/u }).default(DEFAULT_CLOUDFLARE_API_BASE),
  /**
   * Cloudflare in front of this process (E3.10): read the client address from `CF-Connecting-IP`,
   * but only when the TCP peer is inside Cloudflare's published ranges (vendored in
   * `@fundroom/http`). Default off.
   */
  CLOUDFLARE_TRUSTED_PROXY: z.enum(CONTROL_PLANE_MODES).default("off"),

  // --- spreadsheets (E2.4) -------------------------------------------------
  /**
   * How the `metrics` module reads a KPI spreadsheet. `sheets-google` talks to the Sheets v4
   * REST API as a service account — the admin pastes the service-account JSON and shares the
   * sheet with its address, so there is no OAuth client to register. `noop` answers every read
   * with `not_found`, which switches the integration off for an operator who does not want this
   * process reaching Google at all; the sync then records a typed failure and the rest of the
   * module (manual entry, CSV import, derived metrics) is unaffected.
   */
  SPREADSHEET_DRIVER: z.enum(["sheets-google", "noop"]).default("sheets-google"),

  // --- accredited-investor verification (E2.5) -----------------------------
  /**
   * Who settles a Rule 506(c) accreditation verification. `manual` — the only driver today — has
   * the investor upload evidence and a staff member decide; the adapter never answers anything
   * but `pending`, because claiming otherwise would assert on the issuer's behalf that they took
   * the reasonable steps the rule requires. A vendor bureau would be a second id here and nothing
   * else: the evidence, its encryption and its retention belong to the round module either way.
   */
  ACCREDITATION_DRIVER: z.enum(ACCREDITATION_DRIVERS).default("manual"),
  /**
   * The accreditation vendors workspace admins may connect to (E3.7, comma list). Default both;
   * `none` turns vendors off (every workspace verifies manually) — an empty value cannot, because
   * the loader treats an empty variable as unset. A workspace keeps a connection it already has
   * when its driver is later removed here, but cannot create or replace one with it.
   */
  ACCREDITATION_DRIVERS: z
    .string()
    .transform((s) => (s.trim().toLowerCase() === "none" ? "" : s))
    .pipe(csv(z.enum(ACCREDITATION_VENDOR_DRIVERS)))
    .default([...ACCREDITATION_VENDOR_DRIVERS]),
  /**
   * The accreditation client's own private-host allow-list (E3.7) — test rigs and a vendor
   * sandbox proxy on the LAN only. Like ESIGN_ALLOW_PRIVATE_HOSTS it never inherits
   * OUTBOUND_HTTP_ALLOW_PRIVATE[_HOSTS]. Default empty. Refused in prod/staging for loopback /
   * unspecified / wildcard entries.
   */
  ACCREDITATION_ALLOW_PRIVATE_HOSTS: csv(z.string().min(1)).optional(),

  // --- staff SSO + SCIM (E3.8, ADR-0056) -----------------------------------
  /**
   * The protocols a workspace admin may configure a staff SSO connection with (comma list of
   * `oidc,saml`). Default both; `none` turns per-workspace SSO off — an empty value cannot, because
   * the loader treats an empty variable as unset. A workspace keeps a connection it already has
   * when its protocol is later removed here, but cannot create, replace or sign in with it.
   */
  SSO_PROTOCOLS: z
    .string()
    .transform((s) => (s.trim().toLowerCase() === "none" ? "" : s))
    .pipe(csv(z.enum(SSO_PROTOCOL_IDS)))
    .default([...SSO_PROTOCOL_IDS]),
  /**
   * SCIM 2.0 provisioning at `${BASE_URL}/scim/v2` (E3.8). Default on; `false` answers 404 under
   * `/scim/v2` and hides the admin's token controls.
   */
  SCIM_ENABLED: bool.default(true),
  /**
   * The SSO client's own private-host allow-list (E3.8): OIDC discovery/JWKS and SAML metadata
   * fetches — test rigs and an IdP on the LAN (Keycloak) only. Like
   * ACCREDITATION_ALLOW_PRIVATE_HOSTS it never inherits OUTBOUND_HTTP_ALLOW_PRIVATE[_HOSTS].
   * Default empty. Refused in prod/staging for loopback / unspecified / wildcard entries.
   */
  SSO_ALLOW_PRIVATE_HOSTS: csv(z.string().min(1)).optional(),

  // --- managed-host control plane (E3.10, ADR-0058) -------------------------
  /**
   * The operator surface, plans, usage, billing, sanctions screening and signup. `on` requires
   * TENANCY_MODE=multi. Off (the default) everything below is inert: no workspace is ever
   * suspended, plans are unlimited and the billing/platform routes answer 404.
   */
  CONTROL_PLANE: z.enum(CONTROL_PLANE_MODES).default("off"),
  /**
   * The cell this process serves (E3.10). With CONTROL_PLANE=on a request for a workspace placed on
   * another cell is answered 421 `wrong_cell` with `X-Fundroom-Cell`, so an edge can retry there.
   */
  CELL_ID: z.string().regex(CELL_ID_RE, "must be a lower-case id like eu-1").default("default"),
  /**
   * Client networks platform operators may work from (comma list of CIDRs or addresses). When set,
   * the operator session is minted and every `/api/v1/platform/*` request answered only from these
   * addresses (the client address as TRUST_PROXY derives it); anything else is a plain 404.
   */
  PLATFORM_OPERATOR_CIDRS: csv(
    z.string().refine((e) => parseCidr(e) !== undefined, "must be a CIDR such as 203.0.113.0/24"),
  ).optional(),
  /** Self-service signup on the canonical host (E3.10). `open` requires CONTROL_PLANE=on. */
  SIGNUP_MODE: z.enum(SIGNUP_MODES).default("off"),
  /**
   * The plan a self-service signup starts on (a `core.plan` id). Required with SIGNUP_MODE=open;
   * whether it exists is checked at runtime (signup answers 404 until it does).
   */
  SIGNUP_DEFAULT_PLAN: z.string().regex(PLAN_ID_RE, "must be a plan id like starter").optional(),
  /**
   * The platform terms version a signup accepts (E-UP-4): recorded as the attestation kind
   * `platform-terms:v<n>`. Raise it when TERMS_URL's document changes materially. Raising it
   * affects new signups only: existing owners are not re-prompted. Roll every replica together,
   * since a replica still on the old value answers applicants 409 `terms_version` until they agree.
   */
  SIGNUP_TERMS_VERSION: z.coerce.number().int().min(1).max(10000).default(1),
  /**
   * The host's own links (E-UP-4): the operator's terms, privacy policy, support and status pages,
   * shown when set in the footer of the host's pages (admin area, signup, setup, operator console,
   * sign-in on the canonical host), never on the investor portal or a workspace host's sign-in
   * pages, where the tenant is the controller. TERMS_URL also sits next to the signup terms
   * checkbox. An https:// URL (http:// only for localhost); SUPPORT_URL alone may instead be a bare
   * mailto: address. Unset, the link is not shown.
   */
  TERMS_URL: publicLinkUrl(false).optional(),
  PRIVACY_URL: publicLinkUrl(false).optional(),
  SUPPORT_URL: publicLinkUrl(true).optional(),
  STATUS_URL: publicLinkUrl(false).optional(),
  /** Who collects payment (E3.10). `manual` and `stripe` require CONTROL_PLANE=on. */
  BILLING_DRIVER: z.enum(BILLING_DRIVERS).default("none"),
  /** Stripe secret or restricted key (`sk_…` / `rk_…`). Required with BILLING_DRIVER=stripe. */
  STRIPE_SECRET_KEY: z
    .string()
    .regex(/^(?:sk|rk)_[A-Za-z0-9_]+$/u, "must be a Stripe secret (sk_…) or restricted (rk_…) key")
    .optional(),
  /** The webhook endpoint's signing secret (`whsec_…`). Required with BILLING_DRIVER=stripe. */
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .regex(/^whsec_[A-Za-z0-9_+/=]+$/u, "must be a Stripe webhook signing secret (whsec_…)")
    .optional(),
  /** Test seam: the Stripe API base. Any other value is refused in APP_ENV=prod. */
  STRIPE_API_BASE: z.url({ protocol: /^https?$/u }).default(DEFAULT_STRIPE_API_BASE),
  /** Days a `past_due`/`unpaid` workspace keeps working before it is suspended (0–60). */
  BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(14),
  /**
   * The Stripe meter `event_name` the daily staff-seat count is reported under
   * (BILLING_DRIVER=stripe). Must match the meter's event name in your Stripe account.
   */
  BILLING_METER_SEATS_EVENT: z
    .string()
    .regex(
      STRIPE_METER_EVENT_RE,
      "must be 1–100 letters, digits or underscores (a Stripe meter event name)",
    )
    .default("fundroom_staff_seats"),
  /**
   * The Stripe meter `event_name` the daily storage figure (GB) is reported under
   * (BILLING_DRIVER=stripe). Must match the meter's event name in your Stripe account.
   */
  BILLING_METER_STORAGE_EVENT: z
    .string()
    .regex(
      STRIPE_METER_EVENT_RE,
      "must be 1–100 letters, digits or underscores (a Stripe meter event name)",
    )
    .default("fundroom_storage_gb"),
  /**
   * Sanctions screening of every tenant company (E3.10). `ofac` downloads the US SDN and
   * consolidated lists and matches locally; `opensanctions` asks a yente server (or the hosted
   * API, which needs a commercial data licence for a managed host). Non-`none` requires
   * CONTROL_PLANE=on.
   */
  SANCTIONS_DRIVER: z.enum(SANCTIONS_DRIVERS).default("none"),
  /** Test seam: the OFAC export directory the `ofac` adapter appends `SDN.CSV` etc. to. */
  SANCTIONS_OFAC_URL: z.url({ protocol: /^https?$/u }).default(DEFAULT_SANCTIONS_OFAC_URL),
  /** The yente (or hosted OpenSanctions API) base URL. Required with SANCTIONS_DRIVER=opensanctions. */
  SANCTIONS_OPENSANCTIONS_URL: z.url({ protocol: /^https?$/u }).optional(),
  /** The hosted OpenSanctions API key (`Authorization: ApiKey …`); yente itself has no auth. */
  SANCTIONS_OPENSANCTIONS_API_KEY: z.string().min(1).optional(),
  /**
   * Hosts besides `api.opensanctions.org` the API key may be sent to (e.g. an authenticating
   * proxy in front of yente). The key goes nowhere else: a key with a SANCTIONS_OPENSANCTIONS_URL
   * on any other host is refused at startup.
   */
  SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS: csv(z.string().min(1)).optional(),
  /** Match score (0.5–1) at or above which a name is a potential match. Default 0.88. */
  SANCTIONS_MATCH_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.88),
  /**
   * Central auth origin (E3.10): custom domains and `<slug>.<canonical>` hosts sign in through the
   * canonical host (BASE_URL) and receive a session bound to that workspace. Any tenancy mode.
   */
  CENTRAL_AUTH: z.enum(CONTROL_PLANE_MODES).default("off"),

  // --- per-tenant data residency (E3.11) -----------------------------------
  /**
   * The region this deployment's data lives in, as the operator declares it (a code like `eu`).
   * Written onto this install's cells at boot; every workspace's `data_region` derives from its
   * cell. The product cannot verify where a database physically is — everything tenants see says
   * this is operator-declared.
   */
  DATA_REGION: z
    .string()
    .regex(DATA_REGION_RE, "must be a lower-case region code like eu")
    .optional(),
  /** Human text for DATA_REGION, e.g. "European Union (Frankfurt, Germany)". Requires DATA_REGION. */
  DATA_REGION_LABEL: z.string().min(1).max(120).optional(),
  /** The legal jurisdiction of DATA_REGION (`eu|uk|ch|us|ca|au|other`). Requires DATA_REGION. */
  DATA_REGION_JURISDICTION: z.enum(DATA_JURISDICTIONS).optional(),
  /** Where this deployment's backups live, as the operator declares it (human text). */
  BACKUP_LOCATION: z.string().min(1).max(120).optional(),
  /**
   * The shared cell directory (E3.11): global slug/hostname uniqueness, cross-cell routing and
   * moves between cells. Unset = `local` mode (this database alone decides). Requires
   * CONTROL_PLANE=on, DATA_REGION and DATA_REGION_JURISDICTION.
   */
  DIRECTORY_DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//u, "must be a postgres:// or postgresql:// URL")
    .optional(),
  DIRECTORY_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(20).default(4),
  /**
   * DATABASE_ACCEPT_UNVERIFIED_TLS for the directory (E3.11 R2-1): accept a DIRECTORY_DATABASE_URL
   * to a public host without `sslmode=verify-full`/`verify-ca` in staging/prod. The directory
   * carries every cell's export public key (the trust root of a move) and the move rows, and is by
   * design reached across regions — prefer `sslmode=verify-full&sslrootcert=<ca.pem>`.
   */
  DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS: bool.default(false),
  /** Hours a move's source cell keeps its copy after the directory switched (0–720). Default 0. */
  MOVE_SOURCE_RETENTION_HOURS: z.coerce.number().int().min(0).max(720).default(0),
  /** Largest export bundle a target cell downloads for a move (bytes). Default 50 GiB. */
  MOVE_MAX_BUNDLE_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .default(50 * 1024 ** 3),

  // --- e-signature (E3.5, ADR-0053) ----------------------------------------
  /**
   * The e-sign vendors workspace admins may connect to (comma list). Default all four. A
   * workspace keeps a connection it already has when its driver is later removed here, but
   * cannot create or replace one with it.
   */
  ESIGN_DRIVERS: csv(z.enum(ESIGN_DRIVER_IDS)).default([...ESIGN_DRIVER_IDS]),
  /**
   * The e-sign client's own private-host allow-list, for a self-hosted Documenso or DocuSeal on
   * the LAN. Like WEBHOOK_ALLOW_PRIVATE_HOSTS: vendor base URLs are chosen by workspace admins,
   * so the e-sign client never inherits OUTBOUND_HTTP_ALLOW_PRIVATE[_HOSTS]; only the hosts named
   * here may be reached on a private address (and over plain http). Default empty. Refused in
   * prod/staging for loopback / unspecified / wildcard entries.
   */
  ESIGN_ALLOW_PRIVATE_HOSTS: csv(z.string().min(1)).optional(),
  /** Largest signed document or certificate the e-sign collector downloads (bytes). Default 25 MiB. */
  ESIGN_MAX_ARTIFACT_BYTES: z.coerce
    .number()
    .int()
    .min(1_048_576)
    .max(100 * 1024 ** 2)
    .default(25 * 1024 ** 2),

  // --- integrations hub (E3.6, ADR-0054) -----------------------------------
  /**
   * Deployment-level OAuth clients (one app registration per operator, docs/integrations). A
   * provider whose client is unset shows as "not configured by the operator" and cannot be
   * connected; each ID/SECRET pair is set together or not at all. Stripe, Calendly and Cal.com
   * need no client (workspace admins paste a restricted key / token).
   */
  INTEGRATIONS_QUICKBOOKS_CLIENT_ID: z.string().min(1).optional(),
  INTEGRATIONS_QUICKBOOKS_CLIENT_SECRET: z.string().min(1).optional(),
  /** Which Intuit environment the QuickBooks client belongs to. Default production. */
  INTEGRATIONS_QUICKBOOKS_ENVIRONMENT: z.enum(["production", "sandbox"]).default("production"),
  INTEGRATIONS_XERO_CLIENT_ID: z.string().min(1).optional(),
  INTEGRATIONS_XERO_CLIENT_SECRET: z.string().min(1).optional(),
  INTEGRATIONS_SLACK_CLIENT_ID: z.string().min(1).optional(),
  INTEGRATIONS_SLACK_CLIENT_SECRET: z.string().min(1).optional(),
  /**
   * The integrations client's own private-host allow-list — tests and local vendor fakes only.
   * Never inherits OUTBOUND_HTTP_ALLOW_PRIVATE[_HOSTS]. Refused in prod/staging for loopback /
   * unspecified / wildcard entries.
   */
  INTEGRATIONS_ALLOW_PRIVATE_HOSTS: csv(z.string().min(1)).optional(),

  // --- AI assist (E3.12) ---------------------------------------------------
  /**
   * The model provider AI assist uses (E3.12). `none` (default) = the feature is unavailable on
   * this install. `openai-compatible` is the self-hosted adapter (Ollama, vLLM, llama.cpp server,
   * LM Studio) and also speaks to hosted OpenAI-compatible APIs; `anthropic` is Claude's API.
   * Every workspace still opts in separately.
   */
  AI_PROVIDER: z.enum(AI_PROVIDERS).default("none"),
  /**
   * The model server's base URL (`http://ollama:11434`; a trailing `/v1` is accepted). Required
   * with openai-compatible. For anthropic it defaults to https://api.anthropic.com and is a test
   * seam that must stay that in APP_ENV=prod.
   */
  AI_BASE_URL: z.url({ protocol: /^https?$/u }).optional(),
  /** The provider API key. Required with anthropic; optional for openai-compatible. */
  AI_API_KEY: z.string().min(1).optional(),
  /** The model id (`qwen3.5:9b`, `claude-opus-5`). Required when AI_PROVIDER is not none. */
  AI_MODEL: z.string().min(1).max(200).optional(),
  /**
   * openai-compatible only: who runs the model. Unset = `self_hosted` when AI_BASE_URL's host is
   * evidently operator-run (a private address, a service name, `.internal`…), else `third_party`.
   */
  AI_HOSTING: z.enum(AI_HOSTINGS).optional(),
  /** Display / sub-processor name. Required for a third-party openai-compatible provider. */
  AI_PROVIDER_LABEL: z.string().min(1).max(120).optional(),
  /** Where the provider processes data (human text, e.g. "United States"). */
  AI_PROVIDER_LOCATION: z.string().min(1).max(120).optional(),
  /** The provider's jurisdiction (`eu|uk|ch|us|ca|au|other|varies`). Required for a third-party openai-compatible provider. */
  AI_PROVIDER_JURISDICTION: z.enum([...DATA_JURISDICTIONS, "varies"]).optional(),
  /** openai-compatible only: how structured output is requested. Default json_schema. */
  AI_JSON_MODE: z.enum(AI_JSON_MODES).default("json_schema"),
  /** openai-compatible only: the output-token parameter name. Default max_tokens. */
  AI_TOKEN_PARAM: z.enum(AI_TOKEN_PARAMS).default("max_tokens"),
  /** One model call's timeout (5 s–15 min). Default 3 min: local models are slow. */
  AI_TIMEOUT_MS: z.coerce.number().int().min(5000).max(900_000).default(180_000),
  /** Output-token cap per model call (256–32000). Default 4000. */
  AI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(32_000).default(4000),
  /** Prompt size budget in characters (4000–400000). Default 60000 (small local contexts). */
  AI_MAX_INPUT_CHARS: z.coerce.number().int().min(4000).max(400_000).default(60_000),
  /** Model calls in flight per process (1–32). Default 2. */
  AI_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  /** Tokens (input + output) per workspace per UTC calendar month. Workspaces may set lower. */
  AI_MONTHLY_TOKEN_BUDGET: z.coerce.number().int().min(1000).max(10_000_000_000).default(2_000_000),
  /** AI requests one staff member may start per hour (1–1000). Default 30. */
  AI_REQUESTS_PER_USER_HOUR: z.coerce.number().int().min(1).max(1000).default(30),
  /** Hours a suggestion is kept before the retention sweep deletes it (1–2160). Default 168. */
  AI_RESULT_RETENTION_HOURS: z.coerce.number().int().min(1).max(2160).default(168),

  // --- evidence: external audit anchoring (E3.13, ADR-0061) -------------------
  /**
   * Which external anchors timestamp the daily audit checkpoints (csv of `rfc3161`, `rekor`).
   * Empty (default) = anchoring is off and the `audit.anchor` job is not registered.
   */
  AUDIT_ANCHOR_DRIVERS: csv(z.enum(AUDIT_ANCHOR_DRIVER_IDS)).default([]),
  /** RFC 3161 TSA endpoints, tried in order (csv). Required with the rfc3161 driver. */
  AUDIT_ANCHOR_TSA_URLS: csv(z.url({ protocol: /^https?$/u })).optional(),
  /**
   * PEM bundle of the pinned TSA certificates / roots a timestamp must chain to. Required with
   * the rfc3161 driver; may also be set with the driver off (verification-only pins for receipts
   * already stored). Usually given as AUDIT_ANCHOR_TSA_CERTS_FILE=/path/to/tsa-certs.pem.
   */
  AUDIT_ANCHOR_TSA_CERTS: z
    .string()
    .refine(
      (v) => pemBlocks(v, "CERTIFICATE").length > 0,
      "must contain at least one PEM CERTIFICATE",
    )
    .superRefine((v, ctx) => unparseablePem(v, "CERTIFICATE", ctx))
    .optional(),
  /** The Rekor v2 log shard base URL. Required with the rekor driver (no default: shards rotate). */
  AUDIT_ANCHOR_REKOR_URL: z.url({ protocol: /^https?$/u }).optional(),
  /**
   * The Rekor logs' PEM public keys (checkpoint signers). The FIRST is the current shard's (the one
   * AUDIT_ANCHOR_REKOR_URL names); keep older shards' keys after it so their receipts still verify.
   * Required with the rekor driver; may be set with it off (verification-only pins). Usually given
   * as AUDIT_ANCHOR_REKOR_LOG_KEY_FILE=/path/to/rekor-keys.pem.
   */
  AUDIT_ANCHOR_REKOR_LOG_KEY: z
    .string()
    .refine(
      (v) => pemBlocks(v, "PUBLIC KEY").length > 0,
      "must contain at least one PEM PUBLIC KEY",
    )
    .superRefine((v, ctx) => unparseablePem(v, "PUBLIC KEY", ctx))
    .optional(),
  /**
   * The Rekor checkpoint origins (C2SP note names) receipts must be signed under (csv). The FIRST
   * is the current shard's — every new checkpoint must carry it; all are accepted when verifying,
   * so keep old shards' origins next to their keys. Default: the hostname of AUDIT_ANCHOR_REKOR_URL.
   */
  AUDIT_ANCHOR_REKOR_ORIGIN: csv(
    z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\x21-\x7e]+$/u, "must be a printable origin without spaces"),
  ).optional(),
  /** One anchor call's timeout (1–120 s). Default 15 s. */
  AUDIT_ANCHOR_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),

  // --- authz engine (E3.13, ADR-0061) ---------------------------------------
  /**
   * `postgres` (default): Postgres alone decides access. `openfga`: an OpenFGA server receives a
   * projection of the access rules and, per AUTHZ_OPENFGA_MODE, shadows or narrows external
   * principals' checks. Postgres stays the source of truth (RLS keeps reading effective_access).
   */
  AUTHZ_ENGINE: z.enum(AUTHZ_ENGINES).default("postgres"),
  /** The OpenFGA HTTP API base URL. Required with AUTHZ_ENGINE=openfga. */
  AUTHZ_OPENFGA_URL: z.url({ protocol: /^https?$/u }).optional(),
  /** OpenFGA preshared key (sent as a bearer token), when the server requires one. */
  AUTHZ_OPENFGA_API_TOKEN: z.string().min(1).optional(),
  /** `shadow` (default): compare only, never change a decision. `enforce`: the engine may narrow. */
  AUTHZ_OPENFGA_MODE: z.enum(AUTHZ_OPENFGA_MODES).default("shadow"),
  /** Fraction (0–1) of external checks shadow-compared. Default 1. */
  AUTHZ_OPENFGA_SHADOW_SAMPLE: z.coerce.number().min(0).max(1).default(1),
  /** One engine call's timeout (100 ms–30 s). Default 1500 ms. */
  AUTHZ_OPENFGA_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(1500),

  // --- observability -------------------------------------------------------
  OTEL_EXPORTER_OTLP_ENDPOINT: z.url().optional(),
  OTEL_SERVICE_NAME: z.string().min(1).default("fundroom"),
  ERROR_REPORTING_DSN: z.url().optional(),
  /**
   * Serve Prometheus text at `/metrics`. Unset = on in dev/test, and in staging/prod only when
   * METRICS_TOKEN is set (E2.10 F-01); `true` without a token is refused there. See
   * `metricsEnabled()`.
   */
  METRICS_ENABLED: bool.optional(),
  /** When set, `/metrics` requires `Authorization: Bearer <token>`. Required in staging/prod. */
  METRICS_TOKEN: z.string().min(16).optional(),

  // --- operator toggles ----------------------------------------------------
  /** Checks releases.fundroom.com/index.json (no identifiers sent). Opt out per §4.4 of design/07. */
  UPDATE_CHECK: bool.default(true),
  /**
   * The release index the update check reads (design/07 §4.4). A static JSON file; the request
   * carries no query string, cookies or identifiers. Must be https in staging/prod (see
   * `crossFieldRules`); http is for a local test server only. No query, fragment or userinfo:
   * anything the operator put there would be an identifier the check promises not to send.
   */
  UPDATE_CHECK_URL: z
    .url({ protocol: /^https?$/u, hostname: z.regexes.hostname })
    .refine((u) => {
      if (!URL.canParse(u)) return true; // the url check above already reported it
      const url = new URL(u);
      return url.search === "" && url.hash === "" && url.username === "" && url.password === "";
    }, "must not carry a query string, fragment or credentials")
    .default("https://releases.fundroom.com/index.json"),
  /**
   * Offer the generated `en-XA` pseudo-locale in the language switch (E2.8). For translators and
   * layout QA on a staging install; development builds always offer it.
   */
  I18N_PSEUDO_LOCALE: bool.default(false),
});

export type RawEnv = z.output<typeof envSchema>;

/** Every key the loader knows about (drives `*_FILE` resolution and doctor rows). */
export const ENV_KEYS = Object.keys(envSchema.shape) as ReadonlyArray<keyof RawEnv & string>;

/** Redacted everywhere: doctor, logs, error reports. */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "FUNDROOM_SECRET_KEY",
  "SECRET_KEY_RING",
  "SESSION_SECRET",
  "OIDC_CLIENT_SECRET",
  "S3_SECRET_ACCESS_KEY",
  "SMTP_URL",
  "RESEND_API_KEY",
  "RESEND_WEBHOOK_SECRET",
  "POSTMARK_SERVER_TOKEN",
  "POSTMARK_WEBHOOK_PASSWORD",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "ERROR_REPORTING_DSN",
  "METRICS_TOKEN",
  "SETUP_TOKEN",
  "INTEGRATIONS_QUICKBOOKS_CLIENT_SECRET",
  "INTEGRATIONS_XERO_CLIENT_SECRET",
  "INTEGRATIONS_SLACK_CLIENT_SECRET",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SANCTIONS_OPENSANCTIONS_API_KEY",
  "CLOUDFLARE_API_TOKEN",
  "DIRECTORY_DATABASE_URL",
  "AI_API_KEY",
  "AUTHZ_OPENFGA_API_TOKEN",
  "EDGE_SHARED_SECRET",
  "EDGE_SHARED_SECRET_PREVIOUS",
]);

/**
 * Config keys that were renamed, mapped to their old name (A-2, ADR-0062). The loader reads the
 * old name (and its `_FILE` twin) when no spelling of the new one is set, records it on
 * `AppConfig.legacyEnv` so `doctor` and boot warn, and refuses to start when both are set
 * (see `resolveEnv`). Add a row here for any later rename; remove one only in the release that
 * drops the old name.
 */
export const LEGACY_ENV_NAMES: Readonly<Partial<Record<keyof RawEnv & string, string>>> = {
  FUNDROOM_SECRET_KEY: "SEEDHOST_SECRET_KEY",
};

/** Human examples used in error messages. */
export const EXAMPLES: Readonly<Partial<Record<keyof RawEnv, string>>> = {
  MAIL_FROM_NAME: "Acme Investor Relations",
  OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS: "keycloak.internal,10.0.0.5",
  WEBHOOK_ALLOW_PRIVATE_HOSTS: "hooks.internal,10.0.0.7",
  ESIGN_ALLOW_PRIVATE_HOSTS: "documenso.internal,10.0.0.8",
  ESIGN_DRIVERS: "documenso,docuseal",
  ACCREDITATION_DRIVERS: "verifyinvestor,parallel-markets",
  ACCREDITATION_ALLOW_PRIVATE_HOSTS: "accred-proxy.internal,10.0.0.10",
  SSO_PROTOCOLS: "oidc,saml",
  SSO_ALLOW_PRIVATE_HOSTS: "keycloak.internal,10.0.0.11",
  INTEGRATIONS_ALLOW_PRIVATE_HOSTS: "qbo-fake.internal,10.0.0.9",
  INTEGRATIONS_QUICKBOOKS_CLIENT_ID: "ABcd1234…",
  INTEGRATIONS_XERO_CLIENT_ID: "0A1B2C3D…",
  INTEGRATIONS_SLACK_CLIENT_ID: "1234567890.1234567890",
  BASE_URL: "https://investors.example.com",
  DATABASE_URL: "postgres://seedhost:secret@db:5432/seedhost",
  FUNDROOM_SECRET_KEY: "$(openssl rand -base64 32)",
  SECRET_KEY_RING: "v2:$(openssl rand -base64 32),v1:<previous key>",
  MAIL_FROM: "investors@example.com",
  SMTP_URL: "smtps://user:pass@smtp.example.com:465",
  AWS_REGION: "eu-west-1",
  SES_SNS_TOPIC_ARNS: "arn:aws:sns:eu-west-1:123456789012:fundroom-ses-events",
  S3_BUCKET: "fundroom-documents",
  S3_ENDPOINT: "https://<account>.r2.cloudflarestorage.com",
  S3_REGION: "auto",
  STORAGE_FS_PATH: "/data/storage",
  CLAMD_HOST: "clamav",
  ROLES: "api,web,worker",
  MODULES: "access,content,data-room,updates",
  OIDC_ISSUER_URL: "https://accounts.google.com",
  OIDC_ALLOWED_DOMAINS: "acme.com",
  PASSKEY_RP_ID: "investors.example.com",
  CORS_ALLOWED_ORIGINS: "https://www.example.com,https://app.example.com",
  WEB_DIST_PATH: "/app/apps/web/dist",
  DATA_DIR: "/data",
  SETUP_TOKEN: "$(openssl rand -hex 16)",
  CUSTOM_DOMAIN_CNAME_TARGET: "portal.example.com",
  CUSTOM_DOMAIN_EDGE_ADDRESSES: "203.0.113.10,2001:db8::10",
  DOH_ENDPOINTS: "https://1.1.1.1/dns-query,https://8.8.8.8/resolve",
  CLIENT_IP_HEADER: "Fly-Client-IP",
  FORWARDED_HOST_HEADER: "X-Fundroom-Forwarded-Host",
  FORWARDED_CLIENT_IP_HEADER: "X-Fundroom-Client-IP",
  EDGE_SHARED_SECRET: "$(openssl rand -hex 32)",
  EDGE_SHARED_SECRET_PREVIOUS: "<the EDGE_SHARED_SECRET being replaced>",
  PATH_MOUNTS: "https://acme.com/investors,https://www.acme.com/investors",
  METRICS_TOKEN: "$(openssl rand -hex 24)",
  CELL_ID: "eu-1",
  DATA_REGION: "eu",
  DATA_REGION_LABEL: "European Union (Frankfurt, Germany)",
  DATA_REGION_JURISDICTION: "eu",
  BACKUP_LOCATION: "European Union (Frankfurt, Germany)",
  DIRECTORY_DATABASE_URL: "postgres://seedhost:…@directory.internal:5432/directory",
  PLATFORM_OPERATOR_CIDRS: "203.0.113.0/24,2001:db8::/48",
  SIGNUP_DEFAULT_PLAN: "starter",
  TERMS_URL: "https://www.example.com/terms",
  PRIVACY_URL: "https://www.example.com/privacy",
  SUPPORT_URL: "mailto:support@example.com",
  STATUS_URL: "https://status.example.com",
  STRIPE_SECRET_KEY: "sk_live_…",
  STRIPE_WEBHOOK_SECRET: "whsec_…",
  SANCTIONS_OPENSANCTIONS_URL: "http://yente.internal:8000",
  SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS: "sanctions-proxy.internal",
  CLOUDFLARE_ZONE_ID: "023e105f4ecef8ad9ca31a8372d0c353",
  AI_BASE_URL: "http://ollama:11434",
  AI_MODEL: "qwen3.5:9b",
  AI_PROVIDER_LABEL: "Acme Inference",
  AI_PROVIDER_LOCATION: "European Union",
  AUDIT_ANCHOR_DRIVERS: "rfc3161,rekor",
  AUDIT_ANCHOR_TSA_URLS: "https://timestamp.sigstore.dev/api/v1/timestamp,https://freetsa.org/tsr",
  AUDIT_ANCHOR_TSA_CERTS: "(set AUDIT_ANCHOR_TSA_CERTS_FILE=/run/secrets/tsa-certs.pem)",
  AUDIT_ANCHOR_REKOR_URL: "https://log2025-1.rekor.sigstore.dev",
  AUDIT_ANCHOR_REKOR_LOG_KEY: "(set AUDIT_ANCHOR_REKOR_LOG_KEY_FILE=/run/secrets/rekor.pub)",
  AUDIT_ANCHOR_REKOR_ORIGIN: "log2025-1.rekor.sigstore.dev",
  AUTHZ_OPENFGA_URL: "http://openfga:8080",
};

/** The deployment-level OAuth client key pairs (E3.6); each pair is set together or not at all. */
export const INTEGRATION_CLIENT_PAIRS = [
  ["QuickBooks", "INTEGRATIONS_QUICKBOOKS_CLIENT_ID", "INTEGRATIONS_QUICKBOOKS_CLIENT_SECRET"],
  ["Xero", "INTEGRATIONS_XERO_CLIENT_ID", "INTEGRATIONS_XERO_CLIENT_SECRET"],
  ["Slack", "INTEGRATIONS_SLACK_CLIENT_ID", "INTEGRATIONS_SLACK_CLIENT_SECRET"],
] as const satisfies ReadonlyArray<readonly [string, keyof RawEnv, keyof RawEnv]>;

/** Effective METRICS_ENABLED: explicit value, else on unless staging/prod without a token. */
export function metricsEnabled(env: RawEnv): boolean {
  if (env.METRICS_ENABLED !== undefined) return env.METRICS_ENABLED;
  const isProdLike = env.APP_ENV === "prod" || env.APP_ENV === "staging";
  return !isProdLike || env.METRICS_TOKEN !== undefined;
}

/** `PATH_MOUNTS` split into origin and prefix (empty when unset). Entries are already validated. */
export function pathMountsOf(env: Pick<RawEnv, "PATH_MOUNTS">): readonly PathMountEntry[] {
  const out: PathMountEntry[] = [];
  for (const entry of env.PATH_MOUNTS ?? []) {
    const parsed = parsePathMount(entry);
    if (typeof parsed !== "string") out.push(parsed);
  }
  return out;
}

/**
 * Whether this install owns no host of its own (E3.9 FR2): it is served under a path — `BASE_PATH`
 * set, or a `BASE_URL` with a path. HSTS `includeSubDomains`/`preload` pin the whole host and its
 * subdomains, which is not ours to decide there. `PATH_MOUNTS` alone does not count: the portal's
 * own host is still its own, and responses served through a mount carry no HSTS at all
 * (`omitHsts` in @fundroom/http).
 */
export function ownsNoHost(env: Pick<RawEnv, "BASE_PATH" | "BASE_URL">): boolean {
  if (env.BASE_PATH !== "") return true;
  try {
    return new URL(env.BASE_URL).pathname.replace(/^\/+|\/+$/gu, "") !== "";
  } catch {
    return false;
  }
}

/** Effective HSTS_INCLUDE_SUBDOMAINS: explicit value, else on unless the install owns no host (or preload). */
export function hstsIncludeSubDomains(env: RawEnv): boolean {
  if (env.HSTS_INCLUDE_SUBDOMAINS !== undefined) return env.HSTS_INCLUDE_SUBDOMAINS;
  return env.HSTS_PRELOAD || !ownsNoHost(env);
}

/**
 * F-08: the SMTP transport in staging/prod. A relay outside the private network must be reached
 * over TLS that cannot be stripped (`smtps://`, or STARTTLS made mandatory with `requireTLS=true`),
 * and certificate verification is never switched off. The URL is read the way nodemailer reads it
 * (transport.ts, R2-01).
 */
function smtpTransportIssues(env: RawEnv, url: string): string[] {
  const out: string[] = [];
  const t = smtpTransportOf(url);
  if (t.ambiguous) {
    out.push(
      `must not contain backslashes, spaces or control characters in APP_ENV=${env.APP_ENV} (percent-encode them in the user name or password): URL parsers disagree on where the host ends.`,
    );
    return out;
  }
  if (t.repeated.length > 0) {
    out.push(
      `repeats ${t.repeated.join(", ")}; give each option once (the mail library reads a repeated option as a list, not as the last value).`,
    );
    return out;
  }
  // Anything but an explicit `true` (nodemailer reads `0`, `""` and `false` as "do not verify").
  for (const name of ["tls.rejectUnauthorized", "rejectUnauthorized", "tls.rejectunauthorized"]) {
    const v = t.option(name);
    if (v !== undefined && v !== true) {
      out.push(
        `must not disable certificate verification (${name}=${String(v)}) in APP_ENV=${env.APP_ENV}; install the relay's CA instead (NODE_EXTRA_CA_CERTS).`,
      );
      break;
    }
  }
  if (t.host !== undefined && isPrivateHost(t.host)) return out;
  const ignoreTls = t.option("ignoreTLS");
  if (ignoreTls !== undefined && ignoreTls !== false && ignoreTls !== 0) {
    out.push(
      `must not set ignoreTLS (${String(ignoreTls)}) for a relay outside the private network.`,
    );
  } else if (!t.secure && t.option("requireTLS") !== true) {
    out.push(
      `must use smtps:// (implicit TLS, port 465) or add ?requireTLS=true for a relay outside the private network in APP_ENV=${env.APP_ENV}: plain smtp:// only upgrades to TLS when the server offers it, and anyone on the path can remove the offer and read every sign-in code. Example: smtps://user:pass@smtp.example.com:465 or smtp://user:pass@smtp.example.com:587?requireTLS=true. Upgrading from before E2.10: docs/runbooks/install-and-upgrade.md.`,
    );
  }
  return out;
}

/**
 * F-09: a database transport in staging/prod, read the way pg reads the URL (R2-01). The cell
 * database (DATABASE_URL) and, since E3.11 (R2-1), the shared directory (DIRECTORY_DATABASE_URL),
 * each with its own opt-out key.
 */
function databaseTransportIssue(
  env: RawEnv,
  url: string = env.DATABASE_URL,
  acceptKey:
    | "DATABASE_ACCEPT_UNVERIFIED_TLS"
    | "DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS" = "DATABASE_ACCEPT_UNVERIFIED_TLS",
): string | undefined {
  if (env[acceptKey]) return undefined;
  const { host, sslmode } = pgTransportOf(url);
  if (host !== undefined && isPrivateHost(host)) return undefined;
  if (sslmode === "verify-full" || sslmode === "verify-ca") return undefined;
  return `${host === undefined ? "this host" : host} is not on a private network, so in APP_ENV=${env.APP_ENV} add sslmode=verify-full (with sslrootcert=<ca.pem> for a private CA) to the URL; it has ${sslmode === undefined ? "no sslmode" : `sslmode=${sslmode} (when sslmode appears more than once, the last one counts)`}. Set ${acceptKey}=true only if the host is private after all. Upgrading from before E2.10: docs/runbooks/install-and-upgrade.md.`;
}

export interface CrossFieldIssue {
  readonly key: string;
  readonly message: string;
  /** Overrides the key's generic `EXAMPLES` entry when that example would mislead here. */
  readonly example?: string;
}

/**
 * Rules that span fields. Kept as plain functions (not Zod refinements) so the
 * messages can be grouped with field errors and so they are trivially testable.
 */
export function crossFieldRules(
  env: RawEnv,
  /** Keys present in the environment (not defaulted). Omitted = assume every key was set. */
  explicit?: ReadonlySet<string>,
  /**
   * The variable(s) that actually carried `FUNDROOM_SECRET_KEY` (A-2: may be its old name or a
   * `_FILE` spelling), so a message names what the operator set. Defaults to the key itself.
   */
  secretKeyVariable = "FUNDROOM_SECRET_KEY",
): CrossFieldIssue[] {
  const issues: CrossFieldIssue[] = [];
  const isProdLike = env.APP_ENV === "prod" || env.APP_ENV === "staging";

  const hasSingle = env.FUNDROOM_SECRET_KEY !== undefined;
  const hasRing = env.SECRET_KEY_RING !== undefined;
  if (!hasSingle && !hasRing) {
    issues.push({
      key: "FUNDROOM_SECRET_KEY",
      message:
        "required (or SECRET_KEY_RING for rotation). Generate one with: openssl rand -base64 32",
    });
  } else if (hasSingle && hasRing) {
    issues.push({
      key: "SECRET_KEY_RING",
      message: `set together with ${secretKeyVariable}; keep only SECRET_KEY_RING (put the old key in it as v1).`,
    });
  }

  // RL-1: APP_ENV defaults to dev, so "not prod" is not evidence of a test stack. Loosened
  // limits need APP_ENV set on purpose to a non-production value.
  if (
    env.RATE_LIMIT_MULTIPLIER !== 1 &&
    (env.APP_ENV === "prod" || (explicit !== undefined && !explicit.has("APP_ENV")))
  ) {
    issues.push({
      key: "RATE_LIMIT_MULTIPLIER",
      message:
        env.APP_ENV === "prod"
          ? "must be 1 in APP_ENV=prod; it exists for load and DAST runs against non-production stacks."
          : "must be 1 unless APP_ENV is set explicitly to dev, test or staging (APP_ENV is unset and only defaults to dev); it exists for load and DAST runs against non-production stacks.",
    });
  }

  if (isProdLike && !env.BASE_URL.startsWith("https://")) {
    issues.push({ key: "BASE_URL", message: `must use https in APP_ENV=${env.APP_ENV}.` });
  }
  // The update check's answer drives a "security update available" banner; over http anyone on
  // the path could suppress it or point the release-notes link somewhere else.
  if (isProdLike && env.UPDATE_CHECK && !env.UPDATE_CHECK_URL.startsWith("https://")) {
    issues.push({
      key: "UPDATE_CHECK_URL",
      message: `must use https in APP_ENV=${env.APP_ENV} (or set UPDATE_CHECK=false).`,
    });
  }
  const mounts = pathMountsOf(env);
  const baseUrl = new URL(env.BASE_URL);
  const baseUrlPath = baseUrl.pathname.replace(/\/$/u, "");
  // E3.9: BASE_URL is the canonical public URL. Behind a proxy that strips or replaces the prefix
  // it may be a path mount's URL rather than one ending in BASE_PATH.
  if (
    env.BASE_PATH !== "" &&
    !baseUrlPath.endsWith(env.BASE_PATH) &&
    !mounts.some((m) => m.origin === baseUrl.origin && m.prefix === baseUrlPath)
  ) {
    issues.push({
      key: "BASE_PATH",
      message: `BASE_URL path should end with BASE_PATH (${env.BASE_PATH}), or BASE_URL should be one of the PATH_MOUNTS URLs.`,
    });
  }
  // E3.9: an app at the root with a BASE_URL path only makes sense behind a proxy that strips
  // that path — i.e. BASE_URL is a mount. Otherwise every email link points at a path the app
  // does not serve.
  const baseUrlIsMount = mounts.some(
    (m) => m.origin === baseUrl.origin && m.prefix === baseUrlPath,
  );
  if (env.BASE_PATH === "" && baseUrlPath !== "" && !baseUrlIsMount) {
    issues.push({
      key: "BASE_URL",
      message: `has the path ${baseUrlPath} but BASE_PATH is unset, so the app serves nothing there: set BASE_PATH=${baseUrlPath}, or list ${baseUrl.origin}${baseUrlPath} in PATH_MOUNTS when a proxy strips that prefix.`,
    });
  }
  if (mounts.length > 0) {
    // Host-page origins are never CORS-trusted: a credentialed cross-origin read from the host
    // site would hand its scripts every investor API response. Mounted requests are same-origin
    // with the mount anyway.
    const cors = new Set(env.CORS_ALLOWED_ORIGINS ?? []);
    const corsMounts = [...new Set(mounts.map((m) => m.origin))].filter((o) => cors.has(o));
    if (corsMounts.length > 0) {
      issues.push({
        key: "CORS_ALLOWED_ORIGINS",
        message: `must not list a PATH_MOUNTS origin (${corsMounts.join(", ")}): pages on the host site would get credentialed access to the API. A mounted request is same-origin with its mount and needs no CORS.`,
      });
    }
    if (env.TENANCY_MODE === "multi") {
      issues.push({
        key: "PATH_MOUNTS",
        message:
          "is not supported with TENANCY_MODE=multi: per-workspace mounts belong to the managed-host control plane. Unset PATH_MOUNTS or run TENANCY_MODE=single.",
      });
    }
    if (isProdLike) {
      const plain = mounts.filter((m) => !m.origin.startsWith("https://"));
      if (plain.length > 0) {
        issues.push({
          key: "PATH_MOUNTS",
          message: `must use https in APP_ENV=${env.APP_ENV} (${plain.map((m) => `${m.origin}${m.prefix}`).join(", ")}): the portal's cookies are Secure and a mount is a public origin.`,
        });
      }
    }
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const m of mounts) {
      const url = `${m.origin}${m.prefix}`;
      if (seen.has(url)) repeated.add(url);
      seen.add(url);
    }
    if (repeated.size > 0) {
      issues.push({
        key: "PATH_MOUNTS",
        message: `lists ${[...repeated].join(", ")} more than once; give each mount once.`,
      });
    }
  }

  if (env.AV_DRIVER === "clamd" && env.CLAMD_HOST === undefined) {
    issues.push({ key: "CLAMD_HOST", message: "required when AV_DRIVER=clamd." });
  }
  if (isProdLike && env.AV_DRIVER === "noop" && !env.AV_ACCEPT_UNSCANNED) {
    issues.push({
      key: "AV_DRIVER",
      message: `uploads are not virus-scanned with AV_DRIVER=noop. In APP_ENV=${env.APP_ENV} set AV_DRIVER=clamd (+ CLAMD_HOST), or AV_ACCEPT_UNSCANNED=true to run without a scanner on purpose. Upgrading from before E2.10: docs/runbooks/install-and-upgrade.md.`,
    });
  }

  // F-01: /metrics lists every route and is on by default; public without a token in prod.
  if (isProdLike && env.METRICS_ENABLED === true && env.METRICS_TOKEN === undefined) {
    issues.push({
      key: "METRICS_TOKEN",
      message: `required with METRICS_ENABLED=true in APP_ENV=${env.APP_ENV} (openssl rand -hex 24), or set METRICS_ENABLED=false.`,
    });
  }

  // F-07: a client-address header is only believable behind the proxy that writes it.
  if (env.CLIENT_IP_HEADER !== undefined && !env.TRUST_PROXY) {
    issues.push({
      key: "CLIENT_IP_HEADER",
      message:
        "only read with TRUST_PROXY=true; without a trusted proxy in front, any client can send it.",
    });
  }

  // E-UP-7: edge forwarding. The forwarded headers are believed only under the shared secret, so
  // one is never configured without the other.
  const edgeHost = env.FORWARDED_HOST_HEADER;
  const edgeIp = env.FORWARDED_CLIENT_IP_HEADER;
  const edgeSecret = env.EDGE_SHARED_SECRET;
  if (edgeHost !== undefined && edgeSecret === undefined) {
    issues.push({
      key: "EDGE_SHARED_SECRET",
      message:
        "required with FORWARDED_HOST_HEADER: the forwarded host is believed only from a request whose X-Fundroom-Edge header carries this secret. Generate one with openssl rand -hex 32 and give the edge the same value.",
    });
  }
  if (edgeSecret !== undefined && edgeHost === undefined) {
    issues.push({
      key: "FORWARDED_HOST_HEADER",
      message:
        "required with EDGE_SHARED_SECRET: name the header your edge puts the visitor's hostname in, or unset EDGE_SHARED_SECRET.",
    });
  }
  if (edgeIp !== undefined && edgeHost === undefined) {
    issues.push({
      key: "FORWARDED_CLIENT_IP_HEADER",
      message:
        "only read with edge forwarding on: set FORWARDED_HOST_HEADER and EDGE_SHARED_SECRET too, or unset it.",
    });
  }
  if (
    edgeIp !== undefined &&
    edgeHost !== undefined &&
    edgeIp.toLowerCase() === edgeHost.toLowerCase()
  ) {
    issues.push({
      key: "FORWARDED_CLIENT_IP_HEADER",
      message:
        "must differ from FORWARDED_HOST_HEADER (header names are case-insensitive): one carries the hostname, the other the visitor's address.",
    });
  }
  if (env.EDGE_SHARED_SECRET_PREVIOUS !== undefined) {
    if (edgeSecret === undefined) {
      issues.push({
        key: "EDGE_SHARED_SECRET_PREVIOUS",
        message:
          "only accepted during a rotation, next to EDGE_SHARED_SECRET (the new value); set that, or unset this.",
      });
    } else if (env.EDGE_SHARED_SECRET_PREVIOUS === edgeSecret) {
      issues.push({
        key: "EDGE_SHARED_SECRET_PREVIOUS",
        message:
          "must differ from EDGE_SHARED_SECRET: it holds the secret being replaced. Unset it once the edge sends the new one.",
      });
    }
  }
  // The path-mount host copy (X-Forwarded-Host picking among mounts) must never meet a forwarded
  // host from the edge: two sources of "the host" for one request.
  if (edgeHost !== undefined && mounts.length > 0) {
    issues.push({
      key: "FORWARDED_HOST_HEADER",
      message:
        "cannot be combined with PATH_MOUNTS: a request's host would come from two places. Edge forwarding is for custom domains on a managed host; unset one of them.",
    });
  }

  if (isProdLike) {
    const db = databaseTransportIssue(env);
    if (db !== undefined) issues.push({ key: "DATABASE_URL", message: db });
    if (env.DIRECTORY_DATABASE_URL !== undefined) {
      const dir = databaseTransportIssue(
        env,
        env.DIRECTORY_DATABASE_URL,
        "DIRECTORY_DATABASE_ACCEPT_UNVERIFIED_TLS",
      );
      if (dir !== undefined) issues.push({ key: "DIRECTORY_DATABASE_URL", message: dir });
    }
  }

  if (env.STORAGE_DRIVER === "s3") {
    for (const k of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
      if (env[k] === undefined)
        issues.push({ key: k, message: "required when STORAGE_DRIVER=s3." });
    }
    if (env.S3_REGION === undefined && env.S3_ENDPOINT === undefined) {
      issues.push({
        key: "S3_REGION",
        message: "set S3_REGION (AWS) or S3_ENDPOINT (R2/Garage/MinIO).",
      });
    }
  }

  if (isProdLike && env.MAIL_FROM === undefined) {
    issues.push({ key: "MAIL_FROM", message: `required in APP_ENV=${env.APP_ENV}.` });
  }
  if (env.MAILER_DRIVER !== "smtp" && env.MAIL_FROM === undefined) {
    // An ESP only sends from an address on a domain verified in its own dashboard; the
    // `no-reply@<host>` fallback the SMTP driver uses would be refused on every send.
    issues.push({
      key: "MAIL_FROM",
      message: `required when MAILER_DRIVER=${env.MAILER_DRIVER} (an address on a domain verified at the provider).`,
    });
  }
  switch (env.MAILER_DRIVER) {
    case "smtp":
      if (env.SMTP_URL === undefined && isProdLike) {
        issues.push({
          key: "SMTP_URL",
          message: "required when MAILER_DRIVER=smtp outside dev/test.",
        });
      }
      if (env.SMTP_URL !== undefined && isProdLike) {
        for (const message of smtpTransportIssues(env, env.SMTP_URL)) {
          issues.push({ key: "SMTP_URL", message });
        }
      }
      break;
    case "resend":
      if (env.RESEND_API_KEY === undefined) {
        issues.push({ key: "RESEND_API_KEY", message: "required when MAILER_DRIVER=resend." });
      }
      break;
    case "postmark":
      if (env.POSTMARK_SERVER_TOKEN === undefined) {
        issues.push({
          key: "POSTMARK_SERVER_TOKEN",
          message: "required when MAILER_DRIVER=postmark.",
        });
      }
      if (
        (env.POSTMARK_WEBHOOK_USER === undefined) !==
        (env.POSTMARK_WEBHOOK_PASSWORD === undefined)
      ) {
        issues.push({
          key:
            env.POSTMARK_WEBHOOK_USER === undefined
              ? "POSTMARK_WEBHOOK_USER"
              : "POSTMARK_WEBHOOK_PASSWORD",
          message: "set POSTMARK_WEBHOOK_USER and POSTMARK_WEBHOOK_PASSWORD together (or neither).",
        });
      }
      break;
    case "ses":
      for (const k of ["AWS_REGION", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const) {
        if (env[k] === undefined) {
          issues.push({ key: k, message: "required when MAILER_DRIVER=ses." });
        }
      }
      if (env.SES_SNS_TOPIC_ARNS !== undefined && env.SES_CONFIGURATION_SET === undefined) {
        issues.push({
          key: "SES_CONFIGURATION_SET",
          message:
            "required with SES_SNS_TOPIC_ARNS: SES publishes events only for mail sent through a configuration set.",
        });
      }
      break;
  }

  const oidcKeys = ["OIDC_ISSUER_URL", "OIDC_CLIENT_ID"] as const;
  const oidcSet = oidcKeys.filter((k) => env[k] !== undefined);
  if (oidcSet.length > 0 && oidcSet.length < oidcKeys.length) {
    for (const k of oidcKeys) {
      if (env[k] === undefined)
        issues.push({ key: k, message: "required when the other OIDC_* keys are set." });
    }
  }
  if ((env.OIDC_TRUST_MFA || env.OIDC_MFA_ACR !== undefined) && env.OIDC_ISSUER_URL === undefined) {
    issues.push({
      key: env.OIDC_TRUST_MFA ? "OIDC_TRUST_MFA" : "OIDC_MFA_ACR",
      message: "set without OIDC_ISSUER_URL; remove it or configure the provider.",
    });
  }
  if (env.OIDC_CLIENT_SECRET !== undefined && env.OIDC_ISSUER_URL === undefined) {
    issues.push({
      key: "OIDC_CLIENT_SECRET",
      message: "set without OIDC_ISSUER_URL; remove it or configure the provider.",
    });
  }
  if (env.PASSKEY_RP_ID !== undefined) {
    const host = new URL(env.BASE_URL).hostname;
    if (host !== env.PASSKEY_RP_ID && !host.endsWith(`.${env.PASSKEY_RP_ID}`)) {
      issues.push({
        key: "PASSKEY_RP_ID",
        message: `must be the BASE_URL host (${host}) or a registrable parent of it.`,
      });
    }
  }

  if (
    isProdLike &&
    env.OUTBOUND_HTTP_ALLOW_PRIVATE &&
    (env.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS === undefined ||
      env.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS.length === 0)
  ) {
    issues.push({
      key: "OUTBOUND_HTTP_ALLOW_PRIVATE",
      message: `in APP_ENV=${env.APP_ENV} list the hosts in OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS instead of opening every private range.`,
    });
  }
  if (isProdLike && env.WEBHOOK_ALLOW_PRIVATE_HOSTS !== undefined) {
    const loopback = env.WEBHOOK_ALLOW_PRIVATE_HOSTS.filter(isLoopbackOrUnspecifiedHost);
    if (loopback.length > 0) {
      issues.push({
        key: "WEBHOOK_ALLOW_PRIVATE_HOSTS",
        message: `in APP_ENV=${env.APP_ENV} a webhook target may not be loopback, unspecified or a wildcard (${loopback.join(", ")}): webhook URLs are tenant-chosen.`,
      });
    }
  }
  if (isProdLike && env.ESIGN_ALLOW_PRIVATE_HOSTS !== undefined) {
    const loopback = env.ESIGN_ALLOW_PRIVATE_HOSTS.filter(isLoopbackOrUnspecifiedHost);
    if (loopback.length > 0) {
      issues.push({
        key: "ESIGN_ALLOW_PRIVATE_HOSTS",
        message: `in APP_ENV=${env.APP_ENV} an e-sign vendor host may not be loopback, unspecified or a wildcard (${loopback.join(", ")}): vendor base URLs are tenant-chosen.`,
      });
    }
  }
  if (isProdLike && env.ACCREDITATION_ALLOW_PRIVATE_HOSTS !== undefined) {
    const loopback = env.ACCREDITATION_ALLOW_PRIVATE_HOSTS.filter(isLoopbackOrUnspecifiedHost);
    if (loopback.length > 0) {
      issues.push({
        key: "ACCREDITATION_ALLOW_PRIVATE_HOSTS",
        message: `in APP_ENV=${env.APP_ENV} an accreditation vendor host may not be loopback, unspecified or a wildcard (${loopback.join(", ")}).`,
      });
    }
  }
  if (isProdLike && env.SSO_ALLOW_PRIVATE_HOSTS !== undefined) {
    const loopback = env.SSO_ALLOW_PRIVATE_HOSTS.filter(isLoopbackOrUnspecifiedHost);
    if (loopback.length > 0) {
      issues.push({
        key: "SSO_ALLOW_PRIVATE_HOSTS",
        message: `in APP_ENV=${env.APP_ENV} an SSO identity-provider host may not be loopback, unspecified or a wildcard (${loopback.join(", ")}): issuer and metadata URLs are tenant-chosen.`,
      });
    }
  }
  if (isProdLike && env.INTEGRATIONS_ALLOW_PRIVATE_HOSTS !== undefined) {
    const loopback = env.INTEGRATIONS_ALLOW_PRIVATE_HOSTS.filter(isLoopbackOrUnspecifiedHost);
    if (loopback.length > 0) {
      issues.push({
        key: "INTEGRATIONS_ALLOW_PRIVATE_HOSTS",
        message: `in APP_ENV=${env.APP_ENV} an integrations host may not be loopback, unspecified or a wildcard (${loopback.join(", ")}).`,
      });
    }
  }
  for (const [provider, idKey, secretKey] of INTEGRATION_CLIENT_PAIRS) {
    if ((env[idKey] === undefined) !== (env[secretKey] === undefined)) {
      issues.push({
        key: env[idKey] === undefined ? idKey : secretKey,
        message: `set ${idKey} and ${secretKey} together (or neither): the ${provider} integration needs both.`,
      });
    }
  }
  // A positive DNS verdict needs two independent resolvers to agree (E2.1 decision 7), so one
  // poisoned or split-horizon resolver can only withhold a verification, never grant one. The
  // DoH adapter clamps its quorum to however many endpoints it was given rather than refusing at
  // runtime — a legitimate single-resolver dev install has to keep working — which means a
  // one-endpoint list silently drops the guarantee. Refuse it here, loudly, where it is a
  // configuration decision rather than a surprise three months later.
  //
  // Counted by **distinct host**, not by entry (E2.1 S4). `1.1.1.1/dns-query` twice is two
  // entries and one resolver: it passed the old length check and then satisfied a quorum of two
  // out of a single cache. The adapter dedupes by host for the same reason, so the two halves
  // cannot drift. What config validation cannot know is that two *different* hosts may still be
  // one operator (`1.1.1.1` and `1.0.0.1` are both Cloudflare); that residual is recorded in
  // ADR-0039 rather than pretended away here.
  if (isProdLike && env.DOH_ENDPOINTS !== undefined) {
    const hosts = new Set(
      env.DOH_ENDPOINTS.map((endpoint) => {
        try {
          return new URL(endpoint).host;
        } catch {
          return endpoint;
        }
      }),
    );
    if (hosts.size < 2) {
      issues.push({
        key: "DOH_ENDPOINTS",
        message: `in APP_ENV=${env.APP_ENV} name at least two *distinct* resolvers: a positive domain verification requires two of them to agree, and ${env.DOH_ENDPOINTS.length > 1 ? `these ${env.DOH_ENDPOINTS.length} endpoints are all ${[...hosts][0]}` : "a single endpoint"}, which downgrades that to one.`,
      });
    }
  }
  if (env.HSTS_PRELOAD && !env.HSTS) {
    issues.push({ key: "HSTS_PRELOAD", message: "set without HSTS=true; enable HSTS or drop it." });
  }
  if (env.HSTS_PRELOAD && env.HSTS_INCLUDE_SUBDOMAINS === false) {
    issues.push({
      key: "HSTS_INCLUDE_SUBDOMAINS",
      message: "preload lists require includeSubDomains; drop HSTS_PRELOAD or this.",
    });
  }
  if (env.HSTS_INCLUDE_SUBDOMAINS === true && ownsNoHost(env)) {
    issues.push({
      key: "HSTS_INCLUDE_SUBDOMAINS",
      message:
        "pins every subdomain of a host this path-mounted install does not own (BASE_PATH or a BASE_URL path is set); leave it unset.",
    });
  }
  if (env.HSTS_PRELOAD && ownsNoHost(env)) {
    issues.push({
      key: "HSTS_PRELOAD",
      message: "preload applies to the whole host; do not set it for a path-mounted install.",
    });
  }

  // --- managed-host control plane (E3.10) ---------------------------------------------------
  const controlPlane = env.CONTROL_PLANE === "on";
  if (controlPlane && env.TENANCY_MODE !== "multi") {
    issues.push({
      key: "CONTROL_PLANE",
      message:
        "requires TENANCY_MODE=multi: the control plane places, bills and suspends workspaces, and a single-tenant install has exactly one.",
    });
  }
  if (env.SIGNUP_MODE === "open" && !controlPlane) {
    issues.push({ key: "SIGNUP_MODE", message: "open requires CONTROL_PLANE=on." });
  }
  if (env.SIGNUP_MODE === "open" && env.SIGNUP_DEFAULT_PLAN === undefined) {
    issues.push({
      key: "SIGNUP_DEFAULT_PLAN",
      message: "required with SIGNUP_MODE=open: the plan a new workspace starts on.",
    });
  }
  if (env.BILLING_DRIVER !== "none" && !controlPlane) {
    issues.push({
      key: "BILLING_DRIVER",
      message: `${env.BILLING_DRIVER} requires CONTROL_PLANE=on.`,
    });
  }
  if (env.BILLING_DRIVER === "stripe") {
    for (const k of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const) {
      if (env[k] === undefined)
        issues.push({ key: k, message: "required when BILLING_DRIVER=stripe." });
    }
  }
  // --- per-tenant data residency (E3.11) ------------------------------------------------------
  // No rule here refuses an install that sets none of these keys.
  if (env.DATA_REGION === undefined) {
    for (const k of ["DATA_REGION_LABEL", "DATA_REGION_JURISDICTION"] as const) {
      if (env[k] !== undefined) issues.push({ key: k, message: "requires DATA_REGION." });
    }
  }
  if (env.DIRECTORY_DATABASE_URL !== undefined) {
    if (!controlPlane) {
      issues.push({
        key: "DIRECTORY_DATABASE_URL",
        message: "requires CONTROL_PLANE=on: the directory places workspaces across cells.",
      });
    }
    for (const k of ["DATA_REGION", "DATA_REGION_JURISDICTION"] as const) {
      if (env[k] === undefined) {
        issues.push({
          key: k,
          message:
            "required with DIRECTORY_DATABASE_URL: every cell in a directory declares its region.",
        });
      }
    }
    if ((env.APP_ENV === "prod" || env.APP_ENV === "staging") && env.STORAGE_DRIVER !== "s3") {
      issues.push({
        key: "STORAGE_DRIVER",
        message: `must be s3 with DIRECTORY_DATABASE_URL in APP_ENV=${env.APP_ENV}: moves hand bundles between cells over presigned URLs.`,
      });
    }
  }
  if (env.SANCTIONS_DRIVER !== "none" && !controlPlane) {
    issues.push({
      key: "SANCTIONS_DRIVER",
      message: `${env.SANCTIONS_DRIVER} requires CONTROL_PLANE=on.`,
    });
  }
  if (env.SANCTIONS_DRIVER === "opensanctions" && env.SANCTIONS_OPENSANCTIONS_URL === undefined) {
    issues.push({
      key: "SANCTIONS_OPENSANCTIONS_URL",
      message: "required when SANCTIONS_DRIVER=opensanctions (a yente server or the hosted API).",
    });
  }
  if (
    env.SANCTIONS_OPENSANCTIONS_API_KEY !== undefined &&
    env.SANCTIONS_OPENSANCTIONS_URL !== undefined &&
    !opensanctionsKeyHostAllowed(
      env.SANCTIONS_OPENSANCTIONS_URL,
      env.SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS,
    )
  ) {
    issues.push({
      key: "SANCTIONS_OPENSANCTIONS_API_KEY",
      message: `is only sent to ${OPENSANCTIONS_HOSTED_API_HOST} or a host in SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS; ${new URL(env.SANCTIONS_OPENSANCTIONS_URL).hostname} is neither (a yente server needs no key).`,
    });
  }
  // A key (or the hosted API, which always has one) never travels in the clear (RR2-5).
  if (
    env.SANCTIONS_OPENSANCTIONS_URL !== undefined &&
    new URL(env.SANCTIONS_OPENSANCTIONS_URL).protocol !== "https:" &&
    (env.SANCTIONS_OPENSANCTIONS_API_KEY !== undefined ||
      new URL(env.SANCTIONS_OPENSANCTIONS_URL).hostname.toLowerCase() ===
        OPENSANCTIONS_HOSTED_API_HOST)
  ) {
    issues.push({
      key: "SANCTIONS_OPENSANCTIONS_URL",
      message:
        "must be https when an API key is sent or the host is the hosted OpenSanctions API (a plain-http yente without a key is fine).",
    });
  }
  // The OFAC lists decide who is held: fetched in the clear, anybody on the path could rewrite them.
  if (
    (env.APP_ENV === "prod" || env.APP_ENV === "staging") &&
    new URL(env.SANCTIONS_OFAC_URL).protocol !== "https:"
  ) {
    issues.push({
      key: "SANCTIONS_OFAC_URL",
      message: `must be https in APP_ENV=${env.APP_ENV}.`,
    });
  }
  issues.push(...aiRules(env));
  issues.push(...auditAnchorRules(env));
  issues.push(...authzEngineRules(env));
  if (env.CUSTOM_DOMAIN_DRIVER === "cloudflare-saas") {
    for (const k of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ZONE_ID"] as const) {
      if (env[k] === undefined)
        issues.push({ key: k, message: "required when CUSTOM_DOMAIN_DRIVER=cloudflare-saas." });
    }
  }
  // The vendor API bases exist so tests can point the adapters at a local fake. In production a
  // different base would send an API key or a webhook-trusted answer to somebody else's server.
  if (env.APP_ENV === "prod") {
    for (const [k, fallback] of [
      ["STRIPE_API_BASE", DEFAULT_STRIPE_API_BASE],
      ["CLOUDFLARE_API_BASE", DEFAULT_CLOUDFLARE_API_BASE],
    ] as const) {
      if (env[k] !== fallback) {
        issues.push({
          key: k,
          message: `is a test seam and must stay ${fallback} in APP_ENV=prod.`,
        });
      }
    }
  }

  if (env.WORKER_MODE === "external" && env.ROLES.length === 1 && env.ROLES[0] === "worker") {
    issues.push({
      key: "WORKER_MODE",
      message:
        "external means another process runs the worker; this process has ROLES=worker only.",
    });
  }

  return issues;
}

/**
 * Who runs the AI model (E3.12): `null` when AI_PROVIDER=none. anthropic is always third-party;
 * openai-compatible takes AI_HOSTING when set, else `self_hosted` iff AI_BASE_URL's host is
 * evidently operator-run (the rule `@fundroom/ports` `isOperatorRunEndpoint` applies, mirrored
 * here because config depends on nothing but zod).
 */
export function effectiveAiHosting(
  env: Pick<RawEnv, "AI_PROVIDER" | "AI_BASE_URL" | "AI_HOSTING">,
): (typeof AI_HOSTINGS)[number] | null {
  if (env.AI_PROVIDER === "none") return null;
  if (env.AI_PROVIDER === "anthropic") return "third_party";
  if (env.AI_HOSTING !== undefined) return env.AI_HOSTING;
  if (env.AI_BASE_URL === undefined || !URL.canParse(env.AI_BASE_URL)) return "third_party";
  return isOperatorRunHost(new URL(env.AI_BASE_URL).hostname) ? "self_hosted" : "third_party";
}

/**
 * Tokens `ai.start` reserves for one request against the workspace's monthly budget (E3.12 fix
 * RR1-M3, RR3-L6): `2 × AI_MAX_INPUT_CHARS + 3 × AI_MAX_OUTPUT_TOKENS` — two model calls (the
 * first and the one corrective retry, whose prompt also carries the first answer), each prompt
 * counted at a worst case of one token per character. The single source for the kernel and for
 * the config rule that the operator budget covers at least one request. Defaults:
 * 2 × 60000 + 3 × 4000 = 132000; maximum limits: 896000.
 */
export function aiRequestReservation(
  env: Pick<RawEnv, "AI_MAX_OUTPUT_TOKENS" | "AI_MAX_INPUT_CHARS">,
): number {
  return 2 * env.AI_MAX_INPUT_CHARS + 3 * env.AI_MAX_OUTPUT_TOKENS;
}

/** The AI_BASE_URL in effect: the anthropic default when unset. */
export function effectiveAiBaseUrl(
  env: Pick<RawEnv, "AI_PROVIDER" | "AI_BASE_URL">,
): string | undefined {
  if (env.AI_PROVIDER === "anthropic") return env.AI_BASE_URL ?? DEFAULT_ANTHROPIC_API_BASE;
  return env.AI_BASE_URL;
}

/**
 * AI_HOSTING=self_hosted declared for an AI_BASE_URL whose host is NOT evidently operator-run
 * (E3.12 fix R3-M3): legal (a public name the operator really runs), but every tenant-facing
 * claim then rests on the operator's word — doctor says so.
 */
export function aiSelfHostedOverridesPublicHost(
  env: Pick<RawEnv, "AI_PROVIDER" | "AI_BASE_URL" | "AI_HOSTING">,
): boolean {
  if (env.AI_PROVIDER !== "openai-compatible" || env.AI_HOSTING !== "self_hosted") return false;
  if (env.AI_BASE_URL === undefined || !URL.canParse(env.AI_BASE_URL)) return false;
  return !isOperatorRunHost(new URL(env.AI_BASE_URL).hostname);
}

/** Mirror of `@fundroom/ports` `isOperatorRunEndpoint` (keep the two identical). */
function isOperatorRunHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/gu, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(h);
  if (m !== null) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }
  if (h.includes(":"))
    return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
  if (!h.includes(".")) return true; // a compose/k8s service name
  return /\.(local|internal|lan|home\.arpa|svc|cluster\.local)$/u.test(h);
}

/** Cross-field rules for AI assist (E3.12). */
function aiRules(env: RawEnv): CrossFieldIssue[] {
  const issues: CrossFieldIssue[] = [];
  const isProdLike = env.APP_ENV === "prod" || env.APP_ENV === "staging";
  const provider = env.AI_PROVIDER;
  const openai = provider === "openai-compatible";
  if (!openai) {
    if (env.AI_HOSTING !== undefined)
      issues.push({
        key: "AI_HOSTING",
        message: "only applies with AI_PROVIDER=openai-compatible.",
      });
    if (env.AI_JSON_MODE !== "json_schema")
      issues.push({
        key: "AI_JSON_MODE",
        message: "only applies with AI_PROVIDER=openai-compatible.",
      });
    if (env.AI_TOKEN_PARAM !== "max_tokens")
      issues.push({
        key: "AI_TOKEN_PARAM",
        message: "only applies with AI_PROVIDER=openai-compatible.",
      });
  }
  if (provider === "none") return issues;
  // RR1-M3: a budget below one request's reservation could never start a request.
  const reservation = aiRequestReservation(env);
  if (env.AI_MONTHLY_TOKEN_BUDGET < reservation)
    issues.push({
      key: "AI_MONTHLY_TOKEN_BUDGET",
      message: `must be at least ${reservation}: one request reserves 2 × AI_MAX_INPUT_CHARS + 3 × AI_MAX_OUTPUT_TOKENS tokens. Raise it or lower those limits.`,
      example: String(Math.max(2_000_000, reservation)),
    });
  if (env.AI_MODEL === undefined)
    issues.push({ key: "AI_MODEL", message: `required when AI_PROVIDER=${provider}.` });
  if (openai && env.AI_BASE_URL === undefined)
    issues.push({
      key: "AI_BASE_URL",
      message: "required when AI_PROVIDER=openai-compatible (e.g. http://ollama:11434).",
    });
  if (provider === "anthropic") {
    if (env.AI_API_KEY === undefined)
      issues.push({ key: "AI_API_KEY", message: "required when AI_PROVIDER=anthropic." });
    if (
      env.APP_ENV === "prod" &&
      env.AI_BASE_URL !== undefined &&
      env.AI_BASE_URL.replace(/\/+$/u, "") !== DEFAULT_ANTHROPIC_API_BASE
    )
      issues.push({
        key: "AI_BASE_URL",
        message: `is a test seam for AI_PROVIDER=anthropic and must stay ${DEFAULT_ANTHROPIC_API_BASE} (or be unset) in APP_ENV=prod.`,
        example: DEFAULT_ANTHROPIC_API_BASE,
      });
  }
  const base = effectiveAiBaseUrl(env);
  const hosting = effectiveAiHosting(env);
  if (base !== undefined && URL.canParse(base)) {
    const url = new URL(base);
    const plain = url.protocol !== "https:";
    const httpsExample =
      provider === "anthropic"
        ? DEFAULT_ANTHROPIC_API_BASE
        : "https://api.inference.example.com/v1";
    if (isProdLike && plain && hosting === "third_party")
      issues.push({
        key: "AI_BASE_URL",
        message: `must be https in APP_ENV=${env.APP_ENV} for a third-party model provider: prompts carry workspace content.`,
        example: httpsExample,
      });
    // E3.12 fix R3-M3/R1-L3: AI_HOSTING=self_hosted is a declaration, not evidence. Plain http is
    // allowed only to a host that is evidently operator-run (private address, service name,
    // `.internal`…), whatever the declared hosting — prompts carry workspace documents, and a
    // public host reached in the clear exposes them (and any key) to everyone on the path. This
    // also covers the key: after this rule, plain http means an operator-run self-hosted server.
    else if (isProdLike && plain && !isOperatorRunHost(url.hostname))
      issues.push({
        key: "AI_BASE_URL",
        message: `must be https in APP_ENV=${env.APP_ENV}: ${url.hostname} is not an operator-run host (a private address or internal service name), whatever AI_HOSTING says.`,
        example: httpsExample,
      });
  }
  if (openai && hosting === "third_party") {
    if (env.AI_PROVIDER_LABEL === undefined)
      issues.push({
        key: "AI_PROVIDER_LABEL",
        message:
          "required for a third-party openai-compatible provider: it is named as a sub-processor.",
      });
    if (env.AI_PROVIDER_JURISDICTION === undefined)
      issues.push({
        key: "AI_PROVIDER_JURISDICTION",
        message:
          "required for a third-party openai-compatible provider (eu|uk|ch|us|ca|au|other|varies).",
      });
  }
  return issues;
}

/**
 * The PEM blocks of one label in `text` (E3.13): `pemBlocks(bundle, "CERTIFICATE")`. Only the
 * armour is checked here; the adapters parse the DER.
 */
export function pemBlocks(text: string, label: string): string[] {
  // Labels are fixed by the callers; the check keeps one from ever being read as a pattern.
  if (!/^[A-Z0-9 ]+$/u.test(label)) throw new Error(`invalid PEM label: ${label}`);
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const re = new RegExp(
    `-----BEGIN ${label}-----\\s+([A-Za-z0-9+/=\\s]+?)-----END ${label}-----`,
    "gu",
  );
  return [...text.matchAll(re)].map((m) => m[0]);
}

const REKOR_LOG_KEY_TYPES: readonly string[] = ["ed25519", "ec", "rsa"];

/**
 * Every PEM block of `label` must parse (E3.13 FIX2 A14): a junk block next to a good one would
 * otherwise be silently ignored, and as the only Rekor key it would throw at startup.
 */
function unparseablePem(text: string, label: "CERTIFICATE" | "PUBLIC KEY", ctx: z.RefinementCtx) {
  for (const [i, block] of pemBlocks(text, label).entries()) {
    let type: string | undefined;
    try {
      if (label === "CERTIFICATE") new X509Certificate(block);
      else type = createPublicKey(block).asymmetricKeyType;
    } catch {
      ctx.addIssue({
        code: "custom",
        message: `PEM ${label} block ${i + 1} does not parse`,
      });
      continue;
    }
    // A Rekor log signs its checkpoints with Ed25519, ECDSA or RSA (E3.13 FIX3 L-A): any other
    // type (X25519, DH, …) would make the server throw at startup instead of naming the key.
    if (label === "PUBLIC KEY" && !REKOR_LOG_KEY_TYPES.includes(type ?? "")) {
      ctx.addIssue({
        code: "custom",
        message: `PEM PUBLIC KEY block ${i + 1} is a ${type ?? "unknown"} key; a Rekor log key must be Ed25519, ECDSA or RSA`,
      });
    }
  }
}

/** prod/staging: https, unless the host is evidently operator-run (E3.13 endpoints). */
function plainHttpRefused(env: RawEnv, value: string): boolean {
  if (env.APP_ENV !== "prod" && env.APP_ENV !== "staging") return false;
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol !== "https:" && !isOperatorRunHost(url.hostname);
}

/** Cross-field rules for external audit anchoring (E3.13). */
function auditAnchorRules(env: RawEnv): CrossFieldIssue[] {
  const issues: CrossFieldIssue[] = [];
  const drivers = env.AUDIT_ANCHOR_DRIVERS;
  if (new Set(drivers).size !== drivers.length)
    issues.push({ key: "AUDIT_ANCHOR_DRIVERS", message: "lists a driver more than once." });
  const rfc3161 = drivers.includes("rfc3161");
  const rekor = drivers.includes("rekor");
  const only = (key: keyof RawEnv, driver: string) =>
    issues.push({
      key,
      message: `only applies when AUDIT_ANCHOR_DRIVERS includes ${driver}.`,
    });
  if (rfc3161) {
    if (env.AUDIT_ANCHOR_TSA_URLS === undefined || env.AUDIT_ANCHOR_TSA_URLS.length === 0)
      issues.push({
        key: "AUDIT_ANCHOR_TSA_URLS",
        message: "required when AUDIT_ANCHOR_DRIVERS includes rfc3161 (one or more TSA URLs).",
      });
    if (env.AUDIT_ANCHOR_TSA_CERTS === undefined)
      issues.push({
        key: "AUDIT_ANCHOR_TSA_CERTS",
        message:
          "required when AUDIT_ANCHOR_DRIVERS includes rfc3161: the PEM certificates a timestamp must chain to (AUDIT_ANCHOR_TSA_CERTS_FILE=/path/to/tsa-certs.pem).",
      });
    for (const u of env.AUDIT_ANCHOR_TSA_URLS ?? [])
      if (plainHttpRefused(env, u))
        issues.push({
          key: "AUDIT_ANCHOR_TSA_URLS",
          message: `must be https in APP_ENV=${env.APP_ENV} (${new URL(u).hostname} is not an operator-run host).`,
        });
  } else {
    // The certificates may stay without the driver: they keep verifying stored receipts.
    if (env.AUDIT_ANCHOR_TSA_URLS !== undefined) only("AUDIT_ANCHOR_TSA_URLS", "rfc3161");
  }
  for (const u of env.AUDIT_ANCHOR_TSA_URLS ?? []) {
    const problem = anchorUrlProblem(u);
    if (problem) issues.push({ key: "AUDIT_ANCHOR_TSA_URLS", message: problem });
  }
  if (env.AUDIT_ANCHOR_REKOR_URL !== undefined) {
    const problem = anchorUrlProblem(env.AUDIT_ANCHOR_REKOR_URL);
    if (problem) issues.push({ key: "AUDIT_ANCHOR_REKOR_URL", message: problem });
  }
  if (rekor) {
    if (env.AUDIT_ANCHOR_REKOR_URL === undefined)
      issues.push({
        key: "AUDIT_ANCHOR_REKOR_URL",
        message:
          "required when AUDIT_ANCHOR_DRIVERS includes rekor (the current log shard, e.g. https://log2025-1.rekor.sigstore.dev).",
      });
    else if (plainHttpRefused(env, env.AUDIT_ANCHOR_REKOR_URL))
      issues.push({
        key: "AUDIT_ANCHOR_REKOR_URL",
        message: `must be https in APP_ENV=${env.APP_ENV} (${new URL(env.AUDIT_ANCHOR_REKOR_URL).hostname} is not an operator-run host).`,
      });
    if (env.AUDIT_ANCHOR_REKOR_LOG_KEY === undefined)
      issues.push({
        key: "AUDIT_ANCHOR_REKOR_LOG_KEY",
        message:
          "required when AUDIT_ANCHOR_DRIVERS includes rekor: the log's PEM public key (AUDIT_ANCHOR_REKOR_LOG_KEY_FILE=/path/to/rekor.pub).",
      });
  }
  // The origin cannot be derived from a URL for old shards' keys or verification-only pins: with
  // more than one log key, or keys without the driver, it must be spelled out (FIX3 L-B).
  if (env.AUDIT_ANCHOR_REKOR_LOG_KEY !== undefined && env.AUDIT_ANCHOR_REKOR_ORIGIN === undefined) {
    const keys = pemBlocks(env.AUDIT_ANCHOR_REKOR_LOG_KEY, "PUBLIC KEY").length;
    if (keys > 1)
      issues.push({
        key: "AUDIT_ANCHOR_REKOR_ORIGIN",
        message: `required when AUDIT_ANCHOR_REKOR_LOG_KEY pins ${keys} log keys: list every pinned shard's checkpoint origin (first = current).`,
      });
    else if (!rekor)
      issues.push({
        key: "AUDIT_ANCHOR_REKOR_ORIGIN",
        message:
          "required when AUDIT_ANCHOR_REKOR_LOG_KEY is set without the rekor driver (verification-only pins have no URL to derive the origin from).",
      });
  }
  if (!rekor) {
    // The log keys may stay without the driver: they keep verifying stored receipts.
    if (env.AUDIT_ANCHOR_REKOR_URL !== undefined) only("AUDIT_ANCHOR_REKOR_URL", "rekor");
    if (env.AUDIT_ANCHOR_REKOR_ORIGIN !== undefined && env.AUDIT_ANCHOR_REKOR_LOG_KEY === undefined)
      issues.push({
        key: "AUDIT_ANCHOR_REKOR_ORIGIN",
        message:
          "only applies with the rekor driver or with AUDIT_ANCHOR_REKOR_LOG_KEY (verification-only pins).",
      });
  }
  return issues;
}

/**
 * An anchor endpoint ends up in every receipt's `reference` (and so in tenant-downloadable
 * proofs): no credentials, query or fragment may ride along. Keep secrets out of the path too.
 */
function anchorUrlProblem(value: string): string | null {
  if (!URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.username !== "" || url.password !== "")
    return `must not carry credentials (${url.hostname}): anchor URLs are published in every receipt.`;
  if (url.search !== "" || value.includes("?"))
    return `must not carry a query string (${url.hostname}): anchor URLs are published in every receipt.`;
  if (url.hash !== "" || value.includes("#")) return `must not carry a fragment (${url.hostname}).`;
  return null;
}

/** Cross-field rules for the authz engine (E3.13). */
function authzEngineRules(env: RawEnv): CrossFieldIssue[] {
  const issues: CrossFieldIssue[] = [];
  if (env.AUTHZ_ENGINE !== "openfga") {
    for (const key of ["AUTHZ_OPENFGA_URL", "AUTHZ_OPENFGA_API_TOKEN"] as const)
      if (env[key] !== undefined)
        issues.push({ key, message: "only applies with AUTHZ_ENGINE=openfga." });
    if (env.AUTHZ_OPENFGA_MODE !== "shadow")
      issues.push({
        key: "AUTHZ_OPENFGA_MODE",
        message: "only applies with AUTHZ_ENGINE=openfga.",
      });
    return issues;
  }
  if (env.AUTHZ_OPENFGA_URL === undefined) {
    issues.push({
      key: "AUTHZ_OPENFGA_URL",
      message: "required when AUTHZ_ENGINE=openfga (e.g. http://openfga:8080).",
    });
    return issues;
  }
  // E3.13 R3-5: credentials in the URL never work (fetch refuses them) and would be logged; the
  // token has its own key.
  const parsed = new URL(env.AUTHZ_OPENFGA_URL);
  if (parsed.username !== "" || parsed.password !== "")
    issues.push({
      key: "AUTHZ_OPENFGA_URL",
      message: "must not carry credentials (user:password@); set AUTHZ_OPENFGA_API_TOKEN instead.",
      example: "https://openfga.example.com",
    });
  // E3.13 R3-5: the engine holds every workspace's access projection and, in enforce mode, can deny
  // every external user: prod-like installs must authenticate to it (OPENFGA_AUTHN_METHOD=preshared).
  if (
    (env.APP_ENV === "prod" || env.APP_ENV === "staging") &&
    env.AUTHZ_OPENFGA_API_TOKEN === undefined
  )
    issues.push({
      key: "AUTHZ_OPENFGA_API_TOKEN",
      message: `required in APP_ENV=${env.APP_ENV} with AUTHZ_ENGINE=openfga: run OpenFGA with OPENFGA_AUTHN_METHOD=preshared and set the same key here (the engine receives every workspace's access rules).`,
    });
  if (plainHttpRefused(env, env.AUTHZ_OPENFGA_URL))
    issues.push({
      key: "AUTHZ_OPENFGA_URL",
      message: `must be https in APP_ENV=${env.APP_ENV}: ${new URL(env.AUTHZ_OPENFGA_URL).hostname} is not an operator-run host (a private address or internal service name), and the engine receives every workspace's access rules.`,
      example: "https://openfga.example.com",
    });
  return issues;
}

/** The hosted OpenSanctions API: the one host its API key goes to without further config. */
export const OPENSANCTIONS_HOSTED_API_HOST = "api.opensanctions.org";

/** May the OpenSanctions API key be sent to `url`'s host? (The adapter applies the same rule.) */
export function opensanctionsKeyHostAllowed(
  url: string,
  extraHosts: readonly string[] | undefined,
): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return (
    host === OPENSANCTIONS_HOSTED_API_HOST ||
    (extraHosts ?? []).some((h) => h.trim().toLowerCase() === host)
  );
}

/** Loopback and unspecified ranges, v4 and v6, including v4-mapped v6 (fix R6). */
const LOOPBACK_OR_UNSPECIFIED = (() => {
  const list = new BlockList();
  list.addSubnet("127.0.0.0", 8, "ipv4");
  list.addSubnet("0.0.0.0", 8, "ipv4");
  list.addAddress("::1", "ipv6");
  list.addAddress("::", "ipv6");
  list.addSubnet("::ffff:127.0.0.0", 104, "ipv6");
  list.addSubnet("::ffff:0.0.0.0", 104, "ipv6");
  return list;
})();

/**
 * Whether a `WEBHOOK_ALLOW_PRIVATE_HOSTS` entry names loopback, an unspecified address or a
 * wildcard, AFTER the normalisation the SSRF guard applies before comparing hosts (lower case,
 * brackets and a trailing dot removed) — so `localhost.`, `127.0.0.1.`, `[::ffff:7f00:1]` and
 * `foo.localhost` are caught as the guard would see them.
 */
export function isLoopbackOrUnspecifiedHost(entry: string): boolean {
  let h = entry.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  if (h === "" || h.includes("*")) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIPv4(h)) return LOOPBACK_OR_UNSPECIFIED.check(h, "ipv4");
  if (isIPv6(h)) return LOOPBACK_OR_UNSPECIFIED.check(h, "ipv6");
  return false;
}
