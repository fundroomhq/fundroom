import { systemContext, type TenantContext, type Tx } from "@fundroom/db";
import { publish } from "@fundroom/events";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import type { DocumentRenderPort, RenderedImage } from "@fundroom/ports";
import { renditionKey } from "@fundroom/storage";
import { type Actor, DataRoomError } from "../errors.js";
import {
  createMarkIssuer,
  hex,
  type IssuedMark,
  type MarkIssuer,
  traceLine,
} from "../forensic/marks.js";
import { dayBucket, type Protection, type WatermarkViewer, watermarkLines } from "../model.js";
import { BlobRepo, PageTextRepo, RenditionRepo } from "../repos/dataroom-repo.js";
import type { Blob, Document, DocumentVersion } from "../schema/dataroom.js";
import { createObjectStore, type Encryption, parseEncryption } from "./objects.js";

/*
 * Delivery (§8, ADR-0015): page images and downloads leave through the app only. Pages are
 * rasterised lazily on first request at one width, stored encrypted as `page` renditions,
 * and watermarked per viewer at request time (an in-process cache keyed by version, page,
 * viewer and day absorbs the re-reads of a reading session). Downloads are watermarked PDFs
 * unless the viewer holds the original-download right.
 */
export const PAGE_WIDTH = 1600;
const PDF_CACHE_BYTES = 256 * 1024 * 1024;
const WATERMARK_CACHE_ENTRIES = 400;
const VIEW_DEDUPE_MS = 30 * 60_000;

class Lru<V extends { readonly size: number }> {
  private readonly map = new Map<string, V>();
  private bytes = 0;
  constructor(
    private readonly maxBytes: number,
    private readonly maxEntries: number,
  ) {}
  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key: string, value: V): void {
    if (this.map.has(key)) this.delete(key);
    this.map.set(key, value);
    this.bytes += value.size;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.maxBytes && this.map.size <= this.maxEntries) break;
      this.map.delete(k);
      this.bytes -= v.size;
    }
  }
  delete(key: string): void {
    const v = this.map.get(key);
    if (v === undefined) return;
    this.map.delete(key);
    this.bytes -= v.size;
  }
}

export interface DeliveryContext {
  readonly ctx: TenantContext;
  readonly document: Document;
  readonly version: DocumentVersion;
  readonly blob: Blob;
  readonly protection: Protection;
  readonly viewer: WatermarkViewer & { readonly membershipId: string };
  readonly actor: Actor;
  /**
   * Whose forensic mark the bytes carry when that is not `viewer` (E3.13 FIX1 D3): staff viewing
   * as an investor (E2.7) see the investor's visible line but carry their OWN mark — staff
   * impersonation must never create evidence pointing at the investor, and must never hand out
   * an unmarked raster either.
   */
  readonly markMembershipId?: string | undefined;
}

