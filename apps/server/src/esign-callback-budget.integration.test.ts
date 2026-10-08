import { randomUUID } from "node:crypto";
import { createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryESignAdapter } from "@fundroom/esign/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { DROPBOX_SIGN_ACK } from "./routes/esign-callback.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type ConnectionBody,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
  memoryCallback,
} from "./test/esign-harness.js";

/*
 * The vendor callback budget is per connection (E3.5 fix B1): a tenant whose vendor floods us
 * with genuine callbacks — or who replays its own — spends only its own share, so another
 * tenant's wake-ups still enqueue their status pull at once. Over budget the answer is still 200
 * (Dropbox Sign clears a callback URL after 10 non-2xx answers) and nothing is enqueued.
 *
 * The pre-auth ceiling (fix FX2B) sheds with 200 and no lookup, so junk uuids cannot switch off
 * every tenant's callbacks; a connection that authenticated in the last few minutes bypasses it.
 *
 * The route's clock only moves when a test moves it, so the minute cannot roll mid-test.
 */
let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
const mem = createMemoryESignAdapter("docuseal");
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql, callback } = h;

const PER_CONNECTION = 5;
const GLOBAL = 12;
/** Above what the first two tests spend in minute 0 (≈ 80 uuid-shaped requests). */
const PRE_AUTH = 200;
let clockMs = 0;
/** While shedding, shed and failed-bypass answers are held this long (R3C). */
const SHED_FLOOR = 40;

interface Tenant {
  id: string;
  connection: ConnectionBody;
  secret: string;
  /** A `sent` envelope on the tenant's connection, and its vendor reference. */
  envelopeId: string;
  providerRef: string;
}
let a: Tenant;
let b: Tenant;

async function tenant(slug: string): Promise<Tenant> {
  const id = (await createWorkspace(running.container.db, { slug, name: slug })).id;
  const owner = await member(slug, id, `owner@${slug}.test`, "staff", "owner");
  const res = await request(slug, "/api/v1/esign/connection", {
    method: "PUT",
    cookie: owner.cookie,
    body: JSON.stringify({ driver: "docuseal", credentials: { apiToken: `${slug}-token-0001` } }),
  });
  expect(res.status).toBe(200);
  const saved = await json<{ connection: ConnectionBody; callbackSecret: string }>(res);
  const t = {
    id,
    connection: saved.connection,
    secret: saved.callbackSecret,
    envelopeId: randomUUID(),
    providerRef: `mem_docuseal_${slug}_1`,
  };
  await insertEnvelope(t);
  return t;
}

/** A `sent` round envelope on the tenant's connection, written directly (no vendor round trip). */
async function insertEnvelope(t: Tenant): Promise<void> {
  await sql(
    t.id,
    `INSERT INTO core.esign_envelope
       (id, workspace_id, connection_id, driver, provider_ref, purpose, subject_module, subject_kind,
        subject_id, signer_name, signer_email, title, status, sent_at)
     VALUES ('${t.envelopeId}', '${t.id}', '${t.connection.id}', 'docuseal', '${t.providerRef}',
             'round_closing', 'round', 'commitment', '${randomUUID()}', 'Signer', 'signer@example.test',
             'Subscription', 'sent', now())`,
  );
}

async function syncJobs(t: Tenant): Promise<number> {
  const [row] = await sql<{ n: number }>(
    t.id,
    `SELECT count(*)::int AS n FROM pgboss.job
      WHERE name = 'esign.sync' AND data->>'envelopeId' = '${t.envelopeId}'`,
  );
  return row?.n ?? 0;
}

