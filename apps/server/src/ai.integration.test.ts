import { AI_CORRECTIVE_PROMPT, aiProviderKey, deleteAiRequestsOfMember } from "@fundroom/ai";
import { createFakeModel } from "@fundroom/ai/testing";
import { createErasureService } from "@fundroom/compliance";
import { createWorkspace, systemContext, type TenantContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { AiStartError, AiTaskDefinition, ModuleManifest } from "@fundroom/module-kit";
import {
  type JsonObject,
  ModelProviderError,
  type ModelRequest,
  type ModelResult,
} from "@fundroom/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { type RunningServer, startServer } from "./server.js";
import {
  type Actor,
  deadlocks,
  type ErrorBody,
  esignTestConfig,
  freshSecrets,
  harness,
  json,
} from "./test/esign-harness.js";

/*
 * The AI kernel (E3.12 contract §7), end to end on a real server and database, with the fake model
 * and TEST tasks: the updates / data-room manifests are compiled in with their `aiTasks` replaced
 * (the real tasks have their own files), so these tests pin the kernel and nothing else.
 *
 *  - settings + status: unavailable install, permissions, acknowledgement bound to the provider
 *    identity, the budget cap, the safe settings write, audit;
 *  - start: effective state from the raw row, reuse, per-user limit BEFORE the workspace budget,
 *    in-flight cap, budget with Retry-After, audit + queued job;
 *  - the job: claim, fresh settings + requester permission, prepare refusal, input cap, JSON
 *    parsing with ONE corrective retry, finish reasons, provider errors, usage, and the late write
 *    after cancel/delete that must be dropped;
 *  - reads: requester only, and only while they hold the task's permission;
 *  - retention + stale sweep, erasure, discardForSubject;
 *  - a one-connection pool pass (start + job) and a deadlock race (settings vs start vs finish).
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

let acmeId: string;
let betaId: string;
let owner: Actor;
let editor: Actor;
let editor2: Actor;
let editor3: Actor;
let viewer: Actor;
let ada: Actor;
let betaOwner: Actor;
const users = new Map<string, string>();

const PER_USER_HOUR = 20;

// --- the fake model and the test tasks --------------------------------------------------------

type Reply = (req: ModelRequest) => ModelResult | Promise<ModelResult> | Error;
const ok = (text: string, finish: ModelResult["finish"] = "stop"): ModelResult => ({
  text,
  finish,
  usage: { inputTokens: 10, outputTokens: 5 },
  model: "fake",
});
const DEFAULT_REPLY: Reply = () => ok('{"title":"Q3 update"}');
let reply: Reply = DEFAULT_REPLY;
const fake = createFakeModel({ respond: (req) => reply(req) });

/** What the test tasks saw (ctx per call). */
const seen: { prepare: TenantContext[]; finish: TenantContext[] } = { prepare: [], finish: [] };

const DraftParams = z.object({ notes: z.union([z.string(), z.null()]), mode: z.string() });
const draftTask: AiTaskDefinition = {
  feature: "update_draft",
  permission: "updates.manage",
  paramsSchema: DraftParams as unknown as z.ZodType<JsonObject>,
  async prepare(ctx, input) {
    seen.prepare.push(ctx);
    const p = DraftParams.parse(input.params);
    if (p.mode === "refuse") return { kind: "refused", code: "no_sources" };
    const user = p.mode === "big" ? "x".repeat(input.maxInputChars) : `<notes>${p.notes}</notes>`;
    return {
      kind: "prompt",
      system: "SYS",
      user,
      json: {
        name: "draft",
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
          additionalProperties: false,
        },
      },
      maxOutputTokens: 999_999,
    };
  },
  async finish(ctx, _input, _prompt, output) {
    seen.finish.push(ctx);
    const title = (output.json as { title?: unknown }).title;
    if (typeof title !== "string") return { kind: "refused", code: "bad_shape" };
    return {
      kind: "result",
      result: {
        kind: "update_draft",
        title,
        doc: { sections: [] },
        kpiDefinitionIds: [],
        sources: { kpis: false, lastUpdate: null },
      },
    };
  },
};
const QaParams = z.object({ mode: z.string().optional() });
const qaTask: AiTaskDefinition = {
  feature: "qa_answer",
  permission: "data-room.qa_answer",
  paramsSchema: QaParams as unknown as z.ZodType<JsonObject>,
  async prepare() {
    return { kind: "refused", code: "no_sources" };
  },
  async finish() {
    return { kind: "refused", code: "no_sources" };
  },
};
/** A qa task that reaches the model (params `{mode: "prompt"}`). */
const qaPromptTask: AiTaskDefinition = {
  ...qaTask,
  async prepare(_ctx, input) {
    if (QaParams.parse(input.params).mode !== "prompt")
      return { kind: "refused", code: "no_sources" };
    return {
      kind: "prompt",
      system: "SYS",
      user: "<question>q</question>",
      json: { name: "qa", schema: { type: "object" } },
    };
  },
  async finish() {
    return {
      kind: "result",
      result: {
        kind: "qa_answer",
        outcome: "answered",
        body: "late",
        citations: [],
        droppedCitations: 0,
        searchedDocuments: 1,
      },
    };
  },
};

const MODULES: readonly ModuleManifest[] = COMPILED_IN_MODULES.map((m) =>
  m.id === "updates"
    ? { ...m, aiTasks: () => [draftTask] }
    : m.id === "data-room"
      ? { ...m, aiTasks: () => [qaPromptTask] }
      : m,
);

// --- helpers ------------------------------------------------------------------------------------

const month = () => `${new Date().toISOString().slice(0, 7)}-01`;

function staffCtx(workspaceId: string, a: Actor): TenantContext {
  return {
    workspaceId,
    actorKind: "staff",
    membershipId: a.membershipId,
    userId: users.get(a.membershipId) ?? "",
  };
}

async function start(
  a: Actor,
  params: JsonObject = { notes: "grew 20%", mode: "normal" },
  opts: {
    feature?: "update_draft" | "qa_answer";
    subjectId?: string | null;
    via?: RunningServer;
  } = {},
): Promise<{ requestId: string; reused: boolean }> {
  return (opts.via ?? running).container.ai.start(staffCtx(acmeId, a), {
    feature: opts.feature ?? "update_draft",
    subjectId: opts.subjectId ?? null,
    params,
    actor: { membershipId: a.membershipId, userId: users.get(a.membershipId) ?? "" },
  });
}

async function startError(a: Actor, params?: JsonObject): Promise<AiStartError> {
  try {
    await start(a, params);
  } catch (error) {
    return error as AiStartError;
  }
  throw new Error("start succeeded");
}

async function putSettings(
  body: Record<string, unknown>,
  who: Actor = owner,
  slug = "acme",
): Promise<Response> {
  return request(slug, "/api/v1/ai/settings", {
    method: "PUT",
    cookie: who.cookie,
    body: JSON.stringify({
      enabled: true,
      features: { updateDraft: true, qaAnswer: true },
      monthlyTokenBudget: null,
      acknowledge: false,
      ...body,
    }),
  });
}

