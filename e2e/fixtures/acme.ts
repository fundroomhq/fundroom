import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { checkServerIdentity, connect, type PeerCertificate } from "node:tls";
import { fileURLToPath } from "node:url";

/*
 * Facts about the custom-domain e2e stack (deploy/compose/compose.acme.yaml) and the three
 * things the plain CI harness has no need for: publishing DNS into the fake authoritative
 * zone, an HTTP client that carries a cookie jar, and an HTTPS client that verifies the
 * edge's certificate against the local CA's root instead of the public trust store.
 *
 * Like `stack.ts`, this deliberately imports nothing from the workspace. The whole point of
 * the suite is that it exercises the built image the way a stranger's browser would, so the
 * challenge token, the DNS records and the certificate chain are all read back off the wire
 * rather than recomputed from the server's own code.
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The hostname the "customer" points at us. Four labels under `example.com`, which RFC 2606
 * reserves for documentation, so it can never collide with a real zone — and it has to be
 * four, because `packages/custom-domains`' hostname check refuses anything under `.test`,
 * `.example`, `.invalid` or `.localhost` (RFC 6761 special-use names can never hold a
 * certificate) and refuses a bare two-label name whose suffix is a known public one.
 */
export const CUSTOM_HOST = "investors.acme-e2e.example.com";

/** `CUSTOM_DOMAIN_CNAME_TARGET` in the overlay: what the CNAME must point at to verify. */
export const CNAME_TARGET = "edge.fundroom-e2e.example.com";

/** TXT label for the ownership proof (`packages/custom-domains`' `CHALLENGE_LABEL`). */
export const CHALLENGE_LABEL = "_fundroom-challenge";

export const APP_URL = process.env["E2E_BASE_URL"] ?? "http://localhost:3000";
export const CHALLTESTSRV_URL =
  process.env["E2E_CHALLTESTSRV_URL"] ??
  `http://localhost:${process.env["E2E_CHALLTESTSRV_PORT"] ?? "8055"}`;
export const CADDY_HTTPS_PORT = Number(process.env["E2E_CADDY_HTTPS_PORT"] ?? 8443);

export const PEBBLE_MGMT_PORT = Number(process.env["E2E_PEBBLE_MGMT_PORT"] ?? 15000);

/**
 * The root behind Pebble's *own* HTTPS endpoint (`pebble.minica.pem`, copied out of the pinned
 * image — `e2e/acme/README.md`). This is **not** the CA the certificates under test chain to:
 * Pebble generates a fresh `Pebble Root CA <hex>` and intermediate on every start and publishes
 * the root on its management interface. This root only gets us far enough to fetch that one
 * over a verified connection.
 */
export const PEBBLE_ENDPOINT_ROOT = readFileSync(
  join(here, "..", "acme", "pebble-root.pem"),
  "utf8",
);

/* -------------------------------------------------------------------------------------- */
/* The customer's DNS                                                                      */
/* -------------------------------------------------------------------------------------- */

