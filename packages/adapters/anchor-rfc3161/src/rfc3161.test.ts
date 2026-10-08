import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { describeAuditAnchorPortContract } from "@fundroom/audit/testing";
import { createOutboundHttp, type OutboundHttp } from "@fundroom/outbound-http";
import { AnchorError, type AnchorReceipt } from "@fundroom/ports";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildTimeStampRequest,
  createRfc3161Anchor,
  RFC3161_ANCHOR_KIND,
  verifyRfc3161Receipt,
  verifyTimeStampToken,
} from "./index.js";
import { OID_KP_SERVER_AUTH, type StubTsa, startStubTsa } from "./testing/index.js";
import { OID_KP_TIME_STAMPING } from "./tsp.js";

function guarded(timeoutMs = 5_000): OutboundHttp {
  return createOutboundHttp({
    allowedPrivateHosts: ["127.0.0.1"],
    maxRedirects: 0,
    timeoutMs,
    maxResponseBytes: 4 * 1024 * 1024,
  });
}

async function closedPortUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}/tsr`;
}

function sha(text: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(text).digest());
}

function flipBase64Byte(b64: string, at: number): string {
  const bytes = Buffer.from(b64, "base64");
  const index = at < 0 ? bytes.length + at : at;
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  return bytes.toString("base64");
}

describeAuditAnchorPortContract("rfc3161 (stub TSA)", async () => {
  const tsa = await startStubTsa();
  const other = await startStubTsa({ commonName: "unrelated TSA" });
  const http = guarded();
  const before = tsa.requests;
  const build = (url: string) =>
    createRfc3161Anchor({
      urls: [url],
      trustedPems: [tsa.trustedPem],
      http: http.fetch,
      timeoutMs: 800,
    });
  return {
    port: build(tsa.url),
    trusted: [tsa.trustedPem],
    untrusted: [other.trustedPem],
    tamperProof(receipt: AnchorReceipt): AnchorReceipt {
      // Flip a byte inside the signature (the token's last bytes).
      const token = receipt.proof["token"] as string;
      return { ...receipt, proof: { ...receipt.proof, token: flipBase64Byte(token, -3) } };
    },
    setMode(mode) {
      tsa.control.mode = mode;
    },
    requests: () => before(),
    redirectTargetHits: () => tsa.redirectTargetHits(),
    unreachablePort: () => {
      // Resolved lazily: the port is only used by one test.
      let url = "";
      const pending = closedPortUrl().then((u) => {
        url = u;
      });
      return {
        kind: RFC3161_ANCHOR_KIND,
        async anchor(digest) {
          await pending;
          return build(url).anchor(digest);
        },
        verify: (d, r, t) => build(tsa.url).verify(d, r, t),
      };
    },
    async cleanup() {
      await http.close();
      await tsa.close();
      await other.close();
    },
  };
});

describe("rfc3161 anchor (stub TSA)", () => {
  let http: OutboundHttp;
  const stubs: StubTsa[] = [];
  async function stub(options?: Parameters<typeof startStubTsa>[0]): Promise<StubTsa> {
    const s = await startStubTsa(options);
    stubs.push(s);
    return s;
  }

  beforeAll(() => {
    http = guarded();
  });
  afterAll(async () => {
    await http.close();
  });
  afterEach(async () => {
    await Promise.all(stubs.splice(0).map((s) => s.close()));
  });

  it("builds the exact DER TimeStampReq (SHA-256 imprint, nonce, certReq)", () => {
    const digest = new Uint8Array(32).fill(0xab);
    const nonce = Uint8Array.from([0x41, 1, 2, 3, 4, 5, 6, 7]);
    const der = Buffer.from(buildTimeStampRequest(digest, nonce)).toString("hex");
    expect(der).toBe(
      `30430201013031300d060960864801650304020105000420${"ab".repeat(32)}0208${"4101020304050607"}0101ff`,
    );
  });

  it("anchors and records the TSA, serial, policy and genTime", async () => {
    const tsa = await stub();
    const port = createRfc3161Anchor({
      urls: [tsa.url],
      trustedPems: [tsa.trustedPem],
      http: http.fetch,
      timeoutMs: 2_000,
    });
    const digest = sha("root");
    const receipt = await port.anchor(digest);
    expect(receipt.reference).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/tsr serial [0-9a-f]+$/);
    expect(receipt.proof).toMatchObject({
      v: 1,
      hashAlgorithm: "sha256",
      policy: "1.3.6.1.4.1.99999.3161.1",
    });
    const verified = await verifyRfc3161Receipt(digest, receipt, { pems: [tsa.trustedPem] });
    expect(verified).toMatchObject({ status: "verified", anchoredAt: receipt.anchoredAt });
  });

  it("standalone verify with nothing pinned is unverified_origin", async () => {
    const tsa = await stub();
    const port = createRfc3161Anchor({
      urls: [tsa.url],
      trustedPems: [tsa.trustedPem],
      http: http.fetch,
      timeoutMs: 2_000,
    });
    const digest = sha("x");
    const receipt = await port.anchor(digest);
    expect((await verifyRfc3161Receipt(digest, receipt)).status).toBe("unverified_origin");
  });

  it("verifies a token chained through a pinned root CA, not the root pinned alone as signer", async () => {
    const tsa = await stub({ chain: "ca" });
    const port = createRfc3161Anchor({
      urls: [tsa.url],
      trustedPems: [tsa.trustedPem],
      http: http.fetch,
      timeoutMs: 2_000,
    });
    const digest = sha("chain");
    const receipt = await port.anchor(digest);
    expect((await port.verify(digest, receipt)).status).toBe("verified");
    // Pinning the leaf alone works too; an unrelated root does not.
    expect((await port.verify(digest, receipt, { pems: [tsa.signerPem] })).status).toBe("verified");
    const unrelated = await stub({ chain: "ca" });
    expect((await port.verify(digest, receipt, { pems: [unrelated.trustedPem] })).status).toBe(
      "unverified_origin",
    );
  });

  it("refuses a signer certificate without the timeStamping EKU", async () => {
    const tsa = await stub({ eku: [OID_KP_SERVER_AUTH] });
    const port = createRfc3161Anchor({
      urls: [tsa.url],
      trustedPems: [tsa.trustedPem],
      http: http.fetch,
      timeoutMs: 2_000,
    });
    const error = await port.anchor(sha("eku")).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AnchorError);
    expect((error as AnchorError).code).toBe("verification_failed");
    expect((error as AnchorError).message).toMatch(/timeStamping/);
    const token = await tsa.issue(sha("eku"));
    expect(verifyTimeStampToken(sha("eku"), token, [tsa.trustedPem])).toMatchObject({
      status: "failed",
      detail: expect.stringMatching(/timeStamping/),
    });
  });

  it("requires the signer EKU to be exactly timeStamping and critical (RFC 3161 §2.3)", async () => {
    for (const options of [
      { chain: "ca", eku: [OID_KP_SERVER_AUTH, OID_KP_TIME_STAMPING] },
      { eku: [OID_KP_TIME_STAMPING, OID_KP_SERVER_AUTH] },
      { ekuCritical: false },
    ] as const) {
      const tsa = await stub(options);
      const token = await tsa.issue(sha("eku-strict"));
      expect(
        verifyTimeStampToken(sha("eku-strict"), token, [tsa.trustedPem]),
        JSON.stringify(options),
      ).toMatchObject({
        status: "failed",
        detail: expect.stringMatching(/exactly timeStamping, marked critical/),
      });
    }
  });

  it("reports its time as trusted (genTime is signed by the TSA)", async () => {
    const tsa = await stub();
    const port = createRfc3161Anchor({
      urls: [tsa.url],
      trustedPems: [tsa.trustedPem],
      http: http.fetch,
      timeoutMs: 2_000,
    });
    const receipt = await port.anchor(sha("tt"));
    expect(await port.verify(sha("tt"), receipt)).toMatchObject({
      status: "verified",
      timeTrusted: true,
    });
  });

  it("refuses a token without the ESS signing-certificate attribute", async () => {
    const tsa = await stub({ ess: false });
    const token = await tsa.issue(sha("ess"));
    expect(verifyTimeStampToken(sha("ess"), token, [tsa.trustedPem])).toMatchObject({
      status: "failed",
      detail: expect.stringMatching(/ESS/),
    });
  });

  it("refuses a token whose signer certificate was not valid at genTime", async () => {
    const tsa = await stub({ now: () => new Date(Date.now() + 2 * 365 * 86_400_000) });
    const token = await tsa.issue(sha("late"));
    expect(verifyTimeStampToken(sha("late"), token, [tsa.trustedPem])).toMatchObject({
      status: "failed",
      detail: expect.stringMatching(/not valid at/),
    });
  });

  it("refuses a nonce mismatch and a wrong imprint at anchor time", async () => {
    const tsa = await stub();
    const port = createRfc3161Anchor({
      urls: [tsa.url],
      trustedPems: [tsa.trustedPem],
      http: http.fetch,
      timeoutMs: 2_000,
    });
    tsa.control.mode = "wrong-nonce";
    const nonce = await port.anchor(sha("n")).catch((e: unknown) => e);
    expect(nonce).toMatchObject({
      code: "verification_failed",
      message: expect.stringMatching(/nonce/),
    });
    tsa.control.mode = "wrong-imprint";
    const imprint = await port.anchor(sha("n")).catch((e: unknown) => e);
    expect(imprint).toMatchObject({
      code: "verification_failed",
      message: expect.stringMatching(/imprint/),
    });
  });

  it("maps refusals and junk to codes", async () => {
    const tsa = await stub();
    const port = createRfc3161Anchor({
      urls: [tsa.url],
      trustedPems: [tsa.trustedPem],
      http: http.fetch,
      timeoutMs: 2_000,
    });
    const cases = [
      ["rejection", "rejected"],
      ["granted-without-token", "invalid_response"],
      ["garbage", "invalid_response"],
      ["oversize-chunked", "invalid_response"],
    ] as const;
    for (const [mode, code] of cases) {
      tsa.control.mode = mode;
      const error = await port.anchor(sha(mode)).catch((e: unknown) => e);
      expect(error, mode).toBeInstanceOf(AnchorError);
      expect((error as AnchorError).code, mode).toBe(code);
    }
  });

  it("enforces its own cap and refuses redirects even on an unguarded fetch", async () => {
    const tsa = await stub();
    const port = createRfc3161Anchor({
      urls: [tsa.url],
      trustedPems: [tsa.trustedPem],
      http: fetch,
      timeoutMs: 2_000,
    });
    tsa.control.mode = "oversize";
    expect(await port.anchor(sha("o")).catch((e: unknown) => e)).toMatchObject({
      code: "invalid_response",
    });
    tsa.control.mode = "oversize-chunked";
    expect(await port.anchor(sha("o")).catch((e: unknown) => e)).toMatchObject({
      code: "invalid_response",
    });
    const before = tsa.requests();
    tsa.control.mode = "redirect";
    expect(await port.anchor(sha("r")).catch((e: unknown) => e)).toMatchObject({
      code: "rejected",
    });
    expect(tsa.requests()).toBe(before + 1);
    tsa.control.mode = "hang";
    const fast = createRfc3161Anchor({
      urls: [tsa.url],
      trustedPems: [tsa.trustedPem],
      http: fetch,
      timeoutMs: 300,
    });
    expect(await fast.anchor(sha("h")).catch((e: unknown) => e)).toMatchObject({ code: "timeout" });
  });

  it("falls through to the next TSA and reports every failure when all fail", async () => {
    const down = await stub();
    down.control.mode = "error";
    const up = await stub();
    const both = [down.trustedPem, up.trustedPem];
    const port = createRfc3161Anchor({
      urls: [down.url, up.url],
      trustedPems: both,
      http: http.fetch,
      timeoutMs: 2_000,
    });
    const receipt = await port.anchor(sha("f"));
    expect(receipt.reference.startsWith(up.url)).toBe(true);
    up.control.mode = "rejection";
    const error = await port.anchor(sha("f")).catch((e: unknown) => e);
    expect(error).toMatchObject({
      code: "rejected",
      message: expect.stringMatching(/every TSA failed/),
    });
    expect((error as Error).message).toContain("HTTP 500");
  });

  it("an unpinned TSA's token is refused at anchor time", async () => {
    const tsa = await stub();
    const other = await stub();
    const port = createRfc3161Anchor({
      urls: [tsa.url],
      trustedPems: [other.trustedPem],
      http: http.fetch,
      timeoutMs: 2_000,
    });
    expect(await port.anchor(sha("p")).catch((e: unknown) => e)).toMatchObject({
      code: "verification_failed",
      message: expect.stringMatching(/pinned/),
    });
  });

  describe("offline verification rejects forgeries", () => {
    let tsa: StubTsa;
    let receipt: AnchorReceipt;
    const digest = sha("forgery");
    beforeAll(async () => {
      tsa = await startStubTsa();
      const port = createRfc3161Anchor({
        urls: [tsa.url],
        trustedPems: [tsa.trustedPem],
        http: http.fetch,
        timeoutMs: 2_000,
      });
      receipt = await port.anchor(digest);
    });
    afterAll(async () => {
      await tsa.close();
    });
    const pins = () => ({ pems: [tsa.trustedPem] });

    function reencode(mutate: (sd: pkijs.SignedData, tst: pkijs.TSTInfo) => void): AnchorReceipt {
      const der = Buffer.from(receipt.proof["token"] as string, "base64");
      const ci = pkijs.ContentInfo.fromBER(der);
      const sd = new pkijs.SignedData({ schema: ci.content });
      const eContent = sd.encapContentInfo.eContent as asn1js.OctetString;
      const tst = pkijs.TSTInfo.fromBER(eContent.getValue());
      mutate(sd, tst);
      sd.encapContentInfo.eContent = new asn1js.OctetString({
        valueHex: tst.toSchema().toBER(false),
      });
      const out = new pkijs.ContentInfo({
        contentType: ci.contentType,
        content: sd.toSchema(true),
      });
      return {
        ...receipt,
        proof: {
          ...receipt.proof,
          token: Buffer.from(out.toSchema().toBER(false)).toString("base64"),
        },
      };
    }

    it("the untouched receipt verifies", async () => {
      expect((await verifyRfc3161Receipt(digest, receipt, pins())).status).toBe("verified");
    });

    it("a TSTInfo rewritten to another imprint fails the message-digest", async () => {
      const forged = reencode((_sd, tst) => {
        tst.messageImprint.hashedMessage = new asn1js.OctetString({
          valueHex: sha("other").slice().buffer,
        });
      });
      expect(await verifyRfc3161Receipt(sha("other"), forged, pins())).toMatchObject({
        status: "failed",
        detail: expect.stringMatching(/message-digest/),
      });
    });

    it("a back-dated genTime fails", async () => {
      const forged = reencode((_sd, tst) => {
        tst.genTime = new Date(tst.genTime.getTime() - 3_600_000);
      });
      expect((await verifyRfc3161Receipt(digest, forged, pins())).status).toBe("failed");
    });

    it("a receipt whose anchoredAt was edited fails", async () => {
      const edited = { ...receipt, anchoredAt: new Date(0).toISOString() };
      expect(await verifyRfc3161Receipt(digest, edited, pins())).toMatchObject({
        status: "failed",
        detail: expect.stringMatching(/anchoredAt/),
      });
    });

    it("a token with the certificate swapped for another TSA's fails the ESS binding", async () => {
      const other = await startStubTsa({ commonName: "fundroom stub TSA" });
      try {
        const otherToken = Buffer.from(await other.issue(digest));
        const otherSd = new pkijs.SignedData({
          schema: pkijs.ContentInfo.fromBER(otherToken).content,
        });
        const forged = reencode((sd) => {
          sd.certificates = otherSd.certificates ?? [];
        });
        const result = await verifyRfc3161Receipt(digest, forged, { pems: [other.trustedPem] });
        expect(result.status).toBe("failed");
      } finally {
        await other.close();
      }
    });

    it("junk in the token field fails", async () => {
      for (const token of ["", "!!!", Buffer.from("hello").toString("base64"), 42]) {
        const r = { ...receipt, proof: { ...receipt.proof, token } };
        expect((await verifyRfc3161Receipt(digest, r, pins())).status).toBe("failed");
      }
    });
  });
});

describe.skipIf(process.env["FUNDROOM_TEST_LIVE_ANCHOR"] !== "1")("rfc3161 live TSAs", () => {
  /*
   * Opt-in (`FUNDROOM_TEST_LIVE_ANCHOR=1`): real public TSAs through the guarded client. The pins
   * are fetched from the TSAs' published certificate endpoints at run time (this test checks
   * protocol compatibility, not trust in those endpoints).
   */
  const live = createOutboundHttp({ maxRedirects: 0, timeoutMs: 20_000 });
  afterAll(async () => {
    await live.close();
  });

  async function text(url: string): Promise<string> {
    const res = await live.fetch(url);
    expect(res.ok).toBe(true);
    return await res.text();
  }

  it.each([
    [
      "sigstore",
      "https://timestamp.sigstore.dev/api/v1/timestamp",
      "https://timestamp.sigstore.dev/api/v1/timestamp/certchain",
    ],
    ["freetsa", "https://freetsa.org/tsr", "https://freetsa.org/files/cacert.pem"],
  ])(
    "anchors with %s and verifies offline",
    async (_name, url, pemUrl) => {
      const pem = await text(pemUrl);
      const port = createRfc3161Anchor({
        urls: [url],
        trustedPems: [pem],
        http: live.fetch,
        timeoutMs: 20_000,
      });
      const digest = sha(`fundroom live anchor test ${Date.now()}`);
      const receipt = await port.anchor(digest);
      expect(await port.verify(digest, receipt)).toMatchObject({ status: "verified" });
      const other = digest.slice();
      other[0] = (other[0] ?? 0) ^ 1;
      expect((await port.verify(other, receipt)).status).toBe("failed");
    },
    60_000,
  );
});
