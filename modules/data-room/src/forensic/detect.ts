import { systemContext } from "@fundroom/db";
import {
  createForensicDetector,
  type DetectResult,
  FORENSIC_DEFAULT_MAX_CANDIDATES,
  FORENSIC_MIN_ALIGNMENT_QUALITY,
  ForensicBusyError,
  type ForensicDetector,
  ForensicTimeoutError,
  forensicSeed,
} from "@fundroom/forensic";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import type { GrayImageData } from "@fundroom/ports";
import { DataRoomError } from "../errors.js";
import { BlobRepo, DocumentRepo, VersionRepo } from "../repos/dataroom-repo.js";
import { ForensicMarkRepo } from "../repos/forensic-repo.js";
import type { ForensicMark } from "../schema/forensic.js";
import type { DeliveryService } from "../service/delivery.js";
import { parseEncryption } from "../service/objects.js";

/*
 * Forensic detection (E3.13, ADR-0061 §1.7): register a leaked page image onto the clean page
 * raster of the version it came from and test it against the mark of every recipient that
 * version was served to. Every read is a short transaction of its own and the image work runs
 * outside all of them; the scoring itself runs on a worker thread (one shared detector per
 * process, bounded queue → 503 `forensic_busy`), never on the event loop. The uploaded image is
 * never stored.
 */

/** A suspect whose aspect ratio differs from the page's by more than this is not that page. */
export const FORENSIC_MAX_ASPECT_DEVIATION = 0.25;
/** A suspect with more pixels than this many times the reference is refused before decoding. */
export const FORENSIC_MAX_PIXEL_FACTOR = 4;

/**
 * One detection in flight (decoding, queued or scoring) per workspace per process (FIX2 D9): a
 * second one for the same workspace is refused with 503 `forensic_busy` at once, so one tenant
 * can never fill the shared worker queue and starve the others.
 */
export class WorkspaceSlots {
  private readonly busy = new Set<string>();
  /** The release function, or `undefined` when the workspace already holds its slot. */
  tryAcquire(workspaceId: string): (() => void) | undefined {
    if (this.busy.has(workspaceId)) return undefined;
    this.busy.add(workspaceId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.busy.delete(workspaceId);
    };
  }
}
const processSlots = new WorkspaceSlots();

let sharedDetector: ForensicDetector | undefined;
/**
 * Swaps the process detector (integration tests force the busy/timeout paths through the real
 * route); returns a function that restores the previous one.
 */
export function replaceProcessDetector(detector: ForensicDetector): () => void {
  const previous = sharedDetector;
  sharedDetector = detector;
  return () => {
    sharedDetector = previous;
  };
}

/** The process's one worker-thread detector (lazy; workers are unref'd when idle). */
export function processDetector(): ForensicDetector {
  sharedDetector ??= createForensicDetector({ concurrency: 1, maxQueue: 4 });
  return sharedDetector;
}

/** Most recipients one detection tests (a bigger audience: 422 `forensic_too_many_candidates`). */
export const FORENSIC_MAX_CANDIDATES = FORENSIC_DEFAULT_MAX_CANDIDATES;
/** A leaked image narrower than this cannot carry a detectable pattern. */
export const FORENSIC_MIN_IMAGE_WIDTH = 200;
/** Marks read per detection at most (testable or not), so a huge audience is refused cheaply. */
const MARK_READ_LIMIT = 20_000;

export { FORENSIC_MIN_ALIGNMENT_QUALITY };

/** A member's address for display: `null` once erased (the pseudonym is not an address). */
export function displayEmail(email: string | null | undefined): string | null {
  if (email == null) return null;
  return email.startsWith("erased+") && email.endsWith("@erased.invalid") ? null : email;
}

export interface DetectionInput {
  readonly workspaceId: string;
  readonly documentId: string;
  readonly versionId?: string | undefined;
  readonly page: number;
  readonly image: { readonly bytes: Uint8Array; readonly contentType: string };
}

export interface DetectionRecipient {
  readonly membershipId: string;
  readonly displayName: string;
  readonly email: string | null;
  readonly z: number;
  readonly verdict: "match" | "inconclusive";
  readonly servedUnderViewAs: boolean;
  readonly viewAsMembershipId: string | null;
  readonly firstServedAt: string;
  readonly lastServedAt: string;
}

