import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createMemoryAccreditationAdapter } from "@fundroom/accreditation/testing";
import { createFakeModel } from "@fundroom/ai/testing";
import { createWorkspace, systemContext, type TenantContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryESignAdapter } from "@fundroom/esign/testing";
import { createFakeVendor } from "@fundroom/integrations/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { AiTaskDefinition, ModuleManifest } from "@fundroom/module-kit";
import type { JsonObject, ModelResult } from "@fundroom/ports";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  BASE,
  CANON,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
} from "./test/esign-harness.js";

/*
 * Plan entitlements for the vendor and content features (A-3 / E-UP-2, ADR-0063; owner B2): `ai`,
 * `esign`, `accreditation`, `integrations`, `qa`, `forensic`, on a real server and database with
 * CONTROL_PLANE=on and the in-memory vendors.
 *
 * For every gated route: a plan that includes the feature behaves as before; a plan without it
 * answers 402 `plan_limit` `{ limit: "feature", feature }` and stores nothing; toggles are gated on
 * their off→on transition only (keeping a toggle on, or changing other fields, passes); what is
 * already set up keeps working after a downgrade (envelopes, verifications, KPI syncs, Q&A for
 * investors, forensic marks and detection); anonymous callers, investors and staff without the
 * permission get exactly the status they got before (no oracle); and nothing is gated without a
 * plan or with CONTROL_PLANE=off. The `ai.run` job refuses (`plan_limit`) a request queued before
 * the workspace lost AI, without calling the model.
 *
 * No worker: jobs (`ai.run`, `data-room.ingest`) run in-process, deterministically.
 */

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let env: ReturnType<typeof freshSecrets>;
const h = harness(
  () => running,
  () => mailer,
);
const { request, member, sql, runJob } = h;

const esignVendor = createMemoryESignAdapter("docuseal");
const accreditationVendor = createMemoryAccreditationAdapter("verifyinvestor");
const stripe = createFakeVendor("stripe");
const xero = createFakeVendor("xero");
// Two organisations on the grant, so choosing one (`PUT …/account`) has something to choose.
xero.accounts = [
  { id: "tenant-a", name: "Tenant A" },
  { id: "tenant-b", name: "Tenant B" },
];
const ESIGN_ADAPTERS = {
  docuseal: esignVendor.definition,
  "dropbox-sign": createMemoryESignAdapter("dropbox-sign").definition,
};
const ACCREDITATION_ADAPTERS = {
  verifyinvestor: accreditationVendor.definition,
  "parallel-markets": createMemoryAccreditationAdapter("parallel-markets").definition,
};
/** Xero's OAuth client, so the OAuth connect path runs end to end against the fake vendor. */
const XERO_CLIENT = {
  INTEGRATIONS_XERO_CLIENT_ID: "xero-client",
  INTEGRATIONS_XERO_CLIENT_SECRET: "xero-secret-value",
};

// sharp lives with the renderer adapter; borrowed to re-encode a served page like a leaker would.
interface SharpChain {
  jpeg(o: { quality: number }): SharpChain;
  toBuffer(): Promise<Buffer>;
}
const sharp = createRequire(import.meta.resolve("@fundroom/render-pdfium"))("sharp") as (
  input: Uint8Array,
) => SharpChain;

// --- the fake model and test AI tasks (the kernel is what is under test, not the real tasks) -----

const ok = (text: string): ModelResult => ({
  text,
  finish: "stop",
  usage: { inputTokens: 10, outputTokens: 5 },
  model: "fake",
});
const fake = createFakeModel({ respond: () => ok('{"title":"Q3 update"}') });
const DraftParams = z.object({ notes: z.union([z.string(), z.null()]) }).passthrough();
const draftTask: AiTaskDefinition = {
  feature: "update_draft",
  permission: "updates.manage",
  paramsSchema: DraftParams as unknown as z.ZodType<JsonObject>,
  async prepare(_ctx, input) {
    return {
      kind: "prompt",
      system: "SYS",
      user: `<notes>${String(DraftParams.parse(input.params).notes)}</notes>`,
      json: { name: "draft", schema: { type: "object" } },
    };
  },
  async finish(_ctx, _input, _prompt, output) {
    const title = (output.json as { title?: unknown }).title;
    return {
      kind: "result",
      result: {
        kind: "update_draft",
        title: typeof title === "string" ? title : "untitled",
        doc: { sections: [] },
        kpiDefinitionIds: [],
        sources: { kpis: false, lastUpdate: null },
      },
    };
  },
};
const qaTask: AiTaskDefinition = {
  feature: "qa_answer",
  permission: "data-room.qa_answer",
  paramsSchema: z.object({}).passthrough() as unknown as z.ZodType<JsonObject>,
  async prepare() {
    return { kind: "refused", code: "no_sources" };
  },
  async finish() {
    return { kind: "refused", code: "no_sources" };
  },
};
const MODULES: readonly ModuleManifest[] = COMPILED_IN_MODULES.map((m) =>
  m.id === "updates"
    ? { ...m, aiTasks: () => [draftTask] }
    : m.id === "data-room"
      ? { ...m, aiTasks: () => [qaTask] }
      : m,
);

// --- plans ----------------------------------------------------------------------------------------

const B2_FEATURES = ["accreditation", "ai", "esign", "forensic", "integrations", "qa"] as const;
type B2Feature = (typeof B2_FEATURES)[number];
/** Lists exactly the six features (and, absent `modules`, every module). */
const VENDORS = "vendors";
/** No feature at all (every module: `modules` absent, so module read-only never interferes). */
const NONE = "nofeatures";

async function setPlan(planId: string | null): Promise<void> {
  await running.container.db.withHost((tx) =>
    tx.execute(
      `UPDATE core.workspace SET plan_id = ${planId === null ? "NULL" : `'${planId}'`}
        WHERE id = '${acmeId}'`,
    ),
  );
  running.container.resolver.invalidate();
}

