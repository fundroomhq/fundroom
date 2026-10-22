import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "@fundroom/config";
import { createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import {
  type CreatedProxy,
  type StartedToxiProxyContainer,
  ToxiProxyContainer,
} from "@testcontainers/toxiproxy";
import * as OTPAuth from "otpauth";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
  Wait,
} from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";

/*
 * Virus scanning against a real clamd (E-UP-25), the data-room upload path end to end: no fake
 * scanner, the product reads `AV_DRIVER=clamd` / `CLAMD_HOST` / `CLAMD_PORT` / `AV_MAX_SCAN_BYTES`
 * from its config like any install. clamd is reached through Toxiproxy so one test can stall and
 * then cut the link mid-scan.
 *
 * clamd runs from the official image with its bundled signatures (no freshclam: the CDN
 * rate-limits CI) and `StreamMaxLength 2M` set through the image's `CLAMD_CONF_<Option>` env
 * hook, so "bigger than clamd streams" needs a 3 MiB file rather than a 100 MiB one.
 *
 * Opt-in: FUNDROOM_TEST_CLAMD=1 (CI's `av` job). FUNDROOM_TEST_CLAMD_IMAGE pins another image.
 */
const CLAMD_IMAGE = process.env["FUNDROOM_TEST_CLAMD_IMAGE"] ?? "clamav/clamav:1.4";
const TOXIPROXY_IMAGE = "ghcr.io/shopify/toxiproxy:2.12.0";
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";
const METRICS_TOKEN = randomBytes(24).toString("hex");
const MiB = 1024 * 1024;
/** clamd's StreamMaxLength (CLAMD_CONF_StreamMaxLength=2M). */
const STREAM_MAX = 2 * MiB;
/** The product's AV_MAX_SCAN_BYTES: deliberately above StreamMaxLength to reach clamd's refusal. */
const AV_MAX = 4 * MiB;
/** The standard anti-virus test string; built at runtime so this file is not itself flagged. */
const EICAR = ["X5O!P%@AP[4\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(
  "",
);

interface Actor {
  cookie: string;
  membershipId: string;
}

interface Detail {
  currentVersion: { id: string; renderStatus: string } | null;
  scan: { status: string; engine: string | null } | null;
  availability: { viewable: boolean; download: string | null; reason: string };
}

interface BlobRow {
  id: string;
  scan_status: string;
  scan_detail: string | null;
  scan_engine: string | null;
}

