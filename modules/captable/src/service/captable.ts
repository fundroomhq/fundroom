import type { Membership, TenantContext, Tx } from "@fundroom/db";
import { systemContext } from "@fundroom/db";
import { formatFixed } from "@fundroom/decimal";
import { delegationAdmitsModule } from "@fundroom/domain";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import { type Actor, CaptableError } from "../errors.js";
import { type ImportPlan, planImport } from "../import-plan.js";
import {
  type CaptableSettings,
  DEFAULT_DISCLAIMER,
  decimalText,
  effectiveDisclaimer,
  fullyDilutedByClass,
  fullyDilutedByLine,
  type ImportFormat,
  type InvestorSummary,
  investorSummary,
  parseSettings,
  percentPlaces,
  type SecurityKind,
  SNAPSHOT_LIST_LIMIT,
  TOTALS_SCHEMA_VERSION,
  totalOf,
} from "../model.js";
import { CaptableRepo } from "../repos/captable-repo.js";
import { fixed, previewBody, snapshotBody, snapshotDetailBody, summaryInputs } from "../views.js";

/*
 * The cap-table service (E3.6 §8). A snapshot is a record: it is imported as a draft, published
 * (superseding the previous published one) and never edited; only a draft may be deleted. Every
 * writer takes the per-workspace cap-table advisory lock first (`CaptableRepo.lockWorkspace`).
 */

export interface ImportInput {
  readonly format: ImportFormat;
  readonly csv: string;
  readonly asOf: string;
  readonly note?: string | undefined;
}

const PEOPLE_PAGE = 500;

/**
 * Live members by lower-cased address: `active`, not past `expires_at`, and not delegates (a
 * delegate acts for an investor; it is never the holder). Read through identity's
 * `MembershipRepo`, the sanctioned seam onto `core.*`.
 */
async function liveMemberEmails(
  services: ModuleServices,
  ctx: TenantContext,
  tx: Tx,
): Promise<Map<string, string>> {
  const repo = new MembershipRepo(ctx, tx);
  const now = services.now();
  const out = new Map<string, string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await repo.listPeople({ statuses: ["active"], limit: PEOPLE_PAGE, cursor });
    for (const p of page.items) {
      const m = p.membership;
      if (m.role === "delegate" || p.email === null) continue;
      if (m.expiresAt !== null && m.expiresAt.getTime() <= now.getTime()) continue;
      out.set(p.email.toLowerCase(), m.id);
    }
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return out;
}

/**
 * The plan for a CSV, on the caller's transaction. Members whose erasure has been requested are
 * taken out of the address book and the file re-planned (planning is pure and cheap), so a line is
 * never linked to somebody being erased — and the dry-run and the import, which both come here,
 * produce the same plan for the same file and the same workspace state.
 */
async function planIn(
  services: ModuleServices,
  ctx: TenantContext,
  tx: Tx,
  input: ImportInput,
): Promise<ImportPlan> {
  const members = await liveMemberEmails(services, ctx, tx);
  const plan = (m: ReadonlyMap<string, string>) =>
    planImport({ format: input.format, csv: input.csv, members: m });
  let result = plan(members);
  if (result.ok) {
    const matched = [
      ...new Set(
        result.plan.lines.flatMap((l) => (l.membershipId === null ? [] : [l.membershipId])),
      ),
    ];
    const erased = new Set<string>();
    for (const id of matched) if (await services.legal.isErased(tx, ctx, id)) erased.add(id);
    if (erased.size > 0) {
      result = plan(new Map([...members].filter(([, id]) => !erased.has(id))));
    }
  }
  if (!result.ok) {
    throw new CaptableError("import_invalid", "the CSV cannot be imported", {
      reason: result.reason,
      problems: result.problems,
    });
  }
  return result.plan;
}

export interface CaptableService {
  dryRun(ctx: TenantContext, input: ImportInput): Promise<ReturnType<typeof previewBody>>;
  import(
    ctx: TenantContext,
    input: ImportInput,
    actor: Actor,
  ): Promise<{
    snapshot: ReturnType<typeof snapshotBody>;
    preview: ReturnType<typeof previewBody>;
  }>;
  list(ctx: TenantContext): Promise<ReturnType<typeof snapshotBody>[]>;
  detail(ctx: TenantContext, id: string): Promise<ReturnType<typeof snapshotDetailBody>>;
  publish(ctx: TenantContext, id: string, actor: Actor): Promise<ReturnType<typeof snapshotBody>>;
  remove(ctx: TenantContext, id: string, actor: Actor): Promise<void>;
  settings(ctx: TenantContext): Promise<CaptableSettings & { defaultDisclaimer: string }>;
  putSettings(
    ctx: TenantContext,
    settings: CaptableSettings,
    actor: Actor,
  ): Promise<CaptableSettings & { defaultDisclaimer: string }>;
  me(
    ctx: TenantContext,
    membership: Pick<Membership, "id" | "role" | "delegateScope" | "principalMembershipId">,
  ): Promise<MeBody>;
}

