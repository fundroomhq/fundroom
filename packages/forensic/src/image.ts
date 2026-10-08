/*
 * Image primitives for the forensic engine: float images, an anti-aliased separable resampler
 * (scale + offset per axis, tent filter widened when shrinking), a separable box blur and BT.601
 * luma. Everything works on typed arrays with no per-pixel allocation.
 */

/** A single-channel float image, row-major. */
export interface FloatImage {
  readonly w: number;
  readonly h: number;
  readonly d: Float32Array;
}

/** 8-bit luma of interleaved RGB(A) pixels (BT.601, integer weights 77/150/29). */
export function lumaOf(
  data: Uint8Array,
  width: number,
  height: number,
  channels: number,
): Uint8Array {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, o = 0; i < n; i++, o += channels) {
    out[i] =
      (77 * (data[o] as number) +
        150 * (data[o + 1] as number) +
        29 * (data[o + 2] as number) +
        128) >>
      8;
  }
  return out;
}

export function toFloat(data: Uint8Array, w: number, h: number): FloatImage {
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = data[i] as number;
  return { w, h, d };
}

interface AxisTable {
  readonly lo: Int32Array;
  readonly n: Int32Array;
  readonly wt: Float32Array;
  readonly taps: number;
  readonly valid: Uint8Array;
}

/**
 * Per-output-sample filter taps for one axis. Continuous (pixel-centre) coordinates map as
 * `out = scale · src + offset`. The tent's support is max(1, 1/scale) source pixels, so a
 * shrink averages (area-like) and an enlargement interpolates bilinearly.
 */
function axisTable(srcLen: number, outLen: number, scale: number, offset: number): AxisTable {
  const support = Math.max(1, 1 / scale);
  const taps = Math.ceil(support) * 2 + 1;
  const lo = new Int32Array(outLen);
  const n = new Int32Array(outLen);
  const wt = new Float32Array(outLen * taps);
  const valid = new Uint8Array(outLen);
  for (let o = 0; o < outLen; o++) {
    const c = (o + 0.5 - offset) / scale - 0.5;
    valid[o] = c >= -0.5 && c <= srcLen - 0.5 ? 1 : 0;
    let a = Math.floor(c - support) + 1;
    let b = Math.ceil(c + support) - 1;
    if (a < 0) a = 0;
    if (b > srcLen - 1) b = srcLen - 1;
    let sum = 0;
    let k = 0;
    for (let i = a; i <= b && k < taps; i++, k++) {
      const t = 1 - Math.abs(i - c) / support;
      const v = t > 0 ? t : 0;
      wt[o * taps + k] = v;
      sum += v;
    }
    if (sum <= 0) {
      // Outside the source: clamp to the nearest edge sample (the caller ignores invalid ones).
      const near = Math.min(srcLen - 1, Math.max(0, Math.round(c)));
      lo[o] = near;
      n[o] = 1;
      wt[o * taps] = 1;
      for (let j = 1; j < taps; j++) wt[o * taps + j] = 0;
      continue;
    }
    lo[o] = a;
    n[o] = k;
    for (let j = 0; j < k; j++) wt[o * taps + j] = (wt[o * taps + j] as number) / sum;
  }
  return { lo, n, wt, taps, valid };
}

export interface Resampled {
  readonly img: FloatImage;
  /** 1 where the output sample lies inside the source, else 0. */
  readonly valid: Uint8Array;
  /** Number of valid samples. */
  readonly validCount: number;
}

/**
 * Resamples `src` to `outW × outH` with `out = sx · src + ox` (x) and `out = sy · src + oy` (y)
 * in continuous pixel-centre coordinates.
 */