async function enable(features = { updateDraft: true, qaAnswer: true }): Promise<void> {
  const res = await putSettings({ features, acknowledge: true });
  expect(res.status).toBe(200);
}

interface StatusBody {
  available: boolean;
  provider: { id: string; label: string; hosting: string; trainsOnInputs: boolean | null } | null;
  settings: {
    enabled: boolean;
    features: { updateDraft: boolean; qaAnswer: boolean };
    monthlyTokenBudget: number | null;
    acknowledgement: { providerKey: string; hosting: string; byMembershipId: string } | null;
  };
  needsAcknowledgement: boolean;
  effective: { updateDraft: boolean; qaAnswer: boolean };
  usage: {
    month: string;
    inputTokens: number;
    outputTokens: number;
    requests: number;
    budget: number;
    minimumBudget: number;
    budgetBelowMinimum: boolean;
  };
}

async function status(who: Actor = owner, via?: RunningServer): Promise<StatusBody> {
  const res = await request("acme", "/api/v1/ai/status", {
    cookie: who.cookie,
    ...(via === undefined ? {} : { server: via }),
  });
  expect(res.status).toBe(200);
  return json<StatusBody>(res);
}

interface RequestBody {
  id: string;
  feature: string;
  status: string;
  errorCode: string | null;
  finishedAt: string | null;
  result: { kind: string; title?: string } | null;
  usage: { inputTokens: number; outputTokens: number };
}

async function getRequest(id: string, who: Actor): Promise<Response> {
  return request("acme", `/api/v1/ai/requests/${id}`, { cookie: who.cookie });
}

async function rowOf(id: string) {
  const [row] = await sql<{
    status: string;
    error_code: string | null;
    result: Record<string, unknown> | null;
    result_schema_version: number | null;
    input_tokens: number;
    output_tokens: number;
    provider: string;
  }>(
    acmeId,
    `SELECT status, error_code, result, result_schema_version, input_tokens, output_tokens, provider
       FROM core.ai_request WHERE id = '${id}'`,
  );
  return row;
}

async function usageRow() {
  const [row] = await sql<{ input_tokens: string; output_tokens: string; requests: number }>(
    acmeId,
    `SELECT input_tokens::text, output_tokens::text, requests FROM core.ai_usage_monthly
      WHERE workspace_id = '${acmeId}' AND month = '${month()}'`,
  );
  return row;
}

async function run(id: string, via?: RunningServer): Promise<void> {
  await runJob("ai.run", { requestId: id, workspaceId: acmeId }, via);
}

