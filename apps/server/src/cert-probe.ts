import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { connect, type PeerCertificate } from "node:tls";
import { assessAddresses, assessUrl } from "@fundroom/outbound-http";

/*
 * TLS certificate probe for the health page's domain rows (E2.7, `GET /ops/health`).
 *
 * It opens a TLS handshake to `hostname:443` with SNI, reads the leaf certificate and hangs up.
 * `rejectUnauthorized: false` is there only so an expired or mis-issued certificate can still be
 * *read* — the point of the row is to say "expires in 3 days" or "expired yesterday", and a
 * verifying handshake would only say "failed". Validity is reported separately from
 * `socket.authorized` / `authorizationError`; nothing is ever sent over the socket.
 *
 * What keeps it from being a scanning primitive:
 *
 *  - **The caller decides the hostnames and may only pass a workspace's verified domains**
 *    (`dns_ok` / `active`). The probe itself adds the SSRF policy the outbound fetch uses
 *    (`@fundroom/outbound-http`): the name must not be an internal one, and every address it
 *    resolves to must be routable unless the name is on `OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS`. A
 *    verified domain can be repointed at `10.0.0.5` after verification; the check runs on every
 *    probe, and the socket connects to the address that was checked (SNI carries the name), so a
 *    rebinding answer between check and connect cannot redirect it.
 *  - **Results are cached per hostname for five minutes** (one minute for a failure) and
 *    concurrent probes of one hostname share a single handshake, so reloading the page cannot be
 *    used to hammer a host. A bounded number of handshakes run at once.
 *  - **Every handshake has a 3-second ceiling** and the socket is destroyed either way.
 */

export type CertStatus = "valid" | "invalid" | "expired" | "unreachable";

export interface CertProbeResult {
  readonly hostname: string;
  readonly status: CertStatus;
  readonly expiresAt: Date | null;
  readonly issuer: string | null;
  /** Why the certificate does not verify, or why no handshake happened. Never an address. */
  readonly error: string | null;
  readonly checkedAt: Date;
}

export interface CertProbe {
  probe(hostnames: readonly string[]): Promise<CertProbeResult[]>;
}

export interface CertProbeOptions {
  /** Default 443. Tests point it at a local server. */
  readonly port?: number;
  readonly timeoutMs?: number;
  readonly ttlMs?: number;
  readonly failureTtlMs?: number;
  readonly concurrency?: number;
  /** `OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS`: names exempt from the address checks. */
  readonly allowedPrivateHosts?: readonly string[];
  /** Resolves a hostname to its addresses. Default `dns.lookup(…, { all: true })`. */
  readonly lookup?: (hostname: string) => Promise<readonly string[]>;
  /** Extra CA certificates to trust when judging validity (tests' self-signed roots). */
  readonly ca?: string | readonly string[];
  readonly now?: () => Date;
}

export const CERT_PROBE_TIMEOUT_MS = 3_000;
export const CERT_PROBE_TTL_MS = 5 * 60_000;
export const CERT_PROBE_FAILURE_TTL_MS = 60_000;
export const CERT_PROBE_CONCURRENCY = 4;
const CACHE_MAX = 1_000;

async function defaultLookup(hostname: string): Promise<readonly string[]> {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.map((a) => a.address);
}

