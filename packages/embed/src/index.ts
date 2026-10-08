/*
 * `@fundroom/embed` — the browser loader (E2.2 spec §4, design/08 §1c/§5).
 *
 * Two builds come out of this entry point (`scripts/build-artifacts.mjs`): an IIFE that defines
 * `window.SeedHost`, and an ESM module. Nothing here touches a browser global at module scope, so
 * the package is also importable from Node — a server-side renderer that pulls it in must not
 * crash, and `@fundroom/embed/artifacts` (which `apps/server` imports to serve the loader from
 * memory) shares no module with this graph at all.
 */
export type { ConsentInput } from "./consent.js";
export type { FallbackReason } from "./fallback.js";
export type { HistoryMode } from "./history.js";
export {
  DEFAULT_MIN_HEIGHT,
  DEFAULT_TITLE,
  type InitOptions,
  init,
  type Portal,
  type PortalState,
  READY_TIMEOUT_MS,
} from "./loader.js";
export {
  type ChildMessage,
  type ChildType,
  isPortalPath,
  type ParentMessage,
  type PayloadOf,
  type SeedHostEvent,
} from "./protocol.js";

/**
 * The loader's own version, which is also what the capability document's `MIN_EMBED_SDK`
 * (`apps/server/src/version.ts`) is compared against. `artifacts.test.ts` pins it to
 * `package.json` so the two cannot drift.
 */
export const VERSION = "0.1.0";