/** A promise with its resolver, to hold a model call or a task open. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}

async function waitUntil(label: string, probe: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await probe())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function reset(): Promise<void> {
  reply = DEFAULT_REPLY;
  fake.calls.length = 0;
  seen.prepare.length = 0;
  seen.finish.length = 0;
  await sql(acmeId, `DELETE FROM core.ai_request`);
  await sql(acmeId, `DELETE FROM core.ai_usage_monthly`);
  for (const a of [owner, editor, editor2, editor3, viewer]) {
    await running.container.rateLimiter.reset(`ai.start:${a.membershipId}`);
  }
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  env = freshSecrets(pg.connectionString);
  running = await startServer({
    // No worker: the tests run `ai.run` in-process, deterministically.
    config: esignTestConfig(env, {
      ROLES: "api,web",
      AI_REQUESTS_PER_USER_HOUR: String(PER_USER_HOUR),
    }),
    logger: createLogger({ level: "error" }),
    mailer,
    modules: MODULES,
    aiModel: fake,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  betaId = (await createWorkspace(running.container.db, { slug: "beta", name: "Beta" })).id;
  owner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");
  editor = await member("acme", acmeId, "editor@acme.test", "staff", "editor");
  editor2 = await member("acme", acmeId, "editor2@acme.test", "staff", "editor");
  editor3 = await member("acme", acmeId, "editor3@acme.test", "staff", "editor");
  viewer = await member("acme", acmeId, "viewer@acme.test", "staff", "viewer");
  ada = await member("acme", acmeId, "ada@investor.test", "external", "investor");
  betaOwner = await member("beta", betaId, "owner@beta.test", "staff", "owner");
  for (const [ws, a] of [
    [acmeId, owner],
    [acmeId, editor],
    [acmeId, editor2],
    [acmeId, editor3],
    [acmeId, viewer],
  ] as const) {
    const [r] = await sql<{ user_id: string }>(
      ws,
      `SELECT user_id::text FROM core.membership WHERE id = '${a.membershipId}'`,
    );
    users.set(a.membershipId, r?.user_id ?? "");
  }
}, 240_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

beforeEach(reset);

// --- settings and status ------------------------------------------------------------------------

describe("status and settings", () => {
  it("starts off: available with the provider as tenants see it, nothing effective, zero usage", async () => {
    const s = await status(viewer);
    expect(s.available).toBe(true);
    expect(s.provider).toMatchObject({
      id: "fake",
      label: "Fake model",
      hosting: "self_hosted",
      trainsOnInputs: false,
    });
    expect(s.provider).not.toHaveProperty("subProcessor");
    expect(s.settings).toEqual({
      enabled: false,
      features: { updateDraft: false, qaAnswer: false },
      monthlyTokenBudget: null,
      acknowledgement: null,
    });
    expect(s.needsAcknowledgement).toBe(true);
    expect(s.effective).toEqual({ updateDraft: false, qaAnswer: false });
    expect(s.usage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      requests: 0,
      budget: 2_000_000,
    });
    expect((await startError(editor)).code).toBe("ai_disabled");
  });

  it("ai.read for every staff role, ai.manage only for owner/admin, nothing for investors", async () => {
    expect((await request("acme", "/api/v1/ai/status", { cookie: editor.cookie })).status).toBe(
      200,
    );
    expect((await request("acme", "/api/v1/ai/status", { cookie: ada.cookie })).status).toBe(404);
    for (const who of [editor, viewer]) {
      expect((await putSettings({ acknowledge: true }, who)).status).toBe(403);
    }
    expect((await putSettings({ acknowledge: true }, ada)).status).toBe(404);
    expect((await status()).settings.enabled).toBe(false);
  });

  it("enabling needs an acknowledgement of the current provider; it is stored, audited and keeps other blocks", async () => {
    await sql(
      acmeId,
      `UPDATE core.workspace SET settings = jsonb_set(settings, '{dataRoom}', '{"allowUnscanned": true}'::jsonb) WHERE id = '${acmeId}'`,
    );
    const refused = await putSettings({ acknowledge: false });
    expect(refused.status).toBe(409);
    expect((await json<ErrorBody>(refused)).error.code).toBe("ai_acknowledgement_required");

    const res = await putSettings({
      features: { updateDraft: true, qaAnswer: false },
      acknowledge: true,
    });
    expect(res.status).toBe(200);
    const s = await json<StatusBody>(res);
    expect(s.settings.acknowledgement).toMatchObject({
      providerKey: aiProviderKey(fake.info),
      hosting: "self_hosted",
      byMembershipId: owner.membershipId,
    });
    expect(s.needsAcknowledgement).toBe(false);
    expect(s.effective).toEqual({ updateDraft: true, qaAnswer: false });
    // Re-saving without acknowledge keeps the stored acknowledgement.
    expect((await putSettings({ acknowledge: false })).status).toBe(200);

    const [ws] = await sql<{ settings: { dataRoom?: { allowUnscanned?: boolean } } }>(
      acmeId,
      `SELECT settings FROM core.workspace WHERE id = '${acmeId}'`,
    );
    expect(ws?.settings.dataRoom?.allowUnscanned).toBe(true);
    const audits = await sql<{
      meta: { before: { enabled: boolean }; after: { enabled: boolean } };
    }>(
      acmeId,
      `SELECT meta FROM audit.event WHERE workspace_id = '${acmeId}' AND action = 'ai.settings_updated' ORDER BY seq`,
    );
    expect(audits.length).toBe(2);
    expect(audits[0]?.meta.before.enabled).toBe(false);
    expect(audits[0]?.meta.after.enabled).toBe(true);
  });

  it("refuses a budget above the operator's cap (400) and applies a lower one", async () => {
    const res = await putSettings({ acknowledge: true, monthlyTokenBudget: 2_000_001 });
    expect(res.status).toBe(400);
    const lower = await putSettings({ acknowledge: true, monthlyTokenBudget: 200_000 });
    expect((await json<StatusBody>(lower)).usage.budget).toBe(200_000);
    expect((await putSettings({ acknowledge: true, monthlyTokenBudget: null })).status).toBe(200);
  });

  it("the acknowledgement binds to the provider identity: another identity turns everything off", async () => {
    await enable();
    const other = aiProviderKey({ ...fake.info, model: "bigger" });
    await sql(
      acmeId,
      `UPDATE core.workspace SET settings = jsonb_set(settings, '{ai,acknowledgement,providerKey}', to_jsonb('${other}'::text)) WHERE id = '${acmeId}'`,
    );
    const s = await status();
    expect(s.needsAcknowledgement).toBe(true);
    expect(s.effective).toEqual({ updateDraft: false, qaAnswer: false });
    // The start reads the raw row (not the resolver cache) and names the reason.
    expect((await startError(editor)).code).toBe("ai_acknowledgement_required");
    const again = await putSettings({ acknowledge: false });
    expect((await json<ErrorBody>(again)).error.code).toBe("ai_acknowledgement_required");
    await enable();
    expect((await status()).effective.updateDraft).toBe(true);
  });

  it("the settings of one workspace never reach another", async () => {
    await enable();
    const res = await request("beta", "/api/v1/ai/status", { cookie: betaOwner.cookie });
    expect((await json<StatusBody>(res)).settings.enabled).toBe(false);
  });
});

// --- start, the job, reads ----------------------------------------------------------------------

describe("start → job → result", () => {
  beforeEach(() => enable());

  it("queues one request (audited, job enqueued), reuses it while in flight, and the job stores the result", async () => {
    const first = await start(editor);
    expect(first.reused).toBe(false);
    expect(await start(editor)).toEqual({ requestId: first.requestId, reused: true });
    const row = await rowOf(first.requestId);
    expect(row).toMatchObject({ status: "queued", provider: aiProviderKey(fake.info) });
    const audits = await sql(
      acmeId,
      `SELECT 1 FROM audit.event WHERE action = 'ai.request_started' AND resource_id = '${first.requestId}'`,
    );
    expect(audits.length).toBe(1);
    const jobs = await pg.pool.query(
      `SELECT 1 FROM pgboss.job WHERE name = 'ai.run' AND data->>'requestId' = $1`,
      [first.requestId],
    );
    expect(jobs.rowCount).toBe(1);

    await run(first.requestId);
    const res = await getRequest(first.requestId, editor);
    expect(res.status).toBe(200);
    const body = await json<RequestBody>(res);
    expect(body).toMatchObject({
      status: "done",
      errorCode: null,
      result: { kind: "update_draft", title: "Q3 update" },
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect(body.finishedAt).not.toBeNull();
    expect((await rowOf(first.requestId))?.result_schema_version).toBe(1);
    // The model saw the task's prompt, output capped at AI_MAX_OUTPUT_TOKENS, the json schema.
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      system: "SYS",
      messages: [{ role: "user", content: "<notes>grew 20%</notes>" }],
      maxOutputTokens: 4000,
      json: { name: "draft" },
    });
    // The task ran as the requester (staff), not as the system actor.
    expect(seen.prepare[0]).toMatchObject({
      actorKind: "staff",
      membershipId: editor.membershipId,
    });
    expect(await usageRow()).toEqual({ input_tokens: "10", output_tokens: "5", requests: 1 });
    // A second run of the same job does nothing (claim is queued → running only).
    await run(first.requestId);
    expect(fake.calls).toHaveLength(1);
    // Done: the next start is a new request.
    expect((await start(editor)).reused).toBe(false);
  });

  it("only the requester reads or discards a request, and only while they hold the task's permission", async () => {
    const { requestId } = await start(editor);
    await run(requestId);
    for (const who of [editor2, owner, viewer]) {
      expect((await getRequest(requestId, who)).status, who.membershipId).toBe(404);
      expect(
        (
          await request("acme", `/api/v1/ai/requests/${requestId}`, {
            method: "DELETE",
            cookie: who.cookie,
          })
        ).status,
      ).toBe(404);
    }
    expect((await getRequest(requestId, ada)).status).toBe(404);
    expect((await getRequest("not-a-uuid", editor)).status).toBe(400);
    // Demoted to viewer (ai.read but not updates.manage): the requester no longer sees it.
    await sql(
      acmeId,
      `UPDATE core.membership SET role = 'viewer' WHERE id = '${editor.membershipId}'`,
    );
    try {
      expect((await getRequest(requestId, editor)).status).toBe(404);
    } finally {
      await sql(
        acmeId,
        `UPDATE core.membership SET role = 'editor' WHERE id = '${editor.membershipId}'`,
      );
    }
    expect((await getRequest(requestId, editor)).status).toBe(200);
    const del = await request("acme", `/api/v1/ai/requests/${requestId}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
    expect(del.status).toBe(204);
    expect(await rowOf(requestId)).toBeUndefined();
    expect((await getRequest(requestId, editor)).status).toBe(404);
  });

  it("the job re-checks: feature off → refused disabled; requester lost the permission → refused forbidden", async () => {
    const a = await start(editor);
    await sql(
      acmeId,
      `UPDATE core.workspace SET settings = jsonb_set(settings, '{ai,features,updateDraft}', 'false'::jsonb) WHERE id = '${acmeId}'`,
    );
    await run(a.requestId);
    expect(await rowOf(a.requestId)).toMatchObject({ status: "refused", error_code: "disabled" });
    await enable();
    const b = await start(editor2);
    await sql(
      acmeId,
      `UPDATE core.membership SET role = 'viewer' WHERE id = '${editor2.membershipId}'`,
    );
    try {
      await run(b.requestId);
    } finally {
      await sql(
        acmeId,
        `UPDATE core.membership SET role = 'editor' WHERE id = '${editor2.membershipId}'`,
      );
    }
    expect(await rowOf(b.requestId)).toMatchObject({ status: "refused", error_code: "forbidden" });
    expect(fake.calls).toHaveLength(0);
    expect(await usageRow()).toBeUndefined();
  });

  it("task refusal and the input cap refuse without calling the model", async () => {
    const a = await start(editor, { notes: null, mode: "refuse" });
    await run(a.requestId);
    expect(await rowOf(a.requestId)).toMatchObject({ status: "refused", error_code: "no_sources" });
    const b = await start(editor2, { notes: null, mode: "big" });
    await run(b.requestId);
    expect(await rowOf(b.requestId)).toMatchObject({
      status: "refused",
      error_code: "input_too_large",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("strips fences/think blocks, retries ONCE with a corrective turn, then fails invalid_output", async () => {
    reply = () => ok('<think>hmm {"x":1}</think>\n```json\n{"title":"Fenced"}\n```');
    const a = await start(editor);
    await run(a.requestId);
    expect((await rowOf(a.requestId))?.result).toMatchObject({ title: "Fenced" });

    let n = 0;
    reply = () => (++n === 1 ? ok("Sure! Here is your update.") : ok('{"title":"Second"}'));
    const b = await start(editor);
    await run(b.requestId);
    expect(await rowOf(b.requestId)).toMatchObject({
      status: "done",
      input_tokens: 20,
      output_tokens: 10,
    });
    const retry = fake.calls.at(-1);
    expect(retry?.messages).toEqual([
      { role: "user", content: "<notes>grew 20%</notes>" },
      { role: "assistant", content: "Sure! Here is your update." },
      { role: "user", content: AI_CORRECTIVE_PROMPT },
    ]);

    fake.calls.length = 0;
    reply = () => ok("still not json");
    const c = await start(editor);
    await run(c.requestId);
    expect(await rowOf(c.requestId)).toMatchObject({
      status: "failed",
      error_code: "invalid_output",
    });
    expect(fake.calls).toHaveLength(2);
    // Tokens of all three requests were counted.
    expect((await usageRow())?.requests).toBe(3);
  });

  it("maps finish reasons and provider errors to codes", async () => {
    const cases: [Reply, string][] = [
      [() => ok('{"title":"cut', "length"), "output_truncated"],
      [() => ok("", "refusal"), "refused_by_model"],
      [() => ok("{}", "filtered"), "refused_by_model"],
      [() => new ModelProviderError("quota", "insufficient_quota", false), "provider_quota"],
      [() => new Error("boom with secret prompt text"), "internal"],
    ];
    for (const [r, code] of cases) {
      reply = r;
      const { requestId } = await start(editor);
      await run(requestId);
      expect(await rowOf(requestId), code).toMatchObject({ status: "failed", error_code: code });
    }
    // The task refused the model's JSON shape.
    reply = () => ok('{"other":1}');
    const { requestId } = await start(editor);
    await run(requestId);
    expect(await rowOf(requestId)).toMatchObject({ status: "refused", error_code: "bad_shape" });
  });
});

describe("limits", () => {
  beforeEach(() => enable());

  it("the per-user limit is checked BEFORE the workspace budget", async () => {
    await sql(
      acmeId,
      `INSERT INTO core.ai_usage_monthly (workspace_id, month, input_tokens) VALUES ('${acmeId}', '${month()}', 5000000)`,
    );
    // Budget alone: refused with Retry-After to the next UTC month.
    const budget = await startError(editor);
    expect(budget.code).toBe("ai_budget_exhausted");
    expect(budget.retryAfterMs).toBeGreaterThan(0);
    // Over the per-user limit too: the user's own limit answers, the shared budget is not probed.
    for (let i = 0; i < PER_USER_HOUR; i++) {
      await running.container.rateLimiter.hit(`ai.start:${editor.membershipId}`, {
        max: PER_USER_HOUR,
        windowMs: 3_600_000,
      });
    }
    const limited = await startError(editor);
    expect(limited.code).toBe("ai_rate_limited");
    expect(limited.retryAfterMs).toBeGreaterThan(0);
    expect(await sql(acmeId, "SELECT 1 FROM core.ai_request")).toEqual([]);
  });

  it("each started request spends one of the user's hourly starts; a reuse does not", async () => {
    for (let i = 0; i < PER_USER_HOUR; i++) {
      const { requestId } = await start(editor);
      expect((await start(editor)).reused).toBe(true);
      await sql(acmeId, `UPDATE core.ai_request SET status = 'done' WHERE id = '${requestId}'`);
    }
    expect((await startError(editor)).code).toBe("ai_rate_limited");
    expect((await start(editor2)).reused).toBe(false);
  });

  it("at most four requests in flight per workspace (ai_busy), whoever started them", async () => {
    for (const a of [owner, editor2, editor3]) await start(a);
    await start(editor, { notes: null, mode: "x" }, { feature: "qa_answer", subjectId: acmeId });
    expect((await startError(editor)).code).toBe("ai_busy");
    await sql(
      acmeId,
      "UPDATE core.ai_request SET status = 'done' WHERE requested_by = '" +
        owner.membershipId +
        "'",
    );
    expect((await start(editor)).reused).toBe(false);
  });

  it("the API answers the start errors with their status and Retry-After", async () => {
    // Through the error handler exactly as a module route would: a probe route is not needed —
    // `toApiError` adopts the kernel's error (code + details.retryAfterMs).
    const { toApiError } = await import("@fundroom/contracts");
    await sql(
      acmeId,
      `INSERT INTO core.ai_usage_monthly (workspace_id, month, input_tokens) VALUES ('${acmeId}', '${month()}', 5000000)`,
    );
    const api = toApiError(await startError(editor));
    expect(api?.status).toBe(429);
    expect(api?.code).toBe("ai_budget_exhausted");
    expect(Number(api?.headers["Retry-After"])).toBeGreaterThan(0);
  });
});

describe("cancellation and late writes", () => {
  beforeEach(() => enable());

  it("turning a feature off cancels its queued and running requests; a late finish is dropped", async () => {
    const queued = await start(editor2);
    const g = gate();
    let calledModel = false;
    reply = async () => {
      calledModel = true;
      await g.wait;
      return ok('{"title":"too late"}');
    };
    const running1 = await start(editor);
    const job = run(running1.requestId);
    await waitUntil("model call", () => calledModel);
    const res = await putSettings({ features: { updateDraft: false, qaAnswer: true } });
    expect(res.status).toBe(200);
    expect((await rowOf(queued.requestId))?.status).toBe("cancelled");
    expect((await rowOf(running1.requestId))?.status).toBe("cancelled");
    g.open();
    await job;
    // The cancelled row was not overwritten by the late result; the tokens still count.
    expect(await rowOf(running1.requestId)).toMatchObject({ status: "cancelled", result: null });
    expect(await usageRow()).toMatchObject({ requests: 1 });
    // The queued one never runs.
    await run(queued.requestId);
    expect(await rowOf(queued.requestId)).toMatchObject({ status: "cancelled" });
  });

  it("deleting a running request drops the result the job returns later", async () => {
    const g = gate();
    let calledModel = false;
    reply = async () => {
      calledModel = true;
      await g.wait;
      return ok('{"title":"orphan"}');
    };
    const { requestId } = await start(editor);
    const job = run(requestId);
    await waitUntil("model call", () => calledModel);
    const del = await request("acme", `/api/v1/ai/requests/${requestId}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
    expect(del.status).toBe(204);
    g.open();
    await job;
    expect(await rowOf(requestId)).toBeUndefined();
    expect(await sql(acmeId, "SELECT 1 FROM core.ai_request")).toEqual([]);
    expect(await usageRow()).toMatchObject({ input_tokens: "10", requests: 1 });
  });
});

describe("retention, erasure, discardForSubject", () => {
  beforeEach(() => enable());

  it("the hourly sweep deletes expired rows and fails stale in-flight ones", async () => {
    const expired = await start(editor);
    await run(expired.requestId);
    await sql(
      acmeId,
      `UPDATE core.ai_request SET expires_at = now() - interval '1 minute' WHERE id = '${expired.requestId}'`,
    );
    // Running past the job's expiry (2×timeout + 60 s + margin), by started_at.
    const stale = await start(editor2);
    await sql(
      acmeId,
      `UPDATE core.ai_request SET status = 'running', started_at = now() - interval '10 minutes' WHERE id = '${stale.requestId}'`,
    );
    // Queued for long, but claimed a minute ago: legitimately running (R1-L1), not stale.
    const late = await start(editor3);
    await sql(
      acmeId,
      `UPDATE core.ai_request SET status = 'running', created_at = now() - interval '50 minutes', started_at = now() - interval '1 minute' WHERE id = '${late.requestId}'`,
    );
    // Queued and never claimed for over an hour: stale by created_at.
    const orphan = await start(owner);
    await sql(
      acmeId,
      `UPDATE core.ai_request SET created_at = now() - interval '61 minutes' WHERE id = '${orphan.requestId}'`,
    );
    const fresh = await start(editor, { notes: "other", mode: "normal" });
    await runJob("ai.retention", {});
    expect(await rowOf(expired.requestId)).toBeUndefined();
    expect(await rowOf(stale.requestId)).toMatchObject({ status: "failed", error_code: "stale" });
    // RR1-L4: the crashed call (started, never settled) is charged half a reservation.
    expect((await usageRow())?.input_tokens).toBe(String(10 + 66_000));
    expect(await rowOf(orphan.requestId)).toMatchObject({ status: "failed", error_code: "stale" });
    expect(await rowOf(late.requestId)).toMatchObject({ status: "running" });
    expect(await rowOf(fresh.requestId)).toMatchObject({ status: "queued" });
  });

  it("discardForSubject deletes a subject's requests inside the caller's transaction", async () => {
    const subject = "01920000-0000-7000-8000-00000000abcd";
    await start(editor, {}, { feature: "qa_answer", subjectId: subject });
    await start(editor2, {}, { feature: "qa_answer", subjectId: subject });
    const other = await start(editor3, {}, { feature: "qa_answer", subjectId: acmeId });
    const ctx = systemContext(acmeId);
    const n = await running.container.db.withTenant(ctx, (tx) =>
      running.container.ai.discardForSubject(tx, ctx, "qa_answer", subject),
    );
    expect(n).toBe(2);
    expect((await sql(acmeId, "SELECT id FROM core.ai_request")).map((r) => r["id"])).toEqual([
      other.requestId,
    ]);
  });

  it("member erasure deletes every request the member started (and nobody else's)", async () => {
    const gone = await member("acme", acmeId, "gone@acme.test", "staff", "editor");
    const [u] = await sql<{ user_id: string }>(
      acmeId,
      `SELECT user_id::text FROM core.membership WHERE id = '${gone.membershipId}'`,
    );
    users.set(gone.membershipId, u?.user_id ?? "");
    const mine = await start(gone);
    await run(mine.requestId);
    await start(gone, {}, { feature: "qa_answer", subjectId: acmeId });
    const theirs = await start(editor);
    const ctx = systemContext(acmeId);
    const detail = await running.container.db.withTenant(ctx, (tx) =>
      createErasureService({
        db: running.container.db,
        audit: running.container.audit,
        bookingSuppressionKeys: running.container.envelope,
      }).request(ctx, tx, {
        membershipId: gone.membershipId,
        expectedModules: [],
        actor: { membershipId: owner.membershipId },
      }),
    );
    expect(detail.request.status).toBe("completed");
    expect(
      await sql(
        acmeId,
        `SELECT 1 FROM core.ai_request WHERE requested_by = '${gone.membershipId}'`,
      ),
    ).toEqual([]);
    expect(await rowOf(theirs.requestId)).toMatchObject({ status: "queued" });
    const [step] = await sql<{ counts: Record<string, number> }>(
      acmeId,
      `SELECT counts FROM core.dsar_step WHERE request_id = '${detail.request.id}' AND module = 'core.identity'`,
    );
    expect(step?.counts["aiRequests"]).toBe(2);
    // The helper the hook calls is idempotent.
    expect(
      await running.container.db.withTenant(ctx, (tx) =>
        deleteAiRequestsOfMember(tx, ctx, gone.membershipId),
      ),
    ).toBe(0);
  });
});

// --- fix round 1 ------------------------------------------------------------------------------

/** A staff member provisioned without a session (kernel calls only). */
async function quietMember(email: string, role = "editor"): Promise<Actor> {
  const deps = running.container.identityDeps;
  const { userId } = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  const m = await provisionMembership(deps, {
    workspaceId: acmeId,
    userId,
    kind: "staff",
    role: role as never,
    source: "test",
  });
  await sql(acmeId, `UPDATE core.membership SET status = 'active' WHERE id = '${m.id}'`);
  users.set(m.id, userId);
  return { membershipId: m.id, cookie: "" };
}

