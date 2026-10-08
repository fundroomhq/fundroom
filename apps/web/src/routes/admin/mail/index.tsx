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
import { createFileRoute } from "@tanstack/react-router";
import { ShieldOff } from "lucide-react";
import { ConfirmDialog } from "../../../components/access/common.js";
import { CopyButton } from "../../../components/copy-button.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call } from "../../../lib/api.js";
import { formatDateTime } from "../../../lib/format.js";
import {
  MAIL_KEY,
  type MailStatus,
  type MailSuppression,
  mailStatusQuery,
  mailSuppressionsQuery,
} from "../../../lib/mail-queries.js";
import { useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/mail/")({ component: MailPage });

/*
 * Mail delivery (E2.6). A kernel screen, because the facts are kernel facts: the mail driver is
 * server configuration, the webhook ingress is an ops route, and the suppression list is
 * `core.mail_suppression`. Every route here is `access.settings` (owner/admin); removing a
 * suppression also needs a fresh session, which `useGuardedMutation` turns into a step-up and
 * back.
 *
 * What the admin needs from it:
 *
 *  - **Where to point the provider.** The webhook URL is the same for every workspace (events
 *    are routed back by message id), and each provider wants it pasted somewhere different, so
 *    the hint is per driver.
 *  - **Who we stopped writing to, and why.** Hard bounces and spam complaints suppress update and
 *    notification mail (never sign-in mail). Addresses are masked because the server does not
 *    have them: the list is keyed by a keyed hash.
 */
function MailPage() {
  const bootstrap = useBootstrap();
  const allowed = (bootstrap.data?.permissions ?? []).includes("access.settings");
  if (!allowed) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.mail_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return (
    <div className="space-y-6">
      <PageHeader title={m.mail_title()} description={m.mail_subtitle()} />
      <StatusCard />
      <SuppressionsCard />
    </div>
  );
}

function driverName(driver: string): string {
  switch (driver) {
    case "resend":
      return "Resend";
    case "postmark":
      return "Postmark";
    case "ses":
      return "Amazon SES";
    case "smtp":
      return "SMTP";
    default:
      return driver;
  }
}

function setupHint(status: MailStatus): string {
  if (!status.capabilities.webhooks) {
    return status.driver === "smtp" ? m.mail_hint_smtp() : m.mail_hint_no_webhooks();
  }
  switch (status.driver) {
    case "resend":
      return m.mail_hint_resend();
    case "postmark":
      return m.mail_hint_postmark();
    case "ses":
      return m.mail_hint_ses();
    default:
      return m.mail_hint_generic();
  }
}

function StatusCard() {
  const status = useQuery(mailStatusQuery);
  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{m.mail_status_title()}</CardTitle>
        <CardDescription>{m.mail_status_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.isPending ? <LoadingState label={m.common_loading()} /> : null}
        {status.isError ? <ErrorAlert error={status.error} /> : null}
        {status.data ? (
          <>
            <dl className="grid gap-2 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-6">
              <dt className="text-muted-foreground">{m.mail_driver()}</dt>
              <dd className="font-medium">{driverName(status.data.driver)}</dd>
              <dt className="text-muted-foreground">{m.mail_cap_webhooks()}</dt>
              <dd>
                {status.data.capabilities.webhooks ? (
                  <Badge variant="success">{m.mail_cap_yes()}</Badge>
                ) : (
                  <Badge variant="outline">{m.mail_cap_no()}</Badge>
                )}
              </dd>
              <dt className="text-muted-foreground">{m.mail_cap_tracking()}</dt>
              <dd>
                {status.data.capabilities.perMessageTracking ? (
                  <Badge variant="success">{m.mail_cap_per_message()}</Badge>
                ) : (
                  <Badge variant="outline">{m.mail_cap_account_level()}</Badge>
                )}
              </dd>
            </dl>
            {status.data.capabilities.perMessageTracking ? null : (
              <p className="text-sm text-muted-foreground">{m.mail_tracking_account_hint()}</p>
            )}
            {status.data.webhookUrl === null ? null : (
              <div className="space-y-2">
                <p className="text-sm font-medium">{m.mail_webhook_url()}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs">
                    {status.data.webhookUrl}
                  </code>
                  <CopyButton value={status.data.webhookUrl} label={m.mail_webhook_copy()} />
                </div>
              </div>
            )}
            <Alert>
              <AlertTitle>
                {m.mail_setup_title({ provider: driverName(status.data.driver) })}
              </AlertTitle>
              <AlertDescription>{setupHint(status.data)}</AlertDescription>
            </Alert>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function reasonLabel(reason: MailSuppression["reason"]): string {
  switch (reason) {
    case "bounce":
      return m.mail_reason_bounce();
    case "complaint":
      return m.mail_reason_complaint();
    case "manual":
      return m.mail_reason_manual();
    case "provider":
      return m.mail_reason_provider();
  }
}

function SuppressionsCard() {
  const list = useInfiniteQuery(mailSuppressionsQuery());
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.mail_suppressions_title()}</CardTitle>
        <CardDescription>{m.mail_suppressions_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {list.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
        {list.isError ? <ErrorAlert error={list.error} /> : null}
        {list.data ? (
          items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.mail_suppressions_empty()}</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.mail_col_address()}</TableHead>
                    <TableHead>{m.mail_col_reason()}</TableHead>
                    <TableHead>{m.mail_col_since()}</TableHead>
                    <TableHead>{m.common_actions()}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((entry) => (
                    <SuppressionRow key={entry.id} entry={entry} />
                  ))}
                </TableBody>
              </Table>
              {list.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={list.isFetchingNextPage}
                  onClick={() => void list.fetchNextPage()}
                >
                  {m.common_load_more()}
                </Button>
              ) : null}
            </>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

function SuppressionRow({ entry }: { entry: MailSuppression }) {
  const queryClient = useQueryClient();
  const remove = useGuardedMutation({
    mutationFn: () =>
      call(api().DELETE("/mail/suppressions/{id}", { params: { path: { id: entry.id } } })),
    onSuccess: () => {
      toast.success(m.mail_unsuppressed({ address: entry.address }));
      void queryClient.invalidateQueries({ queryKey: [...MAIL_KEY, "suppressions"] });
    },
  });
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{entry.address}</TableCell>
      <TableCell>{reasonLabel(entry.reason)}</TableCell>
      <TableCell>{formatDateTime(entry.createdAt)}</TableCell>
      <TableCell>
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={remove.isPending}
              aria-label={m.mail_unsuppress_named({ address: entry.address })}
            >
              {m.mail_unsuppress()}
            </Button>
          }
          title={m.mail_unsuppress_title({ address: entry.address })}
          description={m.mail_unsuppress_body()}
          confirmLabel={m.mail_unsuppress()}
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
        {remove.isError ? <ErrorAlert error={remove.error} /> : null}
      </TableCell>
    </TableRow>
  );
}
