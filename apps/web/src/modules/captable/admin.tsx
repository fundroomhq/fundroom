import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Field,
  fieldAria,
  LoadingState,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, FileSpreadsheet, PieChart, Settings } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { TypedConfirmDialog } from "../../components/typed-confirm-dialog.js";
import { api, call } from "../../lib/api.js";
import {
  CAPTABLE_INVESTOR_VIEWS,
  type CaptableHolder,
  type CaptableInvestorView,
  type CaptableSettings,
  type CaptableSnapshot,
  captableSettingsQuery,
  captableSnapshotQuery,
  captableSnapshotsQuery,
} from "../../lib/captable-queries.js";
import { formatDateTime } from "../../lib/format.js";
import { useBootstrap } from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import type { ModulePageProps } from "../types.js";
import {
  formatAsOf,
  formatPercent,
  formatShares,
  investorViewLabel,
  sourceLabel,
  statusLabel,
  statusVariant,
} from "./format.js";
import { ImportScreen } from "./import.js";
import { amountsText, ClassTable, RoundingNote, TotalsCard } from "./summary.js";

/*
 * Cap table, staff side (E3.6 §8). `/admin/captable` lists the snapshots; `…/import` is the
 * paste → dry run → draft wizard; `…/snapshots/<id>` is one snapshot's summary (fully diluted
 * by class, option pool, SAFEs/notes outstanding, holders) with publish and delete-draft; and
 * `…/settings` decides what an investor sees.
 *
 * Snapshots are records: once imported, a snapshot's numbers never change (the database
 * refuses it). The only lifecycle is draft → published → superseded, and only a draft can be
 * deleted. Publishing is the one act that reaches investors, so it is confirmed, step-up
 * guarded server-side, and says in the dialog which snapshot it will supersede.
 */

export default function CaptableAdmin({ splat }: ModulePageProps) {
  const [head, id] = splat.split("/").filter(Boolean);
  const permissions = useBootstrap().data?.permissions ?? [];
  const canManage = permissions.includes("captable.manage");
  if (head === "import" && canManage) return <ImportScreen />;
  if (head === "settings" && canManage) return <SettingsScreen />;
  if (head === "snapshots" && id !== undefined)
    return <SnapshotScreen id={id} canManage={canManage} />;
  return <ListScreen canManage={canManage} />;
}

function BackLink() {
  return (
    <Button asChild variant="outline">
      <Link to="/admin/$" params={{ _splat: "captable" }}>
        <ArrowLeft aria-hidden="true" />
        {m.captable_back()}
      </Link>
    </Button>
  );
}

function ImportLink() {
  return (
    <Button asChild>
      <Link to="/admin/$" params={{ _splat: "captable/import" }}>
        <FileSpreadsheet aria-hidden="true" />
        {m.captable_import_button()}
      </Link>
    </Button>
  );
}

// --- list ---------------------------------------------------------------------------------------

