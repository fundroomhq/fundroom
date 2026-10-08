import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import type { EventPayload, EventTopic } from "@fundroom/domain";
import { type EventHandler, publish } from "@fundroom/events";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { ChatMessage, ChatWebhookPort } from "@fundroom/ports";
import * as OTPAuth from "otpauth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Data-room Q&A notifications (E3.3, ADR-0051), end to end through the outbox: the five `qa.*`
 * events published inside a tenant transaction (never through the Q&A routes, so this file does
 * not depend on them) → notify's handlers → the right recipients and nobody else → instant mail
 * (the investor's with the portal link) → the generic channel post. Also: preferences respected,
 * an erased asker's release dropped, redeliveries (same outbox id) collapsing, due phases as
 * distinct rows, and re-armed reminders / re-releases (new outbox events) alerting again.
 *
 * One pooled connection: a handler that took a second connection while holding the dispatcher's
 * transaction would hang here instead of passing.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const posts: { url: string; message: ChatMessage }[] = [];
const fakeChat: ChatWebhookPort = {
  driver: "fake",
  validateUrl: (url) =>
    url.startsWith("https://hooks.slack.com/services/")
      ? { ok: true }
      : { ok: false, reason: "not a slack webhook" },
  async post(url, message) {
    posts.push({ url, message });
    return { ok: true };
  },
};

interface Actor {
  cookie: string;
  membershipId: string;
}

async function request(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `acme.${CANON}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET" && init.cookie)
    headers.set("origin", `http://acme.${CANON}`);
  return running.app.request(`http://acme.${CANON}${path}`, { ...init, headers });
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
  const body = (await verify.json()) as { membership: { id: string } | null };
  const cookie = verify.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
  return { cookie, membershipId: body.membership?.id ?? "" };
}

async function stepUp(cookie: string): Promise<string> {
  const enrol = await request("/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = (await enrol.json()) as { secretBase32: string };
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request("/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  return withSetCookies(cookie, confirm);
}

type Role = "owner" | "admin" | "editor" | "viewer" | "legal" | "finance" | "investor";

async function provision(email: string, role: Role): Promise<string> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  const m = await provisionMembership(deps, {
    workspaceId: acmeId,
    userId: user.userId,
    kind: role === "investor" ? "external" : "staff",
    role,
    source: "test",
  });
  return m.id;
}

async function waitFor<T>(fn: () => Promise<T | undefined>, ms = 30_000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = await fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("timed out");
}

async function rows<T>(query: string): Promise<T[]> {
  return running.container.db.withTenant(systemContext(acmeId), async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

async function publishOutbox<T extends EventTopic>(topic: T, payload: EventPayload<T>) {
  const ctx = systemContext(acmeId);
  return running.container.db.withTenant(ctx, (tx) => publish(tx, ctx, topic, payload));
}

function handlerFor(topic: EventTopic): EventHandler {
  const sub = running.container.subscriptions
    .subscribersFor(topic)
    .find((x) => x.id.startsWith("notify."));
  if (!sub) throw new Error(`no notify subscriber for ${topic}`);
  return sub.handler;
}

/**
 * Hands one event straight to notify's subscriber the way the dispatcher does. Used for a
 * redelivery (same outbox id) and for payload fields the catalogue may not carry yet.
 */
async function deliver<T extends EventTopic>(topic: T, payload: unknown, outboxId: number) {
  const ctx = systemContext(acmeId);
  await running.container.db.withTenant(ctx, (tx) =>
    handlerFor(topic)(
      {
        outboxId,
        topic,
        workspaceId: acmeId,
        payload: payload as EventPayload<T>,
        schemaVersion: 1,
        createdAt: new Date(),
      },
      {
        tx,
        ctx,
        job: {
          id: `test-${outboxId}`,
          name: `event.${topic}`,
          data: { outboxId },
          signal: new AbortController().signal,
        },
      },
    ),
  );
}

interface Alert {
  membershipId: string;
  eventType: string;
  cadence: string;
  actor: string | null;
  resourceKind: string;
  resourceId: string;
  payload: Record<string, unknown>;
}

/** Every notify row about one question, as the system actor sees them. */
async function alertsAbout(questionId: string, eventType?: string): Promise<Alert[]> {
  return rows<Alert>(
    `SELECT membership_id AS "membershipId", event_type AS "eventType", cadence,
            actor_membership_id AS actor, resource_kind AS "resourceKind",
            resource_id AS "resourceId", payload
       FROM notify.notification
      WHERE resource_id = '${questionId}'::uuid
        ${eventType === undefined ? "" : `AND event_type = '${eventType}'`}
      ORDER BY created_at, membership_id`,
  );
}

const recipientsOf = (alerts: readonly Alert[]) => alerts.map((a) => a.membershipId).sort();

/** Waits until `n` rows about the question exist (and a beat more, to catch extras). */
async function settle(questionId: string, eventType: string, n: number): Promise<Alert[]> {
  await waitFor(async () => {
    const r = await alertsAbout(questionId, eventType);
    return r.length >= n ? r : undefined;
  });
  await new Promise((r) => setTimeout(r, 600));
  return alertsAbout(questionId, eventType);
}

let acmeId: string;
let owner: Actor;
let admin: Actor;
let editor: string;
let legal: string;
let viewer: string;
let ada: string;
let bea: string;

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      DATABASE_POOL_MAX: "1",
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer,
    chat: fakeChat,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  await provision("owner@acme.test", "owner");
  owner = await signIn("owner@acme.test");
  owner.cookie = await stepUp(owner.cookie);
  await provision("admin@acme.test", "admin");
  admin = await signIn("admin@acme.test");
  // Owners and admins must have MFA before any staff route answers them.
  admin.cookie = await stepUp(admin.cookie);
  editor = await provision("editor@acme.test", "editor");
  legal = await provision("legal@acme.test", "legal");
  viewer = await provision("viewer@acme.test", "viewer");
  ada = await provision("ada@investor.test", "investor");
  bea = await provision("bea@investor.test", "investor");
  // A channel announcing new questions (and, to prove the filter, nothing else).
  const channel = await request("/api/v1/notify/channels", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      name: "#dataroom",
      url: "https://hooks.slack.com/services/T0/B0/qa",
      eventTypes: ["qa.question_asked"],
    }),
  });
  expect(channel.status).toBe(201);
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("preferences", () => {
  it("lists the six Q&A types, instant by default, after the older ones", async () => {
    const res = await request("/api/v1/notify/preferences", { cookie: admin.cookie });
    const body = (await res.json()) as { preferences: { eventType: string; cadence: string }[] };
    // E3.5 appended its three types after these; the Q&A six stay contiguous.
    expect(body.preferences.filter((p) => p.eventType.startsWith("qa."))).toEqual([
      { eventType: "qa.question_asked", cadence: "instant", isDefault: true },
      { eventType: "qa.question_assigned", cadence: "instant", isDefault: true },
      { eventType: "qa.answer_submitted", cadence: "instant", isDefault: true },
      { eventType: "qa.answer_released", cadence: "instant", isDefault: true },
      { eventType: "qa.question_declined", cadence: "instant", isDefault: true },
      { eventType: "qa.question_due", cadence: "instant", isDefault: true },
    ]);
  });
});

describe("qa.question_asked", () => {
  it("reaches data-room.qa_manage holders only, mails a link and no text, posts a generic line", async () => {
    const q = randomUUID();
    await publishOutbox("qa.question_asked", {
      questionId: q,
      targetKind: "document",
      targetId: randomUUID(),
      askerMembershipId: ada,
    });
    const alerts = await settle(q, "qa.question_asked", 2);
    // owner + admin hold qa_manage; editor / legal / viewer do not; the asker is never told.
    expect(recipientsOf(alerts)).toEqual([owner.membershipId, admin.membershipId].sort());
    expect(alerts[0]).toMatchObject({
      actor: ada,
      resourceKind: "qa_question",
      cadence: "instant",
    });
    const mail = await waitFor(async () =>
      mailer.sent.find((m) => m.to === "owner@acme.test" && m.subject.includes("question")),
    );
    expect(mail.subject).toBe("ada asked a data-room question");
    expect(mail.text).toContain(`http://acme.${CANON}/admin/data-room/questions/${q}`);
    const post = await waitFor(async () =>
      posts.find((p) => p.message.link?.url.endsWith(`/admin/data-room/questions/${q}`)),
    );
    expect(post.message.text).toBe("A new data-room question is waiting in Acme.");
    // Word-bounded: a random uuid in the link can contain the hex letters "ada".
    expect(JSON.stringify(post)).not.toMatch(/\bada\b/u);
    expect(JSON.stringify(post)).not.toContain("investor.test");

    // A redelivery collapses into the rows already written, and posts nothing twice.
    await deliver(
      "qa.question_asked",
      { questionId: q, targetKind: "document", targetId: randomUUID(), askerMembershipId: ada },
      91_001,
    );
    expect(await alertsAbout(q, "qa.question_asked")).toHaveLength(2);
  });

  it("a coordinator's cadence is respected: off writes nothing, daily waits for the digest", async () => {
    for (const [actor, cadence] of [
      [admin, "off"],
      [owner, "daily"],
    ] as const) {
      const res = await request("/api/v1/notify/preferences", {
        method: "PUT",
        cookie: actor.cookie,
        body: JSON.stringify({ preferences: [{ eventType: "qa.question_asked", cadence }] }),
      });
      expect(res.status).toBe(200);
    }
    try {
      mailer.clear();
      const q = randomUUID();
      await publishOutbox("qa.question_asked", {
        questionId: q,
        targetKind: "folder",
        targetId: randomUUID(),
        askerMembershipId: ada,
      });
      const alerts = await settle(q, "qa.question_asked", 1);
      expect(alerts.map((a) => [a.membershipId, a.cadence])).toEqual([
        [owner.membershipId, "daily"],
      ]);
      await new Promise((r) => setTimeout(r, 1500));
      // Mail about THIS question: the queue's workers are capped at the one-connection pool, so
      // the previous test's instant mails can still be landing after `mailer.clear()`.
      expect(
        mailer.sent.filter((m) => m.subject.includes("data-room") && m.text.includes(q)),
      ).toEqual([]);
    } finally {
      for (const actor of [admin, owner]) {
        await request("/api/v1/notify/preferences", {
          method: "PUT",
          cookie: actor.cookie,
          body: JSON.stringify({
            preferences: [{ eventType: "qa.question_asked", cadence: "instant" }],
          }),
        });
      }
    }
  });
});

describe("qa.question_assigned", () => {
  it("tells the assignee alone; an unassignment tells nobody", async () => {
    const q = randomUUID();
    await publishOutbox("qa.question_assigned", { questionId: q, assigneeMembershipId: editor });
    const alerts = await settle(q, "qa.question_assigned", 1);
    // Not the coordinators, not the approvers: only the person now answering it.
    expect(recipientsOf(alerts)).toEqual([editor]);
    const mail = await waitFor(async () =>
      mailer.sent.find((m) => m.to === "editor@acme.test" && m.subject.includes("assigned")),
    );
    expect(mail.subject).toBe("A data-room question was assigned to you");
    expect(mail.text).toContain(`/admin/data-room/questions/${q}`);

    const unassigned = randomUUID();
    await publishOutbox("qa.question_assigned", {
      questionId: unassigned,
      assigneeMembershipId: null,
    });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await alertsAbout(unassigned)).toEqual([]);
  });

  it("a self-assignment is silent; a later reassignment to the same person alerts again", async () => {
    const q = randomUUID();
    await deliver(
      "qa.question_assigned",
      {
        questionId: q,
        assigneeMembershipId: owner.membershipId,
        actorMembershipId: owner.membershipId,
      },
      91_101,
    );
    expect(await alertsAbout(q)).toEqual([]);
    await deliver(
      "qa.question_assigned",
      { questionId: q, assigneeMembershipId: legal, actorMembershipId: owner.membershipId },
      91_102,
    );
    // A redelivery of that event collapses …
    await deliver(
      "qa.question_assigned",
      { questionId: q, assigneeMembershipId: legal, actorMembershipId: owner.membershipId },
      91_102,
    );
    const once = await alertsAbout(q);
    expect(once.map((a) => [a.membershipId, a.actor])).toEqual([[legal, owner.membershipId]]);
    // … a new assignment (another outbox event) back to the same person does not.
    await deliver(
      "qa.question_assigned",
      { questionId: q, assigneeMembershipId: legal, actorMembershipId: owner.membershipId },
      91_103,
    );
    expect(recipientsOf(await alertsAbout(q))).toEqual([legal, legal]);
  });
});

