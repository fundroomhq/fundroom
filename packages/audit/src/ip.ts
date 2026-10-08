import { isIPv4, isIPv6 } from "node:net";

/*
 * IP minimisation (design/02 §6): the general audit log keeps the /24 (v4) or /48 (v6)
 * network, enough for "same office / same ISP" evidence; full addresses belong to the
 * short-retention security table (Phase 2). Output is CIDR text Postgres `inet` accepts.
 */
export function truncateIp(ip: string): string | undefined {
  const s = ip.trim();
  if (isIPv4(s)) {
    const parts = s.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (isIPv6(s)) {
    // IPv4-mapped (::ffff:a.b.c.d) is really v4.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(s);
    if (mapped?.[1]) return truncateIp(mapped[1]);
    const groups = expandIpv6(s);
    return `${groups[0]}:${groups[1]}:${groups[2]}::/48`;
  }
  return undefined;
}

/** Full-precision form Postgres accepts, or undefined for garbage (never throw on input). */
export function normalizeIp(ip: string): string | undefined {
  const s = ip.trim();
  if (isIPv4(s)) return s;
  if (isIPv6(s)) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(s);
    if (mapped?.[1]) return mapped[1];
    return s.replace(/%.*$/u, "");
  }
  return undefined;
}

function expandIpv6(s: string): string[] {
  const noZone = s.replace(/%.*$/u, "");
  const [head = "", tail = ""] = noZone.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = new Array<string>(Math.max(0, 8 - h.length - t.length)).fill("0");
  return [...h, ...fill, ...t].map((g) => g.toLowerCase().replace(/^0+(?=\w)/u, "") || "0");
}
