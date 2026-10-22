import { type TenantContext, TenantRepo, type Tx } from "@fundroom/db";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { FINAL_SCAN_REASONS, NOT_EXPORTED_DETAIL } from "../model.js";
import {
  type Blob,
  blob,
  type Document,
  type DocumentVersion,
  document,
  documentVersion,
  type Folder,
  folder,
  type NewBlob,
  type NewDocument,
  type NewDocumentVersion,
  type NewFolder,
  type NewRendition,
  type NewUpload,
  type PageTextRow,
  pageText,
  type Rendition,
  type RenditionKind,
  rendition,
  type Upload,
  type UploadStatus,
  upload,
} from "../schema/dataroom.js";

/*
 * Repositories over `dataroom.*` (design/06 §3: the only place drizzle is touched in this
 * module). Reads carry the workspace fence explicitly on top of RLS; writes force it.
 */
export class FolderRepo extends TenantRepo<typeof folder> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(folder, ctx, tx);
  }

  byId(id: string): Promise<Folder | undefined> {
    return this.findById(id);
  }

  async live(id: string): Promise<Folder | undefined> {
    const rows = await this.findMany(and(eq(folder.id, id), isNull(folder.deletedAt)));
    return rows[0];
  }

  async root(): Promise<Folder | undefined> {
    const rows = await this.findMany(and(isNull(folder.parentId), isNull(folder.deletedAt)));
    return rows[0];
  }

  /** Every live folder of the workspace, parents before children. */
  async listLive(): Promise<Folder[]> {
    return this.tx
      .select()
      .from(folder)
      .where(this.scope(isNull(folder.deletedAt)))
      .orderBy(sql`nlevel(${folder.path})`, asc(folder.sortOrder), asc(folder.name));
  }

  async children(parentId: string): Promise<Folder[]> {
    return this.tx
      .select()
      .from(folder)
      .where(this.scope(and(eq(folder.parentId, parentId), isNull(folder.deletedAt))))
      .orderBy(asc(folder.sortOrder), asc(folder.name));
  }

  /** Live descendants (strict) of a path. */
  async subtree(path: string): Promise<Folder[]> {
    return this.tx
      .select()
      .from(folder)
      .where(
        this.scope(
          and(sql`${folder.path} <@ ${path}::ltree`, sql`${folder.path} <> ${path}::ltree`),
        ),
      )
      .orderBy(sql`nlevel(${folder.path})`);
  }

  async listDeleted(): Promise<Folder[]> {
    return this.tx
      .select()
      .from(folder)
      .where(this.scope(isNotNull(folder.deletedAt)))
      .orderBy(desc(folder.deletedAt));
  }

  async purgeable(now: Date): Promise<Folder[]> {
    return this.findMany(and(isNotNull(folder.deletedAt), lte(folder.purgeAfter, now)));
  }

  create(values: Omit<NewFolder, "workspaceId">): Promise<Folder> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        Folder,
        | "name"
        | "parentId"
        | "path"
        | "sortOrder"
        | "staffOnly"
        | "deletedAt"
        | "deletedBy"
        | "purgeAfter"
      >
    >,
  ): Promise<Folder | undefined> {
    const rows = await this.tx
      .update(folder)
      .set(patch)
      .where(this.scope(eq(folder.id, id)))
      .returning();
    return rows[0];
  }

  /**
   * Paths of every staff-only folder (E3.5), trashed ones included: what the staff-only veil
   * (`service/access.ts`) tests a node's path against.
   */
  async staffOnlyPaths(): Promise<string[]> {
    const rows = await this.tx
      .select({ path: folder.path })
      .from(folder)
      .where(this.scope(eq(folder.staffOnly, true)));
    return rows.map((r) => r.path);
  }

  /**
   * The vault's per-workspace transaction lock (E3.5): taken first by every vault transaction, by
   * nothing else, so it cannot take part in a lock-order cycle.
   */
  async lockVault(): Promise<void> {
    await this.tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dataroom.vault:${this.ctx.workspaceId}`}::text, 0))`,
    );
  }

  /** Whether `path` lies at or below a staff-only folder (E3.5; the RLS predicate's own function). */
  async underStaffOnly(path: string): Promise<boolean> {
    const result = await this.tx.execute(
      sql`SELECT dataroom.under_staff_only(${path}::ltree) AS veiled`,
    );
    return (result.rows[0] as { veiled?: boolean } | undefined)?.veiled === true;
  }

  /** Rewrites the path prefix of a moved subtree (the folder itself and everything below). */
  async rewritePaths(oldPath: string, newPath: string): Promise<number> {
    const rows = await this.tx
      .update(folder)
      .set({
        path: sql`CASE WHEN nlevel(${folder.path}) = nlevel(${oldPath}::ltree) THEN ${newPath}::ltree ELSE ${newPath}::ltree || subpath(${folder.path}, nlevel(${oldPath}::ltree)) END`,
      })
      .where(this.scope(sql`${folder.path} <@ ${oldPath}::ltree`))
      .returning({ id: folder.id });
    return rows.length;
  }

  /** Soft-deletes (or restores) a whole subtree. Returns the affected ids. */
  async markSubtree(
    path: string,
    values: { deletedAt: Date | null; deletedBy: string | null; purgeAfter: Date | null },
    onlyWhere?: "live" | "deleted",
  ): Promise<string[]> {
    const state =
      onlyWhere === "live"
        ? isNull(folder.deletedAt)
        : onlyWhere === "deleted"
          ? isNotNull(folder.deletedAt)
          : undefined;
    const rows = await this.tx
      .update(folder)
      .set(values)
      .where(this.scope(and(sql`${folder.path} <@ ${path}::ltree`, state)))
      .returning({ id: folder.id });
    return rows.map((r) => r.id);
  }

  hardDelete(id: string): Promise<number> {
    return this.deleteById(id);
  }

  /**
   * The folders and documents whose ltree path breaks the tree's shape (E3.2 L-2), deleted rows
   * included, at most `limit`: the root's path must be `rootLabel`, every other folder's must be
   * its parent's path plus its own label (the uuid without hyphens), and a document's
   * `folder_path` must be its folder's path. ACL rules are derived from these paths
   * (`rederiveRulePaths`, `resource_path <@`), so a crafted one is a grant over someone else's
   * subtree.
   */
  async treeShapeViolations(
    rootLabel: string,
    limit = 5,
  ): Promise<{ kind: "folder" | "document"; id: string }[]> {
    const ws = this.ctx.workspaceId;
    const result = await this.tx.execute(sql`
      SELECT 'folder' AS kind, f.id::text AS id FROM dataroom.folder f
        LEFT JOIN dataroom.folder p ON p.id = f.parent_id AND p.workspace_id = f.workspace_id
       WHERE f.workspace_id = ${ws}::uuid
         AND CASE WHEN f.parent_id IS NULL THEN f.path <> text2ltree(${rootLabel})
                  ELSE p.id IS NULL
                    OR f.path <> p.path || text2ltree(replace(f.id::text, '-', '')) END
      UNION ALL
      SELECT 'document', d.id::text FROM dataroom.document d
        LEFT JOIN dataroom.folder f ON f.id = d.folder_id AND f.workspace_id = d.workspace_id
       WHERE d.workspace_id = ${ws}::uuid AND (f.id IS NULL OR d.folder_path <> f.path)
      LIMIT ${limit}`);
    return result.rows as { kind: "folder" | "document"; id: string }[];
  }
}