describe("qa.answer_submitted", () => {
  it("reaches data-room.qa_approve holders (owner, admin, legal) and nobody else", async () => {
    const q = randomUUID();
    await publishOutbox("qa.answer_submitted", { questionId: q });
    const alerts = await settle(q, "qa.answer_submitted", 3);
    expect(recipientsOf(alerts)).toEqual([owner.membershipId, admin.membershipId, legal].sort());
    expect(alerts.every((a) => a.actor === null)).toBe(true);
  });

  it("never the author of the submitted answer", async () => {
    const q = randomUUID();
    await deliver("qa.answer_submitted", { questionId: q, actorMembershipId: legal }, 91_201);
    expect(recipientsOf(await alertsAbout(q))).toEqual(
      [owner.membershipId, admin.membershipId].sort(),
    );
  });
});

describe("qa.answer_released", () => {
  it("mails the asker alone, with the portal link on the workspace's own host", async () => {
    mailer.clear();
    const q = randomUUID();
    await publishOutbox("qa.answer_released", {
      questionId: q,
      visibility: "asker",
      askerMembershipId: ada,
    });
    const alerts = await settle(q, "qa.answer_released", 1);
    // No staff member is told about a release; the asker is, although investors have no inbox.
    expect(recipientsOf(alerts)).toEqual([ada]);
    expect(alerts[0]).toMatchObject({
      actor: null,
      payload: { questionId: q, visibility: "asker" },
    });
    const mail = await waitFor(async () =>
      mailer.sent.find((m) => m.to === "ada@investor.test" && m.subject.includes("answered")),
    );
    expect(mail.subject).toBe("Acme answered your question");
    expect(mail.text).toContain(`Read the answer: http://acme.${CANON}/data-room/questions/${q}`);
    expect(mail.text).not.toContain("/admin/");
    expect(mail.text).toContain("Only you can see the answer.");

    // Published later: news to the asker (their question is now visible to others) — once.
    const publishedId = await publishOutbox("qa.answer_released", {
      questionId: q,
      visibility: "target",
      askerMembershipId: ada,
    });
    await settle(q, "qa.answer_released", 2);
    // The outbox redelivers the very same event (same outbox id): it collapses.
    await deliver(
      "qa.answer_released",
      { questionId: q, visibility: "target", askerMembershipId: ada },
      publishedId,
    );
    const both = await alertsAbout(q, "qa.answer_released");
    expect(both.map((a) => a.payload["visibility"])).toEqual(["asker", "target"]);
    const published = await waitFor(async () =>
      mailer.sent.find((m) => m.to === "ada@investor.test" && m.text.includes("published")),
    );
    expect(published.text).toContain(`/data-room/questions/${q}`);

    // No asker (a staff FAQ entry or an import): nobody to tell.
    const faq = randomUUID();
    await deliver(
      "qa.answer_released",
      { questionId: faq, visibility: "target", askerMembershipId: null },
      91_302,
    );
    expect(await alertsAbout(faq)).toEqual([]);
  });

  it("reopened, re-answered and released again: the asker hears it again; a redelivery does not", async () => {
    mailer.clear();
    const q = randomUUID();
    const payload = { questionId: q, visibility: "asker" as const, askerMembershipId: ada };
    await publishOutbox("qa.answer_released", payload);
    await settle(q, "qa.answer_released", 1);
    // Reopen + new answer + release: the data room publishes a second event, same payload.
    const again = await publishOutbox("qa.answer_released", payload);
    const twice = await settle(q, "qa.answer_released", 2);
    expect(recipientsOf(twice)).toEqual([ada, ada]);
    await deliver("qa.answer_released", payload, again);
    await deliver("qa.answer_released", payload, again);
    expect(await alertsAbout(q, "qa.answer_released")).toHaveLength(2);
    const mailsAbout = () =>
      mailer.sent.filter(
        (x) => x.to === "ada@investor.test" && x.text.includes(`/data-room/questions/${q}`),
      );
    await waitFor(async () => (mailsAbout().length >= 2 ? true : undefined));
    await new Promise((r) => setTimeout(r, 600));
    expect(mailsAbout()).toHaveLength(2);
  });

  it("an erased asker's release is dropped", async () => {
    await rows(
      `INSERT INTO core.dsar_request (workspace_id, membership_id, kind, due_at)
       VALUES ('${acmeId}'::uuid, '${bea}'::uuid, 'erasure', now() + interval '30 days')`,
    );
    const q = randomUUID();
    await deliver(
      "qa.answer_released",
      { questionId: q, visibility: "asker", askerMembershipId: bea },
      91_401,
    );
    expect(await alertsAbout(q)).toEqual([]);
    // … and so is a question asked by them, dispatched after the request.
    await deliver(
      "qa.question_asked",
      { questionId: q, targetKind: "document", targetId: randomUUID(), askerMembershipId: bea },
      91_402,
    );
    expect(await alertsAbout(q)).toEqual([]);
  });
});

