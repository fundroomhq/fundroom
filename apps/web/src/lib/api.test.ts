import { FundRoomApiError } from "@fundroom/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installMockApi } from "../test/mock-api.js";
import {
  ApiFailure,
  api,
  authRedirectFor,
  call,
  configureApi,
  describeError,
  requestUuid,
  safeReturnTo,
} from "./api.js";

afterEach(() => vi.unstubAllGlobals());

describe("call()", () => {
  it("returns data on 2xx and throws ApiFailure with Retry-After on errors", async () => {
    installMockApi({
      "GET /api/v1/me/sessions": () => [200, { sessions: [] }],
      "POST /api/v1/auth/otp/start": () =>
        new Response(JSON.stringify({ error: { code: "rate_limited", message: "slow" } }), {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "17",
            "x-request-id": "r1",
          },
        }),
    });
    configureApi("http://localhost");
    await expect(call(api().GET("/me/sessions"))).resolves.toEqual({ sessions: [] });
    const error = await call(api().POST("/auth/otp/start", { body: { email: "a@b.co" } })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ApiFailure);
    const f = error as ApiFailure;
    expect(f.code).toBe("rate_limited");
    expect(f.retryAfterSeconds).toBe(17);
    expect(f.requestId).toBe("r1");
    expect(describeError(f).body).toContain("17");
  });
  it("maps network failures to service_unavailable", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("boom")));
    configureApi("http://localhost");
    const error = await call(api().GET("/me")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiFailure);
    expect((error as ApiFailure).code).toBe("service_unavailable");
  });
});

describe("request ids (E2.10 ZAP-03)", () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

  it("still sends a v4 X-Request-Id on an insecure origin, where crypto.randomUUID is absent", async () => {
    const real = globalThis.crypto;
    // What a plain-http, non-localhost page sees: getRandomValues only.
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    const seen: string[] = [];
    vi.stubGlobal("fetch", (input: Request) => {
      seen.push(input.headers.get("x-request-id") ?? "");
      return Promise.resolve(
        new Response(JSON.stringify({ sessions: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    configureApi("http://portal.test");
    await expect(call(api().GET("/me/sessions"))).resolves.toEqual({ sessions: [] });
    await call(api().GET("/me/sessions"));
    expect(seen).toHaveLength(2);
    for (const id of seen) expect(id).toMatch(UUID_V4);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it("uses crypto.randomUUID when the context has it", () => {
    const spy = vi.spyOn(globalThis.crypto, "randomUUID");
    expect(requestUuid()).toMatch(UUID_V4);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe("authRedirectFor", () => {
  const err = (code: string, extra: Record<string, unknown> = {}) =>
    new ApiFailure(
      new FundRoomApiError(401, { error: { code: code as never, message: code, ...extra } }, "r"),
      undefined,
    );
  it("routes unauthenticated to login and step-up with reason", () => {
    expect(authRedirectFor(err("unauthenticated"), "/settings")).toEqual({
      to: "/login",
      search: { returnTo: "/settings" },
    });
    expect(authRedirectFor(err("step_up_required", { reason: "fresh" }), "/x")).toEqual({
      to: "/auth/step-up",
      search: { returnTo: "/x", reason: "fresh" },
    });
    expect(authRedirectFor(err("not_found"), "/x")).toBeUndefined();
    expect(authRedirectFor(new Error("x"), "/x")).toBeUndefined();
  });
});

describe("safeReturnTo", () => {
  it("only accepts same-origin paths", () => {
    expect(safeReturnTo("/updates?x=1")).toBe("/updates?x=1");
    expect(safeReturnTo("https://evil.test")).toBe("/");
    expect(safeReturnTo("//evil.test")).toBe("/");
    expect(safeReturnTo("/\\evil.test")).toBe("/");
    expect(safeReturnTo(undefined, "/admin")).toBe("/admin");
  });

  it("keeps ordinary paths, query and fragment (normalised)", () => {
    expect(safeReturnTo("/")).toBe("/");
    expect(safeReturnTo("/admin/people?tab=staff#top")).toBe("/admin/people?tab=staff#top");
    expect(safeReturnTo("/a/./b/../c")).toBe("/a/c");
    expect(safeReturnTo("/a?b=//c")).toBe("/a?b=//c");
  });

  // Mirrors apps/server/src/routes/auth.test.ts (`safeReturnPath`): the same values the OIDC
  // callback refuses must not become a client-side navigation either (F-02, P2 note).
  it("refuses everything a browser could resolve to another origin", () => {
    for (const raw of [
      "//evil.com",
      "/\\evil.com",
      "/\\/evil.com",
      "/\t/evil.com",
      "/\n/evil.com",
      "/\r/evil.com",
      "/ /evil.com",
      "/\u00a0/evil.com",
      "/\u200b/evil.com",
      "/\u0000/evil.com",
      "/\u007f/evil.com",
      "/%5Cevil.com",
      "/%5cevil.com",
      "/%2F/evil.com",
      "/.//evil.com",
      "/./\\evil.com",
      "https://evil.com",
      "evil.com",
      "javascript:alert(1)",
      `/${"a".repeat(2048)}`,
    ]) {
      expect(safeReturnTo(raw), JSON.stringify(raw)).toBe("/");
    }
  });

  it("refuses an encoded slash or backslash in the first segment after normalisation (R1-06)", () => {
    for (const raw of ["/./%2Fevil.com", "/a/%2e%2e/%2fevil.com", "/./%5Cevil.com"]) {
      expect(safeReturnTo(raw), JSON.stringify(raw)).toBe("/");
    }
    expect(safeReturnTo("/docs/a%2Fb")).toBe("/docs/a%2Fb");
  });

  it("every accepted value stays on the origin when navigated to", () => {
    const origin = "https://investors.acme.test";
    for (const raw of [
      "/admin",
      "/a?b=//c",
      "/x#//y",
      "/%2e%2e/x",
      "/.//evil.com",
      "/..//evil.com",
    ]) {
      expect(new URL(safeReturnTo(raw), origin).origin).toBe(origin);
    }
  });
});

describe("describeError", () => {
  it("gives generic copy for unknown errors and never leaks messages", () => {
    const d = describeError(new Error("secret internal detail"));
    expect(d.body).not.toContain("secret");
    expect(d.requestId).toBeUndefined();
  });

  it("explains a refused password when the breach check is unavailable (E3.2 F-21)", () => {
    const d = describeError(
      new FundRoomApiError(
        503,
        { error: { code: "breach_check_unavailable", message: "hibp down" } } as never,
        "r9",
      ),
    );
    expect(d.title).toBe("Password check unavailable");
    expect(d.body).toMatch(/try again/iu);
    expect(d.body).not.toContain("hibp");
    expect(d.requestId).toBe("r9");
  });
});
