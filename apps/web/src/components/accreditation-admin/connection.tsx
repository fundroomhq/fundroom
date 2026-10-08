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
  Field,
  fieldAria,
  Input,
  LoadingState,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import {
  ACCREDITATION_KEY,
  type AccreditationConnection,
  type AccreditationCredentialField,
  type AccreditationProvider,
  type AccreditationVendor,
  accreditationConnectionQuery,
  accreditationErrorCode,
  accreditationProvidersQuery,
  credentialFieldHelp,
  credentialFieldLabel,
  credentialOptionLabel,
  describeAccreditationError,
  invalidFields,
} from "../../lib/accreditation-queries.js";
import { api, call } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import {
  PlanFeatureNotice,
  usePlanAllowsFeature,
  usePlanRemovalWarning,
} from "../billing/plan-feature-notice.js";
import { NativeSelect } from "../compliance/common.js";
import { CopyButton } from "../copy-button.js";
import { ErrorAlert } from "../error-alert.js";
import { TypedConfirmDialog } from "../typed-confirm-dialog.js";

/*
 * The workspace's one accreditation vendor connection (E3.7, ADR-0055).
 *
 * What the admin must not get wrong, and the screen is shaped around it:
 *
 *  - **No connection is a valid state.** Verifications are then manual (the investor uploads
 *    evidence, an admin decides), exactly as before E3.7.
 *  - **The operator decides what is offered.** A vendor outside `ACCREDITATION_DRIVERS` is listed
 *    but cannot be chosen; a connection to one the operator stopped offering keeps working.
 *  - **Credentials are write-only** and verified live with the vendor before anything is stored.
 *  - **Switching or disconnecting strands pending vendor verifications.** They stop being checked
 *    and an admin decides them in the queue — said before the change, not discovered after.
 *  - **Two addresses go into the vendor's dashboard:** the callback URL, and for a widget vendor
 *    (Parallel Markets) the handoff page, which must be registered as the redirect URI verbatim.
 */

function providerOf(
  providers: readonly AccreditationProvider[] | undefined,
  driver: AccreditationVendor,
): AccreditationProvider | undefined {
  return providers?.find((p) => p.driver === driver);
}

