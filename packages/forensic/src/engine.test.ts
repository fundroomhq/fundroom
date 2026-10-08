import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import {
  type DetectCandidate,
  detectForensicMarks,
  embedForensicMark,
  FORENSIC_DEFAULT_MAX_CANDIDATES,
  FORENSIC_INCONCLUSIVE_Z,
  FORENSIC_MATCH_Z,
  FORENSIC_MIN_ALIGNMENT_QUALITY,
  forensicThresholds,
  forensicVerdict,
  type GrayImage,
  type RgbImage,
  rgbToGray,
} from "./engine.js";
import { boxBlur, type FloatImage, resample } from "./image.js";

/*
 * Engine-level tests on synthetic pages (no codecs here — the render-pdfium tests run the real
 * pipeline: PDFium-rendered pages, sharp webp/jpeg/resize attacks). The attacks below are the
 * geometric/photometric ones done in plain TypeScript: rescale, down-up, crop, noise, gamma and a
 * visible diagonal watermark of another viewer.
 */

const seedOf = (label: string) => new Uint8Array(createHash("sha256").update(label).digest());
const TRUE: DetectCandidate = { id: "recipient", seed: seedOf("recipient") };
const DECOYS: DetectCandidate[] = Array.from({ length: 50 }, (_, i) => ({
  id: `decoy-${i}`,
  seed: seedOf(`decoy-${i}`),
}));

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** A white page with "text": rows of anti-aliased dark word blocks, a heading, a grey box. */
function syntheticPage(width: number, height: number, kind: "text" | "blank" = "text"): RgbImage {
  const data = new Uint8Array(width * height * 3).fill(255);
  const rnd = lcg(42);
  const u = width / 612;
  const ink = (x0: number, y0: number, x1: number, y1: number, level: number) => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(height, Math.ceil(y1)); y++) {
      const cy = Math.min(1, y + 1 - y0, y1 - y);
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(width, Math.ceil(x1)); x++) {
        const cx = Math.min(1, x + 1 - x0, x1 - x);
        const cover = Math.max(0, cx) * Math.max(0, cy);
        const o = (y * width + x) * 3;
        for (let c = 0; c < 3; c++) {
          const v = data[o + c] as number;
          data[o + c] = Math.round(v + (level - v) * cover);
        }
      }
    }
  };
  ink(72 * u, 60 * u, 400 * u, 78 * u, 20); // heading
  if (kind === "blank") return { width, height, channels: 3, data };
  for (let line = 0; line < 40; line++) {
    const y = (110 + line * 15) * u;
    let x = 72 * u;
    while (x < 520 * u) {
      const word = (12 + rnd() * 40) * u;
      // glyph-ish strokes inside the word
      for (let g = x; g < x + word; g += 3.1 * u) ink(g, y, g + 1.4 * u, y + 7 * u, 30);
      ink(x, y + 2.5 * u, x + word, y + 3.4 * u, 60);
      x += word + 4 * u;
    }
  }
  ink(380 * u, 720 * u, 540 * u, 760 * u, 200); // grey box
  return { width, height, channels: 3, data };
}

function toFloatImage(g: GrayImage): FloatImage {
  const d = new Float32Array(g.data.length);
  for (let i = 0; i < d.length; i++) d[i] = g.data[i] as number;
  return { w: g.width, h: g.height, d };
}

