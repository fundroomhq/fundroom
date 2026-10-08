import { BlockList, isIPv4, isIPv6 } from "node:net";
import type { OutboundHttpErrorCode } from "@fundroom/ports";

/*
 * Pure SSRF policy (EXECUTION_PLAN §10 "Outbound", design/02 §5 SSRF). Decides, without
 * touching the network, whether a URL and the addresses it resolves to may be contacted.
 * The guard in guard.ts applies it before DNS, after DNS (every returned address) and again
 * on every redirect hop.
 *
 *  - scheme: http/https only, no userinfo;
 *  - hostname deny-list for names that only mean something inside a network;
 *  - ports: 80/443 unless the target is explicitly allowed;
 *  - addresses: every block the IANA special-purpose registries (v4 and v6, reviewed
 *    2026-09) mark as not globally reachable, plus deprecated/transition space. v4 embedded
 *    in v6 by a translator (IPv4-mapped `::ffff:a.b.c.d`, NAT64 `64:ff9b::/96`, 6to4
 *    `2002:AABB:CCDD::/48`) is re-checked as v4; other embedding forms (IPv4-compatible
 *    `::/96`, SIIT `::ffff:0:0:0/96`, local-use NAT64 `64:ff9b:1::/48`, Teredo) are refused
 *    outright. v6 outside global unicast `2000::/3` is refused (all of it is special or
 *    IETF-reserved), so a future special block down there cannot slip through.
 */
export interface OutboundPolicy {
  /** Skip the host, port and address checks entirely (dev / trusted network). Default false. */
  readonly allowPrivate?: boolean | undefined;
  /**
   * Hostnames or IP literals exempt from the host, port and address checks (an internal
   * webhook target, an OIDC issuer on the LAN). Exact, case-insensitive hostname match.
   */
  readonly allowedPrivateHosts?: readonly string[] | undefined;
  /** Ports a non-exempt target may use. Default `[80, 443]`. */
  readonly allowedPorts?: readonly number[] | undefined;
}

export type Verdict =
  | {
      readonly ok: true;
      readonly url: URL;
      /** Lower-cased, trailing dot removed, no brackets. */
      readonly hostname: string;
      readonly port: number;
      /** Set when the hostname is an IP literal (no DNS needed). */
      readonly literal: string | undefined;
      /** True when the target is exempt from address checks (`allowPrivate` / allowed host). */
      readonly exempt: boolean;
    }
  | {
      readonly ok: false;
      readonly code: OutboundHttpErrorCode;
      readonly message: string;
    };

export const DEFAULT_ALLOWED_PORTS: readonly number[] = [80, 443];

/** Suffixes (and exact names) that never leave a private network. */
export const BLOCKED_HOST_SUFFIXES: readonly string[] = [
  "localhost",
  "local",
  "internal",
  "home.arpa",
  "in-addr.arpa",
  "ip6.arpa",
];

export const BLOCKED_HOSTS: readonly string[] = ["metadata.google.internal"];

const v4Blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24], // deprecated 6to4 relay anycast (RFC 7526)
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
  ["255.255.255.255", 32],
] as const) {
  v4Blocked.addSubnet(net, prefix, "ipv4");
}

/*
 * Blocks inside global unicast `2000::/3` that are not globally reachable. Everything outside
 * `2000::/3` (`::/128`, `::1`, `::/96` IPv4-compatible, `::ffff:0:0:0/96` SIIT, `64:ff9b:1::/48`,
 * `100::/64` discard, `100:0:0:1::/64` dummy, `5f00::/16` SRv6, `fc00::/7`, `fec0::/10`
 * site-local, `fe80::/10`, `ff00::/8`, and IETF-reserved space) is refused by `v6Global`
 * below; only the mapped / NAT64 forms whose embedded v4 is re-checked escape that rule. The
 * named non-global blocks are listed here as well so they never hinge on that one rule.
 */
const v6Blocked = new BlockList();
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback, IPv4-compatible (deprecated)
  ["::ffff:0:0:0", 96], // SIIT (RFC 2765)
  ["64:ff9b:1::", 48], // local-use NAT64 (RFC 8215)
  ["100::", 64], // discard
  ["100:0:0:1::", 64], // dummy prefix (RFC 9780)
  ["5f00::", 16], // SRv6 SIDs (RFC 9602)
  ["fc00::", 7], // unique local
  ["fec0::", 10], // site-local (deprecated)
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
  ["2001::", 23], // IETF protocol assignments: Teredo 2001::/32, benchmarking 2001:2::/48, ORCHID…
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation (RFC 9637)
] as const) {
  v6Blocked.addSubnet(net, prefix, "ipv6");
}

const v6Global = new BlockList();
v6Global.addSubnet("2000::", 3, "ipv6");

