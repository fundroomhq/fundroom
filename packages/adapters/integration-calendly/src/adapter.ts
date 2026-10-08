import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  BookingEvent,
  IntegrationAdapter,
  IntegrationAdapterDeps,
  IntegrationAuth,
  IntegrationProviderMeta,
  IntegrationResult,
} from "@fundroom/ports";
import { type Failure, failure, isRecord, parseJson, send, statusFailure, str } from "./http.js";

/*
 * Calendly (personal access token + signed webhook subscription) — E3.6, ADR-0054.
 *
 * Connect: the admin pastes a personal access token; `verify` calls `GET /users/me`. The kernel
 * mints a signing key and calls `booking.subscribe`, which creates a user-scoped webhook
 * subscription for `invitee.created` + `invitee.canceled` with that key. Every delivery carries
 * `Calendly-Webhook-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(key, "<t>.<raw body>")>`;
 * {@link parseCalendlyWebhook} verifies it in constant time and inside a 5-minute window before it
 * looks at the body.
 */

export const CALENDLY_API_BASE_URL = "https://api.calendly.com";
export const CALENDLY_SIGNATURE_HEADER = "calendly-webhook-signature";
/** Replay window either side of `now` (contract §3). */
/** At most this many pages (100 each) are read when listing webhook subscriptions. */
const LIST_MAX_PAGES = 10;
export const CALENDLY_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;
export const CALENDLY_EVENTS = ["invitee.created", "invitee.canceled"] as const;

/** Column bounds of `core.integration_booking` — refuse or trim here so ingest never fails on length. */
const EXTERNAL_ID_MAX = 300;
const EMAIL_MAX = 320;
const NAME_MAX = 200;
const HEADER_MAX = 1_000;

export const calendlyMeta: IntegrationProviderMeta = {
  provider: "calendly",
  displayName: "Calendly",
  capabilities: ["booking"],
  auth: "secret",
  credentialFields: [
    {
      key: "personalAccessToken",
      label: "Personal access token",
      kind: "secret",
      required: true,
      help: "Calendly → Integrations & apps → API and webhooks → Personal access tokens. Scopes needed: users:read, scheduled_events:read, webhooks:write. Webhooks need a paid Calendly plan.",
    },
  ],
  scopeExplanation: [
    "Reads your Calendly user profile to confirm the token works.",
    "Creates one webhook subscription so meetings booked or cancelled through your Calendly links are recorded here.",
    "Receives the invitee's name and email, the meeting name and its start and end time for those bookings.",
    "Never reads your calendar, other event types, meeting notes or answers to booking questions, and never books or cancels anything.",
  ],
  subProcessor: {
    name: "Calendly LLC",
    purpose: "Meeting scheduling; sends booking notifications for the workspace's Calendly links",
    region: "United States",
    dpaUrl: "https://calendly.com/legal/data-processing-addendum",
    jurisdiction: "us",
  },
};

export interface CalendlyAdapterOptions {
  /** Test seam only (ContainerOptions.integrationAdapters): API root, default https://api.calendly.com */
  readonly apiBaseUrl?: string | undefined;
}

/** Case-insensitive header lookup (the kernel may or may not lower-case names). */
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted) return v;
  return undefined;
}

function hexDigestEquals(givenHex: string, expected: Buffer): boolean {
  const given = Buffer.from(givenHex, "hex");
  if (given.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(given, expected);
}

function trimTo(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  const t = value.trim();
  if (t === "") return null;
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}

function validEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  return t.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(t) ? t : undefined;
}

function validDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Verify-then-parse. Exported for the kernel's tests and the fake. */
export function parseCalendlyWebhook(input: {
  headers: Record<string, string>;
  rawBody: Uint8Array;
  secret: string;
  now: Date;
}): IntegrationResult<readonly BookingEvent[]> {
  if (input.secret.length === 0) return failure("unauthorized", "no signing key configured");
  const header = headerValue(input.headers, CALENDLY_SIGNATURE_HEADER);
  if (header === undefined) return failure("unauthorized", "missing signature header");
  if (header.length > HEADER_MAX) return failure("unauthorized", "malformed signature header");
  let t: string | undefined;
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) return failure("unauthorized", "malformed signature header");
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") {
      if (t !== undefined || !/^\d{1,12}$/u.test(value))
        return failure("unauthorized", "malformed signature header");
      t = value;
    } else if (key === "v1") {
      if (!/^[0-9a-fA-F]{64}$/u.test(value) || v1.length >= 5)
        return failure("unauthorized", "malformed signature header");
      v1.push(value);
    }
    // other schemes (a future v2) are ignored, like Stripe-style verifiers do
  }
  if (t === undefined || v1.length === 0)
    return failure("unauthorized", "malformed signature header");
  const expected = createHmac("sha256", input.secret)
    .update(`${t}.`, "utf8")
    .update(input.rawBody)
    .digest();
  let matched = false;
  for (const candidate of v1) if (hexDigestEquals(candidate, expected)) matched = true;
  if (!matched) return failure("unauthorized", "signature mismatch");
  const skew = Math.abs(input.now.getTime() - Number(t) * 1000);
  if (skew > CALENDLY_SIGNATURE_TOLERANCE_MS)
    return failure("unauthorized", "timestamp outside tolerance");

  // Authentic from here on.
  const body = parseJson(Buffer.from(input.rawBody).toString("utf8"));
  if (!isRecord(body)) return failure("malformed", "body is not a JSON object");
  const event = str(body["event"]);
  if (event !== "invitee.created" && event !== "invitee.canceled") return { ok: true, value: [] };
  const payload = body["payload"];
  if (!isRecord(payload)) return failure("malformed", "no payload");
  const externalId = str(payload["uri"]);
  if (externalId === undefined || externalId.length > EXTERNAL_ID_MAX)
    return failure("malformed", "invitee uri missing or too long");
  const inviteeEmail = validEmail(payload["email"]);
  if (inviteeEmail === undefined) return failure("malformed", "invitee email missing or invalid");
  const scheduled = isRecord(payload["scheduled_event"]) ? payload["scheduled_event"] : undefined;
  const startsAt = validDate(scheduled?.["start_time"]);
  if (startsAt === undefined) return failure("malformed", "scheduled_event.start_time missing");
  const status: BookingEvent["status"] =
    event === "invitee.created"
      ? "booked"
      : payload["rescheduled"] === true
        ? "rescheduled"
        : "cancelled";
  return {
    ok: true,
    value: [
      {
        externalId,
        status,
        startsAt,
        endsAt: validDate(scheduled?.["end_time"]) ?? null,
        inviteeEmail,
        inviteeName: trimTo(str(payload["name"]), NAME_MAX),
        eventName: trimTo(str(scheduled?.["name"]), NAME_MAX),
      },
    ],
  };
}

/** Calendly's error body `{title, message}`: echo the title only when it is plain words. */
function calendlyErrorTitle(body: string): string | undefined {
  const parsed = parseJson(body);
  const title = isRecord(parsed) ? parsed["title"] : undefined;
  return typeof title === "string" && /^[A-Za-z][A-Za-z ]{0,60}$/u.test(title) ? title : undefined;
}

const UUID_RE = /^[0-9a-fA-F-]{8,64}$/u;

