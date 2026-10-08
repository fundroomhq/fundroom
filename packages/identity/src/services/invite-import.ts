import { parseCsv } from "@fundroom/csv";
import {
  type Database,
  type InviteImport,
  type MembershipRole,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { type InviteGrant, parseInviteGrants } from "@fundroom/domain";
import { onceByKey, publish } from "@fundroom/events";
import type { JobDefinition, JsonObject } from "@fundroom/ports";
import { AuthError } from "../errors.js";
import { InviteImportRepo } from "../repos/invite-import-repo.js";
import { GroupRepo, InviteRepo, MembershipRepo } from "../repos/membership-repo.js";
import { findUserByEmail, normalizeEmail } from "../repos/user-repo.js";
import type { InviteService } from "./invites.js";
import type { IdentityDeps } from "./types.js";

/*
 * Bulk CSV invitations (design/05 §5 "Bulk CSV"): columns `email, name, firm, groups,
 * expires_at, note` (header row required, order free, `groups` semicolon-separated names).
 * `dryRun` validates every row against the workspace (unknown groups, existing members,
 * pending invites, duplicates in the file) without writing anything; `start` stores the
 * validated rows in `core.invite_import` and enqueues `identity.invite_import`, whose
 * handler sends one invitation per row, idempotently, and records per-row status.
 */
export const INVITE_IMPORT_JOB = "identity.invite_import";
export const INVITE_IMPORT_MAX_ROWS = 2000;
export const CSV_COLUMNS = ["email", "name", "firm", "groups", "expires_at", "note"] as const;

export type ImportRowStatus = "ok" | "skipped" | "error" | "invited" | "failed";

export interface ImportRow {
  readonly line: number;
  readonly email: string;
  readonly displayName: string;
  readonly firm: string;
  readonly groups: readonly string[];
  readonly groupIds: readonly string[];
  readonly expiresAt: string | null;
  readonly note: string;
  status: ImportRowStatus;
  reason?: string | undefined;
  inviteId?: string | undefined;
}

export interface ImportDefaults {
  readonly kind: "staff" | "external";
  readonly role: MembershipRole;
  readonly groupIds: readonly string[];
  readonly grants: readonly InviteGrant[];
  readonly message?: string | undefined;
  readonly expiresInDays: number;
}

export interface DryRunResult {
  readonly rows: readonly ImportRow[];
  readonly summary: { readonly ok: number; readonly skipped: number; readonly error: number };
}

/*
 * `parseCsv` used to live here. It moved to `@fundroom/csv` verbatim when the KPI importer
 * became its second consumer (E2.4 §2 D6) — one hand-rolled CSV reader, not two. Re-exported
 * so `@fundroom/identity`'s public surface is unchanged; the invite-specific column mapping,
 * the INVITE_IMPORT_MAX_ROWS cap and the invite reason codes stay here, because they are
 * policy rather than parsing.
 *
 * `headerIndex` from that package is deliberately *not* adopted below: it refuses a duplicate
 * column, whereas `indexOf` here silently takes the first. Changing that would reject invite
 * files this importer accepts today, and a refactor is not the place to tighten validation.
 */
export { parseCsv };

export interface ParsedCsv {
  readonly rows: readonly Omit<ImportRow, "groupIds" | "status" | "reason" | "inviteId">[];
  readonly errors: readonly { line: number; message: string }[];
}

/** Header-driven parse into typed rows; structural problems come back as line errors. */
export function parseInviteCsv(text: string): ParsedCsv {
  const raw = parseCsv(text);
  const header = raw[0]?.map((h) => h.trim().toLowerCase().replace(/\s+/gu, "_")) ?? [];
  const errors: { line: number; message: string }[] = [];
  if (!header.includes("email")) {
    return {
      rows: [],
      errors: [{ line: 1, message: "header row must include an `email` column" }],
    };
  }
  const idx = (name: string) => header.indexOf(name);
  const rows: ParsedCsv["rows"][number][] = [];
  raw.slice(1).forEach((cells, i) => {
    const line = i + 2;
    if (rows.length >= INVITE_IMPORT_MAX_ROWS) {
      if (rows.length === INVITE_IMPORT_MAX_ROWS)
        errors.push({ line, message: `more than ${INVITE_IMPORT_MAX_ROWS} rows; split the file` });
      return;
    }
    const get = (name: string) => {
      const j = idx(name);
      return j >= 0 ? (cells[j] ?? "").trim() : "";
    };
    const expiresRaw = get("expires_at");
    let expiresAt: string | null = null;
    if (expiresRaw) {
      const d = new Date(expiresRaw);
      if (Number.isNaN(d.getTime())) {
        errors.push({ line, message: `expires_at "${expiresRaw}" is not a date` });
        return;
      }
      expiresAt = d.toISOString();
    }
    rows.push({
      line,
      email: get("email"),
      displayName: get("name"),
      firm: get("firm"),
      groups: get("groups")
        .split(";")
        .map((g) => g.trim())
        .filter(Boolean),
      expiresAt,
      note: get("note"),
    });
  });
  return { rows, errors };
}

export interface InviteImportService {
  dryRun(ctx: TenantContext, csv: string, defaults: ImportDefaults): Promise<DryRunResult>;
  /** Stores the plan and enqueues the job; returns the import row. */
  start(
    ctx: TenantContext,
    csv: string,
    defaults: ImportDefaults,
    actor: {
      membershipId: string;
      inviterName?: string | undefined;
      workspaceName?: string | undefined;
    },
    enqueue: (data: JsonObject) => Promise<unknown>,
  ): Promise<InviteImport>;
  get(ctx: TenantContext, id: string): Promise<InviteImport | undefined>;
  list(ctx: TenantContext, limit?: number): Promise<InviteImport[]>;
  /** The worker: processes one import; safe to redeliver. */
  run(importId: string, workspaceId: string): Promise<void>;
  readonly job: JobDefinition;
}

export function createInviteImportService(
  deps: IdentityDeps,
  invites: Pick<InviteService, "create">,
): InviteImportService {
  async function validate(
    ctx: TenantContext,
    tx: Tx,
    csv: string,
    defaults: ImportDefaults,
  ): Promise<{ rows: ImportRow[]; parseErrors: ParsedCsv["errors"] }> {
    const parsed = parseInviteCsv(csv);
    const groups = new GroupRepo(ctx, tx);
    const known = await groups.list();
    const byName = new Map(known.map((g) => [g.name.toLowerCase(), g.id]));
    const pending = await new InviteRepo(ctx, tx).pendingEmails(deps.now?.() ?? new Date());
    const seen = new Set<string>();
    const memberships = new MembershipRepo(ctx, tx);
    const rows: ImportRow[] = [];
    for (const r of parsed.rows) {
      let email: string;
      try {
        email = normalizeEmail(r.email);
      } catch {
        rows.push({ ...r, groupIds: [], status: "error", reason: "invalid_email" });
        continue;
      }
      const groupIds: string[] = [];
      let bad: string | undefined;
      for (const name of r.groups) {
        const id = byName.get(name.toLowerCase());
        if (id === undefined) bad = name;
        else groupIds.push(id);
      }
      if (bad !== undefined) {
        rows.push({ ...r, email, groupIds, status: "error", reason: `unknown_group:${bad}` });
        continue;
      }
      if (seen.has(email)) {
        rows.push({ ...r, email, groupIds, status: "skipped", reason: "duplicate_in_file" });
        continue;
      }
      seen.add(email);
      if (pending.has(email)) {
        rows.push({ ...r, email, groupIds, status: "skipped", reason: "already_invited" });
        continue;
      }
      const user = await deps.db.withHost((htx) => findUserByEmail(htx, email));
      if (user && (await memberships.findForUser(user.id))) {
        rows.push({ ...r, email, groupIds, status: "skipped", reason: "already_member" });
        continue;
      }
      rows.push({
        ...r,
        email,
        groupIds: [...new Set([...defaults.groupIds, ...groupIds])],
        status: "ok",
      });
    }
    return { rows, parseErrors: parsed.errors };
  }

  function summarise(rows: readonly ImportRow[]) {
    return {
      ok: rows.filter((r) => r.status === "ok").length,
      skipped: rows.filter((r) => r.status === "skipped").length,
      error: rows.filter((r) => r.status === "error").length,
    };
  }

  async function run(importId: string, workspaceId: string): Promise<void> {
    const ctx = systemContext(workspaceId);
    const imp = await deps.db.withTenant(ctx, async (tx) => {
      const repo = new InviteImportRepo(ctx, tx);
      const row = await repo.byId(importId);
      if (row === undefined || row.status === "done" || row.status === "failed") return undefined;
      await repo.patch(importId, { status: "running", startedAt: row.startedAt ?? new Date() });
      return row;
    });
    if (imp === undefined) return;
    const defaults = imp.defaults as unknown as ImportDefaults & {
      inviterName?: string;
      workspaceName?: string;
      invitedBy?: string;
    };
    const rows = imp.rows as unknown as ImportRow[];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] as ImportRow;
      if (r.status !== "ok") continue;
      const claimed = await deps.db.withTenant(ctx, (tx) =>
        onceByKey(tx, ctx, `identity.invite_import:${importId}:${r.line}`, async () => true),
      );
      if (claimed.skipped) continue;
      try {
        const expiresInDays = r.expiresAt
          ? Math.max(1, Math.ceil((new Date(r.expiresAt).getTime() - Date.now()) / 86_400_000))
          : defaults.expiresInDays;
        const created = await invites.create({
          workspaceId,
          workspaceName: defaults.workspaceName,
          email: r.email,
          kind: defaults.kind,
          role: defaults.role,
          groupIds: r.groupIds,
          grants: parseInviteGrants(defaults.grants),
          message: defaults.message ?? (r.note || undefined),
          expiresInDays,
          invitedBy: defaults.invitedBy,
          inviterName: defaults.inviterName,
          profile: {
            ...(r.displayName ? { displayName: r.displayName } : {}),
            ...(r.firm ? { firm: r.firm } : {}),
          },
        });
        r.status = "invited";
        r.inviteId = created.invite.id;
      } catch (error) {
        r.status = "failed";
        r.reason = error instanceof AuthError ? error.code : "error";
        deps.log?.("auth.invite_import_row_failed", {
          importId,
          line: r.line,
          error: String(error),
        });
      }
      await deps.db.withTenant(ctx, (tx) =>
        new InviteImportRepo(ctx, tx).patch(importId, {
          rows,
          invited: rows.filter((x) => x.status === "invited").length,
          failed: rows.filter((x) => x.status === "failed").length,
        }),
      );
    }
    const invited = rows.filter((x) => x.status === "invited").length;
    const failed = rows.filter((x) => x.status === "failed").length;
    const skipped = rows.filter((x) => x.status === "skipped" || x.status === "error").length;
    await deps.db.withTenant(ctx, async (tx) => {
      await new InviteImportRepo(ctx, tx).patch(importId, {
        rows,
        status: "done",
        invited,
        failed,
        skipped,
        finishedAt: new Date(),
      });
      await publish(tx, ctx, "invite_import.finished", {
        importId,
        status: "done",
        invited,
        skipped,
        failed,
      });
      await deps.audit.record(tx, ctx, {
        action: "invite_import.finished",
        resourceKind: "invite_import",
        resourceId: importId,
        actorKind: "system",
        actorMembershipId: null,
        meta: { invited, skipped, failed, total: rows.length },
      });
    });
    deps.log?.("auth.invite_import_finished", { importId, workspaceId, invited, skipped, failed });
  }

  return {
    async dryRun(ctx, csv, defaults) {
      const { rows, parseErrors } = await deps.db.withTenant(ctx, (tx) =>
        validate(ctx, tx, csv, defaults),
      );
      const all: ImportRow[] = [
        ...rows,
        ...parseErrors.map(
          (e): ImportRow => ({
            line: e.line,
            email: "",
            displayName: "",
            firm: "",
            groups: [],
            groupIds: [],
            expiresAt: null,
            note: "",
            status: "error",
            reason: e.message,
          }),
        ),
      ].sort((a, b) => a.line - b.line);
      return { rows: all, summary: summarise(all) };
    },

    async start(ctx, csv, defaults, actor, enqueue) {
      const imp = await deps.db.withTenant(ctx, async (tx) => {
        const { rows, parseErrors } = await validate(ctx, tx, csv, defaults);
        if (parseErrors.length > 0)
          throw new AuthError(
            "invalid_request",
            "the CSV has structural errors; run a dry run first",
            {
              errors: parseErrors,
            },
          );
        const summary = summarise(rows);
        if (summary.ok === 0)
          throw new AuthError("invalid_request", "nothing to invite", { summary });
        const created = await new InviteImportRepo(ctx, tx).create({
          status: "queued",
          defaults: {
            ...defaults,
            invitedBy: actor.membershipId,
            inviterName: actor.inviterName,
            workspaceName: actor.workspaceName,
          } as unknown as Record<string, unknown>,
          rows: rows as unknown as Record<string, unknown>[],
          total: rows.length,
          skipped: summary.skipped + summary.error,
          createdBy: actor.membershipId,
        });
        await deps.audit.record(tx, ctx, {
          action: "invite_import.started",
          resourceKind: "invite_import",
          resourceId: created.id,
          meta: {
            total: rows.length,
            ok: summary.ok,
            skipped: summary.skipped,
            error: summary.error,
          },
        });
        return created;
      });
      await enqueue({ importId: imp.id, workspaceId: ctx.workspaceId });
      return imp;
    },

    get: (ctx, id) => deps.db.withTenant(ctx, (tx) => new InviteImportRepo(ctx, tx).byId(id)),
    list: (ctx, limit = 20) =>
      deps.db.withTenant(ctx, (tx) => new InviteImportRepo(ctx, tx).list(limit)),
    run,
    job: {
      name: INVITE_IMPORT_JOB,
      queue: { retryLimit: 3, expireInSeconds: 30 * 60 },
      handler: async (job) => {
        const data = job.data as { importId?: unknown; workspaceId?: unknown };
        if (typeof data.importId !== "string" || typeof data.workspaceId !== "string") return;
        await run(data.importId, data.workspaceId);
      },
    },
  };
}

export type { Database };
