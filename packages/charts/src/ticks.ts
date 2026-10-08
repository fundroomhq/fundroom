/**
 * Axis tick selection (E2.4 contract §7). Pure arithmetic, no font metrics, no DOM.
 *
 * A KPI axis is read by people who will quote the numbers back in a board meeting, so the
 * labels have to be round: 0, 25k, 50k — never 0, 23 871, 47 742. That means the *domain* is
 * chosen to fit the ticks rather than the ticks being spread over the data range, which is why
 * `niceTicks` returns a widened `min`/`max` and the scale is built from those, not from the raw
 * extent of the series.
 */

/** A resolved axis: the domain the scale maps, the step between labels, and the labels. */
export interface TickScale {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly ticks: readonly number[];
}

/** Hard cap so a pathological domain/step pair cannot emit thousands of gridlines. */
const MAX_TICKS = 64;

/**
 * Rounds a raw step up to the next 1, 2 or 5 times a power of ten. 1/2/5 is the classic choice
 * because every one of them divides a decade into equal parts a reader can do arithmetic in;
 * 2.5 and 4 do not (the rejected alternative was d3's `tickIncrement`, which also emits 2.5 and
 * produces labels like 2.5k, 7.5k that read as measurement noise on a currency axis).
 */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const frac = raw / pow;
  const mult = frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10;
  return mult * pow;
}

/**
 * Snaps a value computed as `min + i * step` back onto the decimal grid the step implies.
 * `0.1 * 3` is `0.30000000000000004` in IEEE-754 and that string would reach a chart label
 * verbatim, so every tick goes through here. 12 significant digits is well inside a double's
 * 15-17 and well outside any value a KPI carries (`numeric(20,6)`, contract §5).
 */
export function snapTick(v: number): number {
  return v === 0 ? 0 : Number(v.toPrecision(12));
}

/**
 * Picks `~target` round ticks covering `[lo, hi]`. The returned `min`/`max` are the tick
 * extremes, so a scale built from them maps the lowest tick to the bottom edge of the plot and
 * the highest to the top edge exactly.
 *
 * Degenerate inputs are answered, never thrown on: a chart is drawn for whatever the workspace
 * has entered, and "one point", "every value identical" and "every value zero" are all ordinary
 * states of a KPI that was created last week.
 */
export function niceTicks(lo: number, hi: number, target: number): TickScale {
  const count = Math.max(2, Math.min(10, Math.round(target)));
  if (!Number.isFinite(lo) || !Number.isFinite(hi))
    return { min: 0, max: 1, step: 1, ticks: [0, 1] };
  let low = Math.min(lo, hi);
  let high = Math.max(lo, hi);
  if (low === high) {
    // A flat series still deserves a readable axis. Zero gets [0, 1]; anything else gets a band
    // 10% either side so the flat line lands in the middle of the plot rather than on its edge.
    if (low === 0) {
      low = 0;
      high = 1;
    } else {
      const pad = Math.abs(low) * 0.1;
      low -= pad;
      high += pad;
    }
  }
  const step = niceStep((high - low) / count);
  const min = snapTick(Math.floor(low / step) * step);
  const max = snapTick(Math.ceil(high / step) * step);
  const n = Math.min(MAX_TICKS, Math.max(1, Math.round((max - min) / step)));
  const ticks: number[] = [];
  for (let i = 0; i <= n; i++) ticks.push(snapTick(min + i * step));
  return { min, max, step, ticks };
}
