import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Label,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@fundroomhq/ui";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Download, Flame, Info, LayoutGrid, Settings, ShieldOff } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { trackLabel } from "../../components/analytics/transparency-notice.js";
import { ErrorAlert } from "../../components/error-alert.js";
import {
  type AnalyticsMode,
  type AnalyticsResourceKind,
  analyticsHeatmapQuery,
  analyticsHotListQuery,
  analyticsOverviewQuery,
  analyticsPageDwellQuery,
  analyticsSettingsQuery,
  analyticsTimelineQuery,
  analyticsViewersQuery,
  fetchHotListCsv,
  useResourceTitles,
} from "../../lib/analytics-queries.js";
import { api, call, describeError } from "../../lib/api.js";
import { saveBlob } from "../../lib/certificates.js";
import { formatDateTime } from "../../lib/format.js";
import { personQuery, useBootstrap } from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import type { ModulePageProps } from "../types.js";

/*
 * Engagement, staff side (E1.5): `/admin/analytics` is the overview (mode, totals, top
 * documents, recent activity), `/admin/analytics/r/<kind>/<id>` is who viewed a resource,
 * `.../r/<kind>/<id>/<membershipId>` is that viewer's per-page dwell,
 * `/admin/analytics/members/<membershipId>` is one contact's timeline (keyset paged), and
 * `/admin/analytics/settings` holds the mode, retention and the DSAR erasure.
 *
 * E2.6 adds `.../r/<kind>/<id>/heatmap` (dwell per page across every reader, reached from
 * who viewed) and `/admin/analytics/hot-list` (investors ranked by recent engagement).
 */
const DAY_RANGES = [7, 30, 90] as const;

export default function AnalyticsAdmin({ splat }: ModulePageProps) {
  const [head, ...rest] = splat.split("/").filter(Boolean);
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  const can = {
    read: permissions.includes("analytics.read"),
    settings: permissions.includes("analytics.settings"),
  };
  if (head === "settings") return <SettingsScreen canSettings={can.settings} />;
  if (!can.read) return <Forbidden message={m.analytics_forbidden()} />;
  if (head === "hot-list") return <HotListScreen />;
  if (head === "r") {
    const [kind, id, membershipId] = rest;
    if (isKind(kind) && id) {
      // Membership ids are uuids, so the literal segment cannot shadow a viewer.
      if (membershipId === "heatmap") return <HeatmapScreen kind={kind} id={id} />;
      return membershipId ? (
        <PageDwellScreen kind={kind} id={id} membershipId={membershipId} />
      ) : (
        <ViewersScreen kind={kind} id={id} />
      );
    }
  }
  if (head === "members" && rest[0]) {
    return <TimelineScreen membershipId={rest[0]} canErase={can.settings} />;
  }
  return <Overview canSettings={can.settings} />;
}

