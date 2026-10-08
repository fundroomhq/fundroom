import {
  ApiError,
  createRoute,
  errorResponses,
  jsonResponse,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import { systemContext } from "@fundroom/db";
import { MembershipRepo } from "@fundroom/identity";
import type {
  ModuleEnv,
  ModuleRawRouter,
  ModuleRouter,
  ModuleServices,
} from "@fundroom/module-kit";
import type { Context, MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as s from "../contracts.js";
import { DataRoomError } from "../errors.js";
import { DocumentRepo, VersionRepo } from "../repos/dataroom-repo.js";
import { ForensicMarkRepo } from "../repos/forensic-repo.js";
import { sharedDelivery } from "../service/delivery.js";
import { displayEmail, runDetection } from "./detect.js";
import { traceCode } from "./marks.js";

/*
 * Forensic watermark routes (E3.13, ADR-0061 §1.7): trace a leaked page image to its recipient,
 * and list who was served a forensically marked version. Staff with `data-room.forensics` only
 * (owner, admin, legal); everybody else gets the kernel guard's 404.
 *
 * Detection is a multipart upload of up to 15 MiB, so it is a **raw** route (in front of the
 * OpenAPI mount's 1 MiB body limit, behind the same session/CSRF/enablement chain plus
 * `requirePermission("data-room.forensics", { fresh: true })`). The OpenAPI operation of the same
 * path runs the same handler; in a running server the raw mount is routed first and wins.
 */
const TAGS = ["data-room"];
const ERRORS = errorResponses(400, 401, 403, 404, 409, 413, 415, 422, 429, 500, 503);
export const FORENSIC_DETECT_PATH = "/documents/:id/forensic/detect";
/** 10 detections per member per hour. */
export const FORENSIC_DETECT_RATE = { max: 10, windowMs: 60 * 60_000 } as const;
/** Multipart framing on top of the image itself. */
const MULTIPART_SLACK_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function rethrow(error: unknown): never {
  if (error instanceof DataRoomError && error.code === "forensic_busy")
    throw new ApiError(error.code, error.message, error.details, {
      headers: { "Retry-After": "10" },
    });
  if (error instanceof DataRoomError) throw new ApiError(error.code, error.message, error.details);
  throw error;
}

const detectBodyLimit = bodyLimit({
  maxSize: s.FORENSIC_DETECT_MAX_BYTES + MULTIPART_SLACK_BYTES,
  onError: () => {
    throw new ApiError("payload_too_large", "the image is too large", {
      limitBytes: s.FORENSIC_DETECT_MAX_BYTES,
    });
  },
});

export async function handleForensicDetect(
  c: Context<ModuleEnv>,
  services: ModuleServices,
): Promise<Response> {
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  // Unreachable behind the guard; kept so the handler never runs on a half-resolved request.
  if (!membership || !tenant || !workspace) throw new ApiError("unauthenticated");
  const id = c.req.param("id") ?? "";
  if (!UUID_RE.test(id)) throw new ApiError("not_found", "no such document");

  // Per USER across every workspace they staff (E3.13 FIX1 D8). Checked before any work; the hit
  // is recorded once the attempt is over — every attempt counts, the failed ones too, EXCEPT a
  // 503 `forensic_busy` (queue full, workspace slot taken, worker deadline): load shedding must
  // not spend the caller's allowance (FIX3 RR2-1). Concurrent attempts can overshoot by at most
  // one per workspace the user staffs (the per-workspace slot serialises the rest).
  const rateKey = `data-room.forensic_detect:user:${membership.userId}`;
  const limit = await services.rateLimiter.peek(rateKey, FORENSIC_DETECT_RATE);
  if (!limit.allowed) {
    throw new ApiError(
      "forensic_rate_limited",
      "too many forensic detections; try again later",
      { retryAfterMs: limit.retryAfterMs },
      { headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) } },
    );
  }
  let shed = false;
  try {
    return await detectAttempt(c, services, { membership, tenant, workspace, id });
  } catch (error) {
    shed = error instanceof ApiError && error.code === "forensic_busy";
    throw error;
  } finally {
    if (!shed) await services.rateLimiter.hit(rateKey, FORENSIC_DETECT_RATE);
  }
}

