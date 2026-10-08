import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  fieldAria,
  LoadingState,
  PageHeader,
  Switch,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, call } from "../../lib/api.js";
import {
  browserTimezone,
  HOURS,
  hourLabel,
  NOTIFY_CADENCES,
  NOTIFY_STAFF_EVENT_TYPES,
  type NotifyCadence,
  type NotifyEventType,
  type NotifyPreferences,
  notifyPreferencesQuery,
  timezoneOptions,
  WEEKDAYS,
} from "../../lib/notify-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { cadenceLabel, eventLabel, weekdayLabel } from "./labels.js";

interface PrefForm {
  cadences: Record<NotifyEventType, NotifyCadence>;
  emailEnabled: boolean;
  timezone: string;
  digestHour: number;
  weeklyDay: number;
  quiet: boolean;
  quietStart: number;
  quietEnd: number;
  /** The timezone was filled in from this browser, not read from the server. */
  zoneDetected: boolean;
}

/**
 * The server stores `UTC` until a member says otherwise, and every preference reports
 * `isDefault` until the form is first saved (a save writes every row). Both together mean this
 * member has never saved the form, so the browser's own zone is the better starting point — a
 * founder in Berlin asked for an 08:00 digest means 08:00 in Berlin. Once anything is saved the
 * stored zone wins, including a deliberate `UTC`.
 */
function toForm(data: NotifyPreferences): PrefForm {
  const cadences = {} as Record<NotifyEventType, NotifyCadence>;
  for (const type of NOTIFY_STAFF_EVENT_TYPES) {
    cadences[type] = data.preferences.find((p) => p.eventType === type)?.cadence ?? "instant";
  }
  const s = data.settings;
  const neverSaved = s.timezone === "UTC" && data.preferences.every((p) => p.isDefault);
  const detected = neverSaved ? browserTimezone() : undefined;
  const zoneDetected = detected !== undefined && detected !== s.timezone;
  return {
    cadences,
    emailEnabled: s.emailEnabled,
    timezone: zoneDetected ? detected : s.timezone,
    digestHour: s.digestHour,
    weeklyDay: s.weeklyDay,
    quiet: s.quietHours !== null,
    quietStart: s.quietHours?.start ?? 22,
    quietEnd: s.quietHours?.end ?? 7,
    zoneDetected,
  };
}

