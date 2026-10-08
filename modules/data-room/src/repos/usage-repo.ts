import type { Tx } from "@fundroom/db";
import { sql } from "drizzle-orm";

/*
 * What the data room has in object storage for one workspace (E3.10 usage metering): every blob
 * (content-addressed originals, including those of recycled-but-not-purged documents and Q&A
 * attachments) plus every rendition (thumbnails, page images, sanitised PDFs). A row is deleted
 * when its object is, so the sum is what is stored now. The workspace's `system` context.
 */
export async function storedBytes(tx: Tx, workspaceId: string): Promise<number> {
  const r = await tx.execute<{ bytes: string | null }>(sql`
    SELECT (SELECT coalesce(sum(size_bytes), 0) FROM dataroom.blob WHERE workspace_id = ${workspaceId})
         + (SELECT coalesce(sum(size_bytes), 0) FROM dataroom.rendition WHERE workspace_id = ${workspaceId})
           AS bytes`);
  return Number(r.rows[0]?.bytes ?? 0);
}
