import { describeAccreditationPortContract } from "@fundroom/accreditation/testing";
import { AccreditationProviderError, OutboundHttpError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  createVerifyInvestorPort,
  mapVerifyInvestorStatus,
  parseVerifiedExpiresAt,
  verifyInvestorAdapter,
} from "./adapter.js";
import { startFakeVerifyInvestor } from "./testing/fake-server.js";
import {
  createFakeVerifyInvestor,
  type FakeVerifyInvestorOptions,
  fakeFetch,
  fakePdf,
} from "./testing/fake-vendor.js";

const BASE = "https://vi.test";
const SECRET = "vi-webhook-secret-contract";

function scripted(
  options: {
    token?: string;
    webhookSecret?: string | null;
    portalName?: string;
    fake?: Omit<FakeVerifyInvestorOptions, "webhookSecret">;
  } = {},
) {
  const fake = createFakeVerifyInvestor({ webhookSecret: SECRET, ...options.fake });
  const credentials: Record<string, string> = {
    apiToken: options.token ?? fake.vendor.apiToken,
    environment: "staging",
  };
  if (options.webhookSecret !== null)
    credentials["webhookSecret"] = options.webhookSecret ?? SECRET;
  if (options.portalName !== undefined) credentials["portalName"] = options.portalName;
  const port = createVerifyInvestorPort(
    { credentials },
    { fetch: fakeFetch(fake.handle), now: () => new Date(), apiBaseUrl: BASE },
  );
  return { port, vendor: fake.vendor, credentials };
}

const INVALID_TOKEN = "vi_wrong_token_abcdef";

describeAccreditationPortContract(
  "verifyinvestor (scripted fetch)",
  async ({ credentials, callbackSecret }) => {
    const env = scripted({
      ...(credentials === "invalid" ? { token: INVALID_TOKEN } : {}),
      ...(callbackSecret === false ? { webhookSecret: null } : {}),
    });
    return {
      port: env.port,
      vendor: env.vendor,
      secrets: [env.credentials["apiToken"] ?? "", SECRET],
      cleanup: async () => {},
    };
  },
  { callbackTimestamp: false },
);

describeAccreditationPortContract(
  "verifyinvestor (real HTTP fake server)",
  async ({ credentials, callbackSecret }) => {
    const server = await startFakeVerifyInvestor({ webhookSecret: SECRET });
    const token = credentials === "invalid" ? INVALID_TOKEN : server.vendor.apiToken;
    const port = verifyInvestorAdapter.create(
      {
        credentials: {
          apiToken: token,
          environment: "staging",
          ...(callbackSecret === false ? {} : { webhookSecret: SECRET }),
        },
      },
      // Tests only: the kernel injects the SSRF-guarded client here.
      { fetch: globalThis.fetch, now: () => new Date(), apiBaseUrl: server.url },
    );
    return {
      port,
      vendor: server.vendor,
      secrets: [token, SECRET],
      cleanup: () => server.close(),
    };
  },
  { callbackTimestamp: false },
);

describe("verifyinvestor status mapping", () => {
  it.each([
    ["waiting_for_investor_acceptance", "needs_investor_action"],
    ["accepted_by_investor", "in_progress"],
    ["waiting_for_review", "under_review"],
    ["in_review", "under_review"],
    ["waiting_for_information_from_investor", "needs_investor_action"],
    ["accredited", "accredited"],
    ["not_accredited", "not_accredited"],
    ["accepted_expire", "canceled"],
    ["declined_expire", "canceled"],
    ["declined_by_investor", "canceled"],
    ["self_not_accredited", "canceled"],
    ["something_new", "unknown"],
  ])("%s → %s", (raw, mapped) => {
    expect(mapVerifyInvestorStatus(raw)).toBe(mapped);
  });

  it("treats verified_expires_at as the end of that UTC day", () => {
    expect(parseVerifiedExpiresAt("2027-03-14")?.toISOString()).toBe("2027-03-14T23:59:59.999Z");
    expect(parseVerifiedExpiresAt("2027-03-14T10:00:00Z")?.toISOString()).toBe(
      "2027-03-14T10:00:00.000Z",
    );
    expect(parseVerifiedExpiresAt(null)).toBeUndefined();
    expect(parseVerifiedExpiresAt("soon")).toBeUndefined();
  });

  it("reports waiting_for_info under review as needing the investor", async () => {
    const { port, vendor } = scripted({ fake: { existingInvestors: ["ada@example.com"] } });
    const { providerRef } = await port.start({
      verificationId: "v1",
      subject: "individual",
      email: "ada@example.com",
    });
    vendor.setStatus(providerRef, "in_review", { waitingForInfo: true });
    await expect(port.check({ providerRef })).resolves.toMatchObject({
      status: "needs_investor_action",
      vendorStatus: "in_review",
    });
  });
});

