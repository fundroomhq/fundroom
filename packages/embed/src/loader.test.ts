// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://host.example/investors" }
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type InitOptions, init, isSecureHost, type Portal } from "./loader.js";
import type { ChildMessage, ParentMessage } from "./protocol.js";

/*
 * The loader runs in somebody else's page, so these tests are written from the host page's point
 * of view: what ends up in the DOM, what crosses the bridge, what the host's URL looks like
 * afterwards. jsdom never loads the cross-origin frame, which is realistic enough — the child is
 * simulated by dispatching the messages the real one posts (`apps/web/src/embed/bridge.ts`).
 *
 * jsdom does not do project-level configuration, so the environment comes from the docblock above
 * rather than a fifth Vitest project: this package needs a DOM but not React, Tailwind or the
 * `ui`/`web` setup files, and one more project for two files would be the more expensive answer.
 */
const ORIGIN = "https://portal.example";
const ANOTHER_ORIGIN = "https://evil.example";

let mounted: Promise<Portal>[] = [];

function mount(extra: Partial<InitOptions> = {}): Promise<Portal> {
  const pending = init({ workspace: "acme", baseUrl: ORIGIN, el: "#portal", ...extra });
  // Tracked synchronously, not in a `.then`: a portal that never reaches `ready` still has a
  // MutationObserver watching the document, and one that survives into the next test remounts
  // itself into that test's container. Leaking one here would look exactly like a loader bug.
  mounted.push(pending);
  return pending;
}

function frames(): HTMLIFrameElement[] {
  return [...document.querySelectorAll("iframe")];
}

function onlyFrame(): HTMLIFrameElement {
  const frame = frames()[0];
  if (frame === undefined) throw new Error("no iframe mounted");
  return frame;
}

/** Everything the loader has posted to this frame, in order. */
function spyOnFrame(frame: HTMLIFrameElement): { posted: [ParentMessage, string][] } {
  const posted: [ParentMessage, string][] = [];
  const target = frame.contentWindow;
  if (target === null) throw new Error("frame has no contentWindow");
  vi.spyOn(target, "postMessage").mockImplementation(((message: unknown, origin: unknown) => {
    posted.push([message as ParentMessage, origin as string]);
  }) as typeof target.postMessage);
  return { posted };
}

/**
 * Posted messages, minus `viewport` — every ready frame gets those and they arrive on scroll and
 * on every height change, so the tests about other traffic filter them out. The `viewport` suite
 * asserts them directly.
 */
function bridged(posted: [ParentMessage, string][]): ParentMessage[] {
  return posted.filter(([m]) => m.type !== "viewport").map(([m]) => m);
}

function types(posted: [ParentMessage, string][]): string[] {
  return bridged(posted).map((m) => m.type);
}

function fromChild(frame: HTMLIFrameElement, data: unknown, origin = ORIGIN): void {
  window.dispatchEvent(
    new MessageEvent("message", { data, origin, source: frame.contentWindow ?? null }),
  );
}

const READY: ChildMessage = { v: 1, type: "ready", payload: { path: "/updates" } };

beforeEach(() => {
  document.body.replaceChildren();
  const container = document.createElement("div");
  container.id = "portal";
  document.body.append(container);
  window.history.replaceState(null, "", "https://host.example/investors");
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.useRealTimers();
  // Settle anything still waiting for `ready` so every instance can be destroyed: an `error` on
  // the frame is the fastest of the loader's own exits.
  for (const frame of frames()) frame.dispatchEvent(new Event("error"));
  for (const portal of await Promise.all(mounted)) portal.destroy();
  mounted = [];
  // `defineProperty` on the navigator outlives `restoreAllMocks`, and a leaked GPC signal would
  // quietly turn consent off for every test after it.
  Reflect.deleteProperty(window.navigator, "globalPrivacyControl");
  vi.restoreAllMocks();
});

