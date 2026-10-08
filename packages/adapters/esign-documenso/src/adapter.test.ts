import { describeESignPortContract, pdfEnvelope, templateEnvelope } from "@fundroom/esign/testing";
import { ESignProviderError, OutboundHttpError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  createDocumensoPort,
  documensoAdapter,
  mapDocumentStatus,
  mapRecipientStatus,
  toDocumensoGeometry,
} from "./adapter.js";
import { startFakeDocumenso } from "./testing/fake-server.js";
import {
  createFakeDocumenso,
  FAKE_TEMPLATE_ID,
  FAKE_TEMPLATE_ROLE,
  fakeFetch,
  fakePdf,
} from "./testing/fake-vendor.js";

const BASE = "https://documenso.test";
const SECRET = "whsec-documenso-contract";

function scripted(options: { token?: string; now?: () => Date } = {}) {
  const fake = createFakeDocumenso({
    baseUrl: BASE,
    callbackSecret: SECRET,
    ...(options.now ? { now: options.now } : {}),
  });
  const port = createDocumensoPort(
    {
      baseUrl: BASE,
      credentials: { apiToken: options.token ?? fake.vendor.apiToken },
      callbackSecret: SECRET,
    },
    { fetch: fakeFetch(fake.handle), now: options.now ?? (() => new Date()) },
  );
  return { port, vendor: fake.vendor };
}

describeESignPortContract(
  "documenso (scripted fetch)",
  async (opts) => {
    const { port, vendor } = scripted(
      opts?.credentials === "invalid" ? { token: "api_wrong" } : {},
    );
    return { port, vendor, cleanup: async () => {} };
  },
  {
    supports: documensoAdapter.meta.supports,
    templateRef: String(FAKE_TEMPLATE_ID),
    templateRole: FAKE_TEMPLATE_ROLE,
  },
);

describeESignPortContract(
  "documenso (real HTTP fake server)",
  async (opts) => {
    const server = await startFakeDocumenso({ callbackSecret: SECRET });
    const port = documensoAdapter.create(
      {
        baseUrl: server.url,
        credentials: {
          apiToken: opts?.credentials === "invalid" ? "api_wrong" : server.vendor.apiToken,
        },
        callbackSecret: SECRET,
      },
      // Tests only: the kernel injects the SSRF-guarded client here.
      { fetch: globalThis.fetch, now: () => new Date() },
    );
    return { port, vendor: server.vendor, cleanup: () => server.close() };
  },
  {
    supports: documensoAdapter.meta.supports,
    templateRef: String(FAKE_TEMPLATE_ID),
    templateRole: FAKE_TEMPLATE_ROLE,
  },
);

describe("documenso field geometry", () => {
  it("converts page fractions to Documenso percentages", () => {
    expect(
      toDocumensoGeometry({
        signerKey: "s1",
        kind: "signature",
        page: 2,
        x: 0.1,
        y: 0.825,
        w: 0.3,
        h: 0.06,
      }),
    ).toEqual({
      pageNumber: 2,
      pageX: 10,
      pageY: 82.5,
      pageWidth: 30,
      pageHeight: 6,
    });
  });

  it("clamps out-of-range fractions and refuses a bad page", () => {
    expect(
      toDocumensoGeometry({
        signerKey: "s1",
        kind: "date",
        page: 1,
        x: -0.2,
        y: 1.4,
        w: 0.5,
        h: 0.1,
      }),
    ).toMatchObject({
      pageX: 0,
      pageY: 100,
    });
    expect(() =>
      toDocumensoGeometry({ signerKey: "s1", kind: "date", page: 0, x: 0, y: 0, w: 0.1, h: 0.1 }),
    ).toThrow(ESignProviderError);
  });

  it("posts the converted fields for the right recipient", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    const fields = vendor.fieldsOf(providerRef);
    expect(fields).toHaveLength(3);
    expect(fields[0]).toMatchObject({
      type: "SIGNATURE",
      pageNumber: 1,
      pageX: 10,
      pageY: 80,
      pageWidth: 30,
      pageHeight: 6,
    });
    expect(fields.map((f) => f["type"])).toEqual(["SIGNATURE", "DATE", "NAME"]);
  });
});

