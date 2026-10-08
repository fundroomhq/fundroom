/*
 * Bridge protocol v1, parent (host-page) side. The child half is `apps/web/src/embed/bridge.ts`
 * and the two files are one frozen contract (E2.2 spec §3, design/08 §1c and §5):
 *
 *  - every message is `{ v: 1, type, payload }`, both directions;
 *  - neither side ever posts to `"*"`: the child posts to one allowed origin, and this side posts
 *    to the portal origin derived from `baseUrl` and accepts only messages whose `event.origin`
 *    is that origin *and* whose `event.source` is our own frame (two portals on one page share
 *    the window's message events, so the origin alone does not identify the sender);
 *  - an unrecognised `type` is ignored, never thrown. That is the compatibility promise: a loader
 *    pasted into a customer's CMS in 2026 keeps working against a core that learned new message
 *    types in 2027, and `protocol.test.ts` pins it.
 *
 * Payloads are re-validated here rather than trusted. The frame is ours, but "the frame is ours"
 * is an assumption about the browser's origin checks, and the cost of checking a handful of
 * scalars is a few dozen bytes.
 */

/** Child → parent. Mirrors `OutboundMessage` in the web app's bridge, plus the E2.2 additions. */
export type ChildMessage =
  | { v: 1; type: "ready"; payload: { path: string } }
  | { v: 1; type: "resize"; payload: { height: number } }
  | { v: 1; type: "navigate"; payload: { path: string } }
  | { v: 1; type: "auth"; payload: { state: "anonymous" | "authenticated" | "expired" } }
  | { v: 1; type: "open-external"; payload: { url: string } }
  | { v: 1; type: "event"; payload: { name: string; data?: Record<string, unknown> } }
  | { v: 1; type: "scroll-to"; payload: { y: number } };

/**
 * Parent → child. Mirrors `InboundMessage` in the web app's bridge, plus the E2.2 additions.
 *
 * `viewport` is the one message only the parent can produce. The loader sizes the frame to its
 * content, so the frame never scrolls — the host page does — and the child cannot see which part
 * of itself the reader is looking at. Without it a dialog opened by somebody reading at y≈2500 of
 * a 3000px frame renders 2400px above their viewport, greyed out by an `inset-0` overlay, with
 * focus off-screen. `top` is how far the visible region starts below the top of the frame, and
 * `height` is how much of the frame is visible; both in CSS pixels.
 *
 * The child treats it as a **hint** and must work without it: a page framed by a hand-pasted
 * `<iframe>` snippet has no loader and will never receive one, which is a supported way to embed.
 */
export type ParentMessage =
  | { v: 1; type: "theme"; payload: { tokens: Record<string, string> } }
  | { v: 1; type: "navigate"; payload: { path: string } }
  | { v: 1; type: "consent"; payload: { analytics: boolean; gpc?: boolean } }
  | { v: 1; type: "handoff"; payload: { assertion: string } }
  | { v: 1; type: "viewport"; payload: { top: number; height: number } }
  | { v: 1; type: "logout"; payload: Record<string, never> };

export type ChildType = ChildMessage["type"];
export type PayloadOf<T extends ChildType> = Extract<ChildMessage, { type: T }>["payload"];

/** What `onEvent` and the `portal.on(...)` listeners see: the wire message without the version. */
export type SeedHostEvent = {
  [T in ChildType]: { readonly type: T; readonly payload: PayloadOf<T> };
}[ChildType];

const AUTH_STATES = ["anonymous", "authenticated", "expired"] as const;

/**
 * A double-dot segment, in every spelling the URL parser collapses: `.` and `%2e` are the same
 * character to it (case-insensitively), and inside a special-scheme URL a backslash is a path
 * separator like `/`. So `/..\..\admin`, `/.%2e/%2e./admin` and `/../../admin` are one attack.
 */
const TRAVERSAL = /(?:^|[/\\])(?:\.|%2e){2}(?:[/\\?#]|$)/iu;

/**
 * An in-app path. Two rules, each paid for by something that goes wrong without it:
 *
 *  - absolute, and not `//host` — which a browser reads as a protocol-relative URL;
 *  - no `..` segment. The frame's `src` is built by concatenation onto
 *    `${baseUrl}/embed/<slug>`, so `?sh=/../../embed/other-workspace` in a *shared link* walks
 *    back out of this workspace and loads somebody else's embed document inside this widget —
 *    after which the parent posts this workspace's theme, consent and handoff into it. It cannot
 *    leave the portal origin, but it is a remote way to break or repoint any customer's embed.
 *
 * One rule, used by the message parser, by the history sync and by `portal.navigate()`, because a
 * path that is unsafe in the URL bar is unsafe arriving over the bridge too.
 */
export function isPortalPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !TRAVERSAL.test(value)
  );
}

function isFinitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Parses one inbound `MessageEvent.data`. Returns `undefined` for anything that is not a v1
 * message we know — the caller ignores it. Never throws: a host page's other postMessage traffic
 * (tag managers, chat widgets, the host's own framework) lands in the same listener.
 */
export function parseChildMessage(data: unknown): ChildMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const msg = data as Record<string, unknown>;
  if (msg["v"] !== 1 || typeof msg["type"] !== "string") return undefined;
  const payload = msg["payload"];
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;

  switch (msg["type"]) {
    case "ready":
      return isPortalPath(p["path"])
        ? { v: 1, type: "ready", payload: { path: p["path"] } }
        : undefined;
    case "resize":
      return isFinitePositive(p["height"])
        ? { v: 1, type: "resize", payload: { height: p["height"] } }
        : undefined;
    case "navigate":
      return isPortalPath(p["path"])
        ? { v: 1, type: "navigate", payload: { path: p["path"] } }
        : undefined;
    case "auth": {
      const state = p["state"];
      return AUTH_STATES.includes(state as (typeof AUTH_STATES)[number])
        ? { v: 1, type: "auth", payload: { state: state as (typeof AUTH_STATES)[number] } }
        : undefined;
    }
    case "open-external": {
      const url = p["url"];
      // Only http(s). The loader does not navigate on this message (see `loader.ts`), but a host
      // that wires it to `window.open` should never be handed a `javascript:` URL by anything.
      if (typeof url !== "string") return undefined;
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return undefined;
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
      return { v: 1, type: "open-external", payload: { url } };
    }
    case "event": {
      const name = p["name"];
      if (typeof name !== "string" || name.length === 0 || name.length > 64) return undefined;
      const data_ = p["data"];
      // `exactOptionalPropertyTypes`: omit `data` rather than setting it to `undefined`.
      return typeof data_ === "object" && data_ !== null
        ? {
            v: 1,
            type: "event",
            payload: { name, data: { ...(data_ as Record<string, unknown>) } },
          }
        : { v: 1, type: "event", payload: { name } };
    }
    case "scroll-to":
      return isFinitePositive(p["y"])
        ? { v: 1, type: "scroll-to", payload: { y: p["y"] } }
        : undefined;
    default:
      // Unknown type: ignored, never thrown. This is the forward-compatibility promise.
      return undefined;
  }
}
