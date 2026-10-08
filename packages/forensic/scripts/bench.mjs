#!/usr/bin/env node
/*
 * Forensic engine benchmark (E3.13). Run after `pnpm --filter @fundroom/forensic build`:
 *
 *   node packages/forensic/scripts/bench.mjs [candidates=200] [runs=7]
 *
 * Prints the median embed time for a 1600×2070 page (the data room's page width), the median
 * detection time against N candidates for a few leak shapes, the mark's PSNR, the true
 * recipient's z and the largest innocent z. Pure engine — no codecs; the render-pdfium tests
 * cover the real webp/jpeg pipeline.
 */
import { createHash } from "node:crypto";
import { resample } from "../dist/image.js";
import { detectForensicMarks, embedForensicMark, rgbToGray } from "../dist/index.js";

const N = Number(process.argv[2] ?? 200);
const RUNS = Number(process.argv[3] ?? 7);
const W = 1600;
const H = 2070;

const seedOf = (label) => new Uint8Array(createHash("sha256").update(label).digest());

function page() {
  const data = new Uint8Array(W * H * 3).fill(255);
  let s = 42;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
  const u = W / 612;
  const ink = (x0, y0, x1, y1, level) => {
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        const o = (y * W + x) * 3;
        data[o] = data[o + 1] = data[o + 2] = level;
      }
  };
  ink(72 * u, 60 * u, 400 * u, 78 * u, 20);
  for (let line = 0; line < 42; line++) {
    const y = (110 + line * 14) * u;
    let x = 72 * u;
    while (x < 520 * u) {
      const word = (12 + rnd() * 40) * u;
      for (let g = x; g < x + word; g += 3.1 * u) ink(g, y, g + 1.4 * u, y + 7 * u, 30);
      x += word + 4 * u;
    }
  }
  return { width: W, height: H, channels: 3, data };
}

function scaleTo(g, width) {
  const f = width / g.width;
  const height = Math.round(g.height * f);
  const src = { w: g.width, h: g.height, d: Float32Array.from(g.data) };
  const out = resample(src, width, height, f, 0, height / g.height, 0).img.d;
  return {
    width,
    height,
    data: Uint8Array.from(out, (v) => Math.max(0, Math.min(255, Math.round(v)))),
  };
}

function crop(g, frac) {
  const x0 = Math.round(g.width * frac);
  const y0 = Math.round(g.height * frac);
  const w = g.width - 2 * x0;
  const h = g.height - 2 * y0;
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    data.set(g.data.subarray((y + y0) * g.width + x0, (y + y0) * g.width + x0 + w), y * w);
  return { width: w, height: h, data };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const unmarked = page();
const truth = { id: "truth", seed: seedOf("truth") };
const candidates = [
  truth,
  ...Array.from({ length: N - 1 }, (_, i) => ({ id: `c${i}`, seed: seedOf(`c${i}`) })),
];

let marked;
const embedTimes = [];
for (let i = 0; i < RUNS + 1; i++) {
  const t0 = performance.now();
  marked = embedForensicMark(unmarked, truth.seed);
  if (i > 0) embedTimes.push(performance.now() - t0);
}
let mse = 0;
for (let i = 0; i < marked.data.length; i++) mse += (marked.data[i] - unmarked.data[i]) ** 2;
const psnr = 10 * Math.log10((255 * 255) / (mse / marked.data.length));
process.stdout.write(
  `embed ${W}×${H}: median ${median(embedTimes).toFixed(0)} ms over ${RUNS} runs; PSNR ${psnr.toFixed(1)} dB\n`,
);

const reference = rgbToGray(unmarked);
const leakedFull = rgbToGray(marked);
const leaks = {
  "as served": leakedFull,
  "rescaled to 1170 wide": scaleTo(leakedFull, 1170),
  "cropped 5 %/edge": crop(leakedFull, 0.05),
};
for (const [name, suspect] of Object.entries(leaks)) {
  const times = [];
  let result;
  for (let i = 0; i < Math.max(3, Math.ceil(RUNS / 2)); i++) {
    const t0 = performance.now();
    result = detectForensicMarks(reference, suspect, candidates);
    times.push(performance.now() - t0);
  }
  const z = result.scores.find((s) => s.id === truth.id).z;
  const innocent = Math.max(...result.scores.filter((s) => s.id !== truth.id).map((s) => s.z));
  process.stdout.write(
    `detect ${name} (${suspect.width}×${suspect.height}), ${N} candidates: median ${median(times).toFixed(0)} ms; true z ${z.toFixed(1)}, max innocent z ${innocent.toFixed(2)}, alignment q ${result.aligned.quality.toFixed(3)}\n`,
  );
}
