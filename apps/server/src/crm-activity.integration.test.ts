import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { checkRlsCatalog, createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import type { EventPayload } from "@fundroom/domain";
import type { EventHandler } from "@fundroom/events";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { crmDsar } from "@fundroom/module-crm";
import {
  type IntegrationBookingView,
  type IntegrationServices,
  ModuleEnablementRepo,
} from "@fundroom/module-kit";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * E3.6 CRM contact activity, end to end against a fake `ModuleServices.integrations.booking`
 * (the kernel's booking webhook and register are Agent A's and have their own suite):
 *
 *  - `integration.booking_recorded` → one `crm.activity` per (booking, kind): a member's booking
 *    lands on their contact (created on first sight, like a round event); anybody else's only on a
 *    contact staff already hold for that address — a stranger never becomes a contact;
 *  - redelivery, a repeated status and a second reschedule add no row; the event's status (not the
 *    booking's current one) names the activity;
 *  - nothing at all while the CRM is off, or for a booking the kernel no longer holds;
 *  - `GET /crm/contacts/{id}/activity` (crm.read): newest first; investors 404;
 *  - erasure deletes the activities (and reports them in the DSAR step), a booking event about an
 *    erased member is dropped, and — the race — a booking handled while an erasure request holds
 *    the member waits for it and then drops the event instead of re-creating the contact;
 *  - DSAR export lists the activities; `crm.activity` passes the RLS catalog check.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
const SLUG = "stark";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let wsId: string;

/** The kernel's booking register, faked: what `integrations.booking(tx, ctx, id)` answers. */
const bookings = new Map<string, IntegrationBookingView>();
const fakeIntegrations: Partial<IntegrationServices> = {
  async booking(_tx, _ctx, id) {
    return bookings.get(id);
  },
};

interface Actor {
  cookie: string;
  membershipId: string;
}

async function request(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `${SLUG}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && init.cookie)
    headers.set("origin", `http://${SLUG}.${CANON}`);
  return running.app.request(`http://${SLUG}.${CANON}${path}`, { ...init, headers });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

async function signIn(email: string): Promise<Actor> {
  const since = mailer.sent.length;
  const start = await request("/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request("/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const body = await json<{ membership: { id: string } | null }>(verify);
  return { cookie: cookiesOf(verify), membershipId: body.membership?.id ?? "" };
}

async function stepUp(cookie: string): Promise<string> {
  const enrol = await request("/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request("/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  return withSetCookies(cookie, confirm);
}

async function member(
  email: string,
  displayName: string,
  kind: "staff" | "external",
  role: "owner" | "editor" | "investor",
  signedIn = true,
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName });
  const m = await provisionMembership(deps, {
    workspaceId: wsId,
    userId: user.userId,
    kind,
    role,
    source: "test",
  });
  if (!signedIn) return { cookie: "", membershipId: m.id };
  const actor = await signIn(email);
  if (role === "owner") actor.cookie = await stepUp(actor.cookie);
  return actor;
}

async function rows<T>(query: string): Promise<T[]> {
  return running.container.db.withTenant(systemContext(wsId), async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out");
}

function crmHandler(): EventHandler {
  const sub = running.container.subscriptions
    .subscribersFor("integration.booking_recorded")
    .find((x) => x.id.startsWith("crm."));
  if (!sub) throw new Error("no crm subscriber for integration.booking_recorded");
  return sub.handler;
}

let outbox = 90_000;
const nextOutbox = (): number => {
  outbox += 1;
  return outbox;
};

/** Delivers one booking event to the CRM subscriber the way the dispatcher does. */
async function deliver(
  payload: EventPayload<"integration.booking_recorded">,
  outboxId = nextOutbox(),
  createdAt = new Date(),
): Promise<void> {
  const ctx = systemContext(wsId);
  await running.container.db.withTenant(ctx, (tx) =>
    crmHandler()(
      {
        outboxId,
        topic: "integration.booking_recorded",
        workspaceId: wsId,
        payload,
        schemaVersion: 1,
        createdAt,
      },
      {
        tx,
        ctx,
        job: {
          id: `test-${outboxId}`,
          name: "event.integration.booking_recorded",
          data: { outboxId },
          signal: new AbortController().signal,
        },
      },
    ),
  );
}

function book(
  over: Partial<IntegrationBookingView> & Pick<IntegrationBookingView, "inviteeEmail">,
): IntegrationBookingView {
  const view: IntegrationBookingView = {
    id: randomUUID(),
    provider: "calendly",
    status: "booked",
    startsAt: new Date("2026-10-05T15:00:00Z"),
    endsAt: new Date("2026-10-05T15:30:00Z"),
    inviteeName: null,
    eventName: "30 min intro",
    membershipId: null,
    ...over,
  };
  bookings.set(view.id, view);
  return view;
}

const event = (b: IntegrationBookingView, status = b.status) => ({
  bookingId: b.id,
  provider: b.provider,
  status,
});

interface Activity {
  id: string;
  contactId: string;
  kind: string;
  occurredAt: string;
  startsAt: string;
  endsAt: string | null;
  title: string | null;
  provider: string | null;
  bookingId: string | null;
}

const contactOf = async (membershipId: string) =>
  (
    await rows<{ id: string }>(
      `SELECT id::text AS id FROM crm.contact WHERE membership_id = '${membershipId}'::uuid`,
    )
  )[0]?.id;

const activitiesFor = async (contactId: string) =>
  rows<{ kind: string; startsAt: string; title: string | null }>(
    `SELECT kind, starts_at AS "startsAt", title FROM crm.activity
      WHERE contact_id = '${contactId}'::uuid ORDER BY created_at, id`,
  );

const count = async (sql: string) => Number((await rows<{ n: number }>(sql))[0]?.n ?? 0);

async function setCrm(enabled: boolean): Promise<void> {
  const ctx = systemContext(wsId);
  await running.container.db.withTenant(ctx, (tx) =>
    new ModuleEnablementRepo(ctx, tx).set("crm", enabled),
  );
  running.container.enablement.invalidate(wsId);
}

let owner: Actor;
let editor: Actor;
let ada: Actor;
let grace: Actor;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
      SPREADSHEET_DRIVER: "noop",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  // The container test seam (E3.6): the booking half of the integrations port, faked.
  Object.assign(running.container.integrations.services, fakeIntegrations);
  wsId = (await createWorkspace(running.container.db, { slug: SLUG, name: "Stark" })).id;
  owner = await member("tony@stark.test", "Tony", "staff", "owner");
  editor = await member("pepper@stark.test", "Pepper", "staff", "editor");
  ada = await member("ada@investor.test", "Ada Lovelace", "external", "investor");
  grace = await member("grace@investor.test", "Grace Hopper", "external", "investor", false);
  await setCrm(true);
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("crm.activity", () => {
  it("passes the RLS catalog check and admits no external actor", async () => {
    expect(await checkRlsCatalog(running.container.db.pool)).toEqual([]);
    const seen = await running.container.db.withTenant(
      { workspaceId: wsId, actorKind: "external", membershipId: ada.membershipId },
      async (tx) => (await tx.execute("SELECT 1 FROM crm.activity")).rows,
    );
    expect(seen).toEqual([]);
  });
});

describe("integration.booking_recorded → contact activity", () => {
  let adaContact: string;
  let adaBooking: IntegrationBookingView;

  it("a member's booking creates their contact (audited as a booking) and a meeting_booked row", async () => {
    adaBooking = book({ inviteeEmail: "ADA@investor.test", membershipId: ada.membershipId });
    await deliver(event(adaBooking));
    adaContact = (await contactOf(ada.membershipId)) ?? "";
    expect(adaContact).not.toBe("");
    expect(await activitiesFor(adaContact)).toEqual([
      { kind: "meeting_booked", startsAt: expect.any(String), title: "30 min intro" },
    ]);
    const [audit] = await rows<{ meta: Record<string, unknown> }>(
      `SELECT meta FROM audit.event WHERE action = 'crm.contact_created'
         AND resource_id = '${adaContact}'::uuid`,
    );
    expect(audit?.meta).toMatchObject({ linked: true, cause: "booking" });
    expect(JSON.stringify(audit?.meta)).not.toMatch(/ada|@/iu);
  });

  it("is idempotent per (booking, kind), and the event's status names the row", async () => {
    // A redelivery, and the vendor repeating itself under a new outbox id.
    await deliver(event(adaBooking));
    await deliver(event(adaBooking));
    expect(await activitiesFor(adaContact)).toHaveLength(1);
    // Rescheduled twice: one row, carrying the latest times.
    adaBooking = {
      ...adaBooking,
      status: "rescheduled",
      startsAt: new Date("2026-10-06T09:00:00Z"),
    };
    bookings.set(adaBooking.id, adaBooking);
    await deliver(event(adaBooking));
    adaBooking = { ...adaBooking, startsAt: new Date("2026-10-07T09:00:00Z") };
    bookings.set(adaBooking.id, adaBooking);
    await deliver(event(adaBooking));
    // Cancelled — and a late `booked` redelivery read against the now-cancelled booking still
    // records nothing new: the event says "booked", and that row exists.
    adaBooking = { ...adaBooking, status: "cancelled" };
    bookings.set(adaBooking.id, adaBooking);
    await deliver(event(adaBooking));
    await deliver(event(adaBooking, "booked"));
    const kinds = await activitiesFor(adaContact);
    expect(kinds.map((k) => k.kind)).toEqual([
      "meeting_booked",
      "meeting_rescheduled",
      "meeting_cancelled",
    ]);
    const moved = kinds.find((k) => k.kind === "meeting_rescheduled");
    expect(new Date(moved?.startsAt ?? "").toISOString()).toBe("2026-10-07T09:00:00.000Z");
  });

  it("never creates a contact for a stranger", async () => {
    const before = await count("SELECT count(*)::int AS n FROM crm.contact");
    const stranger = book({ inviteeEmail: "who@else.test", inviteeName: "Mallory" });
    await deliver(event(stranger));
    expect(await count("SELECT count(*)::int AS n FROM crm.contact")).toBe(before);
    expect(
      await count(
        `SELECT count(*)::int AS n FROM crm.activity WHERE booking_id = '${stranger.id}'::uuid`,
      ),
    ).toBe(0);
    expect(
      await count("SELECT count(*)::int AS n FROM crm.contact WHERE display_name = 'Mallory'"),
    ).toBe(0);
  });

  it("lands a non-member's booking on the contact staff already hold for that address", async () => {
    const res = await request("/api/v1/crm/contacts", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ displayName: "Linus (conference)", email: "linus@kernel.test" }),
    });
    expect(res.status).toBe(201);
    const linus = (await json<{ id: string }>(res)).id;
    const b = book({ inviteeEmail: "Linus@Kernel.TEST", provider: "calcom", eventName: null });
    await deliver(event(b));
    expect(await activitiesFor(linus)).toEqual([
      { kind: "meeting_booked", startsAt: expect.any(String), title: null },
    ]);
  });

  it("does nothing while the CRM is off, and nothing for a booking the kernel no longer holds", async () => {
    await setCrm(false);
    try {
      const b = book({ inviteeEmail: "grace@investor.test", membershipId: grace.membershipId });
      await deliver(event(b));
      expect(await contactOf(grace.membershipId)).toBeUndefined();
      expect(
        await count(
          `SELECT count(*)::int AS n FROM crm.activity WHERE booking_id = '${b.id}'::uuid`,
        ),
      ).toBe(0);
    } finally {
      await setCrm(true);
    }
    await deliver({ bookingId: randomUUID(), provider: "calendly", status: "booked" });
    expect(await contactOf(grace.membershipId)).toBeUndefined();
  });

  it("GET /crm/contacts/{id}/activity lists newest first for crm.read; investors get 404", async () => {
    const res = await request(`/api/v1/crm/contacts/${adaContact}/activity`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    const { activities } = await json<{ activities: Activity[] }>(res);
    expect(activities.map((a) => a.kind)).toEqual([
      "meeting_cancelled",
      "meeting_rescheduled",
      "meeting_booked",
    ]);
    expect(activities[0]).toMatchObject({
      contactId: adaContact,
      provider: "calendly",
      bookingId: adaBooking.id,
      title: "30 min intro",
    });
    expect(JSON.stringify(activities)).not.toContain("@");
    expect(
      (await request(`/api/v1/crm/contacts/${randomUUID()}/activity`, { cookie: owner.cookie }))
        .status,
    ).toBe(404);
    expect(
      (await request(`/api/v1/crm/contacts/${adaContact}/activity`, { cookie: ada.cookie })).status,
    ).toBe(404);
  });

  it("the member's DSAR export lists the activities", async () => {
    const ctx = systemContext(wsId);
    const exported = await running.container.db.withTenant(ctx, (tx) =>
      crmDsar.export({ tx, ctx, membershipId: ada.membershipId } as never),
    );
    const acts = (exported as { activities?: { kind: string; title: string | null }[] }).activities;
    expect(acts?.map((a) => a.kind).sort()).toEqual([
      "meeting_booked",
      "meeting_cancelled",
      "meeting_rescheduled",
    ]);
  });
});

describe("erasure", () => {
  it("deletes the member's activities and reports them in the crm DSAR step", async () => {
    const adaContact = (await contactOf(ada.membershipId)) ?? "";
    expect((await activitiesFor(adaContact)).length).toBe(3);
    const created = await request("/api/v1/compliance/erasure-requests", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ membershipId: ada.membershipId }),
    });
    expect(created.status).toBe(201);
    const { id } = await json<{ id: string }>(created);
    const step = await waitFor(
      async () =>
        (
          await rows<{ counts: Record<string, number> }>(
            `SELECT counts FROM core.dsar_step WHERE request_id = '${id}'::uuid AND module = 'crm'`,
          )
        )[0],
    );
    expect(step.counts).toMatchObject({ contacts: 1, activities: 3 });
    expect(await activitiesFor(adaContact)).toEqual([]);
  });

  it("drops a booking about an erased member instead of re-creating the contact", async () => {
    const b = book({ inviteeEmail: "ada@investor.test", membershipId: ada.membershipId });
    await deliver(event(b));
    expect(await contactOf(ada.membershipId)).toBeUndefined();
    expect(
      await count(`SELECT count(*)::int AS n FROM crm.activity WHERE booking_id = '${b.id}'::uuid`),
    ).toBe(0);
  });

  /*
   * The race. An erasure request locks the member's row before it is written
   * (`prelockErasureSubject`); here a transaction stands in for it — lock, insert the request,
   * hold — while a booking for the same member is handled. The handler must wait on the member's
   * row and then see the request (drop), not slip through before the request commits and create a
   * contact that the erasure step (which runs later and finds nothing) would never remove.
   */
  it("a booking handled while an erasure request holds the member waits, then drops the event", async () => {
    const b = book({ inviteeEmail: "grace@investor.test", membershipId: grace.membershipId });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const holding = new Promise<void>((r) => {
      locked = r;
    });
    const eraser = running.container.db.withTenant(systemContext(wsId), async (tx) => {
      await tx.execute(
        `SELECT id FROM core.membership WHERE id = '${grace.membershipId}'::uuid FOR NO KEY UPDATE`,
      );
      await tx.execute(
        `INSERT INTO core.dsar_request (workspace_id, membership_id, due_at)
         VALUES ('${wsId}'::uuid, '${grace.membershipId}'::uuid, now() + interval '30 days')`,
      );
      locked();
      await gate;
    });
    await holding;
    let settled = false;
    const handled = deliver(event(b)).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 750));
    expect(settled).toBe(false);
    release();
    await eraser;
    await handled;
    expect(await contactOf(grace.membershipId)).toBeUndefined();
    expect(
      await count(`SELECT count(*)::int AS n FROM crm.activity WHERE booking_id = '${b.id}'::uuid`),
    ).toBe(0);
  });
});
