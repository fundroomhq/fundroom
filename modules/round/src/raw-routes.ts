import { ApiError, requestIdOf } from "@fundroom/contracts";
import type { ModuleEnv, ModuleRawRouter, ModuleServices } from "@fundroom/module-kit";
import type { Context, MiddlewareHandler } from "hono";
import { refuseDelegateWrite } from "./delegation.js";
import { RoundError } from "./errors.js";
import { EVIDENCE_CONTENT_TYPES, EVIDENCE_MAX_BYTES, roundDisabledFor } from "./model.js";
import { createVerificationService } from "./service/verification.js";

/*
 * `PUT /api/v1/round/verifications/{id}/evidence` — the investor's own upload (§P).
 *
 * A **raw** route, and the reason is one number: the OpenAPI mount carries a 1 MiB JSON body
 * limit, and a scan of somebody's brokerage statement is routinely larger than that. Raw routes
 * sit in front of that limit and behind the same session, CSRF and enablement chain
 * (`apps/server/src/app.ts`) plus `services.guards.requireMember()` (member, MFA level, legal
 * acceptance — what the OpenAPI twin mounts), so nothing about the security posture changes — only the ceiling,
 * which this route applies itself: 10 MiB, or `limits.uploadMaxBytes` when the deployment's is
 * smaller.
 *
 * The same handler backs the OpenAPI operation of the same path, which exists so the route is in
 * the contract and in the authz matrix. In a running server the raw mount is routed first and
 * wins; the OpenAPI registration is the documentation and the fallback.
 */
export const EVIDENCE_PATH = "/verifications/:id/evidence";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Everything this route refuses answers `not_found` when the answer would otherwise say
 * something about a row the caller cannot see: an id in another workspace, a verification that
 * belongs to somebody else, a module switched off by the offering status. Only the caller's own
 * mistakes — the wrong type, a file too large, an infected file — get their own code.
 */
export async function handleEvidenceUpload(
  c: Context<ModuleEnv>,
  services: ModuleServices,
): Promise<Response> {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!session || !workspace) throw new ApiError("unauthenticated");
  // A signed-in user with no membership here is not a member of this portal, and saying
  // "forbidden" would confirm that the workspace exists and holds this verification.
  if (!membership || !tenant || membership.status !== "active") {
    throw new ApiError("not_found", "no such verification");
  }
  // F3: a delegate never writes round data (it holds no verification of its own either).
  refuseDelegateWrite(membership);
  /*
   * The raw mount checks per-workspace enablement but **not** `offeringStatusRules`, which the
   * OpenAPI mount does (`apps/server/src/api.ts`). Without this line the one raw route in the
   * round module would stay reachable in a workspace whose offering status switched the rest of
   * the module off — a compliance gate with a hole in it.
   */
  if (roundDisabledFor(workspace.offeringStatus)) {
    throw new ApiError(
      "module_disabled",
      `round is unavailable while the offering status is ${workspace.offeringStatus}`,
    );
  }

  const id = c.req.param("id") ?? "";
  if (!UUID_RE.test(id)) throw new ApiError("not_found", "no such verification");

  const contentType =
    (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(EVIDENCE_CONTENT_TYPES as readonly string[]).includes(contentType)) {
    throw new ApiError("unsupported_media_type", "upload a PDF, a PNG or a JPEG", {
      accepted: [...EVIDENCE_CONTENT_TYPES],
    });
  }

  const ceiling = Math.min(EVIDENCE_MAX_BYTES, services.limits.uploadMaxBytes);
  // The declared length first, so an over-size upload is refused before its bytes are buffered;
  // the actual length is checked again in the service, because the header is the client's claim.
  const declared = Number(c.req.header("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > ceiling) {
    throw new ApiError("payload_too_large", "this file is too large", { limitBytes: ceiling });
  }

  const bytes = new Uint8Array(await c.req.arrayBuffer());
  const service = createVerificationService(services);
  try {
    const updated = await service.uploadEvidence(
      tenant,
      id,
      membership.id,
      { bytes, contentType },
      {
        membershipId: membership.id,
        requestId: requestIdOf(c),
        sessionId: session.sessionId,
      },
    );
    return c.json(
      {
        id: updated.id,
        status: updated.status,
        hasEvidence: updated.evidenceKey !== null,
        evidenceContentType: updated.evidenceContentType,
        evidenceBytes: updated.evidenceBytes,
        evidenceSha256: updated.evidenceSha256,
        evidenceUploadedAt: updated.evidenceUploadedAt?.toISOString() ?? null,
      },
      200,
    );
  } catch (error) {
    if (error instanceof RoundError) {
      switch (error.code) {
        case "unsupported_media_type":
          throw new ApiError("unsupported_media_type", error.message, error.details);
        case "payload_too_large":
          throw new ApiError("payload_too_large", error.message, error.details);
        case "scan_failed":
          throw new ApiError("validation_failed", error.message, error.details);
        case "conflict":
          throw new ApiError("conflict", error.message, error.details);
        case "validation_failed":
          throw new ApiError("validation_failed", error.message, error.details);
        default:
          throw new ApiError("not_found", error.message, error.details);
      }
    }
    throw error;
  }
}

export function registerRoundRawRoutes(app: ModuleRawRouter, services: ModuleServices): void {
  /*
   * The kernel member chain first (E3.2 SWEEP-2), the one the OpenAPI twin mounts: signed in, a
   * member here (else 404), a session as strong as the role needs (`requireMfaForExternal`, the
   * owner/admin level-2 rule) and the legal-acceptance gate. Resolved per request: the services
   * are not readable at registration time.
   */
  const guard: MiddlewareHandler<ModuleEnv> = (c, next) => services.guards.requireMember()(c, next);
  app.put(EVIDENCE_PATH, guard, (c) => handleEvidenceUpload(c, services));
}