/** `rows` lines of CSV text, padded out to exactly `bytes` bytes (printable, so it sniffs as text). */
function csvOf(bytes: number, marker: string): Uint8Array {
  const head = `id,name,amount,${marker}\n`;
  const line = "1,Acme Holdings,250000,ok\n";
  const out = Buffer.alloc(bytes, " ");
  out.write(head, 0, "utf8");
  for (let at = head.length; at + line.length <= bytes; at += line.length) out.write(line, at);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

async function until<T>(what: string, fn: () => Promise<T | undefined>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

describe.skipIf(!process.env["FUNDROOM_TEST_CLAMD"])("virus scanning against clamd", () => {
  let network: StartedNetwork;
  let clamd: StartedTestContainer;
  let toxi: StartedToxiProxyContainer;
  let clamdProxy: CreatedProxy;
  let pg: TestPostgres;
  let running: RunningServer;
  let mailer: MemoryMailer;
  let acmeId: string;
  let owner: Actor;
  let editor: Actor;
  let folderId: string;
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };

  async function request(path: string, init: RequestInit & { cookie?: string } = {}) {
    const headers = new Headers(init.headers);
    headers.set("host", `acme.${CANON}`);
    if (init.body !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.method && init.method !== "GET") headers.set("origin", `http://acme.${CANON}`);
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

  async function member(email: string, role: "owner" | "editor"): Promise<Actor> {
    const deps = running.container.identityDeps;
    const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
    await provisionMembership(deps, {
      workspaceId: acmeId,
      userId: user.userId,
      kind: "staff",
      role,
      source: "test",
    });
    const actor = await signIn(email);
    if (role !== "owner") return actor;
    const enrol = await request("/api/v1/auth/totp/enrol", {
      method: "POST",
      cookie: actor.cookie,
    });
    const { secretBase32 } = (await enrol.json()) as { secretBase32: string };
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
    const confirm = await request("/api/v1/auth/totp/enrol/confirm", {
      method: "POST",
      cookie: actor.cookie,
      body: JSON.stringify({ code: totp.generate() }),
    });
    expect(confirm.status).toBe(200);
    return { ...actor, cookie: withSetCookies(actor.cookie, confirm) };
  }

  /** Starts an upload; returns the start response when it is refused. */
  async function startUpload(fileName: string, bytes: Uint8Array): Promise<Response> {
    return request("/api/v1/data-room/uploads", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ fileName, size: bytes.byteLength, contentType: "text/csv", folderId }),
    });
  }

  /** The browser's tus path: start → create → two PATCHes → complete. */
  async function upload(
    fileName: string,
    bytes: Uint8Array,
  ): Promise<{ documentId: string; versionId: string }> {
    const start = await startUpload(fileName, bytes);
    expect(start.status).toBe(201);
    const started = (await start.json()) as { upload: { id: string }; tus: { path: string } };
    const endpoint = `/api/v1${started.tus.path}`;
    const meta = `upload ${Buffer.from(started.upload.id).toString("base64")},filename ${Buffer.from(fileName).toString("base64")}`;
    const create = await request(endpoint, {
      method: "POST",
      cookie: editor.cookie,
      headers: {
        "Tus-Resumable": "1.0.0",
        "Upload-Length": String(bytes.byteLength),
        "Upload-Metadata": meta,
        "content-type": "application/offset+octet-stream",
      },
      body: new Uint8Array(0),
    });
    expect(create.status).toBe(201);
    const half = Math.ceil(bytes.byteLength / 2);
    for (const [offset, chunk] of [
      [0, bytes.subarray(0, half)],
      [half, bytes.subarray(half)],
    ] as const) {
      const patch = await request(`${endpoint}/${started.upload.id}`, {
        method: "PATCH",
        cookie: editor.cookie,
        headers: {
          "Tus-Resumable": "1.0.0",
          "Upload-Offset": String(offset),
          "content-type": "application/offset+octet-stream",
        },
        body: chunk,
      });
      expect(patch.status).toBe(204);
    }
    const complete = await request(`/api/v1/data-room/uploads/${started.upload.id}/complete`, {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({}),
    });
    expect(complete.status).toBe(200);
    const body = (await complete.json()) as { document: { id: string }; version: { id: string } };
    return { documentId: body.document.id, versionId: body.version.id };
  }

  async function ingested(documentId: string, ms = 90_000): Promise<Detail> {
    return until(
      `ingest of ${documentId}`,
      async () => {
        const res = await request(`/api/v1/data-room/documents/${documentId}`, {
          cookie: owner.cookie,
        });
        if (res.status !== 200) return undefined;
        const d = (await res.json()) as Detail;
        return d.currentVersion && d.currentVersion.renderStatus !== "pending" ? d : undefined;
      },
      ms,
    );
  }

  async function blobOf(versionId: string): Promise<BlobRow> {
    const r = await running.container.db.pool.query<BlobRow>(
      `SELECT b.id, b.scan_status::text AS scan_status, b.scan_detail, b.scan_engine
         FROM dataroom.blob b JOIN dataroom.document_version v ON v.blob_id = b.id
        WHERE v.id = $1`,
      [versionId],
    );
    const row = r.rows[0];
    if (row === undefined) throw new Error(`no blob for version ${versionId}`);
    return row;
  }

  async function ingestJob(versionId: string): Promise<{ state: string; retry_count: number }> {
    const r = await running.container.db.pool.query<{ state: string; retry_count: number }>(
      `SELECT state::text AS state, retry_count FROM pgboss.job
        WHERE name = 'data-room.ingest' AND data->>'versionId' = $1
        ORDER BY created_on DESC LIMIT 1`,
      [versionId],
    );
    const row = r.rows[0];
    if (row === undefined) throw new Error(`no ingest job for version ${versionId}`);
    return row;
  }

  async function outbox(topic: string, versionId: string): Promise<Record<string, unknown>[]> {
    const r = await running.container.db.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM core.outbox
        WHERE workspace_id = $1 AND topic = $2 AND payload->>'versionId' = $3`,
      [acmeId, topic, versionId],
    );
    return r.rows.map((x) => x.payload);
  }

  async function download(documentId: string): Promise<Response> {
    return request(`/api/v1/data-room/documents/${documentId}/download`, { cookie: owner.cookie });
  }

  async function metricsText(): Promise<string> {
    const res = await running.app.request(`${BASE}/metrics`, {
      headers: { host: CANON, authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(res.status).toBe(200);
    return res.text();
  }

  /** Sum of a Prometheus series whose labels include every given pair. */
  function series(text: string, name: string, labels: Record<string, string>): number {
    let sum = 0;
    for (const line of text.split("\n")) {
      if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
      if (!Object.entries(labels).every(([k, v]) => line.includes(`${k}="${v}"`))) continue;
      sum += Number(line.slice(line.lastIndexOf(" ") + 1));
    }
    return sum;
  }

  beforeAll(async () => {
    process.on("unhandledRejection", onUnhandled);
    network = await new Network().start();
    [clamd, toxi, pg] = await Promise.all([
      new GenericContainer(CLAMD_IMAGE)
        .withNetwork(network)
        .withNetworkAliases("clamd")
        .withEnvironment({
          // The image's bundled signatures; freshclam would hit the rate-limited CDN.
          CLAMAV_NO_FRESHCLAMD: "true",
          // The image's init writes CLAMD_CONF_<Option> into /etc/clamav/clamd.conf.
          CLAMD_CONF_StreamMaxLength: "2M",
        })
        // Printed once clamd has loaded its signatures and opened its sockets.
        .withWaitStrategy(Wait.forLogMessage(/socket found, clamd started/u))
        .withStartupTimeout(600_000)
        .start(),
      new ToxiProxyContainer(TOXIPROXY_IMAGE).withNetwork(network).start(),
      startPostgres({ sources: [] }),
    ]);
    clamdProxy = await toxi.createProxy({ name: "clamd", upstream: "clamd:3310" });
    mailer = createMemoryMailer();
    const config = loadConfig({
      env: {
        APP_ENV: "test",
        LOG_LEVEL: "warn",
        BASE_URL: BASE,
        DATABASE_URL: pg.connectionString,
        FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
        STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
        DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
        TENANCY_MODE: "multi",
        ROLES: "api,web,worker",
        OUTBOX_POLL_INTERVAL_MS: "200",
        JOBS_POLL_INTERVAL_MS: "500",
        AV_DRIVER: "clamd",
        CLAMD_HOST: clamdProxy.host,
        CLAMD_PORT: String(clamdProxy.port),
        CLAMD_TIMEOUT_MS: "60000",
        AV_MAX_SCAN_BYTES: String(AV_MAX),
        METRICS_ENABLED: "true",
        METRICS_TOKEN,
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
    owner = await member("owner@example.com", "owner");
    editor = await member("editor@example.com", "editor");
    const tree = (await (
      await request("/api/v1/data-room/tree", { cookie: owner.cookie })
    ).json()) as {
      rootId: string;
    };
    const res = await request("/api/v1/data-room/folders", {
      method: "POST",
      cookie: editor.cookie,
      body: JSON.stringify({ parentId: tree.rootId, name: "Scanned" }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { folders: { id: string; name: string }[] };
    folderId = created.folders.find((f) => f.name === "Scanned")?.id ?? "";
    expect(folderId).not.toBe("");
  }, 900_000);

  afterAll(async () => {
    process.off("unhandledRejection", onUnhandled);
    await running?.stop();
    await pg?.stop();
    await toxi?.stop();
    await clamd?.stop();
    await network?.stop();
  }, 120_000);

  it("a. EICAR (as a .csv) is quarantined: infected, never served, scan_infected published", async () => {
    const up = await upload("payload.csv", new TextEncoder().encode(EICAR));
    const d = await ingested(up.documentId);
    expect(d.scan).toMatchObject({ status: "infected" });
    expect(d.scan?.engine).toMatch(/^clamd/u);
    expect(d.availability.reason).toBe("infected");
    expect((await download(up.documentId)).status).toBe(403);
    const blob = await blobOf(up.versionId);
    expect(blob.scan_status).toBe("infected");
    expect(blob.scan_detail).toMatch(/Eicar/iu);
    const events = await until("document.scan_infected", async () => {
      const rows = await outbox("document.scan_infected", up.versionId);
      return rows.length > 0 ? rows : undefined;
    });
    expect(events[0]).toMatchObject({ documentId: up.documentId, blobId: blob.id });
  });

  it("b. a clean file is scanned clean and served byte for byte", async () => {
    const bytes = csvOf(256 * 1024, "clean");
    const up = await upload("ledger.csv", bytes);
    const d = await ingested(up.documentId);
    expect(d.scan).toMatchObject({ status: "clean" });
    expect((await blobOf(up.versionId)).scan_status).toBe("clean");
    const res = await download(up.documentId);
    expect(res.status).toBe(200);
    const served = new Uint8Array(await res.arrayBuffer());
    expect(served.byteLength).toBe(bytes.byteLength);
    expect(Buffer.compare(Buffer.from(served), Buffer.from(bytes))).toBe(0);
  });

  it("c. over clamd's StreamMaxLength: a final too_large error, no retry; over AV_MAX_SCAN_BYTES: 413", async () => {
    const bytes = csvOf(STREAM_MAX + MiB, "too-big-for-clamd");
    expect(bytes.byteLength).toBeLessThan(AV_MAX);
    const up = await upload("big.csv", bytes);
    const d = await ingested(up.documentId);
    expect(d.scan).toMatchObject({ status: "error" });
    expect(d.availability).toEqual({ viewable: false, download: null, reason: "failed" });
    const blob = await blobOf(up.versionId);
    expect(blob.scan_status).toBe("error");
    expect(blob.scan_detail).toMatch(/^too_large:/u);
    const job = await until("the ingest job to complete", async () => {
      const j = await ingestJob(up.versionId);
      return j.state === "completed" ? j : undefined;
    });
    expect(job.retry_count).toBe(0);
    const events = await outbox("document.ingested", up.versionId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ documentId: up.documentId, scanStatus: "error" });
    expect((await download(up.documentId)).status).toBe(403);

    // Bigger than AV_MAX_SCAN_BYTES: refused before a byte is uploaded.
    const huge = await startUpload("huge.csv", csvOf(AV_MAX + MiB, "huge"));
    expect(huge.status).toBe(413);
    const body = (await huge.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payload_too_large");
  });

  it("d. /metrics shows clamd up and the infected scan", async () => {
    // Before the outage below: the probe container.start() ran found clamd answering.
    const text = await until("fundroom_avscan_up 1", async () => {
      const t = await metricsText();
      return series(t, "fundroom_avscan_up", { driver: "clamd" }) === 1 ? t : undefined;
    });
    expect(
      series(text, "fundroom_avscan_scans_total", { verdict: "infected", source: "data-room" }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      series(text, "fundroom_avscan_scans_total", { verdict: "clean", source: "data-room" }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      series(text, "fundroom_avscan_errors_total", { kind: "too_large", source: "data-room" }),
    ).toBeGreaterThanOrEqual(1);
    expect(unhandled).toEqual([]);
  });
  it("e. clamd cut mid-scan: the process lives on, the blob stays scanning while the job retries, then scans clean", async () => {
    // Stall everything the product sends clamd, so the scan is provably in flight when cut.
    await clamdProxy.instance.addToxic({
      name: "stall",
      type: "timeout",
      stream: "upstream",
      toxicity: 1,
      attributes: { timeout: 0 },
    });
    let versionId = "";
    try {
      const bytes = csvOf(STREAM_MAX - 256 * 1024, "cut-mid-scan");
      const up = await upload("cut.csv", bytes);
      versionId = up.versionId;
      await until("the blob to be scanning", async () =>
        (await blobOf(versionId)).scan_status === "scanning" ? true : undefined,
      );
      await new Promise((r) => setTimeout(r, 1_000));
      // Disabling the proxy closes every connection through it: clamd vanished mid-stream.
      await clamdProxy.setEnabled(false);
      // Retryable and attempts left: the blob stays `scanning` (Processing), with the reason.
      const failed = await until("the scan to fail", async () => {
        const b = await blobOf(versionId);
        return b.scan_detail !== null ? b : undefined;
      });
      expect(failed.scan_status).toBe("scanning");
      expect(failed.scan_detail).toMatch(/^unavailable/u);
      // Retryable: the job goes back to pg-boss for another attempt.
      const job = await until("the ingest job to be retried", async () => {
        const j = await ingestJob(versionId);
        return j.state === "retry" || j.retry_count > 0 ? j : undefined;
      });
      expect(job.state).not.toBe("completed");
      // The process is alive: an unrelated request is served normally.
      const me = await request("/api/v1/data-room/tree", { cookie: owner.cookie });
      expect(me.status).toBe(200);
    } finally {
      await toxi.client.reset();
    }
    // clamd is back; the retry (15 s back-off) scans the same bytes clean.
    const clean = await until(
      "the retry to scan clean",
      async () => {
        const b = await blobOf(versionId);
        return b.scan_status === "clean" ? b : undefined;
      },
      120_000,
    );
    expect(clean.scan_detail).toBeNull();
    expect(
      series(await metricsText(), "fundroom_avscan_errors_total", {
        kind: "unavailable",
        source: "data-room",
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(unhandled).toEqual([]);
  });
});