describe("init", () => {
  it("mounts one iframe with the sandbox, allow, title and layout the spec pins", async () => {
    const pending = mount();
    const frame = onlyFrame();
    expect(frame.getAttribute("src")).toBe("https://portal.example/embed/acme");
    expect(frame.getAttribute("sandbox")).toBe(
      "allow-scripts allow-same-origin allow-forms allow-popups " +
        "allow-popups-to-escape-sandbox allow-downloads",
    );
    expect(frame.getAttribute("allow")).toBe(
      "clipboard-write; fullscreen; publickey-credentials-get",
    );
    expect(frame.getAttribute("title")).toBe("Investor relations portal");
    expect(frame.style.width).toBe("100%");
    expect(frame.style.border).toBe("0px");
    expect(frame.style.display).toBe("block");
    // The skeleton: the host page must not shift when the real height arrives (CLS).
    expect(frame.style.height).toBe("320px");
    const root = document.querySelector("[data-seed-host-portal]");
    expect(root?.getAttribute("data-seed-host-portal")).toBe("acme");
    expect((root as HTMLElement | null)?.style.minHeight).toBe("320px");

    fromChild(frame, READY);
    await expect(pending).resolves.toMatchObject({ state: "ready" });
  });

  it("never suppresses the referrer: it is the server's only initiator signal", async () => {
    const pending = mount();
    const frame = onlyFrame();
    // A top-level iframe navigation sends no `Origin` header, so `Referer` is what the
    // per-workspace origin check reads. A `referrerpolicy` here would silently disable it.
    expect(frame.hasAttribute("referrerpolicy")).toBe(false);
    fromChild(frame, READY);
    await pending;
  });

  it("puts the path in the frame URL and the handoff nowhere near it", async () => {
    const pending = mount({ path: "/data-room", handoff: "assertion.jwt.value", locale: "en" });
    const frame = onlyFrame();
    expect(frame.getAttribute("src")).toBe("https://portal.example/embed/acme/data-room?lang=en");
    expect(frame.getAttribute("src")).not.toContain("assertion");
    const { posted } = spyOnFrame(frame);
    fromChild(frame, READY);
    await pending;
    expect(bridged(posted)[0]).toEqual({
      v: 1,
      type: "handoff",
      payload: { assertion: "assertion.jwt.value" },
    });
  });

  it("throws for a snippet that cannot work, rather than failing quietly", () => {
    expect(() => init({ workspace: "acme", baseUrl: "portal.example", el: "#portal" })).toThrow(
      /absolute URL/u,
    );
    expect(() => init({ workspace: "acme", baseUrl: ORIGIN, el: "#missing" })).toThrow(
      /did not resolve/u,
    );
  });

  it("queues what the host asks for before the frame is listening, then replays it", async () => {
    const pending = mount({ theme: { "--sh-color-accent": "#123456" } });
    const frame = onlyFrame();
    const { posted } = spyOnFrame(frame);
    // Nothing can be posted yet: the child has not said `ready`.
    expect(posted).toHaveLength(0);
    fromChild(frame, READY);
    const p = await pending;
    p.navigate("/round");
    expect(types(posted)).toEqual(["theme", "navigate"]);
    expect(posted.every(([, origin]) => origin === ORIGIN)).toBe(true);
  });
});

