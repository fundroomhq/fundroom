import {
  ApiError,
  createRoute,
  errorResponses,
  jsonResponse,
  type OpenAPIHono,
  residency as r,
  sessionSecurity,
} from "@fundroom/contracts";
import { MOVE_STATES, type MoveState } from "@fundroom/ports";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import { deploymentResidency, workspaceScopeOf, workspaceVendorsOf } from "../residency/kernel.js";
import type { ApiDeps } from "./deps.js";

/*
 * Data residency (E3.11, ADR-0059; owner: agent D): `GET /api/v1/residency`, the tenant's
 * read-only residency facts (kernel manifest `residency`, `compliance.read`).
 *
 * Every location is OPERATOR-DECLARED (`declared: "operator"`): the region comes from
 * `DATA_REGION*`, backups from `BACKUP_LOCATION`, third parties from the configured adapters'
 * own metadata. Nothing secret leaves here: no endpoint URL, no bucket name, no credential, no
 * self-hosted vendor address — a vendor's name and a region only.
 *
 * Cost: the deployment half is pure (config computed once at boot); the workspace half is three
 * short reads of this workspace's own vendor connections (run one after another, never holding
 * more than one pool connection), plus — only in shared directory mode — one directory lookup.
 */

type Api = OpenAPIHono<AppEnv>;

const TAGS = ["residency"];
const ERRORS = errorResponses(401, 403, 404, 429, 500, 503);

/** Moves the tenant may still see in flight; `switched` is done from the tenant's point of view. */
const LIVE_MOVE_STATES: readonly MoveState[] = MOVE_STATES.filter(
  (s) => s !== "switched" && s !== "retired" && s !== "failed" && s !== "cancelled",
);

export function registerResidencyRoutes(api: Api, deps: ApiDeps): void {
  const perm = (permission: string) => requirePermission({ authz: () => deps.authz }, permission);

  /**
   * A move of this workspace between cells, from the directory. `null` in local mode (no moves
   * exist there), when none is in flight, or when the directory cannot answer — the residency
   * page must not break because the shared directory is briefly unreachable.
   */
  async function relocationOf(workspaceId: string) {
    if (deps.directory.mode === "local") return null;
    try {
      const [move] = await deps.directory.moves.list({
        workspaceId,
        states: [...LIVE_MOVE_STATES],
        limit: 1,
      });
      if (move === undefined) return null;
      const target = (await deps.directory.listCells()).find((c) => c.id === move.targetCellId);
      return {
        state: move.state,
        targetRegion: target?.region ?? null,
        requestedAt: move.createdAt.toISOString(),
      };
    } catch (error) {
      deps.log("residency.relocation_unavailable", {
        level: "warn",
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  api.openapi(
    createRoute({
      method: "get",
      path: "/residency",
      tags: TAGS,
      summary: "Where this workspace's data lives",
      description:
        "The region the operator declares for this workspace's cell, where each component (database, object storage, backups, email, …) is, the sub-processors with their locations and out-of-region flags, and any move between cells in progress. Every location is operator-declared: the product cannot verify where a database physically is. `scope: deployment` sub-processors are the operator's configuration; `scope: workspace` ones are vendors this workspace connected itself. `inRegion` / `outsideRegion` compare jurisdictions and are null when either side is unknown or varies.",
      security: sessionSecurity,
      "x-requires": "compliance.read",
      middleware: [perm("compliance.read")] as const,
      responses: { 200: jsonResponse(r.ResidencySchema, "Residency"), ...ERRORS },
    }),
    async (c) => {
      const workspace = c.get("workspace");
      if (workspace === undefined) throw new ApiError("setup_required");
      const tenant = c.get("tenant");
      if (tenant === undefined) throw new ApiError("unauthenticated");

      const deployment = deploymentResidency(deps);
      const region = deployment.region;
      const workspaceScope = workspaceScopeOf(deployment, await workspaceVendorsOf(deps, tenant));

      return c.json(
        {
          region:
            region === null
              ? null
              : { code: region.code, label: region.label, jurisdiction: region.jurisdiction },
          declared: "operator" as const,
          cellId: deps.controlPlane.enabled ? workspace.cellId : null,
          components: deployment.components.map((x) => ({ ...x })),
          subProcessors: [...deployment.subProcessors, ...workspaceScope].map((s) => ({
            ...s,
            certifications: [...s.certifications],
          })),
          relocation: await relocationOf(workspace.id),
        },
        200,
      );
    },
  );
}
