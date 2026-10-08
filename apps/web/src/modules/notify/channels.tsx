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
  EmptyState,
  Field,
  fieldAria,
  Input,
  LoadingState,
  PageHeader,
  Switch,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, MessageSquare, TriangleAlert } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, call, isApiError } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import {
  NOTIFY_CHANNEL_EVENT_TYPES,
  NOTIFY_CHANNELS_KEY,
  type NotifyChannel,
  type NotifyChannelEventType,
  type NotifyChannelKind,
  type NotifyChannelTestResult,
  notifyChannelsQuery,
  type SlackChannelRef,
  slackChannelsQuery,
} from "../../lib/notify-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { disabledReasonLabel, eventLabel, testFailureLabel } from "./labels.js";

/*
 * Workspace chat channels (E2.6). A channel announces the workspace-level events (hot leads,
 * interest, commitments, verification requests) to a room the whole team reads. It is either a
 * Slack incoming webhook (`slack`) or — E3.6 — a channel of the Slack workspace connected in the
 * Integrations hub (`slack_app`), picked from the app's own channel list rather than pasted.
 * Two things this screen owes the admin:
 *
 *  - **The URL is a credential.** Anyone holding it can post into that room, so it is
 *    write-only: typed once, sent once, and never shown again — the list carries only its last
 *    four characters. Replacing it means pasting a new one; the old value is never pre-filled.
 *  - **The text leaves this product.** Alerts name the investor, and the chat provider keeps its
 *    own copy under its own retention. The create form says so before the admin saves.
 *
 * Creating, deleting and re-pointing a channel need a fresh session; `useGuardedMutation` sends a
 * stale admin through step-up and back here, like every other fresh route.
 */
export function ChannelsScreen() {
  const channels = useQuery(notifyChannelsQuery);
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.notify_channels_title()}
        description={m.notify_channels_subtitle()}
        actions={
          <Button asChild variant="ghost">
            <Link to="/admin/$" params={{ _splat: "notify" }}>
              <ArrowLeft aria-hidden="true" />
              {m.notify_back_to_inbox()}
            </Link>
          </Button>
        }
      />
      {channels.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {channels.isError ? <ErrorAlert error={channels.error} /> : null}
      {channels.data ? (
        channels.data.channels.length === 0 ? (
          <EmptyState
            icon={<MessageSquare />}
            title={m.notify_channels_empty_title()}
            description={m.notify_channels_empty_body()}
          />
        ) : (
          <ul className="space-y-4">
            {channels.data.channels.map((channel) => (
              <li key={channel.id}>
                <ChannelCard channel={channel} />
              </li>
            ))}
          </ul>
        )
      ) : null}
      <CreateChannel />
    </div>
  );
}

/** Where a channel posts: a webhook's last four characters, or the Slack app's channel. */
function channelTarget(channel: NotifyChannel): string {
  if (channel.kind === "slack_app") {
    return m.notify_slack_app_target({
      channel: `#${channel.slackChannelName ?? channel.slackChannelId ?? ""}`,
    });
  }
  return m.notify_channel_url_hint({ hint: `…${channel.urlHint ?? ""}` });
}

function EventTypeChecks({
  legend,
  value,
  onChange,
  idPrefix,
}: {
  legend: string;
  value: readonly NotifyChannelEventType[];
  onChange: (next: NotifyChannelEventType[]) => void;
  idPrefix: string;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      {NOTIFY_CHANNEL_EVENT_TYPES.map((type) => {
        const boxId = `${idPrefix}-${type}`;
        return (
          <div key={type} className="flex items-center gap-2">
            <input
              id={boxId}
              type="checkbox"
              className="size-4"
              checked={value.includes(type)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? NOTIFY_CHANNEL_EVENT_TYPES.filter((t) => t === type || value.includes(t))
                    : value.filter((t) => t !== type),
                )
              }
            />
            <label htmlFor={boxId} className="text-sm">
              {eventLabel(type)}
            </label>
          </div>
        );
      })}
    </fieldset>
  );
}

/** The error the API answers when no Slack workspace is connected in the Integrations hub. */
function isNotConnected(error: unknown): boolean {
  return isApiError(error) && error.code === "integration_not_connected";
}

/**
 * The connected Slack app's channels as a native `<select>` (a Radix select is not operable in
 * jsdom and gains nothing here). When no Slack workspace is connected, the admin is sent to the
 * Integrations hub instead of being shown an empty list.
 */
