import { type FloatImage, lumaOf, resample, toFloat } from "./image.js";
import {
  ALPHA_EDGE,
  ALPHA_FLAT,
  amplitudeMap,
  correlate,
  latticeOf,
  patternBits,
  patternSigns,
} from "./pattern.js";
import { register, warpToReference } from "./register.js";

/*
 * The forensic pattern engine (E3.13, ADR-0061): an informed (non-blind) spread-spectrum mark.
 *
 * EMBED. A keyed ±1 lattice (one node every width/160 px, AES-256-CTR under the 32-byte seed) is
 * bilinearly interpolated into a smooth pattern p(x) ∈ [−1, 1] and added to R, G and B with a
 * perceptual amplitude α(x): ALPHA_FLAT (2 levels) on flat paper, rising to ALPHA_EDGE (4) on and
 * within ~3 px of text and edges, where the change is masked by the edge itself. Values clip at
 * 0/255 (white paper can only darken). PSNR ≈ 44–48 dB on real pages; see the tests.
 *
 * DETECT. (1) Register the suspect onto the reference from the images alone (register.ts).
 * (2) Warp the suspect onto the reference grid; pick the reference pre-blur (none, or the
 * down-up resampling the suspect evidently went through) that minimises the residual energy;
 * remove any tone curve by subtracting E[suspect | reference level]. (3) Clip the residual
 * e(x) to ±RESIDUAL_CLIP (kills another viewer's visible watermark strokes and edge ringing) and
 * project it onto each lattice node's tent, weighted by α(x) and whitened by the node's local
 * residual power: x_n. (4) For each candidate with signs w_n: z = Σ w_n x_n / √(Σ x_n²).
 *
 * WHY z IS HONEST. Steps 1–3 never look at a candidate: registration, pre-blur and weights are
 * functions of (reference, suspect) only, so x is fixed before any pattern is generated. For a
 * candidate whose mark is NOT in the image, w is a sequence of independent fair signs
 * independent of x, so z is exactly a normalised Rademacher sum: mean 0, variance 1, and by
 * Hoeffding P(z ≥ t) ≤ exp(−t²/2) for ANY image — 1.5e-8 at the match threshold 6, 3.4e-4 at 4.
 * No search is maximised per candidate (that would inflate z), and the bound holds for unmarked
 * pages, pages marked for someone outside the candidate list, and crafted images alike.
 *
 * LIMITS. Rotation, perspective, print-and-scan and heavy blur defeat registration or the mark;
 * averaging k copies (collusion) divides each colluder's z by ~k; whoever knows the algorithm
 * and has the unmarked page can subtract the mark. The detector needs the unmarked reference.
 */

/** Floor of the "match" threshold (proven bound P(z ≥ 6) ≤ e^(−18) ≈ 1.5e-8 per innocent candidate); `forensicThresholds(n)` raises it with the candidate count. */
export const FORENSIC_MATCH_Z = 6;
/** z in [INCONCLUSIVE, MATCH): "inconclusive"; below: "no_match". */
export const FORENSIC_INCONCLUSIVE_Z = 4;

/** 8-bit luma, row-major. */
export interface GrayImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

/** Raw interleaved pixels. */
export interface RgbImage {
  readonly width: number;
  readonly height: number;
  readonly channels: 3 | 4;
  readonly data: Uint8Array;
}

export interface EmbedOptions {
  /**
   * Amplitude multiplier, (0, 4]. Default `FORENSIC_DEFAULT_STRENGTH` = 1: ±2 luma levels on
   * blank paper, up to ±4 on and around text and edges.
   */
  readonly strength?: number | undefined;
}

export const FORENSIC_DEFAULT_STRENGTH = 1;
/** Registration NCC below which a detection should be reported as "alignment failed". */
export const FORENSIC_MIN_ALIGNMENT_QUALITY = 0.5;
/** Default cap on candidates per detection. */
export const FORENSIC_DEFAULT_MAX_CANDIDATES = 2000;
/** Residual clip (luma levels) before correlation. */
const RESIDUAL_CLIP = 12;
/** Noise-power floor per node (quantisation of an 8-bit image). */
const NOISE_FLOOR = 1;
const MIN_SIDE = 16;

export interface DetectCandidate {
  readonly id: string;
  readonly seed: Uint8Array;
}

export type ForensicVerdict = "match" | "inconclusive" | "no_match";

export interface ForensicThresholds {
  /** z ≥ match: "match". */
  readonly match: number;
  /** inconclusive ≤ z < match: "inconclusive". */
  readonly inconclusive: number;
}

