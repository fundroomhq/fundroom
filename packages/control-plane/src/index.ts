/*
 * `@fundroom/control-plane` (E3.10, ADR-0058): the managed-host control plane's kernel services.
 *
 * Split by file between two owners (contract §4): operators, workspaces, cells and signup (A);
 * plans, usage and quotas (M). `workspaces/status.ts` — `setWorkspaceHold`, the only writer of a
 * workspace's holds (its status is derived from them) — is the cross-agent seam every other
 * package calls.
 */
export * from "./cells/cells.js";
export * from "./moves/engine.js";
export * from "./moves/service.js";
export * from "./operators/enrol.js";
export * from "./operators/operators.js";
export * from "./plans/plans.js";
export * from "./quotas/quotas.js";
export * from "./signup/signup.js";
export * from "./usage/usage.js";
export * from "./workspaces/provisioning.js";
export * from "./workspaces/status.js";
