import { hmacSha256 } from "@fundroom/identity";

/*
 * Data-minimising helpers for acceptance and consent evidence (ADR-0036, design/06 §6).
 *
 * An acceptance row has to survive six years after the offering closes, so it is the last place
 * that should hold a raw IP address or a User-Agent string. What it keeps instead answers the only
 * questions anybody will actually ask of it — "was this the same browser?", "was this the same
 * network?" — without keeping the identifiers themselves.
 *
 * `modules/analytics` carries the same two functions for its view sessions. They are duplicated
 * rather than shared because the kernel must not import a module, and a twenty-line pure function
 * is a smaller price than the seam that would be needed to share it. If a third caller appears,
 * lift them into `@fundroom/crypto`.
 */

export const UA_FAMILIES = ["chrome", "firefox", "safari", "edge", "other"] as const;
export type UaFamily = (typeof UA_FAMILIES)[number];

/** Browser family from a User-Agent string; never the string itself. */
export function uaFamilyOf(userAgent: string | null | undefined): UaFamily {
  const ua = userAgent ?? "";
  if (ua.length === 0) return "other";
  if (/\bEdg(?:e|A|iOS)?\/\d/u.test(ua)) return "edge";
  if (/\b(?:Firefox|FxiOS)\/\d/u.test(ua)) return "firefox";
  if (/\b(?:Chrome|CriOS|Chromium)\/\d/u.test(ua)) return "chrome";
  if (/\bSafari\/\d/u.test(ua) && /\bVersion\/\d/u.test(ua)) return "safari";
  return "other";
}

/** Key purpose for the `ip_hash` on consent and acceptance rows (ADR-0016 envelope encryption). */
export const LEGAL_IP_PURPOSE = "legal-ip";

/**
 * A *keyed* MAC, not a salted hash: IPv4 is only 2^32 wide, so a plain digest over a non-secret
 * salt is recoverable by enumeration from a database dump alone. The key is the workspace's
 * `legal-ip` data key, so two workspaces never hash the same visitor alike.
 */
export function ipHashOf(key: Uint8Array, ip: string | null | undefined): Buffer | null {
  return ip === null || ip === undefined || ip.length === 0 ? null : hmacSha256(key, `ip:${ip}`);
}