function toGray8(f: FloatImage): GrayImage {
  const data = new Uint8Array(f.d.length);
  for (let i = 0; i < data.length; i++) {
    const v = Math.round(f.d[i] as number);
    data[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return { width: f.w, height: f.h, data };
}

const attacks: Record<string, (g: GrayImage) => GrayImage> = {
  identity: (g) => g,
  "rescale to 1170 wide": (g) => scaleTo(g, Math.round((g.width * 1170) / 1600)),
  "rescale to 2000 wide": (g) => scaleTo(g, Math.round((g.width * 2000) / 1600)),
  "50 % down and up": (g) => scaleTo(scaleTo(g, Math.round(g.width / 2)), g.width),
  "crop 5 % per edge": (g) => crop(g, 0.05, 0.05, 0.05, 0.05),
  "crop 4/1/5/2 % + rescale": (g) => scaleTo(crop(g, 0.04, 0.01, 0.05, 0.02), 700),
  "noise ±4 + gamma 0.8": (g) => {
    const rnd = lcg(7);
    const data = new Uint8Array(g.data.length);
    for (let i = 0; i < data.length; i++) {
      const v = 255 * ((g.data[i] as number) / 255) ** 0.8 + (rnd() - 0.5) * 8;
      data[i] = Math.max(0, Math.min(255, Math.round(v)));
    }
    return { ...g, data };
  },
  "another viewer's visible watermark": (g) => overlay(g),
};

function scaleTo(g: GrayImage, width: number): GrayImage {
  const f = width / g.width;
  const height = Math.round(g.height * f);
  return toGray8(resample(toFloatImage(g), width, height, f, 0, height / g.height, 0).img);
}

function crop(g: GrayImage, l: number, t: number, r: number, b: number): GrayImage {
  const x0 = Math.round(g.width * l);
  const y0 = Math.round(g.height * t);
  const w = g.width - x0 - Math.round(g.width * r);
  const h = g.height - y0 - Math.round(g.height * b);
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    data.set(g.data.subarray((y + y0) * g.width + x0, (y + y0) * g.width + x0 + w), y * w);
  return { width: w, height: h, data };
}

/** Diagonal bands of 18 %-opacity "text" (another viewer's tiled visible watermark). */
function overlay(g: GrayImage): GrayImage {
  const data = Uint8Array.from(g.data);
  const period = Math.round(g.width / 3);
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      const d = (x + y * 1.7) % period;
      const stroke = d < g.width / 40 && (x >> 2) % 3 !== 0;
      if (stroke) {
        const i = y * g.width + x;
        data[i] = Math.round((data[i] as number) * 0.82);
      }
    }
  }
  return { ...g, data };
}

function psnr(a: Uint8Array, b: Uint8Array): number {
  let mse = 0;
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    mse += d * d;
  }
  mse /= a.length;
  return mse === 0 ? Number.POSITIVE_INFINITY : 10 * Math.log10((255 * 255) / mse);
}

const W = 800;
const H = 1035;
const page = syntheticPage(W, H);
const reference = rgbToGray(page);
const marked = embedForensicMark(page, TRUE.seed);
const markedGray = rgbToGray(marked);

/*
 * Detection is ~0.3 s of pure CPU per call here, but `pnpm coverage` (V8 block coverage counts
 * every loop iteration) makes it 5–10× slower, and a shared CI runner another 2–3× (one test
 * took 20 s there): the timeout is a hang guard, not a speed budget, so the default 5 s is far
 * too short. The speed budgets are the `speed` block, measured outside the coverage session.
 */
const CPU_BOUND = { timeout: 120_000 };

describe("embedForensicMark", () => {
  it("is deterministic, returns a new buffer and leaves the input alone", () => {
    const before = Uint8Array.from(page.data);
    const again = embedForensicMark(page, TRUE.seed);
    expect(Buffer.from(again.data).equals(Buffer.from(marked.data))).toBe(true);
    expect(again.data).not.toBe(page.data);
    expect(Buffer.from(page.data).equals(Buffer.from(before))).toBe(true);
    const other = embedForensicMark(page, seedOf("someone else"));
    expect(Buffer.from(other.data).equals(Buffer.from(marked.data))).toBe(false);
    expect(marked).toMatchObject({ width: W, height: H, channels: 3 });
  });

  it("is invisible: PSNR ≥ 42 dB and blank paper moves by at most 2 levels", () => {
    expect(psnr(page.data, marked.data)).toBeGreaterThanOrEqual(42);
    // blank paper = pixels further than 8 px from any ink
    const near = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) near[i] = (page.data[i * 3] as number) < 255 ? 1 : 0;
    boxBlur(near, W, H, 8);
    let maxBlank = 0;
    let changed = 0;
    let blankPixels = 0;
    for (let i = 0; i < W * H; i++) {
      if ((near[i] as number) > 0) continue;
      blankPixels++;
      const d = Math.abs((marked.data[i * 3] as number) - (page.data[i * 3] as number));
      if (d > maxBlank) maxBlank = d;
      if (d > 0) changed++;
    }
    expect(blankPixels).toBeGreaterThan(W * H * 0.3);
    expect(maxBlank).toBeLessThanOrEqual(2);
    expect(changed).toBeGreaterThan(0); // the mark is there, not just absent
  });

  it("keeps the alpha channel and honours strength", () => {
    const rgba = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      rgba.set(page.data.subarray(i * 3, i * 3 + 3), i * 4);
      rgba[i * 4 + 3] = i % 251;
    }
    const out = embedForensicMark({ width: W, height: H, channels: 4, data: rgba }, TRUE.seed);
    for (let i = 0; i < W * H; i += 997) expect(out.data[i * 4 + 3]).toBe(i % 251);
    const weak = embedForensicMark(page, TRUE.seed, { strength: 0.5 });
    const strong = embedForensicMark(page, TRUE.seed, { strength: 2 });
    expect(psnr(page.data, weak.data)).toBeGreaterThan(psnr(page.data, marked.data));
    expect(psnr(page.data, strong.data)).toBeLessThan(psnr(page.data, marked.data));
  });

  it("refuses malformed input", () => {
    expect(() => embedForensicMark(page, new Uint8Array(16))).toThrow(RangeError);
    expect(() => embedForensicMark(page, TRUE.seed, { strength: 0 })).toThrow(RangeError);
    expect(() => embedForensicMark(page, TRUE.seed, { strength: 5 })).toThrow(RangeError);
    expect(() =>
      embedForensicMark(
        { width: 10, height: 10, channels: 3, data: new Uint8Array(300) },
        TRUE.seed,
      ),
    ).toThrow(RangeError);
    expect(() =>
      embedForensicMark(
        { width: 20, height: 20, channels: 3, data: new Uint8Array(10) },
        TRUE.seed,
      ),
    ).toThrow(RangeError);
  });
});

