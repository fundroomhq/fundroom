import type { AuditRecorder } from "@fundroom/audit";
import type { KeyRing, RawEnv } from "@fundroom/config";
import { adoptDeclaredRegion, type RegionAdoption } from "@fundroom/control-plane";
import type { Database } from "@fundroom/db";
import type { DirectoryPort } from "@fundroom/ports";
import { publishDirectoryCells } from "./directory-jobs.js";

/*
 * The region boot check (E3.11 §8, ADR-0059; owner: agent B). Runs once at server start, after
 * the migrations and before the listener opens:
 *
 *  - DATA_REGION set: placeholder cells (`region = 'default'`, every fresh and every E3.10
 *    install) ADOPT it, with DATA_REGION_LABEL / DATA_REGION_JURISDICTION (audited `cell.update`
 *    on the platform chain; the 0024 cascade gives their workspaces the region) — except the
 *    seeded `default` row of a database whose CELL_ID is another cell and that never held a
 *    workspace (see `adoptDeclaredRegion`). Cells of the region take the configured label and
 *    jurisdiction when they differ (the config is the declaration). Then any cell of
 *    this database still declaring another region is a contradiction between the deployment's
 *    declaration and its data: refused in prod-like environments (APP_ENV prod|staging — the
 *    residency page and the DPA would state a region the rows are not in), a warning elsewhere.
 *  - DATA_REGION unset while a cell declares a region: a warning (the declaration went missing;
 *    residency answers "not declared" until it is restored).
 *
 * Last, with a shared directory, this database's cells are published (agent A's
 * `publishDirectoryCells`, never throws) so the directory carries the adopted region.
 *
 * A region is operator-declared: nothing here can verify where the database physically is.
 */

export interface RegionBootDeps {
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly raw: Pick<
    RawEnv,
    "APP_ENV" | "CELL_ID" | "DATA_REGION" | "DATA_REGION_LABEL" | "DATA_REGION_JURISDICTION"
  >;
  /** With `keyRing`: publish this database's cells to a shared directory after the check. */
  readonly directory?: DirectoryPort | undefined;
  readonly keyRing?: KeyRing | undefined;
  readonly log: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export class RegionBootError extends Error {
  override readonly name = "RegionBootError";
}

function isProdLike(appEnv: string): boolean {
  return appEnv === "prod" || appEnv === "staging";
}

function describe(foreign: RegionAdoption["foreign"]): string {
  return foreign.map((c) => `${c.id} (${c.region})`).join(", ");
}

/** Adopts / verifies the declared region; throws `RegionBootError` when the boot must stop. */
export async function checkDataRegion(deps: RegionBootDeps): Promise<RegionAdoption> {
  const { raw } = deps;
  const region = raw.DATA_REGION;
  let adoption: RegionAdoption;
  try {
    adoption = await adoptDeclaredRegion(
      deps,
      region === undefined
        ? null
        : {
            region,
            regionLabel: raw.DATA_REGION_LABEL ?? "",
            jurisdiction: raw.DATA_REGION_JURISDICTION ?? null,
          },
      { cellId: raw.CELL_ID },
    );
  } catch (error) {
    // The single-region trigger refused the adoption itself: another cell of this database
    // already declares a different region. Report it the same way as a mismatch found after.
    const found = await adoptDeclaredRegion(deps, null);
    const foreign = found.foreign.filter((c) => c.region !== region);
    if (foreign.length === 0) throw error;
    adoption = { adopted: [], refreshed: [], foreign };
  }
  if (adoption.adopted.length > 0 || adoption.refreshed.length > 0) {
    deps.log("residency.region_adopted", {
      region,
      cells: adoption.adopted,
      refreshed: adoption.refreshed,
    });
  }
  if (adoption.foreign.length === 0) {
    await publish(deps);
    return adoption;
  }

  if (region === undefined) {
    deps.log("residency.region_undeclared", {
      level: "warn",
      message: `cells of this database declare a region (${describe(adoption.foreign)}) but DATA_REGION is unset: the residency page says "not declared" until DATA_REGION is set again`,
    });
    await publish(deps);
    return adoption;
  }
  const message = `DATA_REGION=${region}, but cells of this database declare another region: ${describe(adoption.foreign)}. One database = one region, and a declared region never changes: point this deployment at the database of region ${region}, or set DATA_REGION to the region its cells declare.`;
  if (isProdLike(raw.APP_ENV)) throw new RegionBootError(message);
  deps.log("residency.region_mismatch", { level: "warn", message });
  await publish(deps);
  return adoption;
}

async function publish(deps: RegionBootDeps): Promise<void> {
  if (deps.directory === undefined || deps.keyRing === undefined) return;
  await publishDirectoryCells({
    db: deps.db,
    directory: deps.directory,
    keyRing: deps.keyRing,
    log: deps.log,
  });
}