export interface DetectionOutcome {
  readonly documentId: string;
  readonly versionId: string;
  readonly page: number;
  readonly alignment: DetectResult["aligned"];
  /** The z thresholds the verdicts used (they grow with the number of candidates). */
  readonly thresholds: { readonly match: number; readonly inconclusive: number };
  /** A strongly negative score: the mark looks inverted or subtracted (collusion/tampering). */
  readonly tamperSuspected: boolean;
  readonly candidatesTested: number;
  readonly keysMissing: number;
  readonly results: readonly DetectionRecipient[];
  readonly noMatchCount: number;
}

export interface DetectionDeps {
  readonly delivery: Pick<DeliveryService, "referencePage">;
  /** The detector; the process's shared worker-thread one by default (a seam for tests). */
  readonly detector?: Pick<ForensicDetector, "detect"> | undefined;
  /** Per-workspace fairness slots; the process's by default (a seam for tests). */
  readonly slots?: WorkspaceSlots | undefined;
}

const iso = (d: Date | string) => (typeof d === "string" ? new Date(d) : d).toISOString();

export async function runDetection(
  services: Pick<ModuleServices, "db" | "renderer" | "forensicKeys">,
  deps: DetectionDeps,
  input: DetectionInput,
): Promise<DetectionOutcome> {
  const sys = systemContext(input.workspaceId);
  const detector = deps.detector ?? processDetector();

  // 1. The document, the version (default: current) and its blob; then its marks.
  const loaded = await services.db.withTenant(sys, async (tx) => {
    const document = await new DocumentRepo(sys, tx).byId(input.documentId);
    if (document === undefined) return undefined;
    const versionId = input.versionId ?? document.currentVersionId;
    if (versionId === null) return undefined;
    const version = await new VersionRepo(sys, tx).byId(versionId);
    if (version === undefined || version.documentId !== document.id) return undefined;
    const blob = await new BlobRepo(sys, tx).byId(version.blobId);
    if (blob === undefined) return undefined;
    const marks = await new ForensicMarkRepo(sys, tx).forVersion(version.id, MARK_READ_LIMIT + 1);
    return { document, version, blob, marks };
  });
  if (loaded === undefined) throw new DataRoomError("not_found", "no such document or version");
  const { version, blob, marks } = loaded;
  if (
    version.renderStatus !== "ready" ||
    version.pageCount === null ||
    input.page > version.pageCount ||
    parseEncryption(blob.encryption) === undefined
  ) {
    throw new DataRoomError("not_found", "no such page");
  }
  if (marks.length === 0) {
    throw new DataRoomError(
      "forensic_no_marks",
      "this version was never served with a forensic mark",
    );
  }

  // 2. Candidates: every mark whose key is still in the ring.
  const candidates: { id: string; seed: Uint8Array }[] = [];
  const byId = new Map<string, ForensicMark>();
  let keysMissing = 0;
  for (const m of marks) {
    const key = services.forensicKeys.get(m.keyId);
    if (key === undefined) {
      keysMissing++;
      continue;
    }
    candidates.push({ id: m.id, seed: forensicSeed(key, new Uint8Array(m.token)) });
    byId.set(m.id, m);
  }
  if (candidates.length > FORENSIC_MAX_CANDIDATES || marks.length > MARK_READ_LIMIT) {
    throw new DataRoomError(
      "forensic_too_many_candidates",
      "this version was served to too many recipients to test at once",
      { max: FORENSIC_MAX_CANDIDATES },
    );
  }
  if (candidates.length === 0) {
    throw new DataRoomError(
      "forensic_no_marks",
      "every mark of this version was issued under a key that has left the key ring",
      { keysMissing },
    );
  }

  const release = (deps.slots ?? processSlots).tryAcquire(input.workspaceId);
  if (release === undefined) {
    throw new DataRoomError(
      "forensic_busy",
      "a detection for this workspace is already running; try again shortly",
      { retryAfterMs: 10_000 },
    );
  }
  let result: DetectResult;
  try {
    result = await registerAndScore();
  } finally {
    release();
  }

  async function registerAndScore(): Promise<DetectResult> {
    // 3. Both images as luma at the reference's width (no transaction held from here on). The
    // reference's own geometry is its limit (FIX2 D11): a tall page (a long receipt scan) must
    // not trip toGray's default height cap.
    const reference = await deps.delivery.referencePage({ ctx: sys, version, blob }, input.page);
    const referenceGray = await services.renderer.toGray(reference.bytes, reference.contentType, {
      maxWidth: reference.width > 0 ? reference.width : undefined,
      maxHeight: reference.height > 0 ? reference.height : undefined,
      maxPixels:
        reference.width > 0 && reference.height > 0
          ? reference.width * reference.height
          : undefined,
    });
    // Geometry is bounded from the image header, before any pixel is decoded (FIX1 D1).
    const refPixels = referenceGray.width * referenceGray.height;
    let suspect: GrayImageData;
    try {
      suspect = await services.renderer.toGray(input.image.bytes, input.image.contentType, {
        maxWidth: referenceGray.width,
        maxHeight: referenceGray.height * FORENSIC_MAX_PIXEL_FACTOR,
        maxPixels: refPixels * FORENSIC_MAX_PIXEL_FACTOR,
      });
    } catch (error) {
      throw new DataRoomError(
        "forensic_image_invalid",
        error instanceof RangeError
          ? "the image is too large for this page"
          : "the image could not be decoded",
        { reason: error instanceof RangeError ? "too_large" : "undecodable" },
      );
    }
    const aspect = suspect.width / Math.max(1, suspect.height);
    const refAspect = referenceGray.width / Math.max(1, referenceGray.height);
    if (Math.abs(aspect / refAspect - 1) > FORENSIC_MAX_ASPECT_DEVIATION) {
      throw new DataRoomError(
        "forensic_image_invalid",
        "the image does not have this page's shape",
        {
          reason: "aspect_ratio",
        },
      );
    }
    if (suspect.width < FORENSIC_MIN_IMAGE_WIDTH) {
      throw new DataRoomError("forensic_image_invalid", "the image is too small to test", {
        reason: "too_small",
        minWidth: FORENSIC_MIN_IMAGE_WIDTH,
      });
    }

    // 4. Register and score (worker thread).
    try {
      return await detector.detect(referenceGray, suspect, candidates, {
        maxCandidates: FORENSIC_MAX_CANDIDATES,
      });
    } catch (error) {
      if (error instanceof ForensicBusyError || (error as Error)?.name === "ForensicBusyError") {
        throw new DataRoomError(
          "forensic_busy",
          "every detection slot is busy; try again shortly",
          {
            retryAfterMs: 10_000,
          },
        );
      }
      // The worker hit its per-job deadline (and was respawned): load, not a fault of the image.
      if (
        error instanceof ForensicTimeoutError ||
        (error as Error)?.name === "ForensicTimeoutError"
      ) {
        throw new DataRoomError("forensic_busy", "the detection took too long; try again shortly", {
          retryAfterMs: 10_000,
          reason: "timeout",
        });
      }
      if (error instanceof RangeError) {
        throw new DataRoomError("forensic_alignment_failed", "the image could not be registered", {
          reason: error.message,
        });
      }
      throw error;
    }
  }
  if (!(result.aligned.quality >= FORENSIC_MIN_ALIGNMENT_QUALITY)) {
    throw new DataRoomError(
      "forensic_alignment_failed",
      "the image could not be registered onto this page",
      { quality: result.aligned.quality },
    );
  }

  // 5. Who the match / inconclusive marks belong to (names read as system; tokens never leave).
  const hits = result.scores.filter((s) => s.verdict !== "no_match" && byId.has(s.id));
  const people = await services.db.withTenant(sys, async (tx) => {
    const repo = new MembershipRepo(sys, tx);
    const out = new Map<string, { displayName: string; email: string | null }>();
    for (const h of hits) {
      const m = byId.get(h.id);
      if (m === undefined || out.has(m.membershipId)) continue;
      const p = await repo.person(m.membershipId);
      out.set(m.membershipId, {
        displayName: p?.displayName || "former member",
        email: displayEmail(p?.email),
      });
    }
    return out;
  });
  const results: DetectionRecipient[] = [];
  for (const h of hits) {
    const m = byId.get(h.id);
    if (m === undefined || h.verdict === "no_match") continue;
    const p = people.get(m.membershipId);
    results.push({
      membershipId: m.membershipId,
      displayName: p?.displayName ?? "former member",
      email: p?.email ?? null,
      z: h.z,
      verdict: h.verdict,
      servedUnderViewAs: m.lastViewAsAt !== null,
      viewAsMembershipId: m.viewAsMembershipId,
      firstServedAt: iso(m.firstServedAt),
      lastServedAt: iso(m.lastServedAt),
    });
  }
  return {
    documentId: loaded.document.id,
    versionId: version.id,
    page: input.page,
    alignment: result.aligned,
    thresholds: { match: result.thresholds.match, inconclusive: result.thresholds.inconclusive },
    tamperSuspected: result.minZ <= -result.thresholds.match,
    candidatesTested: candidates.length,
    keysMissing,
    results,
    noMatchCount: candidates.length - results.length,
  };
}
