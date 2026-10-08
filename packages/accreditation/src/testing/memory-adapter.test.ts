import { AccreditationProviderError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { createMemoryAccreditationAdapter, memorySignature } from "./memory-adapter.js";

const deps = { fetch: globalThis.fetch, now: () => new Date("2026-09-26T00:00:00Z") };

describe("the memory accreditation vendor", () => {
  it("starts, reports, accredits and serves a certificate (VerifyInvestor shape)", async () => {
    const { definition, vendor } = createMemoryAccreditationAdapter("verifyinvestor");
    const port = definition.create(
      { credentials: { apiToken: "tok", environment: "staging", webhookSecret: "hook" } },
      deps,
    );
    await port.verifyCredentials();
    const started = await port.start({
      verificationId: "v1",
      subject: "individual",
      email: "ada@investor.test",
    });
    expect(started.handoff).toEqual({ kind: "invite_sent" });
    expect((await port.check({ providerRef: started.providerRef })).status).toBe("in_progress");
    expect(await port.fetchEvidence({ providerRef: started.providerRef })).toBeNull();
    vendor.accredit(started.providerRef);
    const check = await port.check({ providerRef: started.providerRef });
    expect(check).toMatchObject({ status: "accredited", vendorStatus: "accredited" });
    const pdf = await port.fetchEvidence({ providerRef: started.providerRef });
    expect(
      Buffer.from(pdf?.bytes ?? [])
        .subarray(0, 5)
        .toString(),
    ).toBe("%PDF-");
    expect(vendor.started()).toHaveLength(1);
  });

  it("hands Parallel Markets a widget built from the connection", async () => {
    const { definition } = createMemoryAccreditationAdapter("parallel-markets");
    const port = definition.create(
      { credentials: { apiKey: "k", clientId: "client-1", environment: "demo" } },
      deps,
    );
    const started = await port.start({
      verificationId: "v1",
      subject: "entity",
      email: "ada@investor.test",
    });
    expect(started.handoff).toMatchObject({
      kind: "widget",
      config: { clientId: "client-1", environment: "demo", entityType: "business" },
    });
  });

  it("refuses bad credentials and injected failures with the port's error", async () => {
    const { definition, vendor } = createMemoryAccreditationAdapter();
    const bad = definition.create({ credentials: { apiToken: "invalid" } }, deps);
    await expect(bad.verifyCredentials()).rejects.toMatchObject({ code: "unauthorized" });
    const good = definition.create({ credentials: { apiToken: "t" } }, deps);
    vendor.failNext(1, "rate_limited");
    const err = await good.verifyCredentials().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccreditationProviderError);
    expect((err as AccreditationProviderError).retryable).toBe(true);
    await good.verifyCredentials();
  });

  it("authenticates a callback only with the webhook secret's HMAC", async () => {
    const { definition, vendor } = createMemoryAccreditationAdapter();
    const port = definition.create({ credentials: { apiToken: "t", webhookSecret: "hook" } }, deps);
    const now = new Date();
    const ok = vendor.callbackRequest(["vr:1"], "hook");
    expect(await port.parseCallback({ ...ok, now })).toEqual({ refs: ["vr:1"] });
    const forged = vendor.callbackRequest(["vr:1"], "wrong");
    expect(await port.parseCallback({ ...forged, now })).toBeUndefined();
    const body = vendor.callbackBody(["vr:2"]);
    const headers = new Headers({ "x-memory-signature": memorySignature("hook", body) });
    expect(await port.parseCallback({ headers, rawBody: body, now })).toEqual({ refs: ["vr:2"] });
    // No webhook secret on the connection: polling only.
    const silent = definition.create({ credentials: { apiToken: "t" } }, deps);
    expect(await silent.parseCallback({ ...ok, now })).toBeUndefined();
  });

  it("holds a call until released", async () => {
    const { definition, vendor } = createMemoryAccreditationAdapter();
    const port = definition.create({ credentials: { apiToken: "t" } }, deps);
    const held = vendor.hold();
    let done = false;
    const call = port.verifyCredentials().then(() => {
      done = true;
    });
    await held.reached;
    expect(done).toBe(false);
    held.release();
    await call;
    expect(done).toBe(true);
  });
});
