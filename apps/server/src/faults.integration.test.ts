import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { pgErrorCode } from "@fundroom/db";
import { isStorageError } from "@fundroom/ports";
import { createS3Storage } from "@fundroom/storage-s3";
import {
  type CreatedProxy,
  type StartedToxiProxyContainer,
  ToxiProxyContainer,
} from "@testcontainers/toxiproxy";
import { sql } from "drizzle-orm";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { seedDemo } from "./demo/seed.js";
import { createLogger } from "./logger.js";
import { accessModule } from "./modules.js";
import { DEFAULT_PROBE_TIMEOUT_MS } from "./readiness.js";
import { type RunningServer, startServer } from "./server.js";

/*
 * Fault injection (E2.10): the whole server against Postgres, Mailpit (SMTP) and SeaweedFS (S3),
 * each reached **through Toxiproxy**, so a test can add latency, black-hole a socket, cut a link
 * or reset every connection while requests are in flight — and then take the fault away again.
 *
 * Every assertion is about a *bound*: a request under a fault must end, with an error envelope,
 * inside a stated time, and the process must be serving normally once the fault is lifted, with
 * no restart. "Does not crash" is not the property; "does not hang and does not stay broken" is.
 *
 * Timeouts are shortened through the config the product already reads
 * (`DATABASE_STATEMENT_TIMEOUT_MS`, the SMTP URL's nodemailer timeout parameters), never through
 * a test-only seam, so the bounds asserted here are the ones an operator can set.
 */
const BASE = "http://localhost:3000";
const HOST = "localhost:3000";
const OWNER = "founder@example.com";
const BUCKET = "fundroom-faults";

const PG_IMAGE = process.env["FUNDROOM_TEST_PG_IMAGE"] ?? "postgres:18-alpine";
const S3_IMAGE = process.env["FUNDROOM_TEST_S3_IMAGE"] ?? "chrislusf/seaweedfs:3.97";
const MAILPIT_IMAGE = "axllent/mailpit:v1.31.1";
const TOXIPROXY_IMAGE = "ghcr.io/shopify/toxiproxy:2.12.0";

/** Client-side statement bound under test; `DATABASE_STATEMENT_TIMEOUT_MS`. */
const STATEMENT_TIMEOUT_MS = 2_000;
/** SMTP connect/greeting and socket-idle bounds, set through the SMTP URL. */
const SMTP_CONNECT_MS = 1_500;
const SMTP_SOCKET_MS = 2_500;

let network: StartedNetwork;
let postgres: StartedTestContainer;
let mailpit: StartedTestContainer;
let seaweed: StartedTestContainer;
let toxi: StartedToxiProxyContainer;
let pgProxy: CreatedProxy;
let smtpProxy: CreatedProxy;
let s3Proxy: CreatedProxy;
let mailpitApi: string;
let running: RunningServer;
let cookie = "";

async function request(
  path: string,
  init: RequestInit & { cookie?: string } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", HOST);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", BASE);
  return running.app.request(`${BASE}${path}`, { ...init, headers });
}

/** Runs `fn` and returns its result with the wall time it took. */
async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - started };
}