async function detectAttempt(
  c: Context<ModuleEnv>,
  services: ModuleServices,
  who: {
    membership: NonNullable<ModuleEnv["Variables"]["membership"]>;
    tenant: NonNullable<ModuleEnv["Variables"]["tenant"]>;
    workspace: NonNullable<ModuleEnv["Variables"]["workspace"]>;
    id: string;
  },
): Promise<Response> {
  const { membership, tenant, workspace, id } = who;

  const contentType = (c.req.header("content-type") ?? "").toLowerCase();
  if (!contentType.startsWith("multipart/form-data")) {
    throw new ApiError("unsupported_media_type", "send multipart/form-data", {
      accepted: ["multipart/form-data"],
    });
  }
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > s.FORENSIC_DETECT_MAX_BYTES + MULTIPART_SLACK_BYTES) {
    throw new ApiError("payload_too_large", "the image is too large", {
      limitBytes: s.FORENSIC_DETECT_MAX_BYTES,
    });
  }
  let form: Record<string, unknown>;
  try {
    form = (await c.req.parseBody()) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("validation_failed", "the multipart body could not be read");
  }
  const fields = s.ForensicDetectBody.omit({ image: true }).safeParse({
    page: form["page"],
    versionId: typeof form["versionId"] === "string" ? form["versionId"] : undefined,
  });
  if (!fields.success) {
    throw new ApiError("validation_failed", "page (and versionId) are invalid", {
      issues: fields.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  const image = form["image"];
  if (!(image instanceof File)) {
    throw new ApiError("validation_failed", "attach the page image as `image`");
  }
  const imageType = image.type.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(s.FORENSIC_DETECT_CONTENT_TYPES as readonly string[]).includes(imageType)) {
    throw new ApiError("unsupported_media_type", "upload a PNG, a JPEG or a WebP image", {
      accepted: [...s.FORENSIC_DETECT_CONTENT_TYPES],
    });
  }
  if (image.size > s.FORENSIC_DETECT_MAX_BYTES || image.size === 0) {
    throw new ApiError("forensic_image_invalid", "the image is empty or too large", {
      reason: image.size === 0 ? "empty" : "too_large",
      limitBytes: s.FORENSIC_DETECT_MAX_BYTES,
    });
  }
  const bytes = new Uint8Array(await image.arrayBuffer());

  let outcome: Awaited<ReturnType<typeof runDetection>>;
  try {
    outcome = await runDetection(
      services,
      { delivery: sharedDelivery(services) },
      {
        workspaceId: workspace.id,
        documentId: id,
        versionId: fields.data.versionId,
        page: fields.data.page,
        image: { bytes, contentType: imageType },
      },
    );
  } catch (error) {
    rethrow(error);
  }
  await services.db.withTenant(tenant, (tx) =>
    services.audit.record(tx, tenant, {
      action: "data_room.forensic_detection",
      resourceKind: "document",
      resourceId: outcome.documentId,
      actorMembershipId: membership.id,
      requestId: requestIdOf(c),
      sessionId: c.get("session")?.sessionId,
      ip: services.clientIp(c),
      meta: {
        versionId: outcome.versionId,
        page: outcome.page,
        candidatesTested: outcome.candidatesTested,
        matches: outcome.results.filter((r) => r.verdict === "match").map((r) => r.membershipId),
        inconclusive: outcome.results.filter((r) => r.verdict === "inconclusive").length,
      },
    }),
  );
  return c.json(outcome, 200, { "Cache-Control": "private, no-store" });
}

/** The raw mount of `POST /documents/{id}/forensic/detect` (see the header comment). */
export function registerForensicRawRoutes(app: ModuleRawRouter, services: ModuleServices): void {
  const guard: MiddlewareHandler<ModuleEnv> = (c, next) =>
    services.guards.requirePermission("data-room.forensics", { fresh: true })(c, next);
  app.post(FORENSIC_DETECT_PATH, guard, detectBodyLimit, (c) => handleForensicDetect(c, services));
}

function cursorOf(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}
function parseCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  const id = Buffer.from(cursor, "base64url").toString("utf8");
  if (!UUID_RE.test(id)) throw new ApiError("validation_failed", "invalid cursor");
  return id;
}

