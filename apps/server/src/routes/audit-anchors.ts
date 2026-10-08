import { listAnchorPage, readAnchorProof } from "@fundroom/audit";
import {
  ApiError,
  audit as a,
  createRoute,
  errorResponses,
  jsonResponse,
  type OpenAPIHono,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import { requireFeature } from "../middleware/entitlements.js";
import type { ApiDeps } from "./deps.js";

/*
 * External audit anchoring routes (E3.13, ADR-0061; authz-matrix.yaml "external anchoring").
 *
 * - Reads run in the caller's tenant transaction: the `tenant_fence` on audit.checkpoint and
 *   audit.anchor keeps another workspace's checkpoints out, and the batch/receipt tables (global,
 *   staff-readable) are only reached through this workspace's own anchor rows.
 * - A proof carries this workspace's canonical checkpoint, its leaf, the sibling hashes of its
 *   inclusion path and the receipts over the batch root — never another workspace's ids.
 * - `configured` lists the driver kinds this install anchors with; `[]` = anchoring is off (the
 *   list still shows checkpoints, none anchored).
 * - Plan entitlements (A-3, ADR-0063, round-3 decision 20): every workspace is anchored and
 *   verified whatever its plan — a run is one Merkle batch over all of them, so leaving one out
 *   saves nothing, and an excuse for missing anchors could not be made tamper-proof. The
 *   `anchoring` feature is the customer-facing proof: the list says `planAllows`, and the proof
 *   download answers 402 `plan_limit` without it (after its permission guard, never an oracle).
 *   After an upgrade the proofs of every past checkpoint are there at once.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 429, 500, 503);
const GATED_ERRORS = errorResponses(400, 401, 402, 403, 404, 429, 500, 503);
const TAGS = ["audit"];

function signedTenant(c: Context<AppEnv>) {
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!tenant || !workspace || !c.get("membership")) throw new ApiError("unauthenticated");
  return { tenant, workspace };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** Keyset cursor `(seq, id)` of the last item served, as opaque base64url. */
function encodeCursor(seq: number, id: string): string {
  return Buffer.from(`${seq}:${id}`, "utf8").toString("base64url");
}

function decodeCursor(cursor: string): { seq: number; id: string } {
  const [seqText = "", id = ""] = Buffer.from(cursor, "base64url").toString("utf8").split(":");
  if (!/^(0|[1-9]\d{0,17})$/u.test(seqText) || !UUID_RE.test(id)) {
    throw new ApiError("validation_failed", "bad cursor");
  }
  return { seq: Number(seqText), id };
}

export function registerAuditAnchorRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (p: string) => requirePermission({ authz: () => deps.authz }, p);

  api.openapi(
    createRoute({
      method: "get",
      path: "/audit/anchors",
      tags: TAGS,
      summary: "The workspace's checkpoints and their external anchors",
      description:
        "Newest first. For each daily checkpoint: whether it is anchored, the anchoring batch and each driver's receipt (kind, locator, time). `configured` lists the anchor drivers this install uses; empty means anchoring is off. `planAllows` says whether the workspace's plan includes downloading anchor proofs (checkpoints are anchored on every plan).",
      security: sessionSecurity,
      "x-requires": "audit.read",
      middleware: [perm("audit.read")] as const,
      request: { query: a.AuditAnchorsQuery },
      responses: {
        200: jsonResponse(a.AuditAnchorPageSchema, "One page of checkpoints"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const s = signedTenant(c);
      const q = c.req.valid("query");
      const before = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
      const rows = await deps.db.withTenant(s.tenant, (tx) =>
        listAnchorPage(
          tx,
          s.workspace.id,
          { before, limit: q.limit + 1 },
          new Date(),
          deps.keyRing,
        ),
      );
      const items = rows.slice(0, q.limit);
      const last = items.at(-1);
      return c.json(
        {
          configured: deps.auditAnchoring.drivers.map((d) => d.kind),
          planAllows: deps.entitlements.of(s.workspace).allowsFeature("anchoring"),
          items: items.map((i) => ({
            checkpointId: i.checkpointId,
            seq: i.seq,
            createdAt: i.createdAt.toISOString(),
            anchored: i.anchored,
            state: i.state,
            batchId: i.batchId,
            receipts: i.receipts.map((r) => ({
              kind: r.kind,
              reference: r.reference,
              anchoredAt: r.anchoredAt.toISOString(),
            })),
          })),
          nextCursor:
            rows.length > q.limit && last ? encodeCursor(last.seq, last.checkpointId) : null,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/audit/anchors/{checkpointId}/proof",
      tags: TAGS,
      summary: "Download a checkpoint's anchor proof",
      description:
        "A self-contained JSON proof — the canonical checkpoint, its Merkle inclusion path to the anchored root and every receipt — that a third party verifies offline with `fundroom audit verify-anchor <proof.json>`. Owner/legal (`audit.export`). 404 when the checkpoint is not this workspace's or is not anchored yet. 402 `plan_limit` (`feature: anchoring`) when the workspace's plan does not include anchor proofs (the checkpoint is anchored and verified all the same).",
      security: sessionSecurity,
      "x-requires": "audit.export",
      middleware: [perm("audit.export"), requireFeature(deps, "anchoring")] as const,
      request: { params: a.AuditAnchorProofParams },
      responses: { 200: jsonResponse(a.AuditAnchorProofSchema, "The proof"), ...GATED_ERRORS },
    }),
    async (c) => {
      const s = signedTenant(c);
      const { checkpointId } = c.req.valid("param");
      const proof = await deps.db.withTenant(s.tenant, (tx) =>
        readAnchorProof(tx, s.workspace.id, checkpointId),
      );
      if (proof === undefined) throw new ApiError("not_found", "no such checkpoint");
      if (proof === null) throw new ApiError("not_found", "this checkpoint is not anchored yet");
      c.header(
        "Content-Disposition",
        `attachment; filename="anchor-proof-${s.workspace.slug}-${proof.checkpoint.seq}.json"`,
      );
      c.header("Cache-Control", "private, no-store");
      return c.json(
        {
          checkpoint: proof.checkpoint,
          leafHash: proof.leafHash,
          leafIndex: proof.leafIndex,
          path: [...proof.path],
          treeSize: proof.treeSize,
          root: proof.root,
          receipts: proof.receipts.map((r) => ({
            kind: r.kind,
            reference: r.reference,
            anchoredAt: r.anchoredAt,
            proof: r.proof,
          })),
        },
        200,
      );
    },
  );
}