describe("detectForensicMarks", CPU_BOUND, () => {
  it.each(Object.entries(attacks))("finds the recipient after: %s", (_name, attack) => {
    const res = detectForensicMarks(reference, attack(markedGray), [...DECOYS, TRUE]);
    expect(res.scores[0]?.id).toBe(TRUE.id);
    expect(res.scores[0]?.z).toBeGreaterThanOrEqual(FORENSIC_MATCH_Z);
    expect(res.scores[0]?.verdict).toBe("match");
    for (const s of res.scores.slice(1)) {
      expect(s.z).toBeLessThan(FORENSIC_INCONCLUSIVE_Z);
      expect(s.verdict).toBe("no_match");
    }
    expect(res.aligned.quality).toBeGreaterThanOrEqual(FORENSIC_MIN_ALIGNMENT_QUALITY);
  });

  it("registers a crop + rescale to the right geometry", () => {
    const suspect = scaleTo(crop(markedGray, 0.05, 0.03, 0.02, 0.05), 600);
    const { aligned } = detectForensicMarks(reference, suspect, [TRUE]);
    const expectedScale = (W - Math.round(W * 0.05) - Math.round(W * 0.02)) / 600;
    expect(aligned.scale).toBeCloseTo(expectedScale, 2);
    expect(aligned.dx).toBeCloseTo(Math.round(W * 0.05), -0.5);
    expect(aligned.dy).toBeCloseTo(Math.round(H * 0.03), -0.5);
  });

  it("works on a mostly blank page with only a heading", () => {
    const blank = syntheticPage(W, H, "blank");
    const ref = rgbToGray(blank);
    const leaked = crop(rgbToGray(embedForensicMark(blank, TRUE.seed)), 0.05, 0.05, 0.05, 0.05);
    const res = detectForensicMarks(ref, scaleTo(leaked, 640), [...DECOYS, TRUE]);
    expect(res.scores[0]).toMatchObject({ id: TRUE.id, verdict: "match" });
    expect(res.scores[1]?.z).toBeLessThan(FORENSIC_INCONCLUSIVE_Z);
  });

  // ---- false-accusation guards ---------------------------------------------------------------

  it("accuses nobody on an unmarked page", () => {
    for (const suspect of [reference, scaleTo(reference, 585), overlay(reference)]) {
      const res = detectForensicMarks(reference, suspect, [...DECOYS, TRUE]);
      for (const s of res.scores) {
        expect(s.z).toBeLessThan(FORENSIC_INCONCLUSIVE_Z);
        expect(s.verdict).toBe("no_match");
      }
    }
  });

  it("accuses nobody when the page was marked for someone outside the candidate list", () => {
    const outsider = rgbToGray(embedForensicMark(page, seedOf("outsider")));
    for (const suspect of [outsider, scaleTo(crop(outsider, 0.03, 0.03, 0.03, 0.03), 700)]) {
      const res = detectForensicMarks(reference, suspect, [...DECOYS, TRUE]);
      expect(res.scores[0]?.z).toBeLessThan(FORENSIC_INCONCLUSIVE_Z);
    }
  });

  it("innocent z-scores are calibrated N(0,1): 1,000 decoys on a marked, attacked page", () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({ id: `c${i}`, seed: seedOf(`c${i}`) }));
    const res = detectForensicMarks(reference, overlay(scaleTo(markedGray, 640)), [TRUE, ...many], {
      maxCandidates: 1001,
    });
    const innocent = res.scores.filter((s) => s.id !== TRUE.id).map((s) => s.z);
    const mean = innocent.reduce((a, b) => a + b, 0) / innocent.length;
    const sd = Math.sqrt(innocent.reduce((a, b) => a + (b - mean) ** 2, 0) / innocent.length);
    expect(Math.abs(mean)).toBeLessThan(0.15);
    expect(sd).toBeGreaterThan(0.85);
    expect(sd).toBeLessThan(1.15);
    expect(Math.max(...innocent)).toBeLessThan(FORENSIC_INCONCLUSIVE_Z);
    expect(res.scores[0]?.id).toBe(TRUE.id);
  });

  it("scores each candidate independently of who else is tested (no per-candidate search)", () => {
    const suspect = scaleTo(crop(markedGray, 0.02, 0.04, 0.01, 0.03), 650);
    const alone = detectForensicMarks(reference, suspect, [DECOYS[3] as DetectCandidate]);
    const crowd = detectForensicMarks(reference, suspect, [TRUE, ...DECOYS]);
    expect(crowd.scores.find((s) => s.id === "decoy-3")?.z).toBe(alone.scores[0]?.z);
    expect(crowd.aligned).toEqual(alone.aligned);
  });

  it("refuses too many candidates, bad seeds and tiny images", () => {
    const tooMany = Array.from({ length: FORENSIC_DEFAULT_MAX_CANDIDATES + 1 }, () => TRUE);
    expect(() => detectForensicMarks(reference, reference, tooMany)).toThrow(RangeError);
    expect(() => detectForensicMarks(reference, reference, DECOYS, { maxCandidates: 10 })).toThrow(
      RangeError,
    );
    expect(() =>
      detectForensicMarks(reference, reference, [{ id: "x", seed: new Uint8Array(8) }]),
    ).toThrow(RangeError);
    const tiny = { width: 8, height: 8, data: new Uint8Array(64) };
    expect(() => detectForensicMarks(reference, tiny, [TRUE])).toThrow(RangeError);
    expect(detectForensicMarks(reference, reference, []).scores).toEqual([]);
  });
});

