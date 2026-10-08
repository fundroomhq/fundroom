import type { TenantContext, Tx } from "@fundroom/db";
import { dsarRow } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { and, asc, eq, inArray } from "drizzle-orm";
import { traceCode } from "../forensic/marks.js";
import { document, documentVersion, folder, upload } from "../schema/dataroom.js";
import { forensicMark } from "../schema/forensic.js";
import { qaAnswer, qaQuestion } from "../schema/qa.js";

const CAP = 10_000;

/**
 * What the data room holds about one member (E2.7 DSAR export; see `../dsar.ts`): the files they
 * uploaded — metadata only — and the folders and documents they created. Who viewed what is
 * analytics' (`modules/analytics.json`), not this module's.
 */
export async function readMemberDataRoom(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
): Promise<JsonObject> {
  const ws = ctx.workspaceId;
  const versions = await tx
    .select({
      id: documentVersion.id,
      documentId: documentVersion.documentId,
      documentTitle: document.title,
      versionNo: documentVersion.versionNo,
      fileName: documentVersion.fileName,
      contentType: documentVersion.contentType,
      sizeBytes: documentVersion.sizeBytes,
      pageCount: documentVersion.pageCount,
      changeNote: documentVersion.changeNote,
      createdAt: documentVersion.createdAt,
    })
    .from(documentVersion)
    .leftJoin(
      document,
      and(eq(document.id, documentVersion.documentId), eq(document.workspaceId, ws)),
    )
    .where(and(eq(documentVersion.workspaceId, ws), eq(documentVersion.uploadedBy, membershipId)))
    .orderBy(asc(documentVersion.createdAt), asc(documentVersion.id))
    .limit(CAP);
  const uploads = await tx
    .select({
      id: upload.id,
      fileName: upload.fileName,
      declaredSize: upload.declaredSize,
      declaredType: upload.declaredType,
      status: upload.status,
      createdAt: upload.createdAt,
      completedAt: upload.completedAt,
    })
    .from(upload)
    .where(and(eq(upload.workspaceId, ws), eq(upload.createdBy, membershipId)))
    .orderBy(asc(upload.createdAt), asc(upload.id))
    .limit(CAP);
  const documents = await tx
    .select({ id: document.id, title: document.title, createdAt: document.createdAt })
    .from(document)
    .where(and(eq(document.workspaceId, ws), eq(document.createdBy, membershipId)))
    .orderBy(asc(document.createdAt), asc(document.id))
    .limit(CAP);
  const folders = await tx
    .select({ id: folder.id, name: folder.name, createdAt: folder.createdAt })
    .from(folder)
    .where(and(eq(folder.workspaceId, ws), eq(folder.createdBy, membershipId)))
    .orderBy(asc(folder.createdAt), asc(folder.id))
    .limit(CAP);
  // E3.3: the questions they asked, and each answer once it was released to them. Internal
  // notes, assignee, draft answers and approval state are staff working data, not theirs.
  const questions = await tx
    .select({
      id: qaQuestion.id,
      targetKind: qaQuestion.targetKind,
      documentId: qaQuestion.documentId,
      folderId: qaQuestion.folderId,
      subject: qaQuestion.subject,
      body: qaQuestion.body,
      status: qaQuestion.status,
      createdAt: qaQuestion.createdAt,
      releasedAt: qaQuestion.releasedAt,
      answer: qaAnswer.body,
    })
    .from(qaQuestion)
    .leftJoin(
      qaAnswer,
      and(
        eq(qaAnswer.questionId, qaQuestion.id),
        inArray(qaQuestion.status, ["answered", "published"]),
      ),
    )
    .where(and(eq(qaQuestion.workspaceId, ws), eq(qaQuestion.askerMembershipId, membershipId)))
    .orderBy(asc(qaQuestion.createdAt), asc(qaQuestion.id))
    .limit(CAP);
  // E3.13: the forensic marks issued to them — which version they were served with an invisible
  // mark, when, and the trace code printed on their downloads. Never the token or a seed.
  const marks = await tx
    .select({
      documentId: forensicMark.documentId,
      documentTitle: document.title,
      versionId: forensicMark.versionId,
      versionNo: documentVersion.versionNo,
      token: forensicMark.token,
      firstServedAt: forensicMark.firstServedAt,
      lastServedAt: forensicMark.lastServedAt,
    })
    .from(forensicMark)
    .leftJoin(document, and(eq(document.id, forensicMark.documentId), eq(document.workspaceId, ws)))
    .leftJoin(
      documentVersion,
      and(eq(documentVersion.id, forensicMark.versionId), eq(documentVersion.workspaceId, ws)),
    )
    .where(and(eq(forensicMark.workspaceId, ws), eq(forensicMark.membershipId, membershipId)))
    .orderBy(asc(forensicMark.firstServedAt), asc(forensicMark.id))
    .limit(CAP);
  return {
    version: 3,
    filesUploaded: versions.map((r) => dsarRow(r)),
    uploads: uploads.map((r) => dsarRow(r)),
    documentsCreated: documents.map((r) => dsarRow(r)),
    foldersCreated: folders.map((r) => dsarRow(r)),
    questions: questions.map(({ documentId, folderId, answer, ...r }) =>
      dsarRow({
        ...r,
        targetId: r.targetKind === "document" ? documentId : folderId,
        releasedAnswer: answer ?? null,
      }),
    ),
    forensicMarks: marks.map(({ token, ...r }) =>
      dsarRow({ ...r, trace: traceCode(new Uint8Array(token)) }),
    ),
  };
}
