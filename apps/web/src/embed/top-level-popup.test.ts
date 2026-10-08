import { describe, expect, it, vi } from "vitest";
import { openTopLevelPopup } from "./top-level-popup.js";

/*
 * The opener's half of the top-level popup (ADR-0040 decision 11). The popup itself is
 * `/auth/popup`, which has posted `{v:1,type:"auth"}` to `window.opener` since E0.3; what is
 * tested here is that the frame believes it only from the origin it opened, and that a popup
 * the visitor closes resolves rather than hanging forever on a promise nobody settles.
 */
function fakeWindow(popup: { closed: boolean } | null) {
  const listeners = new Set<(e: MessageEvent) => void>();
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const opened: string[] = [];
  return {
    opened,
    win: {
      open: (url: string) => {
        opened.push(url);
        return popup as unknown as Window | null;
      },
      addEventListener: (_: string, l: EventListener) =>
        listeners.add(l as unknown as (e: MessageEvent) => void),
      removeEventListener: (_: string, l: EventListener) =>
        listeners.delete(l as unknown as (e: MessageEvent) => void),
      setInterval: (fn: () => void) => {
        timers.set(nextTimer, fn);
        return nextTimer++;
      },
      clearInterval: (id: number) => {
        timers.delete(id);
      },
    } as unknown as Window,
    emit(origin: string, data: unknown) {
      for (const l of [...listeners]) l({ origin, data } as MessageEvent);
    },
    tick() {
      for (const fn of [...timers.values()]) fn();
    },
    listenerCount: () => listeners.size,
    timerCount: () => timers.size,
  };
}

describe("openTopLevelPopup", () => {
  it("opens the portal origin and resolves when the popup posts back", async () => {
    const popup = { closed: false, close: vi.fn() };
    const w = fakeWindow(popup);
    const promise = openTopLevelPopup({
      canonicalOrigin: "https://investors.acme.test/",
      path: "/auth/popup",
      search: { reason: "fresh" },
      win: w.win,
    });
    expect(w.opened).toEqual(["https://investors.acme.test/auth/popup?reason=fresh"]);

    // A message from anywhere else is not our popup, whatever it claims to be.
    w.emit("https://evil.test", { v: 1, type: "auth", payload: { state: "authenticated" } });
    // Nor is an unrelated message from the right origin.
    w.emit("https://investors.acme.test", { v: 1, type: "resize", payload: { height: 10 } });
    expect(popup.close).not.toHaveBeenCalled();

    w.emit("https://investors.acme.test", { v: 1, type: "auth", payload: { state: "x" } });
    await expect(promise).resolves.toBe("completed");
    expect(popup.close).toHaveBeenCalled();
    expect(w.listenerCount()).toBe(0);
    expect(w.timerCount()).toBe(0);
  });

  it("resolves dismissed when the visitor closes the popup", async () => {
    const popup = { closed: false, close: vi.fn() };
    const w = fakeWindow(popup);
    const promise = openTopLevelPopup({
      canonicalOrigin: "https://investors.acme.test",
      path: "/auth/popup",
      win: w.win,
    });
    w.tick();
    popup.closed = true;
    w.tick();
    await expect(promise).resolves.toBe("dismissed");
    expect(w.listenerCount()).toBe(0);
  });

  it("reports a blocked popup rather than waiting for one that never opened", async () => {
    const w = fakeWindow(null);
    await expect(
      openTopLevelPopup({
        canonicalOrigin: "https://investors.acme.test",
        path: "/auth/popup",
        win: w.win,
      }),
    ).resolves.toBe("blocked");
    await expect(
      openTopLevelPopup({ canonicalOrigin: "not a url", path: "/auth/popup", win: w.win }),
    ).resolves.toBe("blocked");
  });
});
