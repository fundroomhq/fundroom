import type { JsonObject } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AiContextProvider,
  AiStartError,
  type AiTaskDefinition,
  defineModule,
  type ModuleServices,
} from "./manifest.js";
import { createModuleRegistry, registryViewOf } from "./registry.js";

/*
 * E3.12 seams: AI tasks and context providers are built from ModuleServices lazily, one task per
 * feature, a task's permission must be its module's, and the registry view resolves providers on
 * first read only.
 */
const services = {} as ModuleServices;

function task(feature: "update_draft" | "qa_answer", permission: string): AiTaskDefinition {
  const paramsSchema: z.ZodType<JsonObject> = z.object({
    notes: z.string().nullable(),
    template: z.enum(["yc", "blank"]),
  });
  return {
    feature,
    permission,
    paramsSchema,
    prepare: async () => ({ kind: "refused", code: "subject_gone" }),
    finish: async () => ({ kind: "result", result: {} }),
  };
}

const kpis: AiContextProvider = {
  key: "kpis",
  provide: async () => ({ text: "ARR: 1", definitionIds: [] }),
};

describe("AI seams (E3.12)", () => {
  it("resolves tasks by feature and providers by key, lazily", () => {
    let built = 0;
    const updates = defineModule({
      id: "updates",
      version: "1.0.0",
      permissions: ["updates.manage"],
      aiTasks: () => {
        built += 1;
        return [task("update_draft", "updates.manage")];
      },
    });
    const metrics = defineModule({
      id: "metrics",
      version: "1.0.0",
      aiContextProviders: () => {
        built += 1;
        return [kpis];
      },
    });
    const r = createModuleRegistry([updates, metrics]);
    expect(built).toBe(0);
    const tasks = r.resolveAiTasks(services);
    expect(tasks.get("update_draft")?.module).toBe("updates");
    expect(tasks.has("qa_answer")).toBe(false);
    const view = registryViewOf(r, () => services);
    expect(built).toBe(1);
    expect(view.aiContextProviders.get("kpis")?.module).toBe("metrics");
    expect(view.aiContextProviders.get("kpis")?.module).toBe("metrics");
    expect(built).toBe(2);
  });

  it("refuses a feature registered twice and a permission the module does not own", () => {
    const a = defineModule({
      id: "a",
      version: "1.0.0",
      permissions: ["a.x"],
      aiTasks: () => [task("qa_answer", "a.x")],
    });
    const b = defineModule({
      id: "b",
      version: "1.0.0",
      permissions: ["b.x"],
      aiTasks: () => [task("qa_answer", "b.x")],
    });
    expect(() => createModuleRegistry([a, b]).resolveAiTasks(services)).toThrow(
      /registered by a and b/u,
    );
    const c = defineModule({
      id: "c",
      version: "1.0.0",
      aiTasks: () => [task("update_draft", "updates.manage")],
    });
    expect(() => createModuleRegistry([c]).resolveAiTasks(services)).toThrow(/does not declare/u);
    const d = defineModule({ id: "d", version: "1.0.0", aiContextProviders: () => [kpis] });
    const e = defineModule({ id: "e", version: "1.0.0", aiContextProviders: () => [kpis] });
    expect(() => createModuleRegistry([d, e]).resolveAiContextProviders(services)).toThrow(
      /offered by d and e/u,
    );
  });

  it("AiStartError carries its code and retry hint", () => {
    const e = new AiStartError("ai_budget_exhausted", 1000);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("ai_budget_exhausted");
    expect(e.retryAfterMs).toBe(1000);
    expect(e.name).toBe("AiStartError");
  });
});
