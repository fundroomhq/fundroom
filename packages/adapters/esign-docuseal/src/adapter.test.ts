import { describeESignPortContract, pdfEnvelope, templateEnvelope } from "@fundroom/esign/testing";
import { ESignProviderError, OutboundHttpError } from "@fundroom/ports";
import { PageSizes, PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  callbackSecretMatches,
  createDocusealPort,
  docusealAdapter,
  docusealApiRoot,
  LEGACY_SECRET_HEADER,
  mapSubmissionStatus,
  mapSubmitterStatus,
  SECRET_HEADER,
} from "./adapter.js";
import { pdfPageSize, toDocusealArea, US_LETTER } from "./pdf-geometry.js";
import {
  createFakeDocuseal,
  FAKE_TEMPLATE_ID,
  FAKE_TEMPLATE_ROLE,
  fakeFetch,
  fakePdf,
} from "./testing/fake-vendor.js";

const BASE = "https://sign.docuseal.test";
const SECRET = "docuseal-contract-secret";

function scripted(
  options: {
    token?: string;
    now?: () => Date;
    edition?: "ce" | "pro";
    legacyShapes?: boolean;
    callbackSecret?: string | null;
  } = {},
) {
  const fake = createFakeDocuseal({
    baseUrl: BASE,
    callbackSecret: SECRET,
    ...(options.now ? { now: options.now } : {}),
    ...(options.edition ? { edition: options.edition } : {}),
    ...(options.legacyShapes ? { legacyShapes: true } : {}),
  });
  const port = createDocusealPort(
    {
      baseUrl: BASE,
      credentials: { apiToken: options.token ?? fake.vendor.apiToken },
      ...(options.callbackSecret === null
        ? {}
        : { callbackSecret: options.callbackSecret ?? SECRET }),
    },
    { fetch: fakeFetch(fake.handle), now: options.now ?? (() => new Date()) },
  );
  return { port, vendor: fake.vendor };
}

describeESignPortContract(
  "docuseal (scripted fetch)",
  async (opts) => {
    const { port, vendor } = scripted(opts?.credentials === "invalid" ? { token: "wrong" } : {});
    return { port, vendor, cleanup: async () => {} };
  },
  {
    supports: docusealAdapter.meta.supports,
    templateRef: String(FAKE_TEMPLATE_ID),
    templateRole: FAKE_TEMPLATE_ROLE,
  },
);

describeESignPortContract(
  "docuseal (legacy self-hosted response shapes)",
  async (opts) => {
    const { port, vendor } = scripted({
      legacyShapes: true,
      ...(opts?.credentials === "invalid" ? { token: "wrong" } : {}),
    });
    return { port, vendor, cleanup: async () => {} };
  },
  {
    supports: docusealAdapter.meta.supports,
    templateRef: String(FAKE_TEMPLATE_ID),
    templateRole: FAKE_TEMPLATE_ROLE,
  },
);

describe("docuseal api root", () => {
  it.each([
    ["https://api.docuseal.com", "https://api.docuseal.com"],
    ["https://api.docuseal.eu/", "https://api.docuseal.eu"],
    ["https://sign.example.com", "https://sign.example.com/api"],
    ["https://sign.example.com/api", "https://sign.example.com/api"],
    [undefined, "https://api.docuseal.com"],
  ] as const)("%s → %s", (base, root) => {
    expect(docusealApiRoot(base)).toBe(root);
  });
});

