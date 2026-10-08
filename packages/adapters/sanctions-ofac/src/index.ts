import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type SanctionsAdapterDeps,
  type SanctionsMatch,
  SanctionsProviderError,
  type SanctionsScreeningPort,
} from "@fundroom/ports";
import { nameVariants, variantScore } from "@fundroom/sanctions";
import {
  buildList,
  OFAC_FILES,
  type OfacFile,
  type OfacList,
  OfacListError,
  SOURCE_CONSOLIDATED,
  SOURCE_SDN,
} from "./list.js";

export { parseCsv } from "./csv.js";
export { buildList, OFAC_FILES, type OfacList, versionOf } from "./list.js";

/*
 * `@fundroom/sanctions-ofac` (E3.10, ADR-0058; owner: agent S). Downloads `SDN.CSV` + `ALT.CSV`
 * and the consolidated (non-SDN) `CONS_PRIM.CSV` + `CONS_ALT.CSV` from `deps.baseUrl` (the OFAC
 * Sanctions List Service export directory), caches them under `deps.cacheDir` and matches locally
 * with `@fundroom/sanctions`' matcher. Nothing about the screened company leaves the host, so
 * there is no sub-processor. `listVersion` = `ofac:<sha256-12>:jw4`.
 *
 * The wire (vendors file §3.1, live-probed 2026-09-27): SLS answers 403 without a User-Agent and
 * 302-redirects every export to a pre-signed S3 URL (1 h expiry — never cached). The adapter
 * follows exactly ONE redirect, and only to an https `*.amazonaws.com` host (`redirectAllowed`;
 * tests name their own); a second redirect, another host or plain http fails the download.
 * Each file is capped (`maxFileBytes`) and a body shorter than its Content-Length is refused.
 *
 * Fail closed: any failed, oversized, truncated or unparsable file fails the whole refresh with
 * `SanctionsProviderError` and the previous snapshot stays in force; a snapshot older than
 * `maxAgeMs` (48 h: one missed daily refresh) is not used for screening at all. The four files
 * are fetched one after the other, so a publication landing in between yields an alias pointing
 * at an unknown entry — which `buildList` rejects, and the next refresh gets a consistent set.
 *
 * Cache: `<cacheDir>/ofac/<hash>/` holds one snapshot's files, `<cacheDir>/ofac/current.json`
 * names the snapshot in force with its version and fetch time. Both are written to a temporary
 * name and renamed into place, so a crash leaves the previous snapshot readable. A cache whose
 * files no longer hash to its version is ignored (and replaced by a download). A process that cannot
 * write the cache (read-only volume) keeps working from memory.
 */

