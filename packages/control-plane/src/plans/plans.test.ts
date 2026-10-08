import type { AuditRecorder } from "@fundroom/audit";
import type { Tx } from "@fundroom/db";
import { describe, expect, it } from "vitest";
import { createPlan, PLAN_LIMITS_SCHEMA_VERSION, PlanError, updatePlan } from "./plans.js";

/*
 * Plan writes and entitlements (A-3, ADR-0063), without a database: a fake transaction records
 * what would be written. What it pins: `limits.modules` may name only optional modules of the
 * build (refused before anything is written), the lists are stored sorted and unique, and every
 * write stores `limits_schema_version` 2. The SQL itself is covered by the integration suites.
 */

const OPTIONAL = ["analytics", "crm", "data-room", "updates"];
const audit = { record: async () => {} } as unknown as AuditRecorder;
const actor = { kind: "cli", osUser: "test" } as const;

function fakeTx() {
  const writes: Record<string, unknown>[] = [];
  const row = (values: Record<string, unknown>) => ({
    id: "starter",
    name: "Starter",
    limits: {},
    billingPriceRef: null,
    billingMeteredPriceRefs: [],
    trialDays: 0,
    public: false,
    archivedAt: null,
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...values,
  });
  const tx = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        writes.push(values);
        return { onConflictDoNothing: () => ({ returning: async () => [row(values)] }) };
      },
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        writes.push(values);
        return { where: () => ({ returning: async () => [row({ ...values, version: 2 })] }) };
      },
    }),
    execute: async () => ({ rows: [{}] }),
  } as unknown as Tx;
  return { tx, writes };
}

describe("createPlan / updatePlan entitlements", () => {
  it("stores the lists sorted and unique, with limits_schema_version 2", async () => {
    const { tx, writes } = fakeTx();
    const plan = await createPlan(
      tx,
      {
        id: "starter",
        name: "Starter",
        limits: { staffSeats: 3, modules: ["updates", "data-room"], features: ["sso", "ai"] },
      },
      actor,
      { audit, optionalModules: OPTIONAL },
    );
    expect(writes[0]).toMatchObject({
      limits: { staffSeats: 3, modules: ["data-room", "updates"], features: ["ai", "sso"] },
      limitsSchemaVersion: PLAN_LIMITS_SCHEMA_VERSION,
    });
    expect(PLAN_LIMITS_SCHEMA_VERSION).toBe(2);
    expect(plan.limits.modules).toEqual(["data-room", "updates"]);
  });

  it("refuses a module that is not an optional module of the build, before writing", async () => {
    const { tx, writes } = fakeTx();
    for (const bad of ["content", "access", "teleport"]) {
      const error = await createPlan(
        tx,
        { id: "starter", name: "Starter", limits: { modules: ["crm", bad] } },
        actor,
        { audit, optionalModules: OPTIONAL },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PlanError);
      expect(error).toMatchObject({ reason: "unknown_module", module: bad });
    }
    const patched = await updatePlan(
      tx,
      "starter",
      1,
      { limits: { modules: ["metrics"] } },
      actor,
      { audit, optionalModules: OPTIONAL },
    ).catch((e: unknown) => e);
    expect(patched).toMatchObject({ reason: "unknown_module", module: "metrics" });
    expect(writes).toHaveLength(0);
  });

  it("an update writes version 2 even when only the name changes; [] is kept as none", async () => {
    const { tx, writes } = fakeTx();
    await updatePlan(tx, "starter", 1, { name: "Renamed" }, actor, {
      audit,
      optionalModules: OPTIONAL,
    });
    await updatePlan(tx, "starter", 1, { limits: { modules: [], features: [] } }, actor, {
      audit,
      optionalModules: OPTIONAL,
    });
    expect(writes[0]).toMatchObject({ name: "Renamed", limitsSchemaVersion: 2 });
    expect(writes[1]).toMatchObject({
      limits: { modules: [], features: [] },
      limitsSchemaVersion: 2,
    });
  });
});
