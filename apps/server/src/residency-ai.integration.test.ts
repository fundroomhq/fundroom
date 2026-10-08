import { aiProviderKey } from "@fundroom/ai";
import { createFakeModel } from "@fundroom/ai/testing";
import { AI_WORKSPACE_PURPOSE } from "@fundroom/compliance";
import { createWorkspace } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import type { ModelProviderInfo } from "@fundroom/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { type RunningServer, startServer } from "./server.js";
import { type Actor, esignTestConfig, freshSecrets, harness, json } from "./test/esign-harness.js";

/*
 * The AI model provider in the residency facts (E3.12 §9; owner D).
 *
 * Three servers over ONE database, all declaring DATA_REGION=eu: `none` (no provider), `self` (a
 * self-hosted model — the fake's default info) and `third` (a third-party provider in the US).
 * Both workspaces are the same rows for all three, so any difference is the configuration's.
 *
 *  - the `ai` component exists only where a provider is configured: the cell (in region) when
 *    self-hosted, compared by jurisdiction when a third party hosts it;
 *  - a self-hosted model is never a sub-processor, whatever the workspace's switch;
 *  - a third-party provider is a deployment sub-processor (the operator's DPA lists it), and a
 *    WORKSPACE-scope vendor only while that workspace has AI assist EFFECTIVELY on (switch + a
 *    feature + an acknowledgement of this provider identity);
 *  - the privacy notice's `{{aiAssist}}` paragraph follows the same rule.
 */
let pg: TestPostgres;
let none: RunningServer;
let self: RunningServer;
let third: RunningServer;
let mailer: MemoryMailer;
const h = harness(
  () => none,
  () => mailer,
);
const { request, member } = h;

const VENDOR = "Example AI Inc.";
const THIRD_PARTY: Partial<ModelProviderInfo> = {
  id: "openai-compatible",
  label: "Example AI",
  model: "example-large",
  hosting: "third_party",
  location: "United States",
  jurisdiction: "us",
  retention: "Example AI keeps inputs for up to 30 days for abuse monitoring.",
  subProcessor: {
    name: VENDOR,
    purpose: "AI assist (workspaces that turn it on)",
    dataProcessed: "Prompts built from workspace content",
    location: "United States",
    jurisdiction: "us",
  },
};
const selfModel = createFakeModel();
const thirdModel = createFakeModel({ info: THIRD_PARTY });

let acmeId: string;
let owner: Actor;

interface Residency {
  components: {
    component: string;
    location: string | null;
    jurisdiction: string | null;
    inRegion: boolean | null;
  }[];
  subProcessors: {
    name: string;
    purpose: string;
    scope: "deployment" | "workspace";
    outsideRegion: boolean | null;
  }[];
}

async function read(server: RunningServer): Promise<Residency> {
  const res = await request("acme", "/api/v1/residency", { cookie: owner.cookie, server });
  const text = await res.text();
  expect(res.status, text).toBe(200);
  return JSON.parse(text) as Residency;
}

async function preview(server: RunningServer, id: string): Promise<string> {
  const res = await request("acme", `/api/v1/compliance/templates/${id}`, {
    cookie: owner.cookie,
    server,
  });
  expect(res.status).toBe(200);
  return (await json<{ preview: string }>(res)).preview;
}

/** Writes acme's `ai` settings block as the host actor (what `PUT /ai/settings` would store). */
async function setAi(block: Record<string, unknown>): Promise<void> {
  const client = await pg.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_kind', 'host', true)");
    await client.query(
      "UPDATE core.workspace SET settings = jsonb_set(settings, '{ai}', $2::jsonb) WHERE id = $1",
      [acmeId, JSON.stringify(block)],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  for (const s of [none, self, third]) s.container.resolver.invalidate();
}

function ackOf(info: ModelProviderInfo) {
  return {
    providerKey: aiProviderKey(info),
    hosting: info.hosting,
    at: "2026-09-30T10:00:00.000Z",
    byMembershipId: owner.membershipId,
  };
}

const onFor = (info: ModelProviderInfo) => ({
  enabled: true,
  features: { updateDraft: true, qaAnswer: false },
  monthlyTokenBudget: null,
  acknowledgement: ackOf(info),
});

const aiRows = (r: Residency) =>
  r.subProcessors.filter((s) => s.name === VENDOR || s.name === "Fake model");

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  const secrets = freshSecrets(pg.connectionString);
  const env = {
    DATA_REGION: "eu",
    DATA_REGION_LABEL: "European Union (Frankfurt, Germany)",
    DATA_REGION_JURISDICTION: "eu",
  };
  const common = {
    logger: createLogger({ level: "error" }),
    mailer,
    listenEnabled: false,
    announceSetup: false,
  } as const;
  none = await startServer({ ...common, config: esignTestConfig(secrets, env), migrate: true });
  self = await startServer({
    ...common,
    config: esignTestConfig(secrets, { ...env, ROLES: "api" }),
    migrate: false,
    aiModel: selfModel,
  });
  third = await startServer({
    ...common,
    config: esignTestConfig(secrets, { ...env, ROLES: "api" }),
    migrate: false,
    aiModel: thirdModel,
  });
  acmeId = (await createWorkspace(none.container.db, { slug: "acme", name: "Acme" })).id;
  owner = await member("acme", acmeId, "owner@acme.test", "staff", "owner");
}, 240_000);

