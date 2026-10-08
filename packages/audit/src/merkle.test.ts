import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildMerkleTree,
  hashFromHex,
  merkleInclusionPath,
  merkleLeafHash,
  merkleNodeHash,
  merkleRoot,
  toHex,
  verifyMerkleInclusion,
} from "./merkle.js";

/*
 * Test vectors from RFC 6962's reference implementation (certificate-transparency
 * `merkle_tree_test.cc` / Go `merkle/testonly`): eight leaves of growing length, the root of
 * every prefix tree and a set of inclusion proofs.
 */
const LEAVES = [
  "",
  "00",
  "10",
  "2021",
  "3031",
  "40414243",
  "5051525354555657",
  "606162636465666768696a6b6c6d6e6f",
].map((h) => new Uint8Array(Buffer.from(h, "hex")));

const ROOTS = [
  "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
  "fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125",
  "aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77",
  "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
  "4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4",
  "76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef",
  "ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c",
  "5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328",
];

const PROOFS: { index: number; size: number; path: string[] }[] = [
  { index: 0, size: 1, path: [] },
  {
    index: 0,
    size: 8,
    path: [
      "96a296d224f285c67bee93c30f8a309157f0daa35dc5b87e410b78630a09cfc7",
      "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e",
      "6b47aaf29ee3c2af9af889bc1fb9254dabd31177f16232dd6aab035ca39bf6e4",
    ],
  },
  {
    index: 5,
    size: 8,
    path: [
      "bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b",
      "ca854ea128ed050b41b35ffc1b87b8eb2bde461e9e3b5596ece6b9d5975a0ae0",
      "d37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7",
    ],
  },
  {
    index: 2,
    size: 3,
    path: ["fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125"],
  },
  {
    index: 1,
    size: 5,
    path: [
      "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d",
      "5f083f0a1a33ca076a95279832580db3e0ef4584bdff1f54c8a360f50de3031e",
      "bc1a0643b12e4d2d7c77918f44e0f4f79a838b6cf9ec5b5c283e1f4d88599e6b",
    ],
  },
];

const hashed = LEAVES.map(merkleLeafHash);
const hex = (h: Uint8Array) => toHex(h);

/** The RFC's recursive definition, written as naively as possible, as an oracle. */
function naiveRoot(hs: Uint8Array[]): Uint8Array {
  if (hs.length === 1) return hs[0] as Uint8Array;
  let k = 1;
  while (k * 2 < hs.length) k *= 2;
  return merkleNodeHash(naiveRoot(hs.slice(0, k)), naiveRoot(hs.slice(k)));
}

describe("RFC 6962 Merkle tree", () => {
  it("hashes leaves and nodes with the domain-separation bytes", () => {
    expect(hex(merkleLeafHash(new Uint8Array()))).toBe(
      createHash("sha256")
        .update(Buffer.from([0]))
        .digest("hex"),
    );
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    expect(hex(merkleNodeHash(a, b))).toBe(
      createHash("sha256")
        .update(Buffer.from([1]))
        .update(a)
        .update(b)
        .digest("hex"),
    );
  });

  it("matches the reference roots for every prefix of the test leaves", () => {
    for (let n = 1; n <= LEAVES.length; n++) {
      expect(hex(merkleRoot(hashed.slice(0, n))), `size ${n}`).toBe(ROOTS[n - 1]);
    }
  });

  it("matches the reference inclusion proofs, and they verify", () => {
    for (const p of PROOFS) {
      const leaves = hashed.slice(0, p.size);
      expect(merkleInclusionPath(leaves, p.index).map(hex)).toEqual(p.path);
      const root = hashFromHex(ROOTS[p.size - 1]) as Uint8Array;
      expect(
        verifyMerkleInclusion(
          hashed[p.index] as Uint8Array,
          p.index,
          p.size,
          p.path.map((h) => hashFromHex(h) as Uint8Array),
          root,
        ),
      ).toBe(true);
    }
  });

  it("every leaf of every tree size up to 70 verifies, and agrees with the naive oracle", () => {
    const leaves = Array.from({ length: 70 }, (_, i) =>
      merkleLeafHash(new Uint8Array(Buffer.from(`leaf-${i}`))),
    );
    for (let n = 1; n <= leaves.length; n++) {
      const tree = buildMerkleTree(leaves.slice(0, n));
      expect(hex(tree.root)).toBe(hex(naiveRoot(leaves.slice(0, n))));
      for (let i = 0; i < n; i++) {
        const path = tree.paths[i] as Uint8Array[];
        expect(verifyMerkleInclusion(leaves[i] as Uint8Array, i, n, path, tree.root)).toBe(true);
      }
    }
  });

  it("does not duplicate an odd last leaf (no second-preimage via duplication)", () => {
    const [a, b, c] = hashed as [Uint8Array, Uint8Array, Uint8Array];
    expect(hex(merkleRoot([a, b, c]))).not.toBe(hex(merkleRoot([a, b, c, c])));
  });

  it("rejects wrong leaves, indexes, sizes, roots and tampered or padded paths", () => {
    const tree = buildMerkleTree(hashed);
    const path = tree.paths[5] as Uint8Array[];
    const leaf = hashed[5] as Uint8Array;
    expect(verifyMerkleInclusion(leaf, 5, 8, path, tree.root)).toBe(true);
    expect(verifyMerkleInclusion(hashed[4] as Uint8Array, 5, 8, path, tree.root)).toBe(false);
    expect(verifyMerkleInclusion(leaf, 4, 8, path, tree.root)).toBe(false);
    // Size 7 has the same path shape for leaf 5 (RFC 9162 does not bind it), so the batch row's leaf
    // count is checked separately by the anchor verifiers; size 6 has a shorter path.
    expect(verifyMerkleInclusion(leaf, 5, 6, path, tree.root)).toBe(false);
    expect(verifyMerkleInclusion(leaf, 5, 9, path, tree.root)).toBe(false);
    expect(verifyMerkleInclusion(leaf, 8, 8, path, tree.root)).toBe(false);
    expect(verifyMerkleInclusion(leaf, -1, 8, path, tree.root)).toBe(false);
    expect(verifyMerkleInclusion(leaf, 5, 8, path, hashed[0] as Uint8Array)).toBe(false);
    const flipped = path.map((p) => new Uint8Array(p));
    const second = flipped[1] as Uint8Array;
    second[0] = (second[0] ?? 0) ^ 1;
    expect(verifyMerkleInclusion(leaf, 5, 8, flipped, tree.root)).toBe(false);
    expect(verifyMerkleInclusion(leaf, 5, 8, path.slice(0, 2), tree.root)).toBe(false);
    expect(verifyMerkleInclusion(leaf, 5, 8, [...path, leaf], tree.root)).toBe(false);
    expect(verifyMerkleInclusion(leaf, 5, 8, [new Uint8Array(31)], tree.root)).toBe(false);
  });

  it("refuses empty trees and malformed hashes", () => {
    expect(() => buildMerkleTree([])).toThrow(RangeError);
    expect(() => buildMerkleTree([new Uint8Array(31)])).toThrow(RangeError);
    expect(() => merkleInclusionPath(hashed, 8)).toThrow(RangeError);
    expect(hashFromHex("ab")).toBeNull();
    expect(hashFromHex(`${"0".repeat(63)}g`)).toBeNull();
    expect(hashFromHex(42)).toBeNull();
    expect(hashFromHex(ROOTS[0])).not.toBeNull();
  });
});
