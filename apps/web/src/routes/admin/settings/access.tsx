import {
  Alert,
  AlertDescription,
  AlertTitle,
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
  LoadingState,
  PageHeader,
  Switch,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldOff } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { GroupPicker } from "../../../components/access/group-picker.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { WorkspaceLanguageCard } from "../../../components/language.js";
import { accessSettingsQuery, groupsQuery, useBootstrap } from "../../../lib/queries.js";
import {
  type AccessSettings,
  type AccessSettingsPatch,
  patchAccessSettings,
} from "../../../lib/settings-queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/settings/access")({ component: AccessSettingsPage });

/*
 * Access & sign-in settings (E2.7, over the E1.1 `GET/PATCH /access/settings`). Reading needs
 * `access.read`; saving needs `access.settings` and a fresh session, so the save goes through
 * `useGuardedMutation` and a stale admin comes back here from step-up with the form reloaded
 * from the server (the draft is not kept — a half-edited MFA policy is not worth restoring).
 *
 * Only the fields that changed are sent: the PATCH is partial, and sending an untouched field
 * would turn "I changed the invite expiry" into "I re-asserted the MFA policy" in the audit
 * diff.
 */
function AccessSettingsPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  if (!permissions.includes("access.read")) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.accesssettings_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return (
    <AccessSettingsScreen
      canEdit={permissions.includes("access.settings")}
      is506b={bootstrap.data?.workspace?.offeringStatus === "506b"}
    />
  );
}

function AccessSettingsScreen({ canEdit, is506b }: { canEdit: boolean; is506b: boolean }) {
  const settings = useQuery(accessSettingsQuery);
  return (
    <div className="space-y-6">
      <PageHeader title={m.accesssettings_title()} description={m.accesssettings_subtitle()} />
      <p className="text-sm">
        <Link to="/admin/settings" className="underline underline-offset-4">
          {m.adminsettings_back()}
        </Link>
      </p>
      {settings.isPending ? <LoadingState lines={4} label={m.common_loading()} /> : null}
      {settings.isError ? <ErrorAlert error={settings.error} /> : null}
      {settings.data ? (
        <SettingsForm settings={settings.data} canEdit={canEdit} is506b={is506b} />
      ) : null}
      <WorkspaceLanguageCard canEdit={canEdit} />
    </div>
  );
}

function changes(before: AccessSettings, after: AccessSettings): AccessSettingsPatch {
  const out: AccessSettingsPatch = {};
  if (before.requireMfaForStaff !== after.requireMfaForStaff)
    out.requireMfaForStaff = after.requireMfaForStaff;
  if (before.requireMfaForExternal !== after.requireMfaForExternal)
    out.requireMfaForExternal = after.requireMfaForExternal;
  if (before.inviteExpiryDays !== after.inviteExpiryDays)
    out.inviteExpiryDays = after.inviteExpiryDays;
  if (before.allowDelegates !== after.allowDelegates) out.allowDelegates = after.allowDelegates;
  if (before.maxDelegatesPerPrincipal !== after.maxDelegatesPerPrincipal)
    out.maxDelegatesPerPrincipal = after.maxDelegatesPerPrincipal;
  // `requests` is replaced whole by the server, so a change anywhere in it sends all of it.
  if (!sameRequests(before.requests, after.requests)) out.requests = after.requests;
  return out;
}

type RequestSettings = AccessSettings["requests"];

function sameRequests(a: RequestSettings, b: RequestSettings): boolean {
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && x.every((v, i) => v === y[i]);
  return (
    a.enabled === b.enabled &&
    a.pendingExpiryDays === b.pendingExpiryDays &&
    same(a.autoApproveDomains, b.autoApproveDomains) &&
    same([...a.defaultGroupIds].sort(), [...b.defaultGroupIds].sort())
  );
}

/** The server's `EMAIL_DOMAIN_PATTERN` (packages/domain): a lowercase hostname with a TLD. */
const DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/u;
const MAX_DOMAINS = 50;
const MAX_DEFAULT_GROUPS = 20;

/** One domain per line (commas and spaces also split); "@example.com" is taken as "example.com". */
function parseDomains(text: string): { domains: string[]; invalid: string[] } {
  const domains: string[] = [];
  const invalid: string[] = [];
  for (const raw of text.split(/[\s,;]+/u)) {
    const d = raw.trim().toLowerCase().replace(/^@/u, "");
    if (d === "" || domains.includes(d) || invalid.includes(d)) continue;
    (DOMAIN_PATTERN.test(d) ? domains : invalid).push(d);
  }
  return { domains, invalid };
}

