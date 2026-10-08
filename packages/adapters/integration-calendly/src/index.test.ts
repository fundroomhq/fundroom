import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { calendlyMeta, createCalendlyAdapter, parseCalendlyWebhook } from "./index.js";

const NOW = new Date("2026-09-26T12:00:00Z");
const T = Math.floor(NOW.getTime() / 1000);
const KEY = "our-signing-key-0123456789";
const AUTH = {
  accessToken: "pat-secret",
  externalAccountId: null,
  environment: "production" as const,
};
const USER_URI = "https://api.calendly.com/users/AAAA";
const ORG_URI = "https://api.calendly.com/organizations/BBBB";

/** Shape per Calendly's OpenAPI `WebhookPayload` / `InviteePayload` (trimmed). */
function inviteePayload(event: string, overrides: Record<string, unknown> = {}) {
  return {
    event,
    created_at: "2026-09-26T11:59:00.000000Z",
    created_by: USER_URI,
    payload: {
      uri: "https://api.calendly.com/scheduled_events/EV1/invitees/INV1",
      email: "investor@example.com",
      first_name: null,
      last_name: null,
      name: "Ina Investor",
      status: event === "invitee.created" ? "active" : "canceled",
      timezone: "Europe/Oslo",
      event: "https://api.calendly.com/scheduled_events/EV1",
      rescheduled: false,
      old_invitee: null,
      new_invitee: null,
      scheduled_event: {
        uri: "https://api.calendly.com/scheduled_events/EV1",
        name: "Investor intro",
        status: "active",
        start_time: "2026-10-01T09:00:00.000000Z",
        end_time: "2026-10-01T09:30:00.000000Z",
      },
      ...overrides,
    },
  };
}

function sign(body: string, t: number | string = T, key = KEY): string {
  return `t=${t},v1=${createHmac("sha256", key).update(`${t}.${body}`).digest("hex")}`;
}

function parse(body: string, headers: Record<string, string>, now = NOW, secret = KEY) {
  return parseCalendlyWebhook({ headers, rawBody: new TextEncoder().encode(body), secret, now });
}

describe("calendlyMeta", () => {
  it("is a secret-auth booking provider with one PAT field", () => {
    expect(calendlyMeta.provider).toBe("calendly");
    expect(calendlyMeta.auth).toBe("secret");
    expect(calendlyMeta.capabilities).toEqual(["booking"]);
    expect(calendlyMeta.credentialFields?.map((f) => [f.key, f.kind, f.required])).toEqual([
      ["personalAccessToken", "secret", true],
    ]);
    expect(calendlyMeta.oauth).toBeUndefined();
    const a = createCalendlyAdapter({ fetch: async () => new Response(), now: () => NOW });
    expect(a.meta).toBe(calendlyMeta);
    expect(a.booking?.linkHosts).toEqual(["calendly.com"]);
  });
});