describe("qa.question_declined", () => {
  it("mails the asker alone, with the portal link; a redelivery collapses, a re-decline does not", async () => {
    mailer.clear();
    const q = randomUUID();
    await publishOutbox("qa.question_declined", { questionId: q, askerMembershipId: ada });
    const alerts = await settle(q, "qa.question_declined", 1);
    // Only the asker: no coordinator, approver or other investor.
    expect(recipientsOf(alerts)).toEqual([ada]);
    expect(alerts[0]).toMatchObject({
      actor: null,
      cadence: "instant",
      resourceKind: "qa_question",
      payload: { questionId: q },
    });
    const mail = await waitFor(async () =>
      mailer.sent.find((m) => m.to === "ada@investor.test" && m.subject.includes("declined")),
    );
    expect(mail.subject).toBe("Acme declined your question");
    expect(mail.text).toContain(
      `View your question: http://acme.${CANON}/data-room/questions/${q}`,
    );
    expect(mail.text).not.toContain("/admin/");
    expect(mailer.sent.filter((m) => m.subject.includes("declined"))).toHaveLength(1);

    await deliver("qa.question_declined", { questionId: q, askerMembershipId: ada }, 91_601);
    await deliver("qa.question_declined", { questionId: q, askerMembershipId: ada }, 91_601);
    // Reopened and declined again (a new outbox event) is news; its redelivery is not.
    expect(await alertsAbout(q, "qa.question_declined")).toHaveLength(2);
  });

  it("an erased asker is not told", async () => {
    // `bea`'s erasure request: filed by the release test above, or here if that did not run.
    await rows(
      `INSERT INTO core.dsar_request (workspace_id, membership_id, kind, due_at)
       SELECT '${acmeId}'::uuid, '${bea}'::uuid, 'erasure', now() + interval '30 days'
        WHERE NOT EXISTS (SELECT 1 FROM core.dsar_request
                           WHERE membership_id = '${bea}'::uuid AND kind = 'erasure')`,
    );
    const q = randomUUID();
    await deliver("qa.question_declined", { questionId: q, askerMembershipId: bea }, 91_602);
    expect(await alertsAbout(q)).toEqual([]);
  });
});

