import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Field,
  fieldAria,
  Input,
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Plus, ShieldOff, Webhook } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import {
  PlanChangeHint,
  PlanFeatureNotice,
  usePlanAllowsFeature,
} from "../../../components/billing/plan-feature-notice.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import {
  EndpointStatusBadge,
  SecretShownOnce,
  TopicPicker,
} from "../../../components/webhooks/common.js";
import { api, call, isPlanEntitlementRefusal } from "../../../lib/api.js";
import { formatDateTime } from "../../../lib/format.js";
import { useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import {
  describeWebhookError,
  endpointLabel,
  WEBHOOKS_KEY,
  webhookEndpointsQuery,
} from "../../../lib/webhooks-queries.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/webhooks/")({ component: WebhooksPage });

/*
 * Outbound webhooks (E3.4, ADR-0052): endpoints this workspace posts signed events to. A kernel
 * screen, because delivery needs `outbound` (kernel-only) and fans out every module's events.
 *
 *  - The URL is stored sealed and never comes back: an endpoint is recognised by its scheme+host
 *    and the last few characters.
 *  - The signing secret is on the wire once (create, rotate). It is pinned here until dismissed.
 *  - Why an endpoint stopped matters: "the receiver answered 410" and "20 deliveries in a row
 *    failed" are fixed in different places, so the badge names the reason.
 */
function WebhooksPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  if (!permissions.includes("webhooks.read")) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.webhooks_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return <WebhooksScreen canManage={permissions.includes("webhooks.manage")} />;
}

function WebhooksScreen({ canManage }: { canManage: boolean }) {
  const list = useQuery(webhookEndpointsQuery);
  const [revealed, setRevealed] = useState<{ title: string; secret: string }>();
  const items = list.data?.items ?? [];
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.webhooks_title()}
        description={m.webhooks_subtitle()}
        actions={canManage ? <CreateEndpointDialog onCreated={setRevealed} /> : null}
      />
      <PlanFeatureNotice feature="webhooks" />
      {revealed ? (
        <SecretShownOnce
          title={revealed.title}
          secret={revealed.secret}
          onDismiss={() => setRevealed(undefined)}
        />
      ) : null}
      {canManage ? null : <p className="text-sm text-muted-foreground">{m.webhooks_read_only()}</p>}
      {list.isPending ? <LoadingState lines={4} label={m.common_loading()} /> : null}
      {list.isError ? <ErrorAlert error={list.error} /> : null}
      {list.data ? (
        items.length === 0 ? (
          <EmptyState
            icon={<Webhook aria-hidden="true" />}
            title={m.webhooks_empty_title()}
            description={m.webhooks_empty_body()}
          />
        ) : (
          <div className="overflow-x-auto">
            <Table aria-label={m.webhooks_endpoints()}>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.webhooks_col_endpoint()}</TableHead>
                  <TableHead>{m.webhooks_col_events()}</TableHead>
                  <TableHead>{m.webhooks_col_status()}</TableHead>
                  <TableHead>{m.webhooks_col_last_success()}</TableHead>
                  <TableHead>{m.webhooks_col_last_failure()}</TableHead>
                  <TableHead>{m.webhooks_col_failures()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((endpoint) => (
                  <TableRow key={endpoint.id}>
                    <TableCell>
                      <Link
                        to="/admin/webhooks/$endpointId"
                        params={{ endpointId: endpoint.id }}
                        className="font-medium break-all underline underline-offset-4"
                      >
                        {endpointLabel(endpoint)}
                      </Link>
                      {endpoint.description ? (
                        <div className="text-xs text-muted-foreground">{endpoint.description}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {m.webhooks_events_count({ count: endpoint.events.length })}
                    </TableCell>
                    <TableCell>
                      <EndpointStatusBadge endpoint={endpoint} />
                    </TableCell>
                    <TableCell>
                      {endpoint.lastSuccessAt === null
                        ? m.webhooks_never()
                        : formatDateTime(endpoint.lastSuccessAt)}
                    </TableCell>
                    <TableCell>
                      {endpoint.lastFailureAt === null
                        ? m.webhooks_never()
                        : formatDateTime(endpoint.lastFailureAt)}
                    </TableCell>
                    <TableCell className="tabular-nums">{endpoint.consecutiveFailures}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )
      ) : null}
    </div>
  );
}

function CreateEndpointDialog({
  onCreated,
}: {
  onCreated: (revealed: { title: string; secret: string }) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [events, setEvents] = useState<readonly string[]>([]);
  const ids = { url: useId(), description: useId() };
  // A-3: existing endpoints keep receiving; a new one needs `webhooks` on the plan.
  const planAllows = usePlanAllowsFeature("webhooks");

  const create = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/webhooks/endpoints", {
          body: {
            url: url.trim(),
            events: [...events],
            ...(description.trim() === "" ? {} : { description: description.trim() }),
          },
        }),
      ),
    onSuccess: (result) => {
      onCreated({
        title: m.webhooks_created_title({ endpoint: endpointLabel(result.endpoint) }),
        secret: result.secret,
      });
      toast.success(m.webhooks_created_ok());
      void queryClient.invalidateQueries({ queryKey: WEBHOOKS_KEY });
      setUrl("");
      setDescription("");
      setEvents([]);
      setOpen(false);
    },
  });

  const canSubmit = url.trim() !== "" && events.length > 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) create.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" disabled={!planAllows}>
          <Plus aria-hidden="true" />
          {m.webhooks_create()}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form
          className="grid gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (canSubmit) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.webhooks_create_title()}</DialogTitle>
            <DialogDescription>{m.webhooks_create_body()}</DialogDescription>
          </DialogHeader>
          {create.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{m.webhooks_create_failed()}</AlertTitle>
              <AlertDescription>
                <p>{describeWebhookError(create.error)}</p>
                {isPlanEntitlementRefusal(create.error) ? <PlanChangeHint /> : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <Field
            id={ids.url}
            label={m.webhooks_field_url()}
            description={m.webhooks_field_url_hint()}
            required
          >
            <Input
              id={ids.url}
              type="url"
              inputMode="url"
              value={url}
              required
              maxLength={2048}
              autoComplete="off"
              onChange={(e) => setUrl(e.target.value)}
              {...fieldAria(ids.url, { description: true })}
            />
          </Field>
          <Field id={ids.description} label={m.webhooks_field_description()}>
            <Input
              id={ids.description}
              value={description}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <TopicPicker value={events} onChange={setEvents} />
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={create.isPending} disabled={!canSubmit}>
              {m.webhooks_create_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
