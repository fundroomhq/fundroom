import type { BillingKernel } from "./billing-wiring.js";
import type { CentralAuthKernel } from "./central-auth-wiring.js";
import type { OperatorsKernel } from "./operators-wiring.js";
import type { SanctionsKernel } from "./sanctions-wiring.js";
import type { UsageKernel } from "./usage-wiring.js";

/*
 * The control-plane kernel types the container and `ApiDeps` carry (E3.10). Here rather than in
 * `types.ts` so the wiring files (which import `types.ts`) never form an import cycle with it.
 */
export type { BillingKernel, CentralAuthKernel, OperatorsKernel, SanctionsKernel, UsageKernel };

/** `container.controlPlane`: one kernel per owning agent (see `types.ts`). */
export interface ControlPlaneKernel {
  /** CONTROL_PLANE=on. */
  readonly enabled: boolean;
  /** This process's cell (`CELL_ID`). */
  readonly cellId: string;
  readonly operators: OperatorsKernel;
  readonly usage: UsageKernel;
}
