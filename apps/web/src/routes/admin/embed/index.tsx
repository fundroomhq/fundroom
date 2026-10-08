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
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useState } from "react";
import { CopyButton } from "../../../components/copy-button.js";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call } from "../../../lib/api.js";
import {
  checkEmbedOrigin,
  describeEmbedError,
  describeEmbedOriginReason,
  EMBED_SETTINGS_KEY,
  type EmbedSettings,
  embedSettingsQuery,
  embedSnippetInputs,
  HANDOFF_KEY_ID_RE,
  HANDOFF_PUBLIC_KEY_RE,
  iframeSnippet,
  loaderSnippet,
  MAX_HANDOFF_KEYS,
  pinnedLoaderSnippet,
} from "../../../lib/embed-queries.js";
import { formatDateTime } from "../../../lib/format.js";
import { useBootstrap } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";

export const Route = createFileRoute("/admin/embed/")({ component: EmbedPage });

/*
 * Embed settings (E2.2, EXECUTION_PLAN §9.3, ADR-0040). A kernel file route beside Domains,
 * which is the other half of the same question: where this portal lives, and whose page it may
 * live inside.
 *
 * The screen owes the admin four things the API alone does not say:
 *
 *  - **Why an origin was refused, one sentence at a time.** `checkEmbedOrigin` mirrors the
 *    server's rule so the answer arrives while the cursor is still in the field, and names the
 *    rule rather than the outcome. The wildcard case matters most: an admin typing
 *    `https://*.acme.com` believes they are saving themselves three lines, and what they are
 *    actually publishing is a standing trust of every host anyone can ever put under that zone.
 *  - **What the preview toggle costs while it is on**, with the six patterns rendered from the
 *    response rather than copied into the UI — a hard-coded list would be wrong the first time
 *    the curated one changed, and wrong in the direction of understating what is allowed.
 *  - **What the header actually says.** `frameAncestors` is derived on every read, so the line
 *    on screen is the line the browser gets; that is the point of showing it.
 *  - **What the handoff toggle trades.** A host-site compromise becomes investor impersonation
 *    in this workspace. Off by default, and the warning says the sentence rather than implying
 *    it.
 *
 * Every mutation is one `PUT` of the whole block and needs a fresh session (design/02 §78: the
 * framing allow-list decides whose page may wrap the portal in its own chrome), so they all go
 * through `useGuardedMutation` and a stale admin gets the step-up screen rather than a toast
 * that says "forbidden" to someone holding the right permission.
 */
function EmbedPage() {
  const bootstrap = useBootstrap();
  const canManage = (bootstrap.data?.permissions ?? []).includes("embed.manage");
  const settings = useQuery(embedSettingsQuery);
  return (
    <div className="space-y-6">
      <PageHeader title={m.embed_settings_title()} description={m.embed_settings_subtitle()} />
      {settings.isPending ? <LoadingState lines={6} label={m.common_loading()} /> : null}
      {settings.isError ? <ErrorAlert error={settings.error} /> : null}
      {settings.data ? <EmbedSettingsView settings={settings.data} canManage={canManage} /> : null}
    </div>
  );
}

type EmbedPatch = {
  origins?: string[];
  allowPreviewOrigins?: boolean;
  trustHostIdentity?: boolean;
  handoffKeys?: { id: string; publicKey: string; label: string }[];
};

/** One mutation for the whole screen: the `PUT` replaces the block, whatever changed. */
function useSaveEmbed(onSaved?: () => void) {
  const queryClient = useQueryClient();
  return useGuardedMutation<EmbedSettings, EmbedPatch>({
    mutationFn: (patch) => call(api().PUT("/embed/settings", { body: patch })),
    onSuccess: (next) => {
      // The response is the whole settings object with everything re-derived, so it replaces
      // the cache rather than only invalidating it: the `frame-ancestors` line the admin is
      // reading updates in the same frame as the list they just changed.
      queryClient.setQueryData(EMBED_SETTINGS_KEY, next);
      toast.success(m.embed_saved());
      onSaved?.();
    },
    onError: (error) => toast.error(describeEmbedError(error)),
  });
}

function EmbedSettingsView({
  settings,
  canManage,
}: {
  settings: EmbedSettings;
  canManage: boolean;
}) {
  return (
    <>
      <OriginsCard settings={settings} canManage={canManage} />
      <PreviewOriginsCard settings={settings} canManage={canManage} />
      <SnippetsCard settings={settings} />
      <HandoffCard settings={settings} canManage={canManage} />
    </>
  );
}

