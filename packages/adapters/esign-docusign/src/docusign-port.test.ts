import { generateKeyPairSync, verify } from "node:crypto";
import { deflateSync } from "node:zlib";
import { describeESignPortContract, pdfEnvelope, templateEnvelope } from "@fundroom/esign/testing";
import {
  type ESignAdapterDeps,
  type ESignDocumentSource,
  ESignProviderError,
} from "@fundroom/ports";
import { describe, expect, it, vi } from "vitest";
import {
  detectPageSize,
  docusignAdapter,
  jwtClaims,
  signJwt,
  tabsFor,
  validateBaseUri,
} from "./index.js";
import {
  createFakeDocusign,
  FAKE,
  type FakeDocusignOptions,
  hmacHeader,
} from "./testing/fake-docusign.js";

function credentials(pem: string, overrides: Record<string, string> = {}): Record<string, string> {
  return {
    environment: "demo",
    integrationKey: FAKE.integrationKey,
    userId: FAKE.userId,
    privateKeyPem: pem,
    connectHmacKey: FAKE.hmacKey,
    ...overrides,
  };
}

type PdfSource = Extract<ESignDocumentSource, { kind: "pdf" }>;

interface SentSigner {
  recipientId: string;
  clientUserId?: string;
  customFields: string[];
  tabs: {
    signHereTabs: Record<string, string>[];
    dateSignedTabs: Record<string, string>[];
    fullNameTabs: Record<string, string>[];
  };
}

/** The envelope definition the fake DocuSign received (only the parts these tests read). */
interface SentDefinition {
  status: string;
  customFields: { textCustomFields: { name: string; value: string }[] };
  recipients: { signers: SentSigner[] };
  documents: { documentBase64: string }[];
  templateId: string;
  templateRoles: unknown[];
}

let otherPem: string | undefined;

function build(
  options: FakeDocusignOptions & {
    now?: () => Date;
    creds?: Record<string, string>;
    invalidKey?: boolean;
  } = {},
) {
  const fake = createFakeDocusign(options);
  let pem = fake.privateKeyPem;
  if (options.invalidKey) {
    otherPem ??= generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    pem = otherPem;
  }
  const warn = vi.fn();
  const deps: ESignAdapterDeps = {
    fetch: fake.fetch,
    now: options.now ?? (() => new Date()),
    log: { warn },
  };
  const port = docusignAdapter.create({ credentials: credentials(pem, options.creds) }, deps);
  return { fake, port, warn };
}

describeESignPortContract(
  "docusign (scripted fetch)",
  async (opts) => {
    const { fake, port } = build({ invalidKey: opts?.credentials === "invalid" });
    return { port, vendor: fake.vendor, cleanup: async () => {} };
  },
  {
    supports: docusignAdapter.meta.supports,
    templateRef: FAKE.templateId,
    templateRole: FAKE.templateRole,
  },
);