export class DocumentRepo extends TenantRepo<typeof document> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(document, ctx, tx);
  }

  byId(id: string): Promise<Document | undefined> {
    return this.findById(id);
  }

  async live(id: string): Promise<Document | undefined> {
    const rows = await this.findMany(and(eq(document.id, id), isNull(document.deletedAt)));
    return rows[0];
  }

  /**
   * The live document, row-locked for a read-modify-write of its fields: `FOR NO KEY UPDATE`, the
   * mode the `UPDATE` itself takes, so the lock order is exactly the UPDATE's (after any of its Q&A
   * question rows, `QaLifecycleRepo.lockOnTargets`). It serialises every writer of the row (two
   * PATCHes judge `protection` on what they replace), but it does NOT conflict with the
   * `FOR KEY SHARE` a foreign-key check takes when a row referencing the document is inserted
   * (Q&A import, upload start, a new version, a forensic mark). `FOR UPDATE` would: such inserts
   * run after the workspace row (Q&A import, a quota-checked upload start), while this transaction
   * takes the workspace row later (its audit) — a deadlock (A-3 RR2 H1).
   */
  async lockLive(id: string): Promise<Document | undefined> {
    const rows = await this.tx
      .select()
      .from(document)
      .where(this.scope(and(eq(document.id, id), isNull(document.deletedAt))))
      .limit(1)
      .for("no key update");
    return rows[0];
  }

  async byIds(ids: readonly string[]): Promise<Document[]> {
    if (ids.length === 0) return [];
    return this.findMany(and(inArray(document.id, [...ids]), isNull(document.deletedAt)));
  }

  /**
   * The document vaulted from an e-signature envelope (E3.5), in any state — trashed included:
   * the vault's dedupe key (`document_esign_envelope_idx`).
   */
  async byEsignEnvelope(envelopeId: string): Promise<Document | undefined> {
    const rows = await this.findMany(eq(document.esignEnvelopeId, envelopeId));
    return rows[0];
  }

  async inFolder(folderId: string): Promise<Document[]> {
    return this.tx
      .select()
      .from(document)
      .where(this.scope(and(eq(document.folderId, folderId), isNull(document.deletedAt))))
      .orderBy(asc(document.sortOrder), asc(document.title));
  }

  async listLive(): Promise<Document[]> {
    return this.tx
      .select()
      .from(document)
      .where(this.scope(isNull(document.deletedAt)))
      .orderBy(asc(document.sortOrder), asc(document.title));
  }

  /** Live documents anywhere under a folder path (the folder itself included). */
  async underPath(path: string): Promise<Document[]> {
    return this.findMany(
      and(sql`${document.folderPath} <@ ${path}::ltree`, isNull(document.deletedAt)),
    );
  }

  async listDeleted(): Promise<Document[]> {
    return this.tx
      .select()
      .from(document)
      .where(this.scope(isNotNull(document.deletedAt)))
      .orderBy(desc(document.deletedAt));
  }

  async purgeable(now: Date): Promise<Document[]> {
    return this.findMany(
      and(
        isNotNull(document.deletedAt),
        lte(document.purgeAfter, now),
        eq(document.legalHold, false),
      ),
    );
  }

  create(values: Omit<NewDocument, "workspaceId">): Promise<Document> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        Document,
        | "title"
        | "folderId"
        | "folderPath"
        | "sortOrder"
        | "currentVersionId"
        | "protection"
        | "legalHold"
        | "legalHoldReason"
        | "legalHoldSetBy"
        | "legalHoldSetAt"
        | "deletedAt"
        | "deletedBy"
        | "purgeAfter"
      >
    >,
  ): Promise<Document | undefined> {
    const rows = await this.tx
      .update(document)
      .set(patch)
      .where(this.scope(eq(document.id, id)))
      .returning();
    return rows[0];
  }

  /** Rewrites `folder_path` for every document under a moved folder subtree. */
  async rewritePaths(oldPath: string, newPath: string): Promise<number> {
    const rows = await this.tx
      .update(document)
      .set({
        folderPath: sql`CASE WHEN nlevel(${document.folderPath}) = nlevel(${oldPath}::ltree) THEN ${newPath}::ltree ELSE ${newPath}::ltree || subpath(${document.folderPath}, nlevel(${oldPath}::ltree)) END`,
      })
      .where(this.scope(sql`${document.folderPath} <@ ${oldPath}::ltree`))
      .returning({ id: document.id });
    return rows.length;
  }

  /** Soft-deletes (or restores) the documents under a folder subtree; held documents are skipped. */
  async markUnderPath(
    path: string,
    values: { deletedAt: Date | null; deletedBy: string | null; purgeAfter: Date | null },
    onlyWhere: "live" | "deleted",
  ): Promise<string[]> {
    const state = onlyWhere === "live" ? isNull(document.deletedAt) : isNotNull(document.deletedAt);
    const rows = await this.tx
      .update(document)
      .set(values)
      .where(
        this.scope(
          and(sql`${document.folderPath} <@ ${path}::ltree`, state, eq(document.legalHold, false)),
        ),
      )
      .returning({ id: document.id });
    return rows.map((r) => r.id);
  }

  async countUnderPath(path: string, state: "live" | "any"): Promise<number> {
    const rows = await this.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(document)
      .where(
        this.scope(
          and(
            sql`${document.folderPath} <@ ${path}::ltree`,
            state === "live" ? isNull(document.deletedAt) : undefined,
          ),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  hardDelete(id: string): Promise<number> {
    return this.deleteById(id);
  }

  /** Title search across live documents (`simple` FTS + prefix). */
  async search(query: string, limit: number): Promise<Document[]> {
    const terms = query
      .split(/\s+/u)
      .filter(Boolean)
      .map((t) => `${t.replace(/[^\p{L}\p{N}]/gu, "")}:*`)
      .filter((t) => t.length > 2)
      .join(" & ");
    if (terms.length === 0) return [];
    return this.tx
      .select()
      .from(document)
      .where(
        this.scope(
          and(
            isNull(document.deletedAt),
            sql`${document}.search_tsv @@ to_tsquery('simple', ${terms})`,
          ),
        ),
      )
      .orderBy(asc(document.title))
      .limit(limit);
  }
}

export class VersionRepo extends TenantRepo<typeof documentVersion> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(documentVersion, ctx, tx);
  }

  byId(id: string): Promise<DocumentVersion | undefined> {
    return this.findById(id);
  }

  async byIds(ids: readonly string[]): Promise<DocumentVersion[]> {
    if (ids.length === 0) return [];
    return this.findMany(inArray(documentVersion.id, [...ids]));
  }

  async forDocument(documentId: string): Promise<DocumentVersion[]> {
    return this.tx
      .select()
      .from(documentVersion)
      .where(this.scope(eq(documentVersion.documentId, documentId)))
      .orderBy(desc(documentVersion.versionNo));
  }

  async nextVersionNo(documentId: string): Promise<number> {
    const rows = await this.tx
      .select({ max: sql<number | null>`max(${documentVersion.versionNo})` })
      .from(documentVersion)
      .where(this.scope(eq(documentVersion.documentId, documentId)));
    return (rows[0]?.max ?? 0) + 1;
  }

  create(values: Omit<NewDocumentVersion, "workspaceId">): Promise<DocumentVersion> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    patch: Partial<Pick<DocumentVersion, "pageCount" | "renderStatus" | "renderDetail">>,
  ): Promise<DocumentVersion | undefined> {
    const rows = await this.tx
      .update(documentVersion)
      .set(patch)
      .where(this.scope(eq(documentVersion.id, id)))
      .returning();
    return rows[0];
  }

  /**
   * The ingest's final write: only a version still `pending` changes, so of two jobs finishing
   * the same version (a redelivery racing a hand-on) exactly one gets the row back, and only it
   * records `document.ingested`.
   */
  async finishIfPending(
    id: string,
    patch: Pick<DocumentVersion, "pageCount" | "renderStatus" | "renderDetail">,
  ): Promise<DocumentVersion | undefined> {
    const rows = await this.tx
      .update(documentVersion)
      .set(patch)
      .where(
        this.scope(and(eq(documentVersion.id, id), eq(documentVersion.renderStatus, "pending"))),
      )
      .returning();
    return rows[0];
  }

  async firstForBlob(blobId: string): Promise<DocumentVersion | undefined> {
    const rows = await this.tx
      .select()
      .from(documentVersion)
      .where(this.scope(eq(documentVersion.blobId, blobId)))
      .orderBy(asc(documentVersion.createdAt))
      .limit(1);
    return rows[0];
  }

  /** Versions on `blobId` whose ingest has not finished (`render_status = 'pending'`). */
  async pendingForBlob(blobId: string): Promise<DocumentVersion[]> {
    return this.tx
      .select()
      .from(documentVersion)
      .where(
        this.scope(
          and(eq(documentVersion.blobId, blobId), eq(documentVersion.renderStatus, "pending")),
        ),
      )
      .orderBy(asc(documentVersion.createdAt));
  }

  /**
   * A blob's scan is being retried (`BlobRepo.retryScan`): every version on it goes back to
   * `pending` so its ingest runs again (the earlier attempt marked it `failed`, "not scanned").
   * Returns the versions, for the caller to enqueue their ingest jobs.
   */
  async resetRenderForBlob(blobId: string): Promise<DocumentVersion[]> {
    return this.tx
      .update(documentVersion)
      .set({ renderStatus: "pending", renderDetail: null, pageCount: null })
      .where(this.scope(eq(documentVersion.blobId, blobId)))
      .returning();
  }

  async countForBlob(blobId: string): Promise<number> {
    const rows = await this.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(documentVersion)
      .where(this.scope(eq(documentVersion.blobId, blobId)));
    return rows[0]?.n ?? 0;
  }

  hardDelete(id: string): Promise<number> {
    return this.deleteById(id);
  }
}

