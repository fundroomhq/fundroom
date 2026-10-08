/*
 * `@fundroom/embed/artifacts` — the loader's built bytes, as data.
 *
 * `apps/server` imports this to serve `${basePath}/embed/v1/embed.js` and friends (E2.2 spec §4,
 * §5). It exists as a generated TypeScript module rather than files on disk for the same reason
 * `packages/compliance` compiles its Markdown: the distroless image ships `dist/` and nothing
 * else, so "read it from the filesystem" is a Docker-layout assumption waiting to break, and a
 * committed generated file is one a reviewer can diff.
 *
 * Nothing in this module graph touches `window`, `document` or any other browser global — it is
 * imported by a Node server at boot, where that would be a crash, not a bug report.
 */

import type { EmbedArtifact } from "./artifact-types.js";
import { EMBED_ARTIFACTS } from "./generated/artifacts.js";

export type { EmbedArtifact } from "./artifact-types.js";
export { EMBED_ARTIFACTS, EMBED_VERSION } from "./generated/artifacts.js";

/** One artifact by file name, e.g. `embedArtifact("embed.js")`. */
export function embedArtifact(path: string): EmbedArtifact | undefined {
  return EMBED_ARTIFACTS.find((artifact) => artifact.path === path);
}
