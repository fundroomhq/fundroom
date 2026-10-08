import { type FloatImage, Pyramid, resample } from "./image.js";

/*
 * Registration of a suspect image onto the reference page: uniform scale + translation, found by
 * maximising the normalised cross-correlation (NCC) of the two *images* — never of any
 * candidate's pattern, so the alignment cannot be tuned towards (and inflate the score of) a
 * particular recipient.
 *
 * Model (continuous pixel-centre coordinates): reference = scale · suspect + (dx, dy).
 * Search space: the suspect shows the page cropped by at most MAX_CROP per edge, at any size.
 *  1. coarse: reference at ~COARSE_WIDTH px wide; exhaustive over scale (steps of half a coarse
 *     pixel of drift) × integer translation;
 *  2. pyramid refinement at 192 / 384 / 800 px and full width: a small exhaustive translation
 *     search (guards against locking onto the neighbouring text line) then coordinate ascent
 *     over (dx, dy, scale about the page centre) with steps of 1 → ½ → ¼ level pixel.
 * Rotation, perspective and print-scan are out of scope (documented limit).
 */

/** Largest crop per edge the search allows for (the requirement is 5 %). */
export const MAX_CROP = 0.08;
const COARSE_WIDTH = 96;
const REFINE_WIDTHS = [192, 384, 800];
const SAMPLE_BUDGET = 160_000;
const COARSE_SEEDS = 4;

export interface Alignment {
  /** Reference pixels per suspect pixel. */
  readonly scale: number;
  readonly dx: number;
  readonly dy: number;
  /** NCC of the registered images at full reference resolution (−1…1). */
  readonly quality: number;
}

interface Params {
  s: number;
  dx: number;
  dy: number;
}

/** Pearson correlation of zero-offset integer-shifted images (coarse search). */
function nccShift(a: FloatImage, b: FloatImage, tx: number, ty: number): number {
  const x0 = Math.max(0, -tx);
  const y0 = Math.max(0, -ty);
  const x1 = Math.min(b.w, a.w - tx);
  const y1 = Math.min(b.h, a.h - ty);
  if (x1 - x0 < 4 || y1 - y0 < 4) return -1;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  const ad = a.d;
  const bd = b.d;
  for (let y = y0; y < y1; y++) {
    const arow = (y + ty) * a.w + tx;
    const brow = y * b.w;
    for (let x = x0; x < x1; x++) {
      const va = ad[arow + x] as number;
      const vb = bd[brow + x] as number;
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
    }
  }
  const n = (x1 - x0) * (y1 - y0);
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  if (va <= 1e-6 || vb <= 1e-6) return 0;
  return cov / Math.sqrt(va * vb);
}

/**
 * NCC between the reference level `rl` (factor `f`: full-res px per level px) and the suspect
 * level `sl` (built with factor `g`: level px per suspect px) under params `p`, sampled with
 * stride `stride` over the reference level grid.
 */
function nccAt(
  rl: FloatImage,
  sl: FloatImage,
  f: number,
  g: number,
  p: Params,
  stride: number,
): number {
  const k = g / p.s;
  const sw = sl.w;
  const sh = sl.h;
  const sd = sl.d;
  const rd = rl.d;
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  let n = 0;
  for (let y = 0; y < rl.h; y += stride) {
    const v = ((y + 0.5) * f - p.dy) * k - 0.5;
    if (v < 0 || v > sh - 1) continue;
    const v0 = Math.floor(v);
    const fy = v - v0;
    const v1 = v0 + 1 < sh ? v0 + 1 : v0;
    const r0 = v0 * sw;
    const r1 = v1 * sw;
    const rrow = y * rl.w;
    for (let x = 0; x < rl.w; x += stride) {
      const u = ((x + 0.5) * f - p.dx) * k - 0.5;
      if (u < 0 || u > sw - 1) continue;
      const u0 = Math.floor(u);
      const fx = u - u0;
      const u1 = u0 + 1 < sw ? u0 + 1 : u0;
      const top =
        (sd[r0 + u0] as number) + fx * ((sd[r0 + u1] as number) - (sd[r0 + u0] as number));
      const bot =
        (sd[r1 + u0] as number) + fx * ((sd[r1 + u1] as number) - (sd[r1 + u0] as number));
      const vb = top + fy * (bot - top);
      const va = rd[rrow + x] as number;
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
      n++;
    }
  }
  if (n < 16) return -1;
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  if (va <= 1e-6 || vb <= 1e-6) return 0;
  return cov / Math.sqrt(va * vb);
}

/**
 * Centre of the page's content (ink-weighted), full-res coordinates: the pivot for scale moves,
 * so that changing the scale stretches the content about itself instead of sliding it away (on
 * a page whose only content is a heading, a scale step about the page centre moves the heading
 * and is always rejected).
 */
function contentCentroid(rc: FloatImage, f: number): { x: number; y: number } {
  const hist = new Uint32Array(256);
  for (let i = 0; i < rc.d.length; i++) {
    const v = rc.d[i] as number;
    hist[v <= 0 ? 0 : v >= 255 ? 255 : v | 0] =
      (hist[v <= 0 ? 0 : v >= 255 ? 255 : v | 0] as number) + 1;
  }
  let acc = 0;
  let bg = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v] as number;
    if (acc * 2 >= rc.d.length) {
      bg = v;
      break;
    }
  }
  let sw = 0;
  let sx = 0;
  let sy = 0;
  for (let y = 0; y < rc.h; y++) {
    for (let x = 0; x < rc.w; x++) {
      const d = (rc.d[y * rc.w + x] as number) - bg;
      const w = d < 0 ? -d : d;
      sw += w;
      sx += w * (x + 0.5);
      sy += w * (y + 0.5);
    }
  }
  if (sw <= 0) return { x: (rc.w * f) / 2, y: (rc.h * f) / 2 };
  return { x: (sx / sw) * f, y: (sy / sw) * f };
}

