/*
 * Test instrumentation for the loader pages. A customer never has anything like it; it exists so
 * the browser tests can ask questions a page cannot otherwise answer — what height the frame
 * settled at, which paths the visitor moved through, how much space was reserved before the
 * content arrived.
 *
 * It observes from the outside and touches nothing: it listens for the same postMessage traffic
 * the loader listens for, and watches the document for the loader's own root element. That is
 * deliberate. The first version wrapped `SeedHost.init` and silently did nothing, because the
 * IIFE build exposes its exports as getter-only properties (esbuild's `__export`), so the
 * assignment failed without an error in sloppy mode — and the pages went on calling the real
 * loader while the probe stayed empty. Observing costs nothing and cannot lie in that direction.
 *
 * The pages therefore carry the documented snippet character for character.
 */
(() => {
  const PORTAL_ORIGIN = "https://portal.test";
  const probe = {
    /** Every `resize` height the child asked for, in order. */
    resizes: [],
    /** Every `navigate` path the child reported, in order. */
    navigations: [],
    /** Every bridge message, as `{type, payload}` — the test reads these for content leakage. */
    messages: [],
    /** `#below`'s viewport position the moment the loader mounted its skeleton. */
    belowTopAtMount: null,
    /** Cumulative `layout-shift` value, where the browser reports one (Chromium today). */
    cls: 0,
    ready: false,
  };
  window.__probe = probe;

  function belowTop() {
    const below = document.getElementById("below");
    return below === null ? null : Math.round(below.getBoundingClientRect().top);
  }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) probe.cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  } catch (_error) {
    /* Firefox and WebKit do not implement the layout-shift entry; the position checks do. */
  }

  // The loader appends `[data-seed-host-portal]` synchronously inside `init()`, before the frame
  // has any content — so the first time we see it is the reserved-space state.
  const mounted = new MutationObserver(() => {
    if (probe.belowTopAtMount !== null) return;
    if (document.querySelector("[data-seed-host-portal]") === null) return;
    probe.belowTopAtMount = belowTop();
  });
  mounted.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("message", (event) => {
    if (event.origin !== PORTAL_ORIGIN) return;
    const data = event.data;
    if (typeof data !== "object" || data === null || data.v !== 1) return;
    probe.messages.push({ type: data.type, payload: data.payload });
    if (data.type === "ready") probe.ready = true;
    if (data.type === "resize") probe.resizes.push(data.payload.height);
    if (data.type === "navigate") probe.navigations.push(data.payload.path);
  });
})();
