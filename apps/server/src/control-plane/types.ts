import type { AuditService } from "@fundroom/audit";
import type { AuthzService } from "@fundroom/authz";
import type { AppConfig } from "@fundroom/config";
import type { EnvelopeService } from "@fundroom/crypto";
import type { CustomDomainLookup, CustomDomainService } from "@fundroom/custom-domains";
import type { Database, ResolvedWorkspace, WorkspaceResolver } from "@fundroom/db";
import type { AuthService, IdentityDeps } from "@fundroom/identity";
import type { ModuleRegistry } from "@fundroom/module-kit";
import type {
  DirectoryPort,
  JobDefinition,
  JobQueuePort,
  JsonObject,
  MailerPort,
  ObjectStoragePort,
  RateLimiterPort,
} from "@fundroom/ports";
import type { Log } from "../logger.js";

/*
 * The managed-host control plane's composition seam (E3.10, ADR-0058). `container.ts` builds one
 * `ControlPlaneWiringDeps` and hands it to each agent's factory, one file per owner:
 *
 *   operators-wiring.ts     A   operators, workspaces, cells, signup  → container.controlPlane.operators
 *   usage-wiring.ts         M   plans, usage, quotas                  → container.controlPlane.usage
 *   billing-wiring.ts       B   subscriptions, webhook, jobs          → container.billing
 *   sanctions-wiring.ts     S   screening, jobs                       → container.sanctions
 *   central-auth-wiring.ts  CA  central auth handoff                  → container.centralAuth
 *
 * Each factory returns a plain, mutable object (tests `Object.assign` fakes onto it) that extends
 * `WiringKernel`: its jobs are registered with the rest, `close()` runs on stop. A factory must not
 * do I/O or throw on a default (CONTROL_PLANE=off) configuration: everything is inert there.
 * An owner may add fields to its own kernel type freely; a field added HERE is shared — append it
 * and say so in the handshake file.
 */
export interface WiringKernel {
  readonly jobs: readonly JobDefinition<JsonObject>[];
  close(): Promise<void>;
}

export interface ControlPlaneWiringDeps {
  readonly config: AppConfig;
  /** `CONTROL_PLANE=on` (which config only allows with TENANCY_MODE=multi). */
  readonly controlPlaneEnabled: boolean;
  readonly db: Database;
  readonly audit: AuditService;
  readonly queue: JobQueuePort;
  readonly mailer: MailerPort;
  readonly storage: ObjectStoragePort;
  readonly envelope: EnvelopeService;
  readonly rateLimiter: RateLimiterPort;
  readonly authz: AuthzService;
  readonly auth: AuthService;
  readonly identityDeps: IdentityDeps;
  readonly resolver: WorkspaceResolver;
  readonly customDomains: CustomDomainService;
  readonly customDomainLookup: CustomDomainLookup;
  /** E3.11: the cell directory (placement claims). */
  readonly directory: DirectoryPort;
  readonly registry: ModuleRegistry;
  /** A workspace's own URL from BASE_URL (see `routes/deps.ts` `workspaceUrl`). */
  readonly workspaceUrl: (
    workspace: Pick<ResolvedWorkspace, "slug" | "primaryHost">,
    path: string,
  ) => URL;
  readonly now: () => Date;
  readonly log: (component: string) => Log;
}