function SettingsForm({
  settings,
  canEdit,
  is506b,
}: {
  settings: AccessSettings;
  canEdit: boolean;
  is506b: boolean;
}) {
  const ids = useId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AccessSettings>(settings);
  const [expiryText, setExpiryText] = useState(String(settings.inviteExpiryDays));
  const expiry = Number(expiryText);
  const expiryValid = /^\d+$/u.test(expiryText) && expiry >= 1 && expiry <= 90;
  const [maxDelegatesText, setMaxDelegatesText] = useState(
    String(settings.maxDelegatesPerPrincipal),
  );
  const maxDelegates = Number(maxDelegatesText);
  const maxDelegatesValid =
    /^\d+$/u.test(maxDelegatesText) && maxDelegates >= 1 && maxDelegates <= 20;
  const [domainsText, setDomainsText] = useState(settings.requests.autoApproveDomains.join("\n"));
  const [pendingText, setPendingText] = useState(String(settings.requests.pendingExpiryDays));
  const groups = useQuery(groupsQuery);
  const pending = Number(pendingText);
  const pendingValid = /^\d+$/u.test(pendingText) && pending >= 1 && pending <= 365;
  const parsedDomains = parseDomains(domainsText);
  const domainsError =
    parsedDomains.invalid.length > 0
      ? m.accessrequests_settings_domains_invalid({ domains: parsedDomains.invalid.join(", ") })
      : parsedDomains.domains.length > MAX_DOMAINS
        ? m.accessrequests_settings_domains_too_many()
        : undefined;
  // A stored default group may since have been archived (the server drops it from the setting
  // then, but a page loaded before that still holds it): only groups in the loaded list count,
  // on both sides of the diff, so a stale id neither marks the form dirty nor gets sent back.
  const liveGroupIds = groups.data ? new Set(groups.data.groups.map((g) => g.id)) : undefined;
  const live = (ids: readonly string[]) =>
    liveGroupIds ? ids.filter((id) => liveGroupIds.has(id)) : [...ids];
  const defaultGroupIds = live(draft.requests.defaultGroupIds);
  const groupsError =
    defaultGroupIds.length > MAX_DEFAULT_GROUPS
      ? m.accessrequests_settings_groups_too_many()
      : undefined;
  const valid =
    expiryValid && maxDelegatesValid && pendingValid && domainsError === undefined && !groupsError;
  const next: AccessSettings = {
    ...draft,
    inviteExpiryDays: expiryValid ? expiry : draft.inviteExpiryDays,
    maxDelegatesPerPrincipal: maxDelegatesValid ? maxDelegates : draft.maxDelegatesPerPrincipal,
    requests: {
      ...draft.requests,
      autoApproveDomains: parsedDomains.domains,
      defaultGroupIds,
      pendingExpiryDays: pendingValid ? pending : draft.requests.pendingExpiryDays,
    },
  };
  const patch = changes(
    {
      ...settings,
      requests: { ...settings.requests, defaultGroupIds: live(settings.requests.defaultGroupIds) },
    },
    next,
  );
  const dirty = Object.keys(patch).length > 0;

  const save = useGuardedMutation({
    mutationFn: (body: AccessSettingsPatch) => patchAccessSettings(body),
    onSuccess: (saved) => {
      queryClient.setQueryData(accessSettingsQuery.queryKey, saved);
      toast.success(m.accesssettings_saved());
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!valid || !dirty) return;
    save.mutate(patch);
  }

  function toggle(key: "requireMfaForStaff" | "requireMfaForExternal" | "allowDelegates") {
    return (on: boolean) => setDraft((d) => ({ ...d, [key]: on }));
  }

  const switches = [
    {
      key: "requireMfaForStaff" as const,
      label: m.accesssettings_mfa_staff(),
      hint: m.accesssettings_mfa_staff_hint(),
    },
    {
      key: "requireMfaForExternal" as const,
      label: m.accesssettings_mfa_external(),
      hint: m.accesssettings_mfa_external_hint(),
    },
    {
      key: "allowDelegates" as const,
      label: m.accesssettings_delegates(),
      hint: m.accesssettings_delegates_hint(),
    },
  ];

  return (
    <Card className="max-w-3xl">
      <CardHeader>
        <CardTitle>{m.accesssettings_card_title()}</CardTitle>
        <CardDescription>
          {canEdit ? m.accesssettings_card_body() : m.accesssettings_read_only()}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-6" onSubmit={submit} noValidate>
          {switches.map((s) => (
            <div key={s.key} className="flex items-start gap-3">
              <Switch
                id={`${ids}-${s.key}`}
                checked={draft[s.key]}
                disabled={!canEdit}
                onCheckedChange={(on) => toggle(s.key)(on === true)}
                aria-describedby={`${ids}-${s.key}-hint`}
              />
              <div className="grid gap-1">
                <Label htmlFor={`${ids}-${s.key}`}>{s.label}</Label>
                <p id={`${ids}-${s.key}-hint`} className="text-sm text-muted-foreground">
                  {s.hint}
                </p>
              </div>
            </div>
          ))}
          <Field
            id={`${ids}-expiry`}
            label={m.accesssettings_invite_expiry()}
            description={m.accesssettings_invite_expiry_hint()}
            error={expiryValid ? undefined : m.accesssettings_invite_expiry_invalid()}
            className="max-w-xs"
          >
            <Input
              id={`${ids}-expiry`}
              type="number"
              inputMode="numeric"
              min={1}
              max={90}
              value={expiryText}
              disabled={!canEdit}
              onChange={(e) => setExpiryText(e.target.value)}
              {...fieldAria(`${ids}-expiry`, { description: true, error: !expiryValid })}
            />
          </Field>
          <Field
            id={`${ids}-max-delegates`}
            label={m.accesssettings_max_delegates()}
            description={m.accesssettings_max_delegates_hint()}
            error={maxDelegatesValid ? undefined : m.accesssettings_max_delegates_invalid()}
            className="max-w-xs"
          >
            <Input
              id={`${ids}-max-delegates`}
              type="number"
              inputMode="numeric"
              min={1}
              max={20}
              value={maxDelegatesText}
              disabled={!canEdit}
              onChange={(e) => setMaxDelegatesText(e.target.value)}
              {...fieldAria(`${ids}-max-delegates`, {
                description: true,
                error: !maxDelegatesValid,
              })}
            />
          </Field>
          <fieldset className="space-y-6 border-t pt-6" aria-describedby={`${ids}-requests-body`}>
            <legend className="float-left mb-2 w-full text-base font-semibold">
              {m.accessrequests_settings_title()}
            </legend>
            <p id={`${ids}-requests-body`} className="clear-left text-sm text-muted-foreground">
              {m.accessrequests_settings_body()}{" "}
              <Link to="/admin/access-requests" className="underline underline-offset-4">
                {m.accessrequests_settings_queue_link()}
              </Link>
            </p>
            <div className="flex items-start gap-3">
              <Switch
                id={`${ids}-requests-enabled`}
                checked={draft.requests.enabled}
                disabled={!canEdit}
                onCheckedChange={(on) =>
                  setDraft((d) => ({ ...d, requests: { ...d.requests, enabled: on === true } }))
                }
                aria-describedby={`${ids}-requests-enabled-hint`}
              />
              <div className="grid gap-1">
                <Label htmlFor={`${ids}-requests-enabled`}>
                  {m.accessrequests_settings_enabled()}
                </Label>
                <p id={`${ids}-requests-enabled-hint`} className="text-sm text-muted-foreground">
                  {m.accessrequests_settings_enabled_hint()}
                </p>
              </div>
            </div>
            <Field
              id={`${ids}-domains`}
              label={m.accessrequests_settings_domains()}
              description={
                is506b ? (
                  <>
                    {m.accessrequests_settings_domains_hint()}{" "}
                    <strong className="font-medium text-foreground">
                      {m.accessrequests_settings_domains_506b()}
                    </strong>
                  </>
                ) : (
                  m.accessrequests_settings_domains_hint()
                )
              }
              error={domainsError}
              className="max-w-md"
            >
              <Textarea
                id={`${ids}-domains`}
                rows={3}
                value={domainsText}
                disabled={!canEdit}
                spellCheck={false}
                autoCapitalize="none"
                onChange={(e) => setDomainsText(e.target.value)}
                {...fieldAria(`${ids}-domains`, {
                  description: true,
                  error: domainsError !== undefined,
                })}
              />
            </Field>
            {groups.data && groups.data.groups.length > 0 ? (
              <GroupPicker
                groups={groups.data.groups}
                value={draft.requests.defaultGroupIds}
                onChange={(defaultGroupIds) =>
                  setDraft((d) => ({ ...d, requests: { ...d.requests, defaultGroupIds } }))
                }
                legend={m.accessrequests_settings_groups()}
                description={groupsError ?? m.accessrequests_settings_groups_hint()}
                idPrefix={`${ids}-default-group`}
                disabled={!canEdit}
              />
            ) : groups.data ? (
              <p className="text-sm text-muted-foreground">
                {m.accessrequests_settings_groups_none()}
              </p>
            ) : null}
            <Field
              id={`${ids}-pending-expiry`}
              label={m.accessrequests_settings_expiry()}
              description={m.accessrequests_settings_expiry_hint()}
              error={pendingValid ? undefined : m.accessrequests_settings_expiry_invalid()}
              className="max-w-xs"
            >
              <Input
                id={`${ids}-pending-expiry`}
                type="number"
                inputMode="numeric"
                min={1}
                max={365}
                value={pendingText}
                disabled={!canEdit}
                onChange={(e) => setPendingText(e.target.value)}
                {...fieldAria(`${ids}-pending-expiry`, {
                  description: true,
                  error: !pendingValid,
                })}
              />
            </Field>
          </fieldset>
          {save.isError ? <ErrorAlert error={save.error} /> : null}
          {canEdit ? (
            <Button type="submit" disabled={!dirty || !valid} loading={save.isPending}>
              {m.common_save()}
            </Button>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