describe("the bridge", () => {
  it("posts to one explicit origin, never `*`", async () => {
    const pending = mount();
    const frame = onlyFrame();
    const { posted } = spyOnFrame(frame);
    fromChild(frame, READY);
    const portal = await pending;
    portal.setTheme({ "--sh-radius": "4px" });
    portal.setConsent({ analytics: true });
    portal.logout();
    expect(posted.map(([, origin]) => origin)).toEqual(posted.map(() => ORIGIN));
    expect(types(posted)).toEqual(["theme", "consent", "logout"]);
  });

  it("ignores a message from another origin", async () => {
    const pending = mount();
    const frame = onlyFrame();
    const seen: string[] = [];
    fromChild(frame, READY, ANOTHER_ORIGIN);
    // Still loading: the forged `ready` was dropped.
    expect(frames()).toHaveLength(1);
    fromChild(frame, READY);
    const portal = await pending;
    portal.on("navigate", ({ path }) => seen.push(path));
    fromChild(frame, { v: 1, type: "navigate", payload: { path: "/x" } }, ANOTHER_ORIGIN);
    expect(seen).toEqual([]);
    expect(portal.path).toBe("/updates");
  });

  it("ignores a right-origin message from a window that is not our frame", async () => {
    const pending = mount();
    const frame = onlyFrame();
    fromChild(frame, READY);
    const portal = await pending;
    const seen: string[] = [];
    portal.on("navigate", ({ path }) => seen.push(path));
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { v: 1, type: "navigate", payload: { path: "/spoofed" } },
        origin: ORIGIN,
        source: window,
      }),
    );
    expect(seen).toEqual([]);
  });

  it("ignores an unknown message type without throwing", async () => {
    const pending = mount();
    const frame = onlyFrame();
    fromChild(frame, READY);
    const portal = await pending;
    const events: string[] = [];
    portal.on("auth", () => events.push("auth"));
    expect(() => {
      fromChild(frame, { v: 1, type: "from-the-future", payload: { anything: true } });
      fromChild(frame, "not even an object");
    }).not.toThrow();
    expect(events).toEqual([]);
    expect(portal.state).toBe("ready");
  });

  it("delivers child events to `on`, `off` and `onEvent`", async () => {
    const seen: string[] = [];
    const pending = mount({ onEvent: (e) => seen.push(`onEvent:${e.type}`) });
    const frame = onlyFrame();
    fromChild(frame, READY);
    const portal = await pending;
    const handler = (payload: { state: string }): void => {
      seen.push(`on:${payload.state}`);
    };
    portal.on("auth", handler);
    fromChild(frame, { v: 1, type: "auth", payload: { state: "authenticated" } });
    portal.off("auth", handler);
    fromChild(frame, { v: 1, type: "auth", payload: { state: "expired" } });
    expect(seen).toEqual(["onEvent:ready", "on:authenticated", "onEvent:auth", "onEvent:auth"]);
  });

  it("scrolls the host page for an in-frame anchor, and not otherwise", async () => {
    const pending = mount();
    const frame = onlyFrame();
    fromChild(frame, READY);
    await pending;
    fromChild(frame, { v: 1, type: "scroll-to", payload: { y: 120 } });
    expect(window.scrollTo).toHaveBeenCalledTimes(1);
  });

  it("does not navigate the host page on `open-external`", async () => {
    const pending = mount();
    const frame = onlyFrame();
    fromChild(frame, READY);
    const portal = await pending;
    const urls: string[] = [];
    portal.on("open-external", ({ url }) => urls.push(url));
    fromChild(frame, { v: 1, type: "open-external", payload: { url: "https://a.example/x" } });
    expect(urls).toEqual(["https://a.example/x"]);
    expect(window.location.href).toBe("https://host.example/investors?sh=/updates");
  });
});

describe("height", () => {
  it("debounces a burst of resizes into one style write, clamped to minHeight", async () => {
    vi.useFakeTimers();
    const pending = mount({ minHeight: 200, maxHeight: 900 });
    const frame = onlyFrame();
    fromChild(frame, READY);
    const portal = await pending;
    expect(portal.state).toBe("ready");
    fromChild(frame, { v: 1, type: "resize", payload: { height: 500 } });
    fromChild(frame, { v: 1, type: "resize", payload: { height: 640 } });
    expect(frame.style.height).toBe("200px");
    vi.advanceTimersByTime(60);
    expect(frame.style.height).toBe("640px");
    fromChild(frame, { v: 1, type: "resize", payload: { height: 10 } });
    vi.advanceTimersByTime(60);
    expect(frame.style.height).toBe("200px");
  });

  it("stops growing at maxHeight and lets the frame scroll internally", async () => {
    vi.useFakeTimers();
    const pending = mount({ maxHeight: 600 });
    const frame = onlyFrame();
    fromChild(frame, READY);
    await pending;
    fromChild(frame, { v: 1, type: "resize", payload: { height: 4000 } });
    vi.advanceTimersByTime(60);
    expect(frame.style.height).toBe("600px");
  });
});

