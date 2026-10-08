/*
 * postMessage bridge between the embedded portal (this window) and the host page's loader
 * (design/08 §1c, §5). Both directions carry `{ v: 1, type, payload }`. Inbound messages are
 * accepted only from `allowedOrigins` (the workspace's embed origin allow-list, the same list
 * that becomes `frame-ancestors`); outbound messages are posted to one explicit origin —
 * never `"*"` — chosen as the allowed origin that matches `document.referrer`, else the
 * first allowed origin. With an empty allow-list nothing is posted and nothing is heard.
 */
export type OutboundMessage =
  | { v: 1; type: "ready"; payload: { path: string } }
  | { v: 1; type: "resize"; payload: { height: number } }
  | { v: 1; type: "navigate"; payload: { path: string } }
  | { v: 1; type: "auth"; payload: { state: "anonymous" | "authenticated" | "expired" } }
  | { v: 1; type: "open-external"; payload: { url: string } }
  /**
   * A product event for the host's own analytics (E2.2 §3). **Identifiers and counts only.**
   * A document title or a file name crossing into the host page would put the thing the data
   * room exists to control into someone else's analytics pipeline, so `data` carries ids.
   */
  | { v: 1; type: "event"; payload: { name: string; data: Record<string, unknown> } }
  /**
   * Ask the *host page* to scroll (design/08 §4). A loader-managed frame is as tall as its
   * content and has no scroll of its own, so an in-frame anchor link has nothing to scroll:
   * `y` is the target's offset inside the frame and the host adds the iframe's own position.
   */
  | { v: 1; type: "scroll-to"; payload: { y: number } };

export type InboundMessage =
  | { v: 1; type: "theme"; payload: { tokens: Record<string, string> } }
  | { v: 1; type: "navigate"; payload: { path: string } }
  /** The host page's CMP speaking for the visitor. `granted = analytics && !gpc`; see below. */
  | { v: 1; type: "consent"; payload: { analytics: boolean; gpc?: boolean } }
  /** A host-signed identity assertion (design/08 §3 option B). Never a URL, never stored. */
  | { v: 1; type: "handoff"; payload: { assertion: string } }
  | { v: 1; type: "logout"; payload: Record<string, never> }
  /**
   * Which part of this frame the reader can actually see.
   *
   * `top` is the offset in CSS px of the top of the visible region from the top of the frame
   * (0 until the host page is scrolled past the frame's own top edge); `height` is how much of
   * the frame is on screen. A loader-sized frame is exactly as tall as its content and never
   * scrolls, so nothing inside it can work this out for itself — the scrolling happens in a
   * document we cannot read. Sent once after `ready`, then on host scroll and resize.
   *
   * A **hint, never a requirement**: a page using the raw-iframe snippet has no loader and will
   * never send it, so everything that consumes it has to be correct when it never arrives.
   */
  | { v: 1; type: "viewport"; payload: { top: number; height: number } };

export type InboundType = InboundMessage["type"];
type HandlerFor<T extends InboundType> = (
  payload: Extract<InboundMessage, { type: T }>["payload"],
) => void;

export interface BridgeOptions {
  readonly allowedOrigins: readonly string[];
  readonly targetWindow?: Pick<Window, "postMessage"> | null | undefined;
  readonly self?: Pick<Window, "addEventListener" | "removeEventListener"> | undefined;
  readonly referrer?: string | undefined;
}

export interface Bridge {
  readonly targetOrigin: string | undefined;
  post(message: OutboundMessage): boolean;
  on<T extends InboundType>(type: T, handler: HandlerFor<T>): () => void;
  destroy(): void;
}

function originOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function normalizeOrigins(origins: readonly string[]): string[] {
  const out: string[] = [];
  for (const o of origins) {
    const origin = originOf(o.trim());
    if (origin !== undefined && origin !== "null" && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/** The allowed origin matching the referrer, else the first allowed origin, else none. */
export function selectTargetOrigin(
  allowedOrigins: readonly string[],
  referrer: string | undefined,
): string | undefined {
  const allowed = normalizeOrigins(allowedOrigins);
  const ref = originOf(referrer);
  if (ref !== undefined && allowed.includes(ref)) return ref;
  return allowed[0];
}

/**
 * The compact-JWS grammar, which is all `handoff` may carry.
 *
 * Exactly what the verifier requires (E2.2 §6), so nothing the server would accept can be
 * dropped here — and a `handoff` payload carrying anything else never reaches the network.
 */
const COMPACT_JWS_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
/** `HandoffBody` in `packages/contracts`. Refusing longer here saves a round trip, nothing more. */
const MAX_ASSERTION_LENGTH = 4096;

/**
 * One inbound message, or `undefined`.
 *
 * `undefined` covers both "malformed" and "a type this build has never heard of", and the
 * caller ignores it either way: `@fundroom/embed` versions independently of the core, the
 * snippet lives in a CMS nobody will edit again, and a newer loader posting a message this
 * build predates must be a no-op rather than an exception in a stranger's page (ADR-0040
 * decision 10). `bridge.test.ts` pins that.
 */
export function parseInbound(data: unknown): InboundMessage | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const msg = data as Record<string, unknown>;
  if (msg["v"] !== 1 || typeof msg["type"] !== "string") return undefined;
  const payload = msg["payload"];
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  switch (msg["type"]) {
    case "navigate": {
      const path = p["path"];
      if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
        return undefined;
      }
      return { v: 1, type: "navigate", payload: { path } };
    }
    case "theme": {
      const tokens = p["tokens"];
      if (typeof tokens !== "object" || tokens === null) return undefined;
      const clean: Record<string, string> = {};
      for (const [k, v] of Object.entries(tokens as Record<string, unknown>)) {
        if (typeof v === "string") clean[k] = v;
      }
      return { v: 1, type: "theme", payload: { tokens: clean } };
    }
    case "consent": {
      const analytics = p["analytics"];
      const gpc = p["gpc"];
      if (typeof analytics !== "boolean") return undefined;
      if (gpc !== undefined && typeof gpc !== "boolean") return undefined;
      return {
        v: 1,
        type: "consent",
        payload: { analytics, ...(typeof gpc === "boolean" ? { gpc } : {}) },
      };
    }
    case "handoff": {
      const assertion = p["assertion"];
      if (typeof assertion !== "string") return undefined;
      if (assertion.length > MAX_ASSERTION_LENGTH || !COMPACT_JWS_RE.test(assertion)) {
        return undefined;
      }
      return { v: 1, type: "handoff", payload: { assertion } };
    }
    case "logout":
      return { v: 1, type: "logout", payload: {} };
    case "viewport": {
      const top = p["top"];
      const height = p["height"];
      // `Number.isFinite` rejects NaN and both infinities; negatives are rejected because a
      // region above the frame or of negative height is not a measurement, and a consumer
      // clamping it silently would be guessing at what the host meant.
      if (typeof top !== "number" || !Number.isFinite(top) || top < 0) return undefined;
      if (typeof height !== "number" || !Number.isFinite(height) || height < 0) return undefined;
      return { v: 1, type: "viewport", payload: { top, height } };
    }
    default:
      return undefined;
  }
}

/**
 * `granted` for a host CMP's `consent` message.
 *
 * A host CMP may turn measurement **off** over any signal and may never turn it **on** over a
 * Global Privacy Control signal. `packages/compliance/src/service/consent.ts` returns false
 * when `gpc` is set, independently of anything the browser sends us; this is the client saying
 * the same sentence so the two cannot disagree about what was asked for.
 */
export function consentGranted(payload: { analytics: boolean; gpc?: boolean }): boolean {
  return payload.analytics && payload.gpc !== true;
}

export function createBridge(options: BridgeOptions): Bridge {
  const allowed = normalizeOrigins(options.allowedOrigins);
  const target =
    options.targetWindow === undefined
      ? typeof window !== "undefined" && window.parent !== window
        ? window.parent
        : null
      : options.targetWindow;
  const self = options.self ?? (typeof window !== "undefined" ? window : undefined);
  const referrer =
    options.referrer ?? (typeof document !== "undefined" ? document.referrer : undefined);
  const targetOrigin = selectTargetOrigin(allowed, referrer);
  const handlers = new Map<InboundType, Set<(payload: never) => void>>();

  const listener = (event: MessageEvent) => {
    if (!allowed.includes(event.origin)) return;
    const msg = parseInbound(event.data);
    if (msg === undefined) return;
    for (const h of handlers.get(msg.type) ?? []) (h as (p: unknown) => void)(msg.payload);
  };
  self?.addEventListener("message", listener as EventListener);

  return {
    targetOrigin,
    post(message) {
      if (target === null || target === undefined || targetOrigin === undefined) return false;
      target.postMessage(message, targetOrigin);
      return true;
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
    destroy() {
      handlers.clear();
      self?.removeEventListener("message", listener as EventListener);
    },
  };
}
