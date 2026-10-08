import { Alert, AlertDescription, AlertTitle, Button, useTheme } from "@fundroomhq/ui";
import { applyThemeTokens } from "@fundroomhq/ui/theme";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";
import { api, call } from "../lib/api.js";
import { noteHostTokens } from "../lib/brand-theme.js";
import { useWebConfig } from "../lib/config-context.js";
import { meQuery, refreshSession } from "../lib/queries.js";
import { m } from "../paraglide/messages.js";
import { type Bridge, consentGranted, createBridge } from "./bridge.js";
import { type ProbeResult, probeCookies } from "./cookie-probe.js";

/*
 * Everything the `/embed/<slug>` tree needs around the normal screens: the cookie probe,
 * the postMessage bridge, compact density, and the "Open in a new tab" escape hatch
 * (design/08 §1c, §4, §7).
 *
 * Outbound: ready / resize / navigate / auth / open-external / event / scroll-to.
 * Inbound: theme / navigate / consent / handoff / logout.
 *
 * The three inbound additions all do the same thing on failure — nothing visible. A host page
 * asserting an identity we reject, a CMP writing consent for a visitor who is not signed in,
 * a logout on a frame that was never signed in: each is a normal state of the world, not a
 * fault of the embed, and none of them may turn the investor's screen into an error.
 */
const BridgeContext = createContext<Bridge | undefined>(undefined);

export function useBridge(): Bridge | undefined {
  return useContext(BridgeContext);
}

export const EMBED_DENSITY = "0.875";

/**
 * The live bridge, for the two helpers that are called from outside the React tree.
 *
 * `openInNewTab` is reached from `status-screens.tsx` and from screens that hold no bridge
 * reference; a context would mean threading one through every caller for a message that has
 * exactly one sender per document. Set by `EmbedFrame`'s effect and cleared on unmount, so
 * outside the embed tree it is `undefined` and both helpers fall back to the local behaviour.
 */
let activeBridge: Bridge | undefined;

/** The part of the frame the reader can see, as the host last reported it (`viewport`). */
export interface EmbedViewport {
  readonly top: number;
  readonly height: number;
}

/**
 * The last reported region, or `undefined` when the host has never said.
 *
 * Module-level for the same reason as `activeBridge`: there is one frame per document, and the
 * consumers that need this (the dialog offset today; anything that wants to scroll something
 * into *the reader's* view later) are not all inside the React tree. `undefined` is the normal
 * state for a raw-iframe embed, which has no loader to report anything.
 */
let embedViewport: EmbedViewport | undefined;

export function currentEmbedViewport(): EmbedViewport | undefined {
  return embedViewport;
}

/**
 * The custom property `packages/ui`'s `DialogContent` takes its `top` from, defaulting to the
 * `10vmin` it has always used when nobody sets it.
 */
export const DIALOG_TOP_PROPERTY = "--sh-dialog-top";

/**
 * A dialog's offset from the top of the *document* so that it lands near the top of the part
 * the reader can see.
 *
 * The inset is a fraction of the visible height rather than a fixed number so a short region
 * does not get a dialog pushed most of the way down it, and capped so a tall one does not get
 * a dialog halfway down the screen; 8 % of a 600 px region is 48 px, which is close to the
 * `10vmin` a top-level window gets. Both terms are bounded by the region itself, so the result
 * is always inside it — a dialog taller than the visible region is a different problem and the
 * best answer to it is still "start at the top".
 */
const DIALOG_INSET_RATIO = 0.08;
const DIALOG_INSET_MAX = 64;

export function dialogTopFor(region: EmbedViewport): number {
  const inset = Math.min(region.height * DIALOG_INSET_RATIO, DIALOG_INSET_MAX);
  return Math.max(0, Math.round(region.top + inset));
}

/** Records the region and republishes the dialog offset. Safe to call with the same region. */
export function applyEmbedViewport(root: HTMLElement, region: EmbedViewport): void {
  embedViewport = region;
  root.style.setProperty(DIALOG_TOP_PROPERTY, `${dialogTopFor(region)}px`);
}