export interface DetectOptions {
  readonly maxCandidates?: number | undefined;
  /** Overrides `forensicThresholds(candidates.length)` (tests, research). */
  readonly thresholds?: ForensicThresholds | undefined;
}

export interface DetectResult {
  /** How the suspect was registered onto the reference. */
  readonly aligned: {
    readonly scale: number;
    readonly dx: number;
    readonly dy: number;
    readonly quality: number;
  };
  /** Sorted by z, descending. */
  readonly scores: readonly {
    readonly id: string;
    readonly z: number;
    readonly verdict: ForensicVerdict;
  }[];
  /** The thresholds the verdicts used (`forensicThresholds(N)` unless overridden). */
  readonly thresholds: ForensicThresholds;
  /**
   * The lowest z (0 without candidates). Innocent z is symmetric about 0, so a strongly negative
   * z (≤ −thresholds.match) means someone's pattern was SUBTRACTED: a tampering attempt.
   */
  readonly minZ: number;
}

/**
 * Detection thresholds for N candidates, Bonferroni-corrected on the proven per-candidate bound
 * P(z ≥ t) ≤ exp(−t²/2): match = max(6, √(2·ln(N·10⁶))) keeps the chance that ANY innocent of
 * the N reaches "match" ≤ 1e-6 per detection; inconclusive = max(4, √(2·ln(N·100))) keeps the
 * chance any innocent is even named "inconclusive" ≤ 1 %. N = 2000 → 6.54 / 4.94.
 */
export function forensicThresholds(candidateCount: number): ForensicThresholds {
  const n = Math.max(1, Math.floor(candidateCount));
  return {
    match: Math.max(FORENSIC_MATCH_Z, Math.sqrt(2 * Math.log(n * 1e6))),
    inconclusive: Math.max(FORENSIC_INCONCLUSIVE_Z, Math.sqrt(2 * Math.log(n * 100))),
  };
}

/** The verdict for a z-score (default: the fixed floors 6 / 4, i.e. N = 1). */
export function forensicVerdict(
  z: number,
  thresholds: ForensicThresholds = {
    match: FORENSIC_MATCH_Z,
    inconclusive: FORENSIC_INCONCLUSIVE_Z,
  },
): ForensicVerdict {
  if (z >= thresholds.match) return "match";
  if (z >= thresholds.inconclusive) return "inconclusive";
  return "no_match";
}

/** Luma (BT.601) of an RGB(A) image. */
export function rgbToGray(image: RgbImage): GrayImage {
  checkRgb(image);
  return {
    width: image.width,
    height: image.height,
    data: lumaOf(image.data, image.width, image.height, image.channels),
  };
}

function checkSize(width: number, height: number, what: string): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < MIN_SIDE ||
    height < MIN_SIDE
  )
    throw new RangeError(`forensic: ${what} must be at least ${MIN_SIDE}×${MIN_SIDE} pixels`);
}

function checkRgb(image: RgbImage): void {
  checkSize(image.width, image.height, "image");
  if (image.channels !== 3 && image.channels !== 4)
    throw new RangeError("forensic: image must have 3 or 4 channels");
  if (image.data.length !== image.width * image.height * image.channels)
    throw new RangeError("forensic: image data length does not match its dimensions");
}

function checkGray(image: GrayImage, what: string): void {
  checkSize(image.width, image.height, what);
  if (image.data.length !== image.width * image.height)
    throw new RangeError(`forensic: ${what} data length does not match its dimensions`);
}

/** Suspect pixels beyond this multiple of the reference's are refused (memory/CPU bound). */
export const FORENSIC_MAX_SUSPECT_PIXEL_RATIO = 4;
/** Suspect aspect ratio may differ from the reference's by at most this factor. */
export const FORENSIC_MAX_ASPECT_FACTOR = 1.5;

/**
 * Defence in depth for the detect route (review R1-1): a 200 × 250,000 px "page" registered
 * against a 1600 px reference costs ~15 s and > 1 GB. A real leak is the page, possibly cropped
 * by ≤ 8 % per edge and rescaled, so its aspect stays within ~1.2× of the reference's.
 */