interface PlanLimitBody {
  error: {
    code: string;
    limit?: string;
    feature?: string;
    max?: unknown;
    message: string;
    requestId?: string;
  };
}

/** The exact 402 of a feature outside the plan (A-3 §2). */
async function expectFeature402(res: Response, feature: B2Feature): Promise<void> {
  const text = await res.clone().text();
  expect(res.status, text).toBe(402);
  const body = await json<PlanLimitBody>(res);
  expect(body.error).toMatchObject({
    code: "plan_limit",
    limit: "feature",
    feature,
    message: `the workspace's plan does not include the ${feature} feature`,
  });
  expect(body.error).not.toHaveProperty("max");
}

// --- actors and helpers ---------------------------------------------------------------------------

let acmeId: string;
let owner: Actor;
let viewer: Actor;
let ada: Actor;
const users = new Map<string, string>();
const anonymous: Actor = { membershipId: "", cookie: "" };

/** Every live session of `a` counts as freshly authenticated (the `fresh` step-up window). */
async function markFresh(a: Actor): Promise<void> {
  await pg.pool.query(
    `UPDATE core.session SET auth_time = now()
      WHERE user_id = (SELECT user_id FROM core.membership WHERE id = $1::uuid)
        AND revoked_at IS NULL`,
    [a.membershipId],
  );
}

const call = (
  a: Actor,
  method: string,
  path: string,
  body?: unknown,
  via?: RunningServer,
): Promise<Response> =>
  request("acme", `/api/v1${path}`, {
    method,
    ...(a.cookie === "" ? {} : { cookie: a.cookie }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(via === undefined ? {} : { server: via }),
  });

function staffCtx(a: Actor): TenantContext {
  return {
    workspaceId: acmeId,
    actorKind: "staff",
    membershipId: a.membershipId,
    userId: users.get(a.membershipId) ?? "",
  };
}

const aiOn = { enabled: true, features: { updateDraft: true, qaAnswer: true } };
const putAi = (body: Record<string, unknown>, a: Actor = owner, via?: RunningServer) =>
  call(
    a,
    "PUT",
    "/ai/settings",
    { ...aiOn, monthlyTokenBudget: null, acknowledge: false, ...body },
    via,
  );

interface AiStatusBody {
  settings: { enabled: boolean; features: { updateDraft: boolean; qaAnswer: boolean } };
  effective: { updateDraft: boolean; qaAnswer: boolean };
  planAllows: boolean;
}
async function aiStatus(via?: RunningServer): Promise<AiStatusBody> {
  const res = await call(owner, "GET", "/ai/status", undefined, via);
  expect(res.status).toBe(200);
  return json<AiStatusBody>(res);
}

const patchSettings = (body: Record<string, unknown>, a: Actor = owner, via?: RunningServer) =>
  call(a, "PATCH", "/data-room/settings", body, via);

async function dataRoomSettings(): Promise<{
  forensicByDefault: boolean;
  qa: { enabled: boolean; slaHours: number };
  purgeAfterDays: number;
}> {
  const res = await call(owner, "GET", "/data-room/settings");
  expect(res.status).toBe(200);
  return json(res);
}

const patchDocument = (id: string, body: Record<string, unknown>, via?: RunningServer) =>
  call(owner, "PATCH", `/data-room/documents/${id}`, body, via);

async function protectionOf(id: string): Promise<Record<string, boolean>> {
  const { rows } = await pg.pool.query<{ protection: Record<string, boolean> }>(
    "SELECT protection FROM dataroom.document WHERE id = $1",
    [id],
  );
  return rows[0]?.protection ?? {};
}

/** A text-and-table page with enough structure to register a re-encoded copy onto (detect). */
async function makePdf(marker: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  page.drawText(`${marker} — confidential`, { x: 50, y: 730, size: 22, font: bold });
  for (let i = 0; i < 26; i++) {
    page.drawText(
      `${i + 1}. Revenue grew ${(i * 7) % 31}% in Q${(i % 4) + 1}; burn ${(i * 13) % 97}k; runway ${12 + (i % 9)} months.`,
      { x: 50, y: 690 - i * 18, size: 11, font },
    );
  }
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 4; c++) {
      page.drawRectangle({
        x: 50 + c * 125,
        y: 140 - r * 18,
        width: 125,
        height: 18,
        borderColor: rgb(0.2, 0.2, 0.2),
        borderWidth: 0.8,
        color: (r + c) % 2 === 0 ? rgb(0.92, 0.94, 0.98) : rgb(1, 1, 1),
      });
      page.drawText(`${r * 4 + c}`, { x: 56 + c * 125, y: 145 - r * 18, size: 9, font });
    }
  }
  return doc.save();
}

