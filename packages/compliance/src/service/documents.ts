import { createHash } from "node:crypto";
import {
  bumpAclVersionInTx,
  type LegalAudience,
  type LegalDocument,
  type LegalDocumentKind,
  type LegalDocumentVersion,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { publish as publishEvent } from "@fundroom/events";
import { type Actor, ComplianceError } from "../errors.js";
import { LegalDocumentRepo, LegalDocumentVersionRepo } from "../repos/compliance-repo.js";
import type { TemplateContext } from "../templates/contract.js";
import { audienceToLegal, kindForTemplate, templateById } from "../templates/library.js";
import { renderTemplate } from "../templates/render.js";
import type { ComplianceDeps } from "./types.js";

/*
 * The tenant legal-document library (E1.6, design/04 §7).
 *
 * A document is mutable metadata (slug, title, kind, audience, whether it gates access) pointing
 * at an immutable chain of published versions. Acceptance names a version, never the document, so
 * an edit made after somebody clicked "I agree" cannot change what they agreed to; the version's
 * `body_sha256` is the click-wrap evidence design/04 §4 asks for.
 */

export const SLUG_RE = /^[a-z][a-z0-9-]{0,62}$/u;

/** `<slug>:v<n>` — the attestation kind, the disclaimer stamp, and the string an auditor reads. */
export function stamp(slug: string, versionNo: number): string {
  return `${slug}:v${versionNo}`;
}

/** Parses a stamp back into its parts; `undefined` for anything that is not one. */
export function parseStamp(value: string): { slug: string; versionNo: number } | undefined {
  const match = /^([a-z][a-z0-9-]{0,62}):v(\d+)$/u.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) return undefined;
  return { slug: match[1], versionNo: Number(match[2]) };
}

/** Hex sha256 of a body, the way it is stored (`bytea`) and shown (hex). */
export function bodyDigest(body: string): { hex: string; bytes: Buffer } {
  const bytes = createHash("sha256").update(body, "utf8").digest();
  return { hex: bytes.toString("hex"), bytes };
}

/** `core.legal_document.ceremony` (E3.5, migration 0019). */
export type LegalCeremony = "clickwrap" | "esign";