describe("history", () => {
  it("writes `?sh=` with replaceState by default and keeps the host's history state", async () => {
    window.history.replaceState({ hostRouter: "state" }, "", "https://host.example/investors?a=1");
    const pending = mount();
    const frame = onlyFrame();
    fromChild(frame, READY);
    await pending;
    expect(window.location.search).toBe("?a=1&sh=/updates");
    expect(window.history.state).toEqual({ hostRouter: "state" });
  });

  it("restores the initial path from the host URL, beating the snippet's default", async () => {
    window.history.replaceState(null, "", "https://host.example/investors?sh=/data-room/xyz");
    const pending = mount({ path: "/updates" });
    expect(onlyFrame().getAttribute("src")).toBe("https://portal.example/embed/acme/data-room/xyz");
    fromChild(onlyFrame(), { v: 1, type: "ready", payload: { path: "/data-room/xyz" } });
    await pending;
  });

  it("pushes on an explicit navigate and replaces on a child navigate", async () => {
    const pending = mount();
    const frame = onlyFrame();
    fromChild(frame, READY);
    const portal = await pending;
    const before = window.history.length;
    portal.navigate("/round");
    expect(window.location.search).toBe("?sh=/round");
    expect(window.history.length).toBe(before + 1);
    fromChild(frame, { v: 1, type: "navigate", payload: { path: "/updates/2026-q2" } });
    expect(window.location.search).toBe("?sh=/updates/2026-q2");
    expect(window.history.length).toBe(before + 1);
    expect(portal.path).toBe("/updates/2026-q2");
  });

  it("tells the frame to follow the host's back button", async () => {
    const pending = mount();
    const frame = onlyFrame();
    const { posted } = spyOnFrame(frame);
    fromChild(frame, READY);
    const portal = await pending;
    portal.navigate("/round");
    window.history.replaceState(null, "", "https://host.example/investors?sh=/updates");
    window.dispatchEvent(new PopStateEvent("popstate"));
    expect(bridged(posted).at(-1)).toEqual({
      v: 1,
      type: "navigate",
      payload: { path: "/updates" },
    });
  });

  it("uses the fragment in hash mode", async () => {
    const pending = mount({ history: "hash" });
    fromChild(onlyFrame(), READY);
    await pending;
    expect(window.location.hash).toBe("#sh=/updates");
    expect(window.location.search).toBe("");
  });

  it("leaves the host URL alone in none mode", async () => {
    const pending = mount({ history: "none" });
    fromChild(onlyFrame(), READY);
    const portal = await pending;
    portal.navigate("/round");
    expect(window.location.href).toBe("https://host.example/investors");
    expect(portal.path).toBe("/round");
  });

  it("rejects a navigate that is not an in-app path", async () => {
    const pending = mount();
    fromChild(onlyFrame(), READY);
    const portal = await pending;
    expect(() => portal.navigate("//evil.example")).toThrow(TypeError);
    expect(() => portal.navigate("https://evil.example")).toThrow(TypeError);
    expect(() => portal.navigate("/../../admin")).toThrow(TypeError);
    expect(portal.path).toBe("/updates");
  });

  it("ignores a `..` path in a shared link instead of repointing the frame", async () => {
    // Regression: `?sh=/../../embed/victim-workspace` walked out of this workspace and loaded
    // another one's embed document into the widget, which then received this workspace's theme,
    // consent and handoff.
    window.history.replaceState(
      null,
      "",
      "https://host.example/investors?sh=/../../embed/victim-workspace",
    );
    const pending = mount({ path: "/updates" });
    expect(onlyFrame().getAttribute("src")).toBe("https://portal.example/embed/acme/updates");
    fromChild(onlyFrame(), READY);
    await pending;
  });

  it("ignores a `..` path arriving over the bridge", async () => {
    const pending = mount({ history: "none" });
    const frame = onlyFrame();
    fromChild(frame, READY);
    const portal = await pending;
    fromChild(frame, { v: 1, type: "navigate", payload: { path: "/../../admin" } });
    expect(portal.path).toBe("/updates");
  });
});