describe("documenso create", () => {
  it("never sends the API token to the presigned upload/download URLs", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    vendor.complete(providerRef);
    await port.downloadSigned(providerRef, { maxBytes: 1_000_000 });
    const presigned = vendor.requests.filter((r) => r.url.startsWith("/__s3/"));
    expect(presigned.map((r) => r.url.split("/")[2])).toEqual(["upload", "download"]);
    expect(presigned.every((r) => r.authorization === null)).toBe(true);
    const api = vendor.requests.filter((r) => r.url.startsWith("/api/v1/"));
    expect(api.every((r) => r.authorization === vendor.apiToken)).toBe(true);
  });

  it("sends externalId, sequential order and no vendor email for embedded envelopes", async () => {
    const { port, vendor } = scripted();
    const input = pdfEnvelope({
      signers: [
        { signerKey: "s1", name: "A", email: "a@example.com", order: 1 },
        { signerKey: "s2", name: "B", email: "b@example.com", order: 2 },
      ],
      document: {
        kind: "pdf",
        filename: "x.pdf",
        bytes: fakePdf("x"),
        fields: [{ signerKey: "s2", kind: "signature", page: 1, x: 0, y: 0, w: 0.1, h: 0.1 }],
      },
    });
    const { providerRef } = await port.createEnvelope(input);
    const body = vendor.created()[0]?.input as Record<string, unknown>;
    expect(body["externalId"]).toBe(input.externalId);
    expect(body["meta"]).toMatchObject({ signingOrder: "SEQUENTIAL", distributionMethod: "NONE" });
    const state = await port.status(providerRef);
    expect(state.signers.map((s) => s.signerKey)).toEqual(["s1", "s2"]);
    const s2 = vendor.fieldsOf(providerRef)[0]?.["recipientId"];
    expect(typeof s2).toBe("number");
  });

  it("maps template role and prefill (labelled field → prefillFields, others → formValues)", async () => {
    const { port, vendor } = scripted();
    const input = templateEnvelope(String(FAKE_TEMPLATE_ID), "signer");
    await port.createEnvelope(input);
    const body = vendor.created()[0]?.input as Record<string, unknown>;
    expect(body["recipients"]).toEqual([
      { id: 7, email: "ada@example.com", name: "Ada Lovelace", signingOrder: 1 },
    ]);
    expect(body["prefillFields"]).toEqual([{ id: 70, type: "text", value: "Ada Lovelace" }]);
    expect(body["formValues"]).toEqual({ amount: "$25,000" });
    expect(body["meta"]).toMatchObject({ distributionMethod: "EMAIL" });
  });

  it("refuses an unknown template role, a non-numeric template ref and non-canonical signer keys", async () => {
    const { port } = scripted();
    await expect(
      port.createEnvelope(templateEnvelope(String(FAKE_TEMPLATE_ID), "Lawyer")),
    ).rejects.toMatchObject({
      code: "rejected",
    });
    await expect(port.createEnvelope(templateEnvelope("abc", "Signer"))).rejects.toMatchObject({
      code: "rejected",
    });
    await expect(
      port.createEnvelope(
        pdfEnvelope({ signers: [{ signerKey: "investor", name: "A", email: "a@x.io", order: 1 }] }),
      ),
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("deletes the half-created draft when a later step fails", async () => {
    const fake = createFakeDocumenso({ baseUrl: BASE, callbackSecret: SECRET });
    const inner = fakeFetch(fake.handle);
    const port = createDocumensoPort(
      { baseUrl: BASE, credentials: { apiToken: fake.vendor.apiToken }, callbackSecret: SECRET },
      {
        fetch: ((url: string | URL | Request, init?: RequestInit) => {
          if (String(url).endsWith("/fields")) fake.vendor.failNext(422);
          return inner(url, init);
        }) as typeof fetch,
        now: () => new Date(),
      },
    );
    await expect(port.createEnvelope(pdfEnvelope())).rejects.toMatchObject({
      code: "rejected",
      status: 422,
    });
    const ref = fake.vendor.created()[0]?.providerRef ?? "";
    expect(fake.vendor.documentStatus(ref)).toBeUndefined();
    expect(fake.vendor.requests.at(-1)).toMatchObject({ method: "DELETE" });
  });
});

describe("documenso status mapping", () => {
  const r = (over: Partial<{ readStatus: string; signingStatus: string; role: string }> = {}) => ({
    id: 1,
    email: "a@b.c",
    role: "SIGNER",
    signingOrder: 1,
    readStatus: "NOT_OPENED",
    signingStatus: "NOT_SIGNED",
    signedAt: undefined,
    signingUrl: undefined,
    ...over,
  });

  it.each([
    ["DRAFT", [r()], "sent"],
    ["PENDING", [r()], "sent"],
    ["PENDING", [r({ readStatus: "OPENED" })], "delivered"],
    ["PENDING", [r({ role: "CC", readStatus: "OPENED" })], "sent"],
    ["COMPLETED", [r()], "completed"],
    ["REJECTED", [r()], "declined"],
    ["CANCELLED", [r()], "voided"],
    ["SOMETHING_NEW", [r()], "sent"],
  ] as const)("document %s → %s", (status, recipients, expected) => {
    expect(mapDocumentStatus({ status, recipients })).toBe(expected);
  });

  it.each([
    [{ readStatus: "NOT_OPENED", signingStatus: "NOT_SIGNED" }, "pending"],
    [{ readStatus: "OPENED", signingStatus: "NOT_SIGNED" }, "viewed"],
    [{ readStatus: "OPENED", signingStatus: "SIGNED" }, "signed"],
    [{ readStatus: "OPENED", signingStatus: "REJECTED" }, "declined"],
  ] as const)("recipient %o → %s", (rec, expected) => {
    expect(mapRecipientStatus(rec)).toBe(expected);
  });
});

describe("documenso error mapping", () => {
  it.each([
    [400, "rejected", false],
    [401, "unauthorized", false],
    [403, "unauthorized", false],
    [404, "not_found", false],
    [409, "rejected", false],
    [422, "rejected", false],
    [429, "rate_limited", true],
    [500, "unavailable", true],
    [503, "unavailable", true],
  ] as const)("HTTP %i → %s (retryable %s)", async (status, code, retryable) => {
    const { port, vendor } = scripted();
    vendor.failNext(status);
    const err = await port.status("1001").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ESignProviderError);
    expect(err).toMatchObject({ code, retryable });
  });

  it("maps network failures, guard refusals, redirects and bad JSON", async () => {
    const make = (fetchImpl: typeof fetch) =>
      createDocumensoPort(
        { baseUrl: BASE, credentials: { apiToken: "api_x" } },
        { fetch: fetchImpl, now: () => new Date() },
      );
    await expect(
      make((() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch).status("1"),
    ).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    await expect(
      make((() =>
        Promise.reject(
          new OutboundHttpError("blocked_address", "10.0.0.1"),
        )) as typeof fetch).status("1"),
    ).rejects.toMatchObject({ code: "unavailable", retryable: false });
    await expect(
      make((() => Promise.reject(new OutboundHttpError("timeout", "slow"))) as typeof fetch).status(
        "1",
      ),
    ).rejects.toMatchObject({ code: "unavailable", retryable: true });
    await expect(
      make(
        (async () =>
          new Response(null, {
            status: 302,
            headers: { location: "https://evil.test" },
          })) as typeof fetch,
      ).status("1"),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      make((async () => new Response("<html>", { status: 200 })) as typeof fetch).status("1"),
    ).rejects.toMatchObject({
      code: "invalid_response",
    });
    await expect(
      make((async () => new Response("{}", { status: 200 })) as typeof fetch).status("1"),
    ).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("never puts the token or a vendor-echoed secret in an error message", async () => {
    const token = "api_super_secret_token_value";
    const port = createDocumensoPort(
      { baseUrl: BASE, credentials: { apiToken: token } },
      {
        fetch: (async () =>
          new Response(JSON.stringify({ message: `bad token ${token}` }), {
            status: 422,
          })) as unknown as typeof fetch,
        now: () => new Date(),
      },
    );
    const err = (await port.status("1").catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(token);
    expect(err.message).toContain("[redacted]");
  });

  it("verifyCredentials reports unauthorized / unreachable / misconfigured without throwing", async () => {
    const { port: bad } = scripted({ token: "api_nope" });
    await expect(bad.verifyCredentials()).resolves.toEqual({ ok: false, reason: "unauthorized" });
    const down = createDocumensoPort(
      { credentials: { apiToken: "api_x" } },
      {
        fetch: (() => Promise.reject(new TypeError("down"))) as typeof fetch,
        now: () => new Date(),
      },
    );
    await expect(down.verifyCredentials()).resolves.toMatchObject({
      ok: false,
      reason: "unreachable",
    });
    const notDocumenso = createDocumensoPort(
      { credentials: { apiToken: "api_x" } },
      {
        fetch: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
        now: () => new Date(),
      },
    );
    await expect(notDocumenso.verifyCredentials()).resolves.toMatchObject({
      ok: false,
      reason: "misconfigured",
    });
    const empty = createDocumensoPort(
      { credentials: {} },
      {
        fetch: (() => Promise.reject(new Error("no call expected"))) as typeof fetch,
        now: () => new Date(),
      },
    );
    await expect(empty.verifyCredentials()).resolves.toMatchObject({
      ok: false,
      reason: "misconfigured",
    });
  });
});

describe("documenso downloadSigned limits", () => {
  it("refuses an oversize artifact declared by Content-Length", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    vendor.complete(providerRef);
    vendor.setArtifact(new Uint8Array(50_000).fill(0x25));
    await expect(port.downloadSigned(providerRef, { maxBytes: 10_000 })).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("refuses an oversize artifact while streaming (no Content-Length)", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    vendor.complete(providerRef);
    const big = new Uint8Array(64 * 1024).fill(0x20);
    big.set(new TextEncoder().encode("%PDF-1.7"));
    vendor.setArtifact(big, { chunked: true });
    await expect(port.downloadSigned(providerRef, { maxBytes: 8 * 1024 })).rejects.toMatchObject({
      code: "too_large",
    });
    await expect(port.downloadSigned(providerRef, { maxBytes: 128 * 1024 })).resolves.toMatchObject(
      {
        document: expect.any(Uint8Array),
      },
    );
  });

  it("refuses a non-PDF artifact", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    vendor.complete(providerRef);
    vendor.setArtifact(new TextEncoder().encode("<html>not a pdf</html>"));
    await expect(port.downloadSigned(providerRef, { maxBytes: 10_000 })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("documenso void + callbacks", () => {
  it("follows a rotated callback secret on the fake (setCallbackSecret)", async () => {
    const fake = createFakeDocumenso({ baseUrl: BASE });
    const port = createDocumensoPort(
      {
        baseUrl: BASE,
        credentials: { apiToken: fake.vendor.apiToken },
        callbackSecret: "rotated-secret",
      },
      { fetch: fakeFetch(fake.handle), now: () => new Date() },
    );
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    await expect(
      port.parseCallback(fake.vendor.callback(providerRef, "viewed")),
    ).resolves.toBeUndefined();
    fake.vendor.setCallbackSecret("rotated-secret");
    await expect(
      port.parseCallback(fake.vendor.callback(providerRef, "viewed")),
    ).resolves.toMatchObject({
      providerRef,
    });
  });

  it("does not DELETE a completed document", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    vendor.complete(providerRef);
    await expect(port.void(providerRef, "x")).rejects.toMatchObject({ code: "rejected" });
    expect(vendor.requests.some((r) => r.method === "DELETE")).toBe(false);
  });

  it("rejects a callback outside the 5-minute window", async () => {
    let clock = new Date("2026-09-25T12:00:00Z");
    const { port, vendor } = scripted({ now: () => clock });
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    const cb = vendor.callback(providerRef, "completed");
    await expect(port.parseCallback(cb)).resolves.toMatchObject({
      providerRef,
      event: "DOCUMENT_COMPLETED",
    });
    clock = new Date(clock.getTime() + 6 * 60 * 1000);
    await expect(port.parseCallback(cb)).resolves.toBeUndefined();
  });

  it("rejects every callback when no callback secret is configured", async () => {
    const fake = createFakeDocumenso({ baseUrl: BASE, callbackSecret: SECRET });
    const port = createDocumensoPort(
      { baseUrl: BASE, credentials: { apiToken: fake.vendor.apiToken } },
      { fetch: fakeFetch(fake.handle), now: () => new Date() },
    );
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    await expect(
      port.parseCallback(fake.vendor.callback(providerRef, "completed")),
    ).resolves.toBeUndefined();
  });
});
