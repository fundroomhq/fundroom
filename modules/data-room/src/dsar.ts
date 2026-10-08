import type { ModuleDsar } from "@fundroom/module-kit";
import { readMemberDataRoom } from "./repos/dsar-repo.js";

/*
 * The data-room part of a subject-access export (E2.7 DSAR, `modules/data-room.json`).
 *
 * Views, downloads and page dwell are analytics events (`modules/analytics.json`), and access
 * comes from kernel grants (in `profile.json`'s groups and the audit log). What the data room
 * holds about a member is what they put in, plus the forensic marks it issued to them:
 *
 *   filesUploaded     every document version they uploaded — file name, type, size, page count,
 *                     change note, time, and the document's title — **metadata only**
 *   uploads           upload sessions they started (including unfinished or failed ones)
 *   documentsCreated,
 *   foldersCreated    ids, titles/names and times of what they created
 *   questions         Q&A questions they asked (E3.3): subject, body, status, target, times, and
 *                     the answer once it was released to them (drafts and staff notes excluded)
 *   forensicMarks     E3.13: every document version they were served with an invisible forensic
 *                     mark — document, version, first/last served and the trace code printed on
 *                     their watermarked downloads (never the token or pattern seed). Detection
 *                     runs (who investigated which leak) stay in the audit log, not here.
 *
 * **Deviation, on purpose:** the file bytes are not in the export. They can be large, they are
 * envelope-encrypted and malware-scanned evidence, and the person can be sent a copy through the
 * data room itself; the export lists them so nothing is hidden. Storage keys, blob digests,
 * encryption metadata, renditions and extracted page text are internals and are left out.
 */
export const dataRoomDsar: ModuleDsar = {
  export: ({ tx, ctx, membershipId }) => readMemberDataRoom(ctx, tx, membershipId),
};