describe("consent", () => {
  it("folds GPC in as a negative-only signal", async () => {
    Object.defineProperty(window.navigator, "globalPrivacyControl", {
      configurable: true,
      value: true,
    });
    const pending = mount({ consent: { analytics: true } });
    const frame = onlyFrame();
    const { posted } = spyOnFrame(frame);
    fromChild(frame, READY);
    const portal = await pending;
    expect(bridged(posted)[0]).toEqual({
      v: 1,
      type: "consent",
      payload: { analytics: false, gpc: true },
    });
    // A host CMP flipping to "yes" later must not override the browser's signal either.
    portal.setConsent({ analytics: true });
    expect(bridged(posted)[1]).toEqual({
      v: 1,
      type: "consent",
      payload: { analytics: false, gpc: true },
    });
  });

  it("passes the host's answer through when the browser is silent", async () => {
    const pending = mount({ consent: { analytics: true } });
    const frame = onlyFrame();
    const { posted } = spyOnFrame(frame);
    fromChild(frame, READY);
    await pending;
    expect(bridged(posted)[0]).toEqual({ v: 1, type: "consent", payload: { analytics: true } });
  });
});

describe("failure modes", () => {
  it("falls back to a link when the frame never reports ready", async () => {
    vi.useFakeTimers();
    const pending = mount();
    expect(frames()).toHaveLength(1);
    vi.advanceTimersByTime(5_000);
    const portal = await pending;
    expect(portal.state).toBe("fallback");
    expect(frames()).toHaveLength(0);
    const link = document.querySelector<HTMLAnchorElement>("[data-seed-host-fallback]");
    expect(link?.textContent).toBe("Open investor portal");
    expect(link?.getAttribute("href")).toBe("https://portal.example/w/acme");
    expect(link?.rel).toBe("noopener");
    // The console message has to name the directives a host needs, not just complain.
    const warning = vi.mocked(console.warn).mock.calls[0]?.[0] as string;
    expect(warning).toContain("frame-src https://portal.example");
    expect(warning).toContain("child-src https://portal.example");
    expect(warning).toContain("script-src https://portal.example");
  });

  it("falls back when the frame fires an error", async () => {
    const pending = mount();
    const frame = onlyFrame();
    frame.dispatchEvent(new Event("error"));
    const portal = await pending;
    expect(portal.state).toBe("fallback");
    expect(document.querySelector("[data-seed-host-fallback]")).not.toBeNull();
  });

  it("keeps the fallback link pointing at the path the host navigated to", async () => {
    vi.useFakeTimers();
    const pending = mount();
    vi.advanceTimersByTime(5_000);
    const portal = await pending;
    portal.navigate("/round");
    expect(document.querySelector("[data-seed-host-fallback]")?.getAttribute("href")).toBe(
      "https://portal.example/w/acme/round",
    );
  });
});

