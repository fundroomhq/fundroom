import type { AuditRecorder } from "@fundroom/audit";
import { type Database, systemContext, type TenantContext, type Tx } from "@fundroom/db";
import {
  AttestationRepo,
  type CreatedInvite,
  type IdentityDeps,
  MembershipRepo,
  normalizeEmail,
  sendInviteEmail,
  writeInvite,
} from "@fundroom/identity";
import type {
  ControlPlaneHooks,
  JsonObject,
  ProvisionedWorkspace,
  TransactionHandle,
  WorkspaceStatus,
} from "@fundroom/ports";
import { findCell } from "../cells/repos/cell-repo.js";
import { findUserIdByEmail } from "../operators/repos/operator-repo.js";
import { auditPlatformChain, auditTenantChain } from "./chains.js";
import {
  isPlacementError,
  normalizeWorkspaceSlug,
  type PlacementDirectory,
  withSlugClaim,
} from "./placement.js";
import { findPlanRow, insertWorkspace, readWorkspaceState } from "./repos/provisioning-repo.js";
import { enterSystemContext, readTxContext, restoreTxContext } from "./repos/status-repo.js";
import type { ControlPlaneActor } from "./status.js";

// The operator API's workspace operations live beside provisioning (re-exported for the index).
export * from "./placement.js";
export * from "./platform.js";

/*
 * Workspace provisioning (E3.10, ADR-0058; owner: agent A) — the one path the operator API
 * (`POST /platform/workspaces`) and self-service signup create a workspace through: the existing
 * `createWorkspace` + `seedDefaults` path setup uses, the owner (invited by email through the
 * identity invitation service, or — for signup — a staff membership for the verified user), the
 * plan, and every `ControlPlaneHooks.onWorkspaceCreated` in the same transaction (sanctions may
 * hold the workspace `pending_review`; billing creates the manual/trialing subscription).
 *
 * One HOST transaction, in this order:
 *
 *   1. the plan (exists, not archived) and the cell (exists, `active`) are checked;
 *   2. the workspace row is inserted with its placement, plan, legal name and country (host
 *      context: the guard trigger admits only host/system writers to those columns). A taken slug
 *      aborts everything — `ProvisioningError('slug_taken')`, nothing half-created;
 *   3. every hook runs, in the order `hooks()` lists them, before any audit of ours (the port's
 *      rule: a hook may call `setWorkspaceHold`, which audits both chains itself);
 *   4. in the workspace's `system` context: the `workspace.created` event, the owner (an invite
 *      row, or an active staff owner membership + the terms attestation), the seeded legal
 *      documents (a savepoint: a template failure is logged and leaves the workspace un-seeded,
 *      exactly setup's tolerance), and `workspace.created` on the tenant chain;
 *   5. `workspace.created` on the platform chain, last (tenant chain before platform chain).
 *
 * After commit, `afterCommit()` sends the owner's invitation email (a failure is reported, not
 * thrown: the workspace exists and the invite can be resent from the People screen).
 */

export type ProvisionOwner =
  /** Invite `ownerEmail` as a staff owner (operator create). */
  | { readonly kind: "invite" }
  /** The verified user becomes the active staff owner now (signup), accepting these terms. */
  | {
      readonly kind: "member";
      readonly userId: string;
      /** A `core.attestation` kind recorded for the new membership (`platform-terms:v1`). */
      readonly attestationKind: string;
      /** Evidence of the acceptance (when, from the signup request), kept on the attestation. */
      readonly attestationData?: Readonly<Record<string, string | number | boolean>> | undefined;
    };

export interface ProvisionWorkspaceInput {
  readonly slug: string;
  readonly name: string;
  readonly legalName: string;
  readonly country: string;
  readonly ownerEmail: string;
  readonly planId: string | null;
  /** Default: `ProvisioningDeps.defaultCellId` (this process's CELL_ID). */
  readonly cellId?: string | undefined;
  /** The workspace's default language. */
  readonly locale?: string | undefined;
  readonly actor: ControlPlaneActor;
  /** Default `{ kind: "invite" }`. */
  readonly owner?: ProvisionOwner | undefined;
  /**
   * E3.11: the id the caller already claimed the slug under in the cell directory
   * (`withSlugClaim`). The row is inserted with exactly this id. Absent: the column default.
   */
  readonly workspaceId?: string | undefined;
}

/** Events the new workspace announces (the server wires `@fundroom/events` `publish`). */
export type ProvisioningEvent = "workspace.created" | "membership.created";