export function PreferencesScreen() {
  const prefs = useQuery(notifyPreferencesQuery);
  const queryClient = useQueryClient();
  const [form, setForm] = useState<PrefForm | undefined>(undefined);
  const ids = {
    timezone: useId(),
    digestHour: useId(),
    weeklyDay: useId(),
    quietStart: useId(),
    quietEnd: useId(),
    quietOn: useId(),
    quietOff: useId(),
  };
  const defaults = new Set(
    (prefs.data?.preferences ?? []).filter((p) => p.isDefault).map((p) => p.eventType),
  );
  useEffect(() => {
    if (prefs.data && form === undefined) setForm(toForm(prefs.data));
  }, [prefs.data, form]);
  const quietInvalid = form?.quiet === true && form.quietStart === form.quietEnd;
  const save = useGuardedMutation({
    mutationFn: () => {
      if (!form) throw new Error("not loaded");
      return call(
        api().PUT("/notify/preferences", {
          body: {
            preferences: NOTIFY_STAFF_EVENT_TYPES.map((eventType) => ({
              eventType,
              cadence: form.cadences[eventType],
            })),
            settings: {
              emailEnabled: form.emailEnabled,
              timezone: form.timezone,
              digestHour: form.digestHour,
              weeklyDay: form.weeklyDay,
              quietHours: form.quiet ? { start: form.quietStart, end: form.quietEnd } : null,
            },
          },
        }),
      );
    },
    onSuccess: (data) => {
      toast.success(m.notify_preferences_saved());
      queryClient.setQueryData(notifyPreferencesQuery.queryKey, data);
      setForm(toForm(data));
    },
  });
  const zones = form ? timezoneOptions(form.timezone) : [];
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.notify_preferences_title()}
        description={m.notify_preferences_subtitle()}
        actions={
          <Button asChild variant="ghost">
            <Link to="/admin/$" params={{ _splat: "notify" }}>
              <ArrowLeft aria-hidden="true" />
              {m.notify_back_to_inbox()}
            </Link>
          </Button>
        }
      />
      {prefs.isPending ? <LoadingState label={m.common_loading()} /> : null}
      {prefs.isError ? <ErrorAlert error={prefs.error} /> : null}
      {form ? (
        <form
          className="max-w-2xl space-y-6"
          onSubmit={(e) => {
            e.preventDefault();
            if (quietInvalid) return;
            save.mutate();
          }}
        >
          <Card>
            <CardHeader>
              <CardTitle>{m.notify_preferences_card_title()}</CardTitle>
              <CardDescription>{m.notify_preferences_card_body()}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {NOTIFY_STAFF_EVENT_TYPES.map((type) => (
                <fieldset key={type} className="space-y-2">
                  <legend className="text-sm font-medium">
                    {eventLabel(type)}
                    {defaults.has(type) ? (
                      <Badge variant="secondary" className="ml-2">
                        {m.notify_is_default()}
                      </Badge>
                    ) : null}
                  </legend>
                  <div className="flex flex-wrap gap-4">
                    {NOTIFY_CADENCES.map((cadence) => (
                      <label key={cadence} className="flex items-center gap-2 text-sm">
                        <input
                          type="radio"
                          name={`cadence-${type}`}
                          value={cadence}
                          checked={form.cadences[type] === cadence}
                          onChange={() =>
                            setForm({
                              ...form,
                              cadences: { ...form.cadences, [type]: cadence },
                            })
                          }
                        />
                        {cadenceLabel(cadence)}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ))}
              <div className="flex items-center gap-3">
                <Switch
                  id="notify-email-enabled"
                  checked={form.emailEnabled}
                  onCheckedChange={(checked) => setForm({ ...form, emailEnabled: checked })}
                />
                <label htmlFor="notify-email-enabled" className="text-sm">
                  {m.notify_field_email_enabled()}
                </label>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{m.notify_schedule_title()}</CardTitle>
              <CardDescription>{m.notify_schedule_body()}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <Field
                id={ids.timezone}
                label={m.notify_field_timezone()}
                description={form.zoneDetected ? m.notify_field_timezone_detected() : undefined}
              >
                <NativeSelect
                  id={ids.timezone}
                  value={form.timezone}
                  {...fieldAria(ids.timezone, { description: form.zoneDetected })}
                  onChange={(e) => setForm({ ...form, timezone: e.target.value })}
                >
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  id={ids.digestHour}
                  label={m.notify_field_digest_hour()}
                  description={m.notify_field_digest_hour_hint()}
                >
                  <NativeSelect
                    id={ids.digestHour}
                    value={String(form.digestHour)}
                    {...fieldAria(ids.digestHour, { description: true })}
                    onChange={(e) => setForm({ ...form, digestHour: Number(e.target.value) })}
                  >
                    {HOURS.map((h) => (
                      <option key={h} value={String(h)}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
                <Field
                  id={ids.weeklyDay}
                  label={m.notify_field_weekly_day()}
                  description={m.notify_field_weekly_day_hint()}
                >
                  <NativeSelect
                    id={ids.weeklyDay}
                    value={String(form.weeklyDay)}
                    {...fieldAria(ids.weeklyDay, { description: true })}
                    onChange={(e) => setForm({ ...form, weeklyDay: Number(e.target.value) })}
                  >
                    {WEEKDAYS.map((d) => (
                      <option key={d} value={String(d)}>
                        {weekdayLabel(d)}
                      </option>
                    ))}
                  </NativeSelect>
                </Field>
              </div>
              <fieldset className="space-y-3" aria-describedby="notify-quiet-hint">
                <legend className="text-sm font-medium">{m.notify_quiet_legend()}</legend>
                <p id="notify-quiet-hint" className="text-sm text-muted-foreground">
                  {m.notify_quiet_hint()}
                </p>
                <div className="flex flex-wrap gap-4">
                  <label htmlFor={ids.quietOff} className="flex items-center gap-2 text-sm">
                    <input
                      id={ids.quietOff}
                      type="radio"
                      name="notify-quiet"
                      checked={!form.quiet}
                      onChange={() => setForm({ ...form, quiet: false })}
                    />
                    {m.notify_quiet_off()}
                  </label>
                  <label htmlFor={ids.quietOn} className="flex items-center gap-2 text-sm">
                    <input
                      id={ids.quietOn}
                      type="radio"
                      name="notify-quiet"
                      checked={form.quiet}
                      onChange={() => setForm({ ...form, quiet: true })}
                    />
                    {m.notify_quiet_on()}
                  </label>
                </div>
                {form.quiet ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Field id={ids.quietStart} label={m.notify_field_quiet_start()}>
                      <NativeSelect
                        id={ids.quietStart}
                        value={String(form.quietStart)}
                        onChange={(e) => setForm({ ...form, quietStart: Number(e.target.value) })}
                      >
                        {HOURS.map((h) => (
                          <option key={h} value={String(h)}>
                            {hourLabel(h)}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                    <Field
                      id={ids.quietEnd}
                      label={m.notify_field_quiet_end()}
                      error={quietInvalid ? m.notify_quiet_same_hour() : undefined}
                    >
                      <NativeSelect
                        id={ids.quietEnd}
                        value={String(form.quietEnd)}
                        {...fieldAria(ids.quietEnd, { error: quietInvalid })}
                        onChange={(e) => setForm({ ...form, quietEnd: Number(e.target.value) })}
                      >
                        {HOURS.map((h) => (
                          <option key={h} value={String(h)}>
                            {hourLabel(h)}
                          </option>
                        ))}
                      </NativeSelect>
                    </Field>
                  </div>
                ) : null}
              </fieldset>
            </CardContent>
          </Card>
          {save.isError ? <ErrorAlert error={save.error} /> : null}
          <Button type="submit" loading={save.isPending} disabled={quietInvalid}>
            {m.common_save()}
          </Button>
        </form>
      ) : null}
    </div>
  );
}