/** One pyramid level: small exhaustive translation search, then coordinate ascent. */
function refineLevel(
  reference: Pyramid,
  suspect: Pyramid,
  lw: number,
  firstLevel: boolean,
  start: Params,
  pivot: { x: number; y: number },
): { p: Params; score: number } {
  const f = reference.base.w / lw;
  const rl = reference.at(1 / f, true);
  const g = start.s / f;
  const sl = suspect.at(g);
  const stride = Math.max(1, Math.floor(Math.sqrt((rl.w * rl.h) / SAMPLE_BUDGET)));
  let p = start;
  let score = nccAt(rl, sl, f, g, p, stride);
  const reach = firstLevel ? 3 : 2;
  for (let ty = -reach; ty <= reach; ty++) {
    for (let tx = -reach; tx <= reach; tx++) {
      if (tx === 0 && ty === 0) continue;
      const q = { s: start.s, dx: start.dx + tx * f, dy: start.dy + ty * f };
      const v = nccAt(rl, sl, f, g, q, stride);
      if (v > score) {
        score = v;
        p = q;
      }
    }
  }
  const steps = firstLevel ? [2, 1, 0.5, 0.25] : [1, 0.5, 0.25];
  for (const stepPx of steps) {
    for (let iter = 0; iter < 32; iter++) {
      let moved = false;
      const ds = stepPx / lw;
      const moves: Params[] = [
        { s: p.s, dx: p.dx + stepPx * f, dy: p.dy },
        { s: p.s, dx: p.dx - stepPx * f, dy: p.dy },
        { s: p.s, dx: p.dx, dy: p.dy + stepPx * f },
        { s: p.s, dx: p.dx, dy: p.dy - stepPx * f },
      ];
      for (const m of [1 + ds, 1 - ds]) {
        // keep the pivot's suspect point fixed: X_pivot = s·U + d ⇒ d' = X − (X − d)·m
        moves.push({
          s: p.s * m,
          dx: pivot.x - (pivot.x - p.dx) * m,
          dy: pivot.y - (pivot.y - p.dy) * m,
        });
      }
      for (const q of moves) {
        const v = nccAt(rl, sl, f, g, q, stride);
        if (v > score + 1e-9) {
          score = v;
          p = q;
          moved = true;
        }
      }
      if (!moved) break;
    }
  }
  return { p, score };
}

/** Registers `suspect` onto `reference` (both luma as float images). */
export function register(refImage: FloatImage, susImage: FloatImage): Alignment {
  const reference = new Pyramid(refImage);
  const suspect = new Pyramid(susImage);
  const rw = refImage.w;
  const rh = refImage.h;
  const ratioW = rw / susImage.w;
  const ratioH = rh / susImage.h;
  let sLo = (1 - 2 * MAX_CROP) * Math.max(ratioW, ratioH) * 0.995;
  let sHi = Math.min(ratioW, ratioH) * 1.01;
  if (sLo > sHi) [sLo, sHi] = [Math.min(sLo, sHi), Math.max(sLo, sHi)];

  // 1. coarse exhaustive search
  const cw = Math.min(COARSE_WIDTH, rw);
  const f0 = rw / cw;
  const rc = reference.at(1 / f0);
  const step = 1 + 0.5 / cw;
  const perScale: { p: Params; score: number }[] = [];
  for (let s = sLo; s <= sHi * 1.0001; s *= step) {
    const sc = suspect.at(s / f0);
    let top: { p: Params; score: number } = { p: { s, dx: 0, dy: 0 }, score: -2 };
    for (let ty = -2; ty <= rc.h - sc.h + 2; ty++) {
      for (let tx = -2; tx <= rc.w - sc.w + 2; tx++) {
        const v = nccShift(rc, sc, tx, ty);
        // Level pixel u ↔ reference level pixel u + t; full-res: X = s·U + f0·t.
        if (v > top.score) top = { p: { s, dx: tx * f0, dy: ty * f0 }, score: v };
      }
    }
    perScale.push(top);
  }
  // Local maxima over scale, best first: a sparse page (a heading on white) leaves the scale
  // ambiguous at this resolution, so the first refinement level arbitrates between them.
  const seeds = perScale
    .filter(
      (c, i) =>
        c.score >= (perScale[i - 1]?.score ?? -3) && c.score >= (perScale[i + 1]?.score ?? -3),
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, COARSE_SEEDS);
  const pivot = contentCentroid(rc, f0);

  // 2. pyramid refinement (every seed through the first level, the winner through the rest)
  const widths = REFINE_WIDTHS.filter((w) => w < rw * 0.75);
  widths.push(rw);
  const first = widths[0] as number;
  let p = seeds[0]?.p ?? { s: Math.sqrt(sLo * sHi), dx: 0, dy: 0 };
  let quality = -1;
  for (const seed of seeds) {
    const r = refineLevel(reference, suspect, first, true, seed.p, pivot);
    if (r.score > quality) {
      quality = r.score;
      p = r.p;
    }
  }
  for (const lw of widths.slice(1)) {
    const r = refineLevel(reference, suspect, lw, false, p, pivot);
    p = r.p;
    quality = r.score;
  }
  return { scale: p.s, dx: p.dx, dy: p.dy, quality: Number.isFinite(quality) ? quality : 0 };
}

/** The suspect resampled onto the reference grid under `a` (+ which samples it covers). */
export function warpToReference(
  suspect: FloatImage,
  width: number,
  height: number,
  a: Alignment,
): ReturnType<typeof resample> {
  return resample(suspect, width, height, a.scale, a.dx, a.scale, a.dy);
}
