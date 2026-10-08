/*
 * Facts about the embed-host e2e stack (deploy/compose/compose.hosts.yaml) and the two things
 * the plain CI harness has no need for: a set of real hostnames the browser can be made to
 * resolve without touching `/etc/hosts`, and an API client that can configure the workspace
 * before a browser ever opens a page.
 *
 * Like `stack.ts` and `acme.ts`, this imports nothing from the workspace. The suite exists to
 * exercise the built image the way a stranger's browser would, so the slug, the origins and the
 * bridge protocol are all spelled out here rather than imported from `@fundroom/*` — if the
 * loader and the app ever disagree about any of them, a test that imported the answer from one
 * of them would not notice.
 */

/* -------------------------------------------------------------------------------------- */
/* Hostnames                                                                               */
/* -------------------------------------------------------------------------------------- */

/**
 * `.test` is reserved by RFC 6761 for exactly this: names that must never leave the machine and
 * can never collide with a real zone. It also means no public CA could ever sign for them, which
 * is why the edge issues from Caddy's internal CA (see `e2e/hosts/README.md`).
 */
export const PORTAL_HOST = "portal.test";
/** The customer's site. Everything that has to succeed happens here. */
export const HOST_A = "host-a.test";
/** A *second* site. The only thing that proves partition isolation is a different site. */
export const HOST_B = "host-b.test";
/** The inner document of the double-iframe (Wix/Framer/Notion) shape. */
export const HOST_C = "host-c.test";
/** Served over plain http, so the loader has something to refuse. */
export const INSECURE_HOST = "insecure-host.test";

/**
 * The published ports of the edge. They default to the real ones because the browser is told to
 * resolve the hostnames to loopback and nothing rewrites the URL: `https://host-a.test/` has to
 * mean port 443 to Firefox, which can map a name to loopback but not a name to a port.
 * Chromium's `MAP` can carry a port, so a non-default value still works there — that asymmetry
 * is why the Firefox project is only registered when both ports are the default ones.
 */
export const HTTPS_PORT = Number(process.env["E2E_HOSTS_HTTPS_PORT"] ?? 443);
export const HTTP_PORT = Number(process.env["E2E_HOSTS_HTTP_PORT"] ?? 80);

/** Every hostname the rig serves, and the port each is reached on. */
const HOSTS: readonly (readonly [string, number])[] = [
  [PORTAL_HOST, HTTPS_PORT],
  [HOST_A, HTTPS_PORT],
  [HOST_B, HTTPS_PORT],
  [HOST_C, HTTPS_PORT],
  [INSECURE_HOST, HTTP_PORT],
];

export const PORTAL_ORIGIN = `https://${PORTAL_HOST}`;
export const ORIGIN_A = `https://${HOST_A}`;
export const ORIGIN_B = `https://${HOST_B}`;
export const ORIGIN_C = `https://${HOST_C}`;

/** The workspace this rig configures, and the page URL for a host site. */
export const SLUG = "acme-inc";
export const EMBED_URL = `${PORTAL_ORIGIN}/embed/${SLUG}`;

export function hostUrl(host: string, path: string): string {
  const scheme = host === INSECURE_HOST ? "http" : "https";
  return `${scheme}://${host}${path}`;
}

/**
 * Chromium's resolver override. No `/etc/hosts` edit (which needs root, persists after the run
 * and cannot be done on a hosted runner) and no proxy: the browser resolves these names itself
 * and everything downstream — SNI, the `Host` header, the document origin, the cookie's
 * partition key — is the real thing.
 *
 * With the default ports this is one wildcard rule; with overridden ones each name has to carry
 * its port, and a single `MAP *.test 127.0.0.1:<https>` would send the plain-http page to the
 * TLS listener.
 */
export function hostResolverRules(): string {
  if (HTTPS_PORT === 443 && HTTP_PORT === 80) return "MAP *.test 127.0.0.1";
  return HOSTS.map(([host, port]) => `MAP ${host} 127.0.0.1:${port}`).join(", ");
}

/**
 * Firefox's equivalent: `network.dns.localDomains` resolves each listed name to 127.0.0.1. It
 * cannot express a port, so it only works while the edge is on 443/80 — `playwright.config.ts`
 * registers the Firefox project only then, and says so.
 */
export function firefoxLocalDomains(): string {
  return HOSTS.map(([host]) => host).join(",");
}

/* -------------------------------------------------------------------------------------- */
/* The API, before any browser is involved                                                 */
/* -------------------------------------------------------------------------------------- */

/** The app's own published port, bypassing the edge. See `Api` for why that is the right door. */
export const APP_URL = process.env["E2E_BASE_URL"] ?? "http://localhost:3200";

export interface ApiResult<T = unknown> {
  readonly status: number;
  readonly body: T;
}

/**
 * `fetch` plus a cookie jar, pointed at the app's own port rather than at the edge.
 *
 * Deliberately not shared with `acme.ts`'s client of the same shape: that module reads Pebble's
 * root certificate at import time, and a suite with no certificate authority in it should not
 * fail to load because a file belonging to a different rig is missing. The overlap is forty
 * lines of cookie bookkeeping.
 *
 * The session cookie is a `__Host-` cookie and therefore `Secure`, which a non-browser client
 * over `http://localhost` would normally refuse; storing `Set-Cookie` verbatim and echoing it
 * back sidesteps the question. Going through the app's port rather than `https://portal.test`
 * also keeps this half of the suite independent of the edge's self-signed certificate.
 */
export class Api {
  readonly #cookies = new Map<string, string>();

  constructor(private readonly base: string = APP_URL) {}

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#cookies.size > 0) {
      headers["cookie"] = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    // CSRF wants an `Origin` on every unsafe method once a cookie is in play, compared against
    // the request's own origin — which, with no `X-Forwarded-*` on a direct call, is this base.
    if (method !== "GET") headers["origin"] = this.base;

    const res = await fetch(`${this.base}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
    });
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(";")[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "") this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text === "" ? undefined : JSON.parse(text);
    } catch {
      /* a non-JSON body (an HTML error page) comes back as the raw string */
    }
    return { status: res.status, body: parsed as T };
  }

  /** Throws with the server's own error body, which is what you want to read on a failure. */
  async ok<T = unknown>(method: string, path: string, body?: unknown, expect = 200): Promise<T> {
    const res = await this.call<T>(method, path, body);
    if (res.status !== expect) {
      throw new Error(
        `${method} ${path} -> ${res.status} (expected ${expect}): ${JSON.stringify(res.body)}`,
      );
    }
    return res.body;
  }
}

/* -------------------------------------------------------------------------------------- */
/* The embed settings, as the API states them                                              */
/* -------------------------------------------------------------------------------------- */

export interface EmbedSettingsView {
  readonly origins: readonly string[];
  readonly allowPreviewOrigins: boolean;
  readonly trustHostIdentity: boolean;
  readonly frameAncestors: readonly string[];
  readonly embedUrl: string;
  readonly loaderUrl: string;
  readonly loaderIntegrity: string;
}

/** Poll `probe` until it returns a value, or throw. (`acme.ts` has the same shape.) */
export async function until<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  let last: unknown;
  for (;;) {
    try {
      const value = await probe();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`${what} did not happen within the timeout${last ? `: ${last}` : ""}`);
    }
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 500));
  }
}