function checkGeometry(reference: GrayImage, suspect: GrayImage): void {
  const refPixels = reference.width * reference.height;
  if (suspect.width * suspect.height > FORENSIC_MAX_SUSPECT_PIXEL_RATIO * refPixels)
    throw new RangeError("forensic: suspect has far more pixels than the reference page");
  const aspect = suspect.width / suspect.height / (reference.width / reference.height);
  if (aspect > FORENSIC_MAX_ASPECT_FACTOR || aspect < 1 / FORENSIC_MAX_ASPECT_FACTOR)
    throw new RangeError("forensic: suspect aspect ratio does not match the reference page");
}

function checkSeed(seed: Uint8Array): void {
  if (!(seed instanceof Uint8Array) || seed.length !== 32)
    throw new RangeError("forensic: seed must be 32 bytes");
}

/** Embeds the mark keyed by `seed`; returns a new buffer. Deterministic. */
export function embedForensicMark(
  image: RgbImage,
  seed: Uint8Array,
  options?: EmbedOptions,
): RgbImage {
  checkRgb(image);
  checkSeed(seed);
  const strength = options?.strength ?? FORENSIC_DEFAULT_STRENGTH;
  if (!(strength > 0 && strength <= 4))
    throw new RangeError("forensic: strength must be in (0, 4]");
  const { width: w, height: h, channels: ch, data } = image;
  const amp = amplitudeMap(lumaOf(data, w, h, ch), w, h, strength);
  const lat = latticeOf(w, h);
  const signs = patternSigns(seed, lat.cols * lat.rows);
  const xi = new Int32Array(w);
  const xf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = x / lat.cellPx;
    const i = Math.floor(fx);
    xi[x] = i;
    xf[x] = fx - i;
  }
  const rowVals = new Float32Array(lat.cols);
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) {
    const fy = y / lat.cellPx;
    const j = Math.floor(fy);
    const ty = fy - j;
    const r0 = j * lat.cols;
    const r1 = r0 + lat.cols;
    for (let i = 0; i < lat.cols; i++) {
      const a = signs[r0 + i] as number;
      rowVals[i] = a + ty * ((signs[r1 + i] as number) - a);
    }
    let o = y * w * ch;
    const arow = y * w;
    for (let x = 0; x < w; x++, o += ch) {
      const i = xi[x] as number;
      const a = rowVals[i] as number;
      const d =
        (amp[arow + x] as number) * (a + (xf[x] as number) * ((rowVals[i + 1] as number) - a));
      for (let c = 0; c < 3; c++) {
        const v = Math.round((data[o + c] as number) + d);
        out[o + c] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
      if (ch === 4) out[o + 3] = data[o + 3] as number;
    }
  }
  return { width: w, height: h, channels: ch, data: out };
}

/**
 * Rows [y0, y0 + rows) of the reference degraded by a down-then-up resampling by `k` (mimics a
 * lossy rescale chain the suspect went through).
 */
function downUp(ref: FloatImage, k: number, y0: number, rows: number): Float32Array {
  const down = resample(
    ref,
    Math.max(1, Math.ceil(ref.w / k)),
    Math.max(1, Math.ceil(rows / k)),
    1 / k,
    0,
    1 / k,
    -y0 / k,
  ).img;
  return resample(down, ref.w, rows, k, 0, k, 0).img.d;
}

/**
 * Residual `suspect − median[suspect | reference level]` over the valid samples (written to
 * `out`); returns its clipped mean power. Removes gamma/contrast/tone changes; the median ignores
 * the strokes of a visible watermark that the reference does not have. The mark is independent of
 * the reference level, so it survives.
 */
