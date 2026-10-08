import { createHash, timingSafeEqual } from "node:crypto";

/*
 * RFC 6962 / RFC 9162 Merkle tree hashing, as Rekor v2 (Tessera) uses it: leaf = SHA-256(0x00 ||
 * entry), node = SHA-256(0x01 || left || right), no duplication for non-power-of-two sizes.
 * `verifyInclusion` is RFC 9162 §2.1.3.2; `merkleRoot` / `inclusionPath` (RFC 6962 §2.1, §2.1.1)
 * exist for the stub log and tests.
 */

export function leafHash(entry: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(Uint8Array.of(0)).update(entry).digest());
}

export function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return new Uint8Array(
    createHash("sha256").update(Uint8Array.of(1)).update(left).update(right).digest(),
  );
}

/** Largest power of two strictly smaller than n (n ≥ 2). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** MTH over already-hashed leaves. */
export function merkleRoot(leaves: readonly Uint8Array[]): Uint8Array {
  if (leaves.length === 0) return new Uint8Array(createHash("sha256").digest());
  if (leaves.length === 1) return leaves[0] as Uint8Array;
  const k = split(leaves.length);
  return nodeHash(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/** PATH(m, D[n]) over already-hashed leaves, leaf-to-root order. */
export function inclusionPath(index: number, leaves: readonly Uint8Array[]): Uint8Array[] {
  if (index < 0 || index >= leaves.length) throw new RangeError("index outside the tree");
  if (leaves.length === 1) return [];
  const k = split(leaves.length);
  return index < k
    ? [...inclusionPath(index, leaves.slice(0, k)), merkleRoot(leaves.slice(k))]
    : [...inclusionPath(index - k, leaves.slice(k)), merkleRoot(leaves.slice(0, k))];
}

/** RFC 9162 §2.1.3.2: does `leaf` sit at `index` of the tree of `size` with `root`? */
export function verifyInclusion(
  leaf: Uint8Array,
  index: number,
  size: number,
  path: readonly Uint8Array[],
  root: Uint8Array,
): boolean {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size)) return false;
  if (index < 0 || index >= size) return false;
  if (root.byteLength !== 32 || path.some((p) => p.byteLength !== 32)) return false;
  // BigInt keeps the shifts exact for indexes beyond 2^31.
  let fn = BigInt(index);
  let sn = BigInt(size - 1);
  let r = leaf;
  for (const p of path) {
    if (sn === 0n) return false;
    if ((fn & 1n) === 1n || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1n) === 0n) {
        while ((fn & 1n) === 0n && fn !== 0n) {
          fn >>= 1n;
          sn >>= 1n;
        }
      }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1n;
    sn >>= 1n;
  }
  return sn === 0n && r.byteLength === root.byteLength && timingSafeEqual(r, root);
}
