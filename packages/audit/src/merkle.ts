import { createHash, timingSafeEqual } from "node:crypto";

/*
 * RFC 6962 (Certificate Transparency) Merkle trees, as RFC 9162 §2.1 restates them — the shape
 * external anchoring (E3.13, ADR-0061) commits to:
 *
 *   leaf  = SHA-256(0x00 || data)
 *   node  = SHA-256(0x01 || left || right)
 *   MTH(D[n]) for n > 1 = node(MTH(D[0:k]), MTH(D[k:n])), k the largest power of two < n
 *
 * No duplication of an odd last leaf (the Bitcoin-style flaw that lets two different leaf lists
 * share a root). The domain-separation bytes stop a leaf from posing as an inner node. Inclusion
 * paths are ordered leaf → root, and `verifyMerkleInclusion` is RFC 9162 §2.1.3.2 verbatim, so a
 * third party can check a proof with any CT library.
 */

export const MERKLE_HASH_BYTES = 32;

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

export function merkleLeafHash(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(LEAF_PREFIX).update(data).digest());
}

export function merkleNodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return new Uint8Array(
    createHash("sha256").update(NODE_PREFIX).update(left).update(right).digest(),
  );
}

/** The largest power of two strictly smaller than `n` (n ≥ 2). */
function splitPoint(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

export interface MerkleTree {
  readonly root: Uint8Array;
  readonly size: number;
  /** `paths[i]` = leaf i's inclusion path, sibling hashes from the leaf up to the root. */
  readonly paths: readonly (readonly Uint8Array[])[];
}

function assertHashes(leafHashes: readonly Uint8Array[]): void {
  if (leafHashes.length === 0) throw new RangeError("a Merkle tree needs at least one leaf");
  for (const h of leafHashes) {
    if (h.length !== MERKLE_HASH_BYTES) throw new RangeError("leaf hashes are 32 bytes");
  }
}

/**
 * Builds the tree over already-hashed leaves (`merkleLeafHash`) and every leaf's inclusion path
 * in one pass: O(n log n) time and space.
 */
export function buildMerkleTree(leafHashes: readonly Uint8Array[]): MerkleTree {
  assertHashes(leafHashes);
  const paths: Uint8Array[][] = leafHashes.map(() => []);
  const build = (lo: number, hi: number): Uint8Array => {
    if (hi - lo === 1) return leafHashes[lo] as Uint8Array;
    const k = splitPoint(hi - lo);
    const left = build(lo, lo + k);
    const right = build(lo + k, hi);
    for (let i = lo; i < lo + k; i++) paths[i]?.push(right);
    for (let i = lo + k; i < hi; i++) paths[i]?.push(left);
    return merkleNodeHash(left, right);
  };
  const root = build(0, leafHashes.length);
  return { root, size: leafHashes.length, paths };
}

/** MTH over already-hashed leaves. */
export function merkleRoot(leafHashes: readonly Uint8Array[]): Uint8Array {
  return buildMerkleTree(leafHashes).root;
}

/** PATH(index, D[n]) over already-hashed leaves. */
export function merkleInclusionPath(
  leafHashes: readonly Uint8Array[],
  index: number,
): readonly Uint8Array[] {
  if (!Number.isInteger(index) || index < 0 || index >= leafHashes.length) {
    throw new RangeError("leaf index out of range");
  }
  return buildMerkleTree(leafHashes).paths[index] as readonly Uint8Array[];
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * RFC 9162 §2.1.3.2: does `path` lead from `leafHash` at `index` in a tree of `treeSize` leaves
 * to `root`? Never throws; malformed input is `false`.
 */
export function verifyMerkleInclusion(
  leafHash: Uint8Array,
  index: number,
  treeSize: number,
  path: readonly Uint8Array[],
  root: Uint8Array,
): boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(treeSize)) return false;
  if (index < 0 || treeSize < 1 || index >= treeSize) return false;
  if (leafHash.length !== MERKLE_HASH_BYTES || root.length !== MERKLE_HASH_BYTES) return false;
  // BigInt-free: indexes stay below 2^53 and only shift right.
  let fn = index;
  let sn = treeSize - 1;
  let r = leafHash;
  for (const p of path) {
    if (p.length !== MERKLE_HASH_BYTES) return false;
    if (sn === 0) return false;
    if (fn % 2 === 1 || fn === sn) {
      r = merkleNodeHash(p, r);
      if (fn % 2 === 0) {
        while (fn % 2 === 0 && fn !== 0) {
          fn = Math.floor(fn / 2);
          sn = Math.floor(sn / 2);
        }
      }
    } else {
      r = merkleNodeHash(r, p);
    }
    fn = Math.floor(fn / 2);
    sn = Math.floor(sn / 2);
  }
  return sn === 0 && equal(r, root);
}

/** Hex helpers for proofs stored and exported as JSON. */
export function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Strict: exactly 64 lowercase-or-uppercase hex digits, else `null`. */
export function hashFromHex(hex: unknown): Uint8Array | null {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/iu.test(hex)) return null;
  return new Uint8Array(Buffer.from(hex, "hex"));
}