/**
 * Open a portal URL outside the frame.
 *
 * The loader owns the top-level context, so `open-external` is posted first and the loader
 * opens it (`docs/embed/api.md`): a `window.open` from inside a sandboxed iframe is at the
 * mercy of `allow-popups`, the popup blocker's opinion of a frame it cannot see, and the host
 * page's own overlay. `window.open` stays as the fallback for when nothing is listening — a
 * raw-iframe embed with no loader at all, or the portal opened directly at top level.
 */
export function openInNewTab(canonicalOrigin: string, path: string): void {
  const url = `${canonicalOrigin.replace(/\/$/u, "")}${path}`;
  if (activeBridge?.post({ v: 1, type: "open-external", payload: { url } }) === true) return;
  window.open(url, "_blank", "noopener");
}

/**
 * Post a product event to the host page's analytics (E2.2 §3).
 *
 * Ids and counts only: a document title or a file name crossing the bridge would hand the host
 * page's analytics vendor the content the data room exists to control. Nothing in the portal
 * calls this yet — the events worth exporting arrive with the E2.3 screens — so this is the
 * sender half of a message the loader already documents, not a list that is finished.
 */
export function postEmbedEvent(name: string, data: Record<string, unknown> = {}): boolean {
  return activeBridge?.post({ v: 1, type: "event", payload: { name, data } }) === true;
}

/**
 * Ask the host page to scroll to an offset inside the frame (design/08 §4).
 *
 * A loader-managed frame is exactly as tall as its content, so it has no scrollbar of its own
 * and an in-frame anchor link would move nothing. The host adds the iframe's position to `y`.
 */
export function postScrollTo(y: number): boolean {
  return (
    activeBridge?.post({ v: 1, type: "scroll-to", payload: { y: Math.max(0, Math.round(y)) } }) ===
    true
  );
}

