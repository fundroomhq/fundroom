import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Checkbox,
  Label,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  toast,
} from "@fundroomhq/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { useId, useRef, useState } from "react";
import { describeError } from "../../../lib/api.js";
import { formatDateTime } from "../../../lib/format.js";
import {
  downloadQaExport,
  QA_INBOX_STATUSES,
  type QaInboxFilter,
  type QaInboxItem,
  type QaInboxPage,
  type QaQuestionStatus,
  qaInboxQuery,
} from "../../../lib/qa-admin-queries.js";
import { dataRoomSettingsQuery } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";
import { NativeSelect } from "../../compliance/common.js";
import { QaErrorAlert, QaSlaBadge, QaTargetLink, qaEmptyLabel, qaStatusLabel } from "./common.js";
import { QaImportDialog } from "./import-dialog.js";
import { QaNewEntryDialog } from "./new-entry-dialog.js";

export interface QaPermissions {
  canAnswer: boolean;
  canApprove: boolean;
  canManage: boolean;
  canSettings: boolean;
}

/*
 * The staff Q&A inbox (/admin/data-room/questions): one tab per status with every status's
 * count (the server counts independently of the filters), filters for assignee and overdue,
 * and — for `data-room.qa_manage` — CSV export/import and staff-authored entries.
 */
export function QaInbox({ perms }: { perms: QaPermissions }) {
  const ids = { assignee: useId(), overdue: useId() };
  const [status, setStatus] = useState<QaQuestionStatus>("open");
  const [assignee, setAssignee] = useState<QaInboxFilter["assignee"]>("");
  const [overdue, setOverdue] = useState(false);
  const filter: QaInboxFilter = { status, assignee, overdue };
  const list = useInfiniteQuery(qaInboxQuery(filter));
  const settings = useQuery(dataRoomSettingsQuery);
  // Counts are workspace-wide, so the last ones stay on the tabs while another tab loads.
  const lastCounts = useRef<QaInboxPage["counts"]>(undefined);
  if (list.data?.pages[0]) lastCounts.current = list.data.pages[0].counts;
  const counts = lastCounts.current;
  const exportCsv = useGuardedMutation({
    mutationFn: () => downloadQaExport(),
    onSuccess: ({ truncated }) => {
      if (truncated) toast.warning(m.dataroom_qa_admin_export_truncated());
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const qaOff = settings.data?.qa !== undefined && !settings.data.qa.enabled;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{m.dataroom_qa_admin_title()}</h2>
        {perms.canManage ? (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              loading={exportCsv.isPending}
              onClick={() => exportCsv.mutate()}
            >
              <Download aria-hidden="true" />
              {m.dataroom_qa_admin_export()}
            </Button>
            <QaImportDialog />
            <QaNewEntryDialog />
          </div>
        ) : null}
      </div>
      {perms.canAnswer || perms.canApprove || perms.canManage ? null : (
        <p className="text-sm text-muted-foreground">{m.dataroom_qa_admin_read_only()}</p>
      )}
      {qaOff ? (
        <Alert>
          <AlertTitle>{m.dataroom_qa_admin_disabled_title()}</AlertTitle>
          <AlertDescription>
            <p>
              {m.dataroom_qa_admin_disabled_body()}{" "}
              {perms.canSettings ? (
                <Link
                  to="/admin/$"
                  params={{ _splat: "data-room/settings" }}
                  className="font-medium underline underline-offset-4"
                >
                  {m.dataroom_qa_admin_settings_link()}
                </Link>
              ) : null}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="flex flex-wrap items-end gap-4">
        <div className="grid gap-1">
          <Label htmlFor={ids.assignee}>{m.dataroom_qa_admin_filter_assignee()}</Label>
          <NativeSelect
            id={ids.assignee}
            value={assignee}
            onChange={(e) => setAssignee(e.target.value as QaInboxFilter["assignee"])}
            className="w-48"
          >
            <option value="">{m.dataroom_qa_admin_filter_anyone()}</option>
            <option value="me">{m.dataroom_qa_admin_filter_me()}</option>
            <option value="unassigned">{m.dataroom_qa_admin_filter_unassigned()}</option>
          </NativeSelect>
        </div>
        <div className="flex items-center gap-2 pb-2">
          <Checkbox
            id={ids.overdue}
            checked={overdue}
            onCheckedChange={(on) => setOverdue(on === true)}
          />
          <Label htmlFor={ids.overdue}>{m.dataroom_qa_admin_filter_overdue()}</Label>
        </div>
      </div>
      <Tabs value={status} onValueChange={(v) => setStatus(v as QaQuestionStatus)}>
        <TabsList aria-label={m.dataroom_qa_admin_tabs()} className="flex-wrap">
          {QA_INBOX_STATUSES.map((s) => (
            <TabsTrigger key={s} value={s}>
              {counts === undefined
                ? qaStatusLabel(s)
                : m.dataroom_qa_admin_tab_count({
                    label: qaStatusLabel(s),
                    count: String(counts[s] ?? 0),
                  })}
            </TabsTrigger>
          ))}
        </TabsList>
        {QA_INBOX_STATUSES.map((s) => (
          <TabsContent key={s} value={s}>
            {s !== status ? null : list.isPending ? (
              <LoadingState lines={4} label={m.common_loading()} />
            ) : list.isError ? (
              <QaErrorAlert error={list.error} />
            ) : (
              <InboxTable
                status={s}
                items={list.data.pages.flatMap((p) => p.items)}
                hasNextPage={list.hasNextPage}
                isFetchingNextPage={list.isFetchingNextPage}
                onLoadMore={() => void list.fetchNextPage()}
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function InboxTable({
  status,
  items,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: {
  status: QaQuestionStatus;
  items: readonly QaInboxItem[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}) {
  if (items.length === 0) {
    return <p className="py-6 text-sm text-muted-foreground">{qaEmptyLabel(status)}</p>;
  }
  return (
    <div className="space-y-4">
      <div className="overflow-x-auto">
        <Table aria-label={qaStatusLabel(status)}>
          <TableHeader>
            <TableRow>
              <TableHead>{m.dataroom_qa_admin_col_subject()}</TableHead>
              <TableHead>{m.dataroom_qa_admin_col_target()}</TableHead>
              <TableHead>{m.dataroom_qa_admin_col_asker()}</TableHead>
              <TableHead>{m.dataroom_qa_admin_col_assignee()}</TableHead>
              <TableHead>{m.dataroom_qa_admin_col_sla()}</TableHead>
              <TableHead>{m.dataroom_qa_admin_col_created()}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((q) => (
              <TableRow key={q.id}>
                <TableCell className="font-medium">
                  <Link
                    to="/admin/$"
                    params={{ _splat: `data-room/questions/${q.id}` }}
                    className="underline underline-offset-4"
                  >
                    {q.subject}
                  </Link>
                </TableCell>
                <TableCell>
                  <QaTargetLink kind={q.target.kind} id={q.target.id} title={q.target.title} />
                </TableCell>
                <TableCell>{q.askerName ?? "—"}</TableCell>
                <TableCell>{q.assigneeName ?? "—"}</TableCell>
                <TableCell>
                  <QaSlaBadge sla={q.sla} />
                </TableCell>
                <TableCell>{formatDateTime(q.createdAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {hasNextPage ? (
        <Button type="button" variant="outline" loading={isFetchingNextPage} onClick={onLoadMore}>
          {m.common_load_more()}
        </Button>
      ) : null}
    </div>
  );
}