describe("qa.question_due", () => {
  it("the assignee and the coordinators, one row per phase, each phase in its own words", async () => {
    mailer.clear();
    const q = randomUUID();
    const dueAt = "2026-10-01T09:30:00.000Z";
    await publishOutbox("qa.question_due", {
      questionId: q,
      phase: "due_soon",
      dueAt,
      assigneeMembershipId: editor,
    });
    const soon = await settle(q, "qa.question_due", 3);
    expect(recipientsOf(soon)).toEqual([owner.membershipId, admin.membershipId, editor].sort());
    const overdueId = await publishOutbox("qa.question_due", {
      questionId: q,
      phase: "overdue",
      dueAt,
      assigneeMembershipId: editor,
    });
    const all = await settle(q, "qa.question_due", 6);
    expect(all).toHaveLength(6);
    expect(all.filter((a) => a.payload["phase"] === "overdue")).toHaveLength(3);
    // The outbox redelivers the same reminder (same outbox id): it collapses.
    await deliver(
      "qa.question_due",
      { questionId: q, phase: "overdue", dueAt, assigneeMembershipId: editor },
      overdueId,
    );
    expect(await alertsAbout(q, "qa.question_due")).toHaveLength(6);
    const subjects = await waitFor(async () => {
      const s = mailer.sent
        .filter(
          (m) => m.to === "editor@acme.test" && m.subject.startsWith("A data-room question is"),
        )
        .map((m) => m.subject)
        .sort();
      return s.length >= 2 ? s : undefined;
    });
    expect(subjects).toEqual([
      "A data-room question is due soon",
      "A data-room question is overdue",
    ]);

    // The deadline moves (the job re-arms its stamps): the reminder for the new date is delivered.
    const moved = "2026-10-03T09:30:00.000Z";
    await publishOutbox("qa.question_due", {
      questionId: q,
      phase: "due_soon",
      dueAt: moved,
      assigneeMembershipId: editor,
    });
    const rearmed = await settle(q, "qa.question_due", 9);
    expect(rearmed).toHaveLength(9);
    expect(
      recipientsOf(
        rearmed.filter((a) => a.payload["dueAt"] === moved && a.payload["phase"] === "due_soon"),
      ),
    ).toEqual([owner.membershipId, admin.membershipId, editor].sort());

    // … and moved back to the first date (A→B→A): the job re-armed, so this reminder is news too,
    // even though a due-soon alert for that very deadline was sent before.
    const back = await publishOutbox("qa.question_due", {
      questionId: q,
      phase: "due_soon",
      dueAt,
      assigneeMembershipId: editor,
    });
    const aba = await settle(q, "qa.question_due", 12);
    expect(aba).toHaveLength(12);
    expect(
      aba.filter((a) => a.payload["dueAt"] === dueAt && a.payload["phase"] === "due_soon"),
    ).toHaveLength(6);
    await deliver(
      "qa.question_due",
      { questionId: q, phase: "due_soon", dueAt, assigneeMembershipId: editor },
      back,
    );
    expect(await alertsAbout(q, "qa.question_due")).toHaveLength(12);

    // Unassigned: the coordinators only; viewer and legal never.
    const lone = randomUUID();
    await publishOutbox("qa.question_due", {
      questionId: lone,
      phase: "overdue",
      dueAt,
      assigneeMembershipId: null,
    });
    const coordinators = await settle(lone, "qa.question_due", 2);
    expect(recipientsOf(coordinators)).toEqual([owner.membershipId, admin.membershipId].sort());
    expect(coordinators.map((a) => a.membershipId)).not.toContain(viewer);
  });
});

describe("the staff inbox", () => {
  it("shows the Q&A rows with no subject name: nothing is read from the data room", async () => {
    const inbox = (await (
      await request("/api/v1/notify/inbox", { cookie: owner.cookie })
    ).json()) as {
      items: { eventType: string; subjectName: string | null; resourceKind: string | null }[];
    };
    const qa = inbox.items.filter((i) => i.eventType.startsWith("qa."));
    expect(new Set(qa.map((i) => i.eventType))).toEqual(
      new Set(["qa.question_asked", "qa.answer_submitted", "qa.question_due"]),
    );
    expect(qa.every((i) => i.subjectName === null && i.resourceKind === "qa_question")).toBe(true);
  });
});
