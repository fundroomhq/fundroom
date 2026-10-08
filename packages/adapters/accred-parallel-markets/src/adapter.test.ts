import { createHmac } from "node:crypto";
import { describeAccreditationPortContract } from "@fundroom/accreditation/testing";
import { describe, expect, it } from "vitest";
import {
  createParallelMarketsPort,
  mapParallelStatus,
  parallelMarketsAdapter,
  pickAccreditation,
} from "./adapter.js";
import { startFakeParallelMarkets } from "./testing/fake-server.js";
import {
  createFakeParallelMarkets,
  type FakeParallelMarketsOptions,
  fakeFetch,
  fakePdf,
} from "./testing/fake-vendor.js";

const BASE = "https://pm.test";
const SIGNING_KEY = Buffer.from("parallel-contract-signing-key-0123").toString("base64");
const INVALID_KEY = "pm_wrong_api_key_abcdef";

function scripted(
  options: {
    apiKey?: string;
    signingKey?: string | null;
    now?: () => Date;
    fake?: Omit<FakeParallelMarketsOptions, "baseUrl" | "webhookSigningKey" | "now">;
  } = {},
) {
  const now = options.now ?? (() => new Date());
  const fake = createFakeParallelMarkets({
    baseUrl: BASE,
    webhookSigningKey: SIGNING_KEY,
    now,
    ...options.fake,
  });
  const credentials: Record<string, string> = {
    apiKey: options.apiKey ?? fake.vendor.apiKey,
    clientId: "client_abc",
    environment: "demo",
  };
  if (options.signingKey !== null)
    credentials["webhookSigningKey"] = options.signingKey ?? SIGNING_KEY;
  const fetch = fakeFetch(fake.handle);
  const port = createParallelMarketsPort({ credentials }, { fetch, now, apiBaseUrl: BASE });
  return { port, vendor: fake.vendor, credentials, fetch };
}

const individual = {
  verificationId: "v1",
  subject: "individual",
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
} as const;

describeAccreditationPortContract(
  "parallel-markets (scripted fetch)",
  async ({ credentials, callbackSecret }) => {
    const env = scripted({
      ...(credentials === "invalid" ? { apiKey: INVALID_KEY } : {}),
      ...(callbackSecret === false ? { signingKey: null } : {}),
    });
    return {
      port: env.port,
      vendor: env.vendor,
      secrets: [env.credentials["apiKey"] ?? "", SIGNING_KEY],
      cleanup: async () => {},
    };
  },
  { callbackTimestamp: true },
);

describeAccreditationPortContract(
  "parallel-markets (real HTTP fake server)",
  async ({ credentials, callbackSecret }) => {
    const server = await startFakeParallelMarkets({ webhookSigningKey: SIGNING_KEY });
    const apiKey = credentials === "invalid" ? INVALID_KEY : server.vendor.apiKey;
    const port = parallelMarketsAdapter.create(
      {
        credentials: {
          apiKey,
          clientId: "client_abc",
          environment: "demo",
          ...(callbackSecret === false ? {} : { webhookSigningKey: SIGNING_KEY }),
        },
      },
      // Tests only: the kernel injects the SSRF-guarded client here.
      { fetch: globalThis.fetch, now: () => new Date(), apiBaseUrl: server.url },
    );
    return {
      port,
      vendor: server.vendor,
      secrets: [apiKey, SIGNING_KEY],
      cleanup: () => server.close(),
    };
  },
  { callbackTimestamp: true },
);

describe("parallel-markets status mapping", () => {
  it.each([
    ["current", "accredited"],
    ["pending", "under_review"],
    ["submitter_pending", "needs_investor_action"],
    ["third_party_pending", "needs_investor_action"],
    ["unsubmitted", "in_progress"],
    ["rejected", "not_accredited"],
    ["expired", "expired"],
    ["canceled", "canceled"],
    ["on_hold", "unknown"],
  ])("%s → %s", (raw, mapped) => {
    expect(mapParallelStatus(raw)).toBe(mapped);
  });

  it("prefers the most recently certified current attempt, else the newest attempt", () => {
    const d = (s: string) => new Date(s);
    const list = [
      // Older certification, later expiry.
      { id: "a", status: "current", createdAt: d("2026-01-01"), certifiedAt: d("2026-01-05") },
      // Newer certification (a renewal) with an EARLIER expiry must still win.
      { id: "b", status: "current", createdAt: d("2026-02-01"), certifiedAt: d("2026-08-01") },
      { id: "c", status: "unsubmitted", createdAt: d("2026-09-01"), certifiedAt: undefined },
    ];
    expect(pickAccreditation(list)?.id).toBe("b");
    // No certified_at: created_at decides.
    expect(
      pickAccreditation([
        { id: "p", status: "current", createdAt: d("2026-05-01"), certifiedAt: undefined },
        { id: "q", status: "current", createdAt: d("2026-03-01"), certifiedAt: undefined },
      ])?.id,
    ).toBe("p");
    expect(
      pickAccreditation([
        { id: "x", status: "rejected", createdAt: d("2026-01-01"), certifiedAt: undefined },
        { id: "y", status: "pending", createdAt: d("2026-03-01"), certifiedAt: undefined },
      ])?.id,
    ).toBe("y");
    expect(pickAccreditation([])).toBeUndefined();
  });
});

