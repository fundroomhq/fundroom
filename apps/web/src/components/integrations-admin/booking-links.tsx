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
  Input,
  LoadingState,
  Switch,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, CalendarClock } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { api, call } from "../../lib/api.js";
import {
  BOOKING_PROVIDERS,
  type BookingLink,
  type BookingLinkAudience,
  type BookingProvider,
  bookingLinksQuery,
  bookingProviderLabel,
  describeIntegrationError,
  INTEGRATIONS_KEY,
  integrationErrorCode,
  integrationProvidersQuery,
  MAX_BOOKING_LINKS,
} from "../../lib/integrations-queries.js";
import { groupsQuery } from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { ConfirmDialog } from "../access/common.js";
import { GroupPicker } from "../access/group-picker.js";
import { NativeSelect } from "../compliance/common.js";
import { ErrorAlert } from "../error-alert.js";

/*
 * Booking links (E3.6): Cal.com / Calendly scheduling pages shown on the investor portal's
 * "Book time" card, each to everyone or to chosen groups. A link is only a URL — it needs no
 * connection (the connection is what records the meetings) — but it must be `https://` on one
 * of the provider's hosts, which the server checks (422 `booking_link_invalid_url`). At most
 * ten per workspace. Order is `position`; moving a link renumbers the list 0..n-1.
 */

type Group = { id: string; name: string };

