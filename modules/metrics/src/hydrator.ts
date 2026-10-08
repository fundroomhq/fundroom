import { layoutChart } from "@fundroom/charts";
import { findWorkspaceById } from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import type { BlockHydrationContext, ModuleServices } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { buildChartSpec, CHART_HEIGHT, CHART_WIDTH } from "./chart.js";
import { formatFixed } from "./decimal.js";
import { audienceAdmits, type MetricReader } from "./model.js";
import { type CalendarPeriodKind, formatPeriodKey, periodLabel } from "./period.js";
import {
  DefinitionRepo,
  type DefinitionRow,
  PointRepo,
  type PointRow,
} from "./repos/metrics-repo.js";
import { alignSeries, type PeriodColumn, periodColumns } from "./service/series.js";
import {
  CHART_MAX_SERIES,
  CHART_TOKEN_PURPOSE,
  CHART_TOKEN_TTL_DAYS,
  signChartToken,
} from "./tokens.js";

/*
 * The `metric_grid` content block (E2.4 §10, design/06 §8).
 *
 * A content page stores **ids only**; the owning module is asked for the viewer-safe payload at
 * render time, after section visibility has been applied. The payload below is frozen: both the
 * SPA renderer and the email renderer read it, so a field added here reaches two consumers and
 * a field removed breaks them.
 *
 * The rule that matters most is the quiet one: **ids the viewer may not see are dropped, not
 * reported.** No `hidden: 3`, no placeholder tile, no count. An investor must not be able to
 * learn from a page that a metric they cannot see exists — that leaks the existence of a number
 * the founder chose not to show them, which is most of what a per-metric audience is for.
 *
 * Values travel as decimal **strings** for the reason in §5: `numeric(20, 6)` does not survive
 * a round trip through a JSON number, and a KPI block is exactly where somebody would notice.
 */

/** Sparkline width; §10 freezes "up to 12 periods, oldest first". */
export const SPARKLINE_PERIODS = 12;

/** Tiles per row the renderer should aim for. */
const DEFAULT_COLUMNS = 3;
const MAX_COLUMNS = 4;

export interface MetricGridTile {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly unit: string;
  readonly currency: string | null;
  readonly decimals: number;
  readonly direction: "up_good" | "down_good" | "neutral";
  readonly latest: {
    readonly periodKey: string;
    readonly periodLabel: string;
    readonly value: string;
  } | null;
  readonly previous: { readonly periodKey: string; readonly value: string } | null;
  readonly sparkline: readonly (string | null)[];
  /**
   * The columns `sparkline` is indexed by, aligned index for index and oldest first.
   *
   * Without it the sparkline is a row of numbers with nothing saying *when* — `latest` names
   * the period of the latest **value**, which is not necessarily the last column, and a tile
   * carries no `periodKind` to derive columns from. So a screen reader gets "11 periods ago to
   * Latest" where it should say "Jul 2026 to Sep 2026", and a chart whose axis cannot be named
   * is a chart a screen-reader user cannot read. The plain-text table in an update email needs
   * the same labels, so one field serves both consumers, spelled by `formatPeriodKey` and
   * `periodLabel` so the wire form and the human form come from one place.
   */
  readonly periods: readonly { readonly key: string; readonly label: string }[];
}

/** The `<img>` an update email carries, and the sentence that stands in when it does not load. */
export interface MetricGridChart {
  /** Absolute `https` URL of `GET /api/v1/metrics/chart/{token}.png` on the workspace's origin. */
  readonly url: string;
  /** `ChartLayout.describedBy`: the chart is never the only place a number exists. */
  readonly alt: string;
  /** CSS pixels. The bitmap is rasterised at twice this, for retina mail clients. */
  readonly width: number;
  readonly height: number;
}

