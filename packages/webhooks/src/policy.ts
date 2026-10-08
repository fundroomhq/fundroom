import type { JsonObject, JsonValue } from "@fundroom/ports";
import {
  WEBHOOK_LAST_ERROR_MAX,
  WEBHOOK_MAX_RETRY_AFTER_SECONDS,
  WEBHOOK_PAYLOAD_SCHEMA_VERSION,
  WEBHOOK_RESPONSE_EXCERPT_MAX,
  WEBHOOK_RETRY_DELAYS_SECONDS,
  WEBHOOK_USER_AGENT,
} from "./types.js";

/*
 * The pure half of delivery (E3.4, ADR-0052): what happens after an attempt, what a receiver's
 * answer is allowed to leave behind in the log, and how the endpoint URL is shown. No I/O here,
 * so every rule is unit-tested without a database or a socket.
 */

/**
 * Seconds to wait before the next attempt, or `undefined` when `attempts` (the attempts already
 * made, this one included) has used every retry: the delivery is then `failed` — the DLQ.
 * A `Retry-After` is honoured as a floor, capped at an hour: a receiver may slow us down, never
 * park a delivery for a day.
 */
export function nextRetryDelaySeconds(
  attempts: number,
  retryAfterSeconds?: number | undefined,
): number | undefined {
  const scheduled = WEBHOOK_RETRY_DELAYS_SECONDS[attempts - 1];
  if (scheduled === undefined) return undefined;
  if (retryAfterSeconds === undefined || !Number.isFinite(retryAfterSeconds)) return scheduled;
  const asked = Math.min(
    Math.max(0, Math.ceil(retryAfterSeconds)),
    WEBHOOK_MAX_RETRY_AFTER_SECONDS,
  );
  return Math.max(scheduled, asked);
}

/** Total attempts a delivery gets: the first plus one per scheduled retry. */
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_SECONDS.length + 1;

/**
 * `Retry-After` (RFC 9110 §10.2.3): delay-seconds or an HTTP-date. Seconds from `now`, or
 * `undefined` when absent or unparseable (a garbage header must not stall the schedule).
 */
export function parseRetryAfter(value: string | null | undefined, now: Date): number | undefined {
  if (value === null || value === undefined) return undefined;
  const text = value.trim();
  if (text === "") return undefined;
  if (/^\d+$/u.test(text)) return Number.parseInt(text, 10);
  // An HTTP-date names its weekday and month; `Date.parse` would read "-5" as a year.
  if (!/^[A-Za-z]{3}, /u.test(text)) return undefined;
  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now.getTime()) / 1000));
}

/** What one attempt's answer means for the delivery. */
export type AttemptVerdict = "succeeded" | "gone" | "failed";

export function verdictOf(status: number): AttemptVerdict {
  if (status >= 200 && status < 300) return "succeeded";
  if (status === 410) return "gone";
  return "failed";
}

/**
 * The response excerpt kept for the delivery log: printable characters only (tabs, newlines and
 * every other control character become a space; runs of whitespace collapse), at most 512.
 * A receiver's body is untrusted text shown in an admin screen, so nothing that could steer a
 * terminal or a log viewer survives.
 */
export function sanitizeExcerpt(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    // C0, DEL, C1, the bidi overrides and isolates, zero-width and line/paragraph separators.
    const control =
      cp < 0x20 ||
      (cp >= 0x7f && cp <= 0x9f) ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x2028 && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      cp === 0xfeff ||
      cp === 0xfffd;
    out += control ? " " : ch;
    if (out.length > WEBHOOK_RESPONSE_EXCERPT_MAX * 2) break;
  }
  const collapsed = out.replace(/\s+/gu, " ").trim();
  if (collapsed === "") return null;
  // Never split a surrogate pair at the cut.
  return Array.from(collapsed).slice(0, WEBHOOK_RESPONSE_EXCERPT_MAX).join("");
}