describe("docuseal field geometry", () => {
  it("converts fractions to page units with a top-left origin", () => {
    expect(
      toDocusealArea(
        { signerKey: "s1", kind: "signature", page: 2, x: 0.1, y: 0.8, w: 0.3, h: 0.06 },
        US_LETTER,
      ),
    ).toEqual({ x: 61.2, y: 633.6, w: 183.6, h: 47.52, page: 2 });
  });

  it("reads the page size from an uncompressed MediaBox", () => {
    expect(pdfPageSize(fakePdf("x"))).toEqual({
      size: US_LETTER,
      source: "mediabox",
      mixed: false,
    });
  });

  it("reads the page size from pdf-lib output (object streams) and flags mixed sizes", async () => {
    const a4 = await PDFDocument.create();
    a4.addPage(PageSizes.A4);
    a4.addPage(PageSizes.A4);
    const bytes = await a4.save({ useObjectStreams: true });
    const read = pdfPageSize(bytes);
    expect(read.source).toBe("mediabox");
    expect(read.size.width).toBeCloseTo(595.28, 1);
    expect(read.size.height).toBeCloseTo(841.89, 1);
    expect(read.mixed).toBe(false);

    const mixed = await PDFDocument.create();
    mixed.addPage(PageSizes.Letter);
    mixed.addPage(PageSizes.A4);
    expect(pdfPageSize(await mixed.save()).mixed).toBe(true);
  });

  it("falls back to US Letter when no MediaBox is readable", () => {
    expect(pdfPageSize(new TextEncoder().encode("%PDF-1.7\n%%EOF"))).toEqual({
      size: US_LETTER,
      source: "default",
      mixed: false,
    });
  });

  it("sends areas in page units, per-signer roles and the signer name prefill", async () => {
    const { port, vendor } = scripted();
    const input = pdfEnvelope();
    const { providerRef } = await port.createEnvelope(input);
    const body = vendor.created().find((c) => c.providerRef === providerRef)?.input as Record<
      string,
      unknown
    >;
    const doc = (body["documents"] as Record<string, unknown>[])[0] as Record<string, unknown>;
    const fields = doc["fields"] as Record<string, unknown>[];
    expect(fields.map((f) => f["type"])).toEqual(["signature", "date", "text"]);
    expect(fields[0]).toMatchObject({
      role: "Signer s1",
      areas: [{ x: 61.2, y: 633.6, w: 183.6, h: 47.52, page: 1 }],
    });
    const submitters = body["submitters"] as Record<string, unknown>[];
    expect(submitters[0]).toMatchObject({
      role: "Signer s1",
      external_id: `${input.externalId}.s1`,
      metadata: { seedhost_envelope_id: input.externalId, seedhost_signer_key: "s1" },
      send_email: false,
      order: 0,
      values: { name_s1_3: "Ada Lovelace" },
    });
    expect(body["send_email"]).toBe(false);
    expect(
      Buffer.from(doc["file"] as string, "base64")
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
  });
});

describe("docuseal template envelopes", () => {
  it("maps role and prefill onto the submitter", async () => {
    const { port, vendor } = scripted();
    const input = templateEnvelope(String(FAKE_TEMPLATE_ID), FAKE_TEMPLATE_ROLE);
    await port.createEnvelope(input);
    const body = vendor.created()[0]?.input as Record<string, unknown>;
    expect(body).toMatchObject({
      template_id: FAKE_TEMPLATE_ID,
      send_email: true,
      order: "preserved",
    });
    expect((body["submitters"] as unknown[])[0]).toMatchObject({
      role: FAKE_TEMPLATE_ROLE,
      email: "ada@example.com",
      values: { investor_name: "Ada Lovelace", amount: "$25,000" },
      external_id: `${input.externalId}.s1`,
    });
  });

  it("refuses non-numeric template refs and unknown roles", async () => {
    const { port } = scripted();
    await expect(port.createEnvelope(templateEnvelope("tpl", "Investor"))).rejects.toMatchObject({
      code: "rejected",
    });
    await expect(
      port.createEnvelope(templateEnvelope(String(FAKE_TEMPLATE_ID), "Lawyer")),
    ).rejects.toMatchObject({ code: "rejected", status: 422 });
  });

  it("explains a missing PDF API on the open-source edition", async () => {
    const { port } = scripted({ edition: "ce" });
    const err = (await port
      .createEnvelope(pdfEnvelope())
      .catch((e: unknown) => e)) as ESignProviderError;
    expect(err).toMatchObject({ code: "rejected", status: 404 });
    expect(err.message).toContain("DocuSeal Pro or Cloud");
  });
});

describe("docuseal status mapping", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  const sub = (
    status: string | undefined,
    submitters: string[],
    extra: Record<string, unknown> = {},
  ) => ({
    status,
    archivedAt: undefined,
    expireAt: undefined,
    submitters: submitters.map((s, i) => ({ status: s, id: i })) as never,
    ...extra,
  });
  it.each([
    [sub("pending", ["sent"]), "sent"],
    [sub("pending", ["awaiting", "sent"]), "sent"],
    [sub("pending", ["opened"]), "delivered"],
    [sub("pending", ["completed", "sent"]), "delivered"],
    [sub("completed", ["completed"]), "completed"],
    [sub(undefined, ["completed", "completed"]), "completed"],
    [sub("declined", ["declined"]), "declined"],
    [sub(undefined, ["opened", "declined"]), "declined"],
    [sub("expired", ["sent"]), "expired"],
    [sub(undefined, ["sent"], { expireAt: new Date("2026-09-01T00:00:00Z") }), "expired"],
    [sub("pending", ["sent"], { archivedAt: new Date("2026-09-20T00:00:00Z") }), "voided"],
    [
      sub("completed", ["completed"], { archivedAt: new Date("2026-09-20T00:00:00Z") }),
      "completed",
    ],
  ] as const)("%o → %s", (input, expected) => {
    expect(mapSubmissionStatus(input as never, now)).toBe(expected);
  });

  it.each([
    ["awaiting", "pending"],
    ["sent", "pending"],
    ["opened", "viewed"],
    ["completed", "signed"],
    ["declined", "declined"],
    ["something-new", "pending"],
  ] as const)("submitter %s → %s", (status, expected) => {
    expect(mapSubmitterStatus(status)).toBe(expected);
  });

  it("maps signers back by metadata, not position", async () => {
    const { port } = scripted();
    const { providerRef } = await port.createEnvelope(
      templateEnvelope(String(FAKE_TEMPLATE_ID), FAKE_TEMPLATE_ROLE, {
        signers: [
          { signerKey: "lead", name: "L", email: "l@x.io", role: FAKE_TEMPLATE_ROLE, order: 2 },
          { signerKey: "co", name: "C", email: "c@x.io", role: FAKE_TEMPLATE_ROLE, order: 1 },
        ],
      }),
    );
    const state = await port.status(providerRef);
    expect(state.signers.map((s) => s.signerKey)).toEqual(["co", "lead"]);
  });
});