async function until<T>(
  what: string,
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 250,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function mailpitMessages(to: string): Promise<{ ID: string; Created: string }[]> {
  const res = await fetch(`${mailpitApi}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
  const body = (await res.json()) as { messages: { ID: string; Created: string }[] };
  return body.messages;
}

async function mailpitText(id: string): Promise<string> {
  const res = await fetch(`${mailpitApi}/api/v1/message/${id}`);
  return ((await res.json()) as { Text: string }).Text;
}

async function signIn(email: string): Promise<string> {
  const before = new Set((await mailpitMessages(email)).map((m) => m.ID));
  const start = await request("/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  const id = await until(
    "the sign-in mail",
    async () => (await mailpitMessages(email)).find((m) => !before.has(m.ID))?.ID,
    10_000,
  );
  const code = /^\s{4}(\d{6})$/mu.exec(await mailpitText(id))?.[1];
  if (!code) throw new Error("no code in the sign-in mail");
  const verify = await request("/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  return verify.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

async function me(): Promise<Response> {
  return request("/api/v1/me", { cookie });
}

async function readyz(): Promise<{
  status: number;
  checks: { name: string; status: string; detail?: string }[];
}> {
  const res = await request("/readyz");
  const body = (await res.json()) as { checks?: { name: string; status: string }[] };
  return { status: res.status, checks: body.checks ?? [] };
}

function check(r: Awaited<ReturnType<typeof readyz>>, name: string): string | undefined {
  return r.checks.find((c) => c.name === name)?.status;
}

/** Removes every toxic and re-enables every proxy, whatever a test left behind. */
async function heal(): Promise<void> {
  await toxi?.client.reset();
}

/** `n` sequential `/me` calls, all of which must succeed: more than the pool holds. */
async function allHealthy(n = 14): Promise<void> {
  for (let i = 0; i < n; i++) {
    const { value, ms } = await timed(me);
    expect(value.status, `request ${i} after recovery`).toBe(200);
    expect(ms, `request ${i} after recovery`).toBeLessThan(2_000);
  }
}

async function expectErrorEnvelope(res: Response): Promise<void> {
  expect(res.status).toBeGreaterThanOrEqual(500);
  const body = (await res.json()) as { error?: { code?: string; requestId?: string } };
  expect(body.error?.code).toMatch(/^[a-z_]+$/u);
  expect(body.error?.requestId).toMatch(/^[0-9a-f-]{36}$/u);
}

beforeAll(async () => {
  network = await new Network().start();
  [postgres, mailpit, seaweed, toxi] = await Promise.all([
    new GenericContainer(PG_IMAGE)
      .withNetwork(network)
      .withNetworkAliases("postgres")
      .withEnvironment({
        POSTGRES_USER: "seedhost",
        POSTGRES_PASSWORD: "seedhost",
        POSTGRES_DB: "seedhost",
      })
      .withTmpFs({ "/var/lib/postgresql": "rw" })
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/u, 2))
      .withStartupTimeout(120_000)
      .start(),
    new GenericContainer(MAILPIT_IMAGE)
      .withNetwork(network)
      .withNetworkAliases("mailpit")
      .withExposedPorts(8025)
      .withWaitStrategy(Wait.forHttp("/readyz", 8025))
      .start(),
    new GenericContainer(S3_IMAGE)
      .withNetwork(network)
      .withNetworkAliases("s3")
      .withCommand([
        "server",
        "-s3",
        "-dir=/data",
        "-ip.bind=0.0.0.0",
        "-master.volumeSizeLimitMB=64",
        "-volume.max=8",
      ])
      .withWaitStrategy(Wait.forLogMessage(/Start Seaweed S3 API Server/u))
      .withStartupTimeout(120_000)
      .start(),
    new ToxiProxyContainer(TOXIPROXY_IMAGE).withNetwork(network).start(),
  ]);
  mailpitApi = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`;
  pgProxy = await toxi.createProxy({ name: "postgres", upstream: "postgres:5432" });
  smtpProxy = await toxi.createProxy({ name: "smtp", upstream: "mailpit:1025" });
  s3Proxy = await toxi.createProxy({ name: "s3", upstream: "s3:8333" });
  const s3Endpoint = `http://${s3Proxy.host}:${s3Proxy.port}`;

  // SeaweedFS with no `-s3.config` accepts anonymous requests, so a bare PUT creates the bucket.
  await until(
    "the S3 bucket",
    async () => {
      const res = await fetch(`${s3Endpoint}/${BUCKET}`, { method: "PUT" });
      return res.ok || res.status === 409 ? true : undefined;
    },
    60_000,
    1_000,
  );

  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "error",
      BASE_URL: BASE,
      DATABASE_URL: `postgres://seedhost:seedhost@${pgProxy.host}:${pgProxy.port}/seedhost`,
      DATABASE_STATEMENT_TIMEOUT_MS: String(STATEMENT_TIMEOUT_MS),
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-faults-")),
      STORAGE_DRIVER: "s3",
      S3_BUCKET: BUCKET,
      S3_ENDPOINT: s3Endpoint,
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: "fundroom",
      S3_SECRET_ACCESS_KEY: "fundroom",
      S3_FORCE_PATH_STYLE: "true",
      SMTP_URL: `smtp://${smtpProxy.host}:${smtpProxy.port}?connectionTimeout=${SMTP_CONNECT_MS}&greetingTimeout=${SMTP_CONNECT_MS}&socketTimeout=${SMTP_SOCKET_MS}`,
      MAIL_FROM: "portal@example.com",
      TENANCY_MODE: "single",
      ROLES: "api,web,worker",
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "error" }),
    modules: [accessModule],
    listenEnabled: false,
    migrate: true,
  });
  await seedDemo(running.container, { investors: 2 });
  cookie = await signIn(OWNER);
}, 240_000);

