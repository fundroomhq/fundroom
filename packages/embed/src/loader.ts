import { type ConsentInput, foldConsent, readGpc } from "./consent.js";
import { explain, FALLBACK_LABEL, type FallbackReason, renderFallback } from "./fallback.js";
import { type HistoryMode, readPathFromUrl, writePathToUrl } from "./history.js";
import {
  type ChildType,
  isPortalPath,
  type ParentMessage,
  type PayloadOf,
  parseChildMessage,
  type SeedHostEvent,
} from "./protocol.js";

/*
 * `SeedHost.init()` — the host-page half of the embed (E2.2 spec §4, design/08 §1c, §5, §7).
 *
 * It creates one cross-origin iframe on the portal origin and talks to it over the frozen v1
 * bridge. That iframe *is* the security model (ADR-0008): the host page can drive the portal but
 * can never read it, so there is no `mode` option here — an option whose only legal value is the
 * default would be a promise of a second, weaker model we are not making.
 *
 * Everything is per-instance closure state. There is no module-level registry, no shared listener
 * and no singleton, because two portals on one page is a normal thing to want (a summary and a
 * data room in two sections) and shared state is how the second one breaks the first.
 */

/** Spec §4: 5 s. Beyond this we stop waiting and show the link (design/08 §7). */
export const READY_TIMEOUT_MS = 5_000;
/** The skeleton height, which is also the floor. Holding space is what keeps CLS at zero. */
export const DEFAULT_MIN_HEIGHT = 320;
/** design/08 §1c "Accessibility": the frame needs a name, and this is the honest one. */
export const DEFAULT_TITLE = "Investor relations portal";

/**
 * `allow-same-origin` is not a loosening: without it the frame gets an opaque origin and cannot
 * read its own partitioned cookie, so nobody can sign in. `allow-top-navigation` is deliberately
 * absent — a framed portal must never be able to move the host page. `allow-popups` plus
 * `allow-popups-to-escape-sandbox` is the top-level seam (magic links, `/auth/popup`, e-signing):
 * the popup lands on the portal origin unsandboxed, which is where sensitive actions belong.
 */
const SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups " +
  "allow-popups-to-escape-sandbox allow-downloads";

/**
 * `publickey-credentials-get` lets the frame offer passkeys when the host delegates the feature;
 * the top-level popup stays the guaranteed path (spec §5).
 */
const ALLOW = "clipboard-write; fullscreen; publickey-credentials-get";

/**
 * There is deliberately **no `referrerpolicy` attribute**, and adding one would break the origin
 * check. A top-level iframe navigation sends no `Origin` header, so `Referer` is the *only*
 * initiator signal the server gets, and it is what the per-workspace origin check reads
 * (spec §5, design/08 §6 "Embed key reuse on another site"). Suppressing it here would turn every
 * embed into "no evidence of an allowed initiator" — which the server resolves to "allow, but
 * unverified", so the cost is not a broken page, it is a control that silently stops working.
 * The portal's *own* responses still send `Referrer-Policy: no-referrer` outbound; that is a
 * different direction and unaffected.
 */

/** Coalesces a burst of child `resize` messages (a font load, an image, an accordion). */
const RESIZE_DEBOUNCE_MS = 50;

/** `localhost`, `*.localhost`, IPv4 loopback and `[::1]` — the secure-contexts spec's list. */
const LOOPBACK = /^(?:localhost|[^.]+\.localhost|127(?:\.\d{1,3}){3}|\[::1\])$/u;

/**
 * Whether the host page can hold the portal's session at all (design/08 §7 "Mixed content").
 * `https:` always can. Otherwise the browser's own answer is authoritative — a loopback page is a
 * secure context, so a developer running the host page on `http://localhost` gets the real thing
 * rather than a link — and the loopback test is only the fallback for a runtime that does not
 * implement `isSecureContext` (which is also how this is testable under jsdom, where it is
 * `undefined` for every URL).
 */
export function isSecureHost(
  protocol: string,
  hostname: string,
  isSecureContext: unknown,
): boolean {
  if (protocol === "https:") return true;
  if (typeof isSecureContext === "boolean") return isSecureContext;
  return LOOPBACK.test(hostname);
}

export type PortalState = "loading" | "ready" | "fallback" | "destroyed";