export interface OfacScreeningOptions {
  /** May the one redirect go here? Default: https and a `*.amazonaws.com` host. */
  readonly redirectAllowed?: ((target: URL) => boolean) | undefined;
  /** Per-file cap. Default 64 MiB (SDN.CSV is ~4 MiB today). */
  readonly maxFileBytes?: number | undefined;
  /** Fewer SDN rows than this is a truncated download. Default 1000. */
  readonly minPrimaryEntries?: number | undefined;
  /** `listVersion()` downloads again when the snapshot is older than this. Default 1 h. */
  readonly refreshAfterMs?: number | undefined;
  /** `screen()` refuses a snapshot older than this (and downloads). Default 48 h. */
  readonly maxAgeMs?: number | undefined;
  /** At most this many matches are returned, best first. Default 25. */
  readonly maxMatches?: number | undefined;
  readonly userAgent?: string | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export const OFAC_USER_AGENT =
  "fundroom-sanctions-screening/1 (+https://github.com/fundroomhq/fundroom)";
export const DEFAULT_OFAC_MAX_FILE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MIN_PRIMARY_ENTRIES = 1000;
const DEFAULT_REFRESH_AFTER_MS = 3600_000;
const DEFAULT_MAX_AGE_MS = 48 * 3600_000;
const DEFAULT_MAX_MATCHES = 25;

/** The documented redirect target: a pre-signed S3 URL over https. */
export function defaultOfacRedirectAllowed(target: URL): boolean {
  return (
    target.protocol === "https:" &&
    target.username === "" &&
    target.password === "" &&
    target.hostname.toLowerCase().endsWith(".amazonaws.com")
  );
}

interface Snapshot {
  readonly list: OfacList;
  readonly fetchedAt: Date;
}

interface CacheManifest {
  readonly version: string;
  readonly dir: string;
  readonly fetchedAt: string;
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function fail(message: string, cause?: unknown): SanctionsProviderError {
  return new SanctionsProviderError(message, cause === undefined ? undefined : { cause });
}

export function createOfacScreening(
  deps: SanctionsAdapterDeps,
  options: OfacScreeningOptions = {},
): SanctionsScreeningPort {
  const redirectAllowed = options.redirectAllowed ?? defaultOfacRedirectAllowed;
  const maxBytes = options.maxFileBytes ?? DEFAULT_OFAC_MAX_FILE_BYTES;
  const minPrimaryEntries = options.minPrimaryEntries ?? DEFAULT_MIN_PRIMARY_ENTRIES;
  const refreshAfterMs = options.refreshAfterMs ?? DEFAULT_REFRESH_AFTER_MS;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const userAgent = options.userAgent ?? OFAC_USER_AGENT;
  const log = options.log ?? (() => {});
  const base = new URL(deps.baseUrl.endsWith("/") ? deps.baseUrl : `${deps.baseUrl}/`);
  const cacheRoot = join(deps.cacheDir, "ofac");

  let snapshot: Snapshot | undefined;
  let diskChecked = false;
  let inFlight: Promise<Snapshot> | undefined;

  const ageOf = (s: Snapshot) => deps.now().getTime() - s.fetchedAt.getTime();

  async function readBody(file: OfacFile, response: Response): Promise<Uint8Array> {
    const declared = response.headers.get("content-length");
    if (declared !== null && Number(declared) > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw fail(`${file}: ${declared} bytes is over the ${maxBytes} byte cap`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (response.body !== null) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw fail(`${file}: over the ${maxBytes} byte cap`);
        }
        chunks.push(value);
      }
    }
    if (declared !== null && Number(declared) !== total) {
      throw fail(`${file}: got ${total} of ${declared} bytes (truncated)`);
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }

  async function download(file: OfacFile, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const init = (): RequestInit => ({
      method: "GET",
      headers: { "user-agent": userAgent, accept: "text/csv, text/plain, */*" },
      redirect: "manual",
      ...(signal === undefined ? {} : { signal }),
    });
    const first = new URL(file, base);
    let response = await deps.fetch(first, init());
    if (isRedirect(response.status)) {
      await response.body?.cancel().catch(() => {});
      const location = response.headers.get("location");
      let target: URL;
      try {
        if (location === null) throw new Error("no Location");
        target = new URL(location, first);
      } catch (cause) {
        throw fail(`${file}: redirect without a usable Location`, cause);
      }
      if (!redirectAllowed(target)) {
        throw fail(`${file}: redirect to ${target.protocol}//${target.hostname} is not allowed`);
      }
      // The pre-signed URL carries its own credentials in the query; nothing else is sent.
      response = await deps.fetch(target, init());
      if (isRedirect(response.status)) {
        await response.body?.cancel().catch(() => {});
        throw fail(`${file}: more than one redirect`);
      }
    }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw fail(`${file}: HTTP ${response.status}`);
    }
    return readBody(file, response);
  }

  async function writeCache(
    list: OfacList,
    files: Record<OfacFile, Uint8Array>,
    fetchedAt: Date,
  ): Promise<void> {
    const dir = list.version.split(":")[1] as string;
    const tmpSuffix = `.tmp-${randomBytes(6).toString("hex")}`;
    await mkdir(cacheRoot, { recursive: true });
    const finalDir = join(cacheRoot, dir);
    const stagingDir = `${finalDir}${tmpSuffix}`;
    await mkdir(stagingDir, { recursive: true });
    for (const name of OFAC_FILES) {
      await writeFile(join(stagingDir, name), files[name]);
    }
    await rm(finalDir, { recursive: true, force: true });
    await rename(stagingDir, finalDir);
    const manifest: CacheManifest = {
      version: list.version,
      dir,
      fetchedAt: fetchedAt.toISOString(),
    };
    const manifestPath = join(cacheRoot, "current.json");
    await writeFile(`${manifestPath}${tmpSuffix}`, JSON.stringify(manifest));
    await rename(`${manifestPath}${tmpSuffix}`, manifestPath);
    // Older snapshots (and staging leftovers of a crashed write) go.
    for (const entry of await readdir(cacheRoot)) {
      if (entry !== dir && entry !== "current.json") {
        await rm(join(cacheRoot, entry), { recursive: true, force: true });
      }
    }
  }