export interface MetricGridHydrated {
  readonly columns: number;
  readonly metrics: readonly MetricGridTile[];
  /**
   * Present **only** when hydrating for email. Additive and nullable, so a renderer that does
   * not know about it, or one rendering a workspace with nothing chartable, is unaffected.
   */
  readonly chart?: MetricGridChart | null | undefined;
}

/**
 * Tiles one block may carry. A grid is a screen, not a report, and a block naming hundreds of
 * metrics would be a page nobody reads and a query nobody bounded.
 */
export const MAX_BLOCK_METRICS = 24;

/**
 * The ids a block asks for, in the order the editor put them in — **uncapped**.
 *
 * The cap is applied by the hydrator rather than here, because dropping a metric the editor
 * put on the page is a thing somebody has to be able to find out about: it is silent on the
 * page (the tile is simply absent, exactly as a tile the viewer may not see is), so the
 * hydrator logs it. Capping inside this function made that impossible to notice at all.
 */
export function definitionIdsOf(data: JsonObject): string[] {
  const raw = data["definitionIds"] ?? data["ids"];
  if (!Array.isArray(raw)) return [];
  return raw.filter((x): x is string => typeof x === "string");
}

function columnsOf(data: JsonObject): number {
  const raw = data["columns"];
  if (typeof raw !== "number" || !Number.isInteger(raw)) return DEFAULT_COLUMNS;
  return Math.min(MAX_COLUMNS, Math.max(1, raw));
}

/** `undefined` is a gap in the sparkline and stays one; it is never rendered as a zero. */
const asText = (v: bigint | undefined, decimals: number): string | null =>
  v === undefined ? null : formatFixed(v, decimals);

function tileOf(
  definition: DefinitionRow,
  columns: readonly PeriodColumn[],
  values: readonly (bigint | undefined)[],
): MetricGridTile {
  const sparkline = values.map((v) => asText(v, definition.decimals));
  let latestAt = -1;
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== undefined) {
      latestAt = i;
      break;
    }
  }
  let previousAt = -1;
  for (let i = latestAt - 1; i >= 0; i--) {
    if (values[i] !== undefined) {
      previousAt = i;
      break;
    }
  }
  const latestColumn = columns[latestAt];
  const previousColumn = columns[previousAt];
  return {
    id: definition.id,
    key: definition.key,
    name: definition.name,
    unit: definition.unit,
    currency: definition.currency,
    decimals: definition.decimals,
    direction: definition.direction,
    latest:
      latestColumn === undefined
        ? null
        : {
            periodKey: latestColumn.key,
            periodLabel: latestColumn.label,
            value: sparkline[latestAt] as string,
          },
    previous:
      previousColumn === undefined
        ? null
        : { periodKey: previousColumn.key, value: sparkline[previousAt] as string },
    sparkline,
    // Built from the same `columns` as `sparkline`, so the two cannot drift out of alignment.
    periods: columns.map((c) => ({ key: c.key, label: c.label })),
  };
}

/** One visible metric with the columns and values a chart would draw it from. */
interface ChartableSeries {
  readonly definition: DefinitionRow;
  readonly columns: readonly PeriodColumn[];
  readonly values: readonly (bigint | undefined)[];
}

/**
 * Mints the emailed chart: a capability URL, and the sentence that replaces it when images do
 * not load.
 *
 * **Only for email, and that is a security decision rather than an optimisation.** A chart
 * token is a capability that works for 180 days, because the mail it rides in is read for 180
 * days. Putting one in a *web* API response would put a 180-day credential inside a payload
 * that only a session protects — and those bytes outlive the session that fetched them and
 * reach everywhere a page response reaches: a HAR file on a support ticket, a screenshot of
 * devtools, a browser extension. The SPA draws its own chart from geometry and needs no token,
 * so minting one there buys nothing and costs that. A long-lived capability is minted where a
 * long life is the point, which is the mail, and nowhere else.
 *
 * `d` is drawn from the metrics the viewer's audience **already admitted**, so the capability
 * cannot widen what the reader may see — it is the same filter the tiles went through, and the
 * token is the carrier of that decision rather than a second chance to make it (decision D5).
 */