export class BlobRepo extends TenantRepo<typeof blob> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(blob, ctx, tx);
  }

  byId(id: string): Promise<Blob | undefined> {
    return this.findById(id);
  }

  async bySha256(sha256: Buffer): Promise<Blob | undefined> {
    const rows = await this.findMany(eq(blob.sha256, sha256));
    return rows[0];
  }

  create(values: Omit<NewBlob, "workspaceId">): Promise<Blob> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        Blob,
        | "storageKey"
        | "encryption"
        | "scanStatus"
        | "scannedAt"
        | "scanEngine"
        | "scanDetail"
        | "purgeAfter"
        | "contentType"
      >
    >,
  ): Promise<Blob | undefined> {
    const rows = await this.tx
      .update(blob)
      .set(patch)
      .where(this.scope(eq(blob.id, id)))
      .returning();
    return rows[0];
  }

  /**
   * Claims the blob for one ingest job's scan: `scanning`, recording the claiming version
   * (`scan_claimed_by`), conditional on the row still naming the quarantine object the job read
   * (`storageKey`) and on nobody else scanning it. A `scanning` row is only taken over by the
   * job of the version that claimed it (pg-boss redelivers the same job, so the earlier attempt
   * was this job's own) or once it is stale (`scanned_at` before `staleBefore`: the scanning job
   * died and its attempts expired). An `error` row is claimed unless its detail is final
   * (`isFinalScanDetail`: too large, engine limits, an import without bytes), so a retried dead
   * letter scans again; a final error waits for the bytes to be uploaded again (`retryScan`).
   * Undefined when the claim was lost: the caller reloads and does not scan.
   */
  async claimScan(
    id: string,
    storageKey: string,
    opts: { readonly claimant: string; readonly at: Date; readonly staleBefore: Date },
  ): Promise<Blob | undefined> {
    // `isFinalScanDetail` in SQL; null (no detail) is not final.
    const exact = [...FINAL_SCAN_REASONS, NOT_EXPORTED_DETAIL].map((d) => sql`${d}`);
    const prefixed = FINAL_SCAN_REASONS.map(
      (r) => sql`starts_with(${blob.scanDetail}, ${`${r}:`})`,
    );
    const retryable = sql`(${blob.scanDetail} IN (${sql.join(exact, sql`, `)}) OR ${sql.join(prefixed, sql` OR `)}) IS NOT TRUE`;
    const rows = await this.tx
      .update(blob)
      .set({ scanStatus: "scanning", scannedAt: opts.at, scanClaimedBy: opts.claimant })
      .where(
        this.scope(
          and(
            eq(blob.id, id),
            eq(blob.storageKey, storageKey),
            or(
              eq(blob.scanStatus, "pending"),
              // a retryable failure (anything but a final detail; a null detail is retryable)
              and(eq(blob.scanStatus, "error"), retryable),
              and(
                eq(blob.scanStatus, "scanning"),
                or(
                  eq(blob.scanClaimedBy, opts.claimant),
                  isNull(blob.scannedAt),
                  lte(blob.scannedAt, opts.staleBefore),
                ),
              ),
            ),
          ),
        ),
      )
      .returning();
    return rows[0];
  }

  /**
   * `update`, conditional on the row still naming `storageKey` (the object the caller scanned or
   * is promoting): undefined when a re-upload or another job moved it on meanwhile.
   */
  async updateIfKey(
    id: string,
    storageKey: string,
    patch: Partial<
      Pick<
        Blob,
        "storageKey" | "encryption" | "scanStatus" | "scannedAt" | "scanEngine" | "scanDetail"
      >
    >,
    /** Also conditional on the row still having this `scan_status`. */
    opts: { readonly scanStatus?: Blob["scanStatus"] } = {},
  ): Promise<Blob | undefined> {
    const rows = await this.tx
      .update(blob)
      .set(patch)
      .where(
        this.scope(
          and(
            eq(blob.id, id),
            eq(blob.storageKey, storageKey),
            opts.scanStatus === undefined ? undefined : eq(blob.scanStatus, opts.scanStatus),
          ),
        ),
      )
      .returning();
    return rows[0];
  }

  /**
   * Locks the row for the promotion transaction while it still names `storageKey`, so two jobs
   * never both encrypt into the content-addressed key (the second would overwrite the object
   * the first recorded the encryption of). Undefined when it no longer names it. `FOR NO KEY
   * UPDATE`: the promotion changes no key column, and `document_version.blob_id` references this
   * row, so a version inserted meanwhile (its FK check takes `FOR KEY SHARE`) is not blocked for
   * the whole encryption.
   */
  async lockForPromotion(id: string, storageKey: string): Promise<Blob | undefined> {
    const rows = await this.tx
      .select()
      .from(blob)
      .where(this.scope(and(eq(blob.id, id), eq(blob.storageKey, storageKey))))
      .for("no key update");
    return rows[0];
  }

  /**
   * A blob whose scan ended in `error` gets a fresh copy of its bytes (the same SHA-256 uploaded
   * again): point it at the new quarantine object and start the scan over. Conditional on the
   * row still being `error`, so two concurrent re-uploads retry once; undefined when it was not.
   */
  async retryScan(id: string, storageKey: string): Promise<Blob | undefined> {
    const rows = await this.tx
      .update(blob)
      .set({
        storageKey,
        encryption: {},
        scanStatus: "pending",
        scannedAt: null,
        scanEngine: null,
        scanDetail: null,
        scanClaimedBy: null,
        purgeAfter: null,
      })
      .where(this.scope(and(eq(blob.id, id), eq(blob.scanStatus, "error"))))
      .returning();
    return rows[0];
  }

  /** Blobs no version references any more (candidates for the two-phase purge). */
  async orphans(): Promise<Blob[]> {
    return this.tx
      .select()
      .from(blob)
      .where(
        this.scope(
          sql`NOT EXISTS (SELECT 1 FROM ${documentVersion} v WHERE v.blob_id = ${blob.id})`,
        ),
      );
  }

  async listAll(): Promise<Blob[]> {
    return this.findMany();
  }

  /** Blobs stuck in `pending`/`scanning` longer than `olderThan` (ingest never ran or died). */
  async stale(olderThan: Date): Promise<Blob[]> {
    return this.findMany(
      and(
        or(eq(blob.scanStatus, "pending"), eq(blob.scanStatus, "scanning")),
        lte(blob.createdAt, olderThan),
      ),
    );
  }

  hardDelete(id: string): Promise<number> {
    return this.deleteById(id);
  }
}