afterAll(async () => {
  await third?.stop();
  await self?.stop();
  await none?.stop();
  await pg?.stop();
});

describe("no provider configured", () => {
  it("has no AI component, no AI sub-processor and a plain 'not turned on' notice — whatever the workspace stored", async () => {
    // Even a workspace block that says "on" means nothing without an operator provider.
    await setAi(onFor(thirdModel.info));
    const body = await read(none);
    expect(body.components.map((c) => c.component)).not.toContain("ai");
    expect(aiRows(body)).toEqual([]);
    const notice = await preview(none, "privacy-notice");
    expect(notice).toContain("We do not use AI assist at present.");
    expect(notice).not.toContain(VENDOR);
  });
});

describe("a self-hosted model", () => {
  it("is the cell's own component (in region) and never a sub-processor", async () => {
    await setAi(onFor(selfModel.info));
    const body = await read(self);
    expect(body.components.find((c) => c.component === "ai")).toEqual({
      component: "ai",
      location: "European Union (Frankfurt, Germany)",
      jurisdiction: "eu",
      inRegion: true,
    });
    expect(aiRows(body)).toEqual([]);
    const notice = await preview(self, "privacy-notice");
    expect(notice).toContain("the portal's operator states it runs itself");
    // Only updateDraft is on: the notice does not claim Q&A suggestions.
    expect(notice).not.toContain("suggest answers");
    expect(notice).not.toContain("| Fake model |");
  });
});

describe("a third-party provider", () => {
  it("is compared by jurisdiction and always a deployment sub-processor (the operator's DPA)", async () => {
    await setAi({});
    const body = await read(third);
    expect(body.components.find((c) => c.component === "ai")).toEqual({
      component: "ai",
      location: "United States",
      jurisdiction: "us",
      inRegion: false,
    });
    expect(aiRows(body)).toEqual([
      expect.objectContaining({ scope: "deployment", outsideRegion: true }),
    ]);
    expect(await preview(third, "dpa")).toMatch(
      new RegExp(
        `\\| ${VENDOR} \\| [^|]+ \\| [^|]+ \\| United States \\(outside the declared region\\) \\|`,
        "u",
      ),
    );
  });

  it("is a workspace vendor only while the workspace has AI assist effectively on", async () => {
    const info = thirdModel.info;
    const workspaceRows = async () =>
      aiRows(await read(third)).filter((s) => s.scope === "workspace");

    // Off by default.
    await setAi({});
    expect(await workspaceRows()).toEqual([]);
    expect(await preview(third, "privacy-notice")).toContain("We do not use AI assist at present.");
    // Switched on but no feature on.
    await setAi({ ...onFor(info), features: { updateDraft: false, qaAnswer: false } });
    expect(await workspaceRows()).toEqual([]);
    // On, but acknowledged for ANOTHER provider identity (the operator changed the model).
    await setAi(onFor({ ...info, model: "example-small" }));
    expect(await workspaceRows()).toEqual([]);
    // Switch off with a matching acknowledgement.
    await setAi({ ...onFor(info), enabled: false });
    expect(await workspaceRows()).toEqual([]);

    // Effectively on: listed for THIS workspace, with its own purpose.
    await setAi(onFor(info));
    expect(await workspaceRows()).toEqual([
      expect.objectContaining({ purpose: AI_WORKSPACE_PURPOSE, outsideRegion: true }),
    ]);
    const notice = await preview(third, "privacy-notice");
    expect(notice).toContain(
      `provided by **${VENDOR}** (United States), a third party listed below among the host's sub-processors`,
    );
    // The fake's info says `trainsOnInputs: false`.
    expect(notice).toContain("The provider does not use it to train models.");
    // AI_RESULT_RETENTION_HOURS (default 168) reaches the notice.
    expect(notice).toContain(
      "Drafts and suggestions are kept in the portal for about 7 days (up to an hour longer)",
    );
    expect(notice).toContain(info.retention);
    // Listed once, in the host's list — not again as a provider "we connected ourselves" (R3-L4);
    // the residency page above still shows the workspace-scope row.
    expect(notice.split(`| ${VENDOR} |`)).toHaveLength(2);
    expect(notice).not.toContain(AI_WORKSPACE_PURPOSE);

    // Turned off again: gone at once (the raw row is read, not the resolver cache).
    await setAi({ ...onFor(info), features: { updateDraft: false, qaAnswer: false } });
    expect(await workspaceRows()).toEqual([]);
  });
});