function ListScreen({ canManage }: { canManage: boolean }) {
  const snapshots = useQuery(captableSnapshotsQuery);
  const rows = snapshots.data ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.captable_admin_title()}
        description={m.captable_admin_subtitle()}
        actions={
          canManage ? (
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link to="/admin/$" params={{ _splat: "captable/settings" }}>
                  <Settings aria-hidden="true" />
                  {m.captable_settings_link()}
                </Link>
              </Button>
              <ImportLink />
            </div>
          ) : null
        }
      />
      {snapshots.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {snapshots.isError ? <ErrorAlert error={snapshots.error} /> : null}
      {snapshots.data === undefined ? null : rows.length === 0 ? (
        <EmptyState
          icon={<PieChart aria-hidden="true" />}
          title={m.captable_empty_title()}
          description={m.captable_empty_body()}
          action={canManage ? <ImportLink /> : undefined}
        />
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <caption className="sr-only">{m.captable_snapshots_caption()}</caption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">{m.captable_col_as_of()}</TableHead>
                <TableHead scope="col">{m.captable_col_status()}</TableHead>
                <TableHead scope="col">{m.captable_col_source()}</TableHead>
                <TableHead scope="col" className="text-right">
                  {m.captable_col_fully_diluted()}
                </TableHead>
                <TableHead scope="col" className="text-right">
                  {m.captable_col_holders()}
                </TableHead>
                <TableHead scope="col">{m.captable_col_imported()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.id}>
                  <TableHead scope="row" className="font-medium">
                    <Link
                      to="/admin/$"
                      params={{ _splat: `captable/snapshots/${s.id}` }}
                      className="underline underline-offset-4"
                    >
                      {formatAsOf(s.asOf)}
                    </Link>
                  </TableHead>
                  <TableCell>
                    <Badge variant={statusVariant(s.status)}>{statusLabel(s.status)}</Badge>
                  </TableCell>
                  <TableCell>{sourceLabel(s.source)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatShares(s.summary.fullyDilutedShares)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{s.summary.holderCount}</TableCell>
                  <TableCell>{formatDateTime(s.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

// --- one snapshot -------------------------------------------------------------------------------

function HoldersTable({ holders }: { holders: readonly CaptableHolder[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <caption className="sr-only">{m.captable_holders_caption()}</caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{m.captable_col_holder()}</TableHead>
            <TableHead scope="col" className="text-right">
              {m.captable_col_fully_diluted()}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {m.captable_col_percent_fd()}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {m.captable_col_amount()}
            </TableHead>
            <TableHead scope="col" className="text-right">
              {m.captable_col_lines()}
            </TableHead>
            <TableHead scope="col">{m.captable_col_member()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {holders.map((h) => (
            <TableRow key={h.key}>
              <TableHead scope="row" className="font-medium">
                <span className="block">{h.holderName}</span>
                {h.holderEmail === null ? null : (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {h.holderEmail}
                  </span>
                )}
              </TableHead>
              <TableCell className="text-right tabular-nums">
                {formatShares(h.fullyDilutedShares)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPercent(h.percentFullyDiluted)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{amountsText(h.amounts)}</TableCell>
              <TableCell className="text-right tabular-nums">{h.lines}</TableCell>
              <TableCell>
                {h.membershipId === null ? (
                  <Badge variant="outline">{m.captable_member_unmatched()}</Badge>
                ) : (
                  <Badge variant="success">{m.captable_member_matched()}</Badge>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <RoundingNote />
    </div>
  );
}

function SnapshotActions({
  snapshot,
  published,
}: {
  snapshot: CaptableSnapshot;
  published: CaptableSnapshot | undefined;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const publish = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/captable/snapshots/{id}/publish", {
          params: { path: { id: snapshot.id } },
        }),
      ),
    onSuccess: () => {
      toast.success(m.captable_published());
      void queryClient.invalidateQueries({ queryKey: ["captable"] });
    },
  });
  const remove = useGuardedMutation({
    mutationFn: () =>
      call(
        api().DELETE("/captable/snapshots/{id}", {
          params: { path: { id: snapshot.id } },
        }),
      ),
    onSuccess: () => {
      toast.success(m.captable_deleted());
      void queryClient.invalidateQueries({ queryKey: ["captable"] });
      void navigate({ to: "/admin/$", params: { _splat: "captable" } });
    },
  });
  const asOf = formatAsOf(snapshot.asOf);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <ConfirmDialog
          trigger={<Button type="button">{m.captable_publish()}</Button>}
          title={m.captable_publish_title({ asOf })}
          description={
            published === undefined
              ? m.captable_publish_body_first()
              : m.captable_publish_body_supersede({ previous: formatAsOf(published.asOf) })
          }
          confirmLabel={m.captable_publish()}
          pending={publish.isPending}
          onConfirm={() => publish.mutate()}
        />
        <TypedConfirmDialog
          trigger={
            <Button type="button" variant="outline">
              {m.captable_delete_draft()}
            </Button>
          }
          title={m.captable_delete_title({ asOf })}
          description={m.captable_delete_body()}
          phrase={snapshot.asOf}
          confirmLabel={m.captable_delete_draft()}
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      </div>
      <ErrorAlert error={publish.error ?? remove.error} />
    </div>
  );
}

function SnapshotScreen({ id, canManage }: { id: string; canManage: boolean }) {
  const detail = useQuery(captableSnapshotQuery(id));
  // The list says which snapshot is live now, so the publish dialog can name what it replaces.
  const list = useQuery({ ...captableSnapshotsQuery, enabled: canManage });
  const data = detail.data;
  const published = list.data?.find((s) => s.status === "published" && s.id !== id);
  return (
    <div className="space-y-6">
      <PageHeader
        title={
          data === undefined
            ? m.captable_admin_title()
            : m.captable_snapshot_title({ asOf: formatAsOf(data.snapshot.asOf) })
        }
        description={m.captable_snapshot_subtitle()}
        actions={<BackLink />}
      />
      {detail.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {detail.isError ? <ErrorAlert error={detail.error} /> : null}
      {data === undefined ? null : (
        <>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge variant={statusVariant(data.snapshot.status)}>
              {statusLabel(data.snapshot.status)}
            </Badge>
            <span>{m.captable_source_line({ source: sourceLabel(data.snapshot.source) })}</span>
            {data.snapshot.publishedAt === null ? null : (
              <span className="text-muted-foreground">
                {m.captable_published_at({ at: formatDateTime(data.snapshot.publishedAt) })}
              </span>
            )}
          </div>
          {data.snapshot.note === null || data.snapshot.note === "" ? null : (
            <p className="text-sm text-muted-foreground">{data.snapshot.note}</p>
          )}
          {data.snapshot.status === "draft" ? (
            <p className="text-sm" role="note">
              {m.captable_draft_note()}
            </p>
          ) : null}
          {canManage && data.snapshot.status === "draft" ? (
            <SnapshotActions snapshot={data.snapshot} published={published} />
          ) : null}
          <TotalsCard summary={data.snapshot.summary} />
          <section className="space-y-2" aria-labelledby={`${id}-classes`}>
            <h2 id={`${id}-classes`} className="text-lg font-semibold">
              {m.captable_classes_title()}
            </h2>
            <ClassTable
              classes={data.snapshot.summary.classes}
              caption={m.captable_classes_caption()}
            />
          </section>
          <section className="space-y-2" aria-labelledby={`${id}-holders`}>
            <h2 id={`${id}-holders`} className="text-lg font-semibold">
              {m.captable_holders_title()}
            </h2>
            <HoldersTable holders={data.holders} />
          </section>
        </>
      )}
    </div>
  );
}

// --- settings -----------------------------------------------------------------------------------

function SettingsForm({ settings }: { settings: CaptableSettings }) {
  const base = useId();
  const queryClient = useQueryClient();
  const [view, setView] = useState<CaptableInvestorView>(settings.investorView);
  const [disclaimer, setDisclaimer] = useState(settings.disclaimer ?? "");
  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PUT("/captable/settings", {
          body: {
            investorView: view,
            // Empty means "use the built-in text", not "show no disclaimer".
            disclaimer: disclaimer.trim() === "" ? null : disclaimer,
          },
        }),
      ),
    onSuccess: (next) => {
      toast.success(m.captable_settings_saved());
      queryClient.setQueryData(captableSettingsQuery.queryKey, next);
      void queryClient.invalidateQueries({ queryKey: ["captable", "me"] });
    },
  });
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <ErrorAlert error={save.error} />
      <Field
        id={`${base}-view`}
        label={m.captable_field_investor_view()}
        description={m.captable_field_investor_view_help()}
      >
        <NativeSelect
          id={`${base}-view`}
          value={view}
          className="md:w-80"
          {...fieldAria(`${base}-view`, { description: true })}
          onChange={(e) => setView(e.target.value as CaptableInvestorView)}
        >
          {CAPTABLE_INVESTOR_VIEWS.map((v) => (
            <option key={v} value={v}>
              {investorViewLabel(v)}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <Field
        id={`${base}-disclaimer`}
        label={m.captable_field_disclaimer()}
        description={m.captable_field_disclaimer_help()}
      >
        <Textarea
          id={`${base}-disclaimer`}
          rows={6}
          maxLength={2000}
          value={disclaimer}
          placeholder={settings.defaultDisclaimer}
          {...fieldAria(`${base}-disclaimer`, { description: true })}
          onChange={(e) => setDisclaimer(e.target.value)}
        />
      </Field>
      <Button type="submit" loading={save.isPending}>
        {m.common_save()}
      </Button>
    </form>
  );
}

function SettingsScreen() {
  const settings = useQuery(captableSettingsQuery);
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.captable_settings_title()}
        description={m.captable_settings_subtitle()}
        actions={<BackLink />}
      />
      <Card>
        <CardHeader>
          <CardTitle>{m.captable_settings_card_title()}</CardTitle>
          <CardDescription>{m.captable_settings_card_body()}</CardDescription>
        </CardHeader>
        <CardContent>
          {settings.isPending ? <LoadingState label={m.common_loading()} /> : null}
          {settings.isError ? <ErrorAlert error={settings.error} /> : null}
          {settings.data === undefined ? null : <SettingsForm settings={settings.data} />}
        </CardContent>
      </Card>
    </div>
  );
}