describe("docusign JWT grant", () => {
  it("signs RS256 claims that verify with the matching public key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = new Date("2026-09-25T12:00:00Z");
    const claims = jwtClaims({
      integrationKey: "ik",
      userId: "uid",
      audience: "account-d.docusign.com",
      now,
    });
    const jwt = signJwt(claims, privateKey);
    const [h, p, s] = jwt.split(".") as [string, string, string];
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toEqual({
      iss: "ik",
      sub: "uid",
      aud: "account-d.docusign.com",
      iat: 1790337600,
      exp: 1790337600 + 3600,
      scope: "signature impersonation",
    });
    expect(verify("sha256", Buffer.from(`${h}.${p}`), publicKey, Buffer.from(s, "base64url"))).toBe(
      true,
    );
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    expect(verify("sha256", Buffer.from(`${h}.${p}`), other, Buffer.from(s, "base64url"))).toBe(
      false,
    );
  });

  it("uses the production account server for environment=production", async () => {
    const { fake } = build();
    const seen: string[] = [];
    const port = docusignAdapter.create(
      { credentials: credentials(fake.privateKeyPem, { environment: "production" }) },
      {
        fetch: (async (url: string) => {
          seen.push(String(url));
          return new Response("{}", { status: 400 });
        }) as unknown as typeof fetch,
        now: () => new Date(),
      },
    );
    await port.verifyCredentials();
    expect(seen[0]).toBe("https://account.docusign.com/oauth/token");
  });

  it("caches the token until 5 minutes before expiry, then refreshes", async () => {
    let t = Date.parse("2026-09-25T12:00:00Z");
    const { fake, port } = build({ now: () => new Date(t), expiresIn: 3600 });
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    await port.status(providerRef);
    await port.status(providerRef);
    expect(fake.tokenRequests()).toBe(1);
    t += 54 * 60 * 1000; // 6 min before expiry: still cached
    await port.status(providerRef);
    expect(fake.tokenRequests()).toBe(1);
    t += 2 * 60 * 1000; // 4 min before expiry: refresh
    await port.status(providerRef);
    expect(fake.tokenRequests()).toBe(2);
    // userinfo (base URI) is cached for the port's life
    expect(fake.calls.filter((c) => c.url.endsWith("/oauth/userinfo"))).toHaveLength(1);
  });

  it("deduplicates concurrent token requests", async () => {
    const { fake, port } = build();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    fake.revokeTokens();
    await Promise.all([
      port.status(providerRef),
      port.status(providerRef),
      port.status(providerRef),
    ]);
    expect(fake.tokenRequests()).toBe(2);
  });

  it("drops a revoked token and retries once", async () => {
    const { fake, port } = build();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    fake.revokeTokens();
    await expect(port.status(providerRef)).resolves.toMatchObject({ status: "sent" });
    expect(fake.tokenRequests()).toBe(2);
  });

  it("reports a bad PEM as misconfigured without echoing it", async () => {
    const { port } = build({
      creds: { privateKeyPem: "-----BEGIN PRIVATE KEY-----\nc2VjcmV0\n-----END PRIVATE KEY-----" },
    });
    const result = await port.verifyCredentials();
    expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
    expect(JSON.stringify(result)).not.toContain("c2VjcmV0");
  });

  it("verifyCredentials names the account", async () => {
    const { port } = build();
    await expect(port.verifyCredentials()).resolves.toEqual({ ok: true, account: "Acme Ventures" });
  });

  it("verifyCredentials refuses an account id the user cannot reach", async () => {
    const { port } = build({ creds: { accountId: "not-mine" } });
    await expect(port.verifyCredentials()).resolves.toMatchObject({
      ok: false,
      reason: "unauthorized",
    });
  });
});

describe("docusign base URI validation", () => {
  it.each([
    ["https://demo.docusign.net", "https://demo.docusign.net"],
    ["https://NA4.DocuSign.net/", "https://na4.docusign.net"],
    ["https://eu.docusign.net/restapi", "https://eu.docusign.net"],
  ])("accepts %s", (raw, origin) => {
    expect(validateBaseUri(raw)).toBe(origin);
  });

  it.each([
    "http://demo.docusign.net",
    "https://docusign.net.evil.example",
    "https://evil-docusign.net",
    "https://demo.docusign.net:8443",
    "https://user:pw@demo.docusign.net",
    "https://docusign.net",
    "https://169.254.169.254",
    "not a url",
    42,
    undefined,
  ])("rejects %s", (raw) => {
    expect(validateBaseUri(raw)).toBeUndefined();
  });

  it("never sends the bearer token to a base URI that fails validation", async () => {
    const { fake, port } = build({ baseUri: "https://attacker.example" });
    const err = await port.createEnvelope(pdfEnvelope()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ESignProviderError);
    expect((err as ESignProviderError).code).toBe("invalid_response");
    expect(fake.calls.some((c) => c.url.includes("attacker.example"))).toBe(false);
    await expect(port.verifyCredentials()).resolves.toMatchObject({
      ok: false,
      reason: "misconfigured",
    });
  });
});

