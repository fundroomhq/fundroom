import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  LoadingState,
  PageHeader,
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
} from "@fundroomhq/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldOff } from "lucide-react";
import { useState } from "react";
import {
  accessRequestStatusLabel,
  emptyLabel,
} from "../../../components/access-requests/common.js";
import {
  ACCESS_REQUEST_STATUSES,
  type AccessRequest,
  type AccessRequestStatus,
  accessRequestsQuery,
} from "../../../components/access-requests/queries.js";
import {
  RequestDialog,
  type RequestDialogMode,
} from "../../../components/access-requests/request-dialog.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { formatDateTime } from "../../../lib/format.js";
import { accessSettingsQuery, useBootstrap } from "../../../lib/queries.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/access-requests/")({ component: AccessRequestsPage });

/*
 * The access-request queue (E3.1). Reading needs `access.read`; approving and denying need
 * `access.manage` — without it the queue is browsable but every decision control is absent.
 * Under Rule 506(b) an approval must attest a pre-existing relationship (the server answers 422
 * `relationship_attestation_required` otherwise), so the approve form asks for it up front.
 */
function AccessRequestsPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  if (!permissions.includes("access.read")) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.accessrequests_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return (
    <AccessRequestsScreen
      canManage={permissions.includes("access.manage")}
      is506b={bootstrap.data?.workspace?.offeringStatus === "506b"}
    />
  );
}

function AccessRequestsScreen({ canManage, is506b }: { canManage: boolean; is506b: boolean }) {
  const [status, setStatus] = useState<AccessRequestStatus>("pending");
  const settings = useQuery(accessSettingsQuery);
  return (
    <div className="space-y-6">
      <PageHeader title={m.accessrequests_title()} description={m.accessrequests_subtitle()} />
      {canManage ? null : (
        <p className="text-sm text-muted-foreground">{m.accessrequests_read_only()}</p>
      )}
      {settings.data && !settings.data.requests.enabled ? (
        <Alert>
          <AlertTitle>{m.accessrequests_disabled_title()}</AlertTitle>
          <AlertDescription>
            <p>
              {m.accessrequests_disabled_body()}{" "}
              <Link
                to="/admin/settings/access"
                className="font-medium underline underline-offset-4"
              >
                {m.accessrequests_settings_link()}
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      ) : null}
      <Tabs value={status} onValueChange={(v) => setStatus(v as AccessRequestStatus)}>
        <TabsList aria-label={m.accessrequests_tabs()}>
          {ACCESS_REQUEST_STATUSES.map((s) => (
            <TabsTrigger key={s} value={s}>
              {accessRequestStatusLabel(s)}
            </TabsTrigger>
          ))}
        </TabsList>
        {ACCESS_REQUEST_STATUSES.map((s) => (
          <TabsContent key={s} value={s}>
            <RequestsTable status={s} canManage={canManage} is506b={is506b} />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}

function RequestsTable({
  status,
  canManage,
  is506b,
}: {
  status: AccessRequestStatus;
  canManage: boolean;
  is506b: boolean;
}) {
  const list = useInfiniteQuery(accessRequestsQuery(status));
  // The dialog keeps the request it was opened with: the list is reloaded after every decision
  // (even a refused one), and a request that left this tab meanwhile must not take the dialog —
  // and the explanation in it — away with it.
  const [open, setOpen] = useState<{ request: AccessRequest; mode: RequestDialogMode }>();
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const selected = open ? (items.find((r) => r.id === open.request.id) ?? open.request) : undefined;
  const dialog =
    open && selected ? (
      <RequestDialog
        key={selected.id}
        request={selected}
        mode={open.mode}
        onModeChange={(mode) => setOpen({ request: selected, mode })}
        onClose={() => setOpen(undefined)}
        canManage={canManage}
        requires506bRelationship={is506b}
      />
    ) : null;
  // The dialog sits in the same place whatever the list shows, so a reload that empties the
  // tab does not remount it (and lose the answer it is showing).
  return (
    <div className="space-y-4">
      {list.isPending ? (
        <LoadingState lines={4} label={m.common_loading()} />
      ) : list.isError ? (
        <ErrorAlert error={list.error} />
      ) : items.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">{emptyLabel(status)}</p>
      ) : (
        <RequestsTableRows
          status={status}
          items={items}
          decidable={canManage && status === "pending"}
          hasNextPage={list.hasNextPage}
          isFetchingNextPage={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          onOpen={(request, mode) => setOpen({ request, mode })}
        />
      )}
      {dialog}
    </div>
  );
}

function RequestsTableRows({
  status,
  items,
  decidable,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onOpen,
}: {
  status: AccessRequestStatus;
  items: readonly AccessRequest[];
  decidable: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onOpen: (request: AccessRequest, mode: RequestDialogMode) => void;
}) {
  const lastColumn =
    status === "pending"
      ? m.accessrequests_col_expires()
      : status === "expired"
        ? m.accessrequests_col_expired()
        : m.accessrequests_col_decided();
  // An expired request closed early (the requester joined, or was erased) carries the moment it
  // was closed in `decidedAt`; one that ran out has only its expiry.
  const lastValue = (r: AccessRequest) =>
    status === "pending"
      ? formatDateTime(r.expiresAt)
      : status === "expired"
        ? formatDateTime(r.decidedAt ?? r.expiresAt)
        : r.decidedAt
          ? formatDateTime(r.decidedAt)
          : "—";
  return (
    <>
      <div className="overflow-x-auto">
        <Table aria-label={accessRequestStatusLabel(status)}>
          <TableHeader>
            <TableRow>
              <TableHead>{m.accessrequests_col_name()}</TableHead>
              <TableHead>{m.accessrequests_col_email()}</TableHead>
              <TableHead>{m.accessrequests_col_firm()}</TableHead>
              <TableHead>{m.accessrequests_col_requested()}</TableHead>
              <TableHead>{lastColumn}</TableHead>
              <TableHead>
                <span className="sr-only">{m.common_actions()}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="break-all">{r.email}</TableCell>
                <TableCell>{r.firm ?? "—"}</TableCell>
                <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                <TableCell>{lastValue(r)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={m.accessrequests_review_for({ name: r.name })}
                      onClick={() => onOpen(r, "detail")}
                    >
                      {m.accessrequests_review()}
                    </Button>
                    {decidable ? (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-label={m.accessrequests_deny_for({ name: r.name })}
                          onClick={() => onOpen(r, "deny")}
                        >
                          {m.accessrequests_deny()}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          aria-label={m.accessrequests_approve_for({ name: r.name })}
                          onClick={() => onOpen(r, "approve")}
                        >
                          {m.accessrequests_approve()}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </TableCell>
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
    </>
  );
}
