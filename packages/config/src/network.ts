/*
 * Host classification for the transport rules in `crossFieldRules` (E2.10 F-08, F-09).
 *
 * A config loader cannot resolve DNS (and must not: boot would then depend on a resolver), so
 * "private" here is decided from the text of the host alone. It answers the question "is this a
 * hop that never crosses the public internet?", and errs towards *public*: a name we do not
 * recognise is treated as reachable over the internet, which is the case that must be encrypted
 * and verified.
 *
 * Private means one of:
 *  - an IP literal in a loopback, RFC 1918, CGNAT (RFC 6598), link-local or IPv6 ULA range;
 *  - a single-label name (`db`, `postgres`, `dpg-abc123-a`): Compose, Coolify, Kubernetes
 *    short service names and Render's internal hostnames, none of which a public resolver serves;
 *  - a name under a suffix reserved or conventionally used for private networks: `.localhost`,
 *    `.local`, `.internal` (Railway, Fly 6PN, GCP), `.lan`, `.home.arpa`, `.localdomain`,
 *    `.svc` / `.cluster.local` (Kubernetes), `.flycast` (Fly private load balancing) and
 *    `.flympg.net` (Fly Managed Postgres, resolvable only on the org's private network).
 */

const PRIVATE_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".lan",
  ".home.arpa",
  ".localdomain",
  ".svc",
  ".cluster.local",
  ".flycast",
  // Fly Managed Postgres (`pgbouncer.<cluster>.flympg.net`): these names resolve only inside the
  // organisation's private 6PN network, never on the public internet.
  ".flympg.net",
] as const;

function ipv4Octets(host: string): number[] | undefined {
  // Canonical decimal only: `010.0.0.1` is octal (8.0.0.1) to getaddrinfo/inet_aton.
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/u.exec(host);
  if (m === null) return undefined;
  const octets = m.slice(1).map(Number);
  return octets.every((o) => o <= 255) ? octets : undefined;
}

function isPrivateIpv4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return false;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "::1") return true;
  // fc00::/7 (ULA) and fe80::/10 (link-local).
  if (/^f[cd][0-9a-f]{0,2}:/u.test(h)) return true;
  if (/^fe[89ab][0-9a-f]?:/u.test(h)) return true;
  // IPv4-mapped (::ffff:10.0.0.1).
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(h);
  if (mapped?.[1] !== undefined) {
    const octets = ipv4Octets(mapped[1]);
    return octets !== undefined && isPrivateIpv4(octets);
  }
  return false;
}

/**
 * True when `host` (a URL hostname: IPv6 literals may keep their brackets) names a loopback or
 * private-network endpoint. The empty host (a Unix socket, `postgres:///db?host=/run/pg`) is local.
 */
export function isPrivateHost(host: string): boolean {
  let h = host.trim().toLowerCase();
  if (h === "") return true;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.includes(":")) return isPrivateIpv6(h);
  if (h.endsWith(".")) h = h.slice(0, -1);
  const octets = ipv4Octets(h);
  if (octets !== undefined) return isPrivateIpv4(octets);
  // Not a canonical dotted quad but numeric (`2130706433`, `0x08080808`, `010.0.0.1`): the
  // resolver's inet_aton reads these as addresses, so never "private".
  if (/^(?:0x[0-9a-f]*|\d+)(?:\.(?:0x[0-9a-f]*|\d+))*$/u.test(h)) return false;
  if (h === "localhost" || !h.includes(".")) return true;
  return PRIVATE_SUFFIXES.some((suffix) => h.endsWith(suffix));
}