export interface ProvisioningDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  /** Invitation rows and mail (the owner invite). */
  readonly identity: IdentityDeps;
  readonly hooks: () => readonly ControlPlaneHooks[];
  /** The cell a workspace goes to when the input names none (CELL_ID). Default `default`. */
  readonly defaultCellId?: string | undefined;
  /** Outbox events, in the workspace's system context, same transaction. */
  readonly publish?:
    | ((tx: Tx, ctx: TenantContext, type: ProvisioningEvent, payload: JsonObject) => Promise<void>)
    | undefined;
  /**
   * The seeded legal documents (`@fundroom/compliance` `seedDefaults` + the default-disclaimer
   * setting), in the workspace's system context, inside a savepoint.
   */
  readonly seed?:
    | ((
        tx: Tx,
        ctx: TenantContext,
        ws: { readonly id: string; readonly slug: string; readonly name: string },
        actor: { readonly membershipId: string | null; readonly userId: string | null },
      ) => Promise<void>)
    | undefined;
  /** Drops the single-tenant resolver cache after commit. */
  readonly invalidate?: (() => void) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
  readonly now?: (() => Date) | undefined;
  /**
   * E3.11: the cell directory. `provisionWorkspace` (and signup) claim the slug in it before
   * their transaction and activate it after the commit (`withSlugClaim`). Absent: no claim.
   */
  readonly directory?: PlacementDirectory | undefined;
}