export function createCalendlyAdapter(
  deps: IntegrationAdapterDeps,
  options: CalendlyAdapterOptions = {},
): IntegrationAdapter {
  const apiBase = (options.apiBaseUrl ?? CALENDLY_API_BASE_URL).replace(/\/+$/u, "");

  async function call(
    auth: IntegrationAuth,
    method: "GET" | "POST" | "DELETE",
    path: string,
    json?: unknown,
  ): Promise<{ ok: true; data: unknown } | Failure> {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${auth.accessToken}`,
    };
    const init: RequestInit = { method, headers };
    if (json !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(json);
    }
    const sent = await send(deps.fetch, `${apiBase}${path}`, init);
    if (!sent.ok) return sent;
    const bad = statusFailure(sent.status, calendlyErrorTitle(sent.body));
    if (bad !== undefined) return bad;
    if (sent.status === 204 || sent.body.trim() === "") return { ok: true, data: undefined };
    const data = parseJson(sent.body);
    if (data === undefined) return failure("malformed", "non-JSON answer");
    return { ok: true, data };
  }

  async function me(auth: IntegrationAuth) {
    const res = await call(auth, "GET", "/users/me");
    if (!res.ok) return res;
    const resource =
      isRecord(res.data) && isRecord(res.data["resource"]) ? res.data["resource"] : undefined;
    const uri = str(resource?.["uri"]);
    if (resource === undefined || uri === undefined)
      return failure("malformed", "users/me answered without a user uri");
    return {
      ok: true as const,
      uri,
      name: str(resource["name"]) ?? str(resource["email"]) ?? uri,
      organization: str(resource["current_organization"]),
    };
  }

  return {
    meta: calendlyMeta,

    async verify(auth) {
      const user = await me(auth);
      if (!user.ok) return user;
      return { ok: true, value: { accountLabel: user.name, externalAccountId: user.uri } };
    },

    booking: {
      linkHosts: ["calendly.com"],

      parseWebhook: parseCalendlyWebhook,

      async subscribe(auth, input) {
        const user = await me(auth);
        if (!user.ok) return user;
        if (user.organization === undefined)
          return failure("malformed", "users/me answered without current_organization");
        const res = await call(auth, "POST", "/webhook_subscriptions", {
          url: input.callbackUrl,
          events: CALENDLY_EVENTS,
          organization: user.organization,
          user: user.uri,
          scope: "user",
          signing_key: input.signingKey,
        });
        if (!res.ok) {
          // 403 on create is almost always the plan: webhooks need Standard or above.
          if (res.reason === "forbidden")
            return failure(
              "forbidden",
              "Calendly refused the webhook subscription (paid plan and webhooks:write scope required)",
            );
          if (res.detail?.startsWith("HTTP 409") === true)
            return failure("malformed", "a webhook subscription for this URL already exists");
          return res;
        }
        const resource =
          isRecord(res.data) && isRecord(res.data["resource"]) ? res.data["resource"] : undefined;
        const uri = str(resource?.["uri"]);
        if (uri === undefined || uri.length > 300)
          return failure("malformed", "webhook subscription answered without a uri");
        return { ok: true, value: { subscriptionId: uri } };
      },

      async listSubscriptions(auth, callbackUrl) {
        const user = await me(auth);
        if (!user.ok) return user;
        if (user.organization === undefined)
          return failure("malformed", "users/me answered without current_organization");
        const out: string[] = [];
        let pageToken: string | undefined;
        for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
          const q = new URLSearchParams({
            organization: user.organization,
            user: user.uri,
            scope: "user",
            count: "100",
          });
          if (pageToken !== undefined) q.set("page_token", pageToken);
          const res = await call(auth, "GET", `/webhook_subscriptions?${q.toString()}`);
          if (!res.ok) return res;
          const data = isRecord(res.data) ? res.data : {};
          const rows = Array.isArray(data["collection"]) ? data["collection"] : [];
          for (const row of rows) {
            if (!isRecord(row)) continue;
            const uri = str(row["uri"]);
            if (uri !== undefined && str(row["callback_url"]) === callbackUrl) out.push(uri);
          }
          const pagination = isRecord(data["pagination"]) ? data["pagination"] : {};
          pageToken = str(pagination["next_page_token"]);
          if (pageToken === undefined) return { ok: true, value: out };
        }
        return failure("too_large", "too many webhook subscriptions to list");
      },

      async unsubscribe(auth, subscriptionId) {
        try {
          // Accept the stored resource uri or a bare uuid; the request URL is always rebuilt on our
          // API base so a stored value can never redirect the token elsewhere.
          const uuid = subscriptionId.split("/").pop() ?? "";
          if (!UUID_RE.test(uuid)) return;
          const res = await call(auth, "DELETE", `/webhook_subscriptions/${uuid}`);
          if (!res.ok && res.reason !== "not_found")
            deps.log?.("integration.calendly.unsubscribe_failed", { reason: res.reason });
        } catch {
          // best effort
        }
      },
    },
  };
}
