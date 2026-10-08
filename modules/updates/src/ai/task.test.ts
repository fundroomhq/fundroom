import type { TenantContext } from "@fundroom/db";
import type { AiContextProvider, AiPrompt, ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { createUpdateDraftTask } from "./task.js";

/*
 * `prepare`/`finish` of `update_draft` against fake services (the real-database path is
 * apps/server/src/updates-ai.integration.test.ts): the tenant check, params, KPI context only
 * while the providing module is enabled, the last update, and state handed to `finish`.
 */

const WS = "01920000-0000-7000-8000-000000000001";
const OTHER = "01920000-0000-7000-8000-000000000002";
const KPI = "01920000-0000-7000-8000-00000000a001";
const ctx: TenantContext = { workspaceId: WS, actorKind: "system" };
const input = (params: Record<string, unknown>, maxInputChars = 60_000) => ({
  requestId: "01920000-0000-7000-8000-0000000000f1",
  workspaceId: WS,
  subjectId: null,
  params: params as never,
  requestedBy: { membershipId: "01920000-0000-7000-8000-0000000000b1" },
  maxInputChars,
});

interface Fake {
  enabled?: string[];
  provider?: AiContextProvider | undefined;
  last?: { postId: string; title: string; sentAt: string; text: string } | null;
}

function servicesOf(f: Fake) {
  const seen: { providerCtx: TenantContext[]; dbCtx: TenantContext[]; logs: string[] } = {
    providerCtx: [],
    dbCtx: [],
    logs: [],
  };
  const providers = new Map<string, { module: string; provider: AiContextProvider }>();
  if (f.provider) {
    const inner = f.provider;
    providers.set("kpis", {
      module: "metrics",
      provider: {
        key: "kpis",
        provide: (c, o) => {
          seen.providerCtx.push(c);
          return inner.provide(c, o);
        },
      },
    });
  }
  const services = {
    registry: { aiContextProviders: providers },
    enablement: {
      get: async () => ({ enabled: new Set(f.enabled ?? []), flags: new Map() }),
    },
    // `lastSentUpdate` is the only withTenant; the fake returns its answer without SQL.
    db: {
      withTenant: async (c: TenantContext) => {
        seen.dbCtx.push(c);
        return f.last ?? null;
      },
    },
    log: (event: string) => {
      seen.logs.push(event);
    },
  } as unknown as ModuleServices;
  return { services, seen };
}

const kpis = (text: string, ids: string[] = [KPI]): AiContextProvider => ({
  key: "kpis",
  provide: async () => ({ text, definitionIds: ids }),
});

async function prompt(f: Fake, params: Record<string, unknown>, max?: number) {
  const { services, seen } = servicesOf(f);
  const task = createUpdateDraftTask(services);
  const out = await task.prepare(ctx, input(params, max));
  return { out, seen, task };
}

describe("update_draft task", () => {
  it("declares the feature, the permission and the params schema", () => {
    const { services } = servicesOf({});
    const task = createUpdateDraftTask(services);
    expect(task.feature).toBe("update_draft");
    expect(task.permission).toBe("updates.manage");
    expect(task.paramsSchema.safeParse({ notes: null, template: "yc" }).success).toBe(true);
    expect(task.paramsSchema.safeParse({ notes: "a\u0000", template: "yc" }).success).toBe(false);
    expect(task.paramsSchema.safeParse({ notes: null, template: "nope" }).success).toBe(false);
  });

  it("refuses a context of another workspace, and never reads anything for it", async () => {
    const { services, seen } = servicesOf({
      enabled: ["metrics"],
      provider: kpis("- MRR (USD): Sep 2026 1.00"),
    });
    const task = createUpdateDraftTask(services);
    const out = await task.prepare(
      { workspaceId: OTHER, actorKind: "system" },
      input({ notes: null, template: "yc" }),
    );
    expect(out).toEqual({ kind: "refused", code: "forbidden" });
    expect(seen.dbCtx).toEqual([]);
    expect(seen.providerCtx).toEqual([]);
  });

  it("refuses params that do not validate", async () => {
    const { out } = await prompt({}, { notes: 5, template: "yc" });
    expect(out).toEqual({ kind: "refused", code: "invalid_params" });
  });

  it("asks the KPI provider under the request's context only while its module is on", async () => {
    const on = await prompt(
      { enabled: ["metrics"], provider: kpis("- MRR (USD): Sep 2026 42000.00") },
      { notes: "hello", template: "yc" },
    );
    const p = on.out as AiPrompt;
    expect(p.kind).toBe("prompt");
    expect(p.user).toContain("<kpis>\n- MRR (USD): Sep 2026 42000.00\n</kpis>");
    expect(on.seen.providerCtx).toEqual([ctx]);
    expect(on.seen.dbCtx).toEqual([ctx]);

    const off = await prompt(
      { enabled: [], provider: kpis("- MRR (USD): Sep 2026 42000.00") },
      { notes: "hello", template: "yc" },
    );
    const q = off.out as AiPrompt;
    expect(q.user).not.toContain("42000");
    expect(q.user).toMatch(/No KPI data is available/u);
    expect(off.seen.providerCtx).toEqual([]);
    // …and the draft that comes back carries no metric grid.
    const done = await off.task.finish(ctx, input({}), q, {
      json: { title: "x", sections: [{ heading: "KPIs", markdown: "[add detail]" }] },
      text: "",
    });
    expect(JSON.stringify(done)).not.toContain("metric_grid");
  });

  it("drops a KPI provider that fails (logged) rather than failing the draft", async () => {
    const { out, seen } = await prompt(
      {
        enabled: ["metrics"],
        provider: {
          key: "kpis",
          provide: async () => {
            throw new Error("boom");
          },
        },
      },
      { notes: null, template: "minimal" },
    );
    expect((out as AiPrompt).user).toMatch(/No KPI data is available/u);
    expect(seen.logs).toEqual(["updates.ai_kpis_failed"]);
  });

  it("includes the last sent update and the template outline", async () => {
    const last = {
      postId: "01920000-0000-7000-8000-00000000b001",
      title: "August",
      sentAt: "2026-09-01T10:00:00.000Z",
      text: "# August\n\n## TL;DR\nA good month.",
    };
    const { out, task } = await prompt({ last }, { notes: null, template: "board" });
    const p = out as AiPrompt;
    expect(p.system).toMatch(/Never invent/u);
    expect(p.user).toContain("<last_update>\n# August\n\n## TL;DR\nA good month.\n</last_update>");
    expect(p.user).toContain("- Executive summary\n- Financials");
    const done = await task.finish(ctx, input({}), p, {
      json: { title: "September", sections: [{ heading: "Summary", markdown: "Fine." }] },
      text: "",
    });
    expect(done.kind).toBe("result");
    expect((done as unknown as { result: { sources: unknown } }).result.sources).toEqual({
      kpis: false,
      lastUpdate: { postId: last.postId, title: "August", sentAt: last.sentAt },
    });
  });

  it("finish puts the KPI ids that went into the prompt into a metric grid", async () => {
    const { out, task } = await prompt(
      { enabled: ["metrics"], provider: kpis("- MRR (USD): Sep 2026 1.00", [KPI, "not-a-uuid"]) },
      { notes: null, template: "yc" },
    );
    const done = await task.finish(ctx, input({}), out as AiPrompt, {
      json: { title: "x", sections: [{ heading: "KPIs", markdown: "MRR is 1.00." }] },
      text: "",
    });
    const result = (done as unknown as { result: { kpiDefinitionIds: string[]; doc: unknown } })
      .result;
    expect(result.kpiDefinitionIds).toEqual([KPI]);
    expect(JSON.stringify(result.doc)).toContain("metric_grid");
  });

  it("finish without prepare's state still produces a draft (no KPI grid, no source)", async () => {
    const { services } = servicesOf({});
    const task = createUpdateDraftTask(services);
    const done = await task.finish(
      ctx,
      input({}),
      { kind: "prompt", system: "", user: "", json: { name: "x", schema: {} } },
      { json: { title: "x", sections: [{ heading: "a", markdown: "b" }] }, text: "" },
    );
    expect(done.kind).toBe("result");
    expect(JSON.stringify(done)).not.toContain("metric_grid");
  });
});