export interface DeliveredBytes {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

export interface DeliveryService {
  /** The watermark identity of a member (email, display name), resolved once per request. */
  watermarkViewer(
    ctx: TenantContext,
    membershipId: string,
    workspaceSlug: string,
  ): Promise<WatermarkViewer & { readonly membershipId: string }>;
  page(input: DeliveryContext, pageNo: number): Promise<DeliveredBytes>;
  thumbnail(input: Pick<DeliveryContext, "ctx" | "version">): Promise<DeliveredBytes | undefined>;
  download(
    input: DeliveryContext,
    variant: "original" | "watermarked",
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    contentType: string;
    fileName: string;
    size: number | undefined;
  }>;
  search(
    ctx: TenantContext,
    versionId: string,
    query: string,
  ): Promise<{ pageNo: number; snippet: string }[]>;
  /**
   * The unwatermarked, unmarked page raster of any version (rendered and cached on first use):
   * the reference a forensic detection registers a leaked image onto (E3.13).
   */
  referencePage(
    input: Pick<DeliveryContext, "ctx" | "version" | "blob">,
    pageNo: number,
  ): Promise<RenderedImage>;
  /** The extracted text layer of one page (E2.8, assistive technology). Read-only. */
  pageText(ctx: TenantContext, versionId: string, pageNo: number): Promise<string>;
  /** `document.viewed` once per (session, version) per half hour; audit + outbox. */
  recordView(input: DeliveryContext): Promise<boolean>;
}

/**
 * The per-viewer layers of a served page, in order (E3.13 §1.6): the invisible forensic mark on
 * the clean raster first, then the visible watermark on top — so the visible text of one viewer
 * never sits under another layer, and the mark is computed on exactly the pixels detection
 * subtracts.
 */
export async function composePage(
  renderer: Pick<DocumentRenderPort, "embedForensicMark" | "watermarkImage">,
  image: RenderedImage,
  layers: {
    readonly mark?: IssuedMark | undefined;
    readonly lines?: readonly string[] | undefined;
  },
): Promise<RenderedImage> {
  let out = image;
  if (layers.mark !== undefined)
    out = await renderer.embedForensicMark(out, { seed: layers.mark.seed });
  if (layers.lines !== undefined) out = await renderer.watermarkImage(out, { lines: layers.lines });
  return out;
}

/** The per-viewer page cache key: version, page, viewer, day, mark token, visible layer. */
export function pageCacheKey(
  versionId: string,
  pageNo: number,
  membershipId: string,
  day: string,
  mark: IssuedMark | undefined,
  watermark: boolean,
): string {
  return `${versionId}:${pageNo}:${membershipId}:${day}:${mark ? hex(mark.token) : "-"}:${watermark ? "w" : "-"}`;
}

/**
 * One delivery service (and its PDF/page caches) per process database, so the OpenAPI routes,
 * the raw mount (a differently guarded services wrapper) and detection share one (E3.13 FIX1 D7).
 */
const shared = new WeakMap<object, DeliveryService>();
export function sharedDelivery(services: ModuleServices): DeliveryService {
  let d = shared.get(services.db);
  if (d === undefined) {
    d = createDeliveryService(services);
    shared.set(services.db, d);
  }
  return d;
}

export function createDeliveryService(
  services: ModuleServices,
  options: { readonly marks?: MarkIssuer | undefined } = {},
): DeliveryService {
  const { db, renderer, log } = services;
  const marks = options.marks ?? createMarkIssuer(services);
  const objects = createObjectStore(services);
  const pdfCache = new Lru<{ size: number; bytes: Uint8Array }>(PDF_CACHE_BYTES, 64);
  const watermarkCache = new Lru<{ size: number; image: RenderedImage }>(
    64 * 1024 * 1024,
    WATERMARK_CACHE_ENTRIES,
  );
  const recentViews = new Map<string, number>();

  async function sourceBytes(
    ctx: TenantContext,
    version: DocumentVersion,
    blob: Blob,
  ): Promise<Uint8Array> {
    const hit = pdfCache.get(version.id);
    if (hit) return hit.bytes;
    const bytes = await db.withTenant(ctx, async (tx) => {
      const normalized = await new RenditionRepo(ctx, tx).find(version.id, "pdf", null);
      const encryption = parseEncryption(blob.encryption);
      if (encryption === undefined)
        throw new DataRoomError("conflict", "the file is still being processed");
      if (normalized !== undefined) {
        return objects.readBytes(tx, ctx, normalized.storageKey, encryption);
      }
      return objects.readBytes(tx, ctx, blob.storageKey, encryption);
    });
    pdfCache.set(version.id, { size: bytes.byteLength, bytes });
    return bytes;
  }

  async function readRendition(
    tx: Tx,
    ctx: TenantContext,
    key: string,
    encryption: Encryption,
  ): Promise<Uint8Array | undefined> {
    try {
      return await objects.readBytes(tx, ctx, key, encryption);
    } catch {
      return undefined;
    }
  }

  async function pageImage(
    input: Pick<DeliveryContext, "ctx" | "version" | "blob">,
    pageNo: number,
  ): Promise<RenderedImage> {
    const { ctx, version, blob } = input;
    const encryption = parseEncryption(blob.encryption);
    if (encryption === undefined)
      throw new DataRoomError("conflict", "the file is still being processed");
    const existing = await db.withTenant(ctx, async (tx) => {
      const r = await new RenditionRepo(ctx, tx).find(version.id, "page", pageNo);
      if (r === undefined) return undefined;
      const bytes = await readRendition(tx, ctx, r.storageKey, encryption);
      return bytes === undefined
        ? undefined
        : {
            bytes,
            width: r.width ?? 0,
            height: r.height ?? 0,
            contentType: r.contentType as RenderedImage["contentType"],
          };
    });
    if (existing !== undefined) return existing;
    const kind = version.contentType === "application/pdf" ? "pdf" : "image";
    const source = await sourceBytes(ctx, version, blob);
    const image = await renderer.renderPage(source, kind, pageNo, { width: PAGE_WIDTH });
    const key = renditionKey(ctx.workspaceId, version.id, "page", pageNo);
    await db.withTenant(ctx, async (tx) => {
      await objects.putBytes(tx, ctx, key, image.bytes, image.contentType);
      await new RenditionRepo(ctx, tx).createIfAbsent({
        versionId: version.id,
        kind: "page",
        pageNo,
        width: image.width,
        height: image.height,
        contentType: image.contentType,
        storageKey: key,
        sizeBytes: image.bytes.byteLength,
      });
    });
    return image;
  }

  return {
    async watermarkViewer(ctx, membershipId, workspaceSlug) {
      const sys = systemContext(ctx.workspaceId);
      const person = await db.withTenant(sys, (tx) =>
        new MembershipRepo(sys, tx).person(membershipId),
      );
      return {
        membershipId,
        email: person?.email ?? null,
        displayName: person?.displayName ?? "member",
        workspaceSlug,
        at: services.now(),
      };
    },

    async page(input, pageNo) {
      const { ctx, document, version, protection, viewer } = input;
      if (version.pageCount !== null && (pageNo < 1 || pageNo > version.pageCount)) {
        throw new DataRoomError("not_found", "no such page");
      }
      const image = await pageImage(input, pageNo);
      if (!protection.watermark && !protection.forensic)
        return { bytes: image.bytes, contentType: image.contentType };
      // The mark first (its token is part of the cache key): issued in its own system tx.
      const mark = protection.forensic
        ? await marks.issue(
            ctx.workspaceId,
            input.markMembershipId ?? viewer.membershipId,
            document.id,
            version.id,
            input.markMembershipId === undefined ? undefined : viewer.membershipId,
          )
        : undefined;
      const cacheKey = pageCacheKey(
        version.id,
        pageNo,
        viewer.membershipId,
        dayBucket(viewer.at),
        mark,
        protection.watermark,
      );
      const hit = watermarkCache.get(cacheKey);
      if (hit) return { bytes: hit.image.bytes, contentType: hit.image.contentType };
      const marked = await composePage(renderer, image, {
        mark,
        lines: protection.watermark ? watermarkLines(viewer) : undefined,
      });
      watermarkCache.set(cacheKey, { size: marked.bytes.byteLength, image: marked });
      return { bytes: marked.bytes, contentType: marked.contentType };
    },

    referencePage: (input, pageNo) => pageImage(input, pageNo),

    async thumbnail({ ctx, version }) {
      return db.withTenant(ctx, async (tx) => {
        const r = await new RenditionRepo(ctx, tx).find(version.id, "thumbnail", null);
        if (r === undefined) return undefined;
        const blob = await new BlobRepo(ctx, tx).byId(version.blobId);
        const encryption = blob ? parseEncryption(blob.encryption) : undefined;
        if (encryption === undefined) return undefined;
        const bytes = await readRendition(tx, ctx, r.storageKey, encryption);
        return bytes === undefined ? undefined : { bytes, contentType: r.contentType };
      });
    },

    async download(input, variant) {
      const { ctx, version, blob, viewer, document, actor, protection } = input;
      const encryption = parseEncryption(blob.encryption);
      if (encryption === undefined)
        throw new DataRoomError("conflict", "the file is still being processed");
      // A watermarked copy of a forensic document carries a trace of its recipient's mark
      // (visible line + PDF Info `/SeedHostTrace`). Issued before the audit, in its own tx.
      const mark =
        variant === "watermarked" && protection.forensic
          ? await marks.issue(
              ctx.workspaceId,
              input.markMembershipId ?? viewer.membershipId,
              document.id,
              version.id,
              input.markMembershipId === undefined ? undefined : viewer.membershipId,
            )
          : undefined;
      await db.withTenant(ctx, async (tx) => {
        await services.audit.record(tx, ctx, {
          action: "document.downloaded",
          resourceKind: "document",
          resourceId: document.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId,
          sessionId: actor.sessionId,
          ip: actor.ip,
          meta: { versionId: version.id, variant, forensic: mark !== undefined },
        });
        await publish(tx, ctx, "document.downloaded", {
          documentId: document.id,
          versionId: version.id,
          membershipId: actor.membershipId,
          variant,
        });
      });
      if (variant === "original") {
        const body = await db.withTenant(ctx, (tx) =>
          objects.readStream(tx, ctx, blob.storageKey, encryption),
        );
        if (body === undefined)
          throw new DataRoomError("not_found", "the file is missing from storage");
        return {
          body,
          contentType: version.contentType,
          fileName: version.fileName,
          size: version.sizeBytes,
        };
      }
      const source = await sourceBytes(ctx, version, blob);
      // Visible watermark on: the viewer's lines (+ the trace line when forensic). Forensic only
      // (E3.13 FIX1 D2): the trace line alone, tiled like the watermark, + `/SeedHostTrace`.
      const lines = protection.watermark ? watermarkLines(viewer) : [];
      const spec =
        mark === undefined
          ? { lines }
          : { lines: [...lines, traceLine(mark.token)], traceId: hex(mark.token) };
      const pdf =
        version.contentType === "application/pdf"
          ? await renderer.watermarkPdf(source, spec)
          : await renderer.watermarkPdf(
              await renderer.imageToPdf(source, version.contentType),
              spec,
            );
      const fileName = `${version.fileName.replace(/\.[^.]+$/u, "")}-watermarked.pdf`;
      return {
        body: new Blob([pdf]).stream() as unknown as ReadableStream<Uint8Array>,
        contentType: "application/pdf",
        fileName,
        size: pdf.byteLength,
      };
    },

    search: (ctx, versionId, query) =>
      db.withTenant(ctx, (tx) => new PageTextRepo(ctx, tx).search(versionId, query, 50)),

    pageText: (ctx, versionId, pageNo) =>
      db.withTenant(ctx, (tx) => new PageTextRepo(ctx, tx).page(versionId, pageNo)),

    async recordView(input) {
      const { ctx, document, version, actor } = input;
      const key = `${actor.sessionId ?? actor.membershipId}:${version.id}`;
      const t = services.now().getTime();
      const last = recentViews.get(key);
      if (last !== undefined && t - last < VIEW_DEDUPE_MS) return false;
      recentViews.set(key, t);
      if (recentViews.size > 10_000) {
        for (const [k, at] of recentViews) if (t - at > VIEW_DEDUPE_MS) recentViews.delete(k);
      }
      await db.withTenant(ctx, async (tx) => {
        await services.audit.record(tx, ctx, {
          action: "document.viewed",
          resourceKind: "document",
          resourceId: document.id,
          actorMembershipId: actor.membershipId,
          requestId: actor.requestId,
          sessionId: actor.sessionId,
          ip: actor.ip,
          meta: { versionId: version.id },
        });
        await publish(tx, ctx, "document.viewed", {
          documentId: document.id,
          versionId: version.id,
          membershipId: actor.membershipId,
          sessionId: actor.sessionId ?? null,
        });
      });
      log("data-room.viewed", { workspaceId: ctx.workspaceId, documentId: document.id });
      return true;
    },
  };
}
