/*
 * Facts about the path-mount e2e stack (deploy/compose/compose.pathmount.yaml, E3.9, ADR-0057).
 *
 * Like the other fixtures this imports nothing from the workspace: the mounts, the base path and
 * the cookie names are spelled out here, so a drift between the recipes, the compose file and the
 * app shows up as a failing assertion rather than as two sides agreeing with each other.
 */

/** The portal's own address. `BASE_URL` in the overlay; every email link must start with it. */
export const PORTAL_HOST = "portal.test";
export const PORTAL_ORIGIN = `https://${PORTAL_HOST}`;
export const BASE_PATH = "/investors";
export const BASE_URL = `${PORTAL_ORIGIN}${BASE_PATH}`;

/** `/api/v1` on the app's own port (not mounted: the public base is BASE_PATH). */
export const API_PREFIX = `${BASE_PATH}/api/v1`;

export interface Mount {
  /** Short name; also the `test.describe` title, so a failure names the recipe. */
  readonly name: "nginx" | "caddy" | "worker" | "next" | "wp";
  readonly host: string;
  /** The public prefix on the host site (a PATH_MOUNTS entry's path). */
  readonly prefix: string;
  /** `preserve` forwards the path unchanged; `replace` swaps the prefix for BASE_PATH. */
  readonly shape: "preserve" | "replace";
  /**
   * Whether the recipe drops the host site's own cookies before they reach the portal. The
   * Worker and WordPress recipes filter to the portal's cookie names; nginx, Caddy and Next.js
   * cannot without extra machinery and the docs say so — the spec asserts both halves, so a
   * recipe that silently starts (or stops) filtering is noticed.
   */
  readonly filtersHostCookies: boolean;
  /** The recipe files under e2e/pathmount/, for failure messages. */
  readonly recipe: string;
}

export const MOUNTS: readonly Mount[] = [
  {
    name: "nginx",
    host: "nginx.test",
    prefix: "/investors",
    shape: "preserve",
    filtersHostCookies: false,
    recipe: "e2e/pathmount/nginx/seed-host-mount.conf",
  },
  {
    name: "caddy",
    host: "caddy.test",
    prefix: "/portal",
    shape: "replace",
    filtersHostCookies: false,
    recipe: "e2e/pathmount/caddy/seed-host-mount.caddy",
  },
  {
    name: "worker",
    host: "worker.test",
    prefix: "/investors",
    shape: "preserve",
    filtersHostCookies: true,
    recipe: "e2e/pathmount/worker/seed-host-mount.js",
  },
  {
    name: "next",
    host: "next.test",
    prefix: "/investors",
    shape: "preserve",
    filtersHostCookies: false,
    recipe: "e2e/pathmount/next/{next.config.mjs,proxy.js}",
  },
  {
    name: "wp",
    host: "wp.test",
    prefix: "/investors",
    shape: "preserve",
    filtersHostCookies: true,
    recipe: "plugins/wordpress proxy mode (seeded by e2e/pathmount/wp/setup.sh)",
  },
];

export function mountOrigin(mount: Mount): string {
  return `https://${mount.host}`;
}

/** `https://<host><prefix>` — the PATH_MOUNTS entry, and where the investor's portal lives. */
export function mountUrl(mount: Mount, path = ""): string {
  return `${mountOrigin(mount)}${mount.prefix}${path}`;
}

/**
 * The edge's published HTTPS port. 443 by default because the URLs carry no port; Chromium's
 * resolver rules can carry one, so `E2E_PATHMOUNT_HTTPS_PORT` works for this Chromium-only rig.
 */
export const HTTPS_PORT = Number(process.env["E2E_PATHMOUNT_HTTPS_PORT"] ?? 443);

export function pathmountResolverRules(): string {
  const hosts = [PORTAL_HOST, ...MOUNTS.map((m) => m.host)];
  return HTTPS_PORT === 443
    ? hosts.map((h) => `MAP ${h} 127.0.0.1`).join(", ")
    : hosts.map((h) => `MAP ${h} 127.0.0.1:${HTTPS_PORT}`).join(", ");
}

/** The cookie the host sites' marketing pages set on `Path=/` (e2e/pathmount/<host>/). */
export const HOST_COOKIE = "host_session";

/**
 * The portal's cookie names (`__Host-`/`__Secure-` + basename) — the allow-list the Worker and
 * WordPress recipes forward. Re-stated, not imported (see the file comment).
 */
export const PORTAL_COOKIE = /^__(?:Host|Secure)-(?:sid|did|auth_req|oidc_req|sso_req|sh_intg)$/u;

/** The portal's session cookie under any non-empty public base (ADR-0057 cookie recipe). */
export const MOUNTED_SESSION_COOKIE = "__Secure-sid";

/** Harness-only: answered by the portal's edge, echoes what the host proxy forwarded. */
export const ECHO_PATH = "/__e2e/echo";

export function parseEcho(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) out[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
  }
  return out;
}

/** Cookie names out of a `Cookie` request header. */
export function cookieNames(header: string): string[] {
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "")
    .map((pair) => pair.slice(0, pair.indexOf("=") < 0 ? undefined : pair.indexOf("=")));
}

/** Every http(s) URL in a mail's text part. */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(/https?:\/\/[^\s<>()"']+/gu)].map((m) => m[0].replace(/[.,;]+$/u, ""));
}