export interface DocumentSummary {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly kind: LegalDocumentKind;
  readonly audience: LegalAudience;
  readonly requiresAcceptance: boolean;
  /**
   * How a member accepts it (E3.5): `clickwrap` (the E1.6/E2.3 engine) or `esign` (a vendor
   * envelope; click-wrap acceptance is then refused with `esign_required`).
   */
  readonly ceremony: LegalCeremony;
  readonly templateId: string | null;
  readonly templateVersion: number | null;
  readonly currentVersionNo: number | null;
  readonly currentVersionId: string | null;
  /** `<slug>:v<n>` for the current version; `null` before the first publish. */
  readonly stamp: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DocumentDetail extends DocumentSummary {
  readonly current: LegalDocumentVersion | undefined;
  readonly versions: readonly LegalDocumentVersion[];
}

export interface CreateDocumentInput {
  readonly slug: string;
  readonly title?: string | undefined;
  readonly kind?: LegalDocumentKind | undefined;
  readonly audience?: LegalAudience | undefined;
  readonly requiresAcceptance?: boolean | undefined;
  /**
   * E3.5. The caller (route) must hold the e-sign connection lock and have checked a live
   * connection (`assertESignConnected`) before passing `esign`.
   */
  readonly ceremony?: LegalCeremony | undefined;
  /** Seed the first version from a shipped template, rendered against `context`. */
  readonly from?: string | undefined;
  readonly context?: TemplateContext | undefined;
  /** A body of the tenant's own. Ignored when `from` is set. */
  readonly body?: string | undefined;
  readonly actor: Actor;
}

export interface UpdateDocumentInput {
  readonly title?: string | undefined;
  readonly kind?: LegalDocumentKind | undefined;
  readonly audience?: LegalAudience | undefined;
  readonly requiresAcceptance?: boolean | undefined;
  /** E3.5; see `CreateDocumentInput.ceremony`. */
  readonly ceremony?: LegalCeremony | undefined;
  readonly actor: Actor;
}

export interface PublishVersionInput {
  readonly body: string;
  readonly summary?: string | undefined;
  readonly effectiveAt?: Date | undefined;
  readonly templateId?: string | undefined;
  readonly templateVersion?: number | undefined;
  readonly actor: Actor;
}

export interface PublishResult {
  readonly document: DocumentSummary;
  readonly version: LegalDocumentVersion;
  /** False when the body was identical to the current version and nothing was written. */
  readonly published: boolean;
  readonly aclVersion: number | undefined;
}

export interface DocumentService {
  list(ctx: TenantContext, tx: Tx): Promise<readonly DocumentSummary[]>;
  read(ctx: TenantContext, tx: Tx, idOrSlug: string): Promise<DocumentDetail>;
  /** The published body of one version (or the current one), for rendering. */
  version(
    ctx: TenantContext,
    tx: Tx,
    idOrSlug: string,
    versionNo?: number,
  ): Promise<LegalDocumentVersion | undefined>;
  create(ctx: TenantContext, tx: Tx, input: CreateDocumentInput): Promise<DocumentDetail>;
  update(
    ctx: TenantContext,
    tx: Tx,
    id: string,
    input: UpdateDocumentInput,
  ): Promise<DocumentSummary>;
  publish(
    ctx: TenantContext,
    tx: Tx,
    id: string,
    input: PublishVersionInput,
  ): Promise<PublishResult>;
  remove(ctx: TenantContext, tx: Tx, id: string, actor: Actor): Promise<boolean>;
}

function summarise(doc: LegalDocument, current: LegalDocumentVersion | undefined): DocumentSummary {
  return {
    id: doc.id,
    slug: doc.slug,
    title: doc.title,
    kind: doc.kind,
    audience: doc.audience,
    requiresAcceptance: doc.requiresAcceptance,
    ceremony: doc.ceremony,
    templateId: doc.templateId,
    templateVersion: doc.templateVersion,
    currentVersionNo: current?.versionNo ?? null,
    currentVersionId: doc.currentVersionId,
    stamp: current === undefined ? null : stamp(doc.slug, current.versionNo),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export function createDocumentService(deps: ComplianceDeps): DocumentService {
  const now = deps.now ?? (() => new Date());

  async function findLive(ctx: TenantContext, tx: Tx, idOrSlug: string): Promise<LegalDocument> {
    const docs = new LegalDocumentRepo(ctx, tx);
    const doc = SLUG_RE.test(idOrSlug) ? await docs.bySlug(idOrSlug) : await docs.byId(idOrSlug);
    if (doc === undefined) throw new ComplianceError("not_found", "no such legal document");
    return doc;
  }

  async function currentVersion(
    ctx: TenantContext,
    tx: Tx,
    doc: LegalDocument,
  ): Promise<LegalDocumentVersion | undefined> {
    if (doc.currentVersionId === null) return undefined;
    return new LegalDocumentVersionRepo(ctx, tx).byId(doc.currentVersionId);
  }

  const service: DocumentService = {
    async list(ctx, tx) {
      const docs = await new LegalDocumentRepo(ctx, tx).list();
      const versions = new LegalDocumentVersionRepo(ctx, tx);
      const out: DocumentSummary[] = [];
      for (const doc of docs) {
        const current =
          doc.currentVersionId === null ? undefined : await versions.byId(doc.currentVersionId);
        out.push(summarise(doc, current));
      }
      return out;
    },

    async read(ctx, tx, idOrSlug) {
      const doc = await findLive(ctx, tx, idOrSlug);
      const versions = await new LegalDocumentVersionRepo(ctx, tx).list(doc.id);
      const current = versions.find((v) => v.id === doc.currentVersionId);
      return { ...summarise(doc, current), current, versions };
    },

    async version(ctx, tx, idOrSlug, versionNo) {
      const doc = await findLive(ctx, tx, idOrSlug);
      const versions = new LegalDocumentVersionRepo(ctx, tx);
      return versionNo === undefined
        ? await currentVersion(ctx, tx, doc)
        : await versions.byNo(doc.id, versionNo);
    },

    async create(ctx, tx, input) {
      const slug = input.slug.trim().toLowerCase();
      if (!SLUG_RE.test(slug)) {
        throw new ComplianceError("validation_failed", "slug must be kebab-case", { slug });
      }
      const docs = new LegalDocumentRepo(ctx, tx);
      if ((await docs.bySlug(slug)) !== undefined) {
        throw new ComplianceError("conflict", "a document with that slug already exists", { slug });
      }

      const template = input.from === undefined ? undefined : templateById(input.from);
      if (input.from !== undefined && template === undefined) {
        throw new ComplianceError("validation_failed", "no such template", { from: input.from });
      }

      const doc = await docs.create({
        slug,
        title: input.title ?? template?.title ?? slug,
        kind: input.kind ?? (template === undefined ? "disclaimer" : kindForTemplate(template.id)),
        audience:
          input.audience ??
          (template === undefined ? "external" : audienceToLegal(template.audience)),
        requiresAcceptance: input.requiresAcceptance ?? template?.requiresAcceptance ?? false,
        ceremony: input.ceremony ?? "clickwrap",
        templateId: template?.id ?? null,
        templateVersion: template?.version ?? null,
        createdBy: input.actor.membershipId,
      });

      await deps.audit.record(tx, ctx, {
        action: "legal.document_created",
        resourceKind: "legal_document",
        resourceId: doc.id,
        actorMembershipId: input.actor.membershipId,
        ...(input.actor.requestId === undefined ? {} : { requestId: input.actor.requestId }),
        meta: {
          slug,
          kind: doc.kind,
          requiresAcceptance: doc.requiresAcceptance,
          ceremony: doc.ceremony,
          ...(template === undefined
            ? {}
            : { templateId: template.id, templateVersion: template.version }),
        },
      });

      // A document seeded from a template is published straight away: an empty legal document is
      // not a useful intermediate state, and the tenant edits by publishing v2.
      const body =
        template === undefined ? input.body : renderTemplate(template, input.context ?? {});
      if (body !== undefined && body.trim().length > 0) {
        await service.publish(ctx, tx, doc.id, {
          body,
          ...(template === undefined
            ? {}
            : { templateId: template.id, templateVersion: template.version }),
          actor: input.actor,
        });
      }
      return service.read(ctx, tx, doc.id);
    },

    async update(ctx, tx, id, input) {
      const before = await findLive(ctx, tx, id);
      const patch = {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.audience === undefined ? {} : { audience: input.audience }),
        ...(input.requiresAcceptance === undefined
          ? {}
          : { requiresAcceptance: input.requiresAcceptance }),
        ...(input.ceremony === undefined ? {} : { ceremony: input.ceremony }),
      };
      const doc = await new LegalDocumentRepo(ctx, tx).update(before.id, patch);
      if (doc === undefined) throw new ComplianceError("not_found", "no such legal document");

      await deps.audit.record(tx, ctx, {
        action: "legal.document_updated",
        resourceKind: "legal_document",
        resourceId: doc.id,
        actorMembershipId: input.actor.membershipId,
        ...(input.actor.requestId === undefined ? {} : { requestId: input.actor.requestId }),
        diff: {
          before: {
            title: before.title,
            kind: before.kind,
            audience: before.audience,
            requiresAcceptance: before.requiresAcceptance,
            ceremony: before.ceremony,
          },
          after: {
            title: doc.title,
            kind: doc.kind,
            audience: doc.audience,
            requiresAcceptance: doc.requiresAcceptance,
            ceremony: doc.ceremony,
          },
        },
        meta: { slug: doc.slug },
      });

      // Turning acceptance on closes a gate for everybody who has not accepted, so the ACL has to
      // be rebuilt; turning it off opens one. Either way the cached decisions are stale.
      if (before.requiresAcceptance !== doc.requiresAcceptance) {
        await bumpAclVersionInTx(tx, ctx.workspaceId);
      }
      return summarise(doc, await currentVersion(ctx, tx, doc));
    },

    async publish(ctx, tx, id, input) {
      const doc = await findLive(ctx, tx, id);
      const versions = new LegalDocumentVersionRepo(ctx, tx);
      const body = input.body;
      if (body.trim().length === 0) {
        throw new ComplianceError("validation_failed", "a version needs a body");
      }
      const digest = bodyDigest(body);

      // Refuse to publish an identical body. A no-op version would invalidate every acceptance on
      // record and make every member click "I agree" again for a document that did not change —
      // the most expensive possible way to achieve nothing.
      const current = await currentVersion(ctx, tx, doc);
      if (current !== undefined && Buffer.from(current.bodySha256).equals(digest.bytes)) {
        return {
          document: summarise(doc, current),
          version: current,
          published: false,
          aclVersion: undefined,
        };
      }

      const version = await versions.create({
        documentId: doc.id,
        versionNo: await versions.nextVersionNo(doc.id),
        body,
        bodySha256: digest.bytes,
        source: input.templateId === undefined ? "custom" : "template",
        templateId: input.templateId ?? null,
        templateVersion: input.templateVersion ?? null,
        summary: input.summary ?? null,
        effectiveAt: input.effectiveAt ?? now(),
        publishedAt: now(),
        createdBy: input.actor.membershipId,
      });
      const updated = await new LegalDocumentRepo(ctx, tx).update(doc.id, {
        currentVersionId: version.id,
        ...(input.templateId === undefined
          ? {}
          : { templateId: input.templateId, templateVersion: input.templateVersion }),
      });

      await deps.audit.record(tx, ctx, {
        action: "legal.document_published",
        resourceKind: "legal_document",
        resourceId: doc.id,
        actorMembershipId: input.actor.membershipId,
        ...(input.actor.requestId === undefined ? {} : { requestId: input.actor.requestId }),
        meta: {
          slug: doc.slug,
          versionNo: version.versionNo,
          bodySha256: digest.hex,
          requiresAcceptance: doc.requiresAcceptance,
        },
      });
      await publishEvent(tx, ctx, "legal.document_published", {
        documentId: doc.id,
        slug: doc.slug,
        kind: doc.kind,
        versionNo: version.versionNo,
        requiresAcceptance: doc.requiresAcceptance,
        byMembershipId: input.actor.membershipId,
      });

      // Every acceptance on record now names an older version, so every attestation gate keyed to
      // this document is unsettled again (ADR-0032). The cause is `attestation` because that is
      // the kind of rule that changed, not the document row.
      const aclVersion = doc.requiresAcceptance
        ? await bumpAclVersionInTx(tx, ctx.workspaceId)
        : undefined;

      return {
        document: summarise(updated ?? doc, version),
        version,
        published: true,
        aclVersion,
      };
    },

    async remove(ctx, tx, id, actor) {
      const doc = await findLive(ctx, tx, id);
      const removed = await new LegalDocumentRepo(ctx, tx).softDelete(doc.id, now());
      if (!removed) return false;
      await deps.audit.record(tx, ctx, {
        action: "legal.document_updated",
        resourceKind: "legal_document",
        resourceId: doc.id,
        actorMembershipId: actor.membershipId,
        ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
        meta: { slug: doc.slug, deleted: true },
      });
      if (doc.requiresAcceptance) await bumpAclVersionInTx(tx, ctx.workspaceId);
      return true;
    },
  };
  return service;
}
