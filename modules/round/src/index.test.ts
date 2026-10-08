import type { ModuleServices } from "@fundroom/module-kit";
import { createModuleRegistry, defineModule, type ModuleManifest } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { roundModule } from "./index.js";
import { createRoundJobs, EVIDENCE_PURGE_CRON, JOB_EVIDENCE_PURGE } from "./jobs.js";
import { ROUND_DISABLED_WHEN } from "./model.js";

/*
 * The manifest is the module's contract with the kernel: the registry reads it to build the
 * RBAC catalogue, the bootstrap reads it to decide what a workspace sees, and the block
 * registry reads it to know who hydrates `round_summary`. Everything asserted here is something
 * another part of the product would break on.
 */
describe("the round manifest", () => {
  it("owns the `round` schema and ships its migrations", () => {
    expect(roundModule.id).toBe("round");
    expect(roundModule.schema).toBe("round");
    expect(String(roundModule.migrations).endsWith("/migrations/")).toBe(true);
  });

  it("is off until a workspace turns it on", () => {
    // design/03 §157 lists Round among the modules that are off by default. A company using the
    // portal between raises should not carry the tables, and an "Indicate interest" item in the
    // nav of a workspace that is not raising is worse than absent.
    expect(roundModule.defaultEnabled).toBe(false);
    expect(roundModule.required).toBeUndefined();
  });

  it("is disabled outright while nothing is being offered", () => {
    /*
     * The pin §R asks for. `permits(s).roundAndTerms` is false for exactly `none` and
     * `informational`, and this list has to equal that set — a round module reachable in either
     * would be a compliance control with an off switch (ADR-0037 §3: `disabledWhen` applies to
     * staff too).
     *
     * It is pinned against a literal rather than against `permits()` itself because
     * `@fundroom/compliance` is deliberately not a dependency of this module: a module that
     * imported it could reach `core.*` through it. `apps/server/src/round.integration.test.ts`
     * is where the two are proved to agree, by driving a real workspace into `informational`
     * and watching a staff caller get a 404.
     */
    expect(roundModule.offeringStatusRules?.disabledWhen).toEqual(["none", "informational"]);
    expect([...ROUND_DISABLED_WHEN]).toEqual(["none", "informational"]);
    expect(roundModule.offeringStatusRules?.hiddenWhen).toBeUndefined();
  });

  it("depends on access and content", () => {
    // `content` because it registers a block hydrator, which only means something when there is
    // a page to put the block on.
    expect(roundModule.dependsOn).toEqual(["access", "content"]);
  });

  it("declares its four permissions, all prefixed `round.`", () => {
    expect(roundModule.permissions).toEqual([
      "round.read",
      "round.manage",
      "round.publish",
      "round.settings",
    ]);
  });

  it("emits every round topic and handles only its own closing subjects (E3.5)", () => {
    // `crm` is what listens (D1), and it does so without reading a `round.*` table.
    expect(roundModule.events?.emits).toEqual([
      "round.opened",
      "round.closed",
      "round.terms_changed",
      "round.interest_submitted",
      "round.interest_decided",
      "round.commitment_created",
      "round.commitment_changed",
      "round.verification_requested",
      "round.verification_decided",
      "round.signature_completed",
      "round.commitment_confirmed",
      "round.verification_expiring",
    ]);
    // E3.5: the kernel's envelope changes (mirrored onto `round.signature_request`) and the data
    // room's vaulting (links the signed copy). Nothing else.
    // E3.7: an accreditation vendor's callback wake-up.
    expect(Object.keys(roundModule.events?.handles ?? {}).sort()).toEqual([
      "accreditation.provider_updated",
      "document.vaulted",
      "esign.envelope_changed",
      "esign.envelope_completed",
      // E3.7 fix round 1: the vendor handoff (email, name) is removed on erasure.
      "member.erasure_requested",
    ]);
  });

  it("puts the investor entry after the KPIs and the admin entry before CRM", () => {
    expect(roundModule.slots?.["investor.nav"]).toEqual([
      { id: "round", label: "Round", to: "/round", order: 40, icon: "round" },
    ]);
    expect(roundModule.slots?.["admin.nav"]).toEqual([
      { id: "round-admin", label: "Round", to: "/admin/round", order: 36, icon: "round" },
    ]);
  });

  it("declares the round_summary block and hydrates it", () => {
    expect(roundModule.slots?.["content.blocks"]).toEqual(["round_summary"]);
    expect(roundModule.blockHydrators?.map((h) => h.type)).toEqual(["round_summary"]);
  });

  it("registers the evidence upload as a raw route, outside the JSON body limit", () => {
    // A scan of a brokerage statement is routinely larger than the API mount's 1 MiB cap.
    expect(typeof roundModule.rawRoutes).toBe("function");
  });

  it("schedules the evidence purge at 04:50 UTC, clear of the other nightly sweeps", () => {
    expect(JOB_EVIDENCE_PURGE).toBe("round.evidence_purge");
    expect(EVIDENCE_PURGE_CRON).toBe("50 4 * * *");
  });

  it("runs the vendor verification jobs (E3.7): two crons, two keyed per-verification queues", () => {
    const jobs = createRoundJobs({} as ModuleServices);
    const byName = new Map(jobs.map((j) => [j.name, j]));
    expect(byName.get("round.verification_sync_due")?.cron).toBe("*/15 * * * *");
    expect(byName.get("round.verification_lifecycle")?.cron).toBe("10 5 * * *");
    expect(byName.get("round.verification_sync_due")?.queue?.policy).toBe("singleton");
    expect(byName.get("round.verification_lifecycle")?.queue?.policy).toBe("singleton");
    // One queued and one active per verification: two syncs of one row never run at once.
    expect(byName.get("round.verification_start")?.queue).toMatchObject({
      policy: "stately",
      retryLimit: 3,
    });
    expect(byName.get("round.verification_sync")?.queue?.policy).toBe("stately");
    expect(byName.get("round.verification_start")?.cron).toBeUndefined();
    expect(byName.get("round.verification_sync")?.cron).toBeUndefined();
  });

  it("registers in a module registry beside the other manifests", () => {
    const stub = (id: string): ModuleManifest => defineModule({ id, version: "0.0.0" });
    const registry = createModuleRegistry([stub("access"), stub("content"), roundModule]);
    expect(registry.has("round")).toBe(true);
    expect(registry.permissions.get("round.manage")).toBe("round");
    expect(registry.blockHydrators.get("round_summary")?.module).toBe("round");
  });

  it("refuses to hydrate before its routes have been mounted", async () => {
    /*
     * The hydrator is declared *on* the manifest, which is a value, so it cannot be handed the
     * composition root any earlier than route registration. Asking before then must reject
     * rather than reach for `undefined` — and it must reject, not throw synchronously, because
     * `BlockHydrator.hydrate` promises a Promise and the renderer calls it inside a `try` that
     * only catches rejections.
     */
    const hydrator = roundModule.blockHydrators?.[0];
    await expect(
      hydrator?.hydrate({}, {
        tenant: { workspaceId: "01920000-0000-7000-8000-000000000001", actorKind: "system" },
        viewer: { kind: "staff", groupIds: [] },
        facts: {},
      } as never),
    ).rejects.toThrow(/not initialised/u);
  });
});
