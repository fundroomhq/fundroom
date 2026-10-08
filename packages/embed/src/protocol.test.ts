import { describe, expect, it } from "vitest";
import { type ChildMessage, isPortalPath, parseChildMessage } from "./protocol.js";

/*
 * The contract tests design/08 §8 asks for. The one that matters most is the unknown-type case:
 * it is the only thing keeping a loader that a customer pasted into their CMS in 2026 working
 * against a core that learned new message types in 2027.
 */
describe("parseChildMessage", () => {
  it("accepts every v1 child message the frozen protocol defines", () => {
    const cases: ChildMessage[] = [
      { v: 1, type: "ready", payload: { path: "/updates" } },
      { v: 1, type: "resize", payload: { height: 820 } },
      { v: 1, type: "navigate", payload: { path: "/data-room" } },
      { v: 1, type: "auth", payload: { state: "authenticated" } },
      { v: 1, type: "open-external", payload: { url: "https://example.com/x" } },
      { v: 1, type: "event", payload: { name: "document.viewed", data: { id: "doc_1" } } },
      { v: 1, type: "scroll-to", payload: { y: 240 } },
    ];
    for (const message of cases) expect(parseChildMessage(message)).toEqual(message);
  });

  it("ignores an unknown type instead of throwing (forward compatibility)", () => {
    expect(() => parseChildMessage({ v: 1, type: "telemetry", payload: {} })).not.toThrow();
    expect(parseChildMessage({ v: 1, type: "telemetry", payload: {} })).toBeUndefined();
  });

  it("ignores anything that is not a v1 envelope", () => {
    for (const data of [
      undefined,
      null,
      42,
      "ready",
      [],
      {},
      { v: 2, type: "ready", payload: { path: "/" } },
      { v: 1, type: "ready" },
      { v: 1, payload: {} },
      { v: 1, type: "ready", payload: null },
    ]) {
      expect(parseChildMessage(data)).toBeUndefined();
    }
  });

  it("rejects a protocol-relative path, which a browser would read as another origin", () => {
    expect(parseChildMessage({ v: 1, type: "navigate", payload: { path: "//evil.example" } })).toBe(
      undefined,
    );
    expect(
      parseChildMessage({ v: 1, type: "ready", payload: { path: "updates" } }),
    ).toBeUndefined();
    expect(isPortalPath("//evil.example")).toBe(false);
    expect(isPortalPath("/updates")).toBe(true);
  });

  it("rejects a path with a `..` segment, in every spelling the URL parser collapses", () => {
    // Regression: `frameSrc()` concatenates onto `${baseUrl}/embed/<slug>`, so a `..` walks back
    // out of the workspace — `/../../embed/victim` loads another workspace's embed document into
    // this widget, and the parent then posts this workspace's theme, consent and handoff into it.
    for (const path of [
      "/..",
      "/../..",
      "/../../admin",
      "/../../w/acme",
      "/../../embed/victim-workspace",
      "/a/../..",
      "/.%2e/%2e./admin",
      "/%2E%2E/admin",
      "/..\\..\\admin",
      "/..?x=1",
      "/..#frag",
    ]) {
      expect(isPortalPath(path)).toBe(false);
      expect(parseChildMessage({ v: 1, type: "navigate", payload: { path } })).toBeUndefined();
      expect(parseChildMessage({ v: 1, type: "ready", payload: { path } })).toBeUndefined();
    }
    // A segment that merely starts or ends with dots is an ordinary segment, not a traversal.
    for (const path of ["/..foo", "/foo..", "/foo/..bar/baz", "/updates"]) {
      expect(isPortalPath(path)).toBe(true);
    }
  });

  it("rejects a non-http(s) external URL", () => {
    const bad = { v: 1, type: "open-external", payload: { url: "javascript:alert(1)" } };
    expect(parseChildMessage(bad)).toBeUndefined();
    expect(parseChildMessage({ v: 1, type: "open-external", payload: { url: "nope" } })).toBe(
      undefined,
    );
  });

  it("rejects a resize or scroll that is not a finite, non-negative number", () => {
    for (const height of [Number.NaN, Number.POSITIVE_INFINITY, -1, "820", null]) {
      expect(parseChildMessage({ v: 1, type: "resize", payload: { height } })).toBeUndefined();
    }
    expect(parseChildMessage({ v: 1, type: "scroll-to", payload: { y: -1 } })).toBeUndefined();
  });

  it("omits `data` rather than carrying an undefined, and bounds the event name", () => {
    expect(parseChildMessage({ v: 1, type: "event", payload: { name: "x" } })).toEqual({
      v: 1,
      type: "event",
      payload: { name: "x" },
    });
    const long = { v: 1, type: "event", payload: { name: "x".repeat(65) } };
    expect(parseChildMessage(long)).toBeUndefined();
    expect(parseChildMessage({ v: 1, type: "event", payload: { name: "" } })).toBeUndefined();
  });

  it("copies the event payload instead of aliasing the sender's object", () => {
    const data = { id: "doc_1" };
    const parsed = parseChildMessage({ v: 1, type: "event", payload: { name: "e", data } });
    expect(parsed).toEqual({ v: 1, type: "event", payload: { name: "e", data: { id: "doc_1" } } });
    if (parsed?.type !== "event") throw new Error("unreachable");
    expect(parsed.payload.data).not.toBe(data);
  });
});
