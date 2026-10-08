import { beforeEach, describe, expect, it, vi } from "vitest";

// Wrap the HMAC helper (pass-through) so the test can see it is spent on every path.
vi.mock("./http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./http.js")>();
  return { ...actual, hmacSha256: vi.fn(actual.hmacSha256) };
});

const { hmacSha256 } = await import("./http.js");
const { createVerifyInvestorPort } = await import("./adapter.js");

const rawBody = new TextEncoder().encode('{"verification_request_id":90}');
const port = (webhookSecret?: string) =>
  createVerifyInvestorPort(
    {
      credentials: {
        apiToken: "vi_token_value",
        environment: "staging",
        ...(webhookSecret === undefined ? {} : { webhookSecret }),
      },
    },
    { fetch, now: () => new Date() },
  );

describe("verifyinvestor parseCallback timing", () => {
  beforeEach(() => {
    // Block body: a function returned from beforeEach would run as a teardown hook.
    vi.mocked(hmacSha256).mockClear();
  });

  it("still spends one HMAC over the body when no webhook secret is configured", async () => {
    const headers = new Headers({ "x-signature-sha256": "a".repeat(64) });
    await expect(
      port().parseCallback({ headers, rawBody, now: new Date() }),
    ).resolves.toBeUndefined();
    expect(hmacSha256).toHaveBeenCalledTimes(1);
    expect(vi.mocked(hmacSha256).mock.calls[0]?.[1]).toBe(rawBody);
  });

  it.each([
    ["missing header", new Headers()],
    ["malformed header", new Headers({ "x-signature-sha256": "not-a-signature" })],
    ["oversize header", new Headers({ "x-signature-sha256": "a".repeat(500) })],
  ])("still spends one HMAC on a %s", async (_label, headers) => {
    await expect(
      port("configured-secret").parseCallback({ headers, rawBody, now: new Date() }),
    ).resolves.toBeUndefined();
    expect(hmacSha256).toHaveBeenCalledTimes(1);
  });
});
