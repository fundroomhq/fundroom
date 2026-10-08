import { core, type TenantContext, type Tx } from "@fundroom/db";
import { and, eq, isNull } from "drizzle-orm";

const { legalDocument, legalDocumentVersion, workspace } = core;

export interface NdaDocument {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  /** `nda`, `terms`, `accreditation`, …: only an `nda` is ever signed through a vendor (A6). */
  readonly kind: string;
  readonly ceremony: "clickwrap" | "esign";
  /** The current version, or undefined when never published. */
  readonly current:
    | { readonly versionNo: number; readonly body: string; readonly bodySha256: string }
    | undefined;
}

/**
 * The legal document an e-sign NDA is for, with its current version (`core.legal_document`,
 * owned by `@fundroom/compliance`; read-only here — this package never writes it). Deleted
 * documents read as absent.
 */
export async function readLegalDocument(
  tx: Tx,
  ctx: TenantContext,
  documentId: string,
): Promise<NdaDocument | undefined> {
  const docs = await tx
    .select({
      id: legalDocument.id,
      slug: legalDocument.slug,
      title: legalDocument.title,
      kind: legalDocument.kind,
      ceremony: legalDocument.ceremony,
      currentVersionId: legalDocument.currentVersionId,
    })
    .from(legalDocument)
    .where(
      and(
        eq(legalDocument.workspaceId, ctx.workspaceId),
        eq(legalDocument.id, documentId),
        isNull(legalDocument.deletedAt),
      ),
    )
    .limit(1);
  const doc = docs[0];
  if (doc === undefined) return undefined;
  let current: NdaDocument["current"];
  if (doc.currentVersionId !== null) {
    const versions = await tx
      .select({
        versionNo: legalDocumentVersion.versionNo,
        body: legalDocumentVersion.body,
        bodySha256: legalDocumentVersion.bodySha256,
      })
      .from(legalDocumentVersion)
      .where(
        and(
          eq(legalDocumentVersion.workspaceId, ctx.workspaceId),
          eq(legalDocumentVersion.id, doc.currentVersionId),
        ),
      )
      .limit(1);
    const v = versions[0];
    if (v !== undefined) {
      current = {
        versionNo: v.versionNo,
        body: v.body,
        bodySha256: Buffer.from(v.bodySha256).toString("hex"),
      };
    }
  }
  return {
    id: doc.id,
    slug: doc.slug,
    title: doc.title,
    kind: doc.kind,
    ceremony: doc.ceremony,
    current,
  };
}

/** The workspace's display name (for the NDA header); "" when unreadable. */
export async function readWorkspaceName(tx: Tx, ctx: TenantContext): Promise<string> {
  const rows = await tx
    .select({ name: workspace.name })
    .from(workspace)
    .where(eq(workspace.id, ctx.workspaceId))
    .limit(1);
  return rows[0]?.name ?? "";
}