describe("viewport", () => {
  /** jsdom lays nothing out, so the frame's rectangle is supplied. */
  function placeFrame(top: number, height: number): void {
    vi.spyOn(HTMLIFrameElement.prototype, "getBoundingClientRect").mockReturnValue({
      top,
      height,
      bottom: top + height,
      left: 0,
      right: 320,
      width: 320,
      x: 0,
      y: top,
      toJSON: () => ({}),
    } as DOMRect);
  }

  /** One animation frame, whichever scheduler the loader picked. */
  async function nextFrame(): Promise<void> {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 40);
    });
  }

  beforeEach(() => {
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });
  });

  it("tells the child which part of it the reader can see, as soon as it is ready", async () => {
    placeFrame(0, 1000);
    const pending = mount();
    const frame = onlyFrame();
    const { posted } = spyOnFrame(frame);
    fromChild(frame, READY);
    await pending;
    expect(posted.map(([m]) => m.type)).toContain("viewport");
    expect(posted.find(([m]) => m.type === "viewport")?.[0]).toEqual({
      v: 1,
      type: "viewport",
      payload: { top: 0, height: 800 },
    });
  });

  it("follows the host's scroll, throttled, and says nothing when nothing moved", async () => {
    placeFrame(0, 1000);
    const pending = mount();
    const frame = onlyFrame();
    const { posted } = spyOnFrame(frame);
    fromChild(frame, READY);
    await pending;
    const viewports = (): unknown[] =>
      posted.filter(([m]) => m.type === "viewport").map((e) => e[0]);
    expect(viewports()).toHaveLength(1);

    // The reader has scrolled 500px past the top of the frame.
    placeFrame(-500, 1000);
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("scroll"));
    await nextFrame();
    // Three events, one message: the rAF throttle.
    expect(viewports()).toHaveLength(2);
    expect(viewports()[1]).toEqual({ v: 1, type: "viewport", payload: { top: 500, height: 500 } });

    // A scroll that does not change the numbers costs the child nothing.
    window.dispatchEvent(new Event("scroll"));
    await nextFrame();
    expect(viewports()).toHaveLength(2);
  });

  it("reports an off-screen frame once, with height 0", async () => {
    placeFrame(0, 1000);
    const pending = mount();
    const frame = onlyFrame();
    const { posted } = spyOnFrame(frame);
    fromChild(frame, READY);
    await pending;
    const viewports = (): unknown[] =>
      posted.filter(([m]) => m.type === "viewport").map((e) => e[0]);

    // Scrolled past, entirely below the viewport.
    placeFrame(900, 1000);
    window.dispatchEvent(new Event("scroll"));
    await nextFrame();
    expect(viewports()[1]).toEqual({ v: 1, type: "viewport", payload: { top: 0, height: 0 } });

    // And entirely above it: still off-screen, so still nothing more to say.
    placeFrame(-3000, 1000);
    window.dispatchEvent(new Event("scroll"));
    await nextFrame();
    expect(viewports()).toHaveLength(2);
  });

  it("listens passively, in the capture phase, and stops on destroy", async () => {
    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");
    placeFrame(0, 1000);
    const pending = mount();
    const frame = onlyFrame();
    const { posted } = spyOnFrame(frame);
    fromChild(frame, READY);
    const portal = await pending;
    for (const type of ["scroll", "resize"]) {
      expect(added).toHaveBeenCalledWith(type, expect.any(Function), {
        passive: true,
        capture: true,
      });
    }

    portal.destroy();
    for (const type of ["scroll", "resize"]) {
      expect(removed).toHaveBeenCalledWith(type, expect.any(Function), {
        passive: true,
        capture: true,
      });
    }
    const before = posted.length;
    placeFrame(-500, 1000);
    window.dispatchEvent(new Event("scroll"));
    window.dispatchEvent(new Event("resize"));
    await nextFrame();
    expect(posted).toHaveLength(before);
  });
});

