# @fundroom/forensic

The forensic (invisible) watermarking engine of the data room: a keyed, per-recipient
spread-spectrum pattern embedded into page images, and an informed (non-blind) detector that tests a leaked
image against every recipient of a document version. Pure TypeScript over `node:crypto` and
`node:worker_threads`; no runtime dependencies and no image codecs (the render adapter decodes and encodes:
`DocumentRenderPort.embedForensicMark` / `toGray` in `@fundroom/render-pdfium`). Operations:
[`docs/runbooks/forensic-watermarking.md`](../../docs/runbooks/forensic-watermarking.md).

## Exports

- **Keys** (`keys.ts`): `newForensicToken()` (8 random bytes), `deriveForensicPatternKey(ringEntryKey)`
  (HKDF-SHA256, empty salt, info `FORENSIC_KEY_PURPOSE` = `seed-host/forensic/pattern/v1`, 32 bytes; refuses
  entries under 16 bytes), `forensicSeed(patternKey, token)` (`HMAC-SHA256(key, "mark\0" ‖ token)`; refuses a
  key that is not 32 bytes or a token that is not 8). Built per ring entry in the server's
  `ModuleServices.forensicKeys`; modules never see the ring itself.
- **Engine** (`engine.ts`): `embedForensicMark(rgb, seed, { strength? })` (returns a new buffer;
  deterministic), `detectForensicMarks(reference, suspect, candidates, { maxCandidates?, thresholds? })`,
  `forensicThresholds(N)`, `forensicVerdict(z, thresholds?)`, `rgbToGray`, the types `GrayImage`, `RgbImage`,
  `DetectCandidate`, `DetectResult`, `ForensicThresholds`, and the constants below.
- **Detector** (`detector.ts`): `createForensicDetector({ concurrency = 1, maxQueue = 4, timeoutMs = 30_000,
  resourceLimits? })` → `{ detect(...), close() }`, running `detectForensicMarks` on worker threads
  (`dist/detector-worker.js`; build before running the tests from `src/`). A full queue rejects with
  `ForensicBusyError`; a job over its deadline terminates and replaces the worker and rejects with
  `ForensicTimeoutError`. Inputs are structured-cloned. Default worker limits: 512 MB old space, 64 MB young
  (ArrayBuffers are not counted; the geometry caps are the memory bound).

## Embedding

A ±1 lattice with one node every `width / 160` px (10 px at the served 1600 px width), one bit per node from
AES-256-CTR keyed with the 32-byte seed, bilinearly interpolated into a smooth pattern and added to R, G and B
with a perceptual amplitude: `FORENSIC_AMPLITUDE` 2 grey levels on flat paper, rising to 4 on and within about
3 px of text and edges. `strength` (default `FORENSIC_DEFAULT_STRENGTH` = 1, range (0, 4]) multiplies it.
Values clip at 0 and 255, so white paper can only darken. PSNR on real pages: 44.6 dB (dense text), 46.2
(table and chart), 48.0 (nearly blank with a heading).

## Detection, and why its scores are honest

1. **Register** the suspect onto the reference (the clean page raster) from the two images alone: uniform
   scale and translation, crops up to about 8 % per edge, a coarse exhaustive search then pyramid ascent. The
   result's `aligned.quality` is a normalised cross-correlation; below `FORENSIC_MIN_ALIGNMENT_QUALITY` (0.5)
   callers should report "alignment failed" rather than scores.
2. **Residual.** Warp the suspect onto the reference grid, choose the reference pre-blur (none, or the
   down-up resampling the suspect evidently went through) that minimises residual energy, remove tone curves
   (median look-up), clip the residual to ±12 levels (another viewer's visible watermark, edge ringing).
3. **Project** the residual onto each lattice node, weighted by the reference's amplitude map, whitened by
   local residual power, 3 × 3 lattice high-pass: a vector x.
4. **Score** each candidate with signs w: z = Σ wₙxₙ / √Σ xₙ².

Steps 1–3 never look at a candidate, so x is fixed before any pattern is generated. For a candidate whose mark
is not in the image, w is independent fair signs, and z is exactly a normalised Rademacher sum: mean 0,
variance 1, and by Hoeffding P(z ≥ t) ≤ e^(−t²/2) for **any** image (unmarked, marked for someone else, or
crafted). Verdict thresholds (`forensicThresholds(N)`, Bonferroni over N candidates):

- `match`: z ≥ max(6, √(2 ln(N·10⁶))): at most 1e-6 chance per detection of naming any innocent;
- `inconclusive`: z ≥ max(4, √(2 ln(N·100))): at most 1 %;
- e.g. N = 51 → 6 / 4.13; N = 2 000 → 6.54 / 4.94. `FORENSIC_MATCH_Z` / `FORENSIC_INCONCLUSIVE_Z` (6 / 4)
  are the floors.

`DetectResult` carries `aligned`, `scores` (sorted by z, each with its verdict), the `thresholds` used and
`minZ`; a `minZ` at or below `−thresholds.match` is the signature of a subtracted or inverted mark (the data
room reports it as `tamperSuspected`).

**Refusals** (`RangeError`): an image under 16 × 16, a seed that is not 32 bytes, a strength outside (0, 4],
more candidates than `maxCandidates` (default `FORENSIC_DEFAULT_MAX_CANDIDATES` = 2 000), a suspect with more
than `FORENSIC_MAX_SUSPECT_PIXEL_RATIO` (4×) the reference's pixels or an aspect ratio off by more than
`FORENSIC_MAX_ASPECT_FACTOR` (1.5×). Impossible geometry otherwise does not throw; it returns a low alignment
quality.

## Robustness and limits

Tested on real PDFium-rendered pages (dense text, table and chart, nearly blank page) × {served WebP q82,
JPEG q50, 50 % down and up, rescale to 1170 and 2000 px wide, 5 % crop per edge, crop + 1170 px + JPEG q70},
with another viewer's visible watermark on top for several: true recipient z 68–152, best of 50 decoys under
3 (`packages/adapters/render-pdfium/src/forensic.test.ts`). The engine tests add synthetic attacks, 1 000-decoy
calibration, a no-inflation check and false-accusation cases.

Not handled: rotation, perspective, print-and-scan, heavy blur. Averaging copies from k recipients divides
each one's z by about k. Anyone with the unmarked page and this algorithm can subtract the mark. Detection
needs the unmarked reference.

## Performance

`node packages/forensic/scripts/bench.mjs` prints the numbers on your machine. On the development machine
(heavily loaded): embed of a 1600 × 2070 page, median 63 ms in the engine (210–550 ms in the render adapter
including the WebP decode and re-encode, which dominates); detection with 200 candidates about 0.5 s
(0.6–1.0 s per real page in tests). Unit tests assert bounds four times looser so CI is not flaky.
