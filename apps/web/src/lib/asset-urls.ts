/*
 * Where the built SPA finds its own files (E3.9, path-mount mode, ADR-0057).
 *
 * The portal can be served under a public base the build cannot know: `BASE_PATH`, or a
 * per-request prefix a host proxy announces with `X-Forwarded-Prefix` (`acme.com/investors/…`).
 * The server rewrites the root-relative `src`/`href`s in index.html per request, so the entry
 * script always loads from `<public base>/assets/…`. Everything the bundle loads *after* that —
 * lazy route chunks, their `<link rel=modulepreload>`s, CSS `url()`s — must follow the entry
 * rather than a base baked in at build time. Vite's default (`base: "/"`) bakes `"/"+"assets/…"`
 * into the preload helper, which breaks every lazy route under a prefix.
 *
 * `renderBuiltAssetUrl` (vite.config.ts `experimental.renderBuiltUrl`) makes JS- and CSS-hosted
 * URLs relative to the file that references them: the preload helper then resolves each dep
 * with `new URL(dep, import.meta.url)`, and CSS `url()`s are file-relative. So the chunks are
 * byte-identical whatever the base (the immutable `assets/*` cache stays correct) and there is
 * no runtime global to set before the first dynamic import — nothing an inline script, a CSP
 * nonce or a Trusted Types policy would have to allow. index.html (host type `html`) keeps
 * Vite's root-relative form, which is the shape the server's rewrite expects.
 */

/** The slice of Vite's `renderBuiltUrl` context this policy reads. */
export interface BuiltUrlContext {
  readonly hostType: "js" | "css" | "html";
}

export function renderBuiltAssetUrl(
  _filename: string,
  context: BuiltUrlContext,
): { relative: true } | undefined {
  return context.hostType === "html" ? undefined : { relative: true };
}

/*
 * A lazy chunk that fails to load is almost always a stale document: a deploy replaced the
 * content-hashed files the open tab still points at. Reloading once fetches the current
 * index.html and its current chunks. The guard keeps a genuinely missing chunk (an offline
 * visitor, a misconfigured proxy) from reloading forever: a second failure inside the window
 * is left alone, so the error reaches the router's error screen instead.
 */
export const PRELOAD_RELOAD_KEY = "seed-host:preload-reload-at";
export const PRELOAD_RELOAD_WINDOW_MS = 60_000;

interface PreloadRecoveryTarget {
  addEventListener(type: string, listener: (event: Event) => void): void;
  readonly sessionStorage: Pick<Storage, "getItem" | "setItem">;
  readonly location: Pick<Location, "reload">;
}

/** Decides one `vite:preloadError`; returns whether it reloaded (and so swallowed the error). */
export function handlePreloadError(
  event: Event,
  win: Pick<PreloadRecoveryTarget, "sessionStorage" | "location">,
  now: number = Date.now(),
): boolean {
  try {
    const last = Number(win.sessionStorage.getItem(PRELOAD_RELOAD_KEY));
    if (
      Number.isFinite(last) &&
      last > 0 &&
      now - last >= 0 &&
      now - last < PRELOAD_RELOAD_WINDOW_MS
    ) {
      return false;
    }
    win.sessionStorage.setItem(PRELOAD_RELOAD_KEY, String(now));
  } catch {
    // No storage (private mode, blocked site data): no loop guard, so no automatic reload.
    return false;
  }
  event.preventDefault();
  win.location.reload();
  return true;
}

/** Idempotent per window; call once at boot, before the router can import a lazy route. */
export function installPreloadErrorRecovery(win: PreloadRecoveryTarget = window): void {
  const marked = win as PreloadRecoveryTarget & { __fundRoomPreloadRecovery?: true };
  if (marked.__fundRoomPreloadRecovery) return;
  marked.__fundRoomPreloadRecovery = true;
  win.addEventListener("vite:preloadError", (event) => {
    if (!handlePreloadError(event, win)) {
      console.error(
        "a lazy chunk failed to load",
        (event as Event & { payload?: unknown }).payload,
      );
    }
  });
}