export class ProvisioningError extends Error {
  override readonly name = "ProvisioningError";
  constructor(
    readonly reason:
      | "slug_taken"
      | "plan_unavailable"
      | "cell_unavailable"
      | "invalid_email"
      /** E3.11: the cell directory could not be asked whether the slug is free. */
      | "directory_unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface ProvisionResult {
  readonly workspace: ProvisionedWorkspace & {
    readonly name: string;
    readonly cellId: string;
    readonly status: WorkspaceStatus;
    readonly createdAt: Date;
  };
  /** The owner's membership (signup), or null (invited). */
  readonly ownerMembershipId: string | null;
  readonly invite: CreatedInvite | null;
  /** Sends the owner invitation and drops caches. Call after the transaction commits. */
  afterCommit(): Promise<{ readonly inviteMailed: boolean | null }>;
}

const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u;

/**
 * Provisions inside the caller's HOST transaction (signup consumes its challenge and creates the
 * user in the same one). Restores the transaction's context before returning.
 */
export async function provisionWorkspaceInTx(
  tx: Tx,
  deps: ProvisioningDeps,
  input: ProvisionWorkspaceInput,
): Promise<ProvisionResult> {
  let ownerEmail: string;
  try {
    ownerEmail = normalizeEmail(input.ownerEmail);
  } catch {
    throw new ProvisioningError("invalid_email", "invalid owner email address");
  }
  const owner = input.owner ?? { kind: "invite" };
  const slug = normalizeWorkspaceSlug(input.slug);
  const name = input.name.trim();
  const legalName = input.legalName.trim();
  const country = input.country.trim().toUpperCase();
  const cellId = provisioningCellOf(deps, input);
  const saved = await readTxContext(tx);

  // 1. What the workspace is placed on must be assignable.
  if (input.planId !== null) {
    const plan = await findPlanRow(tx, input.planId);
    if (plan === undefined || plan.archivedAt !== null) {
      throw new ProvisioningError("plan_unavailable", "no such plan, or it is archived");
    }
  }
  const cell = await findCell(tx, cellId);
  if (cell === undefined || cell.status !== "active") {
    throw new ProvisioningError("cell_unavailable", "no such cell, or it takes no new workspaces");
  }
  // The invitee's account, if any, read while the transaction is still in the host context (the
  // user table is not readable from the workspace's).
  const existingUserId =
    owner.kind === "invite" ? await findUserIdByEmail(tx, ownerEmail) : undefined;

  // 2. The row.
  const inserted = await insertWorkspace(tx, {
    ...(input.workspaceId === undefined ? {} : { id: input.workspaceId }),
    slug,
    name,
    cellId,
    legalName,
    country,
    planId: input.planId,
    ...(input.locale !== undefined && LOCALE_RE.test(input.locale)
      ? { defaultLocale: input.locale }
      : {}),
  });
  if (inserted === undefined) {
    throw new ProvisioningError("slug_taken", `the address "${slug}" is taken`);
  }
  const ws: ProvisionedWorkspace = {
    id: inserted.id,
    slug: inserted.slug,
    legalName,
    country,
    planId: input.planId,
    ownerEmail,
  };

  // 3. The hooks (sanctions, then billing), before our first audit.
  for (const hook of deps.hooks()) {
    if (hook.onWorkspaceCreated === undefined) continue;
    await hook.onWorkspaceCreated(tx as unknown as TransactionHandle, ws);
    await restoreTxContext(tx, saved);
  }

  // 4. The workspace's own records.
  const ctx = systemContext(ws.id);
  await enterSystemContext(tx, ws.id);
  await deps.publish?.(tx, ctx, "workspace.created", { workspaceId: ws.id, slug: ws.slug });
  let ownerMembershipId: string | null = null;
  let invite: CreatedInvite | null = null;
  const source = input.actor.kind === "operator" ? "platform" : input.actor.source;
  if (owner.kind === "member") {
    const now = deps.now?.() ?? new Date();
    const membership = await new MembershipRepo(ctx, tx).create({
      userId: owner.userId,
      kind: "staff",
      role: "owner",
      status: "active",
      source,
      activatedAt: now,
      lastSeenAt: now,
    });
    ownerMembershipId = membership.id;
    await new AttestationRepo(ctx, tx).record({
      membershipId: membership.id,
      kind: owner.attestationKind,
      signedAt: now,
      data: { ...(owner.attestationData ?? {}), source },
    });
    await deps.publish?.(tx, ctx, "membership.created", {
      membershipId: membership.id,
      userId: owner.userId,
      kind: "staff",
      role: "owner",
      source,
      inviteId: null,
    });
    await auditTenantChain(tx, deps.audit, ws.id, input.actor, {
      action: "membership.created",
      resourceKind: "membership",
      resourceId: membership.id,
      subjectMembershipId: membership.id,
      meta: { source, kind: "staff", role: "owner", attestation: owner.attestationKind },
    });
  } else {
    invite = await writeInvite(
      deps.identity,
      ctx,
      tx,
      {
        workspaceId: ws.id,
        workspaceName: name,
        email: ownerEmail,
        kind: "staff",
        role: "owner",
        send: false,
        actorKind: "system",
        ...(input.actor.requestId === undefined ? {} : { requestId: input.actor.requestId }),
      },
      existingUserId,
    );
  }
  if (deps.seed !== undefined) {
    const seed = deps.seed;
    try {
      await tx.transaction(async (sp) => {
        await seed(
          sp,
          ctx,
          { id: ws.id, slug: ws.slug, name },
          {
            membershipId: ownerMembershipId,
            userId: owner.kind === "member" ? owner.userId : null,
          },
        );
      });
    } catch (error) {
      deps.log?.("control_plane.seed_failed", {
        level: "error",
        workspaceId: ws.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await enterSystemContext(tx, ws.id);
    }
  }
  const facts: JsonObject = { slug: ws.slug, source, planId: ws.planId, cellId };
  await auditTenantChain(tx, deps.audit, ws.id, input.actor, {
    action: "workspace.created",
    resourceKind: "workspace",
    resourceId: ws.id,
    meta: facts,
  });

  // 5. The platform chain, last.
  await auditPlatformChain(tx, deps.audit, input.actor, {
    action: "workspace.created",
    resourceKind: "workspace",
    resourceId: ws.id,
    meta: { ...facts, workspaceId: ws.id, legalName, country },
  });

  const state = await readWorkspaceState(tx, ws.id);
  await restoreTxContext(tx, saved);

  return {
    workspace: {
      ...ws,
      name,
      cellId,
      status: state?.status ?? "active",
      createdAt: inserted.createdAt,
    },
    ownerMembershipId,
    invite,
    async afterCommit() {
      deps.invalidate?.();
      if (invite === null) return { inviteMailed: null };
      try {
        await sendInviteEmail(
          deps.identity,
          ownerEmail,
          { workspaceId: ws.id, workspaceName: name },
          invite.url,
          invite.invite.expiresAt,
        );
        return { inviteMailed: true };
      } catch (error) {
        deps.log?.("control_plane.owner_invite_mail_failed", {
          level: "warn",
          workspaceId: ws.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return { inviteMailed: false };
      }
    },
  };
}

/** The cell a provisioning input lands on. */
export function provisioningCellOf(deps: ProvisioningDeps, input: ProvisionWorkspaceInput): string {
  return input.cellId ?? deps.defaultCellId ?? "default";
}

/**
 * E3.11: runs `create` under a directory claim of the input's slug (`withSlugClaim`), mapping a
 * cross-cell conflict to the same `ProvisioningError('slug_taken')` the local unique index gives.
 */
export async function withProvisioningClaim<T>(
  deps: ProvisioningDeps,
  input: ProvisionWorkspaceInput,
  create: (workspaceId: string) => Promise<T>,
): Promise<T> {
  try {
    return await withSlugClaim(
      deps.directory,
      {
        slug: input.slug,
        cellId: provisioningCellOf(deps, input),
        workspaceId: input.workspaceId,
        log: deps.log,
      },
      create,
    );
  } catch (error) {
    if (isPlacementError(error)) throw new ProvisioningError(error.reason, error.message);
    throw error;
  }
}

/** Creates and seeds a workspace in its own host transaction, runs the hooks, invites the owner. */
export async function provisionWorkspace(
  deps: ProvisioningDeps,
  input: ProvisionWorkspaceInput,
): Promise<ProvisionResult["workspace"] & { readonly inviteMailed: boolean | null }> {
  // The directory claim first, outside the cell transaction (E3.11): no pool connection or row
  // lock is held while another database answers.
  const result = await withProvisioningClaim(deps, input, (workspaceId) =>
    deps.db.withHost((tx) => provisionWorkspaceInTx(tx, deps, { ...input, workspaceId })),
  );
  const { inviteMailed } = await result.afterCommit();
  return { ...result.workspace, inviteMailed };
}
