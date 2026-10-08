import type { Entitlements, PlanFeature } from "@fundroom/domain";
import type { TransactionHandle } from "./jobs.js";

export type { Entitlements, PlanFeature } from "@fundroom/domain";

/**
 * Plan entitlements as a service (A-3 / E-UP-2, ADR-0063): which optional modules and features a
 * workspace's plan lets it turn on. Implemented by `apps/server/src/entitlements.ts`
 * (`createEntitlements`), exposed to routes as `deps.entitlements` and to modules as
 * `ModuleServices.entitlements`; packages that gate inside a service or job (ai, audit, identity,
 * the data room) receive this port by injection and never import the server.
 *
 * Nothing is enforced unless CONTROL_PLANE=on and the workspace has a plan; then an absent list is
 * still "all". A plan gates turning things on: the callers decide which transition that is, and
 * call `assertFeature` / `assertModule` only there — after the route's own authentication and
 * authorization, so a 402 is never an oracle.
 */
export interface EntitlementsPort {
  /**
   * The entitlements of a resolved workspace (`ResolvedWorkspace` carries both fields on every
   * request). Pure: no I/O.
   */
  of(workspace: { readonly planId: string | null; readonly planLimits: unknown }): Entitlements;
  /**
   * For a job or service that holds only the workspace id. Reads through `tx` — the transaction the
   * caller already holds (tenant context of that workspace, system or host) — and never takes a
   * second pool connection. An unknown or deleted workspace reads as "everything allowed": the
   * caller's own lookup is the one that decides it does not exist.
   */
  forWorkspace(tx: TransactionHandle, workspaceId: string): Promise<Entitlements>;
  /**
   * Throws the 402 `plan_limit` (`details: { limit: "feature", feature }`) when `e` does not allow
   * `feature`; returns otherwise.
   */
  assertFeature(e: Entitlements, feature: PlanFeature): void;
  /**
   * Throws the 402 `plan_limit` (`details: { limit: "module", module }`) when `e` does not allow
   * the optional module `moduleId`; returns otherwise. Never call it for a required module.
   */
  assertModule(e: Entitlements, moduleId: string): void;
}
