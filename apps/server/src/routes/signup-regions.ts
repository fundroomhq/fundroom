import {
  ApiError,
  createRoute,
  errorResponses,
  jsonResponse,
  type OpenAPIHono,
  signup as s,
} from "@fundroom/contracts";
import { listCells } from "@fundroom/control-plane";
import type { DirectoryCell } from "@fundroom/ports";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import type { ApiDeps } from "./deps.js";

/*
 * The signup region picker (E3.11, ADR-0059; owner: agent B): `GET /api/v1/signup/regions`,
 * public, canonical host with no workspace, SIGNUP_MODE=open only (plain 404 otherwise, like the
 * rest of signup).
 *
 * One item per region: this deployment's own region first (`signupUrl: null` — sign up here) when
 * one of this database's cells is active, then every other region with an ACTIVE remote cell that
 * has a public origin (`signupUrl` = that origin's `/signup`), by region code. A remote cell with
 * no origin cannot be reached by a browser and is left out.
 *
 * Public and unauthenticated, so it says nothing beyond what the region picker shows: region
 * code, operator-declared label and jurisdiction, and a signup URL. No cell ids, no counts, no
 * status, no heartbeats. The answer is the same for everybody, so it is computed at most once per
 * `REGIONS_TTL_MS` per process (a directory round trip per anonymous request would let anybody
 * drive load at the shared directory); a directory failure answers this origin's region alone and
 * is cached for a shorter while.
 */

type Api = OpenAPIHono<AppEnv>;

const TAGS = ["signup"];
const ERRORS = errorResponses(404, 429, 500, 503);

/** How long a computed list is reused. */
export const REGIONS_TTL_MS = 60_000;
/** How long a list computed without the directory (it failed) is reused. */
export const REGIONS_DEGRADED_TTL_MS = 10_000;

type SignupRegion = {
  readonly region: string;
  readonly label: string;
  readonly jurisdiction: DirectoryCell["jurisdiction"];
  readonly signupUrl: string | null;
};

function requireSignupOpen(c: Context<AppEnv>, deps: ApiDeps): void {
  const open =
    deps.controlPlane.operators.signupEnabled &&
    c.get("classification")?.host === "canonical" &&
    c.get("workspace") === undefined;
  if (!open) throw new ApiError("not_found", "no such path");
}

/** The picker's items from the directory's cells (pure; exported for tests). */
export function signupRegionsOf(
  cells: readonly DirectoryCell[],
  declared: ApiDeps["residency"]["region"],
): SignupRegion[] {
  const local = cells.filter((c) => c.local && c.status === "active");
  const items: SignupRegion[] = [];
  const seen = new Set<string>();
  const first = local[0];
  if (first !== undefined) {
    // One database = one region (0024), so every local cell names the same one.
    const labelled = local.find((c) => c.regionLabel !== "");
    items.push({
      region: first.region,
      label: labelled?.regionLabel || declared?.label || first.region,
      jurisdiction:
        local.find((c) => c.jurisdiction !== null)?.jurisdiction ?? declared?.jurisdiction ?? null,
      signupUrl: null,
    });
    seen.add(first.region);
  }
  const remote = cells
    .filter((c) => !c.local && c.status === "active" && c.publicOrigin !== "")
    .sort((a, b) => a.region.localeCompare(b.region) || a.id.localeCompare(b.id));
  for (const cell of remote) {
    if (seen.has(cell.region)) continue;
    let url: URL;
    try {
      url = new URL("/signup", cell.publicOrigin);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    seen.add(cell.region);
    items.push({
      region: cell.region,
      label: cell.regionLabel || cell.region,
      jurisdiction: cell.jurisdiction,
      signupUrl: url.href,
    });
  }
  return items;
}

export function registerSignupRegionRoutes(api: Api, deps: ApiDeps): void {
  let cached: { readonly items: SignupRegion[]; readonly until: number } | undefined;
  let inflight: Promise<SignupRegion[]> | undefined;

  async function compute(): Promise<SignupRegion[]> {
    let cells: readonly DirectoryCell[];
    let ttl = REGIONS_TTL_MS;
    try {
      cells = await deps.directory.listCells();
    } catch (error) {
      deps.log("signup.regions_directory_failed", {
        level: "warn",
        error: error instanceof Error ? error.message.slice(0, 300) : String(error),
      });
      // This origin's own cells still sign up here; the other regions come back with the
      // directory.
      const rows = await listCells(deps.db);
      cells = rows.map((r) => ({
        id: r.id,
        region: r.region,
        regionLabel: r.regionLabel,
        jurisdiction: (r.jurisdiction ?? null) as DirectoryCell["jurisdiction"],
        publicOrigin: r.publicOrigin,
        status: r.status,
        exportPublicKey: null,
        heartbeatAt: null,
        local: true,
      }));
      ttl = REGIONS_DEGRADED_TTL_MS;
    }
    const items = signupRegionsOf(cells, deps.residency.region);
    cached = { items, until: Date.now() + ttl };
    return items;
  }

  api.openapi(
    createRoute({
      method: "get",
      path: "/signup/regions",
      tags: TAGS,
      summary: "Where a new workspace's data can live",
      description:
        "The regions this deployment offers at signup (operator-declared). `signupUrl` null = sign up here; else the signup page of the cell serving that region.",
      "x-requires": "public",
      responses: { 200: jsonResponse(s.SignupRegionListSchema, "Regions"), ...ERRORS },
    }),
    async (c) => {
      requireSignupOpen(c, deps);
      let items: SignupRegion[];
      if (cached !== undefined && cached.until > Date.now()) items = cached.items;
      else {
        // One computation at a time: a burst of cold requests shares it.
        inflight ??= compute().finally(() => {
          inflight = undefined;
        });
        items = await inflight;
      }
      return c.json({ items }, 200);
    },
  );
}