/** Expands an IPv6 literal to eight 16-bit groups; `undefined` for anything malformed. */
export function expandIpv6(address: string): number[] | undefined {
  let text = address;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  if (text.includes("%")) return undefined; // zone ids are never routable targets for us
  if (!isIPv6(text)) return undefined;
  // Embedded dotted quad (`::ffff:1.2.3.4`, `64:ff9b::1.2.3.4`).
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (!isIPv4(tail)) return undefined;
    const octets = tail.split(".").map(Number);
    const hi = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const lo = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    text = `${text.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const groups = [...head, ...new Array<string>(Math.max(missing, 0)).fill("0"), ...rest];
  const out = groups.map((g) => Number.parseInt(g, 16));
  return out.length === 8 && out.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff)
    ? out
    : undefined;
}

function v4Of(hi: number, lo: number): string {
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * The IPv4 address a translator would actually reach for `groups`, or `undefined` when the
 * address is not one of the re-checkable embedding forms.
 */
function embeddedIpv4(groups: readonly number[]): string | undefined {
  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const zero4 = g2 === 0 && g3 === 0 && g4 === 0;
  // IPv4-mapped ::ffff:a.b.c.d
  if (g0 === 0 && g1 === 0 && zero4 && g5 === 0xffff) return v4Of(g6, g7);
  // Well-known NAT64 prefix 64:ff9b::/96 (RFC 6052)
  if (g0 === 0x64 && g1 === 0xff9b && zero4 && g5 === 0) return v4Of(g6, g7);
  // 6to4 2002:AABB:CCDD::/48 (RFC 3056): the relay tunnels to AA.BB.CC.DD
  if (g0 === 0x2002) return v4Of(g1, g2);
  return undefined;
}

/**
 * True when `address` must not be contacted. Unparseable input counts as blocked: the guard
 * only ever passes what `net.isIP` accepted, so anything else is a bug or an attack.
 */
export function isBlockedAddress(address: string): boolean {
  if (isIPv4(address)) return v4Blocked.check(address, "ipv4");
  const groups = expandIpv6(address);
  if (!groups) return true;
  const v4 = embeddedIpv4(groups);
  if (v4 !== undefined) return v4Blocked.check(v4, "ipv4");
  const canonical = groups.map((g) => g.toString(16)).join(":");
  if (!v6Global.check(canonical, "ipv6")) return true;
  return v6Blocked.check(canonical, "ipv6");
}

export function normalizeHostname(hostname: string): string {
  let h = hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

export function isBlockedHostname(hostname: string): boolean {
  const h = normalizeHostname(hostname);
  if (BLOCKED_HOSTS.includes(h)) return true;
  return BLOCKED_HOST_SUFFIXES.some((s) => h === s || h.endsWith(`.${s}`));
}

function literalOf(hostname: string): string | undefined {
  if (isIPv4(hostname)) return hostname;
  if (isIPv6(hostname)) return hostname;
  return undefined;
}

function isExempt(policy: OutboundPolicy, hostname: string): boolean {
  if (policy.allowPrivate === true) return true;
  const allowed = policy.allowedPrivateHosts ?? [];
  return allowed.some((a) => normalizeHostname(a) === hostname);
}

/** Static checks on the URL: scheme, userinfo, hostname, port, IP literal. */
export function assessUrl(input: string | URL, policy: OutboundPolicy = {}): Verdict {
  let url: URL;
  try {
    url = new URL(typeof input === "string" ? input : input.href);
  } catch {
    return { ok: false, code: "blocked_scheme", message: "not a valid absolute URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, code: "blocked_scheme", message: `scheme ${url.protocol} is not allowed` };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, code: "blocked_host", message: "credentials in the URL are not allowed" };
  }
  const hostname = normalizeHostname(url.hostname);
  if (hostname === "") {
    return { ok: false, code: "blocked_host", message: "empty host" };
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  const literal = literalOf(hostname);
  const exempt = isExempt(policy, hostname);
  if (!exempt) {
    if (isBlockedHostname(hostname)) {
      return { ok: false, code: "blocked_host", message: `host ${hostname} is not allowed` };
    }
    const ports = policy.allowedPorts ?? DEFAULT_ALLOWED_PORTS;
    if (!ports.includes(port)) {
      return { ok: false, code: "blocked_port", message: `port ${port} is not allowed` };
    }
    if (literal !== undefined && isBlockedAddress(literal)) {
      return {
        ok: false,
        code: "blocked_address",
        message: `address ${literal} is in a blocked range`,
      };
    }
  }
  return { ok: true, url, hostname, port, literal, exempt };
}

/** Checks resolved addresses; every one must be routable or the target is refused. */
export function assessAddresses(
  addresses: readonly string[],
  exempt: boolean,
):
  | { readonly ok: true }
  | { readonly ok: false; readonly code: OutboundHttpErrorCode; readonly message: string } {
  if (addresses.length === 0) return { ok: false, code: "dns_failed", message: "no addresses" };
  if (exempt) return { ok: true };
  for (const a of addresses) {
    if (isBlockedAddress(a)) {
      return { ok: false, code: "blocked_address", message: `resolves to blocked address ${a}` };
    }
  }
  return { ok: true };
}