/**
 * Error text safe to store and show: bounded, printable, and never containing the URL (or its
 * path/query, where receivers put their tokens).
 */
export function safeError(text: string, url?: string | undefined): string {
  return Array.from(sanitizeExcerpt(redactUrl(text, url)) ?? "error")
    .slice(0, WEBHOOK_LAST_ERROR_MAX)
    .join("");
}

/** `text` with the URL, its path and its query replaced by `[url]` (no other change). */
export function redactUrl(text: string, url?: string | undefined): string {
  let out = text;
  if (url !== undefined && url.length > 0) {
    const variants = new Set([url]);
    try {
      const u = new URL(url);
      variants.add(u.href);
      if (u.pathname.length > 1) variants.add(u.pathname);
      if (u.search.length > 1) variants.add(u.search);
    } catch {
      // not a URL: the literal is all there is to hide
    }
    for (const v of variants) out = out.split(v).join("[url]");
  }
  return out;
}

/** The two display columns: scheme + host (with a non-default port), and the last ≤4 characters. */
export function urlDisplay(url: URL): { readonly urlHost: string; readonly urlHint: string } {
  return { urlHost: url.origin.slice(0, 300), urlHint: url.href.slice(-4) };
}

/**
 * The catalogue `data` fields the outbound projection removes (the docs list them; a unit test
 * keeps this list equal to every session- or user-id-naming key in `EVENT_CATALOGUE`).
 * `userId` (fix H2): a global user id is the same across workspaces, so receivers of two
 * workspaces could link one person; the membership id is the per-workspace handle. The projection also
 * drops any other key naming a session, so a new one is withheld even before it is listed here.
 */
export const WEBHOOK_STRIPPED_DATA_FIELDS: readonly string[] = ["sessionId", "userId"];

/** Keys never sent to a receiver: session identifiers, at any depth. */
const WITHHELD_KEY = /session/iu;

/**
 * The outbound projection of an event payload (`data`): the catalogue payload minus every key
 * naming a session (`sessionId` on `document.viewed` / `update.viewed`, and any future one).
 * A session id is an internal correlation handle; a third-party URL has no use for it and a
 * leaked one ties a person's requests together. A denylist on purpose — the catalogue is ids
 * only already — and a unit test walks every topic's schema so a new session-bearing key cannot
 * slip through. Applied at fan-out, so the stored payload is exactly what is sent.
 */
export function projectWebhookData(data: JsonObject): JsonObject {
  const out: JsonObject = {};
  for (const [key, value] of Object.entries(data)) {
    if (WITHHELD_KEY.test(key) || WEBHOOK_STRIPPED_DATA_FIELDS.includes(key)) continue;
    out[key] = project(value);
  }
  return out;
}

function project(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(project);
  if (value !== null && typeof value === "object") return projectWebhookData(value);
  return value;
}

/** The body as stored (`payload`): everything but `id`/`eventId`, which are the delivery's own. */
export interface StoredPayload extends JsonObject {
  type: string;
  timestamp: string;
  workspaceId: string;
  data: JsonObject;
  schemaVersion: number;
}

export function storedPayload(input: {
  readonly topic: string;
  readonly createdAt: Date;
  readonly workspaceId: string;
  readonly data: JsonObject;
  readonly schemaVersion?: number | undefined;
}): StoredPayload {
  return {
    type: input.topic,
    timestamp: input.createdAt.toISOString(),
    workspaceId: input.workspaceId,
    data: input.data,
    schemaVersion: input.schemaVersion ?? WEBHOOK_PAYLOAD_SCHEMA_VERSION,
  };
}

/** Headers of one attempt; `signature` is `signPayload`'s output over exactly `body`. */
export function requestHeaders(input: {
  readonly id: string;
  readonly timestamp: number;
  readonly signature: string;
}): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": WEBHOOK_USER_AGENT,
    "webhook-id": input.id,
    "webhook-timestamp": String(input.timestamp),
    "webhook-signature": input.signature,
  };
}
