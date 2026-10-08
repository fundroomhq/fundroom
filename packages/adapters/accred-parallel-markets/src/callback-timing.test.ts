import { beforeEach, describe, expect, it, vi } from "vitest";

// Wrap the HMAC helper (pass-through) so the test can see it is spent on every path.
vi.mock("./http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http.js")>();
  return { ...actual, hmacSha256: vi.fn(actual.hmacSha256) };
});

const { hmacSha256 } = await import("./http.js");
const { createParallelMarketsPort } = await import("./adapter.js");

const rawBody = new TextEncoder().encode('{"entity":{"id":"VXNlcjox","type":"individual"}}');
const KEY = Buffer.from("parallel-timing-signing-key-0123456").toString("base64");
const port = (webhookSigningKey?: string) =>
  createParallelMarketsPort(
    {
      credentials: {
        apiKey: "pm_key_value",
        clientId: "c",
        environment: "demo",
        ...(webhookSigningKey === undefined ? {} : { webhookSigningKey }),
      },
    },
    { fetch, now: () => new Date() },
  );
const ts = () => String(Math.floor(Date.now() / 1000));

describe("parallel-markets parseCallback timing", () => {
  beforeEach(() => {
    // Block body: a function returned from beforeEach would run as a teardown hook.
    vi.mocked(hmacSha256).mockClear();
  });

  it("still spends one HMAC over timestamp + body when no signing key is configured", async () => {
    const headers = new Headers({
      "parallel-timestamp": ts(),
      "parallel-signature": `${"A".repeat(43)}=`,
    });
    await expect(
      port().parseCallback({ headers, rawBody, now: new Date() }),
    ).resolves.toBeUndefined();
    expect(hmacSha256).toHaveBeenCalledTimes(1);
    const message = vi.mocked(hmacSha256).mock.calls[0]?.[1] as Uint8Array;
    expect(Buffer.from(message).subarray(-rawBody.byteLength)).toEqual(Buffer.from(rawBody));
  });

  it.each([
    ["missing headers", () => new Headers()],
    [
      "malformed timestamp",
      () =>
        new Headers({
          "parallel-timestamp": "yesterday",
          "parallel-signature": `${"A".repeat(43)}=`,
        }),
    ],
    [
      "malformed signature",
      () => new Headers({ "parallel-timestamp": ts(), "parallel-signature": "!!" }),
    ],
  ])("still spends one HMAC on %s", async (_label, headers) => {
    await expect(
      port(KEY).parseCallback({ headers: headers(), rawBody, now: new Date() }),
    ).resolves.toBeUndefined();
    expect(hmacSha256).toHaveBeenCalledTimes(1);
  });
});
