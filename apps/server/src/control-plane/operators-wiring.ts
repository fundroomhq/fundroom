import { seedDefaults } from "@fundroom/compliance";
import type {
  OperatorEnrolDeps,
  PlatformDeps,
  ProvisioningDeps,
  ProvisioningEvent,
  SignupDeps,
} from "@fundroom/control-plane";
import { listCells } from "@fundroom/control-plane";
import { lockWorkspaceFacts, updateWorkspaceSettingsBlock } from "@fundroom/db";
import { createDirectoryRouting, isSharedDirectory } from "@fundroom/directory";
import { parseWorkspaceSettings, WorkspaceSettingsSchema } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import type { ControlPlaneHooks } from "@fundroom/ports";
import { type ResidencySources, residencyTemplateFields } from "../residency/kernel.js";
import type { ControlPlaneWiringDeps, WiringKernel } from "./types.js";

/*
 * Operators, workspaces, cells, signup (E3.10; owner: agent A) → `container.controlPlane.operators`,
 * read by `routes/platform.ts`, `routes/signup.ts` and the CLI. `hooks()` returns every
 * `ControlPlaneHooks` (sanctions, billing) the provisioning path must run in-tx.
 *
 * The provisioning deps close over what `@fundroom/control-plane` must not import: the outbox
 * `publish` (`@fundroom/events`) and the seeded legal documents (`@fundroom/compliance`
 * `seedDefaults` + the default-disclaimer setting — the same seeding the setup wizard does).
 */
/** Directory round trips per second the public `GET /signup/slug` hint may spend (per process). */
export const SIGNUP_SLUG_DIRECTORY_BUDGET = 10;

export interface OperatorsKernel extends WiringKernel {
  readonly enabled: boolean;
  /** SIGNUP_MODE=open (and the control plane on). */
  readonly signupEnabled: boolean;
  /** The provisioning path (operator create, signup). */
  readonly provisioning: ProvisioningDeps;
  /** The operator API's workspace operations. */
  readonly platform: PlatformDeps;
  readonly signup: SignupDeps;
  /** A new operator's enrolment link / enrolment-only session (fix round 2). */
  readonly enrol: OperatorEnrolDeps;
}

export interface OperatorsWiringExtras {
  /** The billing and sanctions hooks, read lazily (they are built alongside). */
  readonly hooks: () => readonly ControlPlaneHooks[];
  /** E3.11: where the seeded documents' residency merge fields come from (read lazily). */
  readonly residency?: (() => ResidencySources) | undefined;
}

export function createOperatorsWiring(
  deps: ControlPlaneWiringDeps,
  extras: OperatorsWiringExtras,
): OperatorsKernel {
  const raw = deps.config.raw;
  const log = deps.log("control-plane");
  const invalidate = () => deps.resolver.invalidate();
  const slugRouting =
    deps.directory.mode === "shared"
      ? createDirectoryRouting({
          directory: deps.directory,
          budget: SIGNUP_SLUG_DIRECTORY_BUDGET,
          log: (event, fields) => log(event, fields),
        })
      : undefined;
  const provisioning: ProvisioningDeps = {
    db: deps.db,
    audit: deps.audit,
    identity: deps.identityDeps,
    hooks: extras.hooks,
    defaultCellId: raw.CELL_ID,
    async publish(tx, ctx, type: ProvisioningEvent, payload) {
      await publish(tx, ctx, type, payload as never);
    },
    async seed(tx, ctx, ws, actor) {
      // Never a custom domain: a new workspace has none, and its own address is the portal.
      const portal = deps.workspaceUrl({ slug: ws.slug, primaryHost: null }, "/");
      // E3.11: the deployment's declared region and sub-processors (operator facts).
      const residency =
        extras.residency === undefined ? undefined : residencyTemplateFields(extras.residency());
      const { defaultDisclaimerSlug } = await seedDefaults(
        { db: deps.db, audit: deps.audit, log: (event, fields) => log(event, fields) },
        ctx,
        tx,
        {
          context: {
            company: { name: ws.name },
            portal: { url: portal.href },
            ...(residency === undefined
              ? {}
              : {
                  workspace: {
                    ...(residency.dataRegion === undefined
                      ? {}
                      : { dataRegion: residency.dataRegion }),
                  },
                  subProcessors: residency.subProcessors,
                  dataLocation: residency.dataLocation,
                }),
          },
          // An operator-created workspace has no member yet (the owner is invited): the documents
          // are the system's, `created_by` and the audit actor membership stay null.
          actor: {
            membershipId: actor.membershipId as string,
            ...(actor.userId === null ? {} : { userId: actor.userId }),
          },
        },
      );
      // The `legal` block alone (A-3 R2 M1), merged on the row as this transaction holds it —
      // the workspace was inserted by it, so the lock is a no-op and nobody else sees the row yet;
      // whatever provisioning put in the other blocks stays.
      const current = parseWorkspaceSettings((await lockWorkspaceFacts(tx, ws.id))?.settings);
      const next = WorkspaceSettingsSchema.parse({
        ...current,
        legal: { ...current.legal, defaultDisclaimerSlug },
      });
      await updateWorkspaceSettingsBlock(tx, ws.id, "legal", next.legal);
    },
    invalidate,
    log: (event, fields) => log(event, fields),
    now: deps.now,
    // E3.11: operator create and signup claim the slug in the cell directory first.
    directory: deps.directory,
  };
  return {
    enabled: deps.controlPlaneEnabled,
    signupEnabled: deps.controlPlaneEnabled && raw.SIGNUP_MODE === "open",
    provisioning,
    platform: {
      db: deps.db,
      audit: deps.audit,
      invalidate,
      now: deps.now,
      sanctionsScreening: raw.SANCTIONS_DRIVER !== "none",
      // E3.11 R2-8: a label-cell change re-points the directory entry now (sweep repairs a miss).
      async onCellChanged(input) {
        const directory = deps.directory;
        if (!isSharedDirectory(directory)) return;
        try {
          const localCellIds = (await listCells(deps.db)).map((c) => c.id);
          await directory.ensureEntry({ ...input, localCellIds });
        } catch (error) {
          log("directory.cell_change_failed", {
            level: "warn",
            workspaceId: input.workspaceId,
            error: error instanceof Error ? error.message.slice(0, 300) : String(error),
          });
        }
      },
    },
    signup: {
      provisioning,
      defaultPlanId: raw.SIGNUP_DEFAULT_PLAN,
      // A-5: the platform terms version an applicant must have accepted.
      termsVersion: raw.SIGNUP_TERMS_VERSION,
      // Checkout is self-serve only with Stripe (manual: the operator invoices; none: no billing).
      selfServeCheckout: deps.controlPlaneEnabled && raw.BILLING_DRIVER === "stripe",
      // E3.11 R2-7: the public availability hint asks the directory through its own cached,
      // globally budgeted router (a budget miss or an outage reads as "not held elsewhere").
      ...(slugRouting === undefined
        ? {}
        : { slugHeldElsewhere: async (slug: string) => (await slugRouting.slug(slug)) !== null }),
    },
    enrol: {
      db: deps.db,
      audit: deps.audit,
      identity: deps.identityDeps,
      log: (event, fields) => log(event, fields),
    },
    jobs: [],
    async close() {
      slugRouting?.close();
    },
  };
}
