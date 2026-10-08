import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer } from "node:net";
import { deriveAnchorSigningKey } from "@fundroom/audit";
import { describeAuditAnchorPortContract } from "@fundroom/audit/testing";
import { createOutboundHttp, type OutboundHttp } from "@fundroom/outbound-http";
import { AnchorError, type AnchorReceipt } from "@fundroom/ports";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createRekorAnchor,
  inclusionPath,
  leafHash,
  merkleRoot,
  REKOR_ANCHOR_KIND,
  type RekorAnchorOptions,
  verifyInclusion,
  verifyRekorReceipt,
} from "./index.js";
import { type StubRekor, startStubRekor } from "./testing/index.js";

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
  return `http://127.0.0.1:${port}`;
}

function sha(text: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(text).digest());
}

const signingKey = deriveAnchorSigningKey({ key: new Uint8Array(randomBytes(32)) });

type Entry = Record<string, unknown> & {
  inclusionProof: { hashes: string[]; checkpoint: { envelope: string } };
  canonicalizedBody: string;
  logIndex: string;
};

function withEntry(receipt: AnchorReceipt, mutate: (entry: Entry) => void): AnchorReceipt {
  const copy = JSON.parse(JSON.stringify(receipt)) as AnchorReceipt;
  mutate(copy.proof["entry"] as Entry);
  return copy;
}

for (const logKey of ["ed25519", "ecdsa"] as const) {
  describeAuditAnchorPortContract(`rekor (stub Rekor v2, ${logKey} log key)`, async () => {
    const log = await startStubRekor({ logKey });
    const http = guarded();
    const build = (url: string) =>
      createRekorAnchor({
        url,
        logPublicKeyPem: log.logPublicKeyPem,
        signingKey,
        http: http.fetch,
        timeoutMs: 800,
      });
    return {
      port: build(log.url),
      trusted: [log.logPublicKeyPem],
      untrusted: [log.otherLogPublicKeyPem],
      tamperProof: (receipt) =>
        withEntry(receipt, (entry) => {
          const hashes = entry.inclusionProof.hashes;
          const first = Buffer.from(hashes[0] as string, "base64");
          first[5] = (first[5] ?? 0) ^ 0x01;
          hashes[0] = first.toString("base64");
        }),
      setMode(mode) {
        log.control.mode = mode;
      },
      requests: () => log.requests(),
      redirectTargetHits: () => log.redirectTargetHits(),
      unreachablePort: () => {
        let url = "";
        const pending = closedPortUrl().then((u) => {
          url = u;
        });
        return {
          kind: REKOR_ANCHOR_KIND,
          async anchor(digest) {
            await pending;
            return build(url).anchor(digest);
          },
          verify: (d, r, t) => build(log.url).verify(d, r, t),
        };
      },
      async cleanup() {
        await http.close();
        await log.close();
      },
    };
  });
}