export class RenditionRepo extends TenantRepo<typeof rendition> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(rendition, ctx, tx);
  }

  async find(
    versionId: string,
    kind: RenditionKind,
    pageNo: number | null,
  ): Promise<Rendition | undefined> {
    const rows = await this.findMany(
      and(
        eq(rendition.versionId, versionId),
        eq(rendition.kind, kind),
        pageNo === null ? isNull(rendition.pageNo) : eq(rendition.pageNo, pageNo),
      ),
    );
    return rows[0];
  }

  async forVersion(versionId: string): Promise<Rendition[]> {
    return this.findMany(eq(rendition.versionId, versionId));
  }

  async listAll(): Promise<Rendition[]> {
    return this.findMany();
  }

  /** Insert; a concurrent renderer of the same page wins the unique index and we keep theirs. */
  async createIfAbsent(values: Omit<NewRendition, "workspaceId">): Promise<Rendition> {
    const rows = await this.tx
      .insert(rendition)
      .values({ ...values, workspaceId: this.ctx.workspaceId })
      .onConflictDoNothing()
      .returning();
    const inserted = rows[0];
    if (inserted !== undefined) return inserted;
    const existing = await this.find(values.versionId, values.kind, values.pageNo ?? null);
    if (existing === undefined) throw new Error("rendition insert lost the race and vanished");
    return existing;
  }

  async deleteForVersion(versionId: string): Promise<Rendition[]> {
    return this.tx
      .delete(rendition)
      .where(this.scope(eq(rendition.versionId, versionId)))
      .returning();
  }
}