export interface MeBody {
  snapshotId: string;
  asOf: string;
  disclaimer: string;
  holdings: {
    className: string;
    kind: SecurityKind;
    shares: string | null;
    amount: string | null;
    currency: string | null;
    issuedOn: string | null;
  }[];
  ownership: { fullyDilutedShares: string; percentFullyDiluted: string };
  summary: InvestorSummary | null;
}

const notFound = (what = "no such snapshot") => new CaptableError("not_found", what);

export function createCaptableService(services: ModuleServices): CaptableService {
  const { db } = services;
  return {
    async dryRun(ctx, input) {
      const plan = await db.withTenant(ctx, (tx) => planIn(services, ctx, tx, input));
      return previewBody(plan, input.asOf);
    },

    async import(ctx, input, actor) {
      return db.withTenant(ctx, async (tx) => {
        const repo = new CaptableRepo(ctx, tx);
        await repo.lockWorkspace();
        const plan = await planIn(services, ctx, tx, input);
        const note = input.note?.trim() ? input.note.trim() : null;
        const row = await repo.insertSnapshot({
          asOf: input.asOf,
          source: plan.source,
          note,
          totals: plan.summary as unknown as Record<string, unknown>,
          totalsSchemaVersion: TOTALS_SCHEMA_VERSION,
          importedBy: actor.membershipId,
        });
        const classIds = await repo.insertClasses(row.id, plan.classes);
        await repo.insertHoldings(
          row.id,
          classIds,
          plan.lines.map((l) => ({
            classIndex: l.classIndex,
            holderName: l.holderName,
            holderEmail: l.holderEmail,
            membershipId: l.membershipId,
            shares: l.shares === null ? null : formatFixed(l.shares, 6),
            amount: l.amount === null ? null : formatFixed(l.amount, 6),
            currency: l.currency,
            issuedOn: l.issuedOn,
          })),
        );
        await services.audit.record(tx, ctx, {
          action: "captable.snapshot_imported",
          resourceKind: "captable_snapshot",
          resourceId: row.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId,
          sessionId: actor.sessionId,
          meta: {
            source: plan.source,
            asOf: input.asOf,
            classes: plan.classes.length,
            lines: plan.lines.length,
            matched: plan.matched,
            warnings: plan.warnings.length,
          },
        });
        return {
          snapshot: snapshotBody(row, plan.summary),
          preview: previewBody(plan, input.asOf),
        };
      });
    },

    async list(ctx) {
      const rows = await db.withTenant(ctx, (tx) =>
        new CaptableRepo(ctx, tx).list(SNAPSHOT_LIST_LIMIT),
      );
      return rows.map((r) => snapshotBody(r));
    },

    async detail(ctx, id) {
      return db.withTenant(ctx, async (tx) => {
        const repo = new CaptableRepo(ctx, tx);
        const row = await repo.byId(id);
        if (row === undefined) throw notFound();
        return snapshotDetailBody(row, await repo.classesOf(id), await repo.holdingsOf(id));
      });
    },

    async publish(ctx, id, actor) {
      return db.withTenant(ctx, async (tx) => {
        const repo = new CaptableRepo(ctx, tx);
        await repo.lockWorkspace();
        const row = await repo.lockById(id);
        if (row === undefined) throw notFound();
        if (row.status !== "draft") {
          throw new CaptableError("conflict", `the snapshot is ${row.status}, not a draft`, {
            reason: "not_draft",
            status: row.status,
          });
        }
        const previous = await repo.supersedePublished();
        const published = await repo.markPublished(id, services.now());
        await services.audit.record(tx, ctx, {
          action: "captable.snapshot_published",
          resourceKind: "captable_snapshot",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId,
          sessionId: actor.sessionId,
          meta: { asOf: published.asOf, supersededSnapshotId: previous },
        });
        return snapshotBody(published);
      });
    },

    async remove(ctx, id, actor) {
      await db.withTenant(ctx, async (tx) => {
        const repo = new CaptableRepo(ctx, tx);
        await repo.lockWorkspace();
        const row = await repo.lockById(id);
        if (row === undefined) throw notFound();
        if (row.status !== "draft") {
          throw new CaptableError("conflict", `a ${row.status} snapshot is a record and stays`, {
            reason: "not_draft",
            status: row.status,
          });
        }
        await repo.deleteDraft(id);
        await services.audit.record(tx, ctx, {
          action: "captable.snapshot_deleted",
          resourceKind: "captable_snapshot",
          resourceId: id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId,
          sessionId: actor.sessionId,
          meta: { asOf: row.asOf, source: row.source },
        });
      });
    },

    async settings(ctx) {
      const config = await db.withTenant(ctx, (tx) => new CaptableRepo(ctx, tx).readConfig());
      return { ...parseSettings(config), defaultDisclaimer: DEFAULT_DISCLAIMER };
    },

    async putSettings(ctx, next, actor) {
      const disclaimer = next.disclaimer?.trim() ? next.disclaimer.trim() : null;
      const stored = { investorView: next.investorView, disclaimer };
      await db.withTenant(ctx, async (tx) => {
        const repo = new CaptableRepo(ctx, tx);
        if (!(await repo.writeSettings(stored))) throw notFound("the module is not enabled");
        await services.audit.record(tx, ctx, {
          action: "captable.settings_changed",
          resourceKind: "workspace",
          resourceId: ctx.workspaceId,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId,
          sessionId: actor.sessionId,
          meta: { investorView: stored.investorView, customDisclaimer: disclaimer !== null },
        });
      });
      return { ...stored, defaultDisclaimer: DEFAULT_DISCLAIMER };
    },

    /*
     * The investor's card. Two transactions, never nested: the published snapshot, its classes
     * and the settings are read as the workspace's `system` actor (an external member has no
     * policy on `snapshot` / `security_class`), then the member's own lines are read in *their*
     * context, where RLS (`holding_external_own`) — not this code — decides which lines exist.
     */
    async me(ctx, membership) {
      if (
        membership.role === "delegate" &&
        !delegationAdmitsModule(membership.delegateScope, "captable")
      )
        throw notFound("nothing to show");
      const sys = systemContext(ctx.workspaceId);
      const holderId =
        membership.role === "delegate" ? membership.principalMembershipId : membership.id;
      const base = await db.withTenant(sys, async (tx) => {
        const repo = new CaptableRepo(sys, tx);
        const settings = parseSettings(await repo.readConfig());
        if (settings.investorView === "none") return undefined;
        const snap = await repo.published();
        if (snap === undefined) return undefined;
        const classes = await repo.classesOf(snap.id);
        // Every line, for the fully diluted denominator (never returned to the member).
        const holdings = await repo.holdingsOf(snap.id);
        // The holder's email identities: an unlinked line carrying one of them is theirs, as
        // erasure and the DSAR export already treat it (R5).
        const emails = holderId === null ? [] : await repo.memberEmails(holderId);
        return { settings, snap, classes, holdings, emails: new Set(emails) };
      });
      if (base === undefined) throw notFound("nothing to show");
      // Linked lines come from the member's own context, where RLS decides; unlinked lines under
      // one of their addresses come from the system read above (RLS has no arm for them).
      const linked =
        holderId === null
          ? []
          : await db.withTenant(ctx, (tx) =>
              new CaptableRepo(ctx, tx).holdingsOfMember(base.snap.id, holderId),
            );
      const isViewers = (h: { membershipId: string | null; holderEmail: string | null }) =>
        holderId !== null &&
        (h.membershipId === holderId ||
          (h.membershipId === null &&
            h.holderEmail !== null &&
            base.emails.has(h.holderEmail.toLowerCase())));
      const byAddress = base.holdings.filter((h) => h.membershipId === null && isViewers(h));
      const own = [...linked, ...byAddress];

      const everything = base.holdings;
      const { classes, lines } = summaryInputs(base.classes, everything);
      const fdByLine = fullyDilutedByLine(classes, lines);
      const totalFd = totalOf(fullyDilutedByClass(classes, lines));
      const indexOf = new Map(everything.map((h, i) => [h.id, i]));
      const ownFd = totalOf(own.map((h) => fdByLine[indexOf.get(h.id) ?? -1] ?? 0n));
      const classById = new Map(base.classes.map((c) => [c.id, c]));
      // Kind buckets, % FD only, never about fewer than three other holders (model.ts).
      const summary =
        base.settings.investorView === "summary"
          ? investorSummary(classes, lines, isViewers)
          : null;
      return {
        snapshotId: base.snap.id,
        asOf: base.snap.asOf,
        disclaimer: effectiveDisclaimer(base.settings),
        holdings: own.map((h) => {
          const c = classById.get(h.classId);
          return {
            className: c?.name ?? "",
            kind: c?.kind ?? "common",
            shares: h.shares === null ? null : decimalText(fixed(h.shares) ?? 0n),
            amount: h.amount === null ? null : decimalText(fixed(h.amount) ?? 0n),
            currency: h.currency,
            issuedOn: h.issuedOn,
          };
        }),
        ownership: {
          fullyDilutedShares: decimalText(ownFd),
          percentFullyDiluted: percentPlaces(ownFd, totalFd, 2),
        },
        summary,
      };
    },
  };
}
