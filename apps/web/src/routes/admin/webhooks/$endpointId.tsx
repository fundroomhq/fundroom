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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  fieldAria,
  Input,
  Label,
  LoadingState,
  PageHeader,
  Switch,
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
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import {
  PlanChangeHint,
  PlanFeatureNotice,
  usePlanAllowsFeature,
  usePlanRemovalWarning,
} from "../../../components/billing/plan-feature-notice.js";
import { NativeSelect } from "../../../components/compliance/common.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { TypedConfirmDialog } from "../../../components/typed-confirm-dialog.js";
import {
  EndpointStatusBadge,
  SecretShownOnce,
  TopicPicker,
} from "../../../components/webhooks/common.js";
import { api, call, isPlanEntitlementRefusal } from "../../../lib/api.js";
import { API_KEY_GRACE_HOURS, graceLabel } from "../../../lib/api-keys-queries.js";
import { formatDateTime } from "../../../lib/format.js";
import { useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import {
  DELIVERY_TABS,
  type DeliveryTab,
  deliveryStatusLabel,
  deliveryStatusVariant,
  deliveryTabLabel,
  describeWebhookError,
  endpointLabel,
  WEBHOOKS_KEY,
  type WebhookDelivery,
  type WebhookEndpoint,
  webhookDeliveriesQuery,
  webhookDeliveryQuery,
  webhookEndpointQuery,
} from "../../../lib/webhooks-queries.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/webhooks/$endpointId")({ component: EndpointPage });

/** The same windows API-key rotation offers; the server allows 0..168 hours for both. */
const SECRET_GRACE_DEFAULT = 24;

/*
 * One webhook endpoint (E3.4): its settings, its signing secret, and what was sent to it.
 *
 *  - Changing the URL is as sensitive as adding an endpoint, so it needs a fresh session and is a
 *    form of its own: a step-up round trip reloads the page, and it should not take unsaved
 *    topic edits with it.
 *  - The deliveries list is the dead-letter queue as well as the log: `failed` means retries are
 *    exhausted, and Redeliver queues a new delivery (a new `webhook-id`) with the same payload.
 */
function EndpointPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  if (!permissions.includes("webhooks.read")) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.webhooks_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return <EndpointScreen canManage={permissions.includes("webhooks.manage")} />;
}

function EndpointScreen({ canManage }: { canManage: boolean }) {
  const { endpointId } = Route.useParams();
  const endpoint = useQuery(webhookEndpointQuery(endpointId));
  const [revealed, setRevealed] = useState<string>();
  if (endpoint.isPending) return <LoadingState label={m.common_loading()} />;
  if (endpoint.isError) return <ErrorAlert error={endpoint.error} />;
  const e = endpoint.data;
  return (
    <div className="space-y-6">
      <Button asChild variant="ghost" size="sm">
        <Link to="/admin/webhooks">
          <ArrowLeft aria-hidden="true" />
          {m.webhooks_back()}
        </Link>
      </Button>
      <PageHeader
        title={<span className="break-all">{endpointLabel(e)}</span>}
        description={e.description ?? undefined}
        actions={<EndpointStatusBadge endpoint={e} />}
      />
      {revealed ? (
        <SecretShownOnce
          title={m.webhooks_rotated_title()}
          secret={revealed}
          onDismiss={() => setRevealed(undefined)}
        />
      ) : null}
      <OverviewCard endpoint={e} canManage={canManage} onRotated={setRevealed} />
      <PlanFeatureNotice feature="webhooks" />
      {canManage ? <SettingsCard key={e.updatedAt} endpoint={e} /> : null}
      <DeliveriesCard endpoint={e} canManage={canManage} />
    </div>
  );
}

function useInvalidateWebhooks() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: WEBHOOKS_KEY });
}