afterEach(async () => {
  await heal();
});

afterAll(async () => {
  await running?.stop();
  await Promise.allSettled([toxi?.stop(), postgres?.stop(), mailpit?.stop(), seaweed?.stop()]);
  await network?.stop();
});

describe("baseline", () => {
  it("serves through every proxy with no toxic", async () => {
    expect((await me()).status).toBe(200);
  });
});

/*
 * Storage first: `/readyz` remembers a passing storage probe for 60 s, so this must be the first
 * readiness call of the run or it would be answered from that cache.
 */
describe("c. object storage black-holed", () => {
  it("/readyz reports storage failed inside the 5 s probe bound", async () => {
    await s3Proxy.instance.addToxic({
      name: "hole",
      type: "timeout",
      stream: "downstream",
      toxicity: 1,
      attributes: { timeout: 0 },
    });
    const { value, ms } = await timed(readyz);
    expect(value.status).toBe(503);
    expect(check(value, "storage")).toBe("fail");
    expect(check(value, "database")).toBe("ok");
    expect(ms).toBeLessThan(DEFAULT_PROBE_TIMEOUT_MS + 2_000);
    // Liveness does not depend on storage.
    expect((await request("/healthz")).status).toBe(200);
  });

  it("a download or upload fails inside the adapter's bound instead of hanging", async () => {
    await s3Proxy.instance.addToxic({
      name: "hole",
      type: "timeout",
      stream: "downstream",
      toxicity: 1,
      attributes: { timeout: 0 },
    });
    const storage = createS3Storage({
      bucket: BUCKET,
      endpoint: `http://${s3Proxy.host}:${s3Proxy.port}`,
      accessKeyId: "fundroom",
      secretAccessKey: "fundroom",
      forcePathStyle: true,
      connectionTimeoutMs: 1_000,
      socketTimeoutMs: 1_500,
      maxAttempts: 2,
    });
    const bound = 2 * (1_000 + 1_500) + 1_500;
    const bytes = new TextEncoder().encode("fault-injected");
    const get = await timed(() =>
      storage.get("faults/missing").then(
        () => "resolved",
        (e: unknown) => (isStorageError(e, "backend") ? "backend" : String(e)),
      ),
    );
    expect(get.value).toBe("backend");
    expect(get.ms).toBeLessThan(bound);
    const put = await timed(() =>
      storage.put("faults/object", bytes).then(
        () => "resolved",
        (e: unknown) => (isStorageError(e, "backend") ? "backend" : String(e)),
      ),
    );
    expect(put.value).toBe("backend");
    expect(put.ms).toBeLessThan(bound);

    await heal();
    // Same client, no restart: the next call opens a fresh socket and succeeds.
    await storage.put("faults/object", bytes);
    expect((await storage.head("faults/object"))?.size).toBe(bytes.byteLength);
  });
});

