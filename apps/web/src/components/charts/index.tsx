import { Skeleton } from "@fundroomhq/ui";
import { lazy, Suspense } from "react";
import type { ChartSvgProps, ChartTableVariant } from "./chart-svg.js";

/*
 * Lazy entry point for the chart interpreter (E2.4 §7).
 *
 * `React.lazy` + `Suspense`, the way `components/module-page.tsx` loads a module surface —
 * chosen over a `manualChunks` entry in `vite.config.ts` for two reasons. The config's
 * `manualChunks` only ever looks at `node_modules` ids, and `@fundroom/charts` is a
 * workspace package resolved through `dist/`, so it would need a special case that the next
 * person to read the function would not expect. And `lazy()` splits at the *import site*,
 * which is the guarantee that actually matters: the investor entry chunk holds a `<Chart>`
 * that is a promise, not a layout engine, whichever bundler config it is built under. All
 * three callers — the investor surface, the admin grid and the `metric_grid` content block —
 * share the one chunk.
 *
 * Note the type-only imports: they are erased, so this module pulls no chart code of its own.
 */
const ChartSvg = lazy(() => import("./chart-svg.js"));

export { type ChartTheme, resolveChartTheme, useChartPalette } from "./palette.js";
export type { ChartSvgProps, ChartTableVariant };

/** The chart, loaded on demand. Props are `ChartSvg`'s. */
export function Chart(props: ChartSvgProps) {
  return (
    <Suspense fallback={<Skeleton className="h-24 w-full rounded-md" />}>
      <ChartSvg {...props} />
    </Suspense>
  );
}