function OverviewCard({
  endpoint,
  canManage,
  onRotated,
}: {
  endpoint: WebhookEndpoint;
  canManage: boolean;
  onRotated: (secret: string) => void;
}) {
  const invalidate = useInvalidateWebhooks();
  const navigate = useNavigate();
  const switchId = useId();
  // A-3: switching off never needs `webhooks` on the plan, nor does switching back on an
  // endpoint the system paused (`failing` / `gone`); one an admin switched off (`manual`) does.
  const planAllows = usePlanAllowsFeature("webhooks");
  const warnRemoval = usePlanRemovalWarning("webhooks");
  const canEnable =
    planAllows || endpoint.disabledReason === "failing" || endpoint.disabledReason === "gone";
  const setEnabled = useGuardedMutation<unknown, boolean>({
    mutationFn: (enabled) =>
      call(
        api().PATCH("/webhooks/endpoints/{id}", {
          params: { path: { id: endpoint.id } },
          body: { enabled },
        }),
      ),
    onSuccess: (_data, enabled) => {
      toast.success(enabled ? m.webhooks_enabled_ok() : m.webhooks_disabled_ok());
      invalidate();
    },
    onError: (error) => toast.error(describeWebhookError(error)),
  });
  const test = useGuardedMutation({
    mutationFn: () =>
      call(api().POST("/webhooks/endpoints/{id}/test", { params: { path: { id: endpoint.id } } })),
    onSuccess: () => {
      toast.success(m.webhooks_test_queued());
      invalidate();
    },
    onError: (error) => toast.error(describeWebhookError(error)),
  });
  const remove = useGuardedMutation({
    mutationFn: () =>
      call(api().DELETE("/webhooks/endpoints/{id}", { params: { path: { id: endpoint.id } } })),
    onSuccess: () => {
      toast.success(m.webhooks_deleted_ok());
      invalidate();
      void navigate({ to: "/admin/webhooks" });
    },
    onError: (error) => toast.error(describeWebhookError(error)),
  });
  const stats = endpoint.stats?.last24h;
  const host = hostOf(endpoint.urlHost);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.webhooks_overview()}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!endpoint.enabled && endpoint.disabledReason !== "manual" ? (
          <Alert variant="warning">
            <AlertTitle>{m.webhooks_auto_disabled_title()}</AlertTitle>
            <AlertDescription>
              {endpoint.disabledReason === "gone"
                ? m.webhooks_auto_disabled_gone()
                : m.webhooks_auto_disabled_failing()}
            </AlertDescription>
          </Alert>
        ) : null}
        <dl className="grid gap-2 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-6">
          <dt className="text-muted-foreground">{m.webhooks_col_events()}</dt>
          <dd>
            <ul className="flex flex-wrap gap-1">
              {endpoint.events.map((topic) => (
                <li key={topic}>
                  <code className="rounded bg-muted px-1 font-mono text-xs">{topic}</code>
                </li>
              ))}
            </ul>
          </dd>
          <dt className="text-muted-foreground">{m.webhooks_col_last_success()}</dt>
          <dd>
            {endpoint.lastSuccessAt === null
              ? m.webhooks_never()
              : formatDateTime(endpoint.lastSuccessAt)}
          </dd>
          <dt className="text-muted-foreground">{m.webhooks_col_last_failure()}</dt>
          <dd>
            {endpoint.lastFailureAt === null
              ? m.webhooks_never()
              : formatDateTime(endpoint.lastFailureAt)}
          </dd>
          <dt className="text-muted-foreground">{m.webhooks_col_failures()}</dt>
          <dd className="tabular-nums">{endpoint.consecutiveFailures}</dd>
          {stats ? (
            <>
              <dt className="text-muted-foreground">{m.webhooks_last24h()}</dt>
              <dd>
                {m.webhooks_last24h_counts({
                  succeeded: String(stats.succeeded),
                  failed: String(stats.failed),
                  pending: String(stats.pending + stats.sending),
                })}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">{m.webhooks_secret()}</dt>
          <dd>
            {endpoint.secretRotating ? m.webhooks_secret_rotating() : m.webhooks_secret_one()}
          </dd>
        </dl>
        {canManage ? (
          <div className="flex flex-wrap items-center gap-4 border-t pt-4">
            <div className="flex items-center gap-2">
              <Switch
                id={switchId}
                checked={endpoint.enabled}
                disabled={setEnabled.isPending || (!endpoint.enabled && !canEnable)}
                onCheckedChange={(on) => setEnabled.mutate(on)}
              />
              <Label htmlFor={switchId}>{m.webhooks_enabled_switch()}</Label>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              loading={test.isPending}
              disabled={!endpoint.enabled}
              onClick={() => test.mutate()}
            >
              {m.webhooks_test()}
            </Button>
            <RotateSecretDialog endpoint={endpoint} onRotated={onRotated} />
            <TypedConfirmDialog
              trigger={
                <Button type="button" variant="destructive" size="sm" disabled={remove.isPending}>
                  {m.webhooks_delete()}
                </Button>
              }
              title={m.webhooks_delete_title()}
              description={warnRemoval(m.webhooks_delete_body())}
              phrase={host}
              confirmLabel={m.webhooks_delete()}
              pending={remove.isPending}
              onConfirm={() => remove.mutate()}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** `https://hooks.example.com` → `hooks.example.com`: what the delete confirmation asks for. */
function hostOf(urlHost: string): string {
  try {
    return new URL(urlHost).host;
  } catch {
    return urlHost;
  }
}

function RotateSecretDialog({
  endpoint,
  onRotated,
}: {
  endpoint: WebhookEndpoint;
  onRotated: (secret: string) => void;
}) {
  const invalidate = useInvalidateWebhooks();
  const [open, setOpen] = useState(false);
  const [grace, setGrace] = useState(SECRET_GRACE_DEFAULT);
  const graceId = useId();
  const rotate = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/webhooks/endpoints/{id}/rotate-secret", {
          params: { path: { id: endpoint.id } },
          body: { graceHours: grace },
        }),
      ),
    onSuccess: (result) => {
      onRotated(result.secret);
      toast.success(m.webhooks_rotated_ok());
      invalidate();
      setOpen(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) rotate.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {m.webhooks_rotate()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            rotate.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.webhooks_rotate_title()}</DialogTitle>
            <DialogDescription>{m.webhooks_rotate_body()}</DialogDescription>
          </DialogHeader>
          {rotate.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{m.webhooks_rotate_failed()}</AlertTitle>
              <AlertDescription>{describeWebhookError(rotate.error)}</AlertDescription>
            </Alert>
          ) : null}
          <Field id={graceId} label={m.webhooks_grace()} description={m.webhooks_grace_hint()}>
            <NativeSelect
              id={graceId}
              value={String(grace)}
              onChange={(e) => setGrace(Number(e.target.value))}
              {...fieldAria(graceId, { description: true })}
            >
              {API_KEY_GRACE_HOURS.map((h) => (
                <option key={h} value={String(h)}>
                  {graceLabel(h)}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={rotate.isPending}>
              {m.webhooks_rotate_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Description and topics; the URL has its own dialog (it needs a fresh session). */
function SettingsCard({ endpoint }: { endpoint: WebhookEndpoint }) {
  const invalidate = useInvalidateWebhooks();
  const [description, setDescription] = useState(endpoint.description ?? "");
  const [events, setEvents] = useState<readonly string[]>(endpoint.events);
  const descriptionId = useId();
  // A-3: without `webhooks` on the plan the description can change and topics can be dropped;
  // none can be added (the URL has its own dialog, off on such a plan).
  const planAllows = usePlanAllowsFeature("webhooks");
  const save = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PATCH("/webhooks/endpoints/{id}", {
          params: { path: { id: endpoint.id } },
          body: {
            description: description.trim() === "" ? null : description.trim(),
            events: [...events],
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.webhooks_saved_ok());
      invalidate();
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.webhooks_settings()}</CardTitle>
        <CardDescription>{m.webhooks_settings_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{m.webhooks_field_url()}</span>
          <code className="break-all font-mono text-xs">{endpointLabel(endpoint)}</code>
          <ChangeUrlDialog endpoint={endpoint} />
        </div>
        <form
          className="space-y-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (events.length > 0) save.mutate();
          }}
        >
          {save.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{m.webhooks_save_failed()}</AlertTitle>
              <AlertDescription>
                <p>{describeWebhookError(save.error)}</p>
                {isPlanEntitlementRefusal(save.error) ? <PlanChangeHint /> : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <Field id={descriptionId} label={m.webhooks_field_description()}>
            <Input
              id={descriptionId}
              value={description}
              maxLength={200}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <TopicPicker
            value={events}
            onChange={setEvents}
            addable={planAllows ? undefined : endpoint.events}
          />
          <Button type="submit" loading={save.isPending} disabled={events.length === 0}>
            {m.common_save()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ChangeUrlDialog({ endpoint }: { endpoint: WebhookEndpoint }) {
  const invalidate = useInvalidateWebhooks();
  const planAllows = usePlanAllowsFeature("webhooks");
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const urlId = useId();
  const change = useGuardedMutation({
    mutationFn: () =>
      call(
        api().PATCH("/webhooks/endpoints/{id}", {
          params: { path: { id: endpoint.id } },
          body: { url: url.trim() },
        }),
      ),
    onSuccess: () => {
      toast.success(m.webhooks_url_changed_ok());
      invalidate();
      setUrl("");
      setOpen(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) change.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={!planAllows}>
          {m.webhooks_change_url()}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (url.trim() !== "") change.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>{m.webhooks_change_url_title()}</DialogTitle>
            <DialogDescription>{m.webhooks_change_url_body()}</DialogDescription>
          </DialogHeader>
          {change.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{m.webhooks_save_failed()}</AlertTitle>
              <AlertDescription>
                <p>{describeWebhookError(change.error)}</p>
                {isPlanEntitlementRefusal(change.error) ? <PlanChangeHint /> : null}
              </AlertDescription>
            </Alert>
          ) : null}
          <Field
            id={urlId}
            label={m.webhooks_field_url()}
            description={m.webhooks_field_url_hint()}
            required
          >
            <Input
              id={urlId}
              type="url"
              inputMode="url"
              value={url}
              required
              maxLength={2048}
              autoComplete="off"
              onChange={(e) => setUrl(e.target.value)}
              {...fieldAria(urlId, { description: true })}
            />
          </Field>
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_cancel()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={change.isPending} disabled={url.trim() === ""}>
              {m.webhooks_change_url_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DeliveriesCard({
  endpoint,
  canManage,
}: {
  endpoint: WebhookEndpoint;
  canManage: boolean;
}) {
  const [tab, setTab] = useState<DeliveryTab>("all");
  const [topic, setTopic] = useState("");
  const topicId = useId();
  const topics = [...endpoint.events, "webhook.ping"];
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.webhooks_deliveries()}</CardTitle>
        <CardDescription>{m.webhooks_deliveries_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="max-w-xs">
          <Field id={topicId} label={m.webhooks_filter_topic()}>
            <NativeSelect id={topicId} value={topic} onChange={(e) => setTopic(e.target.value)}>
              <option value="">{m.webhooks_filter_all_topics()}</option>
              {topics.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>
        <Tabs value={tab} onValueChange={(v) => setTab(v as DeliveryTab)}>
          <TabsList aria-label={m.webhooks_deliveries_tabs()}>
            {DELIVERY_TABS.map((t) => (
              <TabsTrigger key={t} value={t}>
                {deliveryTabLabel(t)}
              </TabsTrigger>
            ))}
          </TabsList>
          {DELIVERY_TABS.map((t) => (
            <TabsContent key={t} value={t}>
              <DeliveriesTable
                endpoint={endpoint}
                tab={t}
                topic={topic === "" ? undefined : topic}
                canManage={canManage}
              />
            </TabsContent>
          ))}
        </Tabs>
      </CardContent>
    </Card>
  );
}

function DeliveriesTable({
  endpoint,
  tab,
  topic,
  canManage,
}: {
  endpoint: WebhookEndpoint;
  tab: DeliveryTab;
  topic: string | undefined;
  canManage: boolean;
}) {
  const list = useInfiniteQuery(webhookDeliveriesQuery(endpoint.id, tab, topic));
  const [openId, setOpenId] = useState<string>();
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  if (list.isPending) return <LoadingState lines={3} label={m.common_loading()} />;
  if (list.isError) return <ErrorAlert error={list.error} />;
  return (
    <div className="space-y-3">
      {items.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">{m.webhooks_deliveries_empty()}</p>
      ) : (
        <div className="overflow-x-auto">
          <Table aria-label={deliveryTabLabel(tab)}>
            <TableHeader>
              <TableRow>
                <TableHead>{m.webhooks_col_delivery_status()}</TableHead>
                <TableHead>{m.webhooks_col_topic()}</TableHead>
                <TableHead>{m.webhooks_col_created()}</TableHead>
                <TableHead>{m.webhooks_col_attempts()}</TableHead>
                <TableHead>{m.webhooks_col_response()}</TableHead>
                <TableHead>{m.webhooks_col_next_attempt()}</TableHead>
                <TableHead>
                  <span className="sr-only">{m.common_actions()}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>
                    <Badge variant={deliveryStatusVariant(d.status)}>
                      {deliveryStatusLabel(d.status)}
                    </Badge>
                    {d.manual ? (
                      <div className="mt-1 text-xs text-muted-foreground">
                        {m.webhooks_manual()}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <code className="font-mono text-xs">{d.topic}</code>
                  </TableCell>
                  <TableCell>{formatDateTime(d.createdAt)}</TableCell>
                  <TableCell className="tabular-nums">{d.attempts}</TableCell>
                  <TableCell className="tabular-nums">
                    {d.lastStatusCode === null ? "—" : d.lastStatusCode}
                  </TableCell>
                  <TableCell>
                    {d.nextAttemptAt === null ? "—" : formatDateTime(d.nextAttemptAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={m.webhooks_details_for({
                        topic: d.topic,
                        when: formatDateTime(d.createdAt),
                      })}
                      onClick={() => setOpenId(d.id)}
                    >
                      {m.webhooks_details()}
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
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
      {openId === undefined ? null : (
        <DeliveryDialog
          deliveryId={openId}
          canRedeliver={canManage && endpoint.enabled}
          onClose={() => setOpenId(undefined)}
        />
      )}
    </div>
  );
}

function DeliveryDialog({
  deliveryId,
  canRedeliver,
  onClose,
}: {
  deliveryId: string;
  canRedeliver: boolean;
  onClose: () => void;
}) {
  const detail = useQuery(webhookDeliveryQuery(deliveryId));
  const invalidate = useInvalidateWebhooks();
  const redeliver = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/webhooks/deliveries/{id}/redeliver", {
          params: { path: { id: deliveryId } },
        }),
      ),
    onSuccess: () => {
      toast.success(m.webhooks_redelivered_ok());
      invalidate();
    },
  });
  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{m.webhooks_delivery_title()}</DialogTitle>
          <DialogDescription>{m.webhooks_delivery_body()}</DialogDescription>
        </DialogHeader>
        {detail.isPending ? <LoadingState lines={4} label={m.common_loading()} /> : null}
        {detail.isError ? <ErrorAlert error={detail.error} /> : null}
        {detail.data ? <DeliveryFacts delivery={detail.data} /> : null}
        {detail.data ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">{m.webhooks_payload()}</p>
            <pre className="max-h-64 overflow-auto rounded border bg-muted p-2 font-mono text-xs">
              {JSON.stringify(detail.data.payload, null, 2)}
            </pre>
          </div>
        ) : null}
        {detail.data?.lastResponseExcerpt ? (
          <div className="space-y-1">
            <p className="text-sm font-medium">{m.webhooks_response_excerpt()}</p>
            <pre className="max-h-40 overflow-auto rounded border bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
              {detail.data.lastResponseExcerpt}
            </pre>
          </div>
        ) : null}
        {redeliver.isError ? (
          <Alert variant="destructive" role="alert">
            <AlertTitle>{m.webhooks_redeliver_failed()}</AlertTitle>
            <AlertDescription>{describeWebhookError(redeliver.error)}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {m.common_close()}
            </Button>
          </DialogClose>
          {canRedeliver && detail.data ? (
            <Button type="button" loading={redeliver.isPending} onClick={() => redeliver.mutate()}>
              {m.webhooks_redeliver()}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeliveryFacts({ delivery }: { delivery: WebhookDelivery }) {
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-6">
      <dt className="text-muted-foreground">{m.webhooks_col_delivery_status()}</dt>
      <dd>
        <Badge variant={deliveryStatusVariant(delivery.status)}>
          {deliveryStatusLabel(delivery.status)}
        </Badge>
      </dd>
      <dt className="text-muted-foreground">{m.webhooks_col_topic()}</dt>
      <dd>
        <code className="font-mono text-xs">{delivery.topic}</code>
      </dd>
      <dt className="text-muted-foreground">{m.webhooks_delivery_id()}</dt>
      <dd>
        <code className="font-mono text-xs break-all">{delivery.id}</code>
      </dd>
      <dt className="text-muted-foreground">{m.webhooks_col_attempts()}</dt>
      <dd className="tabular-nums">{delivery.attempts}</dd>
      <dt className="text-muted-foreground">{m.webhooks_col_response()}</dt>
      <dd className="tabular-nums">
        {delivery.lastStatusCode === null ? "—" : delivery.lastStatusCode}
      </dd>
      <dt className="text-muted-foreground">{m.webhooks_duration()}</dt>
      <dd className="tabular-nums">
        {delivery.lastDurationMs === null
          ? "—"
          : m.webhooks_duration_ms({ ms: String(delivery.lastDurationMs) })}
      </dd>
      <dt className="text-muted-foreground">{m.webhooks_col_next_attempt()}</dt>
      <dd>{delivery.nextAttemptAt === null ? "—" : formatDateTime(delivery.nextAttemptAt)}</dd>
      <dt className="text-muted-foreground">{m.webhooks_delivered_at()}</dt>
      <dd>{delivery.deliveredAt === null ? "—" : formatDateTime(delivery.deliveredAt)}</dd>
      <dt className="text-muted-foreground">{m.webhooks_last_error()}</dt>
      <dd className="break-words">{delivery.lastError ?? "—"}</dd>
    </dl>
  );
}