describe("parallel-markets start", () => {
  it("creates an individual record and answers the widget handoff", async () => {
    const { port, vendor } = scripted();
    const result = await port.start(individual);
    expect(result).toEqual({
      providerRef: expect.any(String),
      handoff: {
        kind: "widget",
        sdk: "parallel-markets",
        config: {
          clientId: "client_abc",
          environment: "demo",
          requiredEntityId: result.providerRef,
          email: "ada@example.com",
          firstName: "Ada",
          lastName: "Lovelace",
          entityType: "self",
        },
      },
      vendorStatus: "record_created",
    });
    const post = vendor.requests.find((r) => r.method === "POST");
    expect(new URL(post?.url ?? "").pathname).toBe("/v2/partner-records/individuals");
    expect(post?.body).toEqual({
      email: "ada@example.com",
      first_name: "Ada",
      last_name: "Lovelace",
    });
    expect(post?.authorization).toBe(`Bearer ${vendor.apiKey}`);
  });

  it("creates a business record for an entity", async () => {
    const { port, vendor } = scripted();
    const result = await port.start({
      verificationId: "v2",
      subject: "entity",
      email: "cfo@acme.example",
      legalName: "Acme Holdings LLC",
    });
    expect(result.handoff).toMatchObject({
      config: { entityType: "business", email: "cfo@acme.example" },
    });
    expect(vendor.records()).toEqual([
      { id: result.providerRef, type: "business", email: null, name: "Acme Holdings LLC" },
    ]);
  });

  it("refuses an entity without a legal name", async () => {
    const { port } = scripted();
    await expect(
      port.start({ verificationId: "v2", subject: "entity", email: "cfo@acme.example" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("reuses the existing record when the vendor refuses a duplicate email", async () => {
    const { port, vendor } = scripted({ fake: { conflictOnDuplicateEmail: true } });
    const first = await port.start(individual);
    const second = await port.start({
      ...individual,
      verificationId: "v9",
      email: "ADA@example.com",
    });
    expect(second.providerRef).toBe(first.providerRef);
    expect(vendor.records()).toHaveLength(1);
  });

  it("uses the environment's fixed API root unless a test base is given", async () => {
    const seen: string[] = [];
    const capture = (async (input: string | URL | Request) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return new Response('{"data":[]}', { status: 200 });
    }) as typeof fetch;
    for (const environment of ["demo", "production"]) {
      await createParallelMarketsPort(
        { credentials: { apiKey: "k3y-value", clientId: "c", environment } },
        { fetch: capture, now: () => new Date() },
      ).verifyCredentials();
    }
    expect(seen).toEqual([
      "https://demo-api.parallelmarkets.com/v2/partner-records/file-types",
      "https://api.parallelmarkets.com/v2/partner-records/file-types",
    ]);
  });
});

describe("parallel-markets check", () => {
  it("follows pagination and picks the right attempt", async () => {
    const { port, vendor } = scripted({ fake: { pageSize: 1 } });
    const { providerRef } = await port.start(individual);
    vendor.addAttempt(providerRef, "rejected", { createdAt: new Date("2026-01-01T00:00:00Z") });
    vendor.addAttempt(providerRef, "current", {
      createdAt: new Date("2026-02-01T00:00:00Z"),
      expiresAt: new Date("2027-02-01T00:00:00Z"),
    });
    vendor.addAttempt(providerRef, "unsubmitted", { createdAt: new Date("2026-09-01T00:00:00Z") });
    const check = await port.check({ providerRef });
    expect(check).toMatchObject({
      status: "accredited",
      vendorStatus: "current",
      expiresAt: new Date("2027-02-01T00:00:00Z"),
    });
    const pages = vendor.requests.filter((r) => r.url.includes("/accreditations"));
    expect(pages.length).toBe(3);
  });

  it("reports the assertion and rejection reason", async () => {
    const { port, vendor } = scripted();
    const a = await port.start(individual);
    vendor.accredit(a.providerRef, { assertion: "net-worth" });
    await expect(port.check({ providerRef: a.providerRef })).resolves.toMatchObject({
      assertion: "net-worth",
    });
    const b = await port.start({ ...individual, email: "b@example.com" });
    vendor.reject(b.providerRef);
    await expect(port.check({ providerRef: b.providerRef })).resolves.toMatchObject({
      status: "not_accredited",
      rejectionReason: "income-invalid",
      decidedAt: expect.any(Date),
    });
  });

  it("treats an investor's own 'not accredited' answer as not_accredited", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.start(individual);
    vendor.indicateUnaccredited(providerRef);
    await expect(port.check({ providerRef })).resolves.toMatchObject({
      status: "not_accredited",
      vendorStatus: "indicated_unaccredited",
    });
  });

  it("maps an unknown record to not_found", async () => {
    const { port } = scripted();
    await expect(port.check({ providerRef: "Tm9wZQ==" })).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("parallel-markets fetchEvidence", () => {
  const accredited = async () => {
    const env = scripted();
    const { providerRef } = await env.port.start(individual);
    env.vendor.accredit(providerRef);
    return { ...env, providerRef };
  };

  it("downloads the letter at once and never sends the API key to the download URL", async () => {
    const { port, vendor, providerRef } = await accredited();
    const evidence = await port.fetchEvidence({ providerRef });
    expect(evidence?.contentType).toBe("application/pdf");
    const download = vendor.requests.find((r) => r.url.includes("/secure-files/"));
    expect(download).toBeDefined();
    expect(download?.authorization).toBeNull();
  });

  it("an expired download link is a retryable failure", async () => {
    let clock = new Date();
    const env = scripted({ now: () => clock });
    const { providerRef } = await env.port.start(individual);
    env.vendor.accredit(providerRef);
    // Simulate the link being used after its ~30 s lifetime.
    const slowFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/secure-files/")) clock = new Date(clock.getTime() + 60_000);
      return env.fetch(input, init);
    }) as typeof fetch;
    const port = createParallelMarketsPort(
      { credentials: env.credentials },
      { fetch: slowFetch, now: () => clock, apiBaseUrl: BASE },
    );
    await expect(port.fetchEvidence({ providerRef })).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
      status: 403,
    });
  });

  it("refuses a non-PDF letter and an oversize one", async () => {
    const { port, vendor, providerRef } = await accredited();
    vendor.setLetter(new TextEncoder().encode("<Error/>"));
    await expect(port.fetchEvidence({ providerRef })).rejects.toMatchObject({
      code: "unavailable",
    });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(fakePdf("x").slice(0, 8));
    vendor.setLetter(big);
    await expect(port.fetchEvidence({ providerRef })).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("refuses a plain-http letter URL when the API is https", async () => {
    const letterFetch = (async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.endsWith("/accreditations")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                status: "current",
                created_at: "2026-01-01T00:00:00Z",
                expires_at: "2027-01-01T00:00:00Z",
                documents: [
                  { type: "certification-letter", download_url: "http://files.example/x" },
                ],
              },
            ],
            pagination: { next_cursor: null },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    const port = createParallelMarketsPort(
      { credentials: { apiKey: "k3y-value", clientId: "c", environment: "demo" } },
      { fetch: letterFetch, now: () => new Date() },
    );
    await expect(port.fetchEvidence({ providerRef: "UmVj" })).rejects.toMatchObject({
      code: "unavailable",
      retryable: false,
    });
  });
});

describe("parallel-markets parseCallback", () => {
  it("verifies the documented scheme byte for byte", async () => {
    const { port } = scripted();
    const rawBody = new TextEncoder().encode(
      '{"entity":{"id":"VXNlcjox","type":"individual"},"event":"data_update","scope":"accreditation_status"}',
    );
    const now = new Date("2026-09-26T12:00:00Z");
    const ts = String(Math.floor(now.getTime() / 1000));
    const sig = createHmac("sha256", Buffer.from(SIGNING_KEY, "base64"))
      .update(ts + new TextDecoder().decode(rawBody))
      .digest("base64");
    const headers = new Headers({ "Parallel-Timestamp": ts, "Parallel-Signature": sig });
    await expect(port.parseCallback({ headers, rawBody, now })).resolves.toEqual({
      refs: ["VXNlcjox"],
    });
    // Future-dated beyond the skew window is refused as well.
    await expect(
      port.parseCallback({ headers, rawBody, now: new Date(now.getTime() - 6 * 60 * 1000) }),
    ).resolves.toBeUndefined();
  });

  it("refuses a signature over the body alone (timestamp not bound)", async () => {
    const { port } = scripted();
    const rawBody = new TextEncoder().encode('{"entity":{"id":"VXNlcjox"}}');
    const now = new Date();
    const headers = new Headers({
      "parallel-timestamp": String(Math.floor(now.getTime() / 1000)),
      "parallel-signature": createHmac("sha256", Buffer.from(SIGNING_KEY, "base64"))
        .update(rawBody)
        .digest("base64"),
    });
    await expect(port.parseCallback({ headers, rawBody, now })).resolves.toBeUndefined();
  });

  it("accepts a callback signed a minute ago", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.start(individual);
    const cb = vendor.callbackAt([providerRef], Math.floor(Date.now() / 1000) - 60);
    await expect(port.parseCallback({ ...cb, now: new Date() })).resolves.toEqual({
      refs: [providerRef],
    });
  });
});

describe.each(["scripted fetch", "real HTTP fake server"] as const)(
  "parallel-markets record reuse (%s)",
  (mode) => {
    it("marks a reused record as record_reused and a new one as record_created", async () => {
      let port: ReturnType<typeof createParallelMarketsPort>;
      let close = async () => {};
      if (mode === "scripted fetch") {
        port = scripted({ fake: { conflictOnDuplicateEmail: true } }).port;
      } else {
        const server = await startFakeParallelMarkets({
          webhookSigningKey: SIGNING_KEY,
          conflictOnDuplicateEmail: true,
        });
        close = () => server.close();
        port = parallelMarketsAdapter.create(
          {
            credentials: {
              apiKey: server.vendor.apiKey,
              clientId: "client_abc",
              environment: "demo",
            },
          },
          { fetch: globalThis.fetch, now: () => new Date(), apiBaseUrl: server.url },
        );
      }
      try {
        const first = await port.start(individual);
        expect(first.vendorStatus).toBe("record_created");
        const renewal = await port.start({ ...individual, verificationId: "v2" });
        expect(renewal).toMatchObject({
          providerRef: first.providerRef,
          vendorStatus: "record_reused",
        });
      } finally {
        await close();
      }
    });
  },
);

describe.each(["scripted fetch", "real HTTP fake server"] as const)(
  "parallel-markets renewal with a shorter-lived accreditation (%s)",
  (mode) => {
    it("answers the newer certification even though it expires earlier", async () => {
      let port: ReturnType<typeof createParallelMarketsPort>;
      let vendor: ReturnType<typeof scripted>["vendor"];
      let close = async () => {};
      if (mode === "scripted fetch") {
        ({ port, vendor } = scripted());
      } else {
        const server = await startFakeParallelMarkets({ webhookSigningKey: SIGNING_KEY });
        close = () => server.close();
        vendor = server.vendor;
        port = parallelMarketsAdapter.create(
          {
            credentials: {
              apiKey: server.vendor.apiKey,
              clientId: "client_abc",
              environment: "demo",
            },
          },
          { fetch: globalThis.fetch, now: () => new Date(), apiBaseUrl: server.url },
        );
      }
      try {
        const { providerRef } = await port.start(individual);
        // Original: certified in January on net worth, valid until mid-2027.
        vendor.addAttempt(providerRef, "current", {
          createdAt: new Date("2026-01-01T00:00:00Z"),
          certifiedAt: new Date("2026-01-05T00:00:00Z"),
          expiresAt: new Date("2027-06-01T00:00:00Z"),
        });
        // Renewal: certified in August on income, 90 days.
        vendor.addAttempt(providerRef, "current", {
          createdAt: new Date("2026-08-01T00:00:00Z"),
          certifiedAt: new Date("2026-08-03T00:00:00Z"),
          expiresAt: new Date("2026-11-01T00:00:00Z"),
        });
        await expect(port.check({ providerRef })).resolves.toMatchObject({
          status: "accredited",
          decidedAt: new Date("2026-08-03T00:00:00Z"),
          expiresAt: new Date("2026-11-01T00:00:00Z"),
        });
      } finally {
        await close();
      }
    });
  },
);
