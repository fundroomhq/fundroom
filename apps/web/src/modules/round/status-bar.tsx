import type { Allocation } from "@fundroom/round-terms";
import { m } from "../../paraglide/messages.js";
import { formatMoney, formatPercent } from "./format.js";

/*
 * The status bar (design/03 A4: "soft-circled / committed / closed") and the staff-side
 * allocation tracker are two views of **one** computation — `allocation()` in
 * `@fundroom/round-terms`, run server-side over `round.commitment` (contract §D2). Neither
 * side adds a bucket of its own.
 *
 * Three rules shape what is below:
 *
 *  - **no `style` attribute.** The CSP forbids inline styles (design/07), so the segment
 *    widths come from a static table of Tailwind classes rather than from a computed
 *    percentage. Twenty-one buckets of 5% is coarser than the real figure by design: the bar
 *    is the picture, and…
 *  - **…every figure is also in text.** A number never lives only in a picture (§7). The bar
 *    is `role="img"` with a sentence for its name, and the same sentence's figures appear
 *    beneath it as an ordinary list, so nothing is lost to a screen reader or a printout.
 *  - **colour is never the only carrier.** Each bucket is named beside its amount.
 */

/*
 * Tailwind generates a class only if it can see the literal string, so these cannot be built
 * from a template. Rounding to the nearest 5% keeps the table short; the exact percentage is
 * in the text beneath the bar.
 */
const WIDTHS: readonly string[] = [
  "w-0",
  "w-[5%]",
  "w-[10%]",
  "w-[15%]",
  "w-[20%]",
  "w-[25%]",
  "w-[30%]",
  "w-[35%]",
  "w-[40%]",
  "w-[45%]",
  "w-[50%]",
  "w-[55%]",
  "w-[60%]",
  "w-[65%]",
  "w-[70%]",
  "w-[75%]",
  "w-[80%]",
  "w-[85%]",
  "w-[90%]",
  "w-[95%]",
  "w-full",
];

/** The nearest 5% step, for drawing only. `percent` is a decimal string the server rounded. */
export function widthClass(percent: string): string {
  const n = Number(percent);
  if (!Number.isFinite(n) || n <= 0) return WIDTHS[0] ?? "w-0";
  const step = Math.min(20, Math.max(0, Math.round(n / 5)));
  return WIDTHS[step] ?? "w-0";
}

/** `soft` sits beside `committed` in the bar, so its own width is the remainder of the pair. */
function softWidth(allocation: Allocation): string {
  const committed = Number(allocation.percent.committed);
  const soft = Number(allocation.percent.soft);
  if (!Number.isFinite(committed) || !Number.isFinite(soft)) return "w-0";
  return widthClass(String(Math.max(0, Math.min(100 - committed, soft))));
}

export function StatusBar({
  allocation,
  currency,
  showWired = true,
}: {
  allocation: Allocation;
  currency: string;
  /** Investors see the wired figure only when the round says so (§D8). */
  showWired?: boolean;
}) {
  const label = m.round_progress_label({
    committed: formatMoney(allocation.committed, currency),
    soft: formatMoney(allocation.soft, currency),
    target: formatMoney(allocation.target, currency),
    percent: formatPercent(allocation.percent.committed),
  });
  const buckets = [
    { key: "committed", name: m.round_bucket_committed(), amount: allocation.committed },
    { key: "soft", name: m.round_bucket_soft(), amount: allocation.soft },
    ...(showWired
      ? [{ key: "wired", name: m.round_bucket_wired(), amount: allocation.wired }]
      : []),
    { key: "remaining", name: m.round_bucket_remaining(), amount: allocation.remaining },
  ];
  return (
    <div className="space-y-3">
      <div
        role="img"
        aria-label={label}
        className="flex h-3 w-full overflow-hidden rounded-full bg-muted"
      >
        <div className={`h-full bg-primary ${widthClass(allocation.percent.committed)}`} />
        <div className={`h-full bg-primary/40 ${softWidth(allocation)}`} />
      </div>
      <dl className="flex flex-wrap gap-x-6 gap-y-2">
        {buckets.map((bucket) => (
          <div key={bucket.key}>
            <dt className="text-xs text-muted-foreground">{bucket.name}</dt>
            <dd className="text-sm font-medium tabular-nums">
              {formatMoney(bucket.amount, currency)}
            </dd>
          </div>
        ))}
        <div>
          <dt className="text-xs text-muted-foreground">{m.round_bucket_target()}</dt>
          <dd className="text-sm font-medium tabular-nums">
            {formatMoney(allocation.target, currency)}
          </dd>
        </div>
      </dl>
    </div>
  );
}