async function chartFor(
  services: ModuleServices,
  ctx: BlockHydrationContext,
  series: readonly ChartableSeries[],
): Promise<MetricGridChart | null> {
  const first = series[0];
  if (first === undefined) return null;
  /*
   * One chart has one x axis and one y axis, so it can only show metrics reported at one period
   * kind **and measured in one unit**. The first visible metric decides both, and the rest are
   * dropped rather than squeezed onto a scale that is not theirs — they are still in `metrics`,
   * with their own tiles and their own numbers, and the email's text part carries every figure
   * with its own unit (§10).
   *
   * The unit half is not fussiness: `buildChartSpec` formats every y tick with the *first*
   * series' unit and currency, so charting a currency beside a percentage produced an axis
   * reading `0.0%`, `500k%`, `1.0M%` against dollars — a picture that is simply wrong, and one
   * `chart.ts` claimed the send path already prevented.
   */
  const kind = first.definition.periodKind as CalendarPeriodKind;
  const unit = first.definition.unit;
  const currency = first.definition.currency;
  const chosen = series
    .filter(
      (s) =>
        s.definition.periodKind === kind &&
        s.definition.unit === unit &&
        s.definition.currency === currency,
    )
    .slice(0, CHART_MAX_SERIES);
  const columns = chosen[0]?.columns ?? [];
  if (columns.length === 0) return null;

  // Host context: the hydrator is handed a tenant context, not the workspace row that
  // `workspaceUrl` needs to put the link on the workspace's own domain.
  const workspace = await findWorkspaceById(services.db, ctx.tenant.workspaceId);
  if (workspace === undefined) return null;
  const branding = parseWorkspaceSettings(workspace.settings).branding;

  // The same spec the route will rasterise, so `alt` describes the picture that actually loads.
  const layout = layoutChart(
    buildChartSpec({
      columns,
      entries: chosen.map((s) => ({ definition: s.definition, values: s.values })),
      accentColor: branding.accentColor,
    }),
  );

  // The instant the mail is *of*, never the clock: a retried send must mint the same token,
  // or two recipients in one audience get two URLs and D5's shared-URL property is gone.
  const now = ctx.asOf ?? services.now();
  const key = await services.db.withTenant(ctx.tenant, (tx) =>
    services.crypto.currentKey(tx, ctx.tenant, CHART_TOKEN_PURPOSE),
  );
  const token = signChartToken(key.key, {
    v: 1,
    w: ctx.tenant.workspaceId,
    kid: key.keyId,
    d: chosen.map((s) => s.definition.id),
    k: kind,
    n: columns.length,
    asOf: now.toISOString(),
    exp: new Date(now.getTime() + CHART_TOKEN_TTL_DAYS * 86_400_000).toISOString(),
  });
  return {
    url: services.workspaceUrl(workspace, `/api/v1/metrics/chart/${token}.png`).href,
    alt: layout.describedBy,
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
  };
}

/** A `custom`-period metric has no calendar columns, so its own ranges are the columns. */
function customColumns(points: readonly PointRow[]): PeriodColumn[] {
  return points.slice(-SPARKLINE_PERIODS).map((p) => {
    const period = { kind: "custom" as const, start: p.periodStart, end: p.periodEnd };
    return { period, key: formatPeriodKey(period), label: periodLabel(period) };
  });
}

