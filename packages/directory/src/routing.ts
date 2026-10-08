import type { DirectoryEntryState, DirectoryPort } from "@fundroom/ports";
import { directoryHostname } from "./hostname.js";
import { isSharedDirectory } from "./shared.js";

/*
 * The directory lookups tenant resolution makes (E3.11 §7), bounded so the directory can never
 * become the thing a stranger's request waits on or an oracle:
 *
 *  - A positive/negative cache (30 s, size-capped, clear-on-full like the custom-domain lookup —
 *    keys are attacker-supplied slugs and hostnames). This process's own directory writes clear
 *    it; another cell's writes are seen within the TTL.
 *  - A single global per-process budget of directory round trips per second, keyed on nothing a
 *    caller supplies. Over budget the answer is "no entry" — the caller's plain 404, never a 429.
 *  - A timeout per lookup and a short "down" window after a failure: a directory outage answers
 *    "no entry" at once (logged once per window), never a 503 and never a hang. Local tenants
 *    never reach this code (only local misses and suspended workspaces do).
 *
 * Nothing that fails is cached: "we did not look" is not an answer.
 */

export interface DirectoryRoute {
  readonly cellId: string;
  readonly state: DirectoryEntryState;
}

export interface DirectoryRouting {
  /** The non-deleted entry holding `slug`, or null (miss, over budget, directory down). */
  slug(slug: string): Promise<DirectoryRoute | null>;
  /** The cell of the entry holding the verified hostname `host` (`Host` header spelling ok). */
  host(host: string): Promise<{ readonly cellId: string } | null>;
  /** The entry `workspaceId` is (or, through a switched move, was) bound to. */
  workspace(workspaceId: string): Promise<DirectoryRoute | null>;
  clear(): void;
  /** Stops listening to the directory's writes. */
  close(): void;
}

export interface DirectoryRoutingOptions {
  readonly directory: DirectoryPort;
  /** Default 30 s (positive and negative). */
  readonly ttlMs?: number | undefined;
  /** Cached keys ceiling. Default 2 000. */
  readonly max?: number | undefined;
  /** Directory round trips per `budgetWindowMs`, per process, for slug/host keys. Default 50. */
  readonly budget?: number | undefined;
  /**
   * A SEPARATE budget for `workspace()` (the relocation check of suspended local workspaces, keys
   * a stranger cannot choose), so random-slug traffic cannot starve it (R2-6). Default 50.
   */
  readonly workspaceBudget?: number | undefined;
  /** Default 1 000 ms. */
  readonly budgetWindowMs?: number | undefined;
  /** Per-lookup bound. Default 1 500 ms. */
  readonly timeoutMs?: number | undefined;
  /** After a failure, answer misses without asking for this long. Default 5 000 ms. */
  readonly downMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export const ROUTING_TTL_MS = 30_000;
export const ROUTING_CACHE_MAX = 2_000;
export const ROUTING_BUDGET = 50;
export const ROUTING_BUDGET_WINDOW_MS = 1_000;

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

class Timeout extends Error {}

export function createDirectoryRouting(options: DirectoryRoutingOptions): DirectoryRouting {
  const { directory } = options;
  const ttlMs = options.ttlMs ?? ROUTING_TTL_MS;
  const max = options.max ?? ROUTING_CACHE_MAX;
  const budget = options.budget ?? ROUTING_BUDGET;
  const windowMs = options.budgetWindowMs ?? ROUTING_BUDGET_WINDOW_MS;
  const timeoutMs = options.timeoutMs ?? 1_500;
  const downMs = options.downMs ?? 5_000;
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const cache = new Map<string, { value: unknown; until: number }>();
  const budgets = {
    keys: { limit: budget, slot: -1, used: 0 },
    workspace: { limit: options.workspaceBudget ?? ROUTING_BUDGET, slot: -1, used: 0 },
  };
  let downUntil = 0;
  // Bumped by every write of this process: a read that started before the write never caches.
  let generation = 0;

  const unsubscribe = isSharedDirectory(directory)
    ? directory.onWrite(() => {
        generation += 1;
        cache.clear();
      })
    : () => {};

  function allowed(kind: keyof typeof budgets, t: number): boolean {
    const b = budgets[kind];
    const s = Math.floor(t / windowMs);
    if (s !== b.slot) {
      b.slot = s;
      b.used = 0;
    }
    b.used += 1;
    if (b.used <= b.limit) return true;
    if (b.used === b.limit + 1) {
      log("directory.lookup_budget_exhausted", {
        level: "warn",
        kind,
        budget: b.limit,
        windowMs,
      });
    }
    return false;
  }

  async function bounded<T>(p: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Timeout("directory lookup timed out")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function cached<T>(
    kind: keyof typeof budgets,
    key: string,
    read: () => Promise<T | null>,
  ): Promise<T | null> {
    if (directory.mode !== "shared") return null;
    const t = now();
    const hit = cache.get(key);
    if (hit !== undefined && hit.until > t) return hit.value as T | null;
    if (t < downUntil) return null;
    if (!allowed(kind, t)) return null;
    const gen = generation;
    let value: T | null;
    try {
      value = await bounded(read());
    } catch (error) {
      // Logged once per down window, not once per request.
      if (now() >= downUntil) {
        log("directory.lookup_failed", {
          level: "warn",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      downUntil = now() + downMs;
      return null;
    }
    if (gen === generation) {
      if (cache.size >= max) cache.clear();
      cache.set(key, { value, until: now() + ttlMs });
    }
    return value;
  }

  return {
    slug(slug) {
      const key = slug.trim().toLowerCase();
      if (!SLUG_RE.test(key)) return Promise.resolve(null);
      return cached("keys", `s:${key}`, () => directory.lookupSlug(key));
    },
    host(host) {
      const key = directoryHostname(host);
      if (key === undefined) return Promise.resolve(null);
      return cached("keys", `h:${key}`, () => directory.lookupHost(key));
    },
    workspace(workspaceId) {
      if (!UUID_RE.test(workspaceId)) return Promise.resolve(null);
      return cached("workspace", `w:${workspaceId.toLowerCase()}`, async () => {
        const hit = await directory.lookupWorkspace(workspaceId);
        return hit === null ? null : { cellId: hit.cellId, state: hit.state };
      });
    },
    clear() {
      generation += 1;
      cache.clear();
    },
    close() {
      unsubscribe();
      cache.clear();
    },
  };
}
