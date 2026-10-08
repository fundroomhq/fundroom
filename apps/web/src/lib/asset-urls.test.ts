import { describe, expect, it, vi } from "vitest";
import {
  handlePreloadError,
  installPreloadErrorRecovery,
  PRELOAD_RELOAD_KEY,
  PRELOAD_RELOAD_WINDOW_MS,
  renderBuiltAssetUrl,
} from "./asset-urls.js";

describe("renderBuiltAssetUrl", () => {
  it("makes JS- and CSS-hosted URLs file-relative, so chunks follow the entry's base", () => {
    expect(renderBuiltAssetUrl("assets/admin-abc.js", { hostType: "js" })).toEqual({
      relative: true,
    });
    expect(renderBuiltAssetUrl("assets/font-abc.woff2", { hostType: "css" })).toEqual({
      relative: true,
    });
  });

  it("leaves index.html root-relative for the server's per-request rewrite", () => {
    expect(renderBuiltAssetUrl("assets/index-abc.js", { hostType: "html" })).toBeUndefined();
  });

  it("never emits a runtime expression (no global to set before the first dynamic import)", () => {
    for (const hostType of ["js", "css", "html"] as const) {
      expect(renderBuiltAssetUrl("assets/x.js", { hostType }) ?? {}).not.toHaveProperty("runtime");
    }
  });
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    data,
  };
}

function fakeWindow(storage: Pick<Storage, "getItem" | "setItem">) {
  const listeners = new Map<string, ((e: Event) => void)[]>();
  return {
    sessionStorage: storage,
    location: { reload: vi.fn() },
    addEventListener: (type: string, fn: (e: Event) => void) => {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatch(event: Event) {
      for (const fn of listeners.get(event.type) ?? []) fn(event);
    },
    listenerCount: (type: string) => listeners.get(type)?.length ?? 0,
  };
}

const preloadError = () => new Event("vite:preloadError", { cancelable: true });

describe("handlePreloadError", () => {
  it("reloads once, swallowing the error, and records when", () => {
    const storage = memoryStorage();
    const win = fakeWindow(storage);
    const event = preloadError();
    expect(handlePreloadError(event, win, 1_000_000)).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    expect(win.location.reload).toHaveBeenCalledOnce();
    expect(storage.data.get(PRELOAD_RELOAD_KEY)).toBe("1000000");
  });

  it("lets a second failure inside the window through to the error screen (no loop)", () => {
    const win = fakeWindow(memoryStorage({ [PRELOAD_RELOAD_KEY]: "1000000" }));
    const event = preloadError();
    expect(handlePreloadError(event, win, 1_000_000 + PRELOAD_RELOAD_WINDOW_MS - 1)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(win.location.reload).not.toHaveBeenCalled();
  });

  it("reloads again once the window has passed (a later deploy)", () => {
    const win = fakeWindow(memoryStorage({ [PRELOAD_RELOAD_KEY]: "1000000" }));
    expect(handlePreloadError(preloadError(), win, 1_000_000 + PRELOAD_RELOAD_WINDOW_MS)).toBe(
      true,
    );
    expect(win.location.reload).toHaveBeenCalledOnce();
  });

  it("ignores a garbage or future stamp rather than trusting it", () => {
    for (const stamp of ["nope", "", "9999999999999"]) {
      const win = fakeWindow(memoryStorage({ [PRELOAD_RELOAD_KEY]: stamp }));
      expect(handlePreloadError(preloadError(), win, 1_000_000)).toBe(true);
    }
  });

  it("does not reload when storage is unavailable (no loop guard)", () => {
    const win = fakeWindow({
      getItem: () => {
        throw new DOMException("blocked", "SecurityError");
      },
      setItem: () => undefined,
    });
    const event = preloadError();
    expect(handlePreloadError(event, win, 1)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
    expect(win.location.reload).not.toHaveBeenCalled();
  });

  it("does not reload when the stamp cannot be written", () => {
    const win = fakeWindow({
      getItem: () => null,
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
    });
    expect(handlePreloadError(preloadError(), win, 1)).toBe(false);
    expect(win.location.reload).not.toHaveBeenCalled();
  });
});

describe("installPreloadErrorRecovery", () => {
  it("listens for vite:preloadError once, however often it is called", () => {
    const win = fakeWindow(memoryStorage());
    installPreloadErrorRecovery(win);
    installPreloadErrorRecovery(win);
    expect(win.listenerCount("vite:preloadError")).toBe(1);
    win.dispatch(preloadError());
    expect(win.location.reload).toHaveBeenCalledOnce();
  });

  it("logs the failure it lets through", () => {
    const win = fakeWindow(memoryStorage({ [PRELOAD_RELOAD_KEY]: String(Date.now()) }));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    installPreloadErrorRecovery(win);
    const event = Object.assign(preloadError(), { payload: new Error("chunk gone") });
    win.dispatch(event);
    expect(spy).toHaveBeenCalledWith("a lazy chunk failed to load", event.payload);
    expect(event.defaultPrevented).toBe(false);
    spy.mockRestore();
  });
});
