import { readFileSync } from "node:fs";

/** Server version from this package's manifest; the same string appears in `/healthz`, the capability doc and the OpenAPI `info.version`. */
function readVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const SERVER_VERSION: string = readVersion();
export const API_VERSION = "v1" as const;
/** Lowest `@fundroom/embed` release this server will negotiate with (design/07 §4.1). */
export const MIN_EMBED_SDK = "0.1.0";