export function AccreditationConnectionCard({
  canManage,
  roundOn,
}: {
  canManage: boolean;
  /** The round module is on, so its verification queue can be linked to. */
  roundOn: boolean;
}) {
  const connection = useQuery(accreditationConnectionQuery);
  const providers = useQuery(accreditationProvidersQuery);
  const [editing, setEditing] = useState(false);
  const current = connection.data?.connection ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.accreditation_connection_title()}</CardTitle>
        <CardDescription>{m.accreditation_connection_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* A-3: verifications keep running through the existing connection. */}
        <PlanFeatureNotice feature="accreditation" />
        {connection.isPending || providers.isPending ? (
          <LoadingState lines={3} label={m.common_loading()} />
        ) : null}
        {connection.isError ? <ErrorAlert error={connection.error} /> : null}
        {providers.isError ? <ErrorAlert error={providers.error} /> : null}
        {connection.data && providers.data ? (
          current === null || editing ? (
            <>
              {current === null ? (
                <p className="text-sm text-muted-foreground">{m.accreditation_manual_now()}</p>
              ) : null}
              {canManage ? (
                <ConnectForm
                  providers={providers.data.providers}
                  existing={current}
                  roundOn={roundOn}
                  onDone={() => setEditing(false)}
                  onCancel={current === null ? undefined : () => setEditing(false)}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {m.accreditation_not_connected_read_only()}
                </p>
              )}
            </>
          ) : (
            <ConnectedSummary
              connection={current}
              provider={providerOf(providers.data.providers, current.driver)}
              canManage={canManage}
              roundOn={roundOn}
              onReplace={() => setEditing(true)}
            />
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Where pending vendor verifications end up when the vendor changes: the queue, decided by hand. */
function StrandedNote({ roundOn }: { roundOn: boolean }) {
  return (
    <p>
      {m.accreditation_stranded_body()}{" "}
      {roundOn ? (
        <Link
          to="/admin/$"
          params={{ _splat: "round/verifications" }}
          className="font-medium underline underline-offset-4"
        >
          {m.accreditation_go_to_queue()}
        </Link>
      ) : null}
    </p>
  );
}

// --- connected --------------------------------------------------------------------------------

function ConnectedSummary({
  connection,
  provider,
  canManage,
  roundOn,
  onReplace,
}: {
  connection: AccreditationConnection;
  provider: AccreditationProvider | undefined;
  canManage: boolean;
  roundOn: boolean;
  onReplace: () => void;
}) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ACCREDITATION_KEY });
  const warnRemoval = usePlanRemovalWarning("accreditation");
  // A-3: verify, replace (same vendor) and delete maintain the existing connection, which a
  // plan without `accreditation` keeps — only a first connection or another vendor needs it.
  const verify = useGuardedMutation({
    mutationFn: () => call(api().POST("/accreditation/connection/verify")),
    onSuccess: (result) => {
      if (result.connection.status === "active") toast.success(m.accreditation_verified_ok());
      else toast.error(m.accreditation_verified_failed());
      queryClient.setQueryData(accreditationConnectionQuery.queryKey, result);
      void invalidate();
    },
    onError: (error) => toast.error(describeAccreditationError(error)),
  });
  const disconnect = useGuardedMutation({
    mutationFn: () => call(api().DELETE("/accreditation/connection")),
    onSuccess: () => {
      toast.success(m.accreditation_disconnected_ok({ vendor: connection.label }));
      queryClient.setQueryData(accreditationConnectionQuery.queryKey, { connection: null });
      void invalidate();
    },
  });
  const hints = Object.entries(connection.credentialHints);
  const widget = provider?.handoff === "widget";
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-lg font-semibold">{connection.label}</h3>
        <Badge variant={connection.status === "active" ? "success" : "destructive"}>
          {connection.status === "active"
            ? m.accreditation_connection_active()
            : m.accreditation_connection_error()}
        </Badge>
        <Badge variant="outline">{credentialOptionLabel(connection.environment)}</Badge>
      </div>
      {connection.status === "error" ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{m.accreditation_connection_error_title()}</AlertTitle>
          <AlertDescription>
            <p>{m.accreditation_connection_error_body()}</p>
            {connection.lastError === null ? null : (
              <p className="font-mono text-xs break-all">{connection.lastError}</p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      {provider !== undefined && !provider.offered ? (
        <Alert>
          <AlertTitle>
            {m.accreditation_no_longer_offered_title({ vendor: provider.label })}
          </AlertTitle>
          <AlertDescription>
            {m.accreditation_no_longer_offered_body({ vendor: provider.label })}
          </AlertDescription>
        </Alert>
      ) : null}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{m.accreditation_last_verified()}</dt>
        <dd>
          {connection.lastVerifiedAt === null
            ? m.accreditation_never()
            : formatDateTime(connection.lastVerifiedAt)}
        </dd>
        <dt className="text-muted-foreground">{m.accreditation_last_callback()}</dt>
        <dd>
          {connection.lastCallbackAt === null
            ? m.accreditation_no_callback_yet()
            : formatDateTime(connection.lastCallbackAt)}
        </dd>
        {hints.length === 0 ? null : (
          <>
            <dt className="text-muted-foreground">{m.accreditation_credentials()}</dt>
            <dd>
              <ul className="space-y-1">
                {hints.map(([key, hint]) => {
                  const field = provider?.credentialFields.find((f) => f.key === key);
                  return (
                    <li key={key}>
                      <span>
                        {field === undefined ? key : credentialFieldLabel(connection.driver, field)}
                      </span>{" "}
                      <code className="font-mono text-xs">{hint}</code>
                    </li>
                  );
                })}
              </ul>
            </dd>
          </>
        )}
      </dl>

      <section aria-labelledby="accreditation-callback-heading" className="space-y-3">
        <h3 id="accreditation-callback-heading" className="font-semibold">
          {m.accreditation_callback_title()}
        </h3>
        <p className="text-sm text-muted-foreground">
          {m.accreditation_callback_body({ vendor: connection.label })}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="block min-w-0 flex-1 overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-xs break-all">
            {connection.callbackUrl}
          </code>
          <CopyButton value={connection.callbackUrl} label={m.accreditation_copy_callback_url()} />
        </div>
        {provider === undefined ? null : (
          <p className="text-sm text-muted-foreground">
            {m.accreditation_callback_signature({ signature: provider.callbackSignature })}
          </p>
        )}
      </section>

      {widget ? (
        <section aria-labelledby="accreditation-handoff-heading" className="space-y-3">
          <h3 id="accreditation-handoff-heading" className="font-semibold">
            {m.accreditation_handoff_title()}
          </h3>
          <p className="text-sm text-muted-foreground">
            {m.accreditation_handoff_body({ vendor: connection.label })}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="block min-w-0 flex-1 overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-xs break-all">
              {connection.handoffUrl}
            </code>
            <CopyButton value={connection.handoffUrl} label={m.accreditation_copy_handoff_url()} />
          </div>
        </section>
      ) : null}

      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            loading={verify.isPending}
            onClick={() => verify.mutate()}
          >
            {m.accreditation_verify()}
          </Button>
          <Button type="button" variant="outline" onClick={onReplace}>
            {m.accreditation_replace()}
          </Button>
          <TypedConfirmDialog
            trigger={
              <Button type="button" variant="destructive">
                {m.accreditation_disconnect()}
              </Button>
            }
            title={m.accreditation_disconnect_title({ vendor: connection.label })}
            description={warnRemoval(m.accreditation_disconnect_body())}
            phrase={connection.driver}
            confirmLabel={m.accreditation_disconnect()}
            pending={disconnect.isPending}
            onConfirm={() => disconnect.mutate()}
          />
        </div>
      ) : null}
      {disconnect.isError ? <ErrorAlert error={disconnect.error} /> : null}
      <div className="rounded-md border p-4 text-sm">
        <StrandedNote roundOn={roundOn} />
      </div>
    </div>
  );
}