export class PageTextRepo extends TenantRepo<typeof pageText> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(pageText, ctx, tx);
  }

  async replace(versionId: string, texts: readonly string[]): Promise<void> {
    await this.tx.delete(pageText).where(this.scope(eq(pageText.versionId, versionId)));
    const rows = texts
      .map((text, i) => ({ workspaceId: this.ctx.workspaceId, versionId, pageNo: i + 1, text }))
      .filter((r) => r.text.length > 0);
    if (rows.length > 0) await this.tx.insert(pageText).values(rows);
  }

  /** One page's text; "" when the page has no text layer (no row is stored for an empty page). */
  async page(versionId: string, pageNo: number): Promise<string> {
    const rows = await this.tx
      .select({ text: pageText.text })
      .from(pageText)
      .where(this.scope(and(eq(pageText.versionId, versionId), eq(pageText.pageNo, pageNo))))
      .limit(1);
    return rows[0]?.text ?? "";
  }

  async forVersion(versionId: string): Promise<PageTextRow[]> {
    return this.tx
      .select()
      .from(pageText)
      .where(this.scope(eq(pageText.versionId, versionId)))
      .orderBy(asc(pageText.pageNo));
  }

  /** Pages of one version matching a query (`simple` FTS, prefix on the last term), with a headline. */
  async search(
    versionId: string,
    query: string,
    limit: number,
  ): Promise<{ pageNo: number; snippet: string }[]> {
    const terms = query
      .split(/\s+/u)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter((t) => t.length > 0);
    if (terms.length === 0) return [];
    const tsquery = terms.map((t, i) => (i === terms.length - 1 ? `${t}:*` : t)).join(" & ");
    const rows = await this.tx
      .select({
        pageNo: pageText.pageNo,
        snippet: sql<string>`ts_headline('simple', ${pageText.text}, to_tsquery('simple', ${tsquery}), 'MaxWords=18, MinWords=8, StartSel=«, StopSel=»')`,
      })
      .from(pageText)
      .where(
        this.scope(
          and(
            eq(pageText.versionId, versionId),
            sql`${pageText}.tsv @@ to_tsquery('simple', ${tsquery})`,
          ),
        ),
      )
      .orderBy(asc(pageText.pageNo))
      .limit(limit);
    return rows;
  }
}

