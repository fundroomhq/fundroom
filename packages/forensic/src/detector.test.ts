import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createForensicDetector, ForensicBusyError, ForensicTimeoutError } from "./detector.js";
import { detectForensicMarks, embedForensicMark, type RgbImage, rgbToGray } from "./engine.js";

/*
 * The worker pool runs the BUILT engine (dist/detector-worker.js): `pnpm --filter
 * @fundroom/forensic build` first, as for every cross-package test in this repo.
 */

const seedOf = (label: string) => new Uint8Array(createHash("sha256").update(label).digest());

function page(width: number, height: number): RgbImage {
  const data = new Uint8Array(width * height * 3).fill(255);
  for (let y = Math.round(height * 0.1); y < height * 0.9; y += Math.round(width / 40))
    for (let x = Math.round(width * 0.1); x < width * 0.9; x++)
      if ((x >> 2) % 3 !== 0 && (x >> 6) % 5 !== 0)
        for (let dy = 0; dy < width / 120; dy++)
          data.fill(25, ((y + dy) * width + x) * 3, ((y + dy) * width + x) * 3 + 3);
  return { width, height, channels: 3, data };
}

const small = page(400, 518);
const smallRef = rgbToGray(small);
const truth = { id: "truth", seed: seedOf("truth") };
const smallSuspect = rgbToGray(embedForensicMark(small, truth.seed));
const decoys = Array.from({ length: 20 }, (_, i) => ({ id: `d${i}`, seed: seedOf(`d${i}`) }));

const detectors: ReturnType<typeof createForensicDetector>[] = [];
const make = (o?: Parameters<typeof createForensicDetector>[0]) => {
  const d = createForensicDetector(o);
  detectors.push(d);
  return d;
};
afterAll(async () => {
  await Promise.all(detectors.map((d) => d.close()));
});

describe("createForensicDetector", () => {
  it("returns exactly what the in-process engine returns", async () => {
    const d = make();
    const viaWorker = await d.detect(smallRef, smallSuspect, [truth, ...decoys]);
    expect(viaWorker).toEqual(detectForensicMarks(smallRef, smallSuspect, [truth, ...decoys]));
    expect(viaWorker.scores[0]).toMatchObject({ id: "truth", verdict: "match" });
  });

  it("keeps the event loop free during a heavy detection", async () => {
    const big = page(1600, 2070);
    const ref = rgbToGray(big);
    const suspect = rgbToGray(embedForensicMark(big, truth.seed));
    const many = Array.from({ length: 2000 }, (_, i) => ({ id: `m${i}`, seed: seedOf(`m${i}`) }));
    const d = make();
    await d.detect(smallRef, smallSuspect, [truth]); // worker warm
    let last = performance.now();
    let maxGap = 0;
    let ticks = 0;
    const timer = setInterval(() => {
      const now = performance.now();
      maxGap = Math.max(maxGap, now - last);
      last = now;
      ticks++;
    }, 5);
    const t0 = performance.now();
    const res = await d.detect(ref, suspect, [truth, ...many.slice(0, 1999)]);
    const elapsed = performance.now() - t0;
    clearInterval(timer);
    expect(res.scores[0]?.id).toBe("truth");
    expect(elapsed).toBeGreaterThan(250);
    expect(ticks).toBeGreaterThan(elapsed / 50);
    expect(maxGap).toBeLessThan(Math.max(100, elapsed / 3));
  }, 60_000);

  it("rejects with ForensicBusyError when the queue is full, and recovers", async () => {
    const d = make({ concurrency: 1, maxQueue: 1 });
    const first = d.detect(smallRef, smallSuspect, [truth]);
    const second = d.detect(smallRef, smallSuspect, [truth]);
    const third = d.detect(smallRef, smallSuspect, [truth]);
    await expect(third).rejects.toBeInstanceOf(ForensicBusyError);
    await expect(third).rejects.toMatchObject({ name: "ForensicBusyError" });
    expect((await first).scores[0]?.verdict).toBe("match");
    expect((await second).scores[0]?.verdict).toBe("match");
    expect((await d.detect(smallRef, smallSuspect, [truth])).scores[0]?.verdict).toBe("match");
  }, 60_000);

  it("passes engine RangeErrors through and survives them", async () => {
    const d = make();
    const tiny = { width: 8, height: 8, data: new Uint8Array(64) };
    await expect(d.detect(smallRef, tiny, [truth])).rejects.toBeInstanceOf(RangeError);
    expect((await d.detect(smallRef, smallSuspect, [truth])).scores[0]?.verdict).toBe("match");
  }, 60_000);

  it("times out a stuck job, replaces its worker and keeps serving (fix RR-2)", async () => {
    // ~1.8–2.1 s with 2,000 candidates (measured), well past the 900 ms deadline; the deadline in
    // turn leaves a cold replacement worker plenty of time for the small queued job under load
    const big = page(2400, 3105);
    const ref = rgbToGray(big);
    const suspect = rgbToGray(embedForensicMark(big, truth.seed));
    const many = Array.from({ length: 1999 }, (_, i) => ({ id: `t${i}`, seed: seedOf(`t${i}`) }));
    const d = make({ concurrency: 1, maxQueue: 1, timeoutMs: 900 });
    await d.detect(smallRef, smallSuspect, [truth]); // warm worker
    const t0 = performance.now();
    const slow = d.detect(ref, suspect, [truth, ...many]);
    const waiting = d.detect(smallRef, smallSuspect, [truth]); // queued behind the stuck one
    await expect(slow).rejects.toBeInstanceOf(ForensicTimeoutError);
    expect(performance.now() - t0).toBeLessThan(1700);
    // the queued job runs on a fresh worker, and the detector keeps serving
    expect((await waiting).scores[0]?.verdict).toBe("match");
    expect((await d.detect(smallRef, smallSuspect, [truth])).scores[0]?.verdict).toBe("match");
  }, 60_000);

  it("a job that cannot be dispatched is rejected and frees its slot (fix RR-2)", async () => {
    const d = make({ concurrency: 1, maxQueue: 0 });
    const uncloneable = { thresholds: { match: 6, inconclusive: 4 }, hook: () => 1 } as never;
    await expect(d.detect(smallRef, smallSuspect, [truth], uncloneable)).rejects.toThrow(
      /could not be cloned/u,
    );
    // maxQueue 0 + concurrency 1: a wedged slot would make this ForensicBusyError
    expect((await d.detect(smallRef, smallSuspect, [truth])).scores[0]?.verdict).toBe("match");
  }, 60_000);

  it("close() rejects queued work and refuses new work", async () => {
    const d = createForensicDetector({ concurrency: 1, maxQueue: 2 });
    const running = d.detect(smallRef, smallSuspect, [truth]);
    const queued = d.detect(smallRef, smallSuspect, [truth]);
    const outcomes = Promise.all([
      expect(running).rejects.toThrow(/closed/u),
      expect(queued).rejects.toThrow(/closed/u),
    ]);
    await d.close();
    await outcomes;
    await expect(d.detect(smallRef, smallSuspect, [truth])).rejects.toThrow(/closed/u);
  });
});
