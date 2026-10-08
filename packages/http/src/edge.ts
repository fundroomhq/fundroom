import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import type { Context, MiddlewareHandler } from "hono";

/*
 * Edge forwarding (E-UP-7, ADR-0064). A hosted install puts an edge Worker in front of a platform
 * (Railway) that routes by `Host` and overwrites `X-Forwarded-Host`, so the Worker carries the
 * customer's hostname and the visitor's address in PRIVATE headers (config
 * `FORWARDED_HOST_HEADER`, `FORWARDED_CLIENT_IP_HEADER`) and proves itself with a shared secret in
 * `X-Fundroom-Edge` (config `EDGE_SHARED_SECRET`, plus `EDGE_SHARED_SECRET_PREVIOUS` during a
 * rotation).
 *
 * The middleware runs first (after the request id). Per request:
 *   - no secret header: an ordinary request; the private headers are never read;
 *   - a secret header that matches neither secret: 403 `edge_unauthorized`, logged without the value;
 *   - a matching secret: the forwarded host must be present and valid (else 400 `invalid_request`);
 *     the request is then EDGE-FORWARDED: `edgeForwardedOf(c)` answers the customer host and (when
 *     configured and an IP literal) the visitor address. `requestHost`/`requestOrigin`/
 *     `isSecureRequest` (`./request.ts`) and the server's `clientIp` read it before anything else,
 *     so every caller sees the customer host, `https` and the visitor IP with no change of its own.
 *     The response gets `Vary: <FORWARDED_HOST_HEADER>` (the platform sees one Host for every tenant).
 *
 * The state lives on the Hono context (`edgeForwarded`), never on the Request: `hono/body-limit`
 * can replace `c.req.raw`, and only this middleware ever sets the variable. The secret never
 * leaves this module: it is hashed once at startup, the presented value is only hashed, and once
 * accepted the header is removed from the request (`stripEdgeSecret`) before anything else runs.
 */

/** The header the edge Worker carries the shared secret in. Fixed by the wire contract. */
export const EDGE_SECRET_HEADER = "x-fundroom-edge";

/** What an edge-forwarded request is, as far as the app is concerned. */
export interface EdgeForwarded {
  /** The customer's hostname: lower-case LDH, no port, no trailing dot. */
  readonly host: string;
  /** The visitor's address (an IP literal), when the edge sent a valid one. */
  readonly clientIp?: string | undefined;
}

export interface EdgeVariables {
  /** Set only by `edgeForwarding()` on a request whose secret matched. */
  edgeForwarded?: EdgeForwarded;
}

export type EdgeEnv = { Variables: EdgeVariables & { requestId?: string } };

/** The edge-forwarded facts of this request, or undefined (not configured, or no valid secret). */
export function edgeForwardedOf(c: Context): EdgeForwarded | undefined {
  return (c as Context<EdgeEnv>).get("edgeForwarded");
}

const MAX_HOST = 253;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

/**
 * The forwarded hostname, lower-cased, or undefined when it is not exactly one DNS name: LDH
 * labels of 1–63 chars (no leading/trailing hyphen), at most 253 chars, no port, no trailing dot,
 * no comma, no whitespace, not an IP literal (an all-numeric last label is refused).
 */
export function parseForwardedHost(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value.length === 0 || value.length > MAX_HOST) return undefined;
  const host = value.toLowerCase();
  const labels = host.split(".");
  for (const label of labels) if (!LABEL_RE.test(label)) return undefined;
  if (/^\d+$/u.test(labels.at(-1) ?? "")) return undefined;
  return host;
}

