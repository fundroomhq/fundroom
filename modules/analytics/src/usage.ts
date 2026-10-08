import type { ModuleManifest } from "@fundroom/module-kit";
import { documentsViewedOn } from "./repos/usage-repo.js";

/**
 * `ModuleManifest.usage` (E3.10): documents viewed in the workspace on `day` (UTC), whether or not
 * the module is enabled there. A workspace on the `off` analytics level records no events and so
 * reports 0 — the meter never looks past what the workspace chose to record. Read-only.
 */
export const analyticsUsage: NonNullable<ModuleManifest["usage"]> = async (
  tx,
  { workspaceId, day },
) => ({ docsViewed: await documentsViewedOn(tx, workspaceId, day) });