export function registerForensicRoutes(api: ModuleRouter, services: ModuleServices): void {
  const perm = (p: string, fresh = false) => services.guards.requirePermission(p, { fresh });

  api.openapi(
    createRoute({
      method: "post",
      path: "/documents/{id}/forensic/detect",
      tags: TAGS,
      summary: "Trace a leaked page image to its recipient",
      description:
        "Tests a page image (photo, screenshot, re-encode) against the invisible forensic mark of every recipient who was served this document version, and returns the recipients whose mark it carries (`match`) or may carry (`inconclusive`) against the returned `thresholds`, which grow with the number of recipients tested; the rest are only counted (not detected ≠ ruled out). `tamperSuspected` flags an inverted/subtracted mark. Staff with `data-room.forensics` on a fresh session; 10 per user per hour across workspaces (429 `forensic_rate_limited`); 503 `forensic_busy` when every detection slot of the server is taken. The image must have the page's shape (aspect within 25 %, at most 4× its pixels). 404 for an unknown document, version or page; 409 `forensic_no_marks` when the version was never served with a mark; 422 `forensic_image_invalid` / `forensic_alignment_failed` / `forensic_too_many_candidates` (over 2,000 recipients). The image is never stored; the detection is audited (`data_room.forensic_detection`).",
      security: sessionSecurity,
      "x-requires": "data-room.forensics+fresh",
      middleware: [perm("data-room.forensics", true), detectBodyLimit] as const,
      request: {
        params: s.IdParams,
        body: {
          required: true,
          content: { "multipart/form-data": { schema: s.ForensicDetectBody } },
        },
      },
      responses: {
        200: jsonResponse(s.ForensicDetectionResultSchema, "Detection result"),
        ...ERRORS,
      },
    }),
    (c) => handleForensicDetect(c as unknown as Context<ModuleEnv>, services) as never,
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/documents/{id}/forensic/recipients",
      tags: TAGS,
      summary: "Who was served a forensically marked version",
      description:
        "Every recipient with a forensic mark on this document (or one version of it): first and last served (the latter moves at most hourly). Kept after a member's erasure (the name then shows the pseudonym, the email `null`). Staff with `data-room.forensics`. Keyset-paged by `cursor`.",
      security: sessionSecurity,
      "x-requires": "data-room.forensics",
      middleware: [perm("data-room.forensics")] as const,
      request: { params: s.IdParams, query: s.ForensicRecipientsQuery },
      responses: {
        200: jsonResponse(s.ForensicRecipientPageSchema, "Recipients"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const workspace = c.get("workspace");
      if (!workspace) throw new ApiError("unauthenticated");
      const { id } = c.req.valid("param");
      const q = c.req.valid("query");
      const after = parseCursor(q.cursor);
      const sys = systemContext(workspace.id);
      const page = await services.db.withTenant(sys, async (tx) => {
        const document = await new DocumentRepo(sys, tx).byId(id);
        if (document === undefined) return undefined;
        if (q.versionId !== undefined) {
          const v = await new VersionRepo(sys, tx).byId(q.versionId);
          if (v === undefined || v.documentId !== document.id) return undefined;
        }
        const rows = await new ForensicMarkRepo(sys, tx).recipients({
          documentId: document.id,
          versionId: q.versionId,
          after,
          limit: q.limit + 1,
        });
        const people = new MembershipRepo(sys, tx);
        const names = new Map<string, { displayName: string; email: string | null }>();
        const items = [];
        for (const r of rows.slice(0, q.limit)) {
          let p = names.get(r.mark.membershipId);
          if (p === undefined) {
            const person = await people.person(r.mark.membershipId);
            p = {
              displayName: person?.displayName || "former member",
              email: displayEmail(person?.email),
            };
            names.set(r.mark.membershipId, p);
          }
          items.push({
            membershipId: r.mark.membershipId,
            displayName: p.displayName,
            email: p.email,
            versionId: r.mark.versionId,
            versionNo: r.versionNo,
            servedUnderViewAs: r.mark.lastViewAsAt !== null,
            viewAsMembershipId: r.mark.viewAsMembershipId,
            trace: traceCode(new Uint8Array(r.mark.token)),
            firstServedAt: new Date(r.mark.firstServedAt).toISOString(),
            lastServedAt: new Date(r.mark.lastServedAt).toISOString(),
          });
        }
        const last = rows.length > q.limit ? rows[q.limit - 1] : undefined;
        return { items, nextCursor: last ? cursorOf(last.mark.id) : null };
      });
      if (page === undefined) throw new ApiError("not_found", "no such document or version");
      return c.json(page, 200);
    },
  );
}
