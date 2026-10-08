import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  BookingEvent,
  IntegrationAdapter,
  IntegrationAdapterDeps,
  IntegrationProviderMeta,
  IntegrationResult,
} from "@fundroom/ports";

/*
 * Cal.com signed booking webhooks — E3.6, ADR-0054.
 *
 * Connection-less: there is no Cal.com credential. Connecting mints *our* webhook secret; the admin
 * pastes the callback URL and that secret into Cal.com → Settings → Developer → Webhooks. Every
 * delivery carries `X-Cal-Signature-256: <hex HMAC-SHA256(secret, raw body)>`, verified here in
 * constant time before the body is parsed. Cal.com signs no timestamp, so there is no replay
 * window; replays are harmless because the kernel dedupes by (provider, external id).
 */

export const CALCOM_SIGNATURE_HEADER = "x-cal-signature-256";
export const CALCOM_TRIGGERS = [
  "BOOKING_CREATED",
  "BOOKING_CANCELLED",
  "BOOKING_RESCHEDULED",
] as const;
export const CALCOM_ACCOUNT_LABEL = "Cal.com webhook";

/** Column bounds of `core.integration_booking`. */
const EXTERNAL_ID_MAX = 300;
const EMAIL_MAX = 320;
const NAME_MAX = 200;

export const calcomMeta: IntegrationProviderMeta = {
  provider: "calcom",
  displayName: "Cal.com",
  capabilities: ["booking"],
  auth: "secret",
  credentialFields: [],
  scopeExplanation: [
    "No Cal.com account access: you add a webhook in Cal.com that sends booking notifications here, signed with a secret we show you once.",
    "Receives the attendee's name and email, the meeting title and its start and end time when a meeting is booked, cancelled or rescheduled.",
    "Never reads your calendar or Cal.com account, and never books or cancels anything.",
  ],
  subProcessor: {
    name: "Cal.com, Inc.",
    purpose: "Meeting scheduling; sends booking notifications for the workspace's Cal.com links",
    region: "United States (EU instance available at cal.eu)",
    dpaUrl: "https://cal.com/privacy",
    jurisdiction: "varies",
  },
};

/** Case-insensitive header lookup (the kernel may or may not lower-case names). */
export function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === wanted) return v;
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function trimTo(value: string | undefined, max: number): string | null {
  if (value === undefined) return null;
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function validEmail(value: unknown): string | undefined {
  const t = str(value);
  return t !== undefined && t.length <= EMAIL_MAX && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(t)
    ? t
    : undefined;
}

function validDate(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function fail(
  reason: "unauthorized" | "malformed",
  detail: string,
): { ok: false; reason: "unauthorized" | "malformed"; detail: string } {
  return { ok: false, reason, detail };
}

/** Verify-then-parse. Exported for the kernel's tests and fakes. */
export function parseCalcomWebhook(input: {
  headers: Record<string, string>;
  rawBody: Uint8Array;
  secret: string;
  now: Date;
}): IntegrationResult<readonly BookingEvent[]> {
  if (input.secret.length === 0) return fail("unauthorized", "no webhook secret configured");
  const header = headerValue(input.headers, CALCOM_SIGNATURE_HEADER)?.trim();
  if (header === undefined || header === "")
    return fail("unauthorized", "missing signature header");
  // Accept an optional `sha256=` prefix defensively; the digest itself must be 64 hex characters.
  const hex = header.startsWith("sha256=") ? header.slice(7) : header;
  if (!/^[0-9a-fA-F]{64}$/u.test(hex)) return fail("unauthorized", "malformed signature header");
  const expected = createHmac("sha256", input.secret).update(input.rawBody).digest();
  if (!timingSafeEqual(Buffer.from(hex, "hex"), expected))
    return fail("unauthorized", "signature mismatch");

  // Authentic from here on.
  let body: unknown;
  try {
    body = JSON.parse(Buffer.from(input.rawBody).toString("utf8")) as unknown;
  } catch {
    return fail("malformed", "body is not JSON");
  }
  if (!isRecord(body)) return fail("malformed", "body is not a JSON object");
  const trigger = str(body["triggerEvent"]);
  if (trigger === undefined || !(CALCOM_TRIGGERS as readonly string[]).includes(trigger))
    return { ok: true, value: [] };
  const payload = body["payload"];
  if (!isRecord(payload)) return fail("malformed", "no payload");

  const uid = str(payload["uid"]);
  if (uid === undefined || uid.length > EXTERNAL_ID_MAX)
    return fail("malformed", "payload.uid missing or too long");
  const attendee =
    Array.isArray(payload["attendees"]) && isRecord(payload["attendees"][0])
      ? payload["attendees"][0]
      : undefined;
  const inviteeEmail = validEmail(attendee?.["email"]);
  if (inviteeEmail === undefined) return fail("malformed", "attendee email missing or invalid");
  const startsAt = validDate(payload["startTime"]);
  if (startsAt === undefined) return fail("malformed", "payload.startTime missing");
  const inviteeName = trimTo(str(attendee?.["name"]), NAME_MAX);
  const eventName = trimTo(
    str(payload["eventTitle"]) ?? str(payload["title"]) ?? str(payload["type"]),
    NAME_MAX,
  );
  const common = { inviteeEmail, inviteeName, eventName };

  if (trigger === "BOOKING_CANCELLED") {
    return {
      ok: true,
      value: [
        {
          externalId: uid,
          status: "cancelled",
          startsAt,
          endsAt: validDate(payload["endTime"]) ?? null,
          ...common,
        },
      ],
    };
  }
  const current: BookingEvent = {
    externalId: uid,
    status: "booked",
    startsAt,
    endsAt: validDate(payload["endTime"]) ?? null,
    ...common,
  };
  if (trigger === "BOOKING_CREATED") return { ok: true, value: [current] };

  // BOOKING_RESCHEDULED: Cal.com creates a NEW booking (`uid`) and retires the original
  // (`rescheduleUid`, at `rescheduleStartTime`/`rescheduleEndTime`). Mirror Calendly, which sends
  // `invitee.canceled` (rescheduled) for the old invitee and `invitee.created` for the new one:
  // the original becomes `rescheduled`, the new one `booked`.
  const events: BookingEvent[] = [];
  const oldUid = str(payload["rescheduleUid"]);
  const oldStart = validDate(payload["rescheduleStartTime"]);
  if (
    oldUid !== undefined &&
    oldUid !== uid &&
    oldUid.length <= EXTERNAL_ID_MAX &&
    oldStart !== undefined
  ) {
    events.push({
      externalId: oldUid,
      status: "rescheduled",
      startsAt: oldStart,
      endsAt: validDate(payload["rescheduleEndTime"]) ?? null,
      ...common,
    });
  } else {
    // Payloads without the original's uid/start (older Cal.com versions): record the new booking as
    // rescheduled so the change is still visible.
    return { ok: true, value: [{ ...current, status: "rescheduled" }] };
  }
  events.push(current);
  return { ok: true, value: events };
}

export function createCalcomAdapter(_deps: IntegrationAdapterDeps): IntegrationAdapter {
  return {
    meta: calcomMeta,
    // Nothing to call: the connection is our webhook secret only.
    async verify() {
      return { ok: true, value: { accountLabel: CALCOM_ACCOUNT_LABEL, externalAccountId: null } };
    },
    booking: {
      linkHosts: ["cal.com", "app.cal.com"],
      parseWebhook: parseCalcomWebhook,
    },
  };
}
