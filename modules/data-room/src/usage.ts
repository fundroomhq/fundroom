import type { ModuleManifest } from "@fundroom/module-kit";
import { storedBytes } from "./repos/usage-repo.js";

/**
 * `ModuleManifest.usage` (E3.10): the bytes the data room stores for the workspace — originals and
 * renditions — as of the call, whatever `day` is being rolled up and whether or not the module is
 * enabled there. Read-only.
 */
export const dataRoomUsage: NonNullable<ModuleManifest["usage"]> = async (tx, { workspaceId }) => ({
  storageBytes: await storedBytes(tx, workspaceId),
});
