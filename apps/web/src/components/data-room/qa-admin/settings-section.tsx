import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  fieldAria,
  Input,
  Label,
  Switch,
  toast,
} from "@fundroomhq/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { api, call, describeError } from "../../../lib/api.js";
import type { QaSettings, QaSettingsPatch, QaVisibility } from "../../../lib/qa-admin-queries.js";
import { dataRoomSettingsQuery } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";
import { PlanFeatureNotice, usePlanAllowsFeature } from "../../billing/plan-feature-notice.js";

const LIMITS = {
  slaHours: [1, 720],
  reminderLeadHours: [0, 168],
  maxOpenPerAsker: [1, 500],
} as const;
type NumberKey = keyof typeof LIMITS;

function valid(key: NumberKey, text: string): boolean {
  if (!/^\d+$/u.test(text)) return false;
  const n = Number(text);
  return n >= LIMITS[key][0] && n <= LIMITS[key][1];
}

/*
 * The Q&A block of the data-room settings (E3.3 D3): PATCH /data-room/settings `{ qa: {…} }`,
 * deep-merged server-side (a `fresh` route, like the rest of the form). Off by default: staff
 * can prepare and import before investors see anything.
 */
export function QaSettingsSection({ qa, canSettings }: { qa: QaSettings; canSettings: boolean }) {
  const base = useId();
  const qc = useQueryClient();
  const [numbers, setNumbers] = useState<Partial<Record<NumberKey, string>>>({});
  const [attempted, setAttempted] = useState(false);
  // A-3: Q&A already on keeps working; turning it on needs `qa` on the plan.
  const qaAllowed = usePlanAllowsFeature("qa");
  const update = useGuardedMutation({
    mutationFn: (patch: QaSettingsPatch) =>
      call(api().PATCH("/data-room/settings", { body: { qa: patch } })),
    onSuccess: (data, patch) => {
      qc.setQueryData(dataRoomSettingsQuery.queryKey, data);
      // A switch or the visibility radio saves on its own; it must not throw away number edits
      // the admin has typed but not saved yet (C16). Only the saved numbers are reset.
      const saved = (Object.keys(LIMITS) as NumberKey[]).filter((k) => k in patch);
      if (saved.length > 0) {
        setNumbers((n) => {
          const next = { ...n };
          for (const k of saved) delete next[k];
          return next;
        });
        setAttempted(false);
      }
      toast.success(m.dataroom_admin_settings_saved());
    },
    onError: (e) => toast.error(describeError(e).title),
  });
  const ro = !canSettings || update.isPending;
  const text = (key: NumberKey) => numbers[key] ?? String(qa[key]);
  const invalid = (key: NumberKey) => attempted && !valid(key, text(key));

  function submit(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    const keys = Object.keys(LIMITS) as NumberKey[];
    if (keys.some((k) => !valid(k, text(k)))) return;
    const patch: QaSettingsPatch = {};
    for (const k of keys) if (Number(text(k)) !== qa[k]) patch[k] = Number(text(k));
    if (Object.keys(patch).length > 0) update.mutate(patch);
  }

  const toggle = (key: "enabled" | "requireApproval" | "allowFolderQuestions", label: string) => (
    <div className="flex items-center gap-3">
      <Switch
        id={`${base}-${key}`}
        checked={qa[key]}
        disabled={ro || (key === "enabled" && !qaAllowed && !qa.enabled)}
        onCheckedChange={(v) => update.mutate({ [key]: v })}
      />
      <Label htmlFor={`${base}-${key}`}>{label}</Label>
    </div>
  );
  const number = (key: NumberKey, label: string, hint: string) => {
    const id = `${base}-${key}`;
    return (
      <Field
        id={id}
        label={label}
        description={hint}
        {...(invalid(key)
          ? {
              error: m.dataroom_qa_admin_setting_range({
                min: String(LIMITS[key][0]),
                max: String(LIMITS[key][1]),
              }),
            }
          : {})}
      >
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={LIMITS[key][0]}
          max={LIMITS[key][1]}
          value={text(key)}
          disabled={ro}
          onChange={(e) => setNumbers((n) => ({ ...n, [key]: e.target.value }))}
          {...fieldAria(id, { description: true, error: invalid(key) })}
        />
      </Field>
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.dataroom_qa_admin_settings_title()}</CardTitle>
        <CardDescription>{m.dataroom_qa_admin_settings_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <PlanFeatureNotice feature="qa" />
        {toggle("enabled", m.dataroom_qa_admin_setting_enabled())}
        {toggle("requireApproval", m.dataroom_qa_admin_setting_require_approval())}
        {toggle("allowFolderQuestions", m.dataroom_qa_admin_setting_folder_questions())}
        <fieldset className="space-y-2" disabled={ro}>
          <legend className="text-sm font-medium">
            {m.dataroom_qa_admin_setting_default_visibility()}
          </legend>
          {(["asker", "target"] as const satisfies readonly QaVisibility[]).map((v) => (
            <label key={v} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${base}-visibility`}
                value={v}
                checked={qa.defaultVisibility === v}
                onChange={() => update.mutate({ defaultVisibility: v })}
              />
              {v === "asker"
                ? m.dataroom_qa_admin_visibility_asker()
                : m.dataroom_qa_admin_visibility_target()}
            </label>
          ))}
        </fieldset>
        <form className="grid gap-4 sm:grid-cols-3" onSubmit={submit} noValidate>
          {number(
            "slaHours",
            m.dataroom_qa_admin_setting_sla_hours(),
            m.dataroom_qa_admin_setting_sla_hours_hint(),
          )}
          {number(
            "reminderLeadHours",
            m.dataroom_qa_admin_setting_reminder_hours(),
            m.dataroom_qa_admin_setting_reminder_hours_hint(),
          )}
          {number(
            "maxOpenPerAsker",
            m.dataroom_qa_admin_setting_max_open(),
            m.dataroom_qa_admin_setting_max_open_hint(),
          )}
          {canSettings ? (
            <div className="sm:col-span-3">
              <Button type="submit" disabled={update.isPending}>
                {m.dataroom_qa_admin_settings_save()}
              </Button>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