describe("thresholds scale with the number of candidates (fix R1-3)", CPU_BOUND, () => {
  it("Bonferroni on exp(−t²/2): max(6, √(2 ln(N·1e6))) and max(4, √(2 ln(N·100)))", () => {
    expect(forensicThresholds(0)).toEqual({ match: 6, inconclusive: 4 });
    expect(forensicThresholds(1)).toEqual({ match: 6, inconclusive: 4 });
    const t51 = forensicThresholds(51);
    expect(t51.match).toBe(6);
    expect(t51.inconclusive).toBeCloseTo(4.13, 2);
    const t2000 = forensicThresholds(2000);
    expect(t2000.match).toBeCloseTo(6.54, 2);
    expect(t2000.inconclusive).toBeCloseTo(4.94, 2);
    // the per-detection false-match / false-naming bounds hold at the threshold
    expect(2000 * Math.exp(-(t2000.match ** 2) / 2)).toBeLessThanOrEqual(1e-6 + 1e-12);
    expect(2000 * Math.exp(-(t2000.inconclusive ** 2) / 2)).toBeLessThanOrEqual(0.01 + 1e-12);
  });

  it("verdicts use forensicThresholds(N) and report them; an override wins", () => {
    const suspect = scaleTo(markedGray, 700);
    const candidates = [...DECOYS, TRUE];
    const res = detectForensicMarks(reference, suspect, candidates);
    expect(res.thresholds).toEqual(forensicThresholds(candidates.length));
    for (const s of res.scores) expect(s.verdict).toBe(forensicVerdict(s.z, res.thresholds));
    // a z of 4.05 is "inconclusive" for one candidate but "no_match" among 51
    expect(forensicVerdict(4.05)).toBe("inconclusive");
    expect(forensicVerdict(4.05, res.thresholds)).toBe("no_match");
    const strict = detectForensicMarks(reference, suspect, candidates, {
      thresholds: { match: 1e6, inconclusive: 1e5 },
    });
    expect(strict.scores[0]).toMatchObject({ id: TRUE.id, verdict: "no_match" });
    expect(() =>
      detectForensicMarks(reference, suspect, candidates, {
        thresholds: { match: 3, inconclusive: 4 },
      }),
    ).toThrow(RangeError);
  });

  it("minZ exposes a subtracted mark (tampering)", () => {
    // 2·reference − marked removes the recipient's pattern and leaves its negative
    const data = new Uint8Array(reference.data.length);
    for (let i = 0; i < data.length; i++)
      data[i] = Math.max(
        0,
        Math.min(255, 2 * (reference.data[i] as number) - (markedGray.data[i] as number)),
      );
    const res = detectForensicMarks(reference, { ...reference, data }, [...DECOYS, TRUE]);
    expect(res.scores.at(-1)?.id).toBe(TRUE.id);
    expect(res.minZ).toBe(res.scores.at(-1)?.z);
    expect(res.minZ).toBeLessThanOrEqual(-res.thresholds.match);
    const clean = detectForensicMarks(reference, markedGray, [...DECOYS, TRUE]);
    expect(clean.minZ).toBeGreaterThan(-FORENSIC_INCONCLUSIVE_Z);
    expect(detectForensicMarks(reference, markedGray, []).minZ).toBe(0);
  });

  it("refuses absurd suspect geometry before any work (fix R1-1)", () => {
    const strip = { width: 200, height: 5_000, data: new Uint8Array(200 * 5_000).fill(255) };
    const t0 = performance.now();
    expect(() => detectForensicMarks(reference, strip, [TRUE])).toThrow(/aspect/u);
    expect(performance.now() - t0).toBeLessThan(200);
    const huge = { width: 2000, height: 2588, data: new Uint8Array(2000 * 2588) };
    expect(() => detectForensicMarks(reference, huge, [TRUE])).toThrow(/pixels/u);
  });
});