// --- connect / replace ------------------------------------------------------------------------

function initialValues(provider: AccreditationProvider | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of provider?.credentialFields ?? []) {
    out[field.key] = field.kind === "select" ? (field.options?.[0] ?? "") : "";
  }
  return out;
}

function ConnectForm({
  providers,
  existing,
  roundOn,
  onDone,
  onCancel,
}: {
  providers: readonly AccreditationProvider[];
  existing: AccreditationConnection | null;
  roundOn: boolean;
  onDone: () => void;
  onCancel: (() => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const planAllows = usePlanAllowsFeature("accreditation");
  // The operator's offer, plus the connected vendor itself: a vendor the operator stopped
  // offering can still be re-keyed (same driver), never newly connected.
  const selectable = (p: AccreditationProvider) =>
    p.offered || (existing !== null && existing.driver === p.driver);
  const offered = providers.filter(selectable);
  const first =
    existing !== null && providerOf(offered, existing.driver) !== undefined
      ? existing.driver
      : offered[0]?.driver;
  const [driver, setDriver] = useState<AccreditationVendor | undefined>(first);
  const provider = driver === undefined ? undefined : providerOf(offered, driver);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init = initialValues(provider);
    // Same vendor: start the environment where it is, so a key rotation does not flip it.
    if (existing !== null && existing.driver === driver && "environment" in init) {
      init["environment"] = existing.environment;
    }
    return init;
  });
  // Optional secrets the admin asked to drop (same vendor only).
  const [cleared, setCleared] = useState<ReadonlySet<string>>(() => new Set());
  const base = useId();
  const sameDriver = existing !== null && existing.driver === driver;
  const switching = existing !== null && driver !== undefined && existing.driver !== driver;

  const pick = (next: AccreditationVendor) => {
    setDriver(next);
    setValues(initialValues(providerOf(offered, next)));
    setCleared(new Set());
    save.reset();
  };

  const save = useGuardedMutation({
    mutationFn: () => {
      if (provider === undefined) throw new Error("no provider");
      const credentials: Record<string, string> = {};
      for (const field of provider.credentialFields) {
        const value = (values[field.key] ?? "").trim();
        if (value !== "" && !cleared.has(field.key)) credentials[field.key] = value;
      }
      const clearCredentials = provider.credentialFields
        .filter((f) => cleared.has(f.key))
        .map((f) => f.key);
      return call(
        api().PUT("/accreditation/connection", {
          body: {
            driver: provider.driver,
            credentials,
            ...(clearCredentials.length === 0 ? {} : { clearCredentials }),
          },
        }),
      );
    },
    onSuccess: (result) => {
      queryClient.setQueryData(accreditationConnectionQuery.queryKey, {
        connection: result.connection,
      });
      void queryClient.invalidateQueries({ queryKey: ACCREDITATION_KEY });
      toast.success(m.accreditation_connected_ok({ vendor: result.connection.label }));
      onDone();
    },
  });

  // Same vendor: a blank secret keeps the stored one (the server merges). A new vendor needs all.
  const kept = (field: AccreditationCredentialField): string | undefined =>
    existing !== null && sameDriver && field.kind === "secret" && !cleared.has(field.key)
      ? existing.credentialHints[field.key]
      : undefined;
  const clearable = (field: AccreditationCredentialField): boolean =>
    existing !== null &&
    sameDriver &&
    !field.required &&
    field.kind === "secret" &&
    existing.credentialHints[field.key] !== undefined;
  const toggleCleared = (key: string, on: boolean) =>
    setCleared((cur) => {
      const next = new Set(cur);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const missing =
    provider === undefined ||
    provider.credentialFields.some(
      (f) => f.required && kept(f) === undefined && (values[f.key] ?? "").trim() === "",
    );

  if (offered.length === 0) {
    return (
      <Alert>
        <AlertTitle>{m.accreditation_none_offered_title()}</AlertTitle>
        <AlertDescription>{m.accreditation_none_offered_body()}</AlertDescription>
      </Alert>
    );
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!missing) save.mutate();
      }}
    >
      {existing === null ? null : (
        <Alert>
          <AlertTitle>{m.accreditation_replace_title({ vendor: existing.label })}</AlertTitle>
          <AlertDescription>{m.accreditation_replace_body()}</AlertDescription>
        </Alert>
      )}
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{m.accreditation_field_vendor()}</legend>
        <div className="grid gap-3 md:grid-cols-2">
          {providers.map((p) => {
            const id = `${base}-driver-${p.driver}`;
            return (
              <div key={p.driver} className="flex items-start gap-2 rounded-md border p-3">
                <input
                  id={id}
                  type="radio"
                  name={`${base}-driver`}
                  className="mt-1"
                  value={p.driver}
                  checked={driver === p.driver}
                  disabled={
                    !selectable(p) ||
                    (!planAllows && existing !== null && p.driver !== existing.driver)
                  }
                  aria-describedby={`${id}-desc`}
                  onChange={() => pick(p.driver)}
                />
                <div className="grid gap-1">
                  <label htmlFor={id} className="text-sm font-medium">
                    {p.label}
                  </label>
                  <p id={`${id}-desc`} className="text-xs text-muted-foreground">
                    {selectable(p)
                      ? [
                          p.handoff === "widget"
                            ? m.accreditation_vendor_widget()
                            : m.accreditation_vendor_invite(),
                          p.supportsEntities
                            ? m.accreditation_vendor_entities()
                            : m.accreditation_vendor_individuals_only(),
                          p.certificate ? m.accreditation_vendor_certificate() : null,
                        ]
                          .filter((s) => s !== null)
                          .join(" ")
                      : m.accreditation_vendor_not_offered()}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>

      {switching ? (
        <Alert>
          <AlertTitle>{m.accreditation_switch_title()}</AlertTitle>
          <AlertDescription>
            <StrandedNote roundOn={roundOn} />
          </AlertDescription>
        </Alert>
      ) : null}

      {provider === undefined ? null : (
        <>
          <p className="text-sm text-muted-foreground">
            {m.accreditation_subprocessor({
              vendor: provider.subProcessor.name,
              purpose: provider.subProcessor.purpose,
              location: provider.subProcessor.location,
            })}{" "}
            <a
              href={provider.subProcessor.url}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium underline underline-offset-4"
            >
              {m.accreditation_subprocessor_link({ vendor: provider.subProcessor.name })}
            </a>
          </p>
          <p className="text-sm text-muted-foreground">{m.accreditation_billing_note()}</p>
          {provider.credentialFields.map((field) => (
            <CredentialInput
              key={`${provider.driver}-${field.key}`}
              id={`${base}-${field.key}`}
              driver={provider.driver}
              field={field}
              keptHint={kept(field)}
              value={values[field.key] ?? ""}
              onChange={(value) => setValues((cur) => ({ ...cur, [field.key]: value }))}
              clear={
                clearable(field)
                  ? {
                      checked: cleared.has(field.key),
                      onChange: (on) => toggleCleared(field.key, on),
                    }
                  : undefined
              }
            />
          ))}
          {provider.handoff === "widget" ? (
            <p className="text-sm text-muted-foreground">
              {m.accreditation_widget_redirect_hint({ vendor: provider.label })}
            </p>
          ) : null}
        </>
      )}

      {save.isError ? (
        <SaveRefusal
          error={save.error}
          fieldLabel={(key) => {
            const field = provider?.credentialFields.find((f) => f.key === key);
            return field === undefined || driver === undefined
              ? key
              : credentialFieldLabel(driver, field);
          }}
        />
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          loading={save.isPending}
          disabled={missing || (!planAllows && existing === null)}
        >
          {existing === null ? m.accreditation_connect_submit() : m.accreditation_replace_submit()}
        </Button>
        {onCancel === undefined ? null : (
          <Button type="button" variant="outline" onClick={onCancel}>
            {m.common_cancel()}
          </Button>
        )}
      </div>
    </form>
  );
}

function SaveRefusal({
  error,
  fieldLabel,
}: {
  error: unknown;
  fieldLabel: (key: string) => string;
}) {
  const code = accreditationErrorCode(error);
  if (
    code !== "accreditation_credentials_invalid" &&
    code !== "accreditation_driver_not_offered" &&
    code !== "accreditation_provider_error"
  ) {
    return <ErrorAlert error={error} />;
  }
  const fields = invalidFields(error);
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{m.accreditation_rejected_title()}</AlertTitle>
      <AlertDescription className="space-y-1">
        <p>{describeAccreditationError(error)}</p>
        {fields.length === 0 ? null : (
          <p>{m.accreditation_rejected_fields({ fields: fields.map(fieldLabel).join(", ") })}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}

function CredentialInput({
  id,
  driver,
  field,
  keptHint,
  value,
  onChange,
  clear,
}: {
  id: string;
  driver: AccreditationVendor;
  field: AccreditationCredentialField;
  /** The stored value's mask when leaving this blank keeps it (same vendor, secret field). */
  keptHint: string | undefined;
  value: string;
  onChange: (value: string) => void;
  /** A saved optional secret: the box that removes it on save. */
  clear?: { checked: boolean; onChange: (on: boolean) => void } | undefined;
}) {
  const label = credentialFieldLabel(driver, field);
  const fieldHelp = credentialFieldHelp(driver, field);
  const keepHelp = clear?.checked
    ? m.accreditation_field_cleared()
    : keptHint === undefined
      ? undefined
      : m.accreditation_field_keep({ hint: keptHint });
  const help = [fieldHelp, keepHelp].filter((s) => s !== undefined).join(" ") || undefined;
  const required = field.required && keptHint === undefined;
  const aria = fieldAria(id, { description: help !== undefined });
  const disabled = clear?.checked === true;
  const input = (
    <Field id={id} label={label} description={help} required={required}>
      {field.kind === "select" ? (
        <NativeSelect id={id} value={value} onChange={(e) => onChange(e.target.value)} {...aria}>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {credentialOptionLabel(option)}
            </option>
          ))}
        </NativeSelect>
      ) : (
        <Input
          id={id}
          type={field.kind === "secret" ? "password" : "text"}
          autoComplete={field.kind === "secret" ? "new-password" : "off"}
          spellCheck={false}
          required={required}
          disabled={disabled}
          value={disabled ? "" : value}
          onChange={(e) => onChange(e.target.value)}
          {...aria}
        />
      )}
    </Field>
  );
  if (clear === undefined) return input;
  return (
    <div className="space-y-2">
      {input}
      <div className="flex items-center gap-2">
        <input
          id={`${id}-clear`}
          type="checkbox"
          className="size-4"
          checked={clear.checked}
          onChange={(e) => clear.onChange(e.target.checked)}
        />
        <label htmlFor={`${id}-clear`} className="text-sm">
          {m.accreditation_field_clear({ field: label })}
        </label>
      </div>
    </div>
  );
}
