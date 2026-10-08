import { ESignProviderError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { createMemoryESignAdapter, tinyPdf } from "./memory-adapter.js";

const deps = { fetch: globalThis.fetch, now: () => new Date("2026-09-25T12:00:00Z") };
const input = {
  externalId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a",
  title: "NDA",
  document: { kind: "template" as const, templateRef: "t1", prefill: {} },
  signers: [{ signerKey: "s1", name: "Ada", email: "ada@example.com", order: 1 }],
  embedded: true,
};

describe("in-memory e-sign adapter", () => {
  it("creates idempotently by externalId, completes, and serves PDF artifacts", async () => {
    const { definition, vendor } = createMemoryESignAdapter();
    const port = definition.create(
      { credentials: { apiToken: "ok" }, callbackSecret: "s3cret-s3cret" },
      deps,
    );
    expect(await port.verifyCredentials()).toEqual({ ok: true, account: "memory-account" });
    const { providerRef } = await port.createEnvelope(input);
    expect((await port.createEnvelope(input)).providerRef).toBe(providerRef);
    expect(vendor.created()).toHaveLength(1);
    expect((await port.status(providerRef)).status).toBe("sent");
    vendor.complete(providerRef);
    const state = await port.status(providerRef);
    expect(state.status).toBe("completed");
    expect(state.signers[0]?.status).toBe("signed");
    const art = await port.downloadSigned(providerRef, { maxBytes: 1_000_000 });
    expect(new TextDecoder().decode(art.document.slice(0, 5))).toBe("%PDF-");
    await expect(port.downloadSigned(providerRef, { maxBytes: 10 })).rejects.toMatchObject({
      code: "too_large",
    });
  });

  it("authenticates callbacks by the connection secret and never throws on garbage", async () => {
    const { definition, vendor } = createMemoryESignAdapter("docuseal");
    const port = definition.create(
      { credentials: { apiToken: "ok" }, callbackSecret: "s3cret-s3cret" },
      deps,
    );
    const { providerRef } = await port.createEnvelope(input);
    const genuine = vendor.callback(providerRef, "viewed");
    expect(await port.parseCallback(genuine)).toEqual({
      event: "viewed",
      providerRef,
      externalId: input.externalId,
    });
    expect(await port.parseCallback(vendor.forgedCallback(providerRef))).toBeUndefined();
    expect(
      await port.parseCallback({ headers: genuine.headers, body: new Uint8Array() }),
    ).toBeUndefined();
    expect(
      await port.parseCallback({ headers: genuine.headers, body: genuine.body.slice(0, 7) }),
    ).toBeUndefined();
    expect(
      await port.parseCallback({ headers: new Headers(), body: genuine.body }),
    ).toBeUndefined();
  });

  it("rejects invalid credentials and injects failures", async () => {
    const { definition, vendor } = createMemoryESignAdapter();
    const bad = definition.create({ credentials: { apiToken: "invalid" } }, deps);
    expect(await bad.verifyCredentials()).toEqual({ ok: false, reason: "unauthorized" });
    const port = definition.create({ credentials: { apiToken: "ok" } }, deps);
    vendor.failNext(1, "rate_limited");
    const err = await port.createEnvelope(input).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ESignProviderError);
    expect(err).toMatchObject({ code: "rate_limited", retryable: true });
    const { providerRef } = await port.createEnvelope(input);
    await port.void(providerRef, "test");
    expect((await port.status(providerRef)).status).toBe("voided");
    await expect(port.void(providerRef, "again")).rejects.toMatchObject({ code: "rejected" });
  });

  it("tinyPdf is a PDF", () => {
    const text = new TextDecoder().decode(tinyPdf("x"));
    expect(text.startsWith("%PDF-1.4")).toBe(true);
    expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  });
});