  async function readCache(): Promise<Snapshot | undefined> {
    try {
      const manifest = JSON.parse(
        await readFile(join(cacheRoot, "current.json"), "utf8"),
      ) as CacheManifest;
      if (!/^[0-9a-f]{12}$/u.test(manifest.dir)) return undefined;
      const files = {} as Record<OfacFile, Uint8Array>;
      for (const name of OFAC_FILES) {
        files[name] = new Uint8Array(await readFile(join(cacheRoot, manifest.dir, name)));
      }
      // The version is the hash of the files: a changed or damaged file fails here.
      const list = buildList(files, { minPrimaryEntries });
      if (list.version !== manifest.version) {
        log("sanctions.ofac_cache_corrupt", { level: "warn" });
        return undefined;
      }
      const fetchedAt = new Date(manifest.fetchedAt);
      if (Number.isNaN(fetchedAt.getTime())) return undefined;
      return { list, fetchedAt };
    } catch {
      // Missing, unreadable or unparsable: no cache.
      return undefined;
    }
  }

  async function refresh(signal: AbortSignal | undefined): Promise<Snapshot> {
    const files = {} as Record<OfacFile, Uint8Array>;
    for (const name of OFAC_FILES) {
      try {
        files[name] = await download(name, signal);
      } catch (error) {
        if (error instanceof SanctionsProviderError) throw error;
        throw fail(`${name}: download failed`, error);
      }
    }
    let list: OfacList;
    try {
      list = buildList(files, { minPrimaryEntries });
    } catch (error) {
      if (error instanceof OfacListError) throw fail(error.message, error);
      throw error;
    }
    const fetchedAt = deps.now();
    try {
      await writeCache(list, files, fetchedAt);
    } catch (error) {
      log("sanctions.ofac_cache_write_failed", {
        level: "warn",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (snapshot?.list.version !== list.version) {
      log("sanctions.ofac_list_loaded", { version: list.version, entries: list.entries.length });
    }
    snapshot = { list, fetchedAt };
    return snapshot;
  }

  /** One download at a time per process; concurrent callers share it. */
  function refreshOnce(signal: AbortSignal | undefined): Promise<Snapshot> {
    if (inFlight === undefined) {
      inFlight = refresh(signal).finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  }

  /** A snapshot no older than `maxAge`: memory, then the disk cache, then a download. */
  async function current(maxAge: number, signal: AbortSignal | undefined): Promise<Snapshot> {
    if (snapshot !== undefined && ageOf(snapshot) <= maxAge) return snapshot;
    if (!diskChecked) {
      diskChecked = true;
      const cached = await readCache();
      if (
        cached !== undefined &&
        (snapshot === undefined || cached.fetchedAt > snapshot.fetchedAt)
      ) {
        snapshot = cached;
        if (ageOf(cached) <= maxAge) return cached;
      }
    }
    return refreshOnce(signal);
  }

  return {
    driver: "ofac",
    meta: { subProcessor: null, lists: [SOURCE_SDN, SOURCE_CONSOLIDATED] },

    async screen(subject, opts) {
      const { list } = await current(maxAgeMs, opts.signal);
      // The subject as written, and by appearance when it mixes scripts (jw4).
      const variants = nameVariants(subject.name);
      const matches: SanctionsMatch[] = [];
      if (variants.some((v) => v.length > 0)) {
        for (const entry of list.entries) {
          let best = 0;
          let bestName = entry.primaryName;
          for (const n of entry.names) {
            const s = variantScore(variants, n.tokens);
            if (s > best) {
              best = s;
              bestName = n.name;
            }
          }
          if (best >= opts.threshold) {
            matches.push({
              listEntryId: entry.id,
              name:
                bestName === entry.primaryName
                  ? bestName
                  : `${entry.primaryName} (a.k.a. ${bestName})`,
              score: Math.round(best * 1000) / 1000,
              programs: entry.programs,
              source: entry.source,
            });
          }
        }
      }
      matches.sort((a, b) => b.score - a.score || a.listEntryId.localeCompare(b.listEntryId));
      return {
        outcome: matches.length > 0 ? "potential_match" : "clear",
        listVersion: list.version,
        matches: matches.slice(0, maxMatches),
      };
    },

    async listVersion(opts) {
      return (await current(refreshAfterMs, opts?.signal)).list.version;
    },
  };
}