describe("verifyinvestor start", () => {
  it("posts one 'ai' invitation with the configured portal name and a suggested legal name", async () => {
    const { port, vendor } = scripted({ portalName: "Configured Portal" });
    const result = await port.start({
      verificationId: "v1",
      subject: "individual",
      email: "ada@example.com",
      firstName: "Ada",
      lastName: "Lovelace",
      portalName: "Workspace Name",
    });
    expect(result).toEqual({
      providerRef: expect.stringMatching(/^inv:\d+$/u),
      handoff: { kind: "invite_sent" },
      vendorStatus: "invitation_sent",
    });
    expect(vendor.invitations()).toEqual([
      {
        portal_name: "Configured Portal",
        investors: [{ email: "ada@example.com", suggested_legal_name: "Ada Lovelace", type: "ai" }],
      },
    ]);
    const auth = vendor.requests.map((r) => r.authorization);
    expect(auth.every((a) => a === `Token ${vendor.apiToken}`)).toBe(true);
  });

  it("falls back to the workspace portal name and prefers the legal name", async () => {
    const { port, vendor } = scripted();
    await port.start({
      verificationId: "v1",
      subject: "entity",
      email: "cfo@acme.example",
      firstName: "Ada",
      legalName: "Acme Holdings LLC",
      portalName: "Workspace Name",
    });
    expect(vendor.invitations()[0]).toMatchObject({
      portal_name: "Workspace Name",
      investors: [{ suggested_legal_name: "Acme Holdings LLC" }],
    });
  });

  it("answers a vr: ref at once when the investor already has an account", async () => {
    const { port } = scripted({ fake: { existingInvestors: ["ada@example.com"] } });
    const { providerRef } = await port.start({
      verificationId: "v1",
      subject: "individual",
      email: "ada@example.com",
    });
    expect(providerRef).toMatch(/^vr:\d+$/u);
    await expect(port.check({ providerRef })).resolves.toMatchObject({
      status: "needs_investor_action",
      vendorStatus: "waiting_for_investor_acceptance",
    });
  });

  it("refuses an empty email without calling the vendor", async () => {
    const { port, vendor } = scripted();
    await expect(
      port.start({ verificationId: "v1", subject: "individual", email: "  " }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(vendor.requests).toHaveLength(0);
  });

  it("maps a 422 to invalid_request with the vendor's sanitised message", async () => {
    const { port } = scripted();
    const err = await port
      .start({ verificationId: "v1", subject: "individual", email: "not-an-email" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccreditationProviderError);
    expect(err).toMatchObject({ code: "invalid_request", retryable: false, status: 422 });
    expect((err as Error).message).toContain("Invalid email address");
  });
});

describe("verifyinvestor check", () => {
  it("keeps an unanswered invitation pending, then upgrades inv: → vr:", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.start({
      verificationId: "v1",
      subject: "individual",
      email: "ada@example.com",
    });
    await expect(port.check({ providerRef })).resolves.toEqual({
      status: "needs_investor_action",
      vendorStatus: "invitation_sent",
    });
    const vr = vendor.signUp(providerRef);
    await expect(port.check({ providerRef })).resolves.toMatchObject({
      providerRef: vr,
      status: "needs_investor_action",
      vendorStatus: "waiting_for_investor_acceptance",
    });
    await expect(port.check({ providerRef: vr })).resolves.not.toHaveProperty("providerRef");
  });

  it("reports only decision dates for decisions", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.start({
      verificationId: "v1",
      subject: "individual",
      email: "ada@example.com",
    });
    vendor.accredit(providerRef, { expiresAt: new Date("2027-01-31T08:00:00Z") });
    const check = await port.check({ providerRef });
    expect(check.expiresAt?.toISOString()).toBe("2027-01-31T23:59:59.999Z");
    expect(check.assertion).toBeUndefined();
  });

  it("uses the environment's fixed API root unless a test base is given", async () => {
    const seen: string[] = [];
    const capture = (async (input: string | URL | Request) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    for (const environment of ["staging", "production"]) {
      await createVerifyInvestorPort(
        { credentials: { apiToken: "t0ken-value", environment } },
        { fetch: capture, now: () => new Date("2026-09-26T00:00:00Z") },
      ).verifyCredentials();
    }
    expect(seen).toEqual([
      "https://verifyinvestor-staging.herokuapp.com/api/v1/billing?from_date=2026-09-26&to_date=2026-09-26",
      "https://www.verifyinvestor.com/api/v1/billing?from_date=2026-09-26&to_date=2026-09-26",
    ]);
  });

  it("falls back to the API root when the billing endpoint is not enabled", async () => {
    const { port, vendor } = scripted({ fake: { billingDisabled: true } });
    await expect(port.verifyCredentials()).resolves.toBeUndefined();
    expect(vendor.requests.map((r) => new URL(r.url).pathname)).toEqual([
      "/api/v1/billing",
      "/api/v1",
    ]);
  });

  it("maps guard refusals and redirects without retry storms", async () => {
    const refuse = (async () => {
      throw new OutboundHttpError("blocked_address", "blocked");
    }) as typeof fetch;
    const port = createVerifyInvestorPort(
      { credentials: { apiToken: "t0ken-value", environment: "staging" } },
      { fetch: refuse, now: () => new Date() },
    );
    await expect(port.check({ providerRef: "vr:1" })).rejects.toMatchObject({
      code: "unavailable",
      retryable: false,
    });
    const redirect = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://evil.test" },
      })) as typeof fetch;
    const port2 = createVerifyInvestorPort(
      { credentials: { apiToken: "t0ken-value", environment: "staging" } },
      { fetch: redirect, now: () => new Date() },
    );
    await expect(port2.check({ providerRef: "vr:1" })).rejects.toMatchObject({
      code: "unavailable",
      retryable: false,
    });
    const timeout = (async () => {
      throw new OutboundHttpError("timeout", "slow");
    }) as typeof fetch;
    const port3 = createVerifyInvestorPort(
      { credentials: { apiToken: "t0ken-value", environment: "staging" } },
      { fetch: timeout, now: () => new Date() },
    );
    await expect(port3.check({ providerRef: "vr:1" })).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
  });

  it("never echoes the token even when the vendor reflects it", async () => {
    const token = "vi_secret_token_reflected";
    const reflect = (async () =>
      new Response(JSON.stringify({ error: `bad request for Token ${token}` }), {
        status: 400,
      })) as typeof fetch;
    const port = createVerifyInvestorPort(
      { credentials: { apiToken: token, environment: "staging" } },
      { fetch: reflect, now: () => new Date() },
    );
    const err = (await port.check({ providerRef: "vr:1" }).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(token);
    expect(err.message).toContain("[redacted]");
  });
});