describe("remount", () => {
  it("re-creates the frame when the host router destroys the container", async () => {
    const pending = mount();
    fromChild(onlyFrame(), READY);
    const portal = await pending;
    portal.navigate("/round");
    const first = onlyFrame();

    // What a host router does on a re-render: the container is replaced, not emptied.
    const container = document.querySelector("#portal");
    container?.remove();
    const replacement = document.createElement("div");
    replacement.id = "portal";
    document.body.append(replacement);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    const second = onlyFrame();
    expect(second).not.toBe(first);
    expect(second.getAttribute("src")).toBe("https://portal.example/embed/acme/round");
    expect(replacement.contains(second)).toBe(true);
    expect(portal.state).toBe("loading");
  });

  it("does not resurrect a portal that has already fallen back", async () => {
    // Regression: the observer called `mountFrame()` guarded only on `destroyed`, so any host
    // re-render silently retried a portal that had given up — and explained the next failure with
    // the wrong reason.
    vi.useFakeTimers();
    const pending = mount();
    vi.advanceTimersByTime(5_000);
    const portal = await pending;
    expect(portal.state).toBe("fallback");
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
    const container = document.querySelector("#portal");
    container?.remove();
    const replacement = document.createElement("div");
    replacement.id = "portal";
    document.body.append(replacement);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    expect(document.querySelector("iframe")).toBeNull();
    expect(portal.state).toBe("fallback");
    // The link follows the container, so the reader still has a way in.
    const link = replacement.querySelector("[data-seed-host-fallback]");
    expect(link?.getAttribute("href")).toBe("https://portal.example/w/acme");
    // And the reason is explained once, not once per re-render.
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
  });

  it("resends theme, handoff and consent to the new document", async () => {
    const pending = mount({ theme: { "--sh-color-bg": "#fff" }, consent: { analytics: false } });
    fromChild(onlyFrame(), READY);
    await pending;
    const container = document.querySelector("#portal");
    container?.replaceChildren();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    const frame = onlyFrame();
    const { posted } = spyOnFrame(frame);
    fromChild(frame, READY);
    expect(types(posted)).toEqual(["theme", "consent"]);
  });
});

describe("multiple portals on one page", () => {
  it("keeps two instances independent", async () => {
    const second = document.createElement("div");
    second.id = "second";
    document.body.append(second);

    const pendingA = mount({ history: "none" });
    const pendingB = mount({ el: "#second", history: "none", path: "/data-room" });
    const [frameA, frameB] = frames();
    if (frameA === undefined || frameB === undefined) throw new Error("expected two frames");
    const a = spyOnFrame(frameA);
    const b = spyOnFrame(frameB);

    fromChild(frameA, READY);
    fromChild(frameB, { v: 1, type: "ready", payload: { path: "/data-room" } });
    const portalA = await pendingA;
    const portalB = await pendingB;

    portalA.navigate("/round");
    expect(types(a.posted)).toEqual(["navigate"]);
    expect(types(b.posted)).toEqual([]);
    expect(portalB.path).toBe("/data-room");

    fromChild(frameB, { v: 1, type: "resize", payload: { height: 800 } });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 60);
    });
    expect(frameB.style.height).toBe("800px");
    expect(frameA.style.height).toBe("320px");

    portalA.destroy();
    expect(frames()).toHaveLength(1);
    expect(portalB.state).toBe("ready");
  });
});

describe("destroy", () => {
  it("removes the frame, stops listening and is idempotent", async () => {
    const pending = mount();
    const frame = onlyFrame();
    const { posted } = spyOnFrame(frame);
    fromChild(frame, READY);
    const portal = await pending;
    portal.destroy();
    portal.destroy();
    expect(portal.state).toBe("destroyed");
    expect(document.querySelector("[data-seed-host-portal]")).toBeNull();
    const before = posted.length;
    portal.navigate("/round");
    portal.logout();
    fromChild(frame, { v: 1, type: "resize", payload: { height: 900 } });
    expect(posted).toHaveLength(before);
  });
});

describe("isSecureHost", () => {
  it("trusts https, then the browser, then loopback", () => {
    expect(isSecureHost("https:", "host.example", false)).toBe(true);
    expect(isSecureHost("http:", "host.example", false)).toBe(false);
    // A browser that says a non-https page is a secure context (localhost) is believed.
    expect(isSecureHost("http:", "localhost", true)).toBe(true);
    // No `isSecureContext` (jsdom, very old browsers): fall back to the loopback list.
    expect(isSecureHost("http:", "localhost", undefined)).toBe(true);
    expect(isSecureHost("http:", "app.localhost", undefined)).toBe(true);
    expect(isSecureHost("http:", "127.0.0.1", undefined)).toBe(true);
    expect(isSecureHost("http:", "[::1]", undefined)).toBe(true);
    expect(isSecureHost("http:", "notlocalhost.example", undefined)).toBe(false);
  });
});
