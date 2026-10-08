import { hmacSha256, sha256 } from "@fundroom/identity";
import type { UaFamily } from "./schema/analytics.js";

/*
 * Data-minimising helpers (design/06 §6 privacy, design/03 "respectful analytics"): what
 * the module keeps about a session is a hash of the session id, a browser *family* and an
 * HMAC of the IP — never the raw values. Pure functions, unit tested.
 */

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

/** `session_key` for a kernel session: sha256 of the id, so a leak of analytics rows never yields a cookie value. */
export function sessionKeyOf(sessionId: string): Buffer {
  return sha256(`session:${sessionId}`);
}

/** `session_key` for server-side facts that arrive without a session: one per member per UTC day. */
export function syntheticSessionKey(membershipId: string, at: Date): Buffer {
  return sha256(`synthetic:${membershipId}:${at.toISOString().slice(0, 10)}`);
}

/** Key purpose for `ip_hash` (ADR-0016 envelope encryption), separate from every other use. */
export const ANALYTICS_IP_PURPOSE = "analytics-ip";

/**
 * `ip_hash` for a view session: an HMAC of the address under the workspace's `analytics-ip`
 * data key, so the raw address is never stored and two workspaces never hash the same visitor
 * alike. It must be a *keyed* MAC rather than a salted hash: IPv4 is only 2^32 wide, so a
 * plain digest over a non-secret salt (a workspace id, say) is recoverable by enumeration from
 * a database dump alone.
 */
export function ipHashOf(key: Uint8Array, ip: string | null | undefined): Buffer | null {
  return ip === null || ip === undefined || ip.length === 0 ? null : hmacSha256(key, `ip:${ip}`);
}

/** The heartbeat's dwell cap per beat (design/06 §6: "every 5 s, capped"). */
export const HEARTBEAT_MAX_MS = 15_000;

/** One beat's dwell after the server-side cap; garbage and negatives count as nothing. */
export function cappedDwellMs(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.floor(ms), HEARTBEAT_MAX_MS) : 0;
}

/** `page_open` rows quieter than this are flushed to `page_viewed` events by `analytics.flush`. */
export const PAGE_OPEN_IDLE_MS = 2 * 60_000;

/**
 * Transparency notice: what each mode records about the caller (portal "what we track"). Stable
 * keys the portal localises. `engagement` also records email opens and clicks on updates (subject
 * to the member's `email_tracking` purpose, reported separately in the notice) and ranks the
 * member on the hot list (`engagement_score`).
 */
export function tracksFor(mode: "off" | "essential" | "engagement"): string[] {
  if (mode === "off") return [];
  const essential = ["document_views", "downloads", "update_views"];
  if (mode === "essential") return essential;
  return [
    ...essential,
    "page_dwell",
    "browser_family",
    "hashed_ip",
    "email_opens",
    "email_clicks",
    "engagement_score",
  ];
}

/**
 * Email clicks that are not engagement with the update (E2.6): the workspace's own
 * `/unsubscribe` page and anything under `/api/` (a tracking-wrapped one-click unsubscribe, a
 * pixel, a beacon). The kernel drops them too; this module drops them again at ingest and never
 * scores them, whatever arrives. `link` is origin + path.
 */
export function isUnscoredLink(link: string | null): boolean {
  if (link === null) return false;
  let path: string;
  try {
    path = new URL(link).pathname;
  } catch {
    path = link;
  }
  const p = path.toLowerCase().replace(/\/{2,}/gu, "/");
  return (
    p === "/unsubscribe" || p.startsWith("/unsubscribe/") || p === "/api" || p.startsWith("/api/")
  );
}