describe("a. database slower than the statement timeout", () => {
  it("network latency past the bound fails the request fast, and the pool is not poisoned", async () => {
    await pgProxy.instance.addToxic({
      name: "slow",
      type: "latency",
      stream: "downstream",
      toxicity: 1,
      attributes: { latency: STATEMENT_TIMEOUT_MS * 2, jitter: 0 },
    });
    const { value, ms } = await timed(me);
    await expectErrorEnvelope(value);
    expect(ms).toBeLessThan(STATEMENT_TIMEOUT_MS * 3);
    await heal();
    await allHealthy();
  });

  it("the client bound yields to the server's: a slow statement is cancelled, an opted-out one runs", async () => {
    const db = running.container.db;
    const sleepPast = `SELECT pg_sleep(${(STATEMENT_TIMEOUT_MS + 1_500) / 1000})`;
    // A slow *statement* is the server's to cancel (57014), well before the client bound.
    const slow = await timed(() =>
      db
        .withHost((tx) => tx.execute(sql.raw(sleepPast)))
        .then(
          () => "ok",
          (e: unknown) => pgErrorCode(e) ?? String(e),
        ),
    );
    expect(slow.value).toBe("57014");
    expect(slow.ms).toBeLessThan(STATEMENT_TIMEOUT_MS + 900);
    // `SET LOCAL statement_timeout = 0` (the export/import snapshot path) lifts the client bound
    // for the rest of that transaction too, so a long legitimate FETCH is not cut off.
    const optedOut = await db.withHost(async (tx) => {
      await tx.execute(sql.raw("SET LOCAL statement_timeout = 0"));
      await tx.execute(sql.raw(sleepPast));
      return "ok";
    });
    expect(optedOut).toBe("ok");
    await allHealthy(3);
  });

  it("a black-holed connection fails every in-flight request inside the bound, then recovers", async () => {
    await pgProxy.instance.addToxic({
      name: "hole",
      type: "timeout",
      stream: "downstream",
      toxicity: 1,
      attributes: { timeout: 0 },
    });
    // More concurrent requests than the pool has connections: every one must still end.
    const results = await Promise.all(Array.from({ length: 12 }, () => timed(me)));
    for (const r of results) {
      await expectErrorEnvelope(r.value);
      expect(r.ms).toBeLessThan(STATEMENT_TIMEOUT_MS * 4);
    }
    await heal();
    await allHealthy();
  });
});

describe("b. database connection cut", () => {
  it("liveness stays up, readiness goes 503 inside the probe bound, and both recover without a restart", async () => {
    await pgProxy.setEnabled(false);
    const live = await timed(() => request("/healthz"));
    expect(live.value.status).toBe(200);
    expect(live.ms).toBeLessThan(500);

    const ready = await timed(readyz);
    expect(ready.value.status).toBe(503);
    expect(check(ready.value, "database")).toBe("fail");
    expect(check(ready.value, "queue")).toBe("skipped");
    expect(ready.ms).toBeLessThan(DEFAULT_PROBE_TIMEOUT_MS + 2_000);

    const during = await timed(me);
    await expectErrorEnvelope(during.value);
    expect(during.ms).toBeLessThan(STATEMENT_TIMEOUT_MS * 3);

    await pgProxy.setEnabled(true);
    // Storage's failed probe from (c) is remembered for at most 10 s; everything else is live.
    const back = await until(
      "readiness to recover",
      async () => ((await readyz()).status === 200 ? true : undefined),
      20_000,
      500,
    );
    expect(back).toBe(true);
    await allHealthy();
  });
});

