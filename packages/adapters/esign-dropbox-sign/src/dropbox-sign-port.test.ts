import { describeESignPortContract, pdfEnvelope, templateEnvelope } from "@fundroom/esign/testing";
import { type ESignAdapterDeps, ESignProviderError } from "@fundroom/ports";
import { describe, expect, it, vi } from "vitest";
import {
  detectPageSize,
  dropboxSignAdapter,
  formFieldsFor,
  mapSignatureRequest,
  multipartField,
} from "./index.js";
import {
  createFakeDropboxSign,
  eventHash,
  FAKE,
  type FakeDropboxSignOptions,
  multipartBody,
} from "./testing/fake-dropbox-sign.js";

function build(
  options: FakeDropboxSignOptions & { apiKey?: string; testMode?: string; now?: () => Date } = {},
) {
  const fake = createFakeDropboxSign(options);
  const warn = vi.fn();
  const deps: ESignAdapterDeps = {
    fetch: fake.fetch,
    now: options.now ?? (() => new Date()),
    log: { warn },
  };
  const port = dropboxSignAdapter.create(
    {
      credentials: { apiKey: options.apiKey ?? FAKE.apiKey, testMode: options.testMode ?? "test" },
    },
    deps,
  );
  return { fake, port, warn };
}

describeESignPortContract(
  "dropbox-sign (scripted fetch)",
  async (opts) => {
    const { fake, port } = build(opts?.credentials === "invalid" ? { apiKey: "wrong-key" } : {});
    return { port, vendor: fake.vendor, cleanup: async () => {} };
  },
  {
    supports: dropboxSignAdapter.meta.supports,
    templateRef: FAKE.templateId,
    templateRole: FAKE.templateRole,
  },
);