/**
 * Times one engine call in a fresh worker thread running the BUILT engine (dist/, as the
 * detector's worker does — `pnpm --filter @fundroom/forensic build` first). A worker has its own
 * V8 isolate, outside the coverage session of this test thread, so the budget measures the
 * engine production runs rather than coverage instrumentation.
 */
function timeInWorker(
  op: "embed" | "detect",
  args: readonly unknown[],
): Promise<{ ms: number; topId?: string }> {
  const engineUrl = new URL("../dist/engine.js", import.meta.url).href;
  const code = `
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.engineUrl).then((engine) => {
      const { op, args } = workerData;
      if (op === "embed") {
        engine.embedForensicMark(...args); // warm-up
        const t0 = performance.now();
        engine.embedForensicMark(...args);
        parentPort.postMessage({ ms: performance.now() - t0 });
      } else {
        const t0 = performance.now();
        const res = engine.detectForensicMarks(...args);
        parentPort.postMessage({ ms: performance.now() - t0, topId: res.scores[0]?.id });
      }
    });
  `;
  return new Promise((resolve, reject) => {
    const worker = new Worker(code, { eval: true, workerData: { engineUrl, op, args } });
    worker.once("message", (m: { ms: number; topId?: string }) => {
      resolve(m);
      void worker.terminate();
    });
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`timing worker exited (${code})`)));
  });
}

describe("speed (generous ×4 bounds; scripts/bench.mjs prints the real numbers)", CPU_BOUND, () => {
  const big = syntheticPage(1600, 2070);
  it("embeds a 1600×2070 page in ≤ 1 s", async () => {
    const { ms } = await timeInWorker("embed", [big, TRUE.seed]);
    expect(ms).toBeLessThan(1000);
  });

  it("detects among 200 candidates in ≤ 12 s", async () => {
    const ref = rgbToGray(big);
    const suspect = scaleTo(rgbToGray(embedForensicMark(big, TRUE.seed)), 1170);
    const cands = [
      TRUE,
      ...Array.from({ length: 199 }, (_, i) => ({ id: `s${i}`, seed: seedOf(`s${i}`) })),
    ];
    const { ms, topId } = await timeInWorker("detect", [ref, suspect, cands]);
    expect(ms).toBeLessThan(12_000);
    expect(topId).toBe(TRUE.id);
  });
});