describe("docuseal errors", () => {
  it.each([
    [400, "rejected", false],
    [401, "unauthorized", false],
    [403, "unauthorized", false],
    [404, "not_found", false],
    [409, "rejected", false],
    [422, "rejected", false],
    [429, "rate_limited", true],
    [500, "unavailable", true],
    [502, "unavailable", true],
  ] as const)("HTTP %i → %s (retryable %s)", async (status, code, retryable) => {
    const { port, vendor } = scripted();
    vendor.failNext(status);
    const err = await port.status("71").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ESignProviderError);
    expect(err).toMatchObject({ code, retryable });
  });

  it("maps transport failures and bad bodies", async () => {
    const make = (f: typeof fetch) =>
      createDocusealPort(
        { baseUrl: BASE, credentials: { apiToken: "k" } },
        { fetch: f, now: () => new Date() },
      );
    await expect(
      make((() => Promise.reject(new TypeError("x"))) as typeof fetch).status("1"),
    ).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    await expect(
      make((() =>
        Promise.reject(new OutboundHttpError("too_many_redirects", "x"))) as typeof fetch).status(
        "1",
      ),
    ).rejects.toMatchObject({ code: "invalid_response", retryable: false });
    await expect(
      make((() =>
        Promise.reject(new OutboundHttpError("response_too_large", "x"))) as typeof fetch).status(
        "1",
      ),
    ).rejects.toMatchObject({ code: "too_large" });
    await expect(
      make(
        (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
      ).status("1"),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      make((async () => new Response("[]", { status: 200 })) as unknown as typeof fetch).status(
        "1",
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("keeps the API key out of errors", async () => {
    const key = "docuseal_live_key_0123456789";
    const port = createDocusealPort(
      { baseUrl: BASE, credentials: { apiToken: key } },
      {
        fetch: (async () =>
          new Response(JSON.stringify({ error: `token ${key} invalid` }), {
            status: 422,
          })) as unknown as typeof fetch,
        now: () => new Date(),
      },
    );
    const err = (await port.status("5").catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(key);
  });

  it("verifyCredentials does not throw", async () => {
    await expect(scripted({ token: "nope" }).port.verifyCredentials()).resolves.toEqual({
      ok: false,
      reason: "unauthorized",
    });
    const down = createDocusealPort(
      { credentials: { apiToken: "k" } },
      {
        fetch: (() => Promise.reject(new TypeError("down"))) as typeof fetch,
        now: () => new Date(),
      },
    );
    await expect(down.verifyCredentials()).resolves.toMatchObject({
      ok: false,
      reason: "unreachable",
    });
  });
});

describe("docuseal downloads, signing links, void and callbacks", () => {
  it("downloads document + audit log without sending the API key to the file host", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    vendor.complete(providerRef);
    const artifacts = await port.downloadSigned(providerRef, { maxBytes: 1_000_000 });
    expect(artifacts.certificate).toBeInstanceOf(Uint8Array);
    const files = vendor.requests.filter((r) => r.url.startsWith("/file/"));
    expect(files).toHaveLength(2);
    expect(files.every((r) => r.token === null)).toBe(true);
  });

  it("enforces maxBytes while streaming and checks the PDF magic", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    vendor.complete(providerRef);
    const big = new Uint8Array(40_000).fill(0x41);
    big.set(new TextEncoder().encode("%PDF-"));
    vendor.setArtifact(big, { chunked: true });
    await expect(port.downloadSigned(providerRef, { maxBytes: 4096 })).rejects.toMatchObject({
      code: "too_large",
    });
    vendor.setArtifact(new TextEncoder().encode("PK\u0003\u0004zip"));
    await expect(port.downloadSigned(providerRef, { maxBytes: 4096 })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("sets the per-signer return URL when handing out a signing link", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    const url = await port.signingUrl(providerRef, "s1", "https://portal.example.com/back");
    expect(url).toMatch(/^https:\/\/sign\.docuseal\.test\/s\/slug\d+$/u);
    const stored = vendor.submission(providerRef) as {
      submitters: { completed_redirect_url: string }[];
    };
    expect(stored.submitters[0]?.completed_redirect_url).toBe("https://portal.example.com/back");
    expect(await port.signingUrl(providerRef, "nobody", "https://x.test")).toBeUndefined();
    vendor.complete(providerRef);
    expect(await port.signingUrl(providerRef, "s1", "https://x.test")).toBeUndefined();
  });

  it("void archives an open submission, is idempotent, and refuses a completed one", async () => {
    const { port, vendor } = scripted();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    await port.void(providerRef, "x");
    await port.void(providerRef, "again");
    expect((await port.status(providerRef)).status).toBe("voided");
    expect(vendor.requests.filter((r) => r.method === "DELETE")).toHaveLength(1);
    const other = await port.createEnvelope(pdfEnvelope());
    vendor.complete(other.providerRef);
    await expect(port.void(other.providerRef, "x")).rejects.toMatchObject({ code: "rejected" });
  });

  it("names the envelope from form.* and submission.* events", async () => {
    const { port, vendor } = scripted();
    const input = pdfEnvelope();
    const { providerRef } = await port.createEnvelope(input);
    await expect(port.parseCallback(vendor.callback(providerRef, "viewed"))).resolves.toEqual({
      event: "form.viewed",
      providerRef,
      externalId: input.externalId,
    });
    vendor.complete(providerRef);
    await expect(port.parseCallback(vendor.callback(providerRef, "completed"))).resolves.toEqual({
      event: "submission.completed",
      providerRef,
      externalId: input.externalId,
    });
  });

  it("accepts the secret under X-Fundroom-Signature or the pre-rename X-Seedhost-Signature (A-2)", async () => {
    expect(SECRET_HEADER).toBe("x-fundroom-signature");
    expect(LEGACY_SECRET_HEADER).toBe("x-seedhost-signature");
    const { port, vendor } = scripted();
    const input = pdfEnvelope();
    const { providerRef } = await port.createEnvelope(input);
    vendor.complete(providerRef);
    const genuine = vendor.callback(providerRef, "completed");
    expect(genuine.headers.get(SECRET_HEADER)).toBe(SECRET);
    const expected = { event: "submission.completed", providerRef, externalId: input.externalId };
    /** The genuine body under exactly these secret headers. */
    const send = (secrets: Record<string, string>) => {
      const headers = new Headers({ "content-type": "application/json" });
      for (const [name, value] of Object.entries(secrets)) headers.set(name, value);
      return port.parseCallback({ headers, body: genuine.body });
    };

    await expect(send({ "X-Fundroom-Signature": SECRET })).resolves.toEqual(expected);
    // A DocuSeal webhook configured before the rename.
    await expect(send({ "X-Seedhost-Signature": SECRET })).resolves.toEqual(expected);
    await expect(
      send({ "X-Fundroom-Signature": SECRET, "X-Seedhost-Signature": SECRET }),
    ).resolves.toEqual(expected);

    // Neither header, or a wrong secret under either one alone.
    await expect(send({})).resolves.toBeUndefined();
    await expect(send({ "X-Fundroom-Signature": `${SECRET}!` })).resolves.toBeUndefined();
    await expect(send({ "X-Seedhost-Signature": `${SECRET}!` })).resolves.toBeUndefined();
    await expect(send({ "X-Fundroom-Signature": "" })).resolves.toBeUndefined();
    // Both present: a bad new header is never rescued by a good legacy one…
    await expect(
      send({ "X-Fundroom-Signature": "forged", "X-Seedhost-Signature": SECRET }),
    ).resolves.toBeUndefined();
    await expect(
      send({ "X-Fundroom-Signature": "", "X-Seedhost-Signature": SECRET }),
    ).resolves.toBeUndefined();
    // …and a bad legacy header riding along is not skipped because the new one matched.
    await expect(
      send({ "X-Fundroom-Signature": SECRET, "X-Seedhost-Signature": "forged" }),
    ).resolves.toBeUndefined();
    // A header with some other name carries nothing.
    await expect(send({ "Seedhost-Signature": SECRET })).resolves.toBeUndefined();
  });

  it("callbackSecretMatches needs a configured secret", () => {
    const headers = new Headers({ [SECRET_HEADER]: SECRET });
    expect(callbackSecretMatches(headers, SECRET)).toBe(true);
    expect(callbackSecretMatches(headers, undefined)).toBe(false);
    expect(callbackSecretMatches(headers, "")).toBe(false);
    expect(callbackSecretMatches(new Headers({ [LEGACY_SECRET_HEADER]: "" }), "")).toBe(false);
  });

  it("rejects callbacks when no secret is configured, and unknown event families", async () => {
    const { port, vendor } = scripted({ callbackSecret: null });
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    await expect(
      port.parseCallback(vendor.callback(providerRef, "completed")),
    ).resolves.toBeUndefined();

    const withSecret = scripted();
    const genuine = withSecret.vendor.callback(
      (await withSecret.port.createEnvelope(pdfEnvelope())).providerRef,
      "completed",
    );
    const body = new TextEncoder().encode(
      JSON.stringify({ event_type: "template.created", data: { id: 1 } }),
    );
    await expect(
      withSecret.port.parseCallback({ headers: genuine.headers, body }),
    ).resolves.toBeUndefined();
  });
});
