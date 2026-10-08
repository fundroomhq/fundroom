import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CALCOM_ACCOUNT_LABEL,
  calcomMeta,
  createCalcomAdapter,
  parseCalcomWebhook,
} from "./index.js";

const NOW = new Date("2026-09-26T12:00:00Z");
const SECRET = "whsec-ours-0123456789";

/** Shape per Cal.com's webhook docs (envelope `{triggerEvent, createdAt, payload}`), trimmed. */
function envelope(triggerEvent: string, overrides: Record<string, unknown> = {}) {
  return {
    triggerEvent,
    createdAt: "2026-09-26T11:59:00.000Z",
    payload: {
      type: "investor-intro",
      title: "Investor intro between Founder Fran and Ina Investor",
      eventTitle: "Investor intro",
      startTime: "2026-10-01T09:00:00Z",
      endTime: "2026-10-01T09:30:00Z",
      organizer: { name: "Founder Fran", email: "fran@startup.example", timeZone: "Europe/Oslo" },
      attendees: [
        {
          name: "Ina Investor",
          email: "investor@example.com",
          timeZone: "Europe/Oslo",
          language: { locale: "en" },
        },
        { name: "Second", email: "second@example.com" },
      ],
      uid: "bk_new_uid",
      bookingId: 42,
      status: "ACCEPTED",
      ...overrides,
    },
  };
}

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

function parse(body: string, headers: Record<string, string>, secret = SECRET) {
  return parseCalcomWebhook({ headers, rawBody: new TextEncoder().encode(body), secret, now: NOW });
}

function run(payload: unknown) {
  const b = JSON.stringify(payload);
  return parse(b, { "x-cal-signature-256": sign(b) });
}

describe("calcomMeta / adapter", () => {
  it("is a connection-less booking provider", async () => {
    expect(calcomMeta.provider).toBe("calcom");
    expect(calcomMeta.auth).toBe("secret");
    expect(calcomMeta.credentialFields).toEqual([]);
    expect(calcomMeta.capabilities).toEqual(["booking"]);
    let called = false;
    const a = createCalcomAdapter({
      fetch: async () => {
        called = true;
        return new Response();
      },
      now: () => NOW,
    });
    expect(a.meta).toBe(calcomMeta);
    expect(a.booking?.linkHosts).toEqual(["cal.com", "app.cal.com"]);
    expect(a.booking?.subscribe).toBeUndefined();
    expect(a.booking?.unsubscribe).toBeUndefined();
    expect(
      await a.verify({ accessToken: "", externalAccountId: null, environment: "production" }),
    ).toEqual({ ok: true, value: { accountLabel: CALCOM_ACCOUNT_LABEL, externalAccountId: null } });
    expect(called).toBe(false);
  });
});