export function BookingLinksCard({
  canManage,
  canReadGroups,
}: {
  canManage: boolean;
  canReadGroups: boolean;
}) {
  const links = useQuery(bookingLinksQuery);
  const groups = useQuery({ ...groupsQuery, enabled: canReadGroups });
  const [adding, setAdding] = useState(false);
  const list = [...(links.data?.links ?? [])].sort((a, b) => a.position - b.position);
  const groupList: readonly Group[] = groups.data?.groups ?? [];
  const full = list.length >= MAX_BOOKING_LINKS;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.booking_links_title()}</h2>
        </CardTitle>
        <CardDescription>{m.booking_links_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {links.isPending ? <LoadingState lines={2} label={m.common_loading()} /> : null}
        {links.isError ? <ErrorAlert error={links.error} /> : null}
        {links.data && list.length === 0 && !adding ? (
          <EmptyState
            icon={<CalendarClock aria-hidden="true" />}
            title={m.booking_links_empty_title()}
            description={m.booking_links_empty_body()}
          />
        ) : null}
        {list.length === 0 ? null : (
          <ol className="space-y-3" aria-label={m.booking_links_list_label()}>
            {list.map((link, index) => (
              <li key={link.id}>
                <BookingLinkRow
                  link={link}
                  list={list}
                  index={index}
                  groups={groupList}
                  canManage={canManage}
                />
              </li>
            ))}
          </ol>
        )}
        {canManage ? (
          adding ? (
            <BookingLinkForm
              existing={undefined}
              nextPosition={list.length}
              groups={groupList}
              onDone={() => setAdding(false)}
            />
          ) : (
            <div className="space-y-1">
              <Button type="button" disabled={full || !links.data} onClick={() => setAdding(true)}>
                {m.booking_links_add()}
              </Button>
              {full ? (
                <p className="text-sm text-muted-foreground">
                  {m.booking_error_limit({ max: MAX_BOOKING_LINKS })}
                </p>
              ) : null}
            </div>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

export function audienceText(audience: BookingLinkAudience, groups: readonly Group[]): string {
  if (audience.kind === "all") return m.booking_audience_all();
  const names = audience.groupIds.map((id) => groups.find((g) => g.id === id)?.name);
  if (names.every((n): n is string => n !== undefined)) {
    return m.booking_audience_groups({ groups: names.join(", ") });
  }
  return m.booking_audience_group_count({ count: audience.groupIds.length });
}

function BookingLinkRow({
  link,
  list,
  index,
  groups,
  canManage,
}: {
  link: BookingLink;
  list: readonly BookingLink[];
  index: number;
  groups: readonly Group[];
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const switchId = useId();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
  const patch = useGuardedMutation({
    mutationFn: (body: { enabled: boolean }) =>
      call(
        api().PATCH("/integrations/booking-links/{id}", {
          params: { path: { id: link.id } },
          body,
        }),
      ),
    onSuccess: () => void invalidate(),
    onError: (error) => toast.error(describeIntegrationError(error)),
  });
  const move = useGuardedMutation({
    mutationFn: async (to: number) => {
      const order = list.filter((l) => l.id !== link.id);
      order.splice(to, 0, link);
      // Renumber everything whose position changes, so positions stay 0..n-1.
      for (const [position, l] of order.entries()) {
        if (l.position === position) continue;
        await call(
          api().PATCH("/integrations/booking-links/{id}", {
            params: { path: { id: l.id } },
            body: { position },
          }),
        );
      }
    },
    onSettled: () => void invalidate(),
    onError: (error) => toast.error(describeIntegrationError(error)),
  });
  const remove = useGuardedMutation({
    mutationFn: () =>
      call(api().DELETE("/integrations/booking-links/{id}", { params: { path: { id: link.id } } })),
    onSuccess: () => {
      toast.success(m.booking_links_deleted_ok({ label: link.label }));
      void invalidate();
    },
    onError: (error) => toast.error(describeIntegrationError(error)),
  });
  if (editing) {
    return (
      <BookingLinkForm
        existing={link}
        nextPosition={link.position}
        groups={groups}
        onDone={() => setEditing(false)}
      />
    );
  }
  return (
    <div className="space-y-2 rounded-md border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-medium">{link.label}</h3>
        <Badge variant="outline">{bookingProviderLabel(link.provider)}</Badge>
        {link.enabled ? null : <Badge variant="secondary">{m.booking_links_disabled()}</Badge>}
      </div>
      <p className="font-mono text-xs break-all text-muted-foreground">{link.url}</p>
      {link.description === null ? null : <p className="text-sm">{link.description}</p>}
      <p className="text-sm text-muted-foreground">
        {m.booking_links_audience_label()} {audienceText(link.audience, groups)}
      </p>
      {canManage ? (
        <div className="flex flex-wrap items-center gap-2">
          <div className="mr-2 flex items-center gap-2">
            <Switch
              id={switchId}
              checked={link.enabled}
              disabled={patch.isPending}
              onCheckedChange={(enabled) => patch.mutate({ enabled })}
            />
            <label htmlFor={switchId} className="text-sm">
              {m.booking_links_enabled()}
            </label>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={index === 0 || move.isPending}
            onClick={() => move.mutate(index - 1)}
            aria-label={m.booking_links_move_up({ label: link.label })}
          >
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={index === list.length - 1 || move.isPending}
            onClick={() => move.mutate(index + 1)}
            aria-label={m.booking_links_move_down({ label: link.label })}
          >
            <ArrowDown aria-hidden="true" />
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            {m.booking_links_edit()}
          </Button>
          <ConfirmDialog
            trigger={
              <Button type="button" variant="outline" size="sm">
                {m.booking_links_delete()}
              </Button>
            }
            title={m.booking_links_delete_title({ label: link.label })}
            description={m.booking_links_delete_body()}
            confirmLabel={m.booking_links_delete()}
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        </div>
      ) : null}
    </div>
  );
}

function BookingLinkForm({
  existing,
  nextPosition,
  groups,
  onDone,
}: {
  existing: BookingLink | undefined;
  nextPosition: number;
  groups: readonly Group[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const providers = useQuery(integrationProvidersQuery);
  const base = useId();
  const [provider, setProvider] = useState<BookingProvider>(existing?.provider ?? "calcom");
  const [label, setLabel] = useState(existing?.label ?? "");
  const [url, setUrl] = useState(existing?.url ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [audienceKind, setAudienceKind] = useState<"all" | "groups">(
    existing?.audience.kind ?? "all",
  );
  const [groupIds, setGroupIds] = useState<string[]>(
    existing?.audience.kind === "groups" ? [...existing.audience.groupIds] : [],
  );
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const hosts =
    providers.data?.providers.find((p) => p.provider === provider)?.bookingLinkHosts ?? [];
  const audience: BookingLinkAudience =
    audienceKind === "all" ? { kind: "all" } : { kind: "groups", groupIds };
  const save = useGuardedMutation({
    mutationFn: () => {
      const common = {
        url: url.trim(),
        label: label.trim(),
        description: description.trim() === "" ? null : description.trim(),
        audience,
        enabled,
      };
      return existing === undefined
        ? call(
            api().POST("/integrations/booking-links", {
              body: { provider, position: nextPosition, ...common },
            }),
          )
        : call(
            api().PATCH("/integrations/booking-links/{id}", {
              params: { path: { id: existing.id } },
              body: common,
            }),
          );
    },
    onSuccess: () => {
      toast.success(m.booking_links_saved_ok());
      void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
      onDone();
    },
  });
  const notHttps = url.trim() !== "" && !url.trim().toLowerCase().startsWith("https://");
  const invalid =
    label.trim() === "" ||
    url.trim() === "" ||
    notHttps ||
    (audienceKind === "groups" && groupIds.length === 0);
  const ids = {
    provider: `${base}-provider`,
    label: `${base}-label`,
    url: `${base}-url`,
    description: `${base}-description`,
    enabled: `${base}-enabled`,
  };
  return (
    <form
      className="space-y-4 rounded-md border p-4"
      aria-label={existing === undefined ? m.booking_links_add() : m.booking_links_edit_label()}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!invalid) save.mutate();
      }}
    >
      {existing === undefined ? (
        <Field id={ids.provider} label={m.booking_links_field_provider()}>
          <NativeSelect
            id={ids.provider}
            value={provider}
            onChange={(e) => setProvider(e.target.value as BookingProvider)}
          >
            {BOOKING_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {bookingProviderLabel(p)}
              </option>
            ))}
          </NativeSelect>
        </Field>
      ) : null}
      <Field id={ids.label} label={m.booking_links_field_label()} required>
        <Input
          id={ids.label}
          required
          maxLength={80}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
      <Field
        id={ids.url}
        label={m.booking_links_field_url()}
        description={
          hosts.length === 0
            ? undefined
            : m.booking_links_field_url_hint({ hosts: hosts.join(", ") })
        }
        error={notHttps ? m.booking_links_field_url_https() : undefined}
        required
      >
        <Input
          id={ids.url}
          type="url"
          inputMode="url"
          required
          maxLength={500}
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          {...fieldAria(ids.url, { description: hosts.length > 0, error: notHttps })}
        />
      </Field>
      <Field id={ids.description} label={m.booking_links_field_description()}>
        <Textarea
          id={ids.description}
          rows={2}
          maxLength={300}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{m.booking_links_field_audience()}</legend>
        <div className="flex items-center gap-2">
          <input
            id={`${base}-audience-all`}
            type="radio"
            name={`${base}-audience`}
            checked={audienceKind === "all"}
            onChange={() => setAudienceKind("all")}
          />
          <label htmlFor={`${base}-audience-all`} className="text-sm">
            {m.booking_audience_all()}
          </label>
        </div>
        <div className="flex items-center gap-2">
          <input
            id={`${base}-audience-groups`}
            type="radio"
            name={`${base}-audience`}
            checked={audienceKind === "groups"}
            onChange={() => setAudienceKind("groups")}
          />
          <label htmlFor={`${base}-audience-groups`} className="text-sm">
            {m.booking_links_audience_groups_option()}
          </label>
        </div>
      </fieldset>
      {audienceKind === "groups" ? (
        groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.booking_links_no_groups()}</p>
        ) : (
          <GroupPicker
            groups={groups}
            value={groupIds}
            onChange={setGroupIds}
            legend={m.booking_links_field_groups()}
            idPrefix={`${base}-group`}
          />
        )
      ) : null}
      <div className="flex items-center gap-2">
        <input
          id={ids.enabled}
          type="checkbox"
          className="size-4"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        <label htmlFor={ids.enabled} className="text-sm">
          {m.booking_links_field_enabled()}
        </label>
      </div>
      {save.isError ? (
        integrationErrorCode(save.error)?.startsWith("booking_link_") === true ? (
          <p role="alert" className="text-sm text-destructive">
            {describeIntegrationError(save.error)}
          </p>
        ) : (
          <ErrorAlert error={save.error} />
        )
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={save.isPending} disabled={invalid}>
          {m.booking_links_save()}
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          {m.common_cancel()}
        </Button>
      </div>
    </form>
  );
}
