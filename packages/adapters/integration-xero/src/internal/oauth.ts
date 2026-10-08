/*
 * OAuth 2.0 token endpoint calls (RFC 6749 §4.1.3 / §6) with client_secret_basic — copied verbatim
 * between `@fundroom/integration-quickbooks` and `-xero` (see the note in `http.ts`).
 *
 * Failure mapping (the kernel reads `unauthorized` from `refresh` as `invalid_grant` →
 * `reauth_required`, and anything else as transient):
 * - `error=invalid_grant` (expired/revoked/rotated-away refresh token, reused code) → `unauthorized`;
 * - `invalid_client` / `unauthorized_client`, or a bare 401 (client authentication failed at the
 *   token endpoint) → `unavailable`: the OPERATOR's client credentials are wrong, and asking the
 *   workspace to reconnect would not fix that;
 * - 429 → `rate_limited`, 5xx → `unavailable`, other 4xx → `malformed` (our request was refused);
 * - a 2xx without an `access_token` → `malformed`.
 * The detail names at most the RFC error code (a fixed token), never the vendor's description.
 */

import type { OutboundFetch } from "@fundroom/ports";
import {
  basicAuth,
  type Failure,
  fail,
  isRecord,
  type Logger,
  send,
  statusFailure,
} from "./http.js";

export interface ParsedToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  body: Record<string, unknown>;
}

const OAUTH_ERROR = /^[a-z_]{1,40}$/u;
/** Ten years — anything longer is nonsense, and a Date that far out is not a useful expiry. */
const MAX_LIFETIME_SECONDS = 10 * 365 * 24 * 3600;

export function lifetimeSeconds(raw: unknown): number | null {
  const seconds =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d{1,10}$/u.test(raw.trim())
        ? Number.parseInt(raw.trim(), 10)
        : Number.NaN;
  if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_LIFETIME_SECONDS) return null;
  return seconds;
}

export async function tokenRequest(
  fetch: OutboundFetch,
  tokenUrl: string,
  client: { clientId: string; clientSecret: string },
  form: Record<string, string>,
  now: Date,
  where: string,
  log?: Logger,
): Promise<{ ok: true; value: ParsedToken } | Failure> {
  const sent = await send(
    fetch,
    tokenUrl,
    {
      method: "POST",
      headers: {
        authorization: basicAuth(client.clientId, client.clientSecret),
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
    },
    where,
    log,
  );
  if (!sent.ok) return sent;
  const { status, json } = sent.value;
  if (status < 200 || status >= 300) {
    const code = isRecord(json) && typeof json["error"] === "string" ? json["error"] : null;
    const named = code !== null && OAUTH_ERROR.test(code) ? code : null;
    if (named === "invalid_grant") {
      return fail("unauthorized", `${where} answered invalid_grant (HTTP ${status})`);
    }
    if (named === "invalid_client" || named === "unauthorized_client" || status === 401) {
      return fail(
        "unavailable",
        `${where} refused the deployment's OAuth client credentials (${named ?? `HTTP ${status}`})`,
      );
    }
    if (status === 429 || status >= 500) return statusFailure(status, where);
    if (status >= 400) {
      return fail("malformed", `${where} refused the request (${named ?? `HTTP ${status}`})`);
    }
    return statusFailure(status, where);
  }
  if (!isRecord(json)) return fail("malformed", `${where} did not answer with a JSON object`);
  const accessToken = json["access_token"];
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    return fail("malformed", `${where} answered without an access token`);
  }
  const refreshToken = json["refresh_token"];
  if (refreshToken !== undefined && refreshToken !== null && typeof refreshToken !== "string") {
    return fail("malformed", `${where} answered a refresh token that is not a string`);
  }
  const seconds = lifetimeSeconds(json["expires_in"]);
  const scope = json["scope"];
  return {
    ok: true,
    value: {
      accessToken,
      refreshToken:
        typeof refreshToken === "string" && refreshToken.length > 0 ? refreshToken : null,
      expiresAt: seconds === null ? null : new Date(now.getTime() + seconds * 1000),
      scope: typeof scope === "string" && scope.length > 0 ? scope.slice(0, 1000) : null,
      body: json,
    },
  };
}
