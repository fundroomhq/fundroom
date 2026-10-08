import { afterEach, describe, expect, it, vi } from "vitest";
import { createFundRoomClient, FundRoomApiError, isErrorBody, unwrap } from "./index.js";

describe("createFundRoomClient", () => {
  it("prefixes /api/v1, sends cookies and a request id", async () => {
    const seen: Request[] = [];
    const client = createFundRoomClient({
      origin: "https://investors.acme.test/",
      requestId: () => "rid-1",
      fetch: async (req) => {
        seen.push(req);
        return new Response(JSON.stringify({ providers: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const { data, response } = await client.GET("/auth/oidc/providers");
    expect(response.status).toBe(200);
    expect(data).toEqual({ providers: [] });
    expect(seen[0]?.url).toBe("https://investors.acme.test/api/v1/auth/oidc/providers");
    expect(seen[0]?.credentials).toBe("include");
    expect(seen[0]?.headers.get("x-request-id")).toBe("rid-1");
  });

  it("types request bodies from the contract and unwraps envelopes", async () => {
    const client = createFundRoomClient({
      origin: "https://investors.acme.test",
      fetch: async () =>
        new Response(
          JSON.stringify({ error: { code: "invalid_code", message: "nope", requestId: "r9" } }),
          { status: 400, headers: { "content-type": "application/json", "x-request-id": "r9" } },
        ),
    });
    const result = await client.POST("/auth/otp/verify", {
      body: { email: "ada@example.com", code: "123456" },
    });
    expect(isErrorBody(result.error)).toBe(true);
    expect(() => unwrap(result)).toThrow(FundRoomApiError);
    try {
      unwrap(result);
    } catch (e) {
      const err = e as FundRoomApiError;
      expect(err.code).toBe("invalid_code");
      expect(err.status).toBe(400);
      expect(err.requestId).toBe("r9");
    }
  });
});

describe("createFundRoomClient({ apiKey })", () => {
  const KEY = `frk_${"A".repeat(40)}b-_`;
  const ok = () =>
    new Response(JSON.stringify({ items: [], nextCursor: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends Authorization: Bearer and no cookies", async () => {
    const seen: Request[] = [];
    const client = createFundRoomClient({
      origin: "https://investors.acme.test",
      apiKey: KEY,
      requestId: () => "rid-2",
      // An explicit "include" is overridden: a key request must not carry the session cookie.
      credentials: "include",
      fetch: async (req) => {
        seen.push(req);
        return ok();
      },
    });
    await client.GET("/webhooks/deliveries", {});
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(seen[0]?.credentials).toBe("omit");
    expect(seen[0]?.headers.get("x-request-id")).toBe("rid-2");
  });

  it("keeps the cookie behaviour without a key", async () => {
    const seen: Request[] = [];
    const client = createFundRoomClient({
      fetch: async (req) => {
        seen.push(req);
        return ok();
      },
      origin: "https://investors.acme.test",
    });
    await client.GET("/webhooks/deliveries", {});
    expect(seen[0]?.headers.get("authorization")).toBeNull();
    expect(seen[0]?.credentials).toBe("include");
  });

  it("refuses something that is not a key, without echoing it", () => {
    expect(() => createFundRoomClient({ apiKey: "whsec_notakey" })).toThrow(TypeError);
    expect(() => createFundRoomClient({ apiKey: "whsec_notakey" })).not.toThrow(/whsec_notakey/u);
    expect(() => createFundRoomClient({ apiKey: `${KEY}x` })).toThrow(TypeError);
    // A-2: a key created before the FundRoom rename (`shk_`) is still a key; nothing else is.
    expect(() =>
      createFundRoomClient({ apiKey: `shk_${KEY.slice(4)}`, fetch: async () => ok() }),
    ).not.toThrow();
    expect(() => createFundRoomClient({ apiKey: `frs_${KEY.slice(4)}` })).toThrow(TypeError);
    expect(() => createFundRoomClient({ apiKey: `FRK_${KEY.slice(4)}` })).toThrow(TypeError);
  });

  it("refuses a key in a browser unless dangerouslyAllowBrowser", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {});
    expect(() => createFundRoomClient({ apiKey: KEY })).toThrow(/browser/u);
    expect(() =>
      createFundRoomClient({ apiKey: KEY, dangerouslyAllowBrowser: true }),
    ).not.toThrow();
    // Session clients (the SPA) are unaffected.
    expect(() => createFundRoomClient({})).not.toThrow();
  });
});