export class UploadRepo extends TenantRepo<typeof upload> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(upload, ctx, tx);
  }

  byId(id: string): Promise<Upload | undefined> {
    return this.findById(id);
  }

  create(values: Omit<NewUpload, "workspaceId">): Promise<Upload> {
    return this.insertOne(values);
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        Upload,
        "status" | "blobId" | "versionId" | "error" | "completedAt" | "multipartUploadId"
      >
    >,
  ): Promise<Upload | undefined> {
    const rows = await this.tx
      .update(upload)
      .set(patch)
      .where(this.scope(eq(upload.id, id)))
      .returning();
    return rows[0];
  }

  async listByStatus(statuses: readonly UploadStatus[]): Promise<Upload[]> {
    return this.findMany(inArray(upload.status, [...statuses]));
  }

  /**
   * Declared bytes of the uploads still open (`pending`/`stored`, not past their expiry): what is
   * on its way into the data room but not yet in the usage rollup (E3.10 storage quota).
   */
  async openDeclaredBytes(now: Date): Promise<number> {
    const rows = await this.tx
      .select({ total: sql<string | null>`sum(${upload.declaredSize})` })
      .from(upload)
      .where(
        this.scope(
          and(inArray(upload.status, ["pending", "stored"]), sql`${upload.expiresAt} > ${now}`),
        ),
      );
    return Number(rows[0]?.total ?? 0);
  }

  async expired(now: Date): Promise<Upload[]> {
    return this.findMany(
      and(inArray(upload.status, ["pending", "stored"]), lte(upload.expiresAt, now)),
    );
  }

  hardDelete(id: string): Promise<number> {
    return this.deleteById(id);
  }
}

