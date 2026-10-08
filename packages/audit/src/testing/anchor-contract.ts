import {
  AnchorError,
  type AnchorErrorCode,
  type AnchorReceipt,
  type AuditAnchorPort,
} from "@fundroom/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The AuditAnchorPort contract suite (E3.13 contract §2.3). Every anchor adapter runs it against a
 * local stub of its remote (a stub TSA signing real RFC 3161 tokens, a stub Rekor v2 log building
 * a real RFC 6962 tree and signed-note checkpoints).
 *
 * What it pins down:
 *  - `anchor` returns a receipt of the port's kind that survives a JSON round trip (receipts are
 *    stored as jsonb) and `verify`s as `verified`, both with the configured pins and with the pins
 *    passed explicitly;
 *  - a different digest, a tampered proof or a receipt of another kind → `failed`;
 *  - a consistent receipt checked against unrelated pins (or none) → `unverified_origin`;
 *  - `verify` makes no network call;
 *  - remote failures throw `AnchorError` with a fixed code: HTTP 5xx / connection refused →
 *    `unreachable`, a deadline → `timeout`, an oversize answer → `invalid_response`, a redirect →
 *    `rejected` — and the redirect target is never requested.
 */
export type AnchorStubMode = "ok" | "redirect" | "error" | "hang" | "oversize";

export interface AnchorContractHarness {
  /** The port under test, wired to the stub (short timeout, e.g. ≤ 1 s, for the `hang` case). */
  readonly port: AuditAnchorPort;
  /** Pins under which the stub's receipts are `verified`. */
  readonly trusted: readonly string[];
  /** Well-formed pins of an unrelated signer. */
  readonly untrusted: readonly string[];
  /** A copy of `receipt` whose proof no longer matches what was anchored (signature intact or not). */
  tamperProof(receipt: AnchorReceipt): AnchorReceipt;
  /** Switch the stub's behaviour for subsequent requests. */
  setMode(mode: AnchorStubMode): void;
  /** Requests the stub received in total. */
  requests(): number;
  /** Requests that reached the stub's redirect target (must stay 0). */
  redirectTargetHits(): number;
  /** A port configured like `port` but pointed at an address nothing listens on. */
  unreachablePort(): AuditAnchorPort;
  cleanup(): Promise<void>;
}

function digestOf(seed: number): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i * 7) & 0xff;
  return out;
}

async function anchorError(promise: Promise<unknown>): Promise<AnchorError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AnchorError);
    return error as AnchorError;
  }
  throw new Error("expected the anchor call to throw AnchorError");
}

export function describeAuditAnchorPortContract(
  name: string,
  factory: () => Promise<AnchorContractHarness>,
): void {
  describe(`AuditAnchorPort contract: ${name}`, () => {
    let h: AnchorContractHarness;

    beforeEach(async () => {
      h = await factory();
    });

    afterEach(async () => {
      await h.cleanup();
    });

    it("anchors a digest into a receipt that verifies offline after a JSON round trip", async () => {
      const digest = digestOf(1);
      const receipt = await h.port.anchor(digest);
      expect(receipt.kind).toBe(h.port.kind);
      expect(receipt.reference.length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(receipt.anchoredAt))).toBe(false);
      const stored = JSON.parse(JSON.stringify(receipt)) as AnchorReceipt;

      const byDefault = await h.port.verify(digest, stored);
      expect(byDefault).toMatchObject({ status: "verified" });
      const explicit = await h.port.verify(digest, stored, { pems: h.trusted });
      expect(explicit.status).toBe("verified");
      if (explicit.status === "verified") {
        expect(Date.parse(explicit.anchoredAt)).toBe(Date.parse(receipt.anchoredAt));
      }
    });

    it("verify never touches the network", async () => {
      const digest = digestOf(2);
      const receipt = await h.port.anchor(digest);
      const before = h.requests();
      await h.port.verify(digest, receipt);
      await h.port.verify(digest, receipt, { pems: h.untrusted });
      await h.port.verify(digestOf(3), receipt);
      expect(h.requests()).toBe(before);
    });

    it("fails a receipt checked against a different digest", async () => {
      const digest = digestOf(4);
      const receipt = await h.port.anchor(digest);
      const other = digest.slice();
      other[0] = (other[0] ?? 0) ^ 0x01;
      expect((await h.port.verify(other, receipt)).status).toBe("failed");
      expect((await h.port.verify(other, receipt, { pems: h.untrusted })).status).toBe("failed");
    });

    it("binds each receipt to its own digest", async () => {
      const a = digestOf(5);
      const b = digestOf(6);
      const ra = await h.port.anchor(a);
      const rb = await h.port.anchor(b);
      expect((await h.port.verify(a, ra)).status).toBe("verified");
      expect((await h.port.verify(b, rb)).status).toBe("verified");
      expect((await h.port.verify(a, rb)).status).toBe("failed");
      expect((await h.port.verify(b, ra)).status).toBe("failed");
    });

    it("fails a tampered proof", async () => {
      const digest = digestOf(7);
      const receipt = await h.port.anchor(digest);
      const tampered = h.tamperProof(JSON.parse(JSON.stringify(receipt)) as AnchorReceipt);
      expect(tampered.proof).not.toEqual(receipt.proof);
      expect((await h.port.verify(digest, tampered)).status).toBe("failed");
    });

    it("fails a receipt of another kind and a receipt without a proof", async () => {
      const digest = digestOf(8);
      const receipt = await h.port.anchor(digest);
      expect(
        (await h.port.verify(digest, { ...receipt, kind: `${receipt.kind}-other` })).status,
      ).toBe("failed");
      expect((await h.port.verify(digest, { ...receipt, proof: {} })).status).toBe("failed");
    });

    it("reports a consistent receipt from an unpinned signer as unverified_origin", async () => {
      const digest = digestOf(9);
      const receipt = await h.port.anchor(digest);
      const result = await h.port.verify(digest, receipt, { pems: h.untrusted });
      expect(result.status).toBe("unverified_origin");
      expect((await h.port.verify(digest, receipt, { pems: [] })).status).toBe("unverified_origin");
    });

    it("refuses a digest that is not 32 bytes", async () => {
      await anchorError(h.port.anchor(new Uint8Array(31)));
    });

    const failures: readonly [AnchorStubMode, AnchorErrorCode][] = [
      ["error", "unreachable"],
      ["hang", "timeout"],
      ["oversize", "invalid_response"],
      ["redirect", "rejected"],
    ];
    for (const [mode, code] of failures) {
      it(`throws AnchorError(${code}) when the remote answers "${mode}"`, async () => {
        h.setMode(mode);
        const error = await anchorError(h.port.anchor(digestOf(10)));
        expect(error.code).toBe(code);
      });
    }

    it("never follows a redirect", async () => {
      h.setMode("redirect");
      await anchorError(h.port.anchor(digestOf(11)));
      expect(h.redirectTargetHits()).toBe(0);
    });

    it("throws AnchorError(unreachable) when nothing listens", async () => {
      const error = await anchorError(h.unreachablePort().anchor(digestOf(12)));
      expect(error.code).toBe("unreachable");
    });

    it("recovers once the remote answers again", async () => {
      h.setMode("error");
      await anchorError(h.port.anchor(digestOf(13)));
      h.setMode("ok");
      const receipt = await h.port.anchor(digestOf(13));
      expect((await h.port.verify(digestOf(13), receipt)).status).toBe("verified");
    });
  });
}