describe("dropbox-sign requests", () => {
  it("authenticates with basic auth (API key, empty password) and verifies via /account", async () => {
    const { fake, port } = build();
    await expect(port.verifyCredentials()).resolves.toEqual({
      ok: true,
      account: "founder@example.com",
    });
    expect(fake.calls[0]?.url).toBe("https://api.hellosign.com/v3/account");
    expect(fake.calls[0]?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`${FAKE.apiKey}:`).toString("base64")}`,
    );
    const { port: bad } = build({ apiKey: "nope" });
    await expect(bad.verifyCredentials()).resolves.toMatchObject({
      ok: false,
      reason: "unauthorized",
    });
    const { port: none } = build({ apiKey: "" });
    await expect(none.verifyCredentials()).resolves.toMatchObject({
      ok: false,
      reason: "unauthorized",
    });
  });

  it("sends a PDF as multipart with signers, metadata, 72-DPI form fields and test_mode", async () => {
    const { fake, port } = build();
    const input = pdfEnvelope();
    const { providerRef } = await port.createEnvelope(input);
    const got = fake.vendor.created().find((c) => c.providerRef === providerRef)?.input as Record<
      string,
      unknown
    >;
    expect(got["signers[0][name]"]).toBe("Ada Lovelace");
    expect(got["signers[0][email_address]"]).toBe("ada@example.com");
    expect(got["signers[0][order]"]).toBeUndefined(); // single signer: no order
    expect(got["metadata[seedhost_external_id]"]).toBe(input.externalId);
    expect(got["metadata[seedhost_signers]"]).toBe('[["s1",null]]');
    expect(got["test_mode"]).toBe("1");
    expect(got["signing_redirect_url"]).toBe("https://portal.example.com/esign/done");
    expect(got["files[0]"]).toMatchObject({ type: "application/pdf" });
    const size = detectPageSize((input.document as { bytes: Uint8Array }).bytes).size;
    const fields = JSON.parse(String(got["form_fields_per_document"])) as Record<string, unknown>[];
    expect(fields[0]).toMatchObject({
      document_index: 0,
      type: "signature",
      signer: 0,
      page: 1,
      required: true,
      x: Math.round(0.1 * size.width),
      y: Math.round(0.8 * size.height),
      width: Math.round(0.3 * size.width * (80 / 72)),
    });
    expect(fields.map((f) => f["type"])).toEqual(["signature", "date_signed", "text"]);
  });

  it("orders multiple signers 0-based and maps them back by order", async () => {
    const { fake, port } = build({ testMode: "live" });
    const input = pdfEnvelope({
      signers: [
        { signerKey: "s2", name: "Grace", email: "grace@example.com", order: 2 },
        { signerKey: "s1", name: "Ada", email: "ada@example.com", order: 1 },
      ],
    });
    const { providerRef } = await port.createEnvelope(input);
    const got = fake.vendor.created().at(-1)?.input as Record<string, unknown>;
    expect([
      got["signers[0][email_address]"],
      got["signers[0][order]"],
      got["signers[1][order]"],
    ]).toEqual(["ada@example.com", "0", "1"]);
    expect(got["test_mode"]).toBe("0");
    fake.vendor.view(providerRef);
    const state = await port.status(providerRef);
    expect(state.status).toBe("delivered");
    expect(state.signers.map((s) => [s.signerKey, s.status])).toEqual([
      ["s1", "viewed"],
      ["s2", "viewed"],
    ]);
  });

  it("sends templates as JSON with roles, custom_fields prefill and metadata; maps by role", async () => {
    const { fake, port } = build();
    const input = templateEnvelope(FAKE.templateId, FAKE.templateRole);
    const { providerRef } = await port.createEnvelope(input);
    const got = fake.vendor.created().at(-1)?.input as Record<string, unknown>;
    expect(got).toMatchObject({
      template_ids: [FAKE.templateId],
      signers: [{ role: "Signer", name: "Ada Lovelace", email_address: "ada@example.com" }],
      custom_fields: [
        { name: "investor_name", value: "Ada Lovelace" },
        { name: "amount", value: "$25,000" },
      ],
      metadata: { seedhost_external_id: input.externalId, seedhost_signers: '[["s1","Signer"]]' },
      test_mode: true,
    });
    fake.vendor.complete(providerRef);
    await expect(port.status(providerRef)).resolves.toMatchObject({
      status: "completed",
      signers: [{ signerKey: "s1", status: "signed" }],
    });
  });

  it("refuses template signers without a role", async () => {
    const { port } = build();
    const input = templateEnvelope(FAKE.templateId, FAKE.templateRole);
    await expect(
      port.createEnvelope({
        ...input,
        signers: [{ signerKey: "s1", name: "A", email: "a@example.com", order: 1 }],
      }),
    ).rejects.toMatchObject({ code: "rejected" });
  });

  it("maps expiry and never offers a signing URL", async () => {
    const { fake, port } = build();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    fake.vendor.expire(providerRef);
    await expect(port.status(providerRef)).resolves.toMatchObject({ status: "expired" });
    await expect(port.signingUrl(providerRef, "s1", "https://x.example")).resolves.toBeUndefined();
  });

  it("status mapping table", () => {
    const now = new Date("2026-09-25T00:00:00Z");
    const base = { signatures: [{ status_code: "awaiting_signature" }] };
    expect(mapSignatureRequest(base, now).status).toBe("sent");
    expect(mapSignatureRequest({ ...base, is_declined: true, is_complete: true }, now).status).toBe(
      "declined",
    );
    expect(mapSignatureRequest({ ...base, is_complete: true }, now).status).toBe("completed");
    expect(mapSignatureRequest({ ...base, expires_at: now.getTime() / 1000 - 1 }, now).status).toBe(
      "expired",
    );
    expect(
      mapSignatureRequest({ ...base, expires_at: now.getTime() / 1000 + 60 }, now).status,
    ).toBe("sent");
    expect(mapSignatureRequest({ signatures: [{ last_viewed_at: 1 }] }, now).status).toBe(
      "delivered",
    );
    expect(mapSignatureRequest({ ...base, has_error: true }, now)).toEqual({
      status: "sent",
      vendorError: true,
    });
  });

  it("treats 409 on files as 'still preparing' (retryable) and enforces maxBytes", async () => {
    const { fake, port } = build({ filesPreparing: 1, documentBytes: 50_000 });
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    fake.vendor.complete(providerRef);
    await expect(port.downloadSigned(providerRef, { maxBytes: 1_000_000 })).rejects.toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    await expect(port.downloadSigned(providerRef, { maxBytes: 49_999 })).rejects.toMatchObject({
      code: "too_large",
    });
    const ok = await port.downloadSigned(providerRef, { maxBytes: 50_000 });
    expect(ok.document.byteLength).toBe(50_000);
    expect(ok.certificate).toBeUndefined();
  });

  it("refuses a download that is not a PDF", async () => {
    const port = dropboxSignAdapter.create(
      { credentials: { apiKey: "k", testMode: "test" } },
      {
        fetch: (async (url: string) =>
          String(url).includes("/files/")
            ? new Response("<html>not a pdf</html>", { status: 200 })
            : new Response(JSON.stringify({ signature_request: { is_complete: true } }), {
                status: 200,
              })) as unknown as typeof fetch,
        now: () => new Date(),
      },
    );
    await expect(port.downloadSigned("abc", { maxBytes: 1000 })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("maps HTTP errors without leaking vendor messages or the API key", async () => {
    const cases: [number, string, boolean][] = [
      [401, "unauthorized", false],
      [403, "unauthorized", false],
      [404, "not_found", false],
      [400, "rejected", false],
      [409, "rejected", false],
      [422, "rejected", false],
      [429, "rate_limited", true],
      [500, "unavailable", true],
      [502, "unavailable", true],
    ];
    for (const [status, code, retryable] of cases) {
      const { fake, port } = build();
      const { providerRef } = await port.createEnvelope(pdfEnvelope());
      fake.failNext(status);
      const err = (await port.status(providerRef).catch((e: unknown) => e)) as ESignProviderError;
      expect(err).toBeInstanceOf(ESignProviderError);
      expect([err.code, err.retryable, err.status]).toEqual([code, retryable, status]);
      expect(err.message).toContain("[injected_failure]");
      expect(err.message).not.toContain(FAKE.apiKey);
    }
  });

  it("maps network failures to unavailable and bad JSON to invalid_response", async () => {
    const net = dropboxSignAdapter.create(
      { credentials: { apiKey: "k" } },
      {
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as unknown as typeof fetch,
        now: () => new Date(),
      },
    );
    await expect(net.status("abc")).rejects.toMatchObject({ code: "unavailable", retryable: true });
    await expect(net.verifyCredentials()).resolves.toMatchObject({
      ok: false,
      reason: "unreachable",
    });
    const bad = dropboxSignAdapter.create(
      { credentials: { apiKey: "k" } },
      {
        fetch: (async () => new Response("{oops", { status: 200 })) as unknown as typeof fetch,
        now: () => new Date(),
      },
    );
    await expect(bad.status("abc")).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("void is idempotent on an already-cancelled request", async () => {
    const { port } = build();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    await port.void(providerRef, "first");
    await expect(port.void(providerRef, "again")).resolves.toBeUndefined();
    await expect(port.status(providerRef)).resolves.toMatchObject({ status: "voided" });
  });

  it("rejects malformed references before calling the vendor", async () => {
    const { fake, port } = build();
    await expect(port.status("../account")).rejects.toMatchObject({ code: "not_found" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("dropbox-sign callbacks", () => {
  it("event_hash matches the documented recipe (hex HMAC-SHA256 of event_time+event_type)", () => {
    // echo -n "1348177752signature_request_sent" | openssl dgst -sha256 -hmac "Jefe"
    expect(eventHash("Jefe", "1348177752", "signature_request_sent")).toMatch(/^[0-9a-f]{64}$/);
    // RFC 4231 test case 2 via the same function: key "Jefe", data "what do ya want for nothing?"
    expect(eventHash("Jefe", "what do ya want ", "for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("returns the request id and externalId for an authentic callback", async () => {
    const { fake, port } = build();
    const input = pdfEnvelope();
    const { providerRef } = await port.createEnvelope(input);
    await expect(
      port.parseCallback(fake.vendor.callback(providerRef, "completed")),
    ).resolves.toEqual({
      event: "signature_request_all_signed",
      providerRef,
      externalId: input.externalId,
    });
  });

  it("accepts the account-level callback_test event (no request)", async () => {
    const { port } = build();
    const t = String(Math.floor(Date.now() / 1000));
    const payload = {
      event: {
        event_time: t,
        event_type: "callback_test",
        event_hash: eventHash(FAKE.apiKey, t, "callback_test"),
      },
    };
    const req = multipartBody({ json: JSON.stringify(payload) });
    await expect(port.parseCallback(req)).resolves.toEqual({ event: "callback_test" });
  });

  it("bounds event_time: ≤ 5 min in the future, ≤ 72 h in the past", async () => {
    const now = Date.parse("2026-09-25T12:00:00Z");
    const { fake, port } = build({ now: () => new Date(now) });
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    const s = Math.floor(now / 1000);
    const at = (t: number) => port.parseCallback(fake.vendor.callbackAt(providerRef, String(t)));
    await expect(at(s + 299)).resolves.toBeDefined();
    await expect(at(s + 301)).resolves.toBeUndefined();
    await expect(at(s - 71 * 3600)).resolves.toBeDefined();
    await expect(at(s - 73 * 3600)).resolves.toBeUndefined();
  });

  it("rejects a hash made with another key, a non-hex hash, and a wrong field name", async () => {
    const { fake, port } = build();
    const { providerRef } = await port.createEnvelope(pdfEnvelope());
    await expect(
      port.parseCallback(fake.vendor.forgedCallback(providerRef)),
    ).resolves.toBeUndefined();
    const t = String(Math.floor(Date.now() / 1000));
    const bad = { event: { event_time: t, event_type: "x", event_hash: "zz".repeat(32) } };
    await expect(
      port.parseCallback(multipartBody({ json: JSON.stringify(bad) })),
    ).resolves.toBeUndefined();
    const good = {
      event: {
        event_time: t,
        event_type: "callback_test",
        event_hash: eventHash(FAKE.apiKey, t, "callback_test"),
      },
    };
    await expect(
      port.parseCallback(multipartBody({ payload: JSON.stringify(good) })),
    ).resolves.toBeUndefined();
    // same JSON as a raw application/json body is accepted
    await expect(
      port.parseCallback({
        headers: new Headers({ "content-type": "application/json" }),
        body: new TextEncoder().encode(JSON.stringify(good)),
      }),
    ).resolves.toEqual({ event: "callback_test" });
  });
});

describe("multipart parsing", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  const ct = "multipart/form-data; boundary=XyZ";

  it("extracts a named field among several, keeping UTF-8", () => {
    const body = enc(
      '--XyZ\r\nContent-Disposition: form-data; name="other"\r\n\r\nnope\r\n--XyZ\r\nContent-Disposition: form-data; name="json"\r\nContent-Type: application/json\r\n\r\n{"a":"é–"}\r\n--XyZ--\r\n',
    );
    expect(multipartField(ct, body, "json")).toBe('{"a":"é–"}');
    expect(multipartField('multipart/form-data; boundary="XyZ"', body, "json")).toBe('{"a":"é–"}');
  });

  it("refuses truncated bodies, missing boundaries, wrong types and oversize input", () => {
    const body = enc(
      '--XyZ\r\nContent-Disposition: form-data; name="json"\r\n\r\n{}\r\n--XyZ--\r\n',
    );
    expect(multipartField(ct, body.subarray(0, body.byteLength - 10), "json")).toBeUndefined();
    // complete json part, but the body was cut inside a later part (no closing delimiter)
    const cut = enc(
      '--XyZ\r\nContent-Disposition: form-data; name="json"\r\n\r\n{}\r\n--XyZ\r\nContent-Disposition: form-data; name="x"\r\n\r\nab',
    );
    expect(multipartField(ct, cut, "json")).toBeUndefined();
    expect(multipartField("multipart/form-data", body, "json")).toBeUndefined();
    expect(multipartField("application/x-www-form-urlencoded", body, "json")).toBeUndefined();
    expect(multipartField(null, body, "json")).toBeUndefined();
    expect(multipartField("multipart/form-data; boundary=Other", body, "json")).toBeUndefined();
    expect(multipartField(ct, new Uint8Array(1024 * 1024 + 1), "json")).toBeUndefined();
    expect(multipartField(ct, new Uint8Array(), "json")).toBeUndefined();
    expect(multipartField(ct, enc("--XyZ\r\ngarbage--XyZ--"), "json")).toBeUndefined();
  });

  it("does not match a field whose name merely contains the wanted name", () => {
    const body = enc(
      '--XyZ\r\nContent-Disposition: form-data; name="notjson"\r\n\r\n{}\r\n--XyZ--\r\n',
    );
    expect(multipartField(ct, body, "json")).toBeUndefined();
  });
});

describe("form field geometry", () => {
  it("rejects unknown signers and out-of-range geometry", () => {
    const idx = new Map([["s1", 0]]);
    const size = { width: 612, height: 792 };
    expect(() =>
      formFieldsFor(
        [{ signerKey: "s2", kind: "signature", page: 1, x: 0, y: 0, w: 0, h: 0 }],
        idx,
        size,
      ),
    ).toThrow(ESignProviderError);
    expect(() =>
      formFieldsFor(
        [{ signerKey: "s1", kind: "signature", page: 1, x: -0.1, y: 0, w: 0, h: 0 }],
        idx,
        size,
      ),
    ).toThrow(ESignProviderError);
  });
});