function SlackChannelPicker({
  id,
  value,
  onChange,
  required,
}: {
  id: string;
  value: string;
  onChange: (channel: SlackChannelRef | undefined) => void;
  required: boolean;
}) {
  const channels = useQuery(slackChannelsQuery);
  if (channels.isPending) return <LoadingState label={m.notify_slack_app_loading()} />;
  if (channels.isError) {
    return isNotConnected(channels.error) ? (
      <Alert variant="warning">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>{m.notify_slack_app_not_connected_title()}</AlertTitle>
        <AlertDescription>
          <p>
            {m.notify_slack_app_not_connected_body()}{" "}
            <Link to="/admin/integrations" className="underline underline-offset-4">
              {m.notify_slack_app_connect_link()}
            </Link>
          </p>
        </AlertDescription>
      </Alert>
    ) : (
      <ErrorAlert error={channels.error} />
    );
  }
  const list = channels.data.channels;
  if (list.length === 0) {
    return <p className="text-sm text-muted-foreground">{m.notify_slack_app_no_channels()}</p>;
  }
  return (
    <Field
      id={id}
      label={m.notify_slack_app_field_channel()}
      description={m.notify_slack_app_field_channel_hint()}
      required={required}
    >
      <NativeSelect
        id={id}
        required={required}
        value={value}
        {...fieldAria(id, { description: true })}
        onChange={(e) => onChange(list.find((c) => c.id === e.target.value))}
      >
        <option value="">{m.notify_slack_app_choose_channel()}</option>
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.isPrivate
              ? m.notify_slack_app_channel_private({ name: c.name })
              : m.notify_slack_app_channel_public({ name: c.name })}
          </option>
        ))}
      </NativeSelect>
    </Field>
  );
}

function KindChoice({
  name,
  value,
  onChange,
}: {
  name: string;
  value: NotifyChannelKind;
  onChange: (kind: NotifyChannelKind) => void;
}) {
  const options: { kind: NotifyChannelKind; label: string; hint: string }[] = [
    {
      kind: "slack",
      label: m.notify_slack_app_kind_webhook(),
      hint: m.notify_slack_app_kind_webhook_hint(),
    },
    {
      kind: "slack_app",
      label: m.notify_slack_app_kind_app(),
      hint: m.notify_slack_app_kind_app_hint(),
    },
  ];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">{m.notify_slack_app_kind_legend()}</legend>
      {options.map((option) => {
        const optionId = `${name}-${option.kind}`;
        return (
          <div key={option.kind} className="flex items-start gap-2">
            <input
              id={optionId}
              type="radio"
              name={name}
              className="mt-0.5 size-4"
              checked={value === option.kind}
              aria-describedby={`${optionId}-hint`}
              onChange={() => onChange(option.kind)}
            />
            <div>
              <label htmlFor={optionId} className="text-sm">
                {option.label}
              </label>
              <p id={`${optionId}-hint`} className="text-xs text-muted-foreground">
                {option.hint}
              </p>
            </div>
          </div>
        );
      })}
    </fieldset>
  );
}