async function challtestsrv(path: string, body: unknown): Promise<void> {
  const res = await fetch(`${CHALLTESTSRV_URL}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`challtestsrv ${path} -> ${res.status} ${await res.text()}`);
}

/** Publish `host CNAME target`. Names are absolute here: challtestsrv keys on the root label. */
export async function publishCname(host: string, target: string): Promise<void> {
  await challtestsrv("/set-cname", { host: `${host}.`, target: `${target}.` });
}

/** Publish a TXT record (the `_fundroom-challenge` proof) at `host` carrying `value`. */
export async function publishTxt(host: string, value: string): Promise<void> {
  await challtestsrv("/set-txt", { host: `${host}.`, value });
}

export async function unpublishCname(host: string): Promise<void> {
  await challtestsrv("/clear-cname", { host: `${host}.` });
}

/* -------------------------------------------------------------------------------------- */
/* An HTTP client with a cookie jar                                                        */
/* -------------------------------------------------------------------------------------- */

export interface ApiResult<T = unknown> {
  readonly status: number;
  readonly body: T;
}

/**
 * The smallest thing that can hold a session: `fetch` plus a cookie jar.
 *
 * Playwright's own `request` fixture would do, but the session cookie is a `__Host-` cookie
 * and therefore `Secure`, and this drives the app over plain `http://localhost` — which
 * browsers treat as a secure context and a non-browser client generally does not. Storing
 * `Set-Cookie` verbatim and echoing it back sidesteps the question entirely.
 */
export class Api {
  readonly #cookies = new Map<string, string>();

  constructor(private readonly base: string) {}

  async call<T = unknown>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.#cookies.size > 0) {
      headers["cookie"] = [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    // The CSRF check wants an Origin on every unsafe method once a cookie is in play, and it
    // compares against the request's own origin (`TRUST_PROXY` is on, but a direct request
    // carries no `X-Forwarded-*`, so that is the base URL).
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
      /* a non-JSON body (an HTML error page) is returned as the raw string */
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
/* HTTPS against the edge, verified against the local CA                                   */
/* -------------------------------------------------------------------------------------- */

export interface EdgeCertificate {
  readonly authorized: boolean;
  readonly authorizationError: string | undefined;
  readonly subject: string;
  readonly issuer: string;
  readonly altNames: readonly string[];
  readonly validTo: string;
}

/**
 * The root of the chain Pebble *issues* from, fetched from its management interface over a
 * connection verified against the root behind Pebble's own endpoint.
 *
 * It has to be fetched rather than committed: Pebble mints a fresh `Pebble Root CA <hex>` and
 * intermediate every time it starts. That is also what makes it the right anchor for the
 * assertion — a certificate that verifies against it was issued by *this* CA process, during
 * *this* run, and cannot be a leftover in Caddy's storage from an earlier one.
 */
let issuerRoot: string | undefined;
export async function pebbleIssuerRoot(): Promise<string> {
  if (issuerRoot !== undefined) return issuerRoot;
  const res = await httpsGet({
    host: "127.0.0.1",
    port: PEBBLE_MGMT_PORT,
    path: "/roots/0",
    servername: "localhost",
    ca: PEBBLE_ENDPOINT_ROOT,
    timeoutMs: 10_000,
  });
  if (res.status !== 200 || !res.body.includes("BEGIN CERTIFICATE")) {
    throw new Error(`pebble /roots/0 -> ${res.status}: ${res.body.slice(0, 200)}`);
  }
  issuerRoot = res.body;
  return issuerRoot;
}

interface HttpsGetInput {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  /** SNI *and* the name the certificate is checked against — never the address dialled. */
  readonly servername: string;
  readonly ca: string;
  readonly hostHeader?: string;
  readonly timeoutMs?: number;
}

/**
 * A GET over a chain verified against `ca` and nothing else, dialling `host:port` while
 * presenting and checking `servername`.
 *
 * The split between the address and the name is the whole point: the edge is reached on
 * loopback at a published port, but the certificate is verified as if the browser had resolved
 * `investors.acme-e2e.example.com` and connected to it — so a certificate for the wrong name,
 * or one Caddy signed with its own internal CA, fails here rather than being waved through the
 * way `ignoreHTTPSErrors` would.
 */
function httpsGet(input: HttpsGetInput): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: input.host,
        port: input.port,
        path: input.path,
        method: "GET",
        servername: input.servername,
        ca: input.ca,
        checkServerIdentity: (_seen, cert) => checkServerIdentity(input.servername, cert),
        headers: {
          host: input.hostHeader ?? input.servername,
          accept: "text/html,application/json,application/pem-certificate-chain",
        },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.setTimeout(input.timeoutMs ?? 60_000, () => {
      req.destroy(new Error(`GET https://${input.servername}${input.path} timed out`));
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * One TLS handshake to the edge for `host`, verified against the CA's issuing root and nothing
 * else, with the identity check pinned to `host`.
 *
 * It fails if Caddy fell back to its own internal CA, if the certificate names something else,
 * or if no certificate could be obtained at all. Caddy runs the entire ACME order *inside* this
 * handshake the first time — order, challenge, validation, download — which is why the timeout
 * is generous and why a pass means the whole exchange happened.
 */
export async function edgeCertificate(
  host: string,
  options: { timeoutMs?: number } = {},
): Promise<EdgeCertificate> {
  const ca = await pebbleIssuerRoot();
  return await new Promise((resolve, reject) => {
    const socket = connect(
      {
        host: "127.0.0.1",
        port: CADDY_HTTPS_PORT,
        servername: host,
        ca,
        checkServerIdentity: (_seen, cert) => checkServerIdentity(host, cert),
      },
      () => {
        const cert: PeerCertificate = socket.getPeerCertificate();
        resolve({
          authorized: socket.authorized,
          authorizationError: socket.authorizationError?.message,
          subject: String(cert.subject?.["CN"] ?? JSON.stringify(cert.subject ?? {})),
          issuer: String(cert.issuer?.["CN"] ?? JSON.stringify(cert.issuer ?? {})),
          altNames: (cert.subjectaltname ?? "")
            .split(",")
            .map((entry) => entry.trim().replace(/^DNS:/u, "")),
          validTo: cert.valid_to ?? "",
        });
        socket.end();
      },
    );
    socket.setTimeout(options.timeoutMs ?? 60_000, () => {
      socket.destroy(new Error(`TLS handshake for ${host} timed out`));
    });
    socket.on("error", reject);
  });
}

/** A GET on the edge for `host`, over that same verified chain. */
export async function edgeGet(
  host: string,
  path: string,
  options: { timeoutMs?: number } = {},
): Promise<{ status: number; body: string }> {
  return await httpsGet({
    host: "127.0.0.1",
    port: CADDY_HTTPS_PORT,
    path,
    servername: host,
    ca: await pebbleIssuerRoot(),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

/* -------------------------------------------------------------------------------------- */
/* The page's own bootstrap config                                                         */
/* -------------------------------------------------------------------------------------- */

/** The subset of `apps/server/src/web.ts`'s `WebConfig` this suite reads back off the wire. */
export interface ServedConfig {
  readonly tree: string;
  readonly tenancy: string;
  /**
   * The workspace's own origin — what "open in a new tab" and every copyable link use, and
   * what the server derives from `ResolvedWorkspace.primaryHost`. `primaryHost` itself is not
   * in the served config, so this is how a page states that the custom domain has become the
   * workspace's address (E2.1 decision 5): with no active domain it is `<slug>.<canonical>`.
   */
  readonly canonicalOrigin: string;
  readonly workspace: { readonly slug: string; readonly name: string } | null;
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

/**
 * The workspace a page was served for, read out of the document the edge returned.
 *
 * The server puts the SPA's whole bootstrap config in `<meta name="seed-host:config">` as
 * HTML-escaped JSON, and it is built from the workspace the tenant middleware resolved — so
 * this is the server stating which workspace it decided the Host header meant. Parsing it
 * rather than substring-matching the document is the difference between asserting the mapping
 * and asserting that a string happens to appear in some markup.
 */
export function servedConfig(html: string): ServedConfig {
  const match = /<meta\s+name="seed-host:config"\s+content="([^"]*)"\s*\/?>/u.exec(html);
  if (match?.[1] === undefined) {
    throw new Error(`no seed-host:config meta in the response:\n${html.slice(0, 500)}`);
  }
  const json = match[1].replace(/&(?:amp|lt|gt|quot|#39|apos);/gu, (e) => ENTITIES[e] ?? e);
  return JSON.parse(json) as ServedConfig;
}

/** Poll `probe` until it returns a value, or throw. */
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
    await new Promise((r) => setTimeout(r, options.intervalMs ?? 1000));
  }
}