/** What the search index needs of one live document (E2.8). */
export interface DocumentSearchRow {
  readonly id: string;
  readonly title: string;
  readonly folderPath: string;
  readonly updatedAt: Date;
  /** Page text of the current version in page order, or null when that version is not ready/servable. */
  readonly body: string | null;
  /** At or below a staff-only folder (E3.5): indexed with the `staff` ACL. */
  readonly staffOnly: boolean;
}

/** What the search index needs of one live folder (E2.8). */
export interface FolderSearchRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly path: string;
  readonly updatedAt: Date;
  /** At or below a staff-only folder (E3.5): indexed with the `staff` ACL. */
  readonly staffOnly: boolean;
}

/** Characters of page text read per document (the engine caps a body at 200 000). */
export const SEARCH_BODY_MAX = 200_000;

/**
 * Search sources (E2.8): live documents with their current version's page text joined in one
 * query, and live folders. Keyset-paged by id so a full reindex never holds a whole data room.
 */
export class SearchSourceRepo extends TenantRepo<typeof document> {
  constructor(ctx: TenantContext, tx: Tx) {
    super(document, ctx, tx);
  }

  async documents(filter: {
    readonly ids?: readonly string[] | undefined;
    readonly underPath?: string | undefined;
    readonly afterId?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<DocumentSearchRow[]> {
    if (filter.ids !== undefined && filter.ids.length === 0) return [];
    // Body only for a current version the viewer could open (`blobServable`): `ready`, and a
    // clean blob — or an unscanned one while the workspace accepts unscanned files
    // (`settings.dataRoom.allowUnscanned`, read here so a job needs no settings in hand; the
    // settings route asks for a reindex when it flips). Text of a newer pending version does
    // not exist yet; an older version's text is never used.
    const body = sql<string | null>`CASE WHEN ${documentVersion}.render_status = 'ready'
      AND (${blob}.scan_status = 'clean' OR (${blob}.scan_status = 'skipped' AND COALESCE(
        (SELECT (w.settings -> 'dataRoom' ->> 'allowUnscanned')::boolean
           FROM core.workspace w WHERE w.id = ${document}.workspace_id), false)))
      THEN (SELECT left(string_agg(pt.text, E'\n' ORDER BY pt.page_no), ${SEARCH_BODY_MAX}::int)
            FROM dataroom.page_text pt
            WHERE pt.workspace_id = ${document}.workspace_id AND pt.version_id = ${documentVersion}.id)
      END`;
    const rows = await this.tx
      .select({
        id: document.id,
        title: document.title,
        folderPath: document.folderPath,
        updatedAt: document.updatedAt,
        body,
        staffOnly: sql<boolean>`dataroom.under_staff_only(${document}.folder_path)`,
      })
      .from(document)
      .leftJoin(documentVersion, eq(documentVersion.id, document.currentVersionId))
      .leftJoin(blob, eq(blob.id, documentVersion.blobId))
      .where(
        this.scope(
          and(
            isNull(document.deletedAt),
            filter.ids === undefined ? undefined : inArray(document.id, [...filter.ids]),
            filter.underPath === undefined
              ? undefined
              : sql`${document}.folder_path <@ ${filter.underPath}::ltree`,
            filter.afterId === undefined ? undefined : sql`${document}.id > ${filter.afterId}`,
          ),
        ),
      )
      .orderBy(asc(document.id))
      .limit(filter.limit ?? 10_000);
    return rows.map((r) => ({ ...r, body: r.body ?? null, staffOnly: r.staffOnly === true }));
  }

  async folders(filter: {
    readonly ids?: readonly string[] | undefined;
    readonly underPath?: string | undefined;
    readonly afterId?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<FolderSearchRow[]> {
    if (filter.ids !== undefined && filter.ids.length === 0) return [];
    const rows = await this.tx
      .select({
        id: folder.id,
        parentId: folder.parentId,
        name: folder.name,
        path: folder.path,
        updatedAt: folder.updatedAt,
        staffOnly: sql<boolean>`dataroom.under_staff_only(${folder}.path)`,
      })
      .from(folder)
      .where(
        and(
          eq(folder.workspaceId, this.ctx.workspaceId),
          isNull(folder.deletedAt),
          filter.ids === undefined ? undefined : inArray(folder.id, [...filter.ids]),
          filter.underPath === undefined
            ? undefined
            : sql`${folder}.path <@ ${filter.underPath}::ltree`,
          filter.afterId === undefined ? undefined : sql`${folder}.id > ${filter.afterId}`,
        ),
      )
      .orderBy(asc(folder.id))
      .limit(filter.limit ?? 10_000);
    return rows.map((r) => ({ ...r, staffOnly: r.staffOnly === true }));
  }

  /**
   * Live documents whose current version's blob was never scanned (`skipped`) — the ones whose
   * text is searchable only while the workspace allows unscanned files. Keyset-paged by id.
   */
  async unscannedDocumentIds(filter: {
    readonly afterId?: string | undefined;
    readonly limit: number;
  }): Promise<string[]> {
    const rows = await this.tx
      .select({ id: document.id })
      .from(document)
      .innerJoin(documentVersion, eq(documentVersion.id, document.currentVersionId))
      .innerJoin(blob, eq(blob.id, documentVersion.blobId))
      .where(
        this.scope(
          and(
            isNull(document.deletedAt),
            sql`${blob}.scan_status = 'skipped'`,
            filter.afterId === undefined ? undefined : sql`${document}.id > ${filter.afterId}`,
          ),
        ),
      )
      .orderBy(asc(document.id))
      .limit(filter.limit);
    return rows.map((r) => r.id);
  }

  /**
   * After a workspace import (E2.8): the carried current versions lost their renditions and page
   * text (derived, not exported), so each `ready` one goes back to `pending` for the ingest job
   * to re-derive; a `pending` version whose blob never got past the scanner cannot be processed
   * and is marked `failed`. Returns the versions to enqueue.
   */
  async resetForRederive(): Promise<{ versionId: string; blobId: string }[]> {
    const ws = this.ctx.workspaceId;
    await this.tx.execute(sql`
      UPDATE dataroom.document_version v SET render_status = 'failed',
        render_detail = 'the file was not processed before the workspace export'
      FROM dataroom.blob b
      WHERE v.workspace_id = ${ws} AND b.id = v.blob_id AND v.render_status = 'pending'
        AND b.scan_status NOT IN ('clean', 'skipped')`);
    const rows = await this.tx
      .update(documentVersion)
      .set({ renderStatus: "pending", renderDetail: null })
      .where(
        and(
          eq(documentVersion.workspaceId, ws),
          sql`(${documentVersion}.render_status = 'pending' OR (${documentVersion}.render_status = 'ready'
            AND ${documentVersion}.id IN (SELECT d.current_version_id FROM dataroom.document d
              WHERE d.workspace_id = ${ws} AND d.current_version_id IS NOT NULL)))`,
        ),
      )
      .returning({ versionId: documentVersion.id, blobId: documentVersion.blobId });
    return rows;
  }
}
