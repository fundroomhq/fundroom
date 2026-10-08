import { describe, expect, it, vi } from "vitest";
import { consentGranted, createBridge, parseInbound, selectTargetOrigin } from "./bridge.js";

function fakeWindow() {
  const listeners = new Set<(e: MessageEvent) => void>();
  return {
    addEventListener: (_: string, l: EventListener) =>
      listeners.add(l as unknown as (e: MessageEvent) => void),
    removeEventListener: (_: string, l: EventListener) =>
      listeners.delete(l as unknown as (e: MessageEvent) => void),
    emit(origin: string, data: unknown) {
      for (const l of listeners) l({ origin, data } as MessageEvent);
    },
    size: () => listeners.size,
  };
}

describe("selectTargetOrigin", () => {
  it("prefers the allowed origin matching the referrer, else the first, else none", () => {
    const allowed = ["https://acme.com", "https://www.acme.com/"];
    expect(selectTargetOrigin(allowed, "https://www.acme.com/investors")).toBe(
      "https://www.acme.com",
    );
    expect(selectTargetOrigin(allowed, "https://other.test/")).toBe("https://acme.com");
    expect(selectTargetOrigin(allowed, undefined)).toBe("https://acme.com");
    expect(selectTargetOrigin([], "https://acme.com/")).toBeUndefined();
    expect(selectTargetOrigin(["not a url", "*"], undefined)).toBeUndefined();
  });
});

describe("parseInbound", () => {
  it("accepts only v1 navigate/theme with safe payloads", () => {
    expect(parseInbound({ v: 1, type: "navigate", payload: { path: "/updates" } })).toEqual({
      v: 1,
      type: "navigate",
      payload: { path: "/updates" },
    });
    expect(parseInbound({ v: 1, type: "navigate", payload: { path: "//evil" } })).toBeUndefined();
    expect(parseInbound({ v: 2, type: "navigate", payload: { path: "/" } })).toBeUndefined();
    expect(parseInbound({ v: 1, type: "resize", payload: {} })).toBeUndefined();
    expect(parseInbound("string")).toBeUndefined();
    expect(
      parseInbound({ v: 1, type: "theme", payload: { tokens: { "--sh-color-bg": "#fff", x: 1 } } }),
    ).toEqual({ v: 1, type: "theme", payload: { tokens: { "--sh-color-bg": "#fff" } } });
  });
});

describe("createBridge", () => {
  it("drops messages from origins outside the allow-list", () => {
    const self = fakeWindow();
    const target = { postMessage: vi.fn() };
    const bridge = createBridge({
      allowedOrigins: ["https://acme.com"],
      targetWindow: target,
      self,
      referrer: "https://acme.com/page",
    });
    const onNav = vi.fn();
    bridge.on("navigate", onNav);
    self.emit("https://evil.test", { v: 1, type: "navigate", payload: { path: "/x" } });
    expect(onNav).not.toHaveBeenCalled();
    self.emit("https://acme.com", { v: 1, type: "navigate", payload: { path: "/x" } });
    expect(onNav).toHaveBeenCalledWith({ path: "/x" });
    bridge.destroy();
    expect(self.size()).toBe(0);
  });
  it("posts to the selected origin, never to *", () => {
    const target = { postMessage: vi.fn() };
    const bridge = createBridge({
      allowedOrigins: ["https://acme.com", "https://www.acme.com"],
      targetWindow: target,
      self: fakeWindow(),
      referrer: "https://www.acme.com/investors",
    });
    expect(bridge.post({ v: 1, type: "resize", payload: { height: 10 } })).toBe(true);
    expect(target.postMessage).toHaveBeenCalledWith(
      { v: 1, type: "resize", payload: { height: 10 } },
      "https://www.acme.com",
    );
    for (const c of target.postMessage.mock.calls) expect(c[1]).not.toBe("*");
  });
  it("posts nothing with an empty allow-list", () => {
    const target = { postMessage: vi.fn() };
    const bridge = createBridge({ allowedOrigins: [], targetWindow: target, self: fakeWindow() });
    expect(bridge.post({ v: 1, type: "ready", payload: { path: "/" } })).toBe(false);
    expect(target.postMessage).not.toHaveBeenCalled();
  });
});