describe("docusign envelopes", () => {
  it("maps field fractions to points on the PDF's page size and tags signer keys", async () => {
    const { fake, port } = build();
    const input = pdfEnvelope();
    const { providerRef } = await port.createEnvelope(input);
    const def = fake.vendor.created().find((c) => c.providerRef === providerRef)
      ?.input as SentDefinition;
    expect(def.status).toBe("sent");
    expect(def.customFields.textCustomFields[0]).toMatchObject({
      name: "seedhost_external_id",
      value: input.externalId,
    });
    const signer = def.recipients.signers[0] as SentSigner;
    expect(signer).toMatchObject({ recipientId: "1", routingOrder: "1", clientUserId: "s1" });
    expect(signer.customFields).toEqual(["seedhost_signer_key=s1"]);
    expect(def.documents[0]?.documentBase64.length).toBeGreaterThan(10);
    // tinyPdf is US Letter or A4; whichever, positions are fractions of the detected page.
    const size = detectPageSize((input.document as { bytes: Uint8Array }).bytes).size;
    expect(signer.tabs.signHereTabs[0]).toEqual({
      documentId: "1",
      pageNumber: "1",
      xPosition: String(Math.round(0.1 * size.width)),
      yPosition: String(Math.round(0.8 * size.height)),
    });
    expect(signer.tabs.dateSignedTabs[0]?.["width"]).toBe(String(Math.round(0.2 * size.width)));
    expect(signer.tabs.fullNameTabs).toHaveLength(1);
  });

  it("does not make remote (emailed) signers captive", async () => {
    const { fake, port } = build();
    const { providerRef } = await port.createEnvelope(pdfEnvelope({ embedded: false }));
    const def = fake.vendor.created().find((c) => c.providerRef === providerRef)
      ?.input as SentDefinition;
    expect(def.recipients.signers[0]?.clientUserId).toBeUndefined();
    await expect(
      port.signingUrl(providerRef, "s1", "https://portal.example.com"),
    ).resolves.toBeUndefined();
  });

  it("sends templates with roles + textTabs prefill and maps roles back to signer keys", async () => {
    const { fake, port } = build();
    const input = templateEnvelope(FAKE.templateId, FAKE.templateRole);
    const { providerRef } = await port.createEnvelope(input);
    const def = fake.vendor.created().find((c) => c.providerRef === providerRef)
      ?.input as SentDefinition;
    expect(def.templateId).toBe(FAKE.templateId);
    expect(def.templateRoles[0]).toMatchObject({
      roleName: "Signer",
      name: "Ada Lovelace",
      email: "ada@example.com",
      tabs: {
        textTabs: [
          { tabLabel: "investor_name", value: "Ada Lovelace" },
          { tabLabel: "amount", value: "$25,000" },
        ],
      },
    });
    expect(def.customFields.textCustomFields).toContainEqual({
      name: "seedhost_roles",
      value: "Signer=s1",
      show: "false",
      required: "false",
    });
    fake.vendor.view(providerRef);
    const state = await port.status(providerRef);
    expect(state).toMatchObject({
      status: "delivered",
      signers: [{ signerKey: "s1", status: "viewed" }],
    });
  });

  it("refuses template signers without a role and fields for unknown signers", async () => {
    const { port } = build();
    const input = templateEnvelope(FAKE.templateId, FAKE.templateRole);
    await expect(
      port.createEnvelope({
        ...input,
        signers: [{ signerKey: "s1", name: "A", email: "a@example.com", order: 1 }],
      }),
    ).rejects.toMatchObject({ code: "rejected" });
    const pdf = pdfEnvelope();
    await expect(
      port.createEnvelope({
        ...pdf,
        document: {
          ...(pdf.document as PdfSource),
          fields: [{ signerKey: "s9", kind: "signature", page: 1, x: 0, y: 0, w: 0.1, h: 0.1 }],
        },
      }),
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("maps voided to voided, and voided-because-expired to expired", async () => {
    const { fake, port } = build();
    const a = await port.createEnvelope(pdfEnvelope());
    fake.vendor.voidFromVendor(a.providerRef);
    await expect(port.status(a.providerRef)).resolves.toMatchObject({ status: "voided" });
    const b = await port.createEnvelope(pdfEnvelope());
    await port.void(b.providerRef, "Envelope has expired.");
    await expect(port.status(b.providerRef)).resolves.toMatchObject({ status: "expired" });
  });

  it("refuses an oversize document by Content-Length", async () => {
    const { fake, port } = build({ documentBytes: 100_000 });
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    fake.vendor.complete(providerRef);
    await expect(port.downloadSigned(providerRef, { maxBytes: 99_999 })).rejects.toMatchObject({
      code: "too_large",
    });
    const ok = await port.downloadSigned(providerRef, { maxBytes: 100_000 });
    expect(ok.document.byteLength).toBe(100_000);
    expect(ok.certificate).toBeDefined();
  });

  it("refuses an oversize document while streaming (no Content-Length)", async () => {
    const fake = createFakeDocusign({ documentBytes: 100_000 });
    const stripped = (async (url: string, init?: RequestInit) => {
      const res = await fake.fetch(url, init);
      if (!String(url).includes("/documents/")) return res;
      const body = new Uint8Array(await res.arrayBuffer());
      let sent = false;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) return controller.close();
          sent = true;
          for (let i = 0; i < body.byteLength; i += 8192)
            controller.enqueue(body.subarray(i, i + 8192));
        },
      });
      return new Response(stream, { status: res.status });
    }) as unknown as typeof fetch;
    const port = docusignAdapter.create(
      { credentials: credentials(fake.privateKeyPem) },
      { fetch: stripped, now: () => new Date() },
    );
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    fake.vendor.complete(providerRef);
    await expect(port.downloadSigned(providerRef, { maxBytes: 99_999 })).rejects.toMatchObject({
      code: "too_large",
    });
    await expect(port.downloadSigned(providerRef, { maxBytes: 100_000 })).resolves.toBeDefined();
  });

  it("maps HTTP failures to provider error codes without leaking vendor messages", async () => {
    const cases: [number, string, boolean][] = [
      [403, "unauthorized", false],
      [404, "not_found", false],
      [400, "rejected", false],
      [409, "rejected", false],
      [422, "rejected", false],
      [429, "rate_limited", true],
      [500, "unavailable", true],
      [503, "unavailable", true],
    ];
    for (const [status, code, retryable] of cases) {
      const { fake, port } = build();
      const { providerRef } = await port.createEnvelope(pdfEnvelope());
      fake.failNext(status);
      const err = (await port.status(providerRef).catch((e: unknown) => e)) as ESignProviderError;
      expect(err).toBeInstanceOf(ESignProviderError);
      expect([err.code, err.retryable, err.status]).toEqual([code, retryable, status]);
      expect(err.message).toContain("[INJECTED]");
      expect(err.message).not.toContain("hunter2");
    }
  });

  it("maps network failures to unavailable and bad JSON to invalid_response", async () => {
    const { fake } = build();
    const net = docusignAdapter.create(
      { credentials: credentials(fake.privateKeyPem) },
      {
        fetch: (async () => {
          throw new TypeError("fetch failed: ECONNRESET 10.0.0.1");
        }) as unknown as typeof fetch,
        now: () => new Date(),
      },
    );
    await expect(net.status("abc")).rejects.toMatchObject({ code: "unavailable", retryable: true });
    await expect(net.verifyCredentials()).resolves.toMatchObject({
      ok: false,
      reason: "unreachable",
    });
    const bad = docusignAdapter.create(
      { credentials: credentials(fake.privateKeyPem) },
      {
        fetch: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
        now: () => new Date(),
      },
    );
    await expect(bad.status("abc")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("never puts the private key or tokens in error messages", async () => {
    const { fake, port } = build();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    fake.failNext(500);
    const err = (await port.status(providerRef).catch((e: unknown) => e)) as Error;
    const tokenCall = fake.calls.find((c) => c.headers.get("authorization"));
    const token = tokenCall?.headers.get("authorization")?.slice(7) ?? "";
    expect(token.length).toBeGreaterThan(5);
    expect(err.message).not.toContain(token);
    expect(err.message).not.toContain("PRIVATE KEY");
  });
});

describe("docusign Connect HMAC", () => {
  const body = new TextEncoder().encode(
    '{"event":"envelope-completed","data":{"envelopeId":"6d3c2b1a-0000-4000-8000-000000000001"}}',
  );

  it("matches a known HMAC-SHA256 base64 vector", () => {
    // RFC 4231 test case 2: key "Jefe", data "what do ya want for nothing?"
    expect(hmacHeader("Jefe", new TextEncoder().encode("what do ya want for nothing?"))).toBe(
      Buffer.from(
        "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
        "hex",
      ).toString("base64"),
    );
  });

  it("accepts a match in any signature header, from either configured key (rotation)", async () => {
    const { port } = build({
      creds: { connectHmacKey: "old-key", connectHmacKeySecondary: "new-key" },
    });
    for (const [n, key] of [
      [1, "old-key"],
      [2, "new-key"],
      [7, "old-key"],
    ] as const) {
      const headers = new Headers({ "x-docusign-signature-1": hmacHeader("unrelated", body) });
      headers.set(`x-docusign-signature-${n}`, hmacHeader(key, body));
      await expect(port.parseCallback({ headers, body })).resolves.toEqual({
        event: "envelope-completed",
        providerRef: "6d3c2b1a-0000-4000-8000-000000000001",
      });
    }
    const wrong = new Headers({ "x-docusign-signature-1": hmacHeader("third-key", body) });
    await expect(port.parseCallback({ headers: wrong, body })).resolves.toBeUndefined();
  });

  it("answers undefined when no key is configured", async () => {
    const { port } = build({ creds: { connectHmacKey: "" } });
    const headers = new Headers({ "x-docusign-signature-1": hmacHeader("", body) });
    await expect(port.parseCallback({ headers, body })).resolves.toBeUndefined();
  });

  it("reads the envelope id from a legacy XML payload", async () => {
    const { port } = build();
    const xml = new TextEncoder().encode(
      "<DocuSignEnvelopeInformation><EnvelopeStatus><EnvelopeID>6d3c2b1a-0000-4000-8000-000000000002</EnvelopeID></EnvelopeStatus></DocuSignEnvelopeInformation>",
    );
    const headers = new Headers({ "x-docusign-signature-1": hmacHeader(FAKE.hmacKey, xml) });
    await expect(port.parseCallback({ headers, body: xml })).resolves.toEqual({
      event: "xml",
      providerRef: "6d3c2b1a-0000-4000-8000-000000000002",
    });
  });

  it("drops a malformed envelope id from an authentic body", async () => {
    const { port } = build();
    const b = new TextEncoder().encode('{"event":"envelope-sent","data":{"envelopeId":"../../x"}}');
    const headers = new Headers({ "x-docusign-signature-1": hmacHeader(FAKE.hmacKey, b) });
    await expect(port.parseCallback({ headers, body: b })).resolves.toEqual({
      event: "envelope-sent",
    });
  });
});

describe("pdf page size detection", () => {
  const enc = (s: string) => new TextEncoder().encode(s);

  it("reads a plain MediaBox", () => {
    expect(
      detectPageSize(
        enc("%PDF-1.7\n3 0 obj << /Type /Page /MediaBox [0 0 595.28 841.89] >> endobj"),
      ),
    ).toEqual({
      size: { width: 595.28, height: 841.89 },
      mixed: false,
      found: true,
    });
  });

  it("reads a MediaBox inside a Flate object stream", () => {
    const inner = deflateSync(
      Buffer.from("<< /Type /Page /MediaBox [ 0 0 842 595 ] /Parent 2 0 R >>"),
    );
    const head = Buffer.from(
      `%PDF-1.7\n5 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /Length ${inner.length} >>\nstream\n`,
    );
    const tail = Buffer.from("\nendstream\nendobj\n%%EOF");
    const r = detectPageSize(new Uint8Array(Buffer.concat([head, inner, tail])));
    expect(r).toEqual({ size: { width: 842, height: 595 }, mixed: false, found: true });
  });

  it("falls back to US Letter and flags mixed sizes", () => {
    expect(detectPageSize(enc("%PDF-1.4 nothing here"))).toEqual({
      size: { width: 612, height: 792 },
      mixed: false,
      found: false,
    });
    const mixed = detectPageSize(enc("/MediaBox [0 0 612 792] /MediaBox [0 0 792 612]"));
    expect(mixed).toMatchObject({ size: { width: 612, height: 792 }, mixed: true });
  });

  it("survives garbage and truncated streams", () => {
    const junk = enc(
      "%PDF-1.7\n1 0 obj << /Type /ObjStm /Filter /FlateDecode >>\nstream\nÿþ garbage\nendstream\n",
    );
    expect(detectPageSize(junk).found).toBe(false);
    expect(detectPageSize(new Uint8Array()).found).toBe(false);
  });

  it("rejects out-of-range geometry", () => {
    expect(() =>
      tabsFor([{ signerKey: "s1", kind: "signature", page: 0, x: 0, y: 0, w: 0, h: 0 }], {
        width: 1,
        height: 1,
      }),
    ).toThrow(ESignProviderError);
    expect(() =>
      tabsFor([{ signerKey: "s1", kind: "signature", page: 1, x: 1.5, y: 0, w: 0, h: 0 }], {
        width: 1,
        height: 1,
      }),
    ).toThrow(ESignProviderError);
  });
});