/** A block of generated markup with its copy button; never editable, always selectable. */
function Snippet({ label, code }: { label: string; code: string }) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{label}</h3>
        <CopyButton value={code} label={m.common_copy()} />
      </div>
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** A switch with its label and the sentence that says what it costs. */
function SwitchRow({
  id,
  checked,
  disabled,
  label,
  hint,
  onChange,
}: {
  id: string;
  checked: boolean;
  disabled: boolean;
  label: string;
  hint: ReactNode;
  onChange: (on: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(on) => onChange(on === true)}
      />
      <div className="grid gap-1">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-sm text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}

function OriginsCard({ settings, canManage }: { settings: EmbedSettings; canManage: boolean }) {
  const id = useId();
  const [value, setValue] = useState("");
  const [rejected, setRejected] = useState<string | undefined>(undefined);
  const save = useSaveEmbed(() => setValue(""));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const check = checkEmbedOrigin(value, settings.origins);
    if (!check.ok) {
      setRejected(describeEmbedOriginReason(check.reason));
      return;
    }
    setRejected(undefined);
    save.mutate({ origins: [...settings.origins, check.origin] });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.embed_origins_title()}</CardTitle>
        <CardDescription>{m.embed_origins_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {settings.origins.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.embed_origins_none()}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {settings.origins.map((origin) => (
              <li key={origin} className="flex flex-wrap items-center justify-between gap-2 p-3">
                <span className="font-mono text-sm break-all">{origin}</span>
                {canManage ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={save.isPending}
                    /*
                     * The visible word plus the origin, so four "Remove" buttons are four
                     * different controls to a screen reader (WCAG 2.2 AA 2.4.6) — and the
                     * visible label stays a prefix of the accessible name, which is what
                     * 2.5.3 asks of anyone driving this by voice.
                     */
                    aria-label={m.embed_origin_remove_named({ origin })}
                    onClick={() =>
                      save.mutate({ origins: settings.origins.filter((o) => o !== origin) })
                    }
                  >
                    {m.embed_origin_remove()}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <form className="flex flex-wrap items-end gap-2" onSubmit={submit}>
          <Field
            id={id}
            label={m.embed_origin_field()}
            description={m.embed_origin_field_help()}
            className="flex-1"
            error={rejected}
          >
            <Input
              id={id}
              value={value}
              disabled={!canManage}
              placeholder="https://acme.com"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                setValue(e.target.value);
                setRejected(undefined);
              }}
            />
          </Field>
          {canManage ? (
            <Button type="submit" loading={save.isPending} disabled={value.trim() === ""}>
              {m.embed_origin_add()}
            </Button>
          ) : null}
        </form>
        <div className="space-y-2">
          <h3 className="text-sm font-medium">{m.embed_frame_ancestors_title()}</h3>
          <p className="text-sm text-muted-foreground">{m.embed_frame_ancestors_body()}</p>
          <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs">
            <code>{`Content-Security-Policy: frame-ancestors ${settings.frameAncestors.join(" ")}`}</code>
          </pre>
        </div>
      </CardContent>
    </Card>
  );
}

function PreviewOriginsCard({
  settings,
  canManage,
}: {
  settings: EmbedSettings;
  canManage: boolean;
}) {
  const id = useId();
  const save = useSaveEmbed();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.embed_preview_title()}</CardTitle>
        <CardDescription>{m.embed_preview_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SwitchRow
          id={id}
          checked={settings.allowPreviewOrigins}
          disabled={!canManage || save.isPending}
          label={m.embed_preview_toggle()}
          hint={m.embed_preview_toggle_hint()}
          onChange={(on) => save.mutate({ allowPreviewOrigins: on })}
        />
        {/*
         * Rendered from `previewOriginPatterns` in the response, never from a copy kept here:
         * the curated list is a constant in `@fundroom/domain`, and a stale copy on the screen
         * would understate what the toggle allows — which is the one direction it must not err.
         */}
        <Alert variant={settings.allowPreviewOrigins ? "warning" : "default"}>
          <AlertTitle>
            {settings.allowPreviewOrigins
              ? m.embed_preview_on_title()
              : m.embed_preview_off_title()}
          </AlertTitle>
          <AlertDescription className="space-y-2">
            <p>
              {settings.allowPreviewOrigins
                ? m.embed_preview_on_body()
                : m.embed_preview_off_body()}
            </p>
            <ul className="list-inside list-disc font-mono text-xs">
              {settings.previewOriginPatterns.map((pattern) => (
                <li key={pattern}>{pattern}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}

function SnippetsCard({ settings }: { settings: EmbedSettings }) {
  const inputs = embedSnippetInputs(settings);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.embed_snippets_title()}</CardTitle>
        <CardDescription>{m.embed_snippets_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Snippet label={m.embed_snippet_loader()} code={loaderSnippet(inputs)} />
        <p className="text-sm text-muted-foreground">{m.embed_snippet_loader_hint()}</p>
        <Snippet label={m.embed_snippet_pinned()} code={pinnedLoaderSnippet(inputs)} />
        <p className="text-sm text-muted-foreground">{m.embed_snippet_pinned_hint()}</p>
        <Snippet label={m.embed_snippet_iframe()} code={iframeSnippet(inputs)} />
        <p className="text-sm text-muted-foreground">{m.embed_snippet_iframe_hint()}</p>
      </CardContent>
    </Card>
  );
}

function HandoffCard({ settings, canManage }: { settings: EmbedSettings; canManage: boolean }) {
  const toggleId = useId();
  const ids = { key: useId(), publicKey: useId(), label: useId() };
  const [keyId, setKeyId] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [label, setLabel] = useState("");
  const [errors, setErrors] = useState<{ id?: string; publicKey?: string }>({});
  const save = useSaveEmbed(() => {
    setKeyId("");
    setPublicKey("");
    setLabel("");
  });

  const asInputs = () =>
    settings.handoffKeys.map((k) => ({ id: k.id, publicKey: k.publicKey, label: k.label }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next: { id?: string; publicKey?: string } = {};
    const id = keyId.trim();
    const key = publicKey.trim();
    if (!HANDOFF_KEY_ID_RE.test(id)) next.id = m.embed_handoff_key_id_invalid();
    else if (settings.handoffKeys.some((k) => k.id === id)) next.id = m.embed_handoff_key_id_dup();
    if (!HANDOFF_PUBLIC_KEY_RE.test(key)) next.publicKey = m.embed_handoff_key_public_invalid();
    setErrors(next);
    if (next.id !== undefined || next.publicKey !== undefined) return;
    save.mutate({ handoffKeys: [...asInputs(), { id, publicKey: key, label: label.trim() }] });
  };

  const full = settings.handoffKeys.length >= MAX_HANDOFF_KEYS;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.embed_handoff_title()}</CardTitle>
        <CardDescription>{m.embed_handoff_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <SwitchRow
          id={toggleId}
          checked={settings.trustHostIdentity}
          disabled={!canManage || save.isPending}
          label={m.embed_handoff_toggle()}
          hint={m.embed_handoff_toggle_hint()}
          onChange={(on) => save.mutate({ trustHostIdentity: on })}
        />
        {/*
         * The trade in one sentence, always on screen rather than only while the switch is on:
         * it is the thing to read *before* turning it on. `auth_level` 0, an existing
         * membership and a 60-second single-use assertion are what bound it, and the sentence
         * says so rather than leaving "trusted" to mean whatever the reader assumed.
         */}
        <Alert variant={settings.trustHostIdentity ? "warning" : "default"}>
          <AlertTitle>
            {settings.trustHostIdentity ? m.embed_handoff_on_title() : m.embed_handoff_off_title()}
          </AlertTitle>
          <AlertDescription>
            {settings.trustHostIdentity ? m.embed_handoff_on_body() : m.embed_handoff_off_body()}
          </AlertDescription>
        </Alert>

        {settings.handoffKeys.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.embed_handoff_keys_none()}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.embed_handoff_col_id()}</TableHead>
                <TableHead>{m.embed_handoff_col_label()}</TableHead>
                <TableHead>{m.embed_handoff_col_added()}</TableHead>
                {canManage ? (
                  <TableHead>
                    <span className="sr-only">{m.embed_handoff_col_actions()}</span>
                  </TableHead>
                ) : null}
              </TableRow>
            </TableHeader>
            <TableBody>
              {settings.handoffKeys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="font-mono text-xs break-all">{key.id}</TableCell>
                  <TableCell>{key.label === "" ? m.embed_handoff_no_label() : key.label}</TableCell>
                  <TableCell>{formatDateTime(key.addedAt)}</TableCell>
                  {canManage ? (
                    <TableCell>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={save.isPending}
                        aria-label={m.embed_handoff_key_remove_named({ id: key.id })}
                        onClick={() =>
                          save.mutate({
                            handoffKeys: asInputs().filter((k) => k.id !== key.id),
                          })
                        }
                      >
                        {m.embed_handoff_key_remove()}
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}

        {canManage ? (
          <form className="grid gap-4 sm:grid-cols-3" onSubmit={submit}>
            <Field id={ids.key} label={m.embed_handoff_key_id()} error={errors.id}>
              <Input
                id={ids.key}
                value={keyId}
                autoComplete="off"
                spellCheck={false}
                placeholder="acme-wp-1"
                onChange={(e) => setKeyId(e.target.value)}
              />
            </Field>
            <Field
              id={ids.publicKey}
              label={m.embed_handoff_key_public()}
              description={m.embed_handoff_key_public_help()}
              error={errors.publicKey}
            >
              <Input
                id={ids.publicKey}
                value={publicKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setPublicKey(e.target.value)}
              />
            </Field>
            <Field id={ids.label} label={m.embed_handoff_key_label()}>
              <Input
                id={ids.label}
                value={label}
                autoComplete="off"
                placeholder="acme.com WordPress"
                onChange={(e) => setLabel(e.target.value)}
              />
            </Field>
            <div className="sm:col-span-3">
              <Button type="submit" loading={save.isPending} disabled={full}>
                {m.embed_handoff_key_add()}
              </Button>
              {full ? (
                <p className="pt-2 text-sm text-muted-foreground">
                  {m.embed_handoff_keys_full({ max: String(MAX_HANDOFF_KEYS) })}
                </p>
              ) : null}
            </div>
          </form>
        ) : null}
      </CardContent>
    </Card>
  );
}