describe("parseWebhook signature", () => {
  const body = JSON.stringify(inviteePayload("invitee.created"));

  it("accepts a valid signature and maps invitee.created → booked", () => {
    expect(parse(body, { "Calendly-Webhook-Signature": sign(body) })).toEqual({
      ok: true,
      value: [
        {
          externalId: "https://api.calendly.com/scheduled_events/EV1/invitees/INV1",
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

  it("reads the header case-insensitively", () => {
    expect(parse(body, { "calendly-webhook-signature": sign(body) }).ok).toBe(true);
  });

  it("verifies over the exact raw bytes (non-ASCII body)", () => {
    const b = JSON.stringify(inviteePayload("invitee.created", { name: "Åse Ørnes 🚀" }));
    const res = parse(b, { "calendly-webhook-signature": sign(b) });
    expect(res).toMatchObject({ ok: true, value: [{ inviteeName: "Åse Ørnes 🚀" }] });
  });

  it.each([
    [
      "tampered body",
      () => parse(body.replace("Ina", "Eve"), { "calendly-webhook-signature": sign(body) }),
    ],
    ["wrong key", () => parse(body, { "calendly-webhook-signature": sign(body, T, "other-key") })],
    [
      "empty configured key",
      () => parse(body, { "calendly-webhook-signature": sign(body, T, "") }, NOW, ""),
    ],
    ["stale timestamp", () => parse(body, { "calendly-webhook-signature": sign(body, T - 301) })],
    ["future timestamp", () => parse(body, { "calendly-webhook-signature": sign(body, T + 301) })],
    ["missing header", () => parse(body, {})],
    ["empty header", () => parse(body, { "calendly-webhook-signature": "" })],
    ["no v1", () => parse(body, { "calendly-webhook-signature": `t=${T}` })],
    [
      "no t",
      () => parse(body, { "calendly-webhook-signature": sign(body).replace(/^t=\d+,/u, "") }),
    ],
    ["non-numeric t", () => parse(body, { "calendly-webhook-signature": sign(body, "12a") })],
    ["duplicate t", () => parse(body, { "calendly-webhook-signature": `t=${T},${sign(body)}` })],
    ["short digest", () => parse(body, { "calendly-webhook-signature": `t=${T},v1=abcd` })],
    [
      "non-hex digest",
      () => parse(body, { "calendly-webhook-signature": `t=${T},v1=${"z".repeat(64)}` }),
    ],
    ["garbage", () => parse(body, { "calendly-webhook-signature": "sha256=deadbeef" })],
    [
      "oversized header",
      () => parse(body, { "calendly-webhook-signature": `${sign(body)},x=${"a".repeat(2000)}` }),
    ],
  ])("refuses %s as unauthorized", (_name, run) => {
    expect(run()).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("accepts timestamps inside the 5-minute window on both sides", () => {
    expect(parse(body, { "calendly-webhook-signature": sign(body, T - 299) }).ok).toBe(true);
    expect(parse(body, { "calendly-webhook-signature": sign(body, T + 299) }).ok).toBe(true);
  });

  it("checks the signature before the timestamp (a stale forged request says mismatch)", () => {
    expect(
      parse(body, { "calendly-webhook-signature": sign(body, T - 10_000, "other") }),
    ).toMatchObject({
      detail: "signature mismatch",
    });
  });

  it("accepts when any of several v1 entries matches and ignores unknown schemes", () => {
    const good = sign(body).split(",")[1];
    const header = `t=${T},v0=whatever,v1=${"0".repeat(64)},${good}`;
    expect(parse(body, { "calendly-webhook-signature": header }).ok).toBe(true);
  });

  it("never parses an unverified body", () => {
    expect(
      parse("not json", { "calendly-webhook-signature": `t=${T},v1=${"0".repeat(64)}` }),
    ).toMatchObject({
      reason: "unauthorized",
    });
  });
});

describe("parseWebhook payload mapping", () => {
  const run = (payload: unknown) => {
    const b = JSON.stringify(payload);
    return parse(b, { "calendly-webhook-signature": sign(b) });
  };

  it("maps invitee.canceled → cancelled", () => {
    expect(run(inviteePayload("invitee.canceled"))).toMatchObject({
      ok: true,
      value: [{ status: "cancelled" }],
    });
  });

  it("maps a rescheduled cancel → rescheduled", () => {
    expect(
      run(
        inviteePayload("invitee.canceled", {
          rescheduled: true,
          new_invitee: "https://api.calendly.com/x",
        }),
      ),
    ).toMatchObject({ ok: true, value: [{ status: "rescheduled" }] });
  });

  it("ignores other events after verification", () => {
    expect(run({ event: "invitee_no_show.created", payload: {} })).toEqual({ ok: true, value: [] });
    expect(run({ event: "routing_form_submission.created", payload: {} })).toEqual({
      ok: true,
      value: [],
    });
  });

  it("tolerates a missing end time and names", () => {
    const p = inviteePayload("invitee.created", { name: "" });
    (p.payload.scheduled_event as Record<string, unknown>)["end_time"] = undefined;
    (p.payload.scheduled_event as Record<string, unknown>)["name"] = undefined;
    expect(run(p)).toMatchObject({
      ok: true,
      value: [{ endsAt: null, inviteeName: null, eventName: null }],
    });
  });

  it("trims long names to 200 characters", () => {
    const res = run(inviteePayload("invitee.created", { name: "n".repeat(500) }));
    expect(res.ok && res.value[0]?.inviteeName?.length).toBe(200);
  });

  it.each([
    ["no uri", { uri: undefined }],
    ["overlong uri", { uri: `https://api.calendly.com/${"x".repeat(300)}` }],
    ["bad email", { email: "not-an-email" }],
    ["no scheduled_event", { scheduled_event: undefined }],
    ["bad start", { scheduled_event: { start_time: "yesterday" } }],
  ])("refuses %s as malformed", (_n, overrides) => {
    expect(run(inviteePayload("invitee.created", overrides))).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses a verified non-JSON body as malformed", () => {
    const b = "not json";
    expect(parse(b, { "calendly-webhook-signature": sign(b) })).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("refuses a missing payload as malformed", () => {
    expect(run({ event: "invitee.created" })).toMatchObject({ ok: false, reason: "malformed" });
  });
});

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  redirect: RequestInit["redirect"];
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function adapter(replies: (Response | Error)[], options = {}) {
  const seen: Seen[] = [];
  const logs: string[] = [];
  const a = createCalendlyAdapter(
    {
      fetch: async (input, init) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((v, k) => {
          headers[k] = v;
        });
        seen.push({
          url: String(input),
          method: init?.method ?? "GET",
          headers,
          body: typeof init?.body === "string" ? init.body : "",
          redirect: init?.redirect,
        });
        const next = replies.shift();
        if (next === undefined) throw new Error("unexpected call");
        if (next instanceof Error) throw next;
        return next;
      },
      now: () => NOW,
      log: (e) => void logs.push(e),
    },
    options,
  );
  return { a, seen, logs };
}

const ME = {
  resource: {
    uri: USER_URI,
    name: "Founder Fran",
    email: "fran@startup.example",
    current_organization: ORG_URI,
  },
};

describe("verify", () => {
  it("calls GET /users/me with the PAT: name as label, user uri as account", async () => {
    const { a, seen } = adapter([json(ME)]);
    expect(await a.verify(AUTH)).toEqual({
      ok: true,
      value: { accountLabel: "Founder Fran", externalAccountId: USER_URI },
    });
    expect(seen[0]).toMatchObject({
      url: "https://api.calendly.com/users/me",
      method: "GET",
      redirect: "manual",
    });
    expect(seen[0]?.headers["authorization"]).toBe("Bearer pat-secret");
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "unavailable"],
  ])("maps HTTP %i → %s", async (status, reason) => {
    const { a } = adapter([
      json({ title: "Unauthenticated", message: "The access token is invalid" }, status),
    ]);
    const res = await a.verify(AUTH);
    expect(res).toMatchObject({ ok: false, reason });
    expect(JSON.stringify(res)).not.toContain("pat-secret");
  });

  it("refuses an answer without a user uri", async () => {
    const { a } = adapter([json({ resource: { name: "x" } })]);
    expect(await a.verify(AUTH)).toMatchObject({ ok: false, reason: "malformed" });
  });

  it("honours the apiBaseUrl test seam", async () => {
    const { a, seen } = adapter([json(ME)], { apiBaseUrl: "http://calendly.test/" });
    await a.verify(AUTH);
    expect(seen[0]?.url).toBe("http://calendly.test/users/me");
  });
});

describe("subscribe / unsubscribe", () => {
  const input = { callbackUrl: "https://seed.example/webhooks/integrations/c1", signingKey: KEY };

  it("creates a user-scoped subscription with our signing key", async () => {
    const subUri =
      "https://api.calendly.com/webhook_subscriptions/0f6a0d2c-1111-2222-3333-444455556666";
    const { a, seen } = adapter([
      json(ME),
      json({ resource: { uri: subUri, state: "active" } }, 201),
    ]);
    expect(await a.booking?.subscribe?.(AUTH, input)).toEqual({
      ok: true,
      value: { subscriptionId: subUri },
    });
    expect(seen[1]?.url).toBe("https://api.calendly.com/webhook_subscriptions");
    expect(seen[1]?.method).toBe("POST");
    expect(JSON.parse(seen[1]?.body ?? "")).toEqual({
      url: input.callbackUrl,
      events: ["invitee.created", "invitee.canceled"],
      organization: ORG_URI,
      user: USER_URI,
      scope: "user",
      signing_key: KEY,
    });
  });

  it("explains a 403 (plan or scope) and maps 409", async () => {
    const f = adapter([json(ME), json({ title: "Permission Denied" }, 403)]);
    expect(await f.a.booking?.subscribe?.(AUTH, input)).toMatchObject({
      ok: false,
      reason: "forbidden",
    });
    const c = adapter([json(ME), json({ title: "Already Exists" }, 409)]);
    expect(await c.a.booking?.subscribe?.(AUTH, input)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });

  it("fails when users/me fails or has no organization", async () => {
    expect(await adapter([json({}, 401)]).a.booking?.subscribe?.(AUTH, input)).toMatchObject({
      reason: "unauthorized",
    });
    const noOrg = { resource: { ...ME.resource, current_organization: undefined } };
    expect(await adapter([json(noOrg)]).a.booking?.subscribe?.(AUTH, input)).toMatchObject({
      reason: "malformed",
    });
  });

  it("refuses a created answer without a uri", async () => {
    expect(
      await adapter([json(ME), json({ resource: {} }, 201)]).a.booking?.subscribe?.(AUTH, input),
    ).toMatchObject({
      reason: "malformed",
    });
  });

  it("lists our subscriptions for a callback URL across pages (fix round 2)", async () => {
    const mine = (id: string, url: string) => ({
      uri: `https://api.calendly.com/webhook_subscriptions/${id}`,
      callback_url: url,
    });
    const { a, seen } = adapter([
      json(ME),
      json({
        collection: [mine("s1", input.callbackUrl), mine("s2", "https://other.example/x")],
        pagination: { next_page_token: "p2" },
      }),
      json({ collection: [mine("s3", input.callbackUrl)], pagination: { next_page_token: null } }),
    ]);
    expect(await a.booking?.listSubscriptions?.(AUTH, input.callbackUrl)).toEqual({
      ok: true,
      value: [
        "https://api.calendly.com/webhook_subscriptions/s1",
        "https://api.calendly.com/webhook_subscriptions/s3",
      ],
    });
    const first = new URL(seen[1]?.url ?? "");
    expect(first.pathname).toBe("/webhook_subscriptions");
    expect(Object.fromEntries(first.searchParams)).toEqual({
      organization: ORG_URI,
      user: USER_URI,
      scope: "user",
      count: "100",
    });
    expect(new URL(seen[2]?.url ?? "").searchParams.get("page_token")).toBe("p2");
    expect(
      await adapter([json({}, 401)]).a.booking?.listSubscriptions?.(AUTH, input.callbackUrl),
    ).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  it("deletes by uuid on our own API base, whatever host the stored uri names", async () => {
    const { a, seen } = adapter([new Response(null, { status: 204 })]);
    await a.booking?.unsubscribe?.(
      AUTH,
      "https://evil.example/webhook_subscriptions/0f6a0d2c-1111",
    );
    expect(seen[0]).toMatchObject({
      url: "https://api.calendly.com/webhook_subscriptions/0f6a0d2c-1111",
      method: "DELETE",
    });
  });

  it("is best effort: ignores 404, logs other failures, never throws, skips junk ids", async () => {
    const gone = adapter([json({}, 404)]);
    await gone.a.booking?.unsubscribe?.(AUTH, "0f6a0d2c-1111");
    expect(gone.logs).toEqual([]);
    const down = adapter([json({}, 503)]);
    await down.a.booking?.unsubscribe?.(AUTH, "0f6a0d2c-1111");
    expect(down.logs).toEqual(["integration.calendly.unsubscribe_failed"]);
    const boom = adapter([new Error("x")]);
    await expect(boom.a.booking?.unsubscribe?.(AUTH, "0f6a0d2c-1111")).resolves.toBeUndefined();
    const junk = adapter([]);
    await junk.a.booking?.unsubscribe?.(AUTH, "../users/me?x");
    expect(junk.seen).toHaveLength(0);
  });
});