export function createMetricGridHydrator(services: ModuleServices) {
  return {
    type: "metric_grid" as const,
    async hydrate(data: JsonObject, ctx: BlockHydrationContext): Promise<JsonObject> {
      const asked = definitionIdsOf(data);
      const ids = asked.slice(0, MAX_BLOCK_METRICS);
      if (asked.length > ids.length) {
        /*
         * These are *visible* metrics the editor put on the page, and they vanish from it with
         * no tile, no count and nothing on screen — the payload cannot say so without becoming
         * the "there is something here you cannot see" signal §10 forbids. So it is said where
         * an operator can read it, which is the log.
         */
        services.log("metrics.block_truncated", {
          level: "warn",
          workspaceId: ctx.tenant.workspaceId,
          asked: asked.length,
          rendered: ids.length,
        });
      }
      // `chart` is present on every path, `null` when there is nothing to mint, so a renderer
      // never has to tell "no chart" from "this hydrator predates charts".
      const payload: MetricGridHydrated = { columns: columnsOf(data), metrics: [], chart: null };
      if (ids.length === 0) return payload as unknown as JsonObject;

      const reader: MetricReader = {
        kind: ctx.viewer.kind === "staff" ? "staff" : "external",
        groupIds: ctx.viewer.groupIds,
        delegateScope: ctx.viewer.delegateScope,
      };
      // `asOf` is the instant this rendering is *of* — a send's own instant, so a retry
      // produces the same columns and the same numbers — falling back to the clock for every
      // caller that has not opted in.
      const now = ctx.asOf ?? services.now();
      // Twelve years covers twelve periods of the coarsest kind, so one read serves every
      // definition in the block whatever grain each is reported at.
      const horizon = periodColumns("year", now, SPARKLINE_PERIODS)[0];

      const hydrated = await services.db.withTenant(ctx.tenant, async (tx) => {
        const rows = await new DefinitionRepo(ctx.tenant, tx).byIds(ids);
        /*
         * RLS has already dropped what this reader may not see; `audienceAdmits` is the second
         * lock, not the first. It matters because a hydrator can be called with a `system`
         * tenant context (server-side rendering for an email, a preview), where the database
         * admits everything and the viewer is the only thing that knows who is looking.
         */
        const visible = rows.filter((d) => audienceAdmits(d.audience, reader));
        if (visible.length === 0 || horizon === undefined) {
          return { tiles: [] as MetricGridTile[], series: [] as ChartableSeries[] };
        }
        const points = await new PointRepo(ctx.tenant, tx).series(
          visible.map((d) => d.id),
          horizon.period.start,
        );
        const byDefinition = new Map<string, PointRow[]>();
        for (const p of points) {
          const bucket = byDefinition.get(p.definitionId);
          if (bucket === undefined) byDefinition.set(p.definitionId, [p]);
          else bucket.push(p);
        }
        // The block's own order, minus the ids this reader may not see — which are simply
        // absent from the result and never counted anywhere in it.
        const byId = new Map(visible.map((d) => [d.id, d]));
        const tiles: MetricGridTile[] = [];
        const series: ChartableSeries[] = [];
        for (const id of ids) {
          const definition = byId.get(id);
          if (definition === undefined) continue;
          const own = byDefinition.get(id) ?? [];
          if (definition.periodKind === "custom") {
            const columns = customColumns(own);
            const values = columns.map((c) => {
              const at = own.find((p) => p.periodStart.getTime() === c.period.start.getTime());
              return at?.value;
            });
            tiles.push(tileOf(definition, columns, values));
            // A custom period has no canonical column series, so there is no honest x axis to
            // put it on; it keeps its tile and stays out of the chart.
            continue;
          }
          const columns = periodColumns(definition.periodKind, now, SPARKLINE_PERIODS);
          const values = alignSeries(definition, own, columns);
          tiles.push(tileOf(definition, columns, values));
          series.push({ definition, columns, values });
        }
        return { tiles, series };
      });

      /*
       * `medium` is absent on every caller that has not opted in, and absent must mean `web`:
       * the safe default for "should this response carry a 180-day capability?" is no.
       */
      const chart = ctx.medium === "email" ? await chartFor(services, ctx, hydrated.series) : null;
      return { ...payload, metrics: hydrated.tiles, chart } as unknown as JsonObject;
    },
  };
}