export function EmbedFrame({ children }: { children: ReactNode }) {
  const config = useWebConfig();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { setTheme } = useTheme();
  const [probe, setProbe] = useState<ProbeResult>("ok");

  const bridge = useMemo(
    () => createBridge({ allowedOrigins: config.embedOrigins }),
    [config.embedOrigins],
  );

  useEffect(() => {
    document.documentElement.style.setProperty("--sh-density-base", EMBED_DENSITY);
    setProbe(probeCookies(document));
    return () => {
      document.documentElement.style.removeProperty("--sh-density-base");
    };
  }, []);

  useEffect(() => {
    activeBridge = bridge;
    bridge.post({ v: 1, type: "ready", payload: { path: currentPath(router) } });
    const offNavigate = bridge.on("navigate", ({ path }) => {
      void router.navigate({ to: path });
    });
    /*
     * The host page's CMP is the only consent dialogue the visitor ever saw (plan §11), so the
     * embed renders no banner of its own and writes what the CMP reports. The source is
     * `host_cmp` because that is what is true, and a consent register that recorded a CMP
     * answer as "settings" would be a false statement about where a compliance decision was
     * made — worse than no record at all.
     */
    const offConsent = bridge.on("consent", (payload) => {
      const granted = consentGranted(payload);
      void call(
        api().PUT("/compliance/consent", {
          body: { purpose: "analytics_engagement", granted, source: "host_cmp" },
        }),
      )
        .then(() => {
          void queryClient.invalidateQueries({ queryKey: ["compliance", "consent"] });
          void queryClient.invalidateQueries({ queryKey: ["analytics", "notice"] });
        })
        // An anonymous visitor has no consent record to write to. The CMP told us anyway,
        // which is correct of it, and a 401 here is not something to show anyone.
        .catch(() => undefined);
    });
    /*
     * The assertion goes in a POST body and nowhere else: not a query string, not
     * `sessionStorage`, not a router search param (ADR-0009). A URL is logged by the proxy,
     * sent as a `Referer`, kept in history and pasted into support tickets; a 60-second
     * single-use credential that lands in any of those has a much longer life than 60 seconds.
     */
    const offHandoff = bridge.on("handoff", ({ assertion }) => {
      void call(api().POST("/embed/handoff", { body: { assertion } }))
        .then(() => refreshSession(queryClient))
        // A refused assertion means the frame stays signed out, which is what it already was.
        // The host asserting an identity we will not accept must not break its own page.
        .catch(() => undefined);
    });
    /*
     * A hint, not a requirement. A raw-iframe embed has no loader and never sends this, so the
     * property stays unset and `DialogContent` keeps its `10vmin` default — which is why that
     * default has to remain the right answer rather than a placeholder.
     */
    const offViewport = bridge.on("viewport", (region) => {
      applyEmbedViewport(document.documentElement, region);
    });
    const offLogout = bridge.on("logout", () => {
      void call(api().POST("/auth/logout"))
        .catch(() => undefined)
        .finally(() => {
          // The signed-out user's cached data goes with the session (F-25).
          queryClient.clear();
          void refreshSession(queryClient);
        });
    });
    const offTheme = bridge.on("theme", ({ tokens }) => {
      const { "--sh-color-scheme": scheme, ...rest } = tokens;
      // The host outranks the workspace brand (design/08 §4): tell `BrandTheme` which names
      // it has claimed so a later theme flip does not put the brand back on top.
      noteHostTokens(applyThemeTokens(rest));
      if (scheme === "dark" || scheme === "light") setTheme(scheme);
      else if (scheme === "auto") setTheme("system");
    });
    const unsubscribe = router.subscribe("onResolved", () => {
      bridge.post({ v: 1, type: "navigate", payload: { path: currentPath(router) } });
    });
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const height = Math.ceil(document.documentElement.getBoundingClientRect().height);
        bridge.post({ v: 1, type: "resize", payload: { height } });
      });
    });
    observer.observe(document.documentElement);
    const unsubscribeAuth = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.query.queryHash !== JSON.stringify(meQuery.queryKey))
        return;
      const state = event.query.state;
      if (state.status !== "success") return;
      bridge.post({
        v: 1,
        type: "auth",
        payload: { state: state.data === null ? "anonymous" : "authenticated" },
      });
    });
    /*
     * In-frame anchor links have nothing to scroll (design/08 §4): the loader sizes the iframe
     * to its content, so the frame's own viewport never overflows and `scrollIntoView` is a
     * no-op. The offset goes to the host, which knows where the iframe sits on its page.
     */
    const onAnchorClick = (event: Event) => {
      const anchor = (event.target as Element | null)?.closest?.("a[href^='#']");
      const hash = anchor?.getAttribute("href");
      if (hash === null || hash === undefined || hash === "#") return;
      const target = document.getElementById(decodeURIComponent(hash.slice(1)));
      if (target === null) return;
      postScrollTo(target.getBoundingClientRect().top + window.scrollY);
    };
    document.addEventListener("click", onAnchorClick);
    return () => {
      offNavigate();
      offTheme();
      offConsent();
      offHandoff();
      offLogout();
      offViewport();
      embedViewport = undefined;
      document.documentElement.style.removeProperty(DIALOG_TOP_PROPERTY);
      unsubscribe();
      unsubscribeAuth();
      document.removeEventListener("click", onAnchorClick);
      observer.disconnect();
      cancelAnimationFrame(frame);
      bridge.destroy();
      if (activeBridge === bridge) activeBridge = undefined;
    };
  }, [bridge, router, queryClient, setTheme]);

  if (probe !== "ok") {
    return (
      <div className="p-4">
        <Alert variant="warning">
          <AlertTitle>
            {probe === "insecure" ? m.embed_insecure_title() : m.embed_cookies_blocked_title()}
          </AlertTitle>
          <AlertDescription>
            <p>{probe === "insecure" ? m.embed_insecure_body() : m.embed_cookies_blocked_body()}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => openInNewTab(config.canonicalOrigin, currentPath(router))}
            >
              <ExternalLink aria-hidden="true" />
              {m.embed_open_new_tab()}
            </Button>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return <BridgeContext.Provider value={bridge}>{children}</BridgeContext.Provider>;
}

function currentPath(router: ReturnType<typeof useRouter>): string {
  const loc = router.state.location;
  return `${loc.pathname}${loc.searchStr}`;
}