/** Uploads a PDF (tus) and runs its ingest (scan + render) in-process. */
async function upload(folderId: string, fileName: string, bytes: Uint8Array): Promise<string> {
  const start = await call(owner, "POST", "/data-room/uploads", {
    fileName,
    size: bytes.byteLength,
    contentType: "application/pdf",
    folderId,
  });
  expect(start.status, await start.clone().text()).toBe(201);
  const started = await json<{ upload: { id: string }; tus: { path: string } | null }>(start);
  const endpoint = `/api/v1${started.tus?.path ?? ""}`;
  const meta = `upload ${Buffer.from(started.upload.id).toString("base64")},filename ${Buffer.from(fileName).toString("base64")}`;
  const create = await request("acme", endpoint, {
    method: "POST",
    cookie: owner.cookie,
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(bytes.byteLength),
      "Upload-Metadata": meta,
      "content-type": "application/offset+octet-stream",
    },
    body: new Uint8Array(0),
  });
  expect(create.status).toBe(201);
  const patch = await request("acme", `${endpoint}/${started.upload.id}`, {
    method: "PATCH",
    cookie: owner.cookie,
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": "0",
      "content-type": "application/offset+octet-stream",
    },
    body: bytes as Uint8Array<ArrayBuffer>,
  });
  expect(patch.status).toBe(204);
  const complete = await call(
    owner,
    "POST",
    `/data-room/uploads/${started.upload.id}/complete`,
    {},
  );
  expect(complete.status, await complete.clone().text()).toBe(200);
  const done = await json<{ document: { id: string }; version: { id: string } }>(complete);
  const { rows } = await pg.pool.query<{ data: JsonObject }>(
    "SELECT data FROM pgboss.job WHERE name = 'data-room.ingest' AND data->>'versionId' = $1",
    [done.version.id],
  );
  expect(rows).toHaveLength(1);
  await runJob("data-room.ingest", rows[0]?.data ?? {});
  const detail = await json<{ currentVersion: { renderStatus: string } | null }>(
    await call(owner, "GET", `/data-room/documents/${done.document.id}`),
  );
  expect(detail.currentVersion?.renderStatus).toBe("ready");
  return done.document.id;
}

/** A multipart POST as the owner (the harness would label any body JSON). */
async function multipart(path: string, form: FormData): Promise<Response> {
  const host = `acme.${CANON}`;
  return await running.app.request(`http://${host}${path}`, {
    method: "POST",
    headers: { host, cookie: owner.cookie, origin: `http://${host}` },
    body: form,
  });
}

/**
 * The no-oracle walk: each gated call, made by an anonymous caller, an investor and a staff member
 * without the permission, answers the same status under a plan with the feature and one without —
 * and never 402.
 */