function toneMatchedResidual(
  ref: Float32Array,
  sus: Float32Array,
  valid: Uint8Array,
  out: Float32Array,
): number {
  const hist = new Uint32Array(256 * 256);
  const cnt = new Float64Array(256);
  let n = 0;
  let sr = 0;
  let ss = 0;
  let srr = 0;
  let srs = 0;
  for (let i = 0; i < ref.length; i++) {
    if (valid[i] === 0) continue;
    const r = ref[i] as number;
    const s = sus[i] as number;
    const b = r <= 0 ? 0 : r >= 255 ? 255 : (r + 0.5) | 0;
    const q = s <= 0 ? 0 : s >= 255 ? 255 : (s + 0.5) | 0;
    hist[(b << 8) | q] = (hist[(b << 8) | q] as number) + 1;
    cnt[b] = (cnt[b] as number) + 1;
    n++;
    sr += r;
    ss += s;
    srr += r * r;
    srs += r * s;
  }
  const varR = srr - (sr * sr) / Math.max(1, n);
  const slope = varR > 1e-9 ? (srs - (sr * ss) / n) / varR : 0;
  const icpt = n > 0 ? (ss - slope * sr) / n : 0;
  const pred = new Float32Array(256);
  for (let b = 0; b < 256; b++) {
    const c = cnt[b] as number;
    if (c < 32) {
      pred[b] = icpt + slope * b;
      continue;
    }
    // median with linear interpolation inside the median bin
    const half = c / 2;
    let acc = 0;
    let q = 0;
    for (; q < 256; q++) {
      const h = hist[(b << 8) | q] as number;
      if (acc + h >= half) {
        pred[b] = q - 0.5 + (half - acc) / Math.max(1, h);
        break;
      }
      acc += h;
    }
  }
  let power = 0;
  for (let i = 0; i < ref.length; i++) {
    if (valid[i] === 0) {
      out[i] = 0;
      continue;
    }
    const r = ref[i] as number;
    const b = r <= 0 ? 0 : r >= 255 ? 255 : (r + 0.5) | 0;
    const e = (sus[i] as number) - (pred[b] as number);
    out[i] = e;
    const c = e > RESIDUAL_CLIP ? RESIDUAL_CLIP : e < -RESIDUAL_CLIP ? -RESIDUAL_CLIP : e;
    power += c * c;
  }
  return n > 0 ? power / n : Number.POSITIVE_INFINITY;
}

/**
 * Per-node statistics x_n: the clipped residual projected onto node n's tent, weighted by the
 * embedding amplitude and divided by the node's local residual power. A function of
 * (reference, suspect) only.
 */
function nodeStatistics(
  residual: Float32Array,
  valid: Uint8Array,
  amp: Float32Array,
  w: number,
  h: number,
): Float64Array {
  const lat = latticeOf(w, h);
  const nodes = lat.cols * lat.rows;
  const num = new Float64Array(nodes);
  const pow = new Float64Array(nodes);
  const mass = new Float64Array(nodes);
  const xi = new Int32Array(w);
  const xf = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const fx = x / lat.cellPx;
    const i = Math.floor(fx);
    xi[x] = i;
    xf[x] = fx - i;
  }
  for (let y = 0; y < h; y++) {
    const fy = y / lat.cellPx;
    const j = Math.floor(fy);
    const ty = fy - j;
    const r0 = j * lat.cols;
    const r1 = r0 + lat.cols;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const p = row + x;
      if (valid[p] === 0) continue;
      let e = residual[p] as number;
      if (e > RESIDUAL_CLIP) e = RESIDUAL_CLIP;
      else if (e < -RESIDUAL_CLIP) e = -RESIDUAL_CLIP;
      const v = (amp[p] as number) * e;
      const e2 = e * e;
      const i = xi[x] as number;
      const tx = xf[x] as number;
      const w00 = (1 - tx) * (1 - ty);
      const w10 = tx * (1 - ty);
      const w01 = (1 - tx) * ty;
      const w11 = tx * ty;
      const a = r0 + i;
      const b = r1 + i;
      num[a] = (num[a] as number) + w00 * v;
      num[a + 1] = (num[a + 1] as number) + w10 * v;
      num[b] = (num[b] as number) + w01 * v;
      num[b + 1] = (num[b + 1] as number) + w11 * v;
      pow[a] = (pow[a] as number) + w00 * e2;
      pow[a + 1] = (pow[a + 1] as number) + w10 * e2;
      pow[b] = (pow[b] as number) + w01 * e2;
      pow[b + 1] = (pow[b + 1] as number) + w11 * e2;
      mass[a] = (mass[a] as number) + w00;
      mass[a + 1] = (mass[a + 1] as number) + w10;
      mass[b] = (mass[b] as number) + w01;
      mass[b + 1] = (mass[b + 1] as number) + w11;
    }
  }
  const raw = new Float64Array(nodes);
  for (let n = 0; n < nodes; n++) {
    const m = mass[n] as number;
    if (m <= 0) continue;
    raw[n] = (num[n] as number) / ((pow[n] as number) / m + NOISE_FLOOR);
  }
  // High-pass on the lattice: subtract the 3×3 neighbourhood mean. Removes what is smooth across
  // nodes (tone drift, a codec's DC shift around another viewer's watermark); the pattern is
  // independent per node, so it keeps 8/9 of its amplitude.
  const x = new Float64Array(nodes);
  const { cols, rows } = lat;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const n = j * cols + i;
      if ((mass[n] as number) <= 0) continue;
      let sum = 0;
      let k = 0;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= rows) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= cols) continue;
          const m = jj * cols + ii;
          if ((mass[m] as number) <= 0) continue;
          sum += raw[m] as number;
          k++;
        }
      }
      x[n] = (raw[n] as number) - sum / k;
    }
  }
  return x;
}