/** Parks the next model calls until `open()`; `calls()` = how many reached the model. */
function parkModel(text = '{"title":"parked"}') {
  const g = gate();
  let n = 0;
  reply = async () => {
    n += 1;
    await g.wait;
    return ok(text);
  };
  return { open: g.open, calls: () => n };
}

describe("fix round 1", () => {
  beforeEach(() => enable());

  it("R1-H1: a discarded running request keeps its in-flight slot until its job settles", async () => {
    const park = parkModel();
    const { requestId } = await start(editor);
    const job = run(requestId);
    await waitUntil("model call", () => park.calls() === 1);
    const del = await request("acme", `/api/v1/ai/requests/${requestId}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
    expect(del.status).toBe(204);
    expect((await getRequest(requestId, editor)).status).toBe(404);
    // Three more fill the workspace's four slots; the discarded one still holds the fourth.
    for (const a of [owner, editor2, editor3]) await start(a);
    expect((await startError(editor, { notes: "again", mode: "normal" })).code).toBe("ai_busy");
    park.open();
    await job;
    // Settled: the discarded row is gone, its tokens counted, and its slot is free again.
    expect(await rowOf(requestId)).toBeUndefined();
    expect(await usageRow()).toMatchObject({ input_tokens: "10", requests: 1 });
    expect((await start(editor, { notes: "again", mode: "normal" })).reused).toBe(false);
  });

  it("R1-H1: a request discarded while its job waits for a model slot never reaches the model", async () => {
    // AI_CONCURRENCY = 2: two parked calls hold both slots.
    const park = parkModel();
    const a = await start(owner);
    const b = await start(editor2);
    const jobs = [run(a.requestId), run(b.requestId)];
    await waitUntil("two model calls", () => park.calls() === 2);
    const c = await start(editor);
    const third = run(c.requestId);
    await new Promise((r) => setTimeout(r, 100));
    expect(park.calls()).toBe(2);
    const del = await request("acme", `/api/v1/ai/requests/${c.requestId}`, {
      method: "DELETE",
      cookie: editor.cookie,
    });
    expect(del.status).toBe(204);
    park.open();
    await Promise.all([...jobs, third]);
    expect(park.calls()).toBe(2);
    expect(await rowOf(c.requestId)).toBeUndefined();
  });

  it("R1-H1/M3 + RR1-M3: in-flight requests are reserved at worst case; others' reservations answer busy", async () => {
    // Reservation = 2 × AI_MAX_INPUT_CHARS (60000) + 3 × AI_MAX_OUTPUT_TOKENS (4000) = 132000.
    expect((await putSettings({ acknowledge: true, monthlyTokenBudget: 300_000 })).status).toBe(
      200,
    );
    await start(editor);
    await start(editor2);
    // Nothing recorded yet, but 3 × 132000 > 300000 — only because of the other two: retryable.
    expect((await startError(editor3)).code).toBe("ai_busy");
    // Recorded usage leaves less than one reservation: used up until next month.
    await sql(acmeId, "DELETE FROM core.ai_request");
    await sql(
      acmeId,
      `INSERT INTO core.ai_usage_monthly (workspace_id, month, input_tokens) VALUES ('${acmeId}', '${month()}', 200000)`,
    );
    const err = await startError(editor3);
    expect(err.code).toBe("ai_budget_exhausted");
    expect(err.retryAfterMs).toBeGreaterThan(0);
  });

  it("RR1-M3: a budget below one reservation is refused; status reports the minimum", async () => {
    const res = await putSettings({ acknowledge: true, monthlyTokenBudget: 10_000 });
    expect(res.status).toBe(400);
    expect((await json<{ error: { min?: number } }>(res)).error.min).toBe(132_000);
    expect((await status()).usage.minimumBudget).toBe(132_000);
    expect((await putSettings({ acknowledge: true, monthlyTokenBudget: 132_000 })).status).toBe(
      200,
    );
  });

  it("RR1-M1: subject deletes and erasure keep a RUNNING request's slot (emptied now, deleted at settle)", async () => {
    const park = parkModel();
    const gone = await quietMember("rr1m1@acme.test");
    const q = await start(editor, { mode: "prompt" }, { feature: "qa_answer", subjectId: acmeId });
    const d = await start(gone, { notes: "SECRET-NOTES", mode: "normal" });
    const jobs = [run(q.requestId), run(d.requestId)];
    await waitUntil("two model calls", () => park.calls() === 2);
    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, async (tx) => {
      await running.container.ai.discardForSubject(tx, ctx, "qa_answer", acmeId);
      await deleteAiRequestsOfMember(tx, ctx, gone.membershipId);
    });
    // Both rows stay (cancelled + discarded), the member's notes are gone at once.
    const rows = await sql<{ status: string; error_code: string; params: Record<string, unknown> }>(
      acmeId,
      `SELECT status, error_code, params FROM core.ai_request WHERE id IN ('${q.requestId}', '${d.requestId}')`,
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r).toMatchObject({ status: "cancelled", params: {} });
    // The subject delete says why (readable by the requester, RR3-L9); erasure just discards.
    expect(rows.map((r) => r.error_code).sort()).toEqual(["discarded", "sources_changed"]);
    // They still hold two of the four slots.
    await start(owner);
    await start(editor2);
    expect((await startError(editor3)).code).toBe("ai_busy");
    park.open();
    await Promise.all(jobs);
    expect(await rowOf(q.requestId)).toBeUndefined();
    expect(await rowOf(d.requestId)).toBeUndefined();
    expect((await start(editor3)).reused).toBe(false);
  });

  it("RR1-M2: discardCiting also stops a running qa_answer request from storing its result", async () => {
    const park = parkModel();
    const q = await start(editor, { mode: "prompt" }, { feature: "qa_answer", subjectId: acmeId });
    const job = run(q.requestId);
    await waitUntil("model call", () => park.calls() === 1);
    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.ai.discardCiting(tx, ctx, "01920000-0000-7000-8000-0000000d0c09"),
    );
    park.open();
    await job;
    expect(await rowOf(q.requestId)).toBeUndefined();
  });

  it("RR1-L2: lone surrogates / NUL in params never reach a query (no 500, stored clean)", async () => {
    const { requestId } = await start(editor, {
      notes: "TOPSECRET \ud800 x\u0000y",
      mode: "normal",
    });
    const [row] = await sql<{ params: { notes: string } }>(
      acmeId,
      `SELECT params FROM core.ai_request WHERE id = '${requestId}'`,
    );
    expect(row?.params.notes).toBe("TOPSECRET  xy");
  });

  it("RR1-L3: refused starts (busy) do not spend the user's hourly limit", async () => {
    for (const a of [owner, editor2, editor3]) await start(a);
    await start(editor, {}, { feature: "qa_answer", subjectId: acmeId });
    for (let i = 0; i < PER_USER_HOUR + 5; i++) {
      expect((await startError(editor2, { notes: `n${i}`, mode: "normal" })).code).toBe("ai_busy");
    }
    await sql(acmeId, "UPDATE core.ai_request SET status = 'done', finished_at = now()");
    expect((await start(editor2, { notes: "finally", mode: "normal" })).reused).toBe(false);
  });

  it("R1-M3: a model call that fails is charged its prompt estimate", async () => {
    reply = () => new ModelProviderError("timeout", "deadline", true);
    const { requestId } = await start(editor);
    await run(requestId);
    expect(await rowOf(requestId)).toMatchObject({
      status: "failed",
      error_code: "provider_timeout",
    });
    const chars = "SYS".length + "<notes>grew 20%</notes>".length;
    expect(await usageRow()).toEqual({
      input_tokens: String(chars),
      output_tokens: "0",
      requests: 1,
    });
  });

  it("R1-H2: lone surrogates and NUL in a result are dropped; the result is stored and usage counted", async () => {
    reply = () => ok('{"title":"Secret \\ud800Q3\\u0000 \\udfff$4M \\ud83d\\ude00"}');
    const { requestId } = await start(editor);
    await run(requestId);
    const row = await rowOf(requestId);
    expect(row).toMatchObject({ status: "done" });
    expect((row?.result as { title?: string } | undefined)?.title).toBe("Secret Q3 $4M \u{1F600}");
    expect(await usageRow()).toMatchObject({ requests: 1 });
    const leaked = await pg.pool.query(
      "SELECT 1 FROM pgboss.job WHERE output::text LIKE '%Secret%'",
    );
    expect(leaked.rowCount).toBe(0);
  });

  it("R1-M1: a suspended workspace sends nothing to the model (workspace_unavailable)", async () => {
    const { requestId } = await start(editor);
    await running.container.db.withHost((tx) =>
      tx.execute(`UPDATE core.workspace SET holds = ARRAY['operator'] WHERE id = '${acmeId}'`),
    );
    try {
      await run(requestId);
    } finally {
      await running.container.db.withHost((tx) =>
        tx.execute(`UPDATE core.workspace SET holds = '{}' WHERE id = '${acmeId}'`),
      );
    }
    expect(await rowOf(requestId)).toMatchObject({
      status: "refused",
      error_code: "workspace_unavailable",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("R1-L2: concurrent starts cannot overshoot the per-user hourly limit", async () => {
    for (let i = 0; i < PER_USER_HOUR - 1; i++) {
      await running.container.rateLimiter.hit(`ai.start:${editor.membershipId}`, {
        max: PER_USER_HOUR,
        windowMs: 3_600_000,
      });
    }
    const subjects = [1, 2, 3, 4].map((i) => `01920000-0000-7000-8000-00000000000${i}`);
    const results = await Promise.allSettled(
      subjects.map((subjectId) => start(editor, {}, { feature: "qa_answer", subjectId })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) {
      if (r.status === "rejected") expect((r.reason as AiStartError).code).toBe("ai_rate_limited");
    }
  });

  it("R1-L4: a requester with an erasure in progress cannot start", async () => {
    const leaving = await quietMember("leaving@acme.test");
    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, (tx) =>
      createErasureService({
        db: running.container.db,
        audit: running.container.audit,
        bookingSuppressionKeys: running.container.envelope,
      }).request(ctx, tx, {
        membershipId: leaving.membershipId,
        expectedModules: ["data-room"],
        actor: { membershipId: owner.membershipId },
      }),
    );
    expect((await startError(leaving)).code).toBe("ai_disabled");
    expect(
      await sql(
        acmeId,
        `SELECT 1 FROM core.ai_request WHERE requested_by = '${leaving.membershipId}'`,
      ),
    ).toEqual([]);
  });

  it("R3-L7: reuse only for equal params; different notes start a new request", async () => {
    const a = await start(editor, { notes: "one", mode: "normal" });
    expect(await start(editor, { notes: "one", mode: "normal" })).toEqual({
      requestId: a.requestId,
      reused: true,
    });
    const b = await start(editor, { notes: "two", mode: "normal" });
    expect(b.reused).toBe(false);
    expect(b.requestId).not.toBe(a.requestId);
  });

  it("R3-L10: a stored budget above a lowered operator cap does not block saves, and is capped on read", async () => {
    await sql(
      acmeId,
      `UPDATE core.workspace SET settings = jsonb_set(settings, '{ai,monthlyTokenBudget}', '3000000'::jsonb) WHERE id = '${acmeId}'`,
    );
    const same = await putSettings({ monthlyTokenBudget: 3_000_000 });
    expect(same.status).toBe(200);
    expect((await json<StatusBody>(same)).usage.budget).toBe(2_000_000);
    expect((await putSettings({ monthlyTokenBudget: 2_500_000 })).status).toBe(400);
  });

  it("R1-M4: the acknowledgement lapses when the provider's jurisdiction or location changes", async () => {
    const key = aiProviderKey(fake.info);
    expect(aiProviderKey({ ...fake.info, jurisdiction: "us" })).not.toBe(key);
    expect(aiProviderKey({ ...fake.info, location: "Frankfurt" })).not.toBe(key);
    const moved = aiProviderKey({ ...fake.info, jurisdiction: "us" });
    await sql(
      acmeId,
      `UPDATE core.workspace SET settings = jsonb_set(settings, '{ai,acknowledgement,providerKey}', to_jsonb('${moved}'::text)) WHERE id = '${acmeId}'`,
    );
    expect((await status()).effective.updateDraft).toBe(false);
  });

  it("R2-M1 support: discardCiting deletes qa_answer requests citing a document, nothing else", async () => {
    const doc = "01920000-0000-7000-8000-0000000d0c01";
    const other = "01920000-0000-7000-8000-0000000d0c02";
    const cite = (d: string) =>
      JSON.stringify({
        kind: "qa_answer",
        outcome: "answered",
        body: "x",
        citations: [
          { n: 1, documentId: d, versionId: d, pageNo: 1, documentTitle: "t", quote: "q" },
        ],
        droppedCitations: 0,
        searchedDocuments: 1,
      });
    const a = await start(editor, {}, { feature: "qa_answer", subjectId: acmeId });
    const b = await start(editor2, {}, { feature: "qa_answer", subjectId: acmeId });
    await sql(
      acmeId,
      `UPDATE core.ai_request SET status = 'done', result = '${cite(doc)}'::jsonb, result_schema_version = 1 WHERE id = '${a.requestId}'`,
    );
    await sql(
      acmeId,
      `UPDATE core.ai_request SET status = 'done', result = '${cite(other)}'::jsonb, result_schema_version = 1 WHERE id = '${b.requestId}'`,
    );
    const ctx = systemContext(acmeId);
    const n = await running.container.db.withTenant(ctx, (tx) =>
      running.container.ai.discardCiting(tx, ctx, doc),
    );
    expect(n).toBe(1);
    expect(await rowOf(a.requestId)).toBeUndefined();
    expect(await rowOf(b.requestId)).toMatchObject({ status: "done" });
  });

  it("R1-M2: member erasure raced against PUT /ai/settings (disable) with in-flight rows: no deadlock", async () => {
    const before = await deadlocks(pg.pool);
    for (let i = 0; i < 6; i++) {
      await enable();
      const gone = await quietMember(`race${i}@acme.test`);
      await start(gone);
      await start(gone, {}, { feature: "qa_answer", subjectId: acmeId });
      await start(editor2, { notes: `n${i}`, mode: "normal" });
      const ctx = systemContext(acmeId);
      const [erase, put] = await Promise.allSettled([
        running.container.db.withTenant(ctx, (tx) =>
          createErasureService({
            db: running.container.db,
            audit: running.container.audit,
            bookingSuppressionKeys: running.container.envelope,
          }).request(ctx, tx, {
            membershipId: gone.membershipId,
            expectedModules: [],
            actor: { membershipId: owner.membershipId },
          }),
        ),
        putSettings({ enabled: false, features: { updateDraft: false, qaAnswer: false } }),
      ]);
      expect(erase.status).toBe("fulfilled");
      expect(put.status === "fulfilled" && put.value.status).toBe(200);
      await sql(acmeId, "DELETE FROM core.ai_request");
    }
    expect(await deadlocks(pg.pool)).toBe(before);
  }, 120_000);
});

describe("fix round 3", () => {
  beforeEach(() => enable());

  it("RR3-L7: a call the sweep already failed stale (and charged) is not charged again by its job", async () => {
    const park = parkModel();
    const { requestId } = await start(editor);
    const job = run(requestId);
    await waitUntil("model call", () => park.calls() === 1);
    await sql(
      acmeId,
      `UPDATE core.ai_request SET started_at = now() - interval '2 hours' WHERE id = '${requestId}'`,
    );
    await runJob("ai.retention", {});
    expect(await usageRow()).toEqual({ input_tokens: "66000", output_tokens: "0", requests: 1 });
    park.open();
    await job;
    expect(await rowOf(requestId)).toMatchObject({ status: "failed", error_code: "stale" });
    expect(await usageRow()).toEqual({ input_tokens: "66000", output_tokens: "0", requests: 1 });
  });

  it("RR3-L8: a stored budget below the minimum reads off, with a specific start refusal", async () => {
    await sql(
      acmeId,
      `UPDATE core.workspace SET settings = jsonb_set(settings, '{ai,monthlyTokenBudget}', '5000'::jsonb) WHERE id = '${acmeId}'`,
    );
    const s = await status();
    expect(s.usage).toMatchObject({
      budget: 5000,
      minimumBudget: 132_000,
      budgetBelowMinimum: true,
    });
    expect(s.effective).toEqual({ updateDraft: false, qaAnswer: false });
    const err = (await startError(editor)) as AiStartError & { details: Record<string, unknown> };
    expect(err.code).toBe("ai_disabled");
    expect(err.details["reason"]).toBe("budget_below_minimum");
    await sql(
      acmeId,
      `UPDATE core.workspace SET settings = jsonb_set(settings, '{ai,monthlyTokenBudget}', 'null'::jsonb) WHERE id = '${acmeId}'`,
    );
    expect((await status()).usage.budgetBelowMinimum).toBe(false);
  });

  it("RR3-L9: a running suggestion cancelled by a document bin stays readable as cancelled until settled", async () => {
    const park = parkModel();
    const q = await start(editor, { mode: "prompt" }, { feature: "qa_answer", subjectId: acmeId });
    const job = run(q.requestId);
    await waitUntil("model call", () => park.calls() === 1);
    const ctx = systemContext(acmeId);
    await running.container.db.withTenant(ctx, (tx) =>
      running.container.ai.discardCiting(tx, ctx, "01920000-0000-7000-8000-0000000d0c0a"),
    );
    const res = await getRequest(q.requestId, editor);
    expect(res.status).toBe(200);
    expect(await json<RequestBody>(res)).toMatchObject({
      status: "cancelled",
      errorCode: "sources_changed",
      result: null,
    });
    park.open();
    await job;
    expect((await getRequest(q.requestId, editor)).status).toBe(404);
  });
});

// --- pool + lock order ---------------------------------------------------------------------------

describe("pool and lock order", () => {
  beforeEach(() => enable());

  it("a one-connection pool: start and the whole job complete (no nested pool use)", async () => {
    const single = await startServer({
      config: esignTestConfig(env, { DATABASE_POOL_MAX: "1", ROLES: "api" }),
      logger: createLogger({ level: "error" }),
      mailer,
      modules: MODULES,
      aiModel: fake,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    try {
      // The relay legitimately serialises the only connection; stop it (E3.4 lesson).
      await single.container.relay.stop();
      const within = <T>(p: Promise<T>) =>
        Promise.race([
          p,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("timed out (pool held?)")), 15_000),
          ),
        ]);
      const { requestId } = await within(start(editor, undefined, { via: single }));
      await within(run(requestId, single));
      expect((await rowOf(requestId))?.status).toBe("done");
      const res = await within(
        request("acme", "/api/v1/ai/status", { cookie: owner.cookie, server: single }),
      );
      expect(res.status).toBe(200);
      expect((await json<StatusBody>(res)).usage.requests).toBe(1);
    } finally {
      await single.stop();
    }
  }, 120_000);

  it("PUT /ai/settings (disable) raced against start and job finish: no deadlock", async () => {
    const before = await deadlocks(pg.pool);
    for (let i = 0; i < 8; i++) {
      await enable();
      await sql(acmeId, "DELETE FROM core.ai_request");
      const g = gate();
      let calledModel = false;
      reply = async () => {
        calledModel = true;
        await g.wait;
        return ok('{"title":"race"}');
      };
      const a = await start(editor);
      const job = run(a.requestId);
      await waitUntil("model call", () => calledModel);
      reply = () => ok('{"title":"race"}');
      const settle = <T>(p: Promise<T>) =>
        p.then(
          (v) => ({ ok: true as const, v }),
          (e: unknown) => ({ ok: false as const, e }),
        );
      const [put, s1, s2] = await Promise.all([
        settle(putSettings({ enabled: false, features: { updateDraft: false, qaAnswer: false } })),
        settle(start(editor2)),
        settle(start(editor3)),
        (async () => {
          g.open();
          await job;
        })(),
      ]);
      expect(put.ok && put.v.status).toBe(200);
      for (const s of [s1, s2]) {
        if (!s.ok) expect((s.e as AiStartError).code).toBe("ai_disabled");
      }
      // Whatever raced in: nothing stays runnable once the settings are off.
      for (const r of await sql<{ id: string }>(acmeId, "SELECT id::text FROM core.ai_request")) {
        await run(r.id);
      }
      const leftovers = await sql<{ status: string }>(
        acmeId,
        "SELECT status FROM core.ai_request WHERE status IN ('queued', 'running', 'done')",
      );
      expect(leftovers.filter((r) => r.status !== "done")).toEqual([]);
      expect(leftovers.filter((r) => r.status === "done").length).toBeLessThanOrEqual(1);
    }
    expect(await deadlocks(pg.pool)).toBe(before);
  }, 120_000);
});

describe("unavailable install", () => {
  it("no model: status 200 unavailable, enabling is 409 ai_unavailable, start refuses", async () => {
    const off = await startServer({
      config: esignTestConfig(env, { ROLES: "api" }),
      logger: createLogger({ level: "error" }),
      mailer,
      modules: MODULES,
      listenEnabled: false,
      migrate: false,
      announceSetup: false,
    });
    try {
      const s = await status(owner, off);
      expect(s).toMatchObject({
        available: false,
        provider: null,
        needsAcknowledgement: false,
        effective: { updateDraft: false, qaAnswer: false },
      });
      const res = await request("acme", "/api/v1/ai/settings", {
        method: "PUT",
        cookie: owner.cookie,
        server: off,
        body: JSON.stringify({
          enabled: true,
          features: { updateDraft: true, qaAnswer: false },
          monthlyTokenBudget: null,
          acknowledge: true,
        }),
      });
      expect(res.status).toBe(409);
      const body = await json<ErrorBody>(res);
      expect(body.error.code).toBe("ai_unavailable");
      expect(body.error.message).toBe("AI assist is not configured on this install");
      await expect(start(editor, undefined, { via: off })).rejects.toMatchObject({
        code: "ai_unavailable",
      });
      expect(off.container.aiModel).toBeNull();
    } finally {
      await off.stop();
    }
  }, 120_000);
});