describe("verifyinvestor fetchEvidence", () => {
  const accredited = async (fake?: Omit<FakeVerifyInvestorOptions, "webhookSecret">) => {
    const env = scripted(fake === undefined ? {} : { fake });
    const { providerRef } = await env.port.start({
      verificationId: "v1",
      subject: "individual",
      email: "ada@example.com",
    });
    env.vendor.accredit(providerRef);
    return { ...env, providerRef };
  };

  it("downloads the certificate for the request's investor, even from an inv: ref", async () => {
    const { port, vendor, providerRef } = await accredited();
    const evidence = await port.fetchEvidence({ providerRef });
    expect(evidence?.contentType).toBe("application/pdf");
    const cert = vendor.requests.find((r) => r.url.endsWith("/certificate"));
    expect(new URL(cert?.url ?? "").pathname).toMatch(
      /^\/api\/v1\/users\/\d+\/verification_requests\/\d+\/certificate$/u,
    );
  });

  it("answers null when the vendor has no certificate (404)", async () => {
    const { port, vendor, providerRef } = await accredited();
    vendor.setCertificate(null);
    await expect(port.fetchEvidence({ providerRef })).resolves.toBeNull();
  });

  it("refuses a non-PDF or oversize certificate", async () => {
    const { port, vendor, providerRef } = await accredited();
    vendor.setCertificate(new TextEncoder().encode("<html>nope</html>"));
    await expect(port.fetchEvidence({ providerRef })).rejects.toMatchObject({
      code: "unavailable",
    });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(fakePdf("x").slice(0, 8));
    vendor.setCertificate(big);
    await expect(port.fetchEvidence({ providerRef })).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("verifyinvestor parseCallback", () => {
  it("accepts a base64 signature as well as hex", async () => {
    const fake = createFakeVerifyInvestor({ webhookSecret: SECRET, signatureEncoding: "base64" });
    const port = createVerifyInvestorPort(
      {
        credentials: {
          apiToken: fake.vendor.apiToken,
          webhookSecret: SECRET,
          environment: "staging",
        },
      },
      { fetch: fakeFetch(fake.handle), now: () => new Date(), apiBaseUrl: BASE },
    );
    const { providerRef } = await port.start({
      verificationId: "v1",
      subject: "individual",
      email: "ada@example.com",
    });
    const vr = fake.vendor.signUp(providerRef);
    await expect(
      port.parseCallback({ ...fake.vendor.callback([vr]), now: new Date() }),
    ).resolves.toEqual({ refs: [vr] });
  });

  it("returns no refs for an authentic body without a request id", async () => {
    const { port } = scripted();
    const rawBody = new TextEncoder().encode('{"action":"ping"}');
    const { createHmac } = await import("node:crypto");
    const headers = new Headers({
      "x-signature-sha256": createHmac("sha256", SECRET).update(rawBody).digest("hex"),
    });
    await expect(port.parseCallback({ headers, rawBody, now: new Date() })).resolves.toEqual({
      refs: [],
    });
  });
});

describe.each(["scripted fetch", "real HTTP fake server"] as const)(
  "verifyinvestor lapsed invitations (%s)",
  (mode) => {
    const env = async () => {
      if (mode === "scripted fetch") {
        const s = scripted();
        return { port: s.port, vendor: s.vendor, close: async () => {} };
      }
      const server = await startFakeVerifyInvestor({ webhookSecret: SECRET });
      const port = verifyInvestorAdapter.create(
        {
          credentials: {
            apiToken: server.vendor.apiToken,
            webhookSecret: SECRET,
            environment: "staging",
          },
        },
        { fetch: globalThis.fetch, now: () => new Date(), apiBaseUrl: server.url },
      );
      return { port, vendor: server.vendor, close: () => server.close() };
    };
    const input = {
      verificationId: "v1",
      subject: "individual",
      email: "ada@example.com",
    } as const;

    it.each(["gone", "aged"] as const)(
      "maps an invitation that lapsed (%s) to canceled / invitation_expired",
      async (how) => {
        const { port, vendor, close } = await env();
        try {
          const { providerRef } = await port.start(input);
          expect(providerRef).toMatch(/^inv:/u);
          vendor.expireInvitation(providerRef, how);
          await expect(port.check({ providerRef })).resolves.toEqual({
            status: "canceled",
            vendorStatus: "invitation_expired",
          });
          await expect(port.fetchEvidence({ providerRef })).resolves.toBeNull();
        } finally {
          await close();
        }
      },
    );

    it("an old invitation the investor did answer still follows its request", async () => {
      const { port, vendor, close } = await env();
      try {
        const { providerRef } = await port.start(input);
        const vr = vendor.signUp(providerRef);
        vendor.expireInvitation(providerRef, "aged");
        await expect(port.check({ providerRef })).resolves.toMatchObject({
          providerRef: vr,
          status: "needs_investor_action",
        });
      } finally {
        await close();
      }
    });
  },
);