export function resample(
  src: FloatImage,
  outW: number,
  outH: number,
  sx: number,
  ox: number,
  sy: number,
  oy: number,
): Resampled {
  const ax = axisTable(src.w, outW, sx, ox);
  const ay = axisTable(src.h, outH, sy, oy);
  // Only the source rows some output row reads.
  let rowLo = src.h;
  let rowHi = -1;
  for (let o = 0; o < outH; o++) {
    const a = ay.lo[o] as number;
    const b = a + (ay.n[o] as number) - 1;
    if (a < rowLo) rowLo = a;
    if (b > rowHi) rowHi = b;
  }
  const tmp = new Float32Array(outW * src.h);
  const sd = src.d;
  const sw = src.w;
  const xt = ax.taps;
  for (let y = rowLo; y <= rowHi; y++) {
    const row = y * sw;
    const trow = y * outW;
    for (let o = 0; o < outW; o++) {
      const base = row + (ax.lo[o] as number);
      const cnt = ax.n[o] as number;
      const wb = o * xt;
      let acc = 0;
      for (let k = 0; k < cnt; k++) acc += (sd[base + k] as number) * (ax.wt[wb + k] as number);
      tmp[trow + o] = acc;
    }
  }
  const out = new Float32Array(outW * outH);
  const yt = ay.taps;
  for (let o = 0; o < outH; o++) {
    const a = ay.lo[o] as number;
    const cnt = ay.n[o] as number;
    const orow = o * outW;
    for (let k = 0; k < cnt; k++) {
      const w = ay.wt[o * yt + k] as number;
      if (w === 0) continue;
      const trow = (a + k) * outW;
      for (let x = 0; x < outW; x++)
        out[orow + x] = (out[orow + x] as number) + w * (tmp[trow + x] as number);
    }
  }
  const valid = new Uint8Array(outW * outH);
  let validCount = 0;
  for (let y = 0; y < outH; y++) {
    if (ay.valid[y] === 0) continue;
    const row = y * outW;
    for (let x = 0; x < outW; x++) {
      if (ax.valid[x] === 1) {
        valid[row + x] = 1;
        validCount++;
      }
    }
  }
  return { img: { w: outW, h: outH, d: out }, valid, validCount };
}

/** Uniform rescale by `factor` (output px per source px), offset 0. */
export function rescale(src: FloatImage, factor: number): FloatImage {
  const outW = Math.max(1, Math.round(src.w * factor));
  const outH = Math.max(1, Math.round(src.h * factor));
  return resample(src, outW, outH, outW / src.w, 0, outH / src.h, 0).img;
}

/** In-place separable box blur (mean over the in-bounds window of radius `r`). */
export function boxBlur(d: Float32Array, w: number, h: number, r: number): void {
  if (r <= 0) return;
  const line = new Float32Array(Math.max(w, h));
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) line[x] = d[row + x] as number;
    let acc = 0;
    let cnt = 0;
    for (let x = 0; x < Math.min(r, w); x++) {
      acc += line[x] as number;
      cnt++;
    }
    for (let x = 0; x < w; x++) {
      const add = x + r;
      if (add < w) {
        acc += line[add] as number;
        cnt++;
      }
      const drop = x - r - 1;
      if (drop >= 0) {
        acc -= line[drop] as number;
        cnt--;
      }
      d[row + x] = acc / cnt;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) line[y] = d[y * w + x] as number;
    let acc = 0;
    let cnt = 0;
    for (let y = 0; y < Math.min(r, h); y++) {
      acc += line[y] as number;
      cnt++;
    }
    for (let y = 0; y < h; y++) {
      const add = y + r;
      if (add < h) {
        acc += line[add] as number;
        cnt++;
      }
      const drop = y - r - 1;
      if (drop >= 0) {
        acc -= line[drop] as number;
        cnt--;
      }
      d[y * w + x] = acc / cnt;
    }
  }
}

/**
 * A halving pyramid: `at(factor)` returns the exact uniform rescale of the base image (sizes
 * rounded up, so level coordinates are exactly `factor ×` base coordinates) by resampling the
 * nearest finer halving level, which keeps a coarse resample from reading every base pixel.
 */
export class Pyramid {
  private readonly levels: FloatImage[];
  private readonly cache = new Map<number, FloatImage>();

  constructor(base: FloatImage) {
    this.levels = [base];
    let cur = base;
    while (cur.w >= 64 && cur.h >= 64) {
      cur = resample(cur, Math.ceil(cur.w / 2), Math.ceil(cur.h / 2), 0.5, 0, 0.5, 0).img;
      this.levels.push(cur);
    }
  }

  get base(): FloatImage {
    return this.levels[0] as FloatImage;
  }

  at(factor: number, cache = false): FloatImage {
    if (factor === 1) return this.base;
    const hit = this.cache.get(factor);
    if (hit) return hit;
    let k = factor < 1 ? Math.floor(-Math.log2(factor)) : 0;
    if (k > this.levels.length - 1) k = this.levels.length - 1;
    const src = this.levels[k] as FloatImage;
    const local = factor * 2 ** k;
    const base = this.base;
    const w = Math.max(1, Math.ceil(base.w * factor - 1e-6));
    const h = Math.max(1, Math.ceil(base.h * factor - 1e-6));
    const out = resample(src, w, h, local, 0, local, 0).img;
    if (cache) this.cache.set(factor, out);
    return out;
  }
}
