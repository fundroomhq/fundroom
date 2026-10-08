import { BlockList, isIPv4 } from "node:net";
import { normalizeIp } from "./request.js";

/*
 * Cloudflare in front of the app (E3.10, `CLOUDFLARE_TRUSTED_PROXY=on`). Cloudflare overwrites
 * `CF-Connecting-IP` with the address that connected to its edge, so the header is exactly as
 * trustworthy as the claim "this request came from Cloudflare" — and that claim is checked
 * against the address that actually connected (the socket peer, or the address our own trusted
 * proxy chain vouches for), never against anything the request says about itself. From any
 * other peer the header is a client-written string and is ignored.
 */

/**
 * Cloudflare's published edge ranges, vendored (https://www.cloudflare.com/ips-v4 and
 * https://www.cloudflare.com/ips-v6). They change rarely but they do change: `fundroom doctor`
 * warns once `fetchedAt` is more than 180 days old (`packages/config/src/doctor.ts` keeps the
 * same date; a test pins the two together). Refresh by replacing both lists and the date.
 */
export const CLOUDFLARE_IP_RANGES = {
  fetchedAt: "2026-09-27",
  v4: [
    "173.245.48.0/20",
    "103.21.244.0/22",
    "103.22.200.0/22",
    "103.31.4.0/22",
    "141.101.64.0/18",
    "108.162.192.0/18",
    "190.93.240.0/20",
    "188.114.96.0/20",
    "197.234.240.0/22",
    "198.41.128.0/17",
    "162.158.0.0/15",
    "104.16.0.0/13",
    "104.24.0.0/14",
    "172.64.0.0/13",
    "131.0.72.0/22",
  ],
  v6: [
    "2400:cb00::/32",
    "2606:4700::/32",
    "2803:f800::/32",
    "2405:b500::/32",
    "2405:8100::/32",
    "2a06:98c0::/29",
    "2c0f:f248::/32",
  ],
} as const;

export const CLOUDFLARE_CLIENT_IP_HEADER = "cf-connecting-ip";

let ranges: BlockList | undefined;

function cloudflareRanges(): BlockList {
  if (ranges !== undefined) return ranges;
  const list = new BlockList();
  for (const cidr of CLOUDFLARE_IP_RANGES.v4) {
    const [net, prefix] = cidr.split("/");
    list.addSubnet(net as string, Number(prefix), "ipv4");
  }
  for (const cidr of CLOUDFLARE_IP_RANGES.v6) {
    const [net, prefix] = cidr.split("/");
    list.addSubnet(net as string, Number(prefix), "ipv6");
  }
  ranges = list;
  return list;
}

/**
 * True when `address` is inside Cloudflare's published ranges. An IPv4-mapped IPv6 socket
 * address (`::ffff:104.16.0.1`, what a dual-stack listener reports) is matched as the IPv4 it is.
 */
export function isCloudflareAddress(address: string | undefined): boolean {
  const ip = normalizeIp(address);
  if (ip === undefined) return false;
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/iu.exec(ip)?.[1];
  if (mapped !== undefined) return cloudflareRanges().check(mapped, "ipv4");
  return cloudflareRanges().check(ip, isIPv4(ip) ? "ipv4" : "ipv6");
}

/**
 * The client address, given the address that actually connected (`peer`): `CF-Connecting-IP`
 * when `peer` is a Cloudflare edge address and the header holds an IP, else `peer` unchanged.
 */
export function cloudflareClientIp(
  peer: string | undefined,
  header: (name: string) => string | undefined,
): string | undefined {
  if (!isCloudflareAddress(peer)) return peer;
  return normalizeIp(header(CLOUDFLARE_CLIENT_IP_HEADER)) ?? peer;
}
