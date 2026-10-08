import type { OutboundHttpPort } from "@fundroom/ports";
import { OutboundHttpError } from "@fundroom/ports";
import { describe, expect, it, vi } from "vitest";
import { createUpdateChecker, FAILURE_TTL_MS, SUCCESS_TTL_MS } from "./checker.js";

const URL_ = "https://releases.fundroom.com/index.json";

const INDEX = {
  schemaVersion: 1,
  latest: "1.4.2",
  releases: [
    {
      version: "1.4.2",
      date: "2026-10-01",
      url: "https://github.com/fundroomhq/fundroom/releases/tag/v1.4.2",
      security: false,
      summary: "Bug fixes",
    },
    {
      version: "1.4.1",
      date: "2026-09-20",
      url: "https://github.com/fundroomhq/fundroom/releases/tag/v1.4.1",
      security: true,
    },
  ],
};

function harness(
  respond: () => Response | Promise<Response> = () => Response.json(INDEX),
  over: { enabled?: boolean; currentVersion?: string; url?: string } = {},
) {
  let t = Date.parse("2026-10-02T12:00:00.000Z");
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return respond();
  });
  const http: OutboundHttpPort = { fetch };
  const log = vi.fn();
  const checker = createUpdateChecker({
    enabled: over.enabled ?? true,
    url: over.url ?? URL_,
    currentVersion: over.currentVersion ?? "1.4.0",
    http,
    clock: () => new Date(t),
    log,
  });
  return {
    checker,
    fetch,
    calls,
    log,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createUpdateChecker", () => {
  it("reports a security release newer than this build", async () => {
    const h = harness();
    expect(await h.checker.check()).toEqual({
      status: "security_update",
      currentVersion: "1.4.0",
      latestVersion: "1.4.2",
      checkedAt: "2026-10-02T12:00:00.000Z",
      releaseUrl: "https://github.com/fundroomhq/fundroom/releases/tag/v1.4.2",
      securityReleases: ["1.4.1"],
    });
  });

  it("a development build is unknown", async () => {
    const h = harness(undefined, { currentVersion: "0.0.0" });
    expect((await h.checker.check()).status).toBe("unknown");
  });

  it("sends a bare GET: no query, fragment, credentials, cookies or identifying headers", async () => {
    const h = harness(undefined, { url: `${URL_}?instance=abc#frag` });
    await h.checker.check();
    expect(h.calls).toHaveLength(1);
    const [call] = h.calls;
    expect(call?.url).toBe(URL_);
    expect(call?.init?.method).toBe("GET");
    expect(call?.init?.credentials).toBe("omit");
    const headers = new Headers(call?.init?.headers);
    expect([...headers.keys()]).toEqual(["accept"]);
    expect(call?.init?.body).toBeUndefined();
  });

  it("caches a success for 12 hours", async () => {
    const h = harness();
    await h.checker.check();
    h.advance(SUCCESS_TTL_MS - 1);
    await h.checker.check();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.advance(2);
    await h.checker.check();
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("caches a failure for 1 hour", async () => {
    const h = harness(() => new Response("nope", { status: 503 }));
    expect(await h.checker.check()).toEqual({
      status: "error",
      currentVersion: "1.4.0",
      checkedAt: "2026-10-02T12:00:00.000Z",
    });
    h.advance(FAILURE_TTL_MS - 1);
    await h.checker.check();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.advance(2);
    await h.checker.check();
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(h.log).toHaveBeenCalledWith("update_check.failed", {
      level: "warn",
      reason: "index answered HTTP 503",
    });
  });

  it("is single-flight", async () => {
    let release: (r: Response) => void = () => {};
    const h = harness(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        }),
    );
    const all = Promise.all([h.checker.check(), h.checker.check(), h.checker.check()]);
    await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
    release(Response.json(INDEX));
    const results = await all;
    expect(new Set(results.map((r) => r.status))).toEqual(new Set(["security_update"]));
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("a malformed, oversized or unreachable index is an error, never a throw", async () => {
    const bodies: (() => Response | Promise<Response>)[] = [
      () => new Response("<html>502</html>", { status: 200 }),
      () => Response.json({ ...INDEX, latest: "1.4.9" }),
      () => new Response("x", { headers: { "content-length": String(10 * 1024 * 1024) } }),
      () => new Response(" ".repeat(256 * 1024 + 1)),
      () => {
        throw new OutboundHttpError("timeout", "timed out");
      },
      () => {
        throw new OutboundHttpError("response_too_large", "too large");
      },
      () => {
        throw new TypeError("fetch failed");
      },
    ];
    for (const [i, respond] of bodies.entries()) {
      const h = harness(respond);
      const status = await h.checker.check();
      expect(status.status, `case ${i}`).toBe("error");
      expect(h.log, `case ${i}`).toHaveBeenCalledWith(
        "update_check.failed",
        expect.objectContaining({ level: "warn" }),
      );
    }
  });

  it("disabled never fetches and needs no http", async () => {
    const h = harness(undefined, { enabled: false });
    expect(await h.checker.check()).toEqual({
      status: "disabled",
      reason: "opted_out",
      currentVersion: "1.4.0",
    });
    expect(h.fetch).not.toHaveBeenCalled();
    const bare = createUpdateChecker({ enabled: false, url: URL_, currentVersion: "1.4.0" });
    expect((await bare.check()).status).toBe("disabled");
    expect(() =>
      createUpdateChecker({ enabled: true, url: URL_, currentVersion: "1.4.0" }),
    ).toThrow(/http/u);
  });
});