function Forbidden({ message }: { message: string }) {
  return (
    <Alert variant="destructive" role="alert">
      <ShieldOff aria-hidden="true" />
      <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function isKind(value: string | undefined): value is AnalyticsResourceKind {
  return value === "document" || value === "post";
}

function modeLabel(mode: AnalyticsMode): string {
  switch (mode) {
    case "off":
      return m.analytics_mode_off();
    case "essential":
      return m.analytics_mode_essential();
    case "engagement":
      return m.analytics_mode_engagement();
  }
}

function eventLabel(type: string): string {
  switch (type) {
    case "document_viewed":
      return m.analytics_event_document_viewed();
    case "page_viewed":
      return m.analytics_event_page_viewed();
    case "document_downloaded":
      return m.analytics_event_document_downloaded();
    case "update_viewed":
      return m.analytics_event_update_viewed();
    default:
      return type;
  }
}

/** "1h 05m" / "5m 30s" / "12s" — dwell is only ever read at a glance. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const min = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m.analytics_dur_hm({ h: String(h), min: String(min) });
  if (min > 0) return m.analytics_dur_ms({ min: String(min), s: String(s) });
  return m.analytics_dur_s({ s: String(s) });
}

function ModeBanner({ mode }: { mode: AnalyticsMode }) {
  if (mode === "engagement") return null;
  return (
    <Alert>
      <Info aria-hidden="true" />
      <AlertTitle>
        {mode === "off" ? m.analytics_banner_off_title() : m.analytics_banner_essential_title()}
      </AlertTitle>
      <AlertDescription>
        {mode === "off" ? m.analytics_banner_off_body() : m.analytics_banner_essential_body()}
      </AlertDescription>
    </Alert>
  );
}

function BackLink({ splat, label }: { splat: string; label: string }) {
  return (
    <Button asChild variant="ghost">
      <Link to="/admin/$" params={{ _splat: splat }}>
        <ArrowLeft aria-hidden="true" />
        {label}
      </Link>
    </Button>
  );
}

// --- overview -------------------------------------------------------------------------------------

function Overview({ canSettings }: { canSettings: boolean }) {
  const titleOf = useResourceTitles();
  const [days, setDays] = useState<number>(30);
  const overview = useQuery(analyticsOverviewQuery(days));
  const rangeId = useId();
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.analytics_admin_title()}
        description={m.analytics_admin_subtitle()}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/admin/$" params={{ _splat: "analytics/hot-list" }}>
                <Flame aria-hidden="true" />
                {m.analytics_hot_list_link()}
              </Link>
            </Button>
            {canSettings ? (
              <Button asChild variant="outline">
                <Link to="/admin/$" params={{ _splat: "analytics/settings" }}>
                  <Settings aria-hidden="true" />
                  {m.analytics_settings_link()}
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />
      <div className="max-w-xs">
        <Label htmlFor={rangeId}>{m.analytics_range_label()}</Label>
        <select
          id={rangeId}
          value={String(days)}
          onChange={(e) => setDays(Number(e.target.value))}
          className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
        >
          {DAY_RANGES.map((d) => (
            <option key={d} value={String(d)}>
              {m.analytics_range_days({ n: String(d) })}
            </option>
          ))}
        </select>
      </div>
      {overview.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {overview.isError ? <ErrorAlert error={overview.error} /> : null}
      {overview.data ? (
        <>
          <ModeBanner mode={overview.data.mode} />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={m.analytics_total_views()} value={String(overview.data.totals.views)} />
            <Stat
              label={m.analytics_total_unique()}
              value={String(overview.data.totals.uniqueViewers)}
            />
            <Stat
              label={m.analytics_total_downloads()}
              value={String(overview.data.totals.downloads)}
            />
            <Stat
              label={m.analytics_total_time()}
              value={formatDuration(overview.data.totals.totalMs)}
            />
          </div>
          <section aria-labelledby="an-top" className="space-y-2">
            <h2 id="an-top" className="text-sm font-medium text-muted-foreground">
              {m.analytics_top_documents()}
            </h2>
            {overview.data.topDocuments.length === 0 ? (
              <p className="text-sm text-muted-foreground">{m.analytics_empty()}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.analytics_col_document()}</TableHead>
                    <TableHead>{m.analytics_col_views()}</TableHead>
                    <TableHead>{m.analytics_col_viewers()}</TableHead>
                    <TableHead>{m.analytics_col_downloads()}</TableHead>
                    <TableHead>{m.analytics_col_time()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.data.topDocuments.map((d) => (
                    <TableRow key={d.resourceId}>
                      <TableCell>
                        <Link
                          to="/admin/$"
                          params={{ _splat: `analytics/r/document/${d.resourceId}` }}
                          className="font-medium hover:underline"
                        >
                          {titleOf("document", d.resourceId)}
                        </Link>
                      </TableCell>
                      <TableCell className="tabular-nums">{d.views}</TableCell>
                      <TableCell className="tabular-nums">{d.uniqueViewers}</TableCell>
                      <TableCell className="tabular-nums">{d.downloads}</TableCell>
                      <TableCell className="tabular-nums">{formatDuration(d.totalMs)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
          <section aria-labelledby="an-recent" className="space-y-2">
            <h2 id="an-recent" className="text-sm font-medium text-muted-foreground">
              {m.analytics_recent()}
            </h2>
            {overview.data.recent.length === 0 ? (
              <p className="text-sm text-muted-foreground">{m.analytics_empty()}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.analytics_col_when()}</TableHead>
                    <TableHead>{m.analytics_col_who()}</TableHead>
                    <TableHead>{m.analytics_col_what()}</TableHead>
                    <TableHead>{m.analytics_col_document()}</TableHead>
                    <TableHead>{m.analytics_col_page()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {overview.data.recent.map((e) => (
                    <TableRow key={e.id}>
                      <TableCell>{formatDateTime(e.occurredAt)}</TableCell>
                      <TableCell>
                        <Link
                          to="/admin/$"
                          params={{ _splat: `analytics/members/${e.membershipId}` }}
                          className="hover:underline"
                        >
                          {e.membership?.displayName ?? m.analytics_unknown_member()}
                        </Link>
                      </TableCell>
                      <TableCell>{eventLabel(e.type)}</TableCell>
                      <TableCell>
                        <Link
                          to="/admin/$"
                          params={{ _splat: `analytics/r/${e.resourceKind}/${e.resourceId}` }}
                          className="hover:underline"
                        >
                          {titleOf(e.resourceKind, e.resourceId)}
                        </Link>
                      </TableCell>
                      <TableCell className="tabular-nums">{e.page ?? "—"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  );
}

// --- who viewed -----------------------------------------------------------------------------------

function ViewersScreen({ kind, id }: { kind: AnalyticsResourceKind; id: string }) {
  const titleOf = useResourceTitles();
  const viewers = useQuery(analyticsViewersQuery(kind, id));
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.analytics_viewers_title()}
        description={titleOf(kind, id)}
        actions={
          <div className="flex flex-wrap gap-2">
            <BackLink splat="analytics" label={m.analytics_back_to_overview()} />
            {kind === "document" ? (
              <Button asChild variant="outline">
                <Link to="/admin/$" params={{ _splat: `analytics/r/${kind}/${id}/heatmap` }}>
                  <LayoutGrid aria-hidden="true" />
                  {m.analytics_heatmap_link()}
                </Link>
              </Button>
            ) : null}
          </div>
        }
      />
      {viewers.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {viewers.isError ? <ErrorAlert error={viewers.error} /> : null}
      {viewers.data ? (
        <>
          <ModeBanner mode={viewers.data.mode} />
          {viewers.data.viewers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.analytics_viewers_empty()}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.analytics_col_who()}</TableHead>
                  <TableHead>{m.analytics_col_views()}</TableHead>
                  <TableHead>{m.analytics_col_downloads()}</TableHead>
                  <TableHead>{m.analytics_col_time()}</TableHead>
                  <TableHead>{m.analytics_col_furthest()}</TableHead>
                  <TableHead>{m.analytics_col_last_seen()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {viewers.data.viewers.map((v) => (
                  <TableRow key={v.membershipId}>
                    <TableCell>
                      <Link
                        to="/admin/$"
                        params={{ _splat: `analytics/r/${kind}/${id}/${v.membershipId}` }}
                        className="font-medium hover:underline"
                      >
                        {v.displayName}
                      </Link>
                      <Badge variant="outline" className="ml-2">
                        {v.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="tabular-nums">{v.views}</TableCell>
                    <TableCell className="tabular-nums">{v.downloads}</TableCell>
                    <TableCell className="tabular-nums">{formatDuration(v.totalMs)}</TableCell>
                    <TableCell className="tabular-nums">{v.maxPageReached ?? "—"}</TableCell>
                    <TableCell>{formatDateTime(v.lastAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      ) : null}
    </div>
  );
}

function PageDwellScreen({
  kind,
  id,
  membershipId,
}: {
  kind: AnalyticsResourceKind;
  id: string;
  membershipId: string;
}) {
  const titleOf = useResourceTitles();
  const pages = useQuery(analyticsPageDwellQuery(kind, id, membershipId));
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.analytics_pages_title()}
        description={titleOf(kind, id)}
        actions={
          <div className="flex gap-2">
            <BackLink splat={`analytics/r/${kind}/${id}`} label={m.analytics_back_to_viewers()} />
            <Button asChild variant="outline">
              <Link to="/admin/$" params={{ _splat: `analytics/members/${membershipId}` }}>
                {m.analytics_open_timeline()}
              </Link>
            </Button>
          </div>
        }
      />
      {pages.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {pages.isError ? <ErrorAlert error={pages.error} /> : null}
      {pages.data ? (
        pages.data.pages.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.analytics_pages_empty()}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.analytics_col_page()}</TableHead>
                <TableHead>{m.analytics_col_views()}</TableHead>
                <TableHead>{m.analytics_col_time()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pages.data.pages.map((p) => (
                <TableRow key={p.pageNo}>
                  <TableCell className="tabular-nums">{p.pageNo}</TableCell>
                  <TableCell className="tabular-nums">{p.views}</TableCell>
                  <TableCell className="tabular-nums">{formatDuration(p.durationMs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
      ) : null}
    </div>
  );
}

// --- page heatmap --------------------------------------------------------------------------------

/*
 * Every reader's dwell per page, from the rollup. Each page is a table row so the numbers are
 * the primary encoding; the bar is a decorative second channel (aria-hidden) and the page that
 * held readers longest is also marked in words — never colour alone.
 */
function HeatmapScreen({ kind, id }: { kind: AnalyticsResourceKind; id: string }) {
  const titleOf = useResourceTitles();
  const heatmap = useQuery(analyticsHeatmapQuery(kind, id));
  const versions = heatmap.data?.versions.filter((v) => v.pages.length > 0) ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.analytics_heatmap_title()}
        description={titleOf(kind, id)}
        actions={
          <BackLink splat={`analytics/r/${kind}/${id}`} label={m.analytics_back_to_viewers()} />
        }
      />
      {heatmap.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {heatmap.isError ? <ErrorAlert error={heatmap.error} /> : null}
      {heatmap.data ? (
        <>
          <ModeBanner mode={heatmap.data.mode} />
          <p className="text-sm text-muted-foreground">{m.analytics_heatmap_body()}</p>
          {versions.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.analytics_heatmap_empty()}</p>
          ) : (
            versions.map((v, i) => (
              <HeatmapTable
                key={v.versionId ?? `v${i}`}
                caption={
                  versions.length === 1
                    ? m.analytics_heatmap_caption()
                    : v.versionId === null
                      ? m.analytics_heatmap_version_unknown()
                      : m.analytics_heatmap_version({ id: v.versionId.slice(0, 8) })
                }
                pages={v.pages}
              />
            ))
          )}
        </>
      ) : null}
    </div>
  );
}

