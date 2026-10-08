import { createHmac, timingSafeEqual } from "node:crypto";
import type { CalendarPeriodKind } from "./period.js";

/*
 * Chart capability tokens (E2.4 §9.1, decision D5).
 *
 * `GET /metrics/chart/{token}.png` is what an update email's `<img src>` points at, and a mail
 * client carries no session — so the URL itself is the authority. The construction is
 * `modules/updates/src/tokens.ts:1-62` verbatim in shape: `base64url(json).base64url(hmac)`,
 * HMAC-SHA256 under the workspace data key for the purpose `metrics-chart`, compared with
 * `timingSafeEqual`. A token therefore never works across tenants.
 *
 * **The token names a set of metrics, never a reader.** That is the whole of decision D5: this
 * product ships no tracking pixels (plan §15 E1.4, and `modules/analytics` says so twice), and
 * an `<img>` in an email *is* a tracking pixel the moment its URL identifies one person. So `d`
 * is the list of definition ids that **audience** may see, filtered once at send time, and
 * every recipient who sees the same metrics shares one URL. Gating survives, the open signal is
 * never created, and the cache hit rate is high.
 *
 * `asOf` is what keeps a sent email honest: the route selects, per period, the highest revision
 * created on or before that instant, so a restatement made next week does not silently rewrite
 * a picture somebody already has in their inbox.
 */

/** Envelope key purpose. A chart key is a different key from the unsubscribe key. */
export const CHART_TOKEN_PURPOSE = "metrics-chart";

/** 180 days after the send (§9.1). After that the image 404s and the archive link still works. */
export const CHART_TOKEN_TTL_DAYS = 180;

/** Ceiling on the ids one token may carry; a legend beyond this is unreadable anyway. */
export const CHART_MAX_SERIES = 6;

export interface ChartTokenPayload {
  readonly v: 1;
  /** Workspace id; a token minted for one tenant must not verify against another. */
  readonly w: string;
  /**
   * Which workspace data key signed this token.
   *
   * It exists because the whole premise of the token is that it survives in somebody's inbox
   * for 180 days, and `crypto.rotate` is a routine operational act (`crypto.rewrap` runs
   * nightly). Verifying against whatever key happens to be current would mean that rotating a
   * workspace's key silently 404s every chart image in every update ever sent — undiagnosably,
   * because the token still looks well-formed and this route answers 404 for everything by
   * design. `modules/updates`' unsubscribe token carries a key id for exactly this reason.
   *
   * It names **which key**, and nothing else: the verifier selects the key by `kid` and only
   * then checks the HMAC. A token never gets to choose a verification *path*.
   */
  readonly kid: string;
  /** Definition ids, **already audience-filtered at send time**. */
  readonly d: readonly string[];
  readonly k: CalendarPeriodKind;
  /** How many periods the chart shows, oldest first. */
  readonly n: number;
  /** ISO instant the numbers were true at. */
  readonly asOf: string;
  /** ISO instant the capability stops working. */
  readonly exp: string;
}

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64url");

function sign(key: Uint8Array, body: string): string {
  return b64(createHmac("sha256", key).update(body).digest());
}

export function signChartToken(key: Uint8Array, payload: ChartTokenPayload): string {
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(key, body)}`;
}

const PERIOD_KINDS: readonly string[] = ["month", "quarter", "year"];

/** Shape check only; says nothing about the signature. Never throws. */
export function decodeChartToken(token: string): ChartTokenPayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [body, sig] = parts;
  if (!body || !sig) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const p = parsed as Record<string, unknown>;
    if (p["v"] !== 1) return undefined;
    if (typeof p["w"] !== "string" || typeof p["asOf"] !== "string") return undefined;
    if (typeof p["kid"] !== "string" || p["kid"].length === 0) return undefined;
    if (typeof p["exp"] !== "string" || typeof p["n"] !== "number") return undefined;
    if (typeof p["k"] !== "string" || !PERIOD_KINDS.includes(p["k"])) return undefined;
    const d = p["d"];
    if (!Array.isArray(d) || d.length === 0 || d.length > CHART_MAX_SERIES) return undefined;
    if (!d.every((x): x is string => typeof x === "string")) return undefined;
    if (!Number.isInteger(p["n"]) || (p["n"] as number) < 1 || (p["n"] as number) > 60) {
      return undefined;
    }
    return {
      v: 1,
      w: p["w"],
      kid: p["kid"],
      d,
      k: p["k"] as CalendarPeriodKind,
      n: p["n"] as number,
      asOf: p["asOf"],
      exp: p["exp"],
    };
  } catch {
    return undefined;
  }
}

/**
 * The payload, or `undefined` for **every** kind of refusal — malformed, wrong signature,
 * expired. The caller answers 404 to all of them: the route is public, and a distinguishable
 * failure is an oracle. E2.2 shipped exactly that bug on the handoff route (`unknown_key` vs
 * `bad_signature`) and had to collapse the two; this returns one value so the collapse cannot
 * be undone by accident.
 */
function signatureMatches(key: Uint8Array, token: string): boolean {
  const [body, sig] = token.split(".");
  const expected = Buffer.from(sign(key, body ?? ""));
  const given = Buffer.from(sig ?? "");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function verifyChartToken(
  key: Uint8Array,
  token: string,
  now: Date,
): ChartTokenPayload | undefined {
  const payload = decodeChartToken(token);
  if (payload === undefined) return undefined;
  if (!signatureMatches(key, token)) return undefined;
  const expires = Date.parse(payload.exp);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return undefined;
  return payload;
}

/** Why a token was refused. For the **log only** — the wire answer is 404 for all four. */
export type ChartTokenRefusal = "malformed" | "unknown_key" | "bad_signature" | "expired";

export type ChartTokenResolution =
  | { readonly ok: true; readonly payload: ChartTokenPayload }
  | { readonly ok: false; readonly reason: ChartTokenRefusal };

/**
 * Selects the key the token names, **then** verifies under it.
 *
 * The order is the security property and it is not negotiable: `kid` may name which key to
 * fetch and nothing else. `keyById` is the caller's, and it is where the envelope purpose is
 * enforced — a key minted for unsubscribe links must not verify a chart token, so a purpose
 * mismatch comes back as "no such key" rather than as a key that happens not to match.
 *
 * Every refusal is a distinct `reason` for the operator's log and the **same** answer on the
 * wire. Keeping them apart here is what lets the route stay a single 404 without losing the
 * ability to tell a rotated-away key from a forgery when somebody has to diagnose one.
 */
export async function resolveChartToken(
  token: string,
  now: Date,
  keyById: (kid: string) => Promise<{ readonly key: Uint8Array } | undefined>,
): Promise<ChartTokenResolution> {
  const payload = decodeChartToken(token);
  if (payload === undefined) return { ok: false, reason: "malformed" };
  const key = await keyById(payload.kid);
  if (key === undefined) return { ok: false, reason: "unknown_key" };
  if (!signatureMatches(key.key, token)) return { ok: false, reason: "bad_signature" };
  const expires = Date.parse(payload.exp);
  if (!Number.isFinite(expires) || expires <= now.getTime()) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, payload };
}