async function expectNoOracle(
  calls: readonly { method: string; path: string; body?: unknown }[],
): Promise<void> {
  const callers = { anonymous, investor: ada, viewer };
  const statuses = async () => {
    const out: string[] = [];
    for (const [name, a] of Object.entries(callers)) {
      for (const c of calls) {
        const res = await call(a, c.method, c.path, c.body);
        out.push(`${name} ${c.method} ${c.path} ${res.status}`);
      }
    }
    return out;
  };
  await setPlan(VENDORS);
  const allowed = await statuses();
  await setPlan(NONE);
  const refused = await statuses();
  expect(refused).toEqual(allowed);
  expect(refused.filter((s) => s.endsWith(" 402"))).toEqual([]);
  expect(refused.filter((s) => / 2\d\d$/u.test(s))).toEqual([]);
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  env = freshSecrets(pg.connectionString);
  running = await startServer({
    config: esignTestConfig(env, { ROLES: "api,web", CONTROL_PLANE: "on", ...XERO_CLIENT }),
    logger: createLogger({ level: "error" }),
    mailer,
    modules: MODULES,
    aiModel: fake,
    esignAdapters: ESIGN_ADAPTERS,
    accreditationAdapters: ACCREDITATION_ADAPTERS,
    integrationAdapters: { stripe: () => stripe.adapter, xero: () => xero.adapter },
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  owner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");
  viewer = await member("acme", acmeId, "viewer@acme.test", "staff", "viewer");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  const [row] = await sql<{ user_id: string }>(
    acmeId,
    `SELECT user_id::text FROM core.membership WHERE id = '${owner.membershipId}'`,
  );
  users.set(owner.membershipId, row?.user_id ?? "");
  await running.container.db.withHost((tx) =>
    tx.execute(
      `INSERT INTO core.plan (id, name, limits, limits_schema_version) VALUES
         ('${VENDORS}', 'Vendors', '${JSON.stringify({ features: B2_FEATURES })}', 2),
         ('${NONE}', 'No features', '{"features":[]}', 2)`,
    ),
  );
  await setPlan(VENDORS);
}, 300_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

beforeEach(async () => {
  for (const a of [owner, viewer]) await markFresh(a);
});

// --- AI ---------------------------------------------------------------------------------------------

describe("ai", () => {
  it("a plan with AI: settings turn on, status says planAllows, the draft route starts", async () => {
    await setPlan(VENDORS);
    expect((await aiStatus()).planAllows).toBe(true);
    const on = await putAi({ acknowledge: true });
    expect(on.status, await on.clone().text()).toBe(200);
    expect((await json<AiStatusBody>(on)).planAllows).toBe(true);
    const draft = await call(owner, "POST", "/updates/ai/draft", {
      notes: "grew",
      template: "blank",
    });
    expect(draft.status, await draft.clone().text()).toBe(202);
  });

  it("without AI: every start is 402; status reports planAllows false and keeps the settings", async () => {
    await setPlan(NONE);
    const s = await aiStatus();
    expect(s.planAllows).toBe(false);
    expect(s.settings).toMatchObject(aiOn);
    expect(s.effective).toEqual({ updateDraft: true, qaAnswer: true });
    await expectFeature402(
      await call(owner, "POST", "/updates/ai/draft", { notes: "again", template: "blank" }),
      "ai",
    );
    // The kernel itself refuses, whoever calls it.
    const error = await running.container.ai
      .start(staffCtx(owner), {
        feature: "update_draft",
        subjectId: null,
        params: { notes: "direct" },
        actor: { membershipId: owner.membershipId, userId: users.get(owner.membershipId) ?? "" },
      })
      .then(
        () => undefined,
        (e: unknown) => e as { code?: string; status?: number; details?: unknown },
      );
    expect(error).toMatchObject({
      code: "plan_limit",
      status: 402,
      details: { limit: "feature", feature: "ai" },
    });
  });

  it("without AI: settings that keep or turn things off pass; turning AI or a feature on is 402", async () => {
    await setPlan(NONE);
    expect((await putAi({})).status).toBe(200); // keeps both on
    expect((await putAi({ monthlyTokenBudget: 1_000_000 })).status).toBe(200);
    const one = await putAi({ features: { updateDraft: false, qaAnswer: true } });
    expect(one.status).toBe(200);
    await expectFeature402(await putAi({}), "ai"); // updateDraft back on
    expect((await putAi({ enabled: false })).status).toBe(200);
    // A flag on while AI stays off turns nothing on.
    expect((await putAi({ enabled: false, features: aiOn.features })).status).toBe(200);
    // AI back on, although the provider is still acknowledged.
    await expectFeature402(await putAi({}), "ai");
    expect((await aiStatus()).settings.enabled).toBe(false);
    // And with the plan back, the same write goes through.
    await setPlan(VENDORS);
    expect((await putAi({})).status).toBe(200);
  });

  it("ai.run refuses (plan_limit) a request queued before the downgrade, without the model", async () => {
    await setPlan(VENDORS);
    const actor = { membershipId: owner.membershipId, userId: users.get(owner.membershipId) ?? "" };
    const queued = await running.container.ai.start(staffCtx(owner), {
      feature: "update_draft",
      subjectId: null,
      params: { notes: `queued ${randomUUID()}` },
      actor,
    });
    await setPlan(NONE);
    const calls = fake.calls.length;
    await runJob("ai.run", { requestId: queued.requestId, workspaceId: acmeId });
    expect(fake.calls.length).toBe(calls);
    const [row] = await sql<{ status: string; error_code: string | null; result: unknown }>(
      acmeId,
      `SELECT status, error_code, result FROM core.ai_request WHERE id = '${queued.requestId}'`,
    );
    expect(row).toEqual({ status: "refused", error_code: "plan_limit", result: null });

    // The same job with the feature on the plan runs as before.
    await setPlan(VENDORS);
    const next = await running.container.ai.start(staffCtx(owner), {
      feature: "update_draft",
      subjectId: null,
      params: { notes: `allowed ${randomUUID()}` },
      actor,
    });
    await runJob("ai.run", { requestId: next.requestId, workspaceId: acmeId });
    expect(fake.calls.length).toBe(calls + 1);
    const [done] = await sql<{ status: string }>(
      acmeId,
      `SELECT status FROM core.ai_request WHERE id = '${next.requestId}'`,
    );
    expect(done?.status).toBe("done");
  });

  it("past requests stay readable after the downgrade", async () => {
    await setPlan(NONE);
    const [row] = await sql<{ id: string }>(
      acmeId,
      `SELECT id::text FROM core.ai_request WHERE status = 'done' LIMIT 1`,
    );
    const res = await call(owner, "GET", `/ai/requests/${row?.id}`);
    expect(res.status).toBe(200);
    expect((await json<{ status: string }>(res)).status).toBe("done");
    await setPlan(VENDORS);
  });

  it("no oracle: anonymous, investor and viewer get today's status on the gated AI routes", async () => {
    await expectNoOracle([
      {
        method: "PUT",
        path: "/ai/settings",
        body: { ...aiOn, monthlyTokenBudget: null, acknowledge: true },
      },
      { method: "POST", path: "/updates/ai/draft", body: { notes: "x", template: "blank" } },
    ]);
  });
});

// --- e-sign -----------------------------------------------------------------------------------------

describe("esign", () => {
  const connect = (driver = "docuseal", apiToken = "docuseal-token-abcd1234") =>
    call(owner, "PUT", "/esign/connection", { driver, credentials: { apiToken } });
  const liveConnections = async () =>
    sql<{ id: string; driver: string }>(
      acmeId,
      "SELECT id::text, driver FROM core.esign_connection WHERE deleted_at IS NULL",
    );

  it("without e-sign: a new connection is 402, nothing stored; verify is never gated", async () => {
    await setPlan(NONE);
    await expectFeature402(await connect(), "esign");
    expect(await liveConnections()).toEqual([]);
    const verify = await call(owner, "POST", "/esign/connection/verify");
    expect(verify.status).not.toBe(402);
    expect(verify.status).toBeGreaterThanOrEqual(400); // nothing to verify yet
    // Reading is never gated.
    const read = await call(owner, "GET", "/esign/connection");
    expect(read.status).toBe(200);
    expect(await json(read)).toEqual({ connection: null });
  });

  it("no oracle on the gated e-sign route", async () => {
    await expectNoOracle([
      {
        method: "PUT",
        path: "/esign/connection",
        body: { driver: "docuseal", credentials: { apiToken: "docuseal-token-abcd1234" } },
      },
    ]);
  });

  it("after a downgrade: re-key and verify pass, a driver switch is 402, the connection keeps working", async () => {
    await setPlan(VENDORS);
    const saved = await connect();
    expect(saved.status, await saved.clone().text()).toBe(200);
    const { connection } = await json<{ connection: { id: string } }>(saved);

    await setPlan(NONE);
    // Maintenance: re-verifying and re-keying the live connection (a leaked token is rotatable).
    expect((await call(owner, "POST", "/esign/connection/verify")).status).toBe(200);
    const rekeyed = await connect("docuseal", "docuseal-token-rotated-5678");
    expect(rekeyed.status, await rekeyed.clone().text()).toBe(200);
    expect((await json<{ connection: { id: string } }>(rekeyed)).connection.id).toBe(connection.id);
    // A different driver is a new connection: refused, and the live one is untouched.
    await expectFeature402(await connect("dropbox-sign", "dbx-token-5678"), "esign");
    expect(await liveConnections()).toEqual([{ id: connection.id, driver: "docuseal" }]);
    // An envelope still goes out through the existing connection.
    const envelope = await running.container.esign.request(systemContext(acmeId), {
      purpose: "round_closing",
      subject: { module: "round", kind: "commitment", id: randomUUID() },
      signer: { name: "Ada", email: "ada@investor.test", membershipId: ada.membershipId },
      title: "Subscription agreement",
      document: { kind: "template", templateRef: "tpl-1", prefill: {} },
      vaultFolder: "Signed documents/Seed",
      embedded: false,
      requestedByMembershipId: owner.membershipId,
    });
    expect(envelope.status).toBe("sent");
    // Rotating the callback secret, voiding and disconnecting are never gated.
    expect((await call(owner, "POST", "/esign/connection/rotate-callback-secret")).status).toBe(
      200,
    );
    const voided = await call(owner, "POST", `/esign/envelopes/${envelope.id}/void`, {
      reason: "downgrade test",
    });
    expect(voided.status, await voided.clone().text()).toBe(200);
    const removed = await call(owner, "DELETE", "/esign/connection");
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await liveConnections()).toEqual([]);
    // ...and connecting again is a new connection.
    await expectFeature402(await connect(), "esign");
  });

  it("no plan: nothing is gated", async () => {
    await setPlan(null);
    const saved = await connect();
    expect(saved.status, await saved.clone().text()).toBe(200);
    expect((await call(owner, "DELETE", "/esign/connection")).status).toBe(200);
    await setPlan(VENDORS);
  });
});

// --- accreditation ------------------------------------------------------------------------------

describe("accreditation", () => {
  const credentials = {
    apiToken: "vi-api-token-0123456789-wxyz",
    webhookSecret: "vi-webhook-secret-abcdef-9876",
    environment: "staging",
    portalName: "Acme",
  };
  const connect = (creds: Record<string, string> = credentials) =>
    call(owner, "PUT", "/accreditation/connection", {
      driver: "verifyinvestor",
      credentials: creds,
    });
  const liveConnections = async () =>
    (
      await pg.pool.query<{ id: string; driver: string }>(
        `SELECT id::text, driver FROM core.accreditation_connection
          WHERE workspace_id = $1 AND deleted_at IS NULL`,
        [acmeId],
      )
    ).rows;

  it("without accreditation: a new connection is 402; verify is never gated", async () => {
    await setPlan(NONE);
    await expectFeature402(await connect(), "accreditation");
    expect(await liveConnections()).toEqual([]);
    const verify = await call(owner, "POST", "/accreditation/connection/verify");
    expect(verify.status).not.toBe(402);
    expect(verify.status).toBeGreaterThanOrEqual(400); // nothing to verify yet
    const read = await call(owner, "GET", "/accreditation/connection");
    expect(read.status).toBe(200);
    expect((await json<{ connection: unknown }>(read)).connection).toBeNull();
  });

  it("no oracle on the gated accreditation route", async () => {
    await expectNoOracle([
      {
        method: "PUT",
        path: "/accreditation/connection",
        body: { driver: "verifyinvestor", credentials },
      },
    ]);
  });

  it("after a downgrade: re-key and verify pass, a vendor switch is 402, verifications still run", async () => {
    await setPlan(VENDORS);
    const saved = await connect();
    expect(saved.status, await saved.clone().text()).toBe(200);
    const { connection } = await json<{ connection: { id: string } }>(saved);

    await setPlan(NONE);
    expect((await call(owner, "POST", "/accreditation/connection/verify")).status).toBe(200);
    const rekeyed = await connect({ ...credentials, apiToken: "vi-api-token-rotated-0000-abcd" });
    expect(rekeyed.status, await rekeyed.clone().text()).toBe(200);
    expect((await json<{ connection: { id: string } }>(rekeyed)).connection.id).toBe(connection.id);
    const pm = await call(owner, "PUT", "/accreditation/connection", {
      driver: "parallel-markets",
      credentials: {
        apiKey: "pm-api-key-0123456789-qrst",
        clientId: "client-1",
        webhookSigningKey: "pm-signing-key-0123456789-lmno",
        environment: "demo",
      },
    });
    await expectFeature402(pm, "accreditation");
    expect(await liveConnections()).toEqual([{ id: connection.id, driver: "verifyinvestor" }]);

    const service = running.container.moduleServices.accreditation;
    const ctx = systemContext(acmeId);
    expect((await service.effective(undefined, ctx)).driver).toBe("verifyinvestor");
    const started = await service.start(ctx, {
      driver: "verifyinvestor",
      verificationId: randomUUID(),
      subject: "individual",
      email: "ada@investor.test",
      portalName: "Acme",
    });
    expect(started.handoff).toEqual({ kind: "invite_sent" });
    accreditationVendor.vendor.accredit(started.providerRef);
    expect(
      await service.check(ctx, { driver: "verifyinvestor", providerRef: started.providerRef }),
    ).toMatchObject({ status: "accredited" });
    expect((await call(owner, "DELETE", "/accreditation/connection")).status).toBe(200);
    await expectFeature402(await connect(), "accreditation");
    await setPlan(VENDORS);
  });
});

// --- integrations -------------------------------------------------------------------------------

describe("integrations", () => {
  const connectStripe = (key = "rk_test_51PlanEntitlements") =>
    call(owner, "POST", "/integrations/stripe/connect", { credentials: { restrictedKey: key } });
  const BOGUS_PENDING = { pendingToken: "A".repeat(43) };
  const gated = [
    {
      method: "POST",
      path: "/integrations/stripe/connect",
      body: { credentials: { restrictedKey: "rk_test_51PlanEntitlements" } },
    },
    { method: "POST", path: "/integrations/xero/oauth/begin", body: {} },
    { method: "POST", path: "/integrations/xero/oauth/complete", body: BOGUS_PENDING },
  ] as const;
  const live = async (provider: string) =>
    sql<{ id: string }>(
      acmeId,
      `SELECT id::text FROM core.integration_connection
        WHERE provider = '${provider}' AND deleted_at IS NULL`,
    );

  /** A GET on the canonical host (the ops tree), as a browser would send it. */
  const ops = async (url: string, cookie?: string): Promise<Response> => {
    const headers = new Headers({ host: CANON });
    if (cookie !== undefined) headers.set("cookie", cookie);
    return await running.app.request(url, { headers, redirect: "manual" });
  };
  /** begin → start → vendor consent → callback: the one-time pending token (not yet confirmed). */
  async function xeroPending(): Promise<string> {
    const begun = await call(owner, "POST", "/integrations/xero/oauth/begin", {});
    expect(begun.status, await begun.clone().text()).toBe(200);
    const started = await ops((await json<{ startUrl: string }>(begun)).startUrl);
    expect(started.status).toBe(302);
    const state = new URL(started.headers.get("location") ?? "").searchParams.get("state") ?? "";
    const binding =
      started.headers
        .getSetCookie()
        .find((c) => c.startsWith("sh_intg="))
        ?.split(";")[0] ?? "";
    const url = new URL(`${BASE}/oauth/integrations/callback`);
    url.searchParams.set("code", xero.code);
    url.searchParams.set("state", state);
    const landed = await ops(url.href, binding);
    expect(landed.status).toBe(302);
    const to = new URL(landed.headers.get("location") ?? "");
    expect(to.searchParams.get("result"), to.href).toBe("pending");
    return new URLSearchParams(to.hash.slice(1)).get("pending") ?? "";
  }
  const complete = (pendingToken: string) =>
    call(owner, "POST", "/integrations/xero/oauth/complete", { pendingToken });

  it("without integrations: connecting a provider the workspace has not connected is 402", async () => {
    await setPlan(NONE);
    for (const g of gated.slice(0, 2))
      await expectFeature402(await call(owner, g.method, g.path, g.body), "integrations");
    // An unusable pending token is the same 404 as ever (the plan is asked only for a real grant;
    // see "a confirm refused by the plan" below).
    expect(
      (await call(owner, "POST", "/integrations/xero/oauth/complete", BOGUS_PENDING)).status,
    ).toBe(404);
    expect(await live("stripe")).toEqual([]);
    expect(await live("xero")).toEqual([]);
    // Choosing an account needs a connection, so it is never the plan's question.
    const account = await call(owner, "PUT", "/integrations/xero/account", {
      externalAccountId: "tenant-b",
    });
    expect(account.status).toBe(404);
    expect((await call(owner, "GET", "/integrations/connections")).status).toBe(200);
  });

  it("no oracle on the gated integration routes", async () => {
    await expectNoOracle(gated);
  });

  it("after a downgrade: reconnecting a connected provider passes; syncs, account, verify and disconnect keep working", async () => {
    await setPlan(VENDORS);
    expect((await connectStripe()).status).toBe(200);
    expect((await complete(await xeroPending())).status).toBe(200);
    const [xeroBefore] = await live("xero");

    await setPlan(NONE);
    // Re-keying Stripe and re-authorising Xero are maintenance.
    const rekeyed = await connectStripe("rk_test_51PlanEntitlementsRotated");
    expect(rekeyed.status, await rekeyed.clone().text()).toBe(200);
    const again = await complete(await xeroPending());
    expect(again.status, await again.clone().text()).toBe(200);
    const accounts =
      (await json<{ availableAccounts?: { id: string }[] }>(again)).availableAccounts ?? [];
    const [xeroAfter] = await live("xero");
    expect(xeroAfter?.id).not.toBe(xeroBefore?.id);
    expect(accounts.length).toBeGreaterThan(0);
    const account = await call(owner, "PUT", "/integrations/xero/account", {
      externalAccountId: accounts.at(-1)?.id,
    });
    expect(account.status, await account.clone().text()).toBe(200);
    const kpi = await running.container.integrations.services.readKpi(
      systemContext(acmeId),
      "stripe",
      { metrics: ["revenue"], fromMonth: "2026-01", toMonth: "2026-03" },
    );
    expect(kpi.ok).toBe(true);
    expect((await call(owner, "POST", "/integrations/stripe/verify")).status).toBe(200);
    expect((await call(owner, "DELETE", "/integrations/stripe")).status).toBe(200);
    expect(await live("stripe")).toEqual([]);
    // Disconnected: connecting it again is new.
    await expectFeature402(await connectStripe(), "integrations");
    expect((await call(owner, "DELETE", "/integrations/xero")).status).toBe(200);
    await expectFeature402(
      await call(owner, "POST", "/integrations/xero/oauth/begin", {}),
      "integrations",
    );
    await setPlan(VENDORS);
  });

  it("a confirm refused by the plan does not burn the grant: it connects after an upgrade", async () => {
    await setPlan(VENDORS);
    expect(await live("xero")).toEqual([]);
    const pending = await xeroPending();
    await setPlan(NONE);
    await expectFeature402(await complete(pending), "integrations");
    expect(await live("xero")).toEqual([]);
    await setPlan(VENDORS);
    const done = await complete(pending);
    expect(done.status, await done.clone().text()).toBe(200);
    expect(await live("xero")).toHaveLength(1);
    expect((await call(owner, "DELETE", "/integrations/xero")).status).toBe(200);
  });
});

// --- data room: Q&A and forensic ---------------------------------------------------------------

describe("data room", () => {
  let folderId: string;
  let docId: string;

  beforeAll(async () => {
    await setPlan(VENDORS);
    await markFresh(owner);
    // The noop scanner marks files `skipped`: serve them (also: a settings write of another field).
    expect((await patchSettings({ allowUnscanned: true })).status).toBe(200);
    const tree = await json<{ rootId: string }>(await call(owner, "GET", "/data-room/tree"));
    const made = await call(owner, "POST", "/data-room/folders", {
      parentId: tree.rootId,
      name: "Plans",
    });
    expect(made.status, await made.clone().text()).toBe(201);
    const folder = (
      await json<{ folders: { id: string; name: string; path: string }[] }>(made)
    ).folders.find((f) => f.name === "Plans");
    folderId = folder?.id ?? "";
    const grant = await call(owner, "POST", "/access/grants", {
      subject: { kind: "membership", id: ada.membershipId },
      resource: { kind: "folder", id: folderId, path: folder?.path },
      capabilities: ["view", "download"],
    });
    expect(grant.status, await grant.clone().text()).toBe(200);
    docId = await upload(folderId, "deck.pdf", await makePdf("Acme deck"));
  }, 120_000);

  describe("qa", () => {
    let questionId: string;

    it("without Q&A: turning it on is 402 and nothing changes; other settings still save", async () => {
      await setPlan(NONE);
      await expectFeature402(await patchSettings({ qa: { enabled: true } }), "qa");
      await expectFeature402(
        await patchSettings({ purgeAfterDays: 40, qa: { enabled: true, slaHours: 48 } }),
        "qa",
      );
      const s = await dataRoomSettings();
      expect(s.qa.enabled).toBe(false);
      expect(s.purgeAfterDays).toBe(30);
      const other = await patchSettings({ purgeAfterDays: 40, qa: { slaHours: 48 } });
      expect(other.status, await other.clone().text()).toBe(200);
      expect((await dataRoomSettings()).qa).toMatchObject({ enabled: false, slaHours: 48 });
    });

    it("no oracle on the settings PATCH", async () => {
      await expectNoOracle([
        { method: "PATCH", path: "/data-room/settings", body: { qa: { enabled: true } } },
      ]);
    });

    it("with Q&A: turns on; after a downgrade it stays on for investors and staff", async () => {
      await setPlan(VENDORS);
      expect((await patchSettings({ qa: { enabled: true } })).status).toBe(200);

      await setPlan(NONE);
      // Keeping it on, and changing its other fields, pass.
      expect((await patchSettings({ qa: { enabled: true } })).status).toBe(200);
      expect((await patchSettings({ qa: { enabled: true, slaHours: 24 } })).status).toBe(200);
      const status = await json<{ enabled: boolean; canAsk: boolean }>(
        await call(ada, "GET", "/data-room/qa/status"),
      );
      expect(status).toMatchObject({ enabled: true, canAsk: true });
      const asked = await call(ada, "POST", "/data-room/qa/questions", {
        targetKind: "folder",
        targetId: folderId,
        subject: "Runway",
        body: "How many months of runway?",
      });
      expect(asked.status, await asked.clone().text()).toBe(201);
      questionId = (await json<{ id: string }>(asked)).id;
      const answered = await call(owner, "PUT", `/data-room/qa/inbox/${questionId}/answer`, {
        body: "Eighteen months.",
      });
      expect(answered.status, await answered.clone().text()).toBe(200);
      // Off is always allowed; on again needs the feature.
      expect((await patchSettings({ qa: { enabled: false } })).status).toBe(200);
      await expectFeature402(await patchSettings({ qa: { enabled: true } }), "qa");
      await setPlan(VENDORS);
      expect((await patchSettings({ qa: { enabled: true } })).status).toBe(200);
    });

    it("the AI suggestion route answers the AI plan gate (402), and starts with AI on the plan", async () => {
      await setPlan(VENDORS);
      expect((await putAi({})).status).toBe(200);
      const path = `/data-room/qa/inbox/${questionId}/ai-suggestion`;
      const started = await call(owner, "POST", path);
      expect(started.status, await started.clone().text()).toBe(202);
      await setPlan(NONE);
      await expectFeature402(await call(owner, "POST", path), "ai");
      await setPlan(VENDORS);
    });
  });

  describe("forensic", () => {
    let markedId: string;

    it("without forensic: marking a document and the default are 402; other changes pass", async () => {
      await setPlan(NONE);
      await expectFeature402(
        await patchDocument(docId, { protection: { forensic: true } }),
        "forensic",
      );
      await expectFeature402(
        await patchDocument(docId, { title: "Renamed deck", protection: { forensic: true } }),
        "forensic",
      );
      await expectFeature402(await patchSettings({ forensicByDefault: true }), "forensic");
      expect((await protectionOf(docId))["forensic"]).toBe(false);
      expect((await dataRoomSettings()).forensicByDefault).toBe(false);
      const renamed = await patchDocument(docId, {
        title: "Renamed deck",
        protection: { forensic: false, download: true },
      });
      expect(renamed.status, await renamed.clone().text()).toBe(200);
    });

    it("no oracle on the document PATCH", async () => {
      await expectNoOracle([
        {
          method: "PATCH",
          path: `/data-room/documents/${docId}`,
          body: { protection: { forensic: true } },
        },
      ]);
    });

    it("with forensic: marks a document and turns the default on", async () => {
      await setPlan(VENDORS);
      const on = await patchDocument(docId, { protection: { forensic: true, watermark: true } });
      expect(on.status, await on.clone().text()).toBe(200);
      expect((await protectionOf(docId))["forensic"]).toBe(true);
      expect((await patchSettings({ forensicByDefault: true })).status).toBe(200);
      markedId = docId;
    });

    it("the forensic transition is judged on the locked row: a racing switch-off is not undone", async () => {
      await setPlan(NONE);
      // Another writer switches forensic off and holds the row (uncommitted) while a PATCH that
      // "keeps" it on arrives. Judged on a stale read, the PATCH would pass and restore the mark.
      const other = await pg.pool.connect();
      try {
        await other.query("BEGIN");
        await other.query(
          `UPDATE dataroom.document SET protection = protection || '{"forensic":false}'::jsonb
            WHERE id = $1`,
          [markedId],
        );
        const racing = patchDocument(markedId, { protection: { forensic: true, watermark: true } });
        const deadline = Date.now() + 10_000;
        for (;;) {
          const { rows } = await pg.pool.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          if ((rows[0]?.n ?? 0) > 0) break;
          if (Date.now() > deadline) throw new Error("the PATCH never waited on the row");
          await new Promise((r) => setTimeout(r, 25));
        }
        await other.query("COMMIT");
        await expectFeature402(await racing, "forensic");
      } finally {
        other.release();
      }
      expect((await protectionOf(markedId))["forensic"]).toBe(false);
      await setPlan(VENDORS);
      expect((await patchDocument(markedId, { protection: { forensic: true } })).status).toBe(200);
    });

    it("after a downgrade: marks are still issued and traced, the default still applies", async () => {
      await setPlan(NONE);
      // Keeping the mark on and changing other fields pass.
      expect(
        (await patchDocument(markedId, { title: "Deck v2", protection: { forensic: true } }))
          .status,
      ).toBe(200);
      expect((await patchSettings({ forensicByDefault: true, purgeAfterDays: 45 })).status).toBe(
        200,
      );
      const page = await request("acme", `/api/v1/data-room/documents/${markedId}/pages/1`, {
        cookie: ada.cookie,
      });
      expect(page.status).toBe(200);
      const served = new Uint8Array(await page.arrayBuffer());
      const { rows: marks } = await pg.pool.query(
        "SELECT 1 FROM dataroom.forensic_mark WHERE membership_id = $1::uuid",
        [ada.membershipId],
      );
      expect(marks.length).toBe(1);
      const form = new FormData();
      const leak = new Uint8Array(await sharp(served).jpeg({ quality: 85 }).toBuffer());
      form.set(
        "image",
        new Blob([leak as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }),
        "leak.jpg",
      );
      form.set("page", "1");
      const detected = await multipart(
        `/api/v1/data-room/documents/${markedId}/forensic/detect`,
        form,
      );
      expect(detected.status, await detected.clone().text()).toBe(200);
      const body = await json<{ results: { membershipId: string; verdict: string }[] }>(detected);
      expect(body.results.find((r) => r.membershipId === ada.membershipId)?.verdict).toBe("match");
      const recipients = await call(
        owner,
        "GET",
        `/data-room/documents/${markedId}/forensic/recipients`,
      );
      expect(recipients.status).toBe(200);
      // The default already on keeps marking new uploads.
      const fresh = await upload(folderId, "default.pdf", await makePdf("Default on"));
      expect((await protectionOf(fresh))["forensic"]).toBe(true);
      // Turning it off is allowed; back on needs the feature.
      expect((await patchSettings({ forensicByDefault: false })).status).toBe(200);
      await expectFeature402(await patchSettings({ forensicByDefault: true }), "forensic");
      expect((await patchDocument(fresh, { protection: { forensic: false } })).status).toBe(200);
      await expectFeature402(
        await patchDocument(fresh, { protection: { forensic: true } }),
        "forensic",
      );
    });

    it("no plan: nothing is gated", async () => {
      await setPlan(null);
      expect((await patchDocument(docId, { protection: { forensic: false } })).status).toBe(200);
      const on = await patchDocument(docId, { protection: { forensic: true } });
      expect(on.status, await on.clone().text()).toBe(200);
      expect((await patchSettings({ forensicByDefault: true })).status).toBe(200);
      expect((await patchSettings({ forensicByDefault: false })).status).toBe(200);
      await setPlan(VENDORS);
    });
  });
});

// --- CONTROL_PLANE=off ----------------------------------------------------------------------------

describe("CONTROL_PLANE=off", () => {
  it("gates nothing, even for a workspace whose plan lists no features", async () => {
    await setPlan(NONE);
    const off = await startServer({
      config: esignTestConfig(env, { ROLES: "api,web", CONTROL_PLANE: "off", ...XERO_CLIENT }),
      logger: createLogger({ level: "error" }),
      mailer,
      modules: MODULES,
      aiModel: fake,
      esignAdapters: ESIGN_ADAPTERS,
      accreditationAdapters: ACCREDITATION_ADAPTERS,
      integrationAdapters: { stripe: () => stripe.adapter, xero: () => xero.adapter },
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    await off.container.relay.stop();
    try {
      expect((await aiStatus(off)).planAllows).toBe(true);
      expect((await putAi({ enabled: false }, owner, off)).status).toBe(200);
      expect((await putAi({}, owner, off)).status).toBe(200);
      expect((await patchSettings({ qa: { enabled: false } }, owner, off)).status).toBe(200);
      expect((await patchSettings({ qa: { enabled: true } }, owner, off)).status).toBe(200);
      expect((await patchSettings({ forensicByDefault: true }, owner, off)).status).toBe(200);
      const esign = await call(
        owner,
        "PUT",
        "/esign/connection",
        { driver: "docuseal", credentials: { apiToken: "docuseal-token-abcd1234" } },
        off,
      );
      expect(esign.status, await esign.clone().text()).toBe(200);
      expect((await call(owner, "DELETE", "/esign/connection", undefined, off)).status).toBe(200);
      // The same workspace on the enforcing server is refused.
      await expectFeature402(
        await call(owner, "POST", "/updates/ai/draft", { notes: "x", template: "blank" }),
        "ai",
      );
      expect((await patchSettings({ forensicByDefault: false })).status).toBe(200);
      await expectFeature402(await patchSettings({ forensicByDefault: true }), "forensic");
    } finally {
      await off.stop();
      await setPlan(VENDORS);
    }
  });
});
