import type { OutboundHttpPort } from "@fundroom/ports";
import { MAX_INDEX_BYTES, parseReleaseIndex } from "./release-index.js";
import { deriveUpdateStatus, disabledStatus, errorStatus, type UpdateStatus } from "./status.js";

/*
 * The cached checker behind `GET /api/v1/ops/update` and `fundroom doctor`.
 *
 * - **Lazy, no job, no table.** The index is fetched when somebody asks, then cached in-process:
 *   12 hours after a success, 1 hour after a failure (a CDN outage must not become one request
 *   per page view, and must not hide a security release for half a day either).
 * - **Single-flight.** Concurrent callers share one request.
 * - **Nothing identifying leaves the process.** The request is a bare `GET` of the configured URL
 *   with its query string and fragment removed, `credentials: "omit"`, no cookies, no referrer,
 *   and only an `Accept` header — the User-Agent (`FundRoom/<version>`) is the outbound
 *   instance's and is the one fact the CDN learns. No instance id, no host name, no counts.
 * - **Never throws, never auto-updates.** Every failure is an `error` status and a log line.
 * - **`enabled: false` never fetches** and needs no `http` at all, so an opted-out install builds
 *   no outbound agent.
 */

export const SUCCESS_TTL_MS = 12 * 60 * 60 * 1000;
export const FAILURE_TTL_MS = 60 * 60 * 1000;

export type UpdateCheckLog = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

export interface UpdateCheckerOptions {
  readonly enabled: boolean;
  /** The index URL (`UPDATE_CHECK_URL`); its query and fragment are never sent. */
  readonly url: string;
  /** This build's version (`SERVER_VERSION`). */
  readonly currentVersion: string;
  /** Required when `enabled`; the guarded outbound instance (5 s, 256 KiB, no redirects). */
  readonly http?: OutboundHttpPort | undefined;
  readonly clock?: (() => Date) | undefined;
  readonly log?: UpdateCheckLog | undefined;
}

export interface UpdateChecker {
  readonly enabled: boolean;
  readonly currentVersion: string;
  /** The cached status, fetching the index first when the cache is empty or expired. */
  check(): Promise<UpdateStatus>;
}

/** The URL actually requested: no query, no fragment, no userinfo. */
export function requestUrlOf(url: string): string {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  u.username = "";
  u.password = "";
  return u.href;
}

export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const { enabled, currentVersion } = options;
  const clock = options.clock ?? (() => new Date());
  const log = options.log ?? (() => {});
  const http = options.http;
  if (enabled && http === undefined) {
    throw new Error("createUpdateChecker: `http` is required when the update check is enabled");
  }

  let cached: { readonly status: UpdateStatus; readonly until: number } | undefined;
  let inflight: Promise<UpdateStatus> | undefined;

  async function fetchStatus(): Promise<{ status: UpdateStatus; ok: boolean }> {
    const started = clock();
    const fail = (reason: string) => {
      log("update_check.failed", { level: "warn", reason });
      return { status: errorStatus(currentVersion, started), ok: false };
    };
    let body: string;
    try {
      const res = await (http as OutboundHttpPort).fetch(requestUrlOf(options.url), {
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return fail(`index answered HTTP ${res.status}`);
      }
      const declared = Number(res.headers.get("content-length") ?? "0");
      if (declared > MAX_INDEX_BYTES) {
        await res.body?.cancel().catch(() => {});
        return fail(`index larger than ${MAX_INDEX_BYTES} bytes`);
      }
      body = await res.text();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      return fail(
        typeof code === "string" ? code : error instanceof Error ? error.message : "fetch failed",
      );
    }
    const parsed = parseReleaseIndex(body);
    if (!parsed.ok) return fail(parsed.reason);
    const status = deriveUpdateStatus(currentVersion, parsed.index, started);
    log("update_check.checked", {
      level: "debug",
      status: status.status,
      latest: status.latestVersion,
    });
    return { status, ok: true };
  }

  return {
    enabled,
    currentVersion,
    async check() {
      if (!enabled) return disabledStatus(currentVersion, "opted_out");
      if (cached !== undefined && cached.until > clock().getTime()) return cached.status;
      if (inflight !== undefined) return inflight;
      inflight = (async () => {
        try {
          const { status, ok } = await fetchStatus();
          cached = {
            status,
            until: clock().getTime() + (ok ? SUCCESS_TTL_MS : FAILURE_TTL_MS),
          };
          return status;
        } finally {
          inflight = undefined;
        }
      })();
      return inflight;
    },
  };
}