function CreateChannel() {
  const queryClient = useQueryClient();
  const ids = { name: useId(), url: useId(), events: useId(), kind: useId(), channel: useId() };
  const [kind, setKind] = useState<NotifyChannelKind>("slack");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [slackChannelId, setSlackChannelId] = useState("");
  const [eventTypes, setEventTypes] = useState<NotifyChannelEventType[]>([
    ...NOTIFY_CHANNEL_EVENT_TYPES,
  ]);
  const create = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/notify/channels", {
          body:
            kind === "slack_app"
              ? { kind, name: name.trim(), slackChannelId, eventTypes, enabled: true }
              : { name: name.trim(), url: url.trim(), eventTypes, enabled: true },
        }),
      ),
    onSuccess: (channel) => {
      // The URL leaves the page with this request: clear it so nothing on screen still holds it.
      setUrl("");
      setName("");
      setSlackChannelId("");
      setEventTypes([...NOTIFY_CHANNEL_EVENT_TYPES]);
      toast.success(m.notify_channel_created({ name: channel.name }));
      void queryClient.invalidateQueries({ queryKey: NOTIFY_CHANNELS_KEY });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>{m.notify_channel_create_title()}</CardTitle>
        <CardDescription>{m.notify_channel_create_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <KindChoice name={ids.kind} value={kind} onChange={setKind} />
          <Field id={ids.name} label={m.notify_channel_field_name()} required>
            <Input
              id={ids.name}
              required
              maxLength={80}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          {kind === "slack_app" ? (
            <SlackChannelPicker
              id={ids.channel}
              value={slackChannelId}
              required
              onChange={(channel) => {
                setSlackChannelId(channel?.id ?? "");
                // The Slack channel's own name is the obvious label; never overwrite a typed one.
                if (channel !== undefined && name.trim() === "") setName(`#${channel.name}`);
              }}
            />
          ) : (
            <Field
              id={ids.url}
              label={m.notify_channel_field_url()}
              description={m.notify_channel_field_url_hint()}
              required
            >
              <Input
                id={ids.url}
                type="url"
                required
                minLength={12}
                maxLength={500}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://hooks.slack.com/services/…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                {...fieldAria(ids.url, { description: true })}
              />
            </Field>
          )}
          <EventTypeChecks
            legend={m.notify_channel_field_events()}
            value={eventTypes}
            onChange={setEventTypes}
            idPrefix={ids.events}
          />
          <Alert variant="warning">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{m.notify_channel_privacy_title()}</AlertTitle>
            <AlertDescription>{m.notify_channel_privacy_body()}</AlertDescription>
          </Alert>
          {create.isError ? <ErrorAlert error={create.error} /> : null}
          <Button
            type="submit"
            loading={create.isPending}
            disabled={kind === "slack_app" && slackChannelId === ""}
          >
            {m.notify_channel_create_submit()}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function ChannelStatus({ channel }: { channel: NotifyChannel }) {
  if (channel.disabledReason !== null) {
    return <Badge variant="destructive">{m.notify_channel_auto_disabled()}</Badge>;
  }
  return channel.enabled ? (
    <Badge variant="success">{m.notify_channel_enabled()}</Badge>
  ) : (
    <Badge variant="outline">{m.notify_channel_paused()}</Badge>
  );
}

function ChannelCard({ channel }: { channel: NotifyChannel }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [result, setResult] = useState<NotifyChannelTestResult | undefined>(undefined);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: NOTIFY_CHANNELS_KEY });
  const test = useGuardedMutation({
    mutationFn: () =>
      call(api().POST("/notify/channels/{id}/test", { params: { path: { id: channel.id } } })),
    onMutate: () => setResult(undefined),
    onSuccess: (r) => {
      setResult(r);
      refresh();
    },
  });
  const remove = useGuardedMutation({
    mutationFn: () =>
      call(api().DELETE("/notify/channels/{id}", { params: { path: { id: channel.id } } })),
    onSuccess: () => {
      toast.success(m.notify_channel_deleted({ name: channel.name }));
      refresh();
    },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <span>{channel.name}</span>
          <ChannelStatus channel={channel} />
        </CardTitle>
        <CardDescription>{channelTarget(channel)}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {channel.disabledReason !== null ? (
          <Alert variant="destructive">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>{m.notify_channel_auto_disabled_title()}</AlertTitle>
            <AlertDescription>{disabledReasonLabel(channel.disabledReason)}</AlertDescription>
          </Alert>
        ) : null}
        <dl className="grid gap-2 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-6">
          <dt className="text-muted-foreground">{m.notify_channel_events()}</dt>
          <dd>
            {channel.eventTypes.length === 0
              ? m.notify_channel_events_none()
              : channel.eventTypes.map((t) => eventLabel(t)).join(", ")}
          </dd>
          <dt className="text-muted-foreground">{m.notify_channel_last_success()}</dt>
          <dd>
            {channel.lastSuccessAt === null
              ? m.notify_channel_never()
              : formatDateTime(channel.lastSuccessAt)}
          </dd>
          {channel.lastError === null ? null : (
            <>
              <dt className="text-muted-foreground">{m.notify_channel_last_error()}</dt>
              <dd className="break-words">
                {channel.lastError}
                {channel.failureCount > 0
                  ? ` · ${m.notify_channel_failures({ n: String(channel.failureCount) })}`
                  : null}
              </dd>
            </>
          )}
        </dl>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            loading={test.isPending}
            aria-label={m.notify_channel_test_named({ name: channel.name })}
            onClick={() => test.mutate()}
          >
            {m.notify_channel_test()}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-expanded={editing}
            aria-label={m.notify_channel_edit_named({ name: channel.name })}
            onClick={() => setEditing((v) => !v)}
          >
            {m.notify_channel_edit()}
          </Button>
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={remove.isPending}
                aria-label={m.notify_channel_delete_named({ name: channel.name })}
              >
                {m.notify_channel_delete()}
              </Button>
            }
            title={m.notify_channel_delete_title({ name: channel.name })}
            description={m.notify_channel_delete_body()}
            confirmLabel={m.notify_channel_delete()}
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </div>
        <div aria-live="polite">
          {result === undefined ? null : result.ok ? (
            <Alert variant="success">
              <AlertTitle>{m.notify_channel_test_ok_title()}</AlertTitle>
              <AlertDescription>{m.notify_channel_test_ok_body()}</AlertDescription>
            </Alert>
          ) : (
            <Alert variant="destructive">
              <AlertTitle>{m.notify_channel_test_failed_title()}</AlertTitle>
              <AlertDescription>
                {testFailureLabel(result.reason)}
                {result.detail ? ` (${result.detail})` : null}
              </AlertDescription>
            </Alert>
          )}
        </div>
        {test.isError ? <ErrorAlert error={test.error} /> : null}
        {remove.isError ? <ErrorAlert error={remove.error} /> : null}
        {editing ? <EditChannel channel={channel} onDone={() => setEditing(false)} /> : null}
      </CardContent>
    </Card>
  );
}