export interface InitOptions {
  /** Workspace slug. Public by design — it is already in the URL (spec §2 decision 1). */
  readonly workspace: string;
  /** Where the portal lives, e.g. `https://portal.example` or `https://acme.com/investors`. */
  readonly baseUrl: string;
  /** A CSS selector or the element itself. A selector also survives a host router remount. */
  readonly el: string | HTMLElement;
  readonly path?: string | undefined;
  /** `--sh-*` tokens; overrides the workspace brand. Sent over the bridge, never in the URL. */
  readonly theme?: Readonly<Record<string, string>> | undefined;
  readonly locale?: string | undefined;
  readonly consent?: ConsentInput | undefined;
  /** Default `"query"` → `?sh=/updates`. */
  readonly history?: HistoryMode | undefined;
  readonly minHeight?: number | undefined;
  /** Above this the frame scrolls internally instead of growing. */
  readonly maxHeight?: number | undefined;
  readonly title?: string | undefined;
  /** A signed handoff assertion (spec §6). Posted over the bridge, **never** put in a URL. */
  readonly handoff?: string | undefined;
  readonly onEvent?: ((event: SeedHostEvent) => void) | undefined;
}

export interface Portal {
  readonly state: PortalState;
  /** The path the portal is showing, as far as this side knows. */
  readonly path: string;
  /** The mounted frame, or `undefined` while showing the fallback. */
  readonly iframe: HTMLIFrameElement | undefined;
  on<T extends ChildType>(type: T, handler: (payload: PayloadOf<T>) => void): () => void;
  off<T extends ChildType>(type: T, handler: (payload: PayloadOf<T>) => void): void;
  navigate(path: string): void;
  setTheme(tokens: Readonly<Record<string, string>>): void;
  setConsent(consent: ConsentInput): void;
  logout(): void;
  destroy(): void;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

/**
 * Mounts a portal. Resolves once the frame reports `ready` **or** once we have given up and shown
 * the link — never rejects for a runtime failure, because a host page that `await`s us must not
 * get an unhandled rejection when a CMS turns out to have a strict CSP. It *does* throw
 * synchronously for a programming mistake (no browser, unusable `baseUrl`, missing element),
 * which is a bug in the snippet and should be loud.
 */
export function init(options: InitOptions): Promise<Portal> {
  if (typeof window === "undefined") {
    throw new Error("[FundRoom] init() needs a browser; there is no `window` in this runtime.");
  }
  const win = window;
  const doc = win.document;
  // Captured rather than read through `win` at call time: the `instanceof` below also runs from a
  // MutationObserver callback, which can outlive a torn-down window in a test runner.
  const ElementCtor = win.HTMLElement;

  let base: URL;
  try {
    base = new URL(options.baseUrl);
  } catch {
    throw new Error(`[FundRoom] baseUrl must be an absolute URL, got ${options.baseUrl}`);
  }
  const origin = base.origin;
  const baseHref = trimTrailingSlashes(base.href);
  const slug = encodeURIComponent(options.workspace);
  if (slug.length === 0) throw new Error("[FundRoom] workspace is required.");

  const host = typeof options.el === "string" ? doc.querySelector(options.el) : options.el;
  if (!(host instanceof ElementCtor)) {
    throw new Error(`[FundRoom] el did not resolve to an element: ${String(options.el)}`);
  }

  // Decided once, consulted on every mount: see `mountFrame`.
  const secure = isSecureHost(win.location.protocol, win.location.hostname, win.isSecureContext);

  const mode: HistoryMode = options.history ?? "query";
  const minHeight = options.minHeight ?? DEFAULT_MIN_HEIGHT;
  const maxHeight = options.maxHeight;
  const title = options.title ?? DEFAULT_TITLE;
  const locale = options.locale;
  const handoff = options.handoff;
  // A path in the host URL wins over the snippet's `path`: it is the deep link this visitor
  // followed, and the snippet's value is the default for someone arriving without one.
  const fromUrl = readPathFromUrl(win.location.href, mode);
  let path = fromUrl ?? (isPortalPath(options.path) ? options.path : "/");

  let theme: Record<string, string> | undefined =
    options.theme === undefined ? undefined : { ...options.theme };
  let consent: ConsentInput | undefined = options.consent;

  let state: PortalState = "loading";
  let iframe: HTMLIFrameElement | undefined;
  let fallbackLink: HTMLAnchorElement | undefined;
  /** Set once, the first time we give up. A failed portal stays failed, for that reason. */
  let failedReason: FallbackReason | undefined;
  let readyTimer: number | undefined;
  let resizeTimer: number | undefined;
  let lastHeight = minHeight;
  /** rAF handle for the pending viewport post, and the last values we actually sent. */
  let viewportTick: number | undefined;
  let sentTop = -1;
  let sentHeight = -1;
  /** Messages asked for before the frame was listening. Replayed on `ready`. */
  let queue: ParentMessage[] = [];
  const handlers = new Map<ChildType, Set<(payload: never) => void>>();
  let settle: (() => void) | undefined;

  /** Our own element inside the host's container, so we never touch the host's other children. */
  const root = doc.createElement("div");
  root.setAttribute("data-seed-host-portal", options.workspace);
  root.style.minHeight = `${minHeight}px`;
  host.append(root);

  function standaloneUrl(): string {
    // `/w/<slug>` is the first-party page the fallback link opens: a real top-level context where
    // the session cookie is first-party and nothing about the host page matters (design/08 §1b).
    return `${baseHref}/w/${slug}${path === "/" ? "" : path}`;
  }

  function frameSrc(): string {
    const url = new URL(`${baseHref}/embed/${slug}${path === "/" ? "" : path}`);
    // A hint the app is free to ignore; the frozen protocol has no `locale` message, so this is
    // the only place to say it, and it must not be load-bearing.
    if (locale !== undefined) url.searchParams.set("lang", locale);
    return url.toString();
  }

  /**
   * The part of the frame the reader can actually see, from the frame's own rectangle against the
   * host viewport — an IntersectionObserver would give a ratio, and what the child needs is an
   * offset. Entirely off-screen is reported once as `{ top: 0, height: 0 }`, whichever edge it
   * left by, so the child gets one message and can stop caring.
   */
  function sendViewport(): void {
    if (state !== "ready" || iframe === undefined) return;
    const rect = iframe.getBoundingClientRect();
    const above = Math.max(0, -rect.top);
    const visible = Math.max(0, Math.min(rect.height, win.innerHeight - rect.top) - above);
    const height = Math.round(visible);
    const top = height === 0 ? 0 : Math.round(above);
    // This runs on every scroll frame, so the cheap comparison matters more than it looks:
    // a message per pixel would cost the child a structured clone and a render per frame.
    if (top === sentTop && height === sentHeight) return;
    sentTop = top;
    sentHeight = height;
    post({ v: 1, type: "viewport", payload: { top, height } });
  }

  const hasRaf = typeof win.requestAnimationFrame === "function";

  function scheduleViewport(): void {
    if (viewportTick !== undefined) return;
    const run = (): void => {
      viewportTick = undefined;
      sendViewport();
    };
    viewportTick = hasRaf ? win.requestAnimationFrame(run) : win.setTimeout(run, 16);
  }

  function cancelViewport(): void {
    if (viewportTick === undefined) return;
    if (hasRaf) win.cancelAnimationFrame(viewportTick);
    else win.clearTimeout(viewportTick);
    viewportTick = undefined;
  }

  function clearTimers(): void {
    if (readyTimer !== undefined) win.clearTimeout(readyTimer);
    if (resizeTimer !== undefined) win.clearTimeout(resizeTimer);
    readyTimer = undefined;
    resizeTimer = undefined;
  }

  function settleNow(): void {
    const done = settle;
    settle = undefined;
    if (done !== undefined) done();
  }

  function post(message: ParentMessage): void {
    // Nothing will ever deliver a message queued against a frame we have given up on, and a
    // fallback that quietly accumulates them is a leak. A remount re-sends the state that matters
    // (`sessionMessages`), which is the only part worth keeping.
    if (state === "destroyed" || state === "fallback") return;
    const target = iframe?.contentWindow;
    if (state !== "ready" || target === null || target === undefined) {
      queue.push(message);
      return;
    }
    // One explicit origin. Never `"*"`, in either direction (spec §3).
    target.postMessage(message, origin);
  }

  /** The state the frame needs on every load, including after a remount into a new document. */
  function sessionMessages(): ParentMessage[] {
    const out: ParentMessage[] = [];
    if (handoff !== undefined) out.push({ v: 1, type: "handoff", payload: { assertion: handoff } });
    if (theme !== undefined) out.push({ v: 1, type: "theme", payload: { tokens: theme } });
    if (consent !== undefined) {
      out.push({ v: 1, type: "consent", payload: foldConsent(consent, readGpc(win.navigator)) });
    }
    return out;
  }

  function applyHeight(height: number): void {
    if (iframe === undefined) return;
    // Over `maxHeight` we stop growing and let the frame's own document scroll (design/08 §1c);
    // a portal that grows without limit inside somebody's page is a page nobody can scroll.
    const clamped = Math.min(Math.max(height, minHeight), maxHeight ?? Number.POSITIVE_INFINITY);
    iframe.style.height = `${Math.round(clamped)}px`;
    // The frame just changed size under a stationary reader: the visible region moved without a
    // scroll event to tell us.
    scheduleViewport();
  }

  function scheduleHeight(height: number): void {
    lastHeight = height;
    if (resizeTimer !== undefined) return;
    resizeTimer = win.setTimeout(() => {
      resizeTimer = undefined;
      applyHeight(lastHeight);
    }, RESIZE_DEBOUNCE_MS);
  }

  function syncUrl(kind: "replace" | "push"): void {
    if (mode === "none") return;
    const next = writePathToUrl(win.location.href, mode, path);
    if (next === win.location.href) return;
    // Carry the host router's `history.state` through untouched: replacing it with `null` is
    // exactly how an embed breaks somebody else's back button.
    const h = win.history;
    if (kind === "push") h.pushState(h.state, "", next);
    else h.replaceState(h.state, "", next);
  }

  function scrollHost(y: number): void {
    // An anchor link inside the frame cannot scroll the host page, so it asks us to (design/08 §4).
    const top = root.getBoundingClientRect().top + win.scrollY + y;
    const reduce =
      typeof win.matchMedia === "function" &&
      win.matchMedia("(prefers-reduced-motion: reduce)").matches;
    win.scrollTo({ top, behavior: reduce ? "auto" : "smooth" });
  }

  function emit(event: SeedHostEvent): void {
    for (const handler of handlers.get(event.type) ?? []) {
      (handler as (payload: unknown) => void)(event.payload);
    }
    options.onEvent?.(event);
  }

  function markReady(readyPath: string): void {
    state = "ready";
    if (readyTimer !== undefined) win.clearTimeout(readyTimer);
    readyTimer = undefined;
    path = readyPath;
    syncUrl("replace");
    const pending = [...sessionMessages(), ...queue];
    queue = [];
    for (const message of pending) post(message);
    sendViewport();
    settleNow();
  }

  /**
   * Give up and show the link. The *first* reason sticks and is the only one explained: a page
   * that refused to embed over `http:` must not later be told its CSP is the problem. Calling it
   * again with the reason we already have re-renders the link — which is what a remount needs
   * once the host router has thrown our element away.
   */
  function fail(reason: FallbackReason): void {
    if (state === "destroyed") return;
    const first = failedReason === undefined;
    failedReason = failedReason ?? reason;
    state = "fallback";
    clearTimers();
    iframe?.remove();
    iframe = undefined;
    fallbackLink = renderFallback(root, standaloneUrl(), FALLBACK_LABEL);
    if (first) console.warn(explain(failedReason, origin, READY_TIMEOUT_MS));
    settleNow();
  }

  function mountFrame(): void {
    // Checked here rather than once at startup, because the remount path arrives here too: a host
    // router re-render must not be a way around the refusal. A frame on an insecure page cannot
    // store the `Secure; Partitioned` session cookie no matter who asked for it, so mounting one
    // would replace a clear explanation with a silently broken sign-in.
    if (!secure) {
      fail("insecure-host");
      return;
    }
    clearTimers();
    state = "loading";
    queue = [];
    root.textContent = "";
    root.style.minHeight = `${minHeight}px`;
    fallbackLink = undefined;
    cancelViewport();
    sentTop = -1;
    sentHeight = -1;

    const frame = doc.createElement("iframe");
    frame.setAttribute("src", frameSrc());
    frame.setAttribute("title", title);
    frame.setAttribute("sandbox", SANDBOX);
    frame.setAttribute("allow", ALLOW);
    // `loading="lazy"` only below the fold: on an above-the-fold frame it delays the thing the
    // visitor came for (design/08 §7 "Slow host page").
    if (root.getBoundingClientRect().top > win.innerHeight) {
      frame.setAttribute("loading", "lazy");
    }
    // CSSOM property writes, not a `style` attribute: a host page with a strict `style-src` blocks
    // the attribute form, and an unstyled 0-height iframe looks exactly like a broken embed.
    frame.style.width = "100%";
    frame.style.border = "0";
    frame.style.display = "block";
    frame.style.height = `${minHeight}px`;
    frame.addEventListener("error", () => {
      fail("error");
    });
    root.append(frame);
    iframe = frame;
    readyTimer = win.setTimeout(() => {
      fail("timeout");
    }, READY_TIMEOUT_MS);
  }

  const onMessage = (event: MessageEvent): void => {
    if (event.origin !== origin) return;
    // Two portals on one page see each other's messages, so the origin alone does not identify
    // the sender: the frame does.
    if (iframe === undefined || event.source !== iframe.contentWindow) return;
    const message = parseChildMessage(event.data);
    if (message === undefined) return;
    switch (message.type) {
      case "ready":
        markReady(message.payload.path);
        break;
      case "resize":
        scheduleHeight(message.payload.height);
        break;
      case "navigate":
        // The frame navigated itself: `replaceState`, so a visitor clicking through the portal
        // does not fill the host page's history with entries they have to click back through.
        path = message.payload.path;
        syncUrl("replace");
        break;
      case "scroll-to":
        scrollHost(message.payload.y);
        break;
      default:
        // `auth`, `open-external` and `event` need nothing from us but the notification below.
        // `open-external` deliberately does **not** navigate: a loader that follows a URL posted
        // from a frame is a redirect gadget, and the host decides what its own page does.
        break;
    }
    emit(message);
  };
  win.addEventListener("message", onMessage);

  /**
   * `capture: true` because the scroll may happen on an ancestor element rather than the window —
   * a host that puts the embed inside its own scrolling pane still needs the child told — and
   * scroll events do not bubble to the window from an element. `passive` because we never call
   * `preventDefault` and a non-passive scroll listener blocks the host's scrolling.
   */
  const VIEWPORT_LISTENER = { passive: true, capture: true } as const;
  const onViewportChange = (): void => {
    scheduleViewport();
  };
  win.addEventListener("scroll", onViewportChange, VIEWPORT_LISTENER);
  win.addEventListener("resize", onViewportChange, VIEWPORT_LISTENER);

  const onPopState = (): void => {
    const next = readPathFromUrl(win.location.href, mode);
    if (next === undefined || next === path) return;
    path = next;
    post({ v: 1, type: "navigate", payload: { path: next } });
  };
  if (mode !== "none") win.addEventListener("popstate", onPopState);

  /**
   * A host router that re-renders the section throws our element away (design/08 §7). The check
   * is one `isConnected` read per mutation batch, which is why it can afford to watch the whole
   * document: the container may be replaced, not just emptied, so watching its parent is not
   * enough. Re-resolution needs the selector form of `el` — an element reference to a node the
   * router has discarded cannot be found again, and the docs say so.
   */
  const observer = new win.MutationObserver(() => {
    if (state === "destroyed" || root.isConnected) return;
    const container = typeof options.el === "string" ? doc.querySelector(options.el) : options.el;
    if (!(container instanceof ElementCtor) || !container.isConnected) return;
    container.append(root);
    if (failedReason === undefined) mountFrame();
    // Already given up: re-attach the link we were showing rather than trying the frame again,
    // for the reason we gave up. Retrying would re-run whatever failed and explain it wrongly.
    else fail(failedReason);
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true });

  const portal: Portal = {
    get state() {
      return state;
    },
    get path() {
      return path;
    },
    get iframe() {
      return iframe;
    },
    on(type, handler) {
      let set = handlers.get(type);
      if (set === undefined) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler as (payload: never) => void);
      return () => {
        set.delete(handler as (payload: never) => void);
      };
    },
    off(type, handler) {
      handlers.get(type)?.delete(handler as (payload: never) => void);
    },
    navigate(to) {
      if (state === "destroyed") return;
      if (!isPortalPath(to)) throw new TypeError(`[FundRoom] navigate() needs a path, got ${to}`);
      path = to;
      // Explicit navigation is a place the visitor asked to be, so it gets a history entry.
      syncUrl("push");
      if (fallbackLink !== undefined) fallbackLink.href = standaloneUrl();
      post({ v: 1, type: "navigate", payload: { path: to } });
    },
    setTheme(tokens) {
      theme = { ...tokens };
      post({ v: 1, type: "theme", payload: { tokens: theme } });
    },
    setConsent(next) {
      consent = next;
      // GPC is re-read here, not cached: the fold has to happen at the moment of the decision.
      post({ v: 1, type: "consent", payload: foldConsent(next, readGpc(win.navigator)) });
    },
    logout() {
      post({ v: 1, type: "logout", payload: {} });
    },
    destroy() {
      if (state === "destroyed") return;
      state = "destroyed";
      clearTimers();
      cancelViewport();
      observer.disconnect();
      win.removeEventListener("message", onMessage);
      win.removeEventListener("scroll", onViewportChange, VIEWPORT_LISTENER);
      win.removeEventListener("resize", onViewportChange, VIEWPORT_LISTENER);
      if (mode !== "none") win.removeEventListener("popstate", onPopState);
      handlers.clear();
      queue = [];
      iframe = undefined;
      fallbackLink = undefined;
      root.remove();
      // Resolve rather than leave a caller's `await init(...)` pending forever.
      settleNow();
    },
  };

  return new Promise<Portal>((resolve) => {
    settle = () => {
      resolve(portal);
    };
    mountFrame();
  });
}