/** First row of the `band`-row window with the largest summed amplitude (edge content). */
function busiestBand(amp: Float32Array, w: number, h: number, band: number): number {
  const rowSum = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = 0, p = y * w; x < w; x++, p++) acc += amp[p] as number;
    rowSum[y] = acc;
  }
  let acc = 0;
  for (let y = 0; y < band; y++) acc += rowSum[y] as number;
  let best = acc;
  let at = 0;
  for (let y = band; y < h; y++) {
    acc += (rowSum[y] as number) - (rowSum[y - band] as number);
    if (acc > best) {
      best = acc;
      at = y - band + 1;
    }
  }
  return at;
}

/** Registers `suspect` onto `reference` and scores every candidate's pattern. */
export function detectForensicMarks(
  reference: GrayImage,
  suspect: GrayImage,
  candidates: readonly DetectCandidate[],
  options?: DetectOptions,
): DetectResult {
  checkGray(reference, "reference");
  checkGray(suspect, "suspect");
  checkGeometry(reference, suspect);
  const thresholds = options?.thresholds ?? forensicThresholds(candidates.length);
  if (!(thresholds.match >= thresholds.inconclusive && thresholds.inconclusive > 0))
    throw new RangeError("forensic: thresholds must satisfy match ≥ inconclusive > 0");
  const max = options?.maxCandidates ?? FORENSIC_DEFAULT_MAX_CANDIDATES;
  if (candidates.length > max)
    throw new RangeError(`forensic: ${candidates.length} candidates exceed the cap of ${max}`);
  for (const c of candidates) checkSeed(c.seed);
  const { width: w, height: h } = reference;
  const ref = toFloat(reference.data, w, h);
  const sus = toFloat(suspect.data, suspect.width, suspect.height);

  // 1. registration from the images alone
  const aligned = register(ref, sus);
  const warped = warpToReference(sus, w, h, aligned);

  // 2. reference pre-blur that best explains the suspect (candidate-independent), judged on the
  // band of rows with the most edge content, then applied to the whole page
  const amp = amplitudeMap(reference.data, w, h, 1);
  const band = Math.min(h, Math.max(64, Math.round(h / 5)));
  const y0 = busiestBand(amp, w, h, band);
  const factors = [1, 1.5, 2];
  if (aligned.scale > 1.05 && aligned.scale < 4) factors.push(aligned.scale);
  const susBand = warped.img.d.subarray(y0 * w, (y0 + band) * w);
  const validBand = warped.valid.subarray(y0 * w, (y0 + band) * w);
  const scratch = new Float32Array(w * band);
  let factor = 1;
  let bestPower = Number.POSITIVE_INFINITY;
  for (const k of factors) {
    const r = k === 1 ? ref.d.subarray(y0 * w, (y0 + band) * w) : downUp(ref, k, y0, band);
    const power = toneMatchedResidual(r, susBand, validBand, scratch);
    if (power < bestPower - 1e-9) {
      bestPower = power;
      factor = k;
    }
  }
  const residual = new Float32Array(w * h);
  toneMatchedResidual(
    factor === 1 ? ref.d : downUp(ref, factor, 0, h),
    warped.img.d,
    warped.valid,
    residual,
  );

  // 3. node statistics, weighted by the amplitude the embedder used on this page
  const x = nodeStatistics(residual, warped.valid, amp, w, h);
  let energy = 0;
  for (let n = 0; n < x.length; n++) energy += (x[n] as number) * (x[n] as number);
  const norm = Math.sqrt(energy);

  // 4. one correlation per candidate
  const scores = candidates.map((c) => {
    const z = norm > 0 ? correlate(patternBits(c.seed, x.length), x) / norm : 0;
    return { id: c.id, z, verdict: forensicVerdict(z, thresholds) };
  });
  scores.sort((a, b) => b.z - a.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const minZ = scores.length > 0 ? (scores[scores.length - 1]?.z ?? 0) : 0;
  return {
    aligned: {
      scale: aligned.scale,
      dx: aligned.dx,
      dy: aligned.dy,
      quality: aligned.quality,
    },
    scores,
    thresholds,
    minZ,
  };
}

/** Amplitudes used at strength 1 (documentation / tests). */
export const FORENSIC_AMPLITUDE = { flat: ALPHA_FLAT, edge: ALPHA_EDGE } as const;
