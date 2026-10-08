import { createCipheriv } from "node:crypto";
import { boxBlur } from "./image.js";

/*
 * The keyed pattern and its perceptual mask.
 *
 * Lattice: nodes every `cellPx = width / GRID` pixels in both directions, starting at (0, 0). The
 * pattern value at a pixel is the bilinear interpolation of the ±1 values of the four
 * surrounding nodes, so the mark is smooth (no block edges for a codec to fight with, and it
 * survives any rescale because it is defined relative to the page width). Node (i, j) has index
 * `j · (GRID + 1) + i`, independent of the page height.
 *
 * Values: AES-256-CTR keystream under the 32-byte seed (a fixed, purpose-bound IV), one bit per
 * node. Two seeds give computationally independent ±1 sequences; this independence is what makes
 * an innocent candidate's z exactly a Rademacher sum (see engine.ts).
 */

/** Lattice nodes across the page width (cell = width / GRID px; 10 px at the 1600 px page). */
export const GRID = 160;
const PATTERN_IV = Buffer.from("seed-host/fp/v1\0", "latin1");

export interface Lattice {
  readonly cellPx: number;
  readonly cols: number;
  readonly rows: number;
}

export function latticeOf(width: number, height: number): Lattice {
  const cellPx = width / GRID;
  return { cellPx, cols: GRID + 1, rows: Math.floor((height - 1) / cellPx) + 2 };
}

/** One bit per node (bit set: +1, clear: −1), packed little-endian within each byte. */
export function patternBits(seed: Uint8Array, nodes: number): Uint8Array {
  const cipher = createCipheriv("aes-256-ctr", seed, PATTERN_IV);
  const out = cipher.update(new Uint8Array((nodes + 7) >> 3));
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** ±1 per node as floats (embedding). */
export function patternSigns(seed: Uint8Array, nodes: number): Float32Array {
  const bits = patternBits(seed, nodes);
  const out = new Float32Array(nodes);
  for (let n = 0; n < nodes; n++) out[n] = ((bits[n >> 3] as number) >> (n & 7)) & 1 ? 1 : -1;
  return out;
}

/** Σ sign(n) · x[n] — the correlation of one candidate with the node statistics. */
export function correlate(bits: Uint8Array, x: Float64Array): number {
  let acc = 0;
  const nodes = x.length;
  for (let n = 0; n < nodes; n++) {
    const v = x[n] as number;
    acc += ((bits[n >> 3] as number) >> (n & 7)) & 1 ? v : -v;
  }
  return acc;
}

/** Amplitude (luma levels) on flat paper at strength 1 — the "±2 levels on blank paper" rule. */
export const ALPHA_FLAT = 2;
/** Amplitude on and around text / edges at strength 1 (masked by the edges themselves). */
export const ALPHA_EDGE = 4;
/** Mean local gradient (sum of |central differences|) at which the edge amplitude saturates. */
const ACTIVITY_SATURATION = 40;

/**
 * Per-pixel embedding amplitude from the unmarked luma: flat paper gets `ALPHA_FLAT`, pixels on
 * or within a couple of pixels of an edge get up to `ALPHA_EDGE`. The detector recomputes the
 * same map from the reference page to weight its correlation (matched filter).
 */
export function amplitudeMap(
  gray: Uint8Array,
  width: number,
  height: number,
  strength: number,
): Float32Array {
  const g = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const up = (y > 0 ? y - 1 : y) * width;
    const down = (y < height - 1 ? y + 1 : y) * width;
    for (let x = 0; x < width; x++) {
      const l = x > 0 ? x - 1 : x;
      const r = x < width - 1 ? x + 1 : x;
      const gx = (gray[row + r] as number) - (gray[row + l] as number);
      const gy = (gray[down + x] as number) - (gray[up + x] as number);
      g[row + x] = (gx < 0 ? -gx : gx) + (gy < 0 ? -gy : gy);
    }
  }
  const radius = Math.max(1, Math.round(width / GRID / 4));
  boxBlur(g, width, height, radius);
  const flat = ALPHA_FLAT * strength;
  const span = (ALPHA_EDGE - ALPHA_FLAT) * strength;
  for (let i = 0; i < g.length; i++) {
    const a = (g[i] as number) / ACTIVITY_SATURATION;
    g[i] = flat + span * (a < 1 ? a : 1);
  }
  return g;
}
