import type { ConsentPurpose, TenantContext, Tx } from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import type { LegalServices, ResolvedDisclaimer } from "@fundroom/module-kit";
import {
  ConsentEventRepo,
  LegalDocumentRepo,
  LegalDocumentVersionRepo,
  readWorkspaceFacts,
} from "../repos/compliance-repo.js";
import { DsarRequestRepo } from "../repos/dsar-repo.js";
import { createAccreditationVerificationService } from "./accreditation-verification.js";
import { consentAllows } from "./consent.js";
import { stamp } from "./documents.js";
import { createErasureService } from "./erasure.js";
import type { ErasureDeps } from "./types.js";

/*
 * `LegalServices` (`packages/module-kit/src/manifest.ts`), the kernel seam modules see.
 *
 * A module needs these from the legal kernel and must not reach into `core.legal_document` or
 * `core.attestation` for any of them: the disclaimer to render, the stamp to freeze onto a
 * snapshot it is creating, the member's own consent answer to show them, the decision about
 * whether an optional purpose is permitted, and — since E2.5 — everything to do with accredited
 * status. Consent and accreditation in particular are kernel facts about a *person*; an analytics
 * module deciding for itself whether it may track somebody, or a round module writing its own
 * `accredited` attestation, is exactly the coupling ADR-0033 forbids.
 *
 * Every method takes the caller's transaction, because a snapshot and the stamp on it have to be
 * the same read.
 *
 * The accreditation methods are delegated to `createAccreditationVerificationService` rather than
 * written here, so that the acceptance service stays the only thing that knows how a
 * self-certification becomes two attestation rows, an audit row, a certificate and an ACL bump.
 */

export function createLegalPort(deps: ErasureDeps): LegalServices {
  const accreditation = createAccreditationVerificationService(deps);
  const erasure = createErasureService(deps);

  /** The document named by `slug`, else `legal.defaultDisclaimerSlug`, else nothing. */
  async function resolve(
    tx: Tx,
    ctx: TenantContext,
    slug: string | undefined,
  ): Promise<ResolvedDisclaimer | undefined> {
    let wanted = slug;
    if (wanted === undefined) {
      const ws = await readWorkspaceFacts(tx, ctx);
      wanted = parseWorkspaceSettings(ws?.settings ?? {}).legal.defaultDisclaimerSlug ?? undefined;
    }
    if (wanted === undefined) return undefined;

    const doc = await new LegalDocumentRepo(ctx, tx).bySlug(wanted);
    if (doc?.currentVersionId == null) return undefined;
    const version = await new LegalDocumentVersionRepo(ctx, tx).byId(doc.currentVersionId);
    if (version === undefined) return undefined;
    return {
      documentId: doc.id,
      slug: doc.slug,
      title: doc.title,
      versionNo: version.versionNo,
      body: version.body,
      bodySha256: Buffer.from(version.bodySha256).toString("hex"),
      effectiveAt: version.effectiveAt,
    };
  }

  async function stored(
    tx: Tx,
    ctx: TenantContext,
    membershipId: string,
    purpose: ConsentPurpose,
  ): Promise<boolean | null> {
    const row = await new ConsentEventRepo(ctx, tx).latestFor(membershipId, purpose);
    return row === undefined ? null : row.granted;
  }

  /*
   * `core.dsar_request` is readable by staff and system actors only (0011's RLS), so a caller
   * holding a member's own transaction would silently see "no request" — failing open. Such a
   * caller gets the answer on **its own transaction**: the transaction-local `app.actor_kind` is
   * switched to `system` for this one read and restored straight after, on the same connection
   * (the move `IdentityErasureRepo.revokeWorkspaceSessions` makes with `app.user_id`). Opening a
   * system transaction here instead would take a second pool connection while the caller holds
   * one — the deadlock this codebase keeps rediscovering (analytics' tracking and ingest call
   * this inside their own transactions). The workspace fence is untouched: the read stays inside
   * the caller's workspace. It works in a read-only (view-as) transaction too: `set_config` is
   * not a write.
   */
  async function erased(tx: Tx, ctx: TenantContext, membershipId: string): Promise<boolean> {
    if (ctx.actorKind === "staff" || ctx.actorKind === "system") {
      return new DsarRequestRepo(ctx, tx).hasLiveFor(membershipId);
    }
    return new DsarRequestRepo(ctx, tx).hasLiveForInOwnTx(membershipId);
  }

  return {
    ...accreditation,

    resolveDisclaimer: (tx, ctx, slug) => resolve(tx, ctx, slug),

    async stampFor(tx, ctx, slug) {
      const resolved = await resolve(tx, ctx, slug);
      return resolved === undefined ? undefined : stamp(resolved.slug, resolved.versionNo);
    },

    consentFor: (tx, ctx, membershipId, purpose) => stored(tx, ctx, membershipId, purpose),

    isErased: (tx, ctx, membershipId) => erased(tx, ctx, membershipId),

    /*
     * GPC reaches this in two ways. A caller with a browser in front of it passes `signals.gpc`.
     * Everything without one — an ESP open arriving hours later, the hot-list rollup, a
     * notification fan-out — relies on the *durable* form: the kernel's GPC middleware
     * (`apps/server/src/middleware/gpc.ts`) records a `source: "gpc"` refusal for both purposes
     * the first time a signed-in member's request carries `Sec-GPC: 1`, so the stored answer
     * below is already `false`. A later explicit grant made from a browser *without* GPC is a
     * newer statement of the same person's wish and wins, until a GPC request records a newer
     * refusal again.
     *
     * An erased member (a non-cancelled DSAR request) is never allowed anything: their rows are
     * gone or going, and a late fact must not quietly recreate them.
     */
    async allowsPurpose(tx, ctx, membershipId, purpose, signals) {
      if (await erased(tx, ctx, membershipId)) return false;
      const ws = await readWorkspaceFacts(tx, ctx);
      const { consentMode } = parseWorkspaceSettings(ws?.settings ?? {}).legal;
      return consentAllows({
        mode: consentMode,
        stored: await stored(tx, ctx, membershipId, purpose),
        gpc: signals?.gpc,
      });
    },

    // E2.6 decision 5: a module reports its part of an erasure request; see `./erasure.ts`.
    completeErasureStep: (tx, ctx, requestId, module, counts) =>
      erasure.completeStep(ctx, tx, requestId, module, counts),
  };
}