describe("parseWebhook signature", () => {
  const body = JSON.stringify(envelope("BOOKING_CREATED"));

  it("accepts a valid signature and maps BOOKING_CREATED → booked", () => {
    expect(parse(body, { "X-Cal-Signature-256": sign(body) })).toEqual({
      ok: true,
      value: [
        {
          externalId: "bk_new_uid",
          status: "booked",
          startsAt: new Date("2026-10-01T09:00:00Z"),
          endsAt: new Date("2026-10-01T09:30:00Z"),
          inviteeEmail: "investor@example.com",
          inviteeName: "Ina Investor",
          eventName: "Investor intro",
        },
      ],
    });
  });

  it("accepts upper-case hex and a sha256= prefix", () => {
    expect(parse(body, { "x-cal-signature-256": sign(body).toUpperCase() }).ok).toBe(true);
    expect(parse(body, { "x-cal-signature-256": `sha256=${sign(body)}` }).ok).toBe(true);
  });

  it("verifies over the exact raw bytes (non-ASCII body)", () => {
    const b = JSON.stringify(envelope("BOOKING_CREATED", { eventTitle: "Møte ☕" }));
    expect(parse(b, { "x-cal-signature-256": sign(b) })).toMatchObject({
      ok: true,
      value: [{ eventName: "Møte ☕" }],
    });
  });

  it.each([
    [
      "tampered body",
      () => parse(body.replace("Ina", "Eve"), { "x-cal-signature-256": sign(body) }),
    ],
    ["wrong key", () => parse(body, { "x-cal-signature-256": sign(body, "other") })],
    ["empty configured secret", () => parse(body, { "x-cal-signature-256": sign(body, "") }, "")],
    ["missing header", () => parse(body, {})],
    ["empty header", () => parse(body, { "x-cal-signature-256": "" })],
    ["short digest", () => parse(body, { "x-cal-signature-256": "abcd" })],
    ["non-hex digest", () => parse(body, { "x-cal-signature-256": "z".repeat(64) })],
    [
      "base64 digest",
      () =>
        parse(body, {
          "x-cal-signature-256": createHmac("sha256", SECRET).update(body).digest("base64"),
        }),
    ],
    ["other header name", () => parse(body, { "x-cal-signature": sign(body) })],
  ])("refuses %s as unauthorized", (_n, go) => {
    expect(go()).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("never parses an unverified body", () => {
    expect(parse("not json", { "x-cal-signature-256": "0".repeat(64) })).toMatchObject({
      reason: "unauthorized",
    });
  });
});

describe("parseWebhook payload mapping", () => {
  it("maps BOOKING_CANCELLED → cancelled", () => {
    expect(
      run(envelope("BOOKING_CANCELLED", { cancellationReason: "busy", status: "CANCELLED" })),
    ).toMatchObject({
      ok: true,
      value: [{ externalId: "bk_new_uid", status: "cancelled" }],
    });
  });

  it("maps BOOKING_RESCHEDULED to the original (rescheduled) and the new booking (booked)", () => {
    const res = run(
      envelope("BOOKING_RESCHEDULED", {
        rescheduleUid: "bk_old_uid",
        rescheduleId: 41,
        rescheduleStartTime: "2026-09-30T09:00:00Z",
        rescheduleEndTime: "2026-09-30T09:30:00Z",
      }),
    );
    expect(res).toMatchObject({
      ok: true,
      value: [
        {
          externalId: "bk_old_uid",
          status: "rescheduled",
          startsAt: new Date("2026-09-30T09:00:00Z"),
          endsAt: new Date("2026-09-30T09:30:00Z"),
        },
        { externalId: "bk_new_uid", status: "booked", startsAt: new Date("2026-10-01T09:00:00Z") },
      ],
    });
  });

  it("falls back to one rescheduled event when the original is not described", () => {
    expect(run(envelope("BOOKING_RESCHEDULED"))).toMatchObject({
      ok: true,
      value: [{ externalId: "bk_new_uid", status: "rescheduled" }],
    });
    expect(run(envelope("BOOKING_RESCHEDULED", { rescheduleUid: "bk_old" }))).toMatchObject({
      ok: true,
      value: [{ externalId: "bk_new_uid", status: "rescheduled" }],
    });
  });

  it("ignores other triggers (PING, MEETING_ENDED, …) after verification", () => {
    expect(run({ triggerEvent: "PING", createdAt: "x", payload: {} })).toEqual({
      ok: true,
      value: [],
    });
    expect(run({ triggerEvent: "MEETING_ENDED", uid: "x" })).toEqual({ ok: true, value: [] });
    expect(run({ triggerEvent: "BOOKING_REQUESTED", payload: {} })).toEqual({
      ok: true,
      value: [],
    });
    expect(run({})).toEqual({ ok: true, value: [] });
  });

  it("falls back to title then type for the event name", () => {
    expect(run(envelope("BOOKING_CREATED", { eventTitle: undefined }))).toMatchObject({
      value: [{ eventName: "Investor intro between Founder Fran and Ina Investor" }],
    });
    expect(
      run(envelope("BOOKING_CREATED", { eventTitle: undefined, title: undefined })),
    ).toMatchObject({
      value: [{ eventName: "investor-intro" }],
    });
  });

  it("tolerates a missing end time and attendee name; trims long names", () => {
    expect(
      run(envelope("BOOKING_CREATED", { endTime: undefined, attendees: [{ email: "a@b.co" }] })),
    ).toMatchObject({ value: [{ endsAt: null, inviteeName: null, inviteeEmail: "a@b.co" }] });
    const res = run(
      envelope("BOOKING_CREATED", { attendees: [{ email: "a@b.co", name: "n".repeat(300) }] }),
    );
    expect(res.ok && res.value[0]?.inviteeName?.length).toBe(200);
  });

  it.each([
    ["no uid", { uid: undefined }],
    ["overlong uid", { uid: "u".repeat(301) }],
    ["no attendees", { attendees: [] }],
    ["bad email", { attendees: [{ email: "nope" }] }],
    ["bad start", { startTime: "soon" }],
  ])("refuses %s as malformed", (_n, overrides) => {
    expect(run(envelope("BOOKING_CREATED", overrides))).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses a verified non-JSON body and a missing payload as malformed", () => {
    expect(parse("oops", { "x-cal-signature-256": sign("oops") })).toMatchObject({
      reason: "malformed",
    });
    expect(run({ triggerEvent: "BOOKING_CREATED" })).toMatchObject({ reason: "malformed" });
    expect(run([1, 2])).toMatchObject({ reason: "malformed" });
  });
});