function HeatmapTable({
  caption,
  pages,
}: {
  caption: string;
  pages: readonly {
    pageNo: number;
    totalMs: number;
    views: number;
    viewers: number;
    avgMs: number;
  }[];
}) {
  const max = Math.max(1, ...pages.map((p) => p.totalMs));
  const hottest = pages.reduce<(typeof pages)[number] | undefined>(
    (best, p) => (best === undefined || p.totalMs > best.totalMs ? p : best),
    undefined,
  )?.pageNo;
  const sorted = [...pages].sort((a, b) => a.pageNo - b.pageNo);
  return (
    <Table>
      <caption className="mb-2 text-left text-sm font-medium">{caption}</caption>
      <TableHeader>
        <TableRow>
          <TableHead>{m.analytics_col_page()}</TableHead>
          <TableHead className="w-1/3">{m.analytics_col_time()}</TableHead>
          <TableHead>{m.analytics_col_avg_time()}</TableHead>
          <TableHead>{m.analytics_col_views()}</TableHead>
          <TableHead>{m.analytics_col_readers()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sorted.map((p) => (
          <TableRow key={p.pageNo}>
            <TableCell className="tabular-nums">
              {p.pageNo}
              {p.pageNo === hottest && p.totalMs > 0 ? (
                <Badge variant="secondary" className="ml-2">
                  {m.analytics_heatmap_hottest()}
                </Badge>
              ) : null}
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-2">
                <div aria-hidden="true" className="h-3 flex-1 rounded-sm bg-muted">
                  <div
                    className="h-3 rounded-sm bg-primary"
                    style={{ width: `${Math.round((p.totalMs / max) * 100)}%` }}
                  />
                </div>
                <span className="w-20 shrink-0 text-right tabular-nums">
                  {formatDuration(p.totalMs)}
                </span>
              </div>
            </TableCell>
            <TableCell className="tabular-nums">{formatDuration(p.avgMs)}</TableCell>
            <TableCell className="tabular-nums">{p.views}</TableCell>
            <TableCell className="tabular-nums">{p.viewers}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// --- hot list -------------------------------------------------------------------------------------

const HOT_LIST_RANGES = [7, 14, 30, 90] as const;

function HotListScreen() {
  // `undefined` = the workspace's own window (`hotListWindowDays`); the answer names it.
  const [days, setDays] = useState<number | undefined>(undefined);
  const hot = useQuery(analyticsHotListQuery(days));
  const rangeId = useId();
  const exportCsv = useGuardedMutation({
    mutationFn: () => fetchHotListCsv(days),
    onSuccess: (blob) => saveBlob(blob, "hot-list.csv"),
    onError: (error) => toast.error(describeError(error).title),
  });
  const windowDays = hot.data?.days;
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.analytics_hot_title()}
        description={m.analytics_hot_subtitle()}
        actions={
          <div className="flex flex-wrap gap-2">
            <BackLink splat="analytics" label={m.analytics_back_to_overview()} />
            <Button
              type="button"
              variant="outline"
              loading={exportCsv.isPending}
              onClick={() => exportCsv.mutate()}
            >
              <Download aria-hidden="true" />
              {m.analytics_hot_export()}
            </Button>
          </div>
        }
      />
      <div className="max-w-xs">
        <Label htmlFor={rangeId}>{m.analytics_range_label()}</Label>
        <select
          id={rangeId}
          value={days === undefined ? "" : String(days)}
          onChange={(e) => setDays(e.target.value === "" ? undefined : Number(e.target.value))}
          className="mt-1 h-9 w-full rounded-md border bg-background px-3 text-sm"
        >
          <option value="">{m.analytics_hot_window_default()}</option>
          {HOT_LIST_RANGES.map((d) => (
            <option key={d} value={String(d)}>
              {m.analytics_range_days({ n: String(d) })}
            </option>
          ))}
        </select>
      </div>
      {hot.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {hot.isError ? <ErrorAlert error={hot.error} /> : null}
      {hot.data ? (
        <>
          <p className="text-sm text-muted-foreground">
            {m.analytics_hot_window({ n: String(windowDays ?? "") })}{" "}
            {hot.data.threshold === null
              ? m.analytics_hot_threshold_off()
              : m.analytics_hot_threshold({ n: String(hot.data.threshold) })}
          </p>
          {hot.data.entries.length === 0 ? (
            <Alert>
              <Info aria-hidden="true" />
              <AlertTitle>{m.analytics_hot_empty_title()}</AlertTitle>
              <AlertDescription>
                {hot.data.mode === "engagement"
                  ? m.analytics_hot_empty_body()
                  : m.analytics_hot_empty_mode()}
              </AlertDescription>
            </Alert>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.analytics_col_rank()}</TableHead>
                  <TableHead>{m.analytics_col_who()}</TableHead>
                  <TableHead>{m.analytics_col_score()}</TableHead>
                  <TableHead>{m.analytics_col_breakdown()}</TableHead>
                  <TableHead>{m.analytics_col_last_seen()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {hot.data.entries.map((e, i) => (
                  <TableRow key={e.membershipId}>
                    <TableCell className="tabular-nums">{i + 1}</TableCell>
                    <TableCell>
                      <Link
                        to="/admin/$"
                        params={{ _splat: `analytics/members/${e.membershipId}` }}
                        className="font-medium hover:underline"
                      >
                        {e.displayName}
                      </Link>
                      <Badge variant="outline" className="ml-2">
                        {e.role}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-lg font-semibold tabular-nums">{e.score}</TableCell>
                    <TableCell>
                      <ScoreBreakdown entry={e} />
                    </TableCell>
                    <TableCell>
                      {e.lastActivityAt === null ? "—" : formatDateTime(e.lastActivityAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      ) : null}
    </div>
  );
}

/** Points per signal with the raw count beside it; automated email traffic is listed, unscored. */
function ScoreBreakdown({
  entry,
}: {
  entry: {
    points: { views: number; dwell: number; downloads: number; opens: number; clicks: number };
    counts: {
      views: number;
      dwellMs: number;
      downloads: number;
      humanOpens: number;
      clicks: number;
      automatedOpens: number;
      automatedClicks: number;
    };
  };
}) {
  const { points, counts } = entry;
  const pts = (n: number) => String(Math.round(n));
  const rows: [string, string][] = [
    [m.analytics_hot_views({ n: String(counts.views) }), pts(points.views)],
    [m.analytics_hot_dwell({ time: formatDuration(counts.dwellMs) }), pts(points.dwell)],
    [m.analytics_hot_downloads({ n: String(counts.downloads) }), pts(points.downloads)],
    [m.analytics_hot_opens({ n: String(counts.humanOpens) }), pts(points.opens)],
    [m.analytics_hot_clicks({ n: String(counts.clicks) }), pts(points.clicks)],
  ];
  const automated = counts.automatedOpens + counts.automatedClicks;
  return (
    <div className="text-sm">
      <dl className="grid grid-cols-[1fr_auto] gap-x-4">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right tabular-nums">{m.analytics_hot_points({ n: value })}</dd>
          </div>
        ))}
      </dl>
      {automated > 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {m.analytics_hot_automated({
            opens: String(counts.automatedOpens),
            clicks: String(counts.automatedClicks),
          })}
        </p>
      ) : null}
    </div>
  );
}

// --- per-contact timeline -------------------------------------------------------------------------

function TimelineScreen({ membershipId, canErase }: { membershipId: string; canErase: boolean }) {
  const titleOf = useResourceTitles();
  const person = useQuery({ ...personQuery(membershipId), retry: false });
  const timeline = useInfiniteQuery(analyticsTimelineQuery(membershipId));
  const items = timeline.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.analytics_timeline_title()}
        description={
          person.data?.person.displayName ??
          m.analytics_member_ref({ id: membershipId.slice(0, 8) })
        }
        actions={
          <div className="flex gap-2">
            <BackLink splat="analytics" label={m.analytics_back_to_overview()} />
            {canErase ? <AnonymiseButton membershipId={membershipId} /> : null}
          </div>
        }
      />
      {timeline.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {timeline.isError ? <ErrorAlert error={timeline.error} /> : null}
      {timeline.data ? (
        items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.analytics_timeline_empty()}</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.analytics_col_when()}</TableHead>
                  <TableHead>{m.analytics_col_what()}</TableHead>
                  <TableHead>{m.analytics_col_document()}</TableHead>
                  <TableHead>{m.analytics_col_page()}</TableHead>
                  <TableHead>{m.analytics_col_time()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((i) => (
                  <TableRow key={i.id}>
                    <TableCell>{formatDateTime(i.occurredAt)}</TableCell>
                    <TableCell>{eventLabel(i.type)}</TableCell>
                    <TableCell>
                      <Link
                        to="/admin/$"
                        params={{ _splat: `analytics/r/${i.resourceKind}/${i.resourceId}` }}
                        className="hover:underline"
                      >
                        {titleOf(i.resourceKind, i.resourceId)}
                      </Link>
                    </TableCell>
                    <TableCell className="tabular-nums">{i.pageNo ?? "—"}</TableCell>
                    <TableCell className="tabular-nums">
                      {i.durationMs === null ? "—" : formatDuration(i.durationMs)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {timeline.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                loading={timeline.isFetchingNextPage}
                onClick={() => void timeline.fetchNextPage()}
              >
                {m.analytics_load_more()}
              </Button>
            ) : null}
          </>
        )
      ) : null}
    </div>
  );
}

function AnonymiseButton({ membershipId }: { membershipId: string }) {
  const queryClient = useQueryClient();
  const erase = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/analytics/members/{membershipId}/anonymise", {
          params: { path: { membershipId } },
        }),
      ),
    onSuccess: () => {
      toast.success(m.analytics_anonymise_done());
      void queryClient.invalidateQueries({ queryKey: ["analytics"] });
    },
  });
  return (
    <ConfirmDialog
      trigger={
        <Button type="button" variant="destructive">
          <ShieldOff aria-hidden="true" />
          {m.analytics_anonymise()}
        </Button>
      }
      title={m.analytics_anonymise()}
      description={m.analytics_anonymise_body()}
      confirmLabel={m.analytics_anonymise_confirm()}
      pending={erase.isPending}
      onConfirm={() => erase.mutate()}
    />
  );
}

// --- settings -------------------------------------------------------------------------------------

const MODES: readonly AnalyticsMode[] = ["off", "essential", "engagement"];

function modeHint(mode: AnalyticsMode): string {
  switch (mode) {
    case "off":
      return m.analytics_mode_off_hint();
    case "essential":
      return m.analytics_mode_essential_hint();
    case "engagement":
      return m.analytics_mode_engagement_hint();
  }
}

function SettingsScreen({ canSettings }: { canSettings: boolean }) {
  const settings = useQuery(analyticsSettingsQuery);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<SettingsForm | undefined>(undefined);
  const retentionId = useId();
  const windowId = useId();
  const thresholdId = useId();
  useEffect(() => {
    if (settings.data && form === undefined) {
      setForm({
        mode: settings.data.mode,
        retentionMonths: String(settings.data.retentionMonths),
        hotListWindowDays: String(settings.data.hotListWindowDays),
        alertsOn: settings.data.hotLeadThreshold !== null,
        hotLeadThreshold: String(settings.data.hotLeadThreshold ?? 60),
      });
    }
  }, [settings.data, form]);
  // A `fresh` step-up is required to change these; `useGuardedMutation` routes the 401 to
  // `/auth/step-up?reason=fresh` and brings the operator straight back here.
  const save = useGuardedMutation({
    mutationFn: () => {
      if (!form) throw new Error("not loaded");
      return call(
        api().PATCH("/analytics/settings", {
          body: {
            mode: form.mode,
            retentionMonths: Number(form.retentionMonths),
            hotListWindowDays: Number(form.hotListWindowDays),
            hotLeadThreshold: form.alertsOn ? Number(form.hotLeadThreshold) : null,
          },
        }),
      );
    },
    onSuccess: (data) => {
      toast.success(m.analytics_settings_saved());
      queryClient.setQueryData(analyticsSettingsQuery.queryKey, data);
      void queryClient.invalidateQueries({ queryKey: ["analytics"] });
    },
  });
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.analytics_settings_title()}
        description={m.analytics_settings_subtitle()}
        actions={<BackLink splat="analytics" label={m.analytics_back_to_overview()} />}
      />
      {!canSettings ? <Forbidden message={m.analytics_settings_forbidden()} /> : null}
      {settings.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {settings.isError ? <ErrorAlert error={settings.error} /> : null}
      {form ? (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>{m.analytics_settings_card_title()}</CardTitle>
            <CardDescription>{m.analytics_settings_card_body()}</CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                save.mutate();
              }}
            >
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{m.analytics_field_mode()}</legend>
                {MODES.map((mode) => (
                  <label key={mode} className="flex items-start gap-2 text-sm">
                    <input
                      type="radio"
                      name="analytics-mode"
                      value={mode}
                      checked={form.mode === mode}
                      disabled={!canSettings}
                      onChange={() => setForm({ ...form, mode })}
                      className="mt-1"
                    />
                    <span>
                      <span className="font-medium">{modeLabel(mode)}</span>
                      <span className="block text-muted-foreground">{modeHint(mode)}</span>
                    </span>
                  </label>
                ))}
              </fieldset>
              <Field
                id={retentionId}
                label={m.analytics_field_retention()}
                description={m.analytics_field_retention_hint()}
                required
              >
                <Input
                  id={retentionId}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={120}
                  required
                  disabled={!canSettings}
                  value={form.retentionMonths}
                  onChange={(e) => setForm({ ...form, retentionMonths: e.target.value })}
                />
              </Field>
              <p className="text-sm text-muted-foreground">{m.analytics_retention_legal_hold()}</p>
              <fieldset className="space-y-4 rounded-md border p-4">
                <legend className="px-1 text-sm font-medium">{m.analytics_hot_settings()}</legend>
                <p className="text-sm text-muted-foreground">{m.analytics_hot_settings_body()}</p>
                <Field
                  id={windowId}
                  label={m.analytics_field_hot_window()}
                  description={m.analytics_field_hot_window_hint()}
                  required
                >
                  <Input
                    id={windowId}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={90}
                    required
                    disabled={!canSettings}
                    aria-describedby={`${windowId}-description`}
                    value={form.hotListWindowDays}
                    onChange={(e) => setForm({ ...form, hotListWindowDays: e.target.value })}
                  />
                </Field>
                <label className="flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.alertsOn}
                    disabled={!canSettings}
                    onChange={(e) => setForm({ ...form, alertsOn: e.target.checked })}
                    className="mt-1"
                  />
                  <span>{m.analytics_field_hot_alerts()}</span>
                </label>
                <Field
                  id={thresholdId}
                  label={m.analytics_field_hot_threshold()}
                  description={m.analytics_field_hot_threshold_hint()}
                  required={form.alertsOn}
                >
                  <Input
                    id={thresholdId}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={100}
                    required={form.alertsOn}
                    disabled={!canSettings || !form.alertsOn}
                    aria-describedby={`${thresholdId}-description`}
                    value={form.hotLeadThreshold}
                    onChange={(e) => setForm({ ...form, hotLeadThreshold: e.target.value })}
                  />
                </Field>
              </fieldset>
              <div className="text-sm text-muted-foreground">
                <p>{m.analytics_settings_tracks()}</p>
                <ul className="mt-1 list-disc pl-5">
                  {tracksFor(form.mode).map((t) => (
                    <li key={t}>{trackLabel(t)}</li>
                  ))}
                </ul>
              </div>
              {save.isError ? <ErrorAlert error={save.error} /> : null}
              <Button type="submit" disabled={!canSettings} loading={save.isPending}>
                {m.common_save()}
              </Button>
            </form>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

interface SettingsForm {
  mode: AnalyticsMode;
  retentionMonths: string;
  hotListWindowDays: string;
  /** Off sends `hotLeadThreshold: null`: the list still ranks, nobody is alerted. */
  alertsOn: boolean;
  hotLeadThreshold: string;
}

/** Mirrors the server's `tracksFor()` so the operator sees what a mode discloses before saving. */
function tracksFor(mode: AnalyticsMode): string[] {
  if (mode === "off") return [];
  const essential = ["document_views", "downloads", "update_views"];
  // `email_engagement` is disclosed here and in the portal notice although the server's
  // `tracksFor()` does not list it yet: engagement mode is what turns on open/click tracking.
  return mode === "essential"
    ? essential
    : [...essential, "page_dwell", "browser_family", "hashed_ip", "email_engagement"];
}
