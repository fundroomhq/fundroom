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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { awaitMail } from "./test/sign-in-mail.js";

/*
 * Accreditation verification alerts to the investor (E3.7, ADR-0055), end to end through the
 * outbox: `round.verification_decided` / `round.verification_expiring` published inside a tenant
 * transaction (never through the round routes, so this file does not depend on them) → notify's
 * handlers → a row for the investor in the payload and nobody else → an instant email in the
 * investor's words, linked to the portal's round page. Also: a pending "decision" tells nobody,
 * redeliveries collapse, verified-then-expired is two facts, and an erased, revoked or opted-out
 * investor receives nothing.
 *
 * One pooled connection: a handler that took a second connection while holding the dispatcher's
 * transaction would hang here instead of passing.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
const ROUND_PAGE = `http://acme.${CANON}/round`;
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let acmeId: string;
let owner: string;
let admin: string;
let ada: string;
let bea: string;
let cid: string;
let dan: string;

type Role = "owner" | "admin" | "investor";

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

/** Hands one event straight to notify's subscriber the way the dispatcher does (a redelivery). */
async function deliver<T extends EventTopic>(topic: T, payload: EventPayload<T>, outboxId: number) {
  const ctx = systemContext(acmeId);
  await running.container.db.withTenant(ctx, (tx) =>
    handlerFor(topic)(
      {
        outboxId,
        topic,
        workspaceId: acmeId,
        payload,
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
  payload: Record<string, unknown>;
}

async function alertsAbout(verificationId: string, eventType?: string): Promise<Alert[]> {
  return rows<Alert>(
    `SELECT membership_id AS "membershipId", event_type AS "eventType", cadence,
            actor_membership_id AS actor, resource_kind AS "resourceKind", payload
       FROM notify.notification
      WHERE resource_id = '${verificationId}'::uuid
        ${eventType === undefined ? "" : `AND event_type = '${eventType}'`}
      ORDER BY created_at, membership_id`,
  );
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

/** Waits until `n` rows about the verification exist (and a beat more, to catch extras). */
async function settle(verificationId: string, eventType: string, n: number): Promise<Alert[]> {
  await waitFor(async () => {
    const r = await alertsAbout(verificationId, eventType);
    return r.length >= n ? r : undefined;
  });
  await new Promise((r) => setTimeout(r, 600));
  return alertsAbout(verificationId, eventType);
}

const staffMail = () =>
  mailer.sent.filter(
    (m) =>
      (m.to === "owner@acme.test" || m.to === "admin@acme.test") &&
      /accreditation/iu.test(m.subject),
  );

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
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  // Staff holding `round.manage`: they hear about verification *requests*, never these.
  owner = await provision("owner@acme.test", "owner");
  admin = await provision("admin@acme.test", "admin");
  ada = await provision("ada@investor.test", "investor");
  bea = await provision("bea@investor.test", "investor");
  cid = await provision("cid@investor.test", "investor");
  // Access removed: a revoked member is no longer anybody the workspace writes to.
  await rows(`UPDATE core.membership SET status = 'revoked' WHERE id = '${cid}'::uuid`);
  dan = await provision("dan@investor.test", "investor");
  mailer.clear();
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("round.verification_decided", () => {
  it("verified: the investor alone, instantly, in neutral words linked to the portal", async () => {
    const since = mailer.sent.length;
    const v = randomUUID();
    await publishOutbox("round.verification_decided", {
      verificationId: v,
      membershipId: ada,
      status: "verified",
    });
    const alerts = await settle(v, "round.verification_decided", 1);
    expect(alerts.map((a) => a.membershipId)).toEqual([ada]);
    expect(alerts[0]).toMatchObject({
      actor: null,
      cadence: "instant",
      resourceKind: "verification",
      payload: { verificationId: v, status: "verified" },
    });
    const mail = await awaitMail(mailer, {
      to: "ada@investor.test",
      since,
      match: (m) => m.subject.includes("accreditation"),
      timeoutMs: 30_000,
    });
    expect(mail.subject).toBe("Your accreditation verification is complete");
    expect(mail.text).toContain("Your accreditation verification with Acme is complete.");
    expect(mail.text).toContain(`View your round: ${ROUND_PAGE}`);
    expect(mail.text).not.toContain("/admin/");
    expect(staffMail()).toEqual([]);
    expect(alerts.map((a) => a.membershipId)).not.toContain(owner);
    expect(alerts.map((a) => a.membershipId)).not.toContain(admin);
  });

  it("rejected and expired each have their own words; verified-then-expired is two facts", async () => {
    const rejected = randomUUID();
    let since = mailer.sent.length;
    await publishOutbox("round.verification_decided", {
      verificationId: rejected,
      membershipId: ada,
      status: "rejected",
    });
    const r = await awaitMail(mailer, {
      to: "ada@investor.test",
      since,
      match: (m) => m.text.includes("could not be completed"),
      timeoutMs: 30_000,
    });
    expect(r.subject).toBe("Your accreditation verification could not be completed");
    expect(r.text).toContain(ROUND_PAGE);

    const v = randomUUID();
    since = mailer.sent.length;
    await publishOutbox("round.verification_decided", {
      verificationId: v,
      membershipId: ada,
      status: "verified",
    });
    await publishOutbox("round.verification_decided", {
      verificationId: v,
      membershipId: ada,
      status: "expired",
    });
    const expired = await awaitMail(mailer, {
      to: "ada@investor.test",
      since,
      match: (m) => m.subject === "Your accreditation verification has expired",
      timeoutMs: 30_000,
    });
    expect(expired.text).toContain(`Renew your verification: ${ROUND_PAGE}`);
    const alerts = await settle(v, "round.verification_decided", 2);
    expect(alerts.map((a) => a.payload["status"]).sort()).toEqual(["expired", "verified"]);

    // A redelivery of either collapses into the row already written.
    await deliver(
      "round.verification_decided",
      { verificationId: v, membershipId: ada, status: "expired" },
      93_001,
    );
    expect(await alertsAbout(v, "round.verification_decided")).toHaveLength(2);
    expect(staffMail()).toEqual([]);
  });

  it("a pending status is not a decision: nobody is told", async () => {
    const v = randomUUID();
    // Handed straight to the subscriber: "nothing happened" needs no waiting.
    await deliver(
      "round.verification_decided",
      { verificationId: v, membershipId: ada, status: "pending" },
      93_201,
    );
    expect(await alertsAbout(v)).toEqual([]);
  });
});

describe("round.verification_expiring", () => {
  it("reminds the investor alone, once, with a renew link", async () => {
    const since = mailer.sent.length;
    const v = randomUUID();
    await publishOutbox("round.verification_expiring", { verificationId: v, membershipId: ada });
    const alerts = await settle(v, "round.verification_expiring", 1);
    expect(alerts.map((a) => a.membershipId)).toEqual([ada]);
    const mail = await awaitMail(mailer, {
      to: "ada@investor.test",
      since,
      match: (m) => m.subject.includes("expires soon"),
      timeoutMs: 30_000,
    });
    expect(mail.subject).toBe("Your accreditation verification expires soon");
    expect(mail.text).toContain(`Renew your verification: ${ROUND_PAGE}`);
    await deliver("round.verification_expiring", { verificationId: v, membershipId: ada }, 93_101);
    expect(await alertsAbout(v)).toHaveLength(1);
    expect(staffMail()).toEqual([]);
  });
});

describe("who is never told", () => {
  it("an erased investor receives nothing", async () => {
    await rows(
      `INSERT INTO core.dsar_request (workspace_id, membership_id, kind, due_at)
       VALUES ('${acmeId}'::uuid, '${bea}'::uuid, 'erasure', now() + interval '30 days')`,
    );
    const v = randomUUID();
    await deliver(
      "round.verification_decided",
      { verificationId: v, membershipId: bea, status: "verified" },
      93_301,
    );
    await deliver("round.verification_expiring", { verificationId: v, membershipId: bea }, 93_302);
    expect(await alertsAbout(v)).toEqual([]);
    expect(mailer.sent.filter((m) => m.to === "bea@investor.test")).toEqual([]);
  });

  it("a revoked membership receives nothing", async () => {
    const v = randomUUID();
    await deliver(
      "round.verification_decided",
      { verificationId: v, membershipId: cid, status: "expired" },
      93_303,
    );
    expect(await alertsAbout(v)).toEqual([]);
    expect(mailer.sent.filter((m) => m.to === "cid@investor.test")).toEqual([]);
  });

  it("an investor's own cadence is respected: off writes nothing", async () => {
    await rows(
      `INSERT INTO notify.preference (workspace_id, membership_id, event_type, cadence)
       VALUES ('${acmeId}'::uuid, '${dan}'::uuid, 'round.verification_decided', 'off')`,
    );
    const v = randomUUID();
    await deliver(
      "round.verification_decided",
      { verificationId: v, membershipId: dan, status: "verified" },
      93_304,
    );
    expect(await alertsAbout(v)).toEqual([]);
    expect(mailer.sent.filter((m) => m.to === "dan@investor.test")).toEqual([]);
  });
});