/** The forwarded client address when it is an IP literal (no port, no brackets), else undefined. */
export function parseForwardedClientIp(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return isIP(value) !== 0 ? value : undefined;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * A constant-time check of a presented secret against the current one and, during a rotation, the
 * previous one. Both sides are hashed first, so neither the value nor its length leaks through
 * timing, and both comparisons always run.
 */
export function createEdgeSecretCheck(
  current: string,
  previous?: string | undefined,
): (presented: string) => boolean {
  const wanted = [digest(current), ...(previous === undefined ? [] : [digest(previous)])];
  return (presented) => {
    const given = digest(presented);
    let ok = false;
    for (const w of wanted) ok = timingSafeEqual(given, w) || ok;
    return ok;
  };
}

/** `existing` with `token` appended unless already listed (case-insensitive) or `*`. */
function withVary(existing: string | null, token: string): string {
  const tokens = (existing ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
  if (tokens.includes("*")) return "*";
  if (tokens.some((t) => t.toLowerCase() === token.toLowerCase())) return tokens.join(", ");
  return [...tokens, token].join(", ");
}

/**
 * Removes the secret header from the request every later middleware, handler and adapter sees
 * (`c.req.header()`, `c.req.raw.headers`, a webhook adapter handed `c.req.raw`), so nothing
 * downstream can log or forward it. @hono/node-server's Request and a fetch `Request` (guard
 * "request") both have mutable headers, so the delete is in place and the body stream is never
 * touched; should a runtime hand us immutable headers, the Request is replaced by a copy without
 * the header, the way `hono/body-limit` replaces it (the body stream moves to the copy). The
 * socket (`getConnInfo` reads `c.env.incoming`) is unaffected either way. Throws if the header
 * survives both, so the request fails closed rather than carrying the secret on.
 */
export function stripEdgeSecret(c: Context): void {
  try {
    c.req.raw.headers.delete(EDGE_SECRET_HEADER);
  } catch {
    // immutable headers: replaced below
  }
  if (!c.req.raw.headers.has(EDGE_SECRET_HEADER)) return;
  const headers = new Headers(c.req.raw.headers);
  headers.delete(EDGE_SECRET_HEADER);
  c.req.raw = new Request(c.req.raw, { headers, duplex: "half" } as RequestInit);
  if (c.req.raw.headers.has(EDGE_SECRET_HEADER)) {
    throw new Error("the edge secret header could not be removed from the request");
  }
}

export interface EdgeForwardingOptions {
  /** `FORWARDED_HOST_HEADER`: the private header carrying the customer hostname. */
  readonly hostHeader: string;
  /** `FORWARDED_CLIENT_IP_HEADER`: the private header carrying the visitor's IP. */
  readonly clientIpHeader?: string | undefined;
  /** `EDGE_SHARED_SECRET`. */
  readonly secret: string;
  /** `EDGE_SHARED_SECRET_PREVIOUS`, during a rotation only. */
  readonly previousSecret?: string | undefined;
  /** Where refusals are logged. Fields never include a header value. */
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
  /**
   * Extra fields for a refusal's log line, so a forging attempt can be attributed: the server
   * passes the redacted path and the (truncated) client address the ORDINARY derivation gives —
   * on a refused request nothing is edge-forwarded, so that is the address that really connected
   * per the trusted proxy chain. Must never return a header value.
   */
  readonly attribution?: ((c: Context) => Readonly<Record<string, unknown>>) | undefined;
  /** Called once per refusal (a metric counter): `code` and a bounded `reason`. */
  readonly onRefused?: ((code: EdgeRefusalCode, reason: EdgeRefusalReason) => void) | undefined;
}

export type EdgeRefusalCode = "edge_unauthorized" | "invalid_request";
/** `mismatch`: the secret matched neither configured one; `missing`/`invalid`: the forwarded host. */
export type EdgeRefusalReason = "mismatch" | "missing" | "invalid";

function refuse(c: Context<EdgeEnv>, status: 400 | 403, code: string, message: string): Response {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  const requestId = c.get("requestId");
  return c.json(
    { error: { code, message, ...(requestId === undefined ? {} : { requestId }) } },
    status,
  );
}

/** The edge-forwarding middleware (see the file comment). Register right after the request id. */
export function edgeForwarding(options: EdgeForwardingOptions): MiddlewareHandler<EdgeEnv> {
  const check = createEdgeSecretCheck(options.secret, options.previousSecret);
  return async (c, next) => {
    const presented = c.req.header(EDGE_SECRET_HEADER);
    if (presented === undefined) return next();
    const refused = (
      event: string,
      status: 400 | 403,
      code: EdgeRefusalCode,
      reason: EdgeRefusalReason,
      message: string,
    ): Response => {
      // The hooks are best effort: a throwing one must never turn the refusal into a 500 (and
      // a failed attribution still leaves the line itself).
      let attributed: Readonly<Record<string, unknown>> | undefined;
      try {
        attributed = options.attribution?.(c);
      } catch {
        attributed = undefined;
      }
      try {
        options.log?.(event, {
          level: "warn",
          requestId: c.get("requestId"),
          method: c.req.method,
          ...attributed,
          reason,
        });
      } catch {
        // a broken log sink is not the client's problem
      }
      try {
        options.onRefused?.(code, reason);
      } catch {
        // nor is a broken metric
      }
      return refuse(c, status, code, message);
    };
    if (!check(presented)) {
      return refused(
        "http.edge_secret_mismatch",
        403,
        "edge_unauthorized",
        "mismatch",
        "the edge credential was not accepted",
      );
    }
    // Accepted: from here on nothing downstream may see the secret (L10).
    stripEdgeSecret(c);
    const raw = c.req.header(options.hostHeader);
    const host = parseForwardedHost(raw);
    if (host === undefined) {
      return refused(
        "http.edge_forwarded_host_invalid",
        400,
        "invalid_request",
        raw === undefined ? "missing" : "invalid",
        "the edge sent no valid forwarded host",
      );
    }
    const clientIp =
      options.clientIpHeader === undefined
        ? undefined
        : parseForwardedClientIp(c.req.header(options.clientIpHeader));
    c.set("edgeForwarded", clientIp === undefined ? { host } : { host, clientIp });
    await next();
    c.header("Vary", withVary(c.res.headers.get("Vary"), options.hostHeader));
  };
}