function issuerOf(cert: PeerCertificate): string | null {
  const issuer = cert.issuer as Partial<Record<string, string | string[]>> | undefined;
  if (issuer === undefined) return null;
  const pick = (k: string): string | undefined => {
    const v = issuer[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const name = [pick("O"), pick("CN")].filter((p) => p !== undefined && p !== "");
  return name.length === 0 ? null : name.join(" — ").slice(0, 200);
}

export function createCertProbe(options: CertProbeOptions = {}): CertProbe {
  const port = options.port ?? 443;
  const timeoutMs = options.timeoutMs ?? CERT_PROBE_TIMEOUT_MS;
  const ttlMs = options.ttlMs ?? CERT_PROBE_TTL_MS;
  const failureTtlMs = options.failureTtlMs ?? CERT_PROBE_FAILURE_TTL_MS;
  const concurrency = Math.max(1, options.concurrency ?? CERT_PROBE_CONCURRENCY);
  const lookup = options.lookup ?? defaultLookup;
  const now = options.now ?? (() => new Date());
  const cache = new Map<string, { result: CertProbeResult; until: number }>();
  const inFlight = new Map<string, Promise<CertProbeResult>>();

  const failed = (hostname: string, error: string): CertProbeResult => ({
    hostname,
    status: "unreachable",
    expiresAt: null,
    issuer: null,
    error,
    checkedAt: now(),
  });

  async function resolveGuarded(hostname: string): Promise<string | CertProbeResult> {
    const verdict = assessUrl(`https://${hostname}:${port}/`, {
      allowedPrivateHosts: options.allowedPrivateHosts ?? [],
      allowedPorts: [port],
    });
    if (!verdict.ok) return failed(hostname, "hostname is not allowed");
    let addresses: readonly string[];
    try {
      addresses = verdict.literal !== undefined ? [verdict.literal] : await lookup(hostname);
    } catch {
      return failed(hostname, "DNS lookup failed");
    }
    const allowed = assessAddresses(addresses, verdict.exempt);
    if (!allowed.ok) {
      return failed(
        hostname,
        allowed.code === "dns_failed" ? "DNS lookup failed" : "resolves to a blocked address",
      );
    }
    const address = addresses[0];
    return address === undefined ? failed(hostname, "DNS lookup failed") : address;
  }

  function handshake(hostname: string, address: string): Promise<CertProbeResult> {
    return new Promise((resolve) => {
      let settled = false;
      // The certificate is read, never trusted: validity comes from `socket.authorized` (header).
      // nosemgrep: problem-based-packs.insecure-transport.js-node.bypass-tls-verification.bypass-tls-verification
      const socket = connect({
        host: address,
        port,
        // SNI must be a name, never an IP literal (RFC 6066 §3).
        ...(isIP(hostname) === 0 ? { servername: hostname } : {}),
        rejectUnauthorized: false,
        ...(options.ca === undefined
          ? {}
          : { ca: typeof options.ca === "string" ? options.ca : [...options.ca] }),
        ALPNProtocols: ["http/1.1"],
      });
      const finish = (result: CertProbeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      const timer = setTimeout(
        () => finish(failed(hostname, `no TLS handshake within ${timeoutMs} ms`)),
        timeoutMs,
      );
      timer.unref?.();
      socket.once("error", (error: NodeJS.ErrnoException) =>
        finish(failed(hostname, `TLS handshake failed (${error.code ?? "error"})`)),
      );
      socket.once("secureConnect", () => {
        const cert = socket.getPeerCertificate(false);
        if (cert === undefined || Object.keys(cert).length === 0) {
          finish(failed(hostname, "no certificate presented"));
          return;
        }
        const expiresAt = cert.valid_to ? new Date(cert.valid_to) : null;
        const validExpiry = expiresAt !== null && !Number.isNaN(expiresAt.getTime());
        const at = now();
        const expired = validExpiry && expiresAt.getTime() <= at.getTime();
        const authError =
          socket.authorizationError === undefined || socket.authorizationError === null
            ? null
            : String(
                (socket.authorizationError as unknown as { code?: string }).code ??
                  socket.authorizationError,
              );
        finish({
          hostname,
          status: expired ? "expired" : socket.authorized ? "valid" : "invalid",
          expiresAt: validExpiry ? expiresAt : null,
          issuer: issuerOf(cert),
          error: expired ? (authError ?? "CERT_HAS_EXPIRED") : authError,
          checkedAt: at,
        });
      });
    });
  }

  async function probeOne(hostname: string): Promise<CertProbeResult> {
    const t = now().getTime();
    const hit = cache.get(hostname);
    if (hit !== undefined && hit.until > t) return hit.result;
    const pending = inFlight.get(hostname);
    if (pending !== undefined) return pending;
    const run = (async () => {
      const target = await resolveGuarded(hostname);
      const result = typeof target === "string" ? await handshake(hostname, target) : target;
      if (cache.size >= CACHE_MAX) cache.clear();
      cache.set(hostname, {
        result,
        until: now().getTime() + (result.status === "unreachable" ? failureTtlMs : ttlMs),
      });
      return result;
    })().finally(() => inFlight.delete(hostname));
    inFlight.set(hostname, run);
    return run;
  }

  return {
    async probe(hostnames) {
      const names = [...new Set(hostnames.map((h) => h.toLowerCase()))];
      const results = new Map<string, CertProbeResult>();
      let next = 0;
      const worker = async () => {
        for (;;) {
          const i = next++;
          const name = names[i];
          if (name === undefined) return;
          results.set(name, await probeOne(name));
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));
      return names.map((n) => results.get(n) as CertProbeResult);
    },
  };
}