function wake(t: Tenant, providerRef = t.providerRef) {
  return callback(t.connection.id, memoryCallback(t.secret, { providerRef, event: "viewed" }));
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  running = await startServer({
    config: esignTestConfig(freshSecrets(pg.connectionString)),
    logger: createLogger({ level: "error" }),
    mailer,
    esignAdapters: { docuseal: mem.definition },
    esignCallbackBudget: {
      perConnectionPerMinute: PER_CONNECTION,
      perMinute: GLOBAL,
      preAuthPerMinute: PRE_AUTH,
      shedFloorMs: SHED_FLOOR,
      now: () => clockMs,
    },
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  a = await tenant("floody");
  b = await tenant("quiet");
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("the e-sign callback budget", () => {
  it("one tenant's flood of genuine callbacks cannot delay another tenant's wake-up", async () => {
    // Tenant A spends its own budget (and then some) on wake-ups naming nothing we know.
    for (let i = 0; i < GLOBAL * 3; i++) {
      const res = await wake(a, `mem_docuseal_unknown_${i}`);
      // Over budget is still a 2xx: the vendor must never count it as a failed delivery.
      expect(res.status).toBe(200);
    }
    // A's own envelope: authentic, but A is over budget — acknowledged, nothing enqueued.
    const own = await wake(a);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ ok: true });
    expect(await syncJobs(a)).toBe(0);

    // Tenant B's first callback of the minute is admitted and its pull is queued at once.
    const res = await wake(b);
    expect(res.status).toBe(200);
    expect(await syncJobs(b)).toBe(1);
  });

  it("the budget is counted after authentication: forged callbacks spend nobody's share", async () => {
    for (let i = 0; i < GLOBAL * 3; i++) {
      const res = await callback(
        b.connection.id,
        memoryCallback("forged-secret", { providerRef: b.providerRef, event: "viewed" }),
      );
      expect(res.status).toBe(401);
    }
    // B has spent 1 of its 5: a genuine wake-up for another of its envelopes still gets through.
    const second = { ...b, envelopeId: randomUUID(), providerRef: "mem_docuseal_quiet_2" };
    await insertEnvelope(second);
    expect((await wake(second)).status).toBe(200);
    expect(await syncJobs(second)).toBe(1);
  });

  it("a junk flood past the pre-auth ceiling sheds with 200 but keeps recent tenants' wake-ups", async () => {
    // A fresh minute (A and B authenticated in the previous one, well inside the recent window).
    clockMs = 60_000;
    const c = await tenant("neverseen");
    let last: Response | undefined;
    for (let i = 0; i < PRE_AUTH + 20; i++) {
      last = await callback(
        randomUUID(),
        memoryCallback("junk", { providerRef: "mem_docuseal_junk", event: "viewed" }),
      );
      // Under the ceiling junk is the usual 401; past it, the shed 200 — never a non-2xx that
      // would make a vendor switch the URL off.
      expect(last.status).toBe(i < PRE_AUTH ? 401 : 200);
    }
    expect(await last?.text()).toBe(DROPBOX_SIGN_ACK);

    // B authenticated recently: its genuine wake-up bypasses the ceiling and is queued at once.
    const third = { ...b, envelopeId: randomUUID(), providerRef: "mem_docuseal_quiet_3" };
    await insertEnvelope(third);
    const res = await wake(third);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await syncJobs(third)).toBe(1);

    // C never authenticated: shed with the same 200 body as the junk, nothing queued (the
    // esign.sync-due sweep backstops it).
    const shed = await wake(c);
    expect(shed.status).toBe(200);
    expect(await shed.text()).toBe(DROPBOX_SIGN_ACK);
    expect(await syncJobs(c)).toBe(0);
  });
  it("R3C-1: forged callbacks naming a recent id while shedding leave its genuine wake-up", async () => {
    // Still the shedding minute of the previous test; B bypassed once there (1 of its 5).
    for (let i = 0; i < PER_CONNECTION; i++) {
      const res = await callback(
        b.connection.id,
        memoryCallback("forged-secret", { providerRef: b.providerRef, event: "viewed" }),
      );
      // The same ack as shed junk: no oracle.
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(DROPBOX_SIGN_ACK);
    }
    const fourth = { ...b, envelopeId: randomUUID(), providerRef: "mem_docuseal_quiet_4" };
    await insertEnvelope(fourth);
    const res = await wake(fourth);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await syncJobs(fourth)).toBe(1);
  });

  it("R3C-2: while shedding, a forged callback to a recent id is timed like shed junk", async () => {
    const time = async (id: string) => {
      const t = performance.now();
      const res = await callback(
        id,
        memoryCallback("forged-secret", { providerRef: "mem_docuseal_x", event: "viewed" }),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(DROPBOX_SIGN_ACK);
      return performance.now() - t;
    };
    const junk: number[] = [];
    const recent: number[] = [];
    for (let i = 0; i < 7; i++) {
      junk.push(await time(randomUUID()));
      // A authenticated in the last five minutes: its forgeries do the authentication work.
      recent.push(await time(a.connection.id));
    }
    const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)] ?? 0;
    expect(median(junk)).toBeGreaterThanOrEqual(SHED_FLOOR - 2);
    expect(median(recent)).toBeGreaterThanOrEqual(SHED_FLOOR - 2);
    expect(Math.abs(median(recent) - median(junk))).toBeLessThan(10);
  });
});