function sameTypes(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t) => b.includes(t));
}

function EditChannel({ channel, onDone }: { channel: NotifyChannel; onDone: () => void }) {
  const queryClient = useQueryClient();
  const ids = { name: useId(), url: useId(), enabled: useId(), events: useId(), channel: useId() };
  const isApp = channel.kind === "slack_app";
  const [slackChannelId, setSlackChannelId] = useState(channel.slackChannelId ?? "");
  const [name, setName] = useState(channel.name);
  const [enabled, setEnabled] = useState(channel.enabled);
  // Never pre-filled: the stored URL is not readable, and an empty field means "keep it".
  const [url, setUrl] = useState("");
  const [eventTypes, setEventTypes] = useState<NotifyChannelEventType[]>([...channel.eventTypes]);
  const save = useGuardedMutation({
    mutationFn: () => {
      const body: {
        name?: string;
        url?: string;
        slackChannelId?: string;
        eventTypes?: NotifyChannelEventType[];
        enabled?: boolean;
      } = {};
      if (name.trim() !== channel.name) body.name = name.trim();
      if (!isApp && url.trim() !== "") body.url = url.trim();
      if (isApp && slackChannelId !== "" && slackChannelId !== channel.slackChannelId) {
        body.slackChannelId = slackChannelId;
      }
      if (!sameTypes(eventTypes, channel.eventTypes)) body.eventTypes = eventTypes;
      // A channel that switched itself off reads as enabled=false; switching it on re-enables it
      // and clears its failure count.
      if (enabled !== channel.enabled) body.enabled = enabled;
      return call(
        api().PATCH("/notify/channels/{id}", { params: { path: { id: channel.id } }, body }),
      );
    },
    onSuccess: () => {
      setUrl("");
      toast.success(m.notify_channel_saved({ name: name.trim() }));
      void queryClient.invalidateQueries({ queryKey: NOTIFY_CHANNELS_KEY });
      onDone();
    },
  });
  return (
    <form
      className="space-y-4 rounded-md border p-4"
      aria-label={m.notify_channel_edit_named({ name: channel.name })}
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Field id={ids.name} label={m.notify_channel_field_name()} required>
        <Input
          id={ids.name}
          required
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="flex items-center gap-3">
        <Switch id={ids.enabled} checked={enabled} onCheckedChange={setEnabled} />
        <label htmlFor={ids.enabled} className="text-sm">
          {m.notify_channel_field_enabled()}
        </label>
      </div>
      {isApp ? (
        <SlackChannelPicker
          id={ids.channel}
          value={slackChannelId}
          required={false}
          onChange={(c) => setSlackChannelId(c?.id ?? "")}
        />
      ) : (
        <Field
          id={ids.url}
          label={m.notify_channel_field_replace_url()}
          description={m.notify_channel_field_replace_url_hint()}
        >
          <Input
            id={ids.url}
            type="url"
            minLength={12}
            maxLength={500}
            autoComplete="off"
            spellCheck={false}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            {...fieldAria(ids.url, { description: true })}
          />
        </Field>
      )}
      <EventTypeChecks
        legend={m.notify_channel_field_events()}
        value={eventTypes}
        onChange={setEventTypes}
        idPrefix={ids.events}
      />
      {save.isError ? <ErrorAlert error={save.error} /> : null}
      <div className="flex gap-2">
        <Button type="submit" size="sm" loading={save.isPending}>
          {m.common_save()}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {m.common_cancel()}
        </Button>
      </div>
    </form>
  );
}