describe("RFC 6962 inclusion proofs", () => {
  it("verifies every leaf of every tree size up to 33 and rejects off-by-one claims", () => {
    for (let size = 1; size <= 33; size++) {
      const leaves = Array.from({ length: size }, (_, i) => leafHash(Uint8Array.of(i, size)));
      const root = merkleRoot(leaves);
      for (let i = 0; i < size; i++) {
        const path = inclusionPath(i, leaves);
        const leaf = leaves[i] as Uint8Array;
        expect(verifyInclusion(leaf, i, size, path, root), `${i}/${size}`).toBe(true);
        if (size > 1) {
          expect(verifyInclusion(leaf, (i + 1) % size, size, path, root)).toBe(false);
          expect(verifyInclusion(leaf, i, size, path.slice(0, -1), root)).toBe(false);
        }
        expect(verifyInclusion(leaf, i, size, [...path, root], root)).toBe(false);
      }
    }
  });

  it("matches the RFC 6962 MTH of a known tree (empty, 1, 3 leaves)", () => {
    expect(Buffer.from(merkleRoot([])).toString("hex")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    // Hashes from transparency-dev/merkle's RFC 6962 test vectors (leaves "", 0x00, 0x10).
    const leaves = [Uint8Array.of(), Uint8Array.of(0x00), Uint8Array.of(0x10)].map(leafHash);
    expect(Buffer.from(leaves[0] as Uint8Array).toString("hex")).toBe(
      "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
    );
    expect(Buffer.from(merkleRoot(leaves)).toString("hex")).toBe(
      "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
    );
  });
});

describe("rekor anchor (stub Rekor v2)", () => {
  let http: OutboundHttp;
  const logs: StubRekor[] = [];
  async function stub(options?: Parameters<typeof startStubRekor>[0]): Promise<StubRekor> {
    const s = await startStubRekor(options);
    logs.push(s);
    return s;
  }
  function anchor(log: StubRekor, extra: Partial<RekorAnchorOptions> = {}) {
    return createRekorAnchor({
      url: log.url,
      logPublicKeyPem: log.logPublicKeyPem,
      signingKey,
      http: http.fetch,
      timeoutMs: 2_000,
      ...extra,
    });
  }

  beforeAll(() => {
    http = guarded();
  });
  afterAll(async () => {
    await http.close();
  });
  afterEach(async () => {
    await Promise.all(logs.splice(0).map((s) => s.close()));
  });

  it("submits a hashedrekord of SHA-256(root) signed by the P-256 key and stores the whole entry", async () => {
    const log = await stub();
    const at = new Date("2026-10-01T02:40:00.000Z");
    const port = anchor(log, { now: () => at });
    const digest = sha("root");
    const receipt = await port.anchor(digest);
    expect(receipt.anchoredAt).toBe(at.toISOString());
    expect(receipt.reference).toMatch(/^http:\/\/127\.0\.0\.1:\d+ logIndex 5$/);
    const entry = receipt.proof["entry"] as Entry;
    expect(entry.logIndex).toBe("5");
    const body = JSON.parse(Buffer.from(entry.canonicalizedBody, "base64").toString("utf8"));
    expect(body.spec.hashedRekordV002.data).toEqual({
      algorithm: "SHA2_256",
      digest: Buffer.from(createHash("sha256").update(digest).digest()).toString("base64"),
    });
    expect(body.spec.hashedRekordV002.signature.verifier.keyDetails).toBe(
      "PKIX_ECDSA_P256_SHA_256",
    );
    // The checkpoint carries a witness cosignature from an unknown key: ignored, still verified.
    expect(entry.inclusionProof.checkpoint.envelope.split("\n— ").length).toBe(3);
    expect(
      await verifyRekorReceipt(digest, receipt, {
        pems: [log.logPublicKeyPem],
        origins: [log.origin],
      }),
    ).toMatchObject({
      status: "verified",
      anchoredAt: at.toISOString(),
    });
    expect(log.entries()).toBe(1);
  });

  it("is presence-only evidence: verified with timeTrusted false", async () => {
    const log = await stub();
    const port = anchor(log, { now: () => new Date("2025-06-02T00:00:00.000Z") });
    const receipt = await port.anchor(sha("presence"));
    const result = await port.verify(sha("presence"), receipt);
    expect(result).toMatchObject({
      status: "verified",
      timeTrusted: false,
      anchoredAt: "2025-06-02T00:00:00.000Z",
      detail: expect.stringMatching(/no trusted time/),
    });
    expect(
      await verifyRekorReceipt(sha("presence"), receipt, {
        pems: [log.logPublicKeyPem],
        origins: [log.origin],
      }),
    ).toMatchObject({
      status: "verified",
      timeTrusted: false,
    });
  });

  it("binds the checkpoint origin to the configured shard", async () => {
    const log = await stub({ origin: "other-log.example" });
    // Same pinned key, but the log's checkpoints carry another origin than the configured URL's host.
    expect(
      await anchor(log)
        .anchor(sha("o1"))
        .catch((e: unknown) => e),
    ).toMatchObject({
      code: "verification_failed",
      message: expect.stringMatching(
        /origin "other-log.example" is not the log's origin "127.0.0.1"/,
      ),
    });
    await expect(anchor(log).healthCheck?.()).rejects.toMatchObject({
      code: "verification_failed",
    });
    // An operator-declared origin is accepted and recorded (informational).
    const port = anchor(log, { origin: "other-log.example" });
    const receipt = await port.anchor(sha("o2"));
    expect(receipt.proof["origin"]).toBe("other-log.example");
    expect((await port.verify(sha("o2"), receipt)).status).toBe("verified");
  });

  it("verify pins origins from configuration, never from the receipt's own claim", async () => {
    const log = await stub({ origin: "rekor.example.com" });
    const receipt = await anchor(log, { origin: "rekor.example.com" }).anchor(sha("pin"));
    const keys = [log.logPublicKeyPem];
    // Standalone: the origin must be pinned explicitly.
    expect(
      await verifyRekorReceipt(sha("pin"), receipt, { pems: keys, origins: ["rekor.example.com"] }),
    ).toMatchObject({ status: "verified" });
    expect(await verifyRekorReceipt(sha("pin"), receipt, { pems: keys })).toMatchObject({
      status: "unverified_origin",
      detail: expect.stringMatching(/not a pinned log origin/),
    });
    // A receipt rewritten to claim another origin / URL changes nothing: the checkpoint decides.
    const doctored = {
      ...receipt,
      proof: { ...receipt.proof, origin: "evil.example", logUrl: "https://evil.example" },
    };
    expect(
      (await verifyRekorReceipt(sha("pin"), doctored, { pems: keys, origins: ["evil.example"] }))
        .status,
    ).toBe("unverified_origin");
    // The port: configured origins by default (first = current shard, older ones still accepted).
    const rotated = anchor(log, { origin: ["log2026-1.example", "rekor.example.com"] });
    expect((await rotated.verify(sha("pin"), receipt)).status).toBe("verified");
    const other = anchor(log, { origin: "log2026-1.example" });
    expect((await other.verify(sha("pin"), receipt)).status).toBe("unverified_origin");
    expect(
      (await other.verify(sha("pin"), receipt, { pems: keys, origins: ["rekor.example.com"] }))
        .status,
    ).toBe("verified");
    // Anchoring under the rotated config requires the CURRENT (first) origin.
    expect(await rotated.anchor(sha("pin2")).catch((e: unknown) => e)).toMatchObject({
      code: "verification_failed",
    });
    expect(() => anchor(log, { origin: [] })).toThrow(/origin/);
    expect(() => anchor(log, { origin: "has space" })).toThrow(/origin/);
  });

  it("accepts several configured log keys (bundle or list): any pinned key verifies", async () => {
    const log = await stub();
    const other = await stub();
    for (const logPublicKeyPem of [
      `${other.logPublicKeyPem}\n${log.logPublicKeyPem}`,
      [other.logPublicKeyPem, log.logPublicKeyPem],
    ]) {
      const port = anchor(log, { logPublicKeyPem });
      const receipt = await port.anchor(sha("multi"));
      expect((await port.verify(sha("multi"), receipt)).status).toBe("verified");
    }
    expect(() => anchor(log, { logPublicKeyPem: [] })).toThrow(/no usable log public key/);
  });

  it("standalone verify with nothing pinned is unverified_origin", async () => {
    const log = await stub();
    const receipt = await anchor(log).anchor(sha("a"));
    expect((await verifyRekorReceipt(sha("a"), receipt)).status).toBe("unverified_origin");
  });

  it("accepts any of several pinned log keys (shard rotation)", async () => {
    const older = await stub();
    const newer = await stub();
    const receipt = await anchor(newer).anchor(sha("rot"));
    const pems = [older.logPublicKeyPem, newer.logPublicKeyPem].join("\n");
    expect(
      (await verifyRekorReceipt(sha("rot"), receipt, { pems: [pems], origins: ["127.0.0.1"] }))
        .status,
    ).toBe("verified");
  });

  it("refuses a log key that is not the one signing at anchor time", async () => {
    const log = await stub();
    const port = anchor(log, { logPublicKeyPem: log.otherLogPublicKeyPem });
    expect(await port.anchor(sha("k")).catch((e: unknown) => e)).toMatchObject({
      code: "verification_failed",
      message: expect.stringMatching(/not signed by a pinned log key/),
    });
  });

  it("refuses a bad proof, a forged checkpoint signature, a foreign log key and a wrong digest", async () => {
    const log = await stub();
    const port = anchor(log);
    const cases = [
      ["bad-proof", /inclusion proof/],
      ["bad-signature", /signature by the pinned log key is invalid/],
      ["foreign-key", /not signed by a pinned log key/],
      ["wrong-digest", /does not record this digest/],
    ] as const;
    for (const [mode, message] of cases) {
      log.control.mode = mode;
      const error = await port.anchor(sha(mode)).catch((e: unknown) => e);
      expect(error, mode).toBeInstanceOf(AnchorError);
      expect(error, mode).toMatchObject({
        code: "verification_failed",
        message: expect.stringMatching(message),
      });
    }
    log.control.mode = "garbage";
    expect(await port.anchor(sha("g")).catch((e: unknown) => e)).toMatchObject({
      code: "invalid_response",
    });
  });

  it("enforces its own cap and refuses redirects and slow logs even on an unguarded fetch", async () => {
    const log = await stub();
    const port = anchor(log, { http: fetch, timeoutMs: 300 });
    log.control.mode = "oversize";
    expect(await port.anchor(sha("o")).catch((e: unknown) => e)).toMatchObject({
      code: "invalid_response",
    });
    log.control.mode = "redirect";
    expect(await port.anchor(sha("r")).catch((e: unknown) => e)).toMatchObject({
      code: "rejected",
    });
    expect(log.redirectTargetHits()).toBe(0);
    log.control.mode = "hang";
    expect(await port.anchor(sha("h")).catch((e: unknown) => e)).toMatchObject({ code: "timeout" });
  });

  it("the stub log, like Rekor, refuses pure Ed25519 hashedrekords", async () => {
    const log = await stub();
    const { publicKey } = generateKeyPairSync("ed25519");
    const res = await fetch(`${log.url}/api/v2/log/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        hashedRekordRequestV002: {
          digest: Buffer.alloc(32, 1).toString("base64"),
          signature: {
            content: Buffer.alloc(64, 2).toString("base64"),
            verifier: {
              publicKey: {
                rawBytes: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
              },
              keyDetails: "PKIX_ED25519",
            },
          },
        },
      }),
    });
    expect(res.status).toBe(400);
  });

  it("refuses a signing key that is not ECDSA P-256 and a bad log key pin", async () => {
    const log = await stub();
    const { privateKey } = generateKeyPairSync("ed25519");
    expect(() => anchor(log, { signingKey: privateKey })).toThrow(/P-256/);
    expect(() => anchor(log, { logPublicKeyPem: "not a key" })).toThrow();
  });

  it("healthCheck verifies the live checkpoint against the pinned key", async () => {
    const log = await stub();
    await expect(anchor(log).healthCheck?.()).resolves.toBeUndefined();
    await expect(
      anchor(log, { logPublicKeyPem: log.otherLogPublicKeyPem }).healthCheck?.(),
    ).rejects.toMatchObject({ code: "verification_failed" });
  });

  describe("offline verification rejects forgeries", () => {
    let log: StubRekor;
    let receipt: AnchorReceipt;
    const digest = sha("forgery");
    const pins = () => ({ pems: [log.logPublicKeyPem], origins: [log.origin] });
    beforeAll(async () => {
      log = await startStubRekor();
      receipt = await anchor(log).anchor(digest);
    });
    afterAll(async () => {
      await log.close();
    });

    it("the untouched receipt verifies", async () => {
      expect((await verifyRekorReceipt(digest, receipt, pins())).status).toBe("verified");
    });

    it("a body re-signed by another key over the same digest is not in the tree", async () => {
      const other = deriveAnchorSigningKey({ key: new Uint8Array(randomBytes(32)) });
      const forged = withEntry(receipt, (entry) => {
        const body = JSON.parse(Buffer.from(entry.canonicalizedBody, "base64").toString("utf8"));
        body.spec.hashedRekordV002.signature.content = sign("sha256", digest, other).toString(
          "base64",
        );
        body.spec.hashedRekordV002.signature.verifier.publicKey.rawBytes = createPublicKey(other)
          .export({ type: "spki", format: "der" })
          .toString("base64");
        entry.canonicalizedBody = Buffer.from(JSON.stringify(body)).toString("base64");
      });
      expect(await verifyRekorReceipt(digest, forged, pins())).toMatchObject({
        status: "failed",
        detail: expect.stringMatching(/inclusion proof/),
      });
    });

    it("a body whose signature does not cover the digest fails", async () => {
      const forged = withEntry(receipt, (entry) => {
        const body = JSON.parse(Buffer.from(entry.canonicalizedBody, "base64").toString("utf8"));
        const sig = Buffer.from(body.spec.hashedRekordV002.signature.content, "base64");
        sig[sig.length - 1] = (sig[sig.length - 1] ?? 0) ^ 0x01;
        body.spec.hashedRekordV002.signature.content = sig.toString("base64");
        entry.canonicalizedBody = Buffer.from(JSON.stringify(body)).toString("base64");
      });
      expect(await verifyRekorReceipt(digest, forged, pins())).toMatchObject({
        status: "failed",
        detail: expect.stringMatching(/signature over the digest/),
      });
    });

    it("a moved log index fails", async () => {
      const forged = withEntry(receipt, (entry) => {
        entry.logIndex = String(Number(entry.logIndex) - 1);
      });
      expect((await verifyRekorReceipt(digest, forged, pins())).status).toBe("failed");
    });

    it("a checkpoint with another root, re-using the old signature, fails", async () => {
      const forged = withEntry(receipt, (entry) => {
        const lines = entry.inclusionProof.checkpoint.envelope.split("\n");
        lines[2] = Buffer.alloc(32, 7).toString("base64");
        entry.inclusionProof.checkpoint.envelope = lines.join("\n");
      });
      expect((await verifyRekorReceipt(digest, forged, pins())).status).toBe("failed");
    });

    it("a checkpoint whose pinned-key signature bytes were altered fails (not just unverified)", async () => {
      const forged = withEntry(receipt, (entry) => {
        const lines = entry.inclusionProof.checkpoint.envelope.split("\n");
        const sigLine = lines.findIndex((l) => l.startsWith(`— ${log.origin} `));
        const blob = Buffer.from((lines[sigLine] as string).split(" ")[2] as string, "base64");
        blob[10] = (blob[10] ?? 0) ^ 0x01;
        lines[sigLine] = `— ${log.origin} ${blob.toString("base64")}`;
        entry.inclusionProof.checkpoint.envelope = lines.join("\n");
      });
      expect(await verifyRekorReceipt(digest, forged, pins())).toMatchObject({
        status: "failed",
        detail: expect.stringMatching(/signature by the pinned log key is invalid/),
      });
    });

    it("an edited anchoredAt is reported as given (Rekor v2 asserts no time) but junk fails", async () => {
      expect(
        (await verifyRekorReceipt(digest, { ...receipt, anchoredAt: "yesterday" }, pins())).status,
      ).toBe("failed");
    });

    it("junk entries fail", async () => {
      for (const entry of [null, "x", 1, [], { canonicalizedBody: "!!" }]) {
        const r = { ...receipt, proof: { ...receipt.proof, entry } };
        expect((await verifyRekorReceipt(digest, r, pins())).status).toBe("failed");
      }
    });
  });
});

/** log2025-1.rekor.sigstore.dev, from Sigstore's TUF trusted_root.json (PKIX_ED25519). */
const LOG2025_1_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAt8rlp1knGwjfbcXAYPYAkn0XiLz1x8O4t0YkEhie244=
-----END PUBLIC KEY-----
`;

describe.skipIf(process.env["FUNDROOM_TEST_LIVE_ANCHOR"] !== "1")("rekor live (log2025-1)", () => {
  /*
   * Opt-in (`FUNDROOM_TEST_LIVE_ANCHOR=1`): writes ONE entry to the public Rekor v2 shard (the
   * digest of a random string; nothing identifying) and verifies it offline. Override the shard
   * with FUNDROOM_TEST_REKOR_URL / FUNDROOM_TEST_REKOR_KEY_FILE when it rotates.
   */
  const live = createOutboundHttp({ maxRedirects: 0, timeoutMs: 60_000 });
  afterAll(async () => {
    await live.close();
  });
  const url = process.env["FUNDROOM_TEST_REKOR_URL"] ?? "https://log2025-1.rekor.sigstore.dev";
  const keyFile = process.env["FUNDROOM_TEST_REKOR_KEY_FILE"];

  it("health-checks, anchors and verifies offline", async () => {
    const pem = keyFile ? (await import("node:fs")).readFileSync(keyFile, "utf8") : LOG2025_1_KEY;
    const port = createRekorAnchor({
      url,
      logPublicKeyPem: pem,
      signingKey,
      http: live.fetch,
      timeoutMs: 60_000,
    });
    await port.healthCheck?.();
    const digest = sha(`fundroom live anchor test ${randomBytes(16).toString("hex")}`);
    const receipt = await port.anchor(digest);
    expect(await port.verify(digest, receipt)).toMatchObject({ status: "verified" });
    const other = digest.slice();
    other[0] = (other[0] ?? 0) ^ 1;
    expect((await port.verify(other, receipt)).status).toBe("failed");
  }, 120_000);
});