describe("parseInbound, the E2.2 additions", () => {
  it("accepts consent with an optional gpc flag", () => {
    expect(parseInbound({ v: 1, type: "consent", payload: { analytics: true } })).toEqual({
      v: 1,
      type: "consent",
      payload: { analytics: true },
    });
    expect(
      parseInbound({ v: 1, type: "consent", payload: { analytics: false, gpc: true } }),
    ).toEqual({ v: 1, type: "consent", payload: { analytics: false, gpc: true } });
    expect(parseInbound({ v: 1, type: "consent", payload: { analytics: "yes" } })).toBeUndefined();
    expect(
      parseInbound({ v: 1, type: "consent", payload: { analytics: true, gpc: "1" } }),
    ).toBeUndefined();
  });

  it("accepts only a compact JWS as a handoff assertion", () => {
    const jws = `${"a".repeat(40)}.${"b".repeat(60)}.${"c".repeat(86)}`;
    expect(parseInbound({ v: 1, type: "handoff", payload: { assertion: jws } })).toEqual({
      v: 1,
      type: "handoff",
      payload: { assertion: jws },
    });
    // Two segments, a JSON body, a padded base64 and an over-long one are all not assertions,
    // and none of them should reach the network.
    expect(parseInbound({ v: 1, type: "handoff", payload: { assertion: "a.b" } })).toBeUndefined();
    expect(
      parseInbound({ v: 1, type: "handoff", payload: { assertion: '{"alg":"none"}' } }),
    ).toBeUndefined();
    expect(
      parseInbound({ v: 1, type: "handoff", payload: { assertion: "a+/=.b.c" } }),
    ).toBeUndefined();
    expect(
      parseInbound({ v: 1, type: "handoff", payload: { assertion: `a.b.${"c".repeat(4096)}` } }),
    ).toBeUndefined();
  });

  it("accepts a viewport region and refuses anything that is not a measurement", () => {
    expect(parseInbound({ v: 1, type: "viewport", payload: { top: 0, height: 640 } })).toEqual({
      v: 1,
      type: "viewport",
      payload: { top: 0, height: 640 },
    });
    expect(parseInbound({ v: 1, type: "viewport", payload: { top: 2500.5, height: 640 } })).toEqual(
      { v: 1, type: "viewport", payload: { top: 2500.5, height: 640 } },
    );
    // A region above the frame, of negative height, or not a number at all, is not something
    // to clamp into shape: clamping would be guessing at what the host meant.
    expect(
      parseInbound({ v: 1, type: "viewport", payload: { top: -10, height: 640 } }),
    ).toBeUndefined();
    expect(
      parseInbound({ v: 1, type: "viewport", payload: { top: 0, height: -1 } }),
    ).toBeUndefined();
    expect(
      parseInbound({ v: 1, type: "viewport", payload: { top: Number.NaN, height: 640 } }),
    ).toBeUndefined();
    expect(
      parseInbound({
        v: 1,
        type: "viewport",
        payload: { top: 0, height: Number.POSITIVE_INFINITY },
      }),
    ).toBeUndefined();
    expect(
      parseInbound({ v: 1, type: "viewport", payload: { top: "0", height: "640" } }),
    ).toBeUndefined();
    expect(parseInbound({ v: 1, type: "viewport", payload: { top: 0 } })).toBeUndefined();
  });

  it("accepts logout with an empty payload", () => {
    expect(parseInbound({ v: 1, type: "logout", payload: {} })).toEqual({
      v: 1,
      type: "logout",
      payload: {},
    });
    // No payload at all is still malformed: `{v,type,payload}` is the envelope, both ways.
    expect(parseInbound({ v: 1, type: "logout" })).toBeUndefined();
  });
});

/*
 * The compatibility contract (ADR-0040 decision 10). `@fundroom/embed` versions independently
 * of the core and the snippet lives in a CMS page nobody will ever edit again, so a loader
 * newer than the portal it frames is the normal state of the world rather than a fault. A
 * message type this build has never heard of must be a silent no-op — not a throw in a
 * stranger's page, and not a handler for the wrong type.
 */
describe("unknown message types", () => {
  it("are ignored, never thrown, in both the parser and the bridge", () => {
    const future = [
      { v: 1, type: "print", payload: { copies: 2 } },
      { v: 1, type: "esign", payload: { documentId: "abc" } },
      { v: 1, type: "consent-v2", payload: { analytics: true } },
      { v: 1, type: "", payload: {} },
    ];
    for (const msg of future) {
      expect(() => parseInbound(msg)).not.toThrow();
      expect(parseInbound(msg)).toBeUndefined();
    }

    const self = fakeWindow();
    const bridge = createBridge({
      allowedOrigins: ["https://acme.com"],
      targetWindow: { postMessage: vi.fn() },
      self,
      referrer: "https://acme.com/page",
    });
    const onNav = vi.fn();
    const onLogout = vi.fn();
    bridge.on("navigate", onNav);
    bridge.on("logout", onLogout);
    for (const msg of future) {
      expect(() => self.emit("https://acme.com", msg)).not.toThrow();
    }
    expect(onNav).not.toHaveBeenCalled();
    expect(onLogout).not.toHaveBeenCalled();
    // Still working afterwards: an unknown message must not leave the bridge in a bad state.
    self.emit("https://acme.com", { v: 1, type: "logout", payload: {} });
    expect(onLogout).toHaveBeenCalledWith({});
    bridge.destroy();
  });
});

describe("consentGranted", () => {
  it("lets a host CMP turn measurement off but never on over GPC", () => {
    expect(consentGranted({ analytics: true })).toBe(true);
    expect(consentGranted({ analytics: true, gpc: false })).toBe(true);
    expect(consentGranted({ analytics: false })).toBe(false);
    // The whole point: consent reported by the CMP does not beat the browser's own signal.
    expect(consentGranted({ analytics: true, gpc: true })).toBe(false);
    expect(consentGranted({ analytics: false, gpc: true })).toBe(false);
  });
});