describe("e. Postgres drops every connection mid-traffic", () => {
  async function traffic(ms: number): Promise<{ statuses: number[]; slowest: number }> {
    const statuses: number[] = [];
    let slowest = 0;
    const end = Date.now() + ms;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (Date.now() < end) {
          const r = await timed(me);
          statuses.push(r.value.status);
          slowest = Math.max(slowest, r.ms);
        }
      }),
    );
    return { statuses, slowest };
  }

  it("connection resets under load end each request, and the pool heals itself", async () => {
    const load = traffic(3_000);
    await new Promise((r) => setTimeout(r, 500));
    await pgProxy.instance.addToxic({
      name: "reset",
      type: "reset_peer",
      stream: "upstream",
      toxicity: 1,
      attributes: { timeout: 0 },
    });
    await new Promise((r) => setTimeout(r, 1_000));
    await heal();
    const { statuses, slowest } = await load;
    expect(statuses.some((s) => s === 200)).toBe(true);
    expect(statuses.some((s) => s >= 500)).toBe(true);
    expect(statuses.every((s) => s === 200 || s >= 500)).toBe(true);
    expect(slowest).toBeLessThan(STATEMENT_TIMEOUT_MS * 3);
    await allHealthy();
  });

  it("an administrator terminating every backend (a restart's first act) is survived too", async () => {
    const load = traffic(2_500);
    await new Promise((r) => setTimeout(r, 500));
    const admin = await postgres.exec([
      "psql",
      "-U",
      "seedhost",
      "-d",
      "seedhost",
      "-Atc",
      "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type = 'client backend'",
    ]);
    expect(admin.exitCode).toBe(0);
    expect(Number(admin.output.trim())).toBeGreaterThan(0);
    const { statuses, slowest } = await load;
    expect(statuses.every((s) => s === 200 || s >= 500)).toBe(true);
    expect(slowest).toBeLessThan(STATEMENT_TIMEOUT_MS * 3);
    await allHealthy();
    // The job queue shares the pool: it must still be answering, not just HTTP.
    expect(check(await readyz(), "queue")).toBe("ok");
  });
});

describe("d. SMTP down or black-holed", () => {
  it("sign-in mail is sent detached: the request answers at once, then sign-in works again", async () => {
    await smtpProxy.instance.addToxic({
      name: "hole",
      type: "timeout",
      stream: "downstream",
      toxicity: 1,
      attributes: { timeout: 0 },
    });
    const start = await timed(() =>
      request("/api/v1/auth/otp/start", {
        method: "POST",
        body: JSON.stringify({ email: OWNER }),
      }),
    );
    // E2.10 R1-03: the answer must not depend on delivery (a 503 for members only was an
    // enumeration oracle), so a black-holed relay shows neither in the status nor in the time.
    expect(start.value.status).toBe(200);
    expect(((await start.value.json()) as { status: string }).status).toBe("sent");
    expect(start.ms).toBeLessThan(1_500);

    await heal();
    cookie = await signIn(OWNER);
    expect((await me()).status).toBe(200);
  });

  it("mail sent from a job is retried while SMTP is refused, and delivered exactly once after", async () => {
    const queue = running.container.queue;
    const name = "faults.mail";
    const to = "queued@example.com";
    let attempts = 0;
    await queue.ensureQueue(name, { retryLimit: 10, retryDelaySeconds: 1, retryBackoff: false });
    await queue.work(name, async () => {
      attempts += 1;
      await running.container.mailer.send({
        to,
        subject: "queued through an outage",
        text: "delivered after SMTP came back",
        idempotencyKey: "faults:queued",
      });
    });
    await smtpProxy.setEnabled(false);
    await queue.send(name, { n: 1 });
    await until("two failed attempts", async () => (attempts >= 2 ? true : undefined), 20_000);
    expect(await mailpitMessages(to)).toEqual([]);

    await smtpProxy.setEnabled(true);
    await until(
      "the queued mail",
      async () => ((await mailpitMessages(to)).length > 0 ? true : undefined),
      20_000,
    );
    const tried = attempts;
    await new Promise((r) => setTimeout(r, 2_000));
    expect(attempts).toBe(tried);
    expect(await mailpitMessages(to)).toHaveLength(1);
  });
});
