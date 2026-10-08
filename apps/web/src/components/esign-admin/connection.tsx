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
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { api, call } from "../../lib/api.js";
import {
  credentialFieldHelp,
  credentialFieldLabel,
  credentialOptionLabel,
  describeESignError,
  ESIGN_KEY,
  type ESignConnection,
  type ESignCredentialField,
  type ESignDriver,
  type ESignDriverInfo,
  esignConnectionQuery,
  esignDriversQuery,
  esignErrorCode,
  rejectedDetail,
  retypeFields,
} from "../../lib/esign-queries.js";
import { formatDateTime } from "../../lib/format.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { ConfirmDialog } from "../access/common.js";
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
 * The workspace's one e-signature vendor connection (E3.5, ADR-0053).
 *
 * Three things the admin must not get wrong, and the screen is shaped around them:
 *
 *  - **Credentials are write-only.** The form is generated from the driver's `credentialFields`;
 *    once saved, only masked hints come back, so replacing credentials means typing them all
 *    again. The save verifies them live against the vendor before anything is stored, and a
 *    refusal says which of the three things went wrong (rejected, unreachable, misconfigured).
 *  - **Who owns the callback secret depends on the vendor.** Documenso and DocuSeal ("ours"):
 *    we mint it, it is shown once, and the admin pastes it into the vendor. DocuSign and Dropbox
 *    Sign ("vendor"): the vendor has the key (DocuSign's Connect HMAC key is a credential field;
 *    Dropbox Sign signs with the API key itself), so there is nothing of ours to show or rotate.
 *  - **Disconnecting is refused while it would strand something**: open envelopes, or a legal
 *    document whose ceremony is e-signature. The 409 says which, and where to go.
 */

export interface RevealedSecret {
  readonly title: string;
  readonly secret: string;
  readonly driver: ESignDriver;
}

/** The host of a typed base URL, lower-cased like the server's `baseUrlHost`; `null` if unparsable. */
function hostOf(url: string): string | null {
  try {
    return new URL(url.trim()).host.toLowerCase();
  } catch {
    return null;
  }
}

function driverMeta(
  drivers: readonly ESignDriverInfo[] | undefined,
  driver: ESignDriver,
): ESignDriverInfo | undefined {
  return drivers?.find((d) => d.meta.driver === driver);
}

export function ConnectionCard({
  canManage,
  onSecret,
}: {
  canManage: boolean;
  onSecret: (revealed: RevealedSecret) => void;
}) {
  const connection = useQuery(esignConnectionQuery);
  const drivers = useQuery(esignDriversQuery);
  const [editing, setEditing] = useState(false);
  const current = connection.data?.connection ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.esign_connection_title()}</CardTitle>
        <CardDescription>{m.esign_connection_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* A-3: envelopes keep going out through the existing connection. */}
        <PlanFeatureNotice feature="esign" />
        {connection.isPending || drivers.isPending ? (
          <LoadingState lines={3} label={m.common_loading()} />
        ) : null}
        {connection.isError ? <ErrorAlert error={connection.error} /> : null}
        {drivers.isError ? <ErrorAlert error={drivers.error} /> : null}
        {connection.data && drivers.data ? (
          current === null || editing ? (
            canManage ? (
              <ConnectForm
                drivers={drivers.data.drivers}
                existing={current}
                onDone={(revealed) => {
                  setEditing(false);
                  if (revealed) onSecret(revealed);
                }}
                onCancel={current === null ? undefined : () => setEditing(false)}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{m.esign_not_connected_read_only()}</p>
            )
          ) : (
            <ConnectedSummary
              connection={current}
              info={driverMeta(drivers.data.drivers, current.driver)}
              canManage={canManage}
              onReplace={() => setEditing(true)}
              onSecret={onSecret}
            />
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

// --- connected --------------------------------------------------------------------------------

function ConnectedSummary({
  connection,
  info,
  canManage,
  onReplace,
  onSecret,
}: {
  connection: ESignConnection;
  info: ESignDriverInfo | undefined;
  canManage: boolean;
  onReplace: () => void;
  onSecret: (revealed: RevealedSecret) => void;
}) {
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ESIGN_KEY });
  const secretOwner = connection.callbackSecretKind;
  const warnRemoval = usePlanRemovalWarning("esign");
  // A-3: verify, replace (same vendor), rotate and delete maintain the existing connection,
  // which a plan without `esign` keeps — only a first connection or another vendor needs it.
  const verify = useGuardedMutation({
    mutationFn: () => call(api().POST("/esign/connection/verify")),
    onSuccess: (result) => {
      if (result.connection?.status === "active") toast.success(m.esign_verified_ok());
      else toast.error(m.esign_verified_failed());
      queryClient.setQueryData(esignConnectionQuery.queryKey, result);
      void invalidate();
    },
    onError: (error) => toast.error(describeESignError(error)),
  });
  const rotate = useGuardedMutation({
    mutationFn: () => call(api().POST("/esign/connection/rotate-callback-secret")),
    onSuccess: (result) => {
      queryClient.setQueryData(esignConnectionQuery.queryKey, { connection: result.connection });
      onSecret({
        title: m.esign_secret_rotated_title({ vendor: connection.displayName }),
        secret: result.callbackSecret,
        driver: connection.driver,
      });
      toast.success(m.esign_secret_rotated_ok());
      void invalidate();
    },
    onError: (error) => toast.error(describeESignError(error)),
  });
  const disconnect = useGuardedMutation({
    mutationFn: () => call(api().DELETE("/esign/connection")),
    onSuccess: () => {
      toast.success(m.esign_disconnected_ok({ vendor: connection.displayName }));
      void invalidate();
    },
  });
  const hints = Object.entries(connection.credentialHints);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-lg font-semibold">{connection.displayName}</h3>
        <Badge variant={connection.status === "active" ? "success" : "destructive"}>
          {connection.status === "active"
            ? m.esign_connection_active()
            : m.esign_connection_error()}
        </Badge>
      </div>
      {connection.status === "error" ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{m.esign_connection_error_title()}</AlertTitle>
          <AlertDescription>
            <p>{m.esign_connection_error_body()}</p>
            {connection.lastError === null ? null : (
              <p className="font-mono text-xs break-all">{connection.lastError}</p>
            )}
          </AlertDescription>
        </Alert>
      ) : null}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        {connection.baseUrlHost === null ? null : (
          <>
            <dt className="text-muted-foreground">{m.esign_base_url_host()}</dt>
            <dd className="font-mono text-xs">{connection.baseUrlHost}</dd>
          </>
        )}
        <dt className="text-muted-foreground">{m.esign_last_verified()}</dt>
        <dd>
          {connection.lastVerifiedAt === null
            ? m.esign_never_verified()
            : formatDateTime(connection.lastVerifiedAt)}
        </dd>
        <dt className="text-muted-foreground">{m.esign_supports()}</dt>
        <dd>
          <ul className="flex flex-wrap gap-1">
            {connection.supports.templates ? (
              <li>
                <Badge variant="outline">{m.esign_supports_templates()}</Badge>
              </li>
            ) : null}
            {connection.supports.pdf ? (
              <li>
                <Badge variant="outline">{m.esign_supports_pdf()}</Badge>
              </li>
            ) : null}
            {connection.supports.embeddedSigning ? (
              <li>
                <Badge variant="outline">{m.esign_supports_embedded()}</Badge>
              </li>
            ) : (
              <li>
                <Badge variant="outline">{m.esign_supports_email_only()}</Badge>
              </li>
            )}
            {connection.supports.void ? (
              <li>
                <Badge variant="outline">{m.esign_supports_void()}</Badge>
              </li>
            ) : null}
          </ul>
        </dd>
        {hints.length === 0 ? null : (
          <>
            <dt className="text-muted-foreground">{m.esign_credentials()}</dt>
            <dd>
              <ul className="space-y-1">
                {hints.map(([key, hint]) => {
                  const field = info?.credentialFields.find((f) => f.key === key);
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

      <section aria-labelledby="esign-callback-heading" className="space-y-3">
        <h3 id="esign-callback-heading" className="font-semibold">
          {m.esign_callback_title()}
        </h3>
        <p className="text-sm text-muted-foreground">{m.esign_callback_body()}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="block min-w-0 flex-1 overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-xs break-all">
            {connection.callbackUrl}
          </code>
          <CopyButton value={connection.callbackUrl} label={m.esign_copy_callback_url()} />
        </div>
        <SetupHints driver={connection.driver} />
        {secretOwner === "ours" ? (
          <p className="text-sm text-muted-foreground">{m.esign_secret_lost_hint()}</p>
        ) : null}
      </section>

      {canManage ? (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            loading={verify.isPending}
            onClick={() => verify.mutate()}
          >
            {m.esign_verify()}
          </Button>
          <Button type="button" variant="outline" onClick={onReplace}>
            {m.esign_replace()}
          </Button>
          {secretOwner === "ours" ? (
            <ConfirmDialog
              trigger={
                <Button type="button" variant="outline" disabled={rotate.isPending}>
                  {m.esign_rotate_secret()}
                </Button>
              }
              title={m.esign_rotate_secret_title()}
              description={m.esign_rotate_secret_body({ vendor: connection.displayName })}
              confirmLabel={m.esign_rotate_secret()}
              pending={rotate.isPending}
              onConfirm={() => rotate.mutate()}
            />
          ) : null}
          <TypedConfirmDialog
            trigger={
              <Button type="button" variant="destructive">
                {m.esign_disconnect()}
              </Button>
            }
            title={m.esign_disconnect_title({ vendor: connection.displayName })}
            description={warnRemoval(m.esign_disconnect_body())}
            phrase={connection.driver}
            confirmLabel={m.esign_disconnect()}
            pending={disconnect.isPending}
            onConfirm={() => disconnect.mutate()}
          />
        </div>
      ) : null}
      {disconnect.isError ? <DisconnectRefusal error={disconnect.error} /> : null}
    </div>
  );
}

/** Why a disconnect was refused, and where to go to clear it. */
function DisconnectRefusal({ error }: { error: unknown }) {
  const code = esignErrorCode(error);
  if (code !== "envelopes_open" && code !== "esign_ceremony_in_use") {
    return <ErrorAlert error={error} />;
  }
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{m.esign_disconnect_refused()}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{describeESignError(error)}</p>
        {code === "esign_ceremony_in_use" ? (
          <p>
            <Link to="/admin/legal" className="font-medium underline underline-offset-4">
              {m.esign_go_to_legal()}
            </Link>
          </p>
        ) : (
          <p>{m.esign_envelopes_open_hint()}</p>
        )}
      </AlertDescription>
    </Alert>
  );
}

/**
 * Where the callback URL (and, for some vendors, the secret) goes on the vendor's side. Written
 * per vendor because each hides it somewhere else, and because "vendor"-secret drivers need the
 * opposite instruction: paste *their* key into *our* form.
 */
export function SetupHints({ driver }: { driver: ESignDriver }) {
  const steps = setupSteps(driver);
  const note = setupNote(driver);
  return (
    <div className="space-y-2 rounded-md border p-4 text-sm">
      <p className="font-medium">{m.esign_setup_title()}</p>
      <ol className="list-decimal space-y-1 pl-5">
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {note === undefined ? null : <p className="text-muted-foreground">{note}</p>}
    </div>
  );
}

function setupSteps(driver: ESignDriver): string[] {
  switch (driver) {
    case "documenso":
      return [
        m.esign_setup_documenso_1(),
        m.esign_setup_documenso_2(),
        m.esign_setup_documenso_3(),
      ];
    case "docuseal":
      return [m.esign_setup_docuseal_1(), m.esign_setup_docuseal_2(), m.esign_setup_docuseal_3()];
    case "docusign":
      return [m.esign_setup_docusign_1(), m.esign_setup_docusign_2(), m.esign_setup_docusign_3()];
    case "dropbox-sign":
      return [m.esign_setup_dropbox_sign_1(), m.esign_setup_dropbox_sign_2()];
  }
}

function setupNote(driver: ESignDriver): string | undefined {
  switch (driver) {
    case "docuseal":
      return m.esign_setup_docuseal_note();
    case "docusign":
      return m.esign_setup_docusign_note();
    case "dropbox-sign":
      return m.esign_setup_dropbox_sign_note();
    default:
      return undefined;
  }
}

// --- connect / replace ------------------------------------------------------------------------

function initialValues(info: ESignDriverInfo | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of info?.credentialFields ?? []) {
    out[field.key] = field.kind === "select" ? (field.options?.[0] ?? "") : "";
  }
  return out;
}

function ConnectForm({
  drivers,
  existing,
  onDone,
  onCancel,
}: {
  drivers: readonly ESignDriverInfo[];
  existing: ESignConnection | null;
  onDone: (revealed: RevealedSecret | undefined) => void;
  onCancel: (() => void) | undefined;
}) {
  const queryClient = useQueryClient();
  const planAllows = usePlanAllowsFeature("esign");
  const first = existing?.driver ?? drivers[0]?.meta.driver;
  const [driver, setDriver] = useState<ESignDriver | undefined>(first);
  const info = driver === undefined ? undefined : driverMeta(drivers, driver);
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(info));
  const [baseUrl, setBaseUrl] = useState("");
  // Optional secrets the admin asked to drop (same vendor only; A5).
  const [cleared, setCleared] = useState<ReadonlySet<string>>(() => new Set());
  // Secrets the server said must be typed again (422 `esign_credentials_required`, A4).
  const [retype, setRetype] = useState<ReadonlySet<string>>(() => new Set());
  const base = useId();
  const showBaseUrl = info !== undefined && (info.meta.selfHostable || info.meta.baseUrl.required);
  const sameDriver = existing !== null && existing.driver === driver;
  // The server stores the full base URL but shows only its host, so the form cannot prefill it:
  // the saved host is the field's placeholder, and on a same-vendor save an empty field keeps the
  // saved address (the body omits `baseUrl`), so rotating one key never means retyping the rest.
  // A *different* address never reuses stored secrets (they would go to a host they were never
  // given to): every one must be typed again. Same host, other path: only the server can tell,
  // and its 422 `esign_credentials_required` names the fields.
  const savedBaseHost = sameDriver && showBaseUrl ? (existing?.baseUrlHost ?? null) : null;
  const addressChanges =
    sameDriver && showBaseUrl && baseUrl.trim() !== "" && hostOf(baseUrl) !== savedBaseHost;
  /** An address is needed: the vendor has no default and there is no saved one to keep. */
  const baseUrlRequired = info?.meta.baseUrl.required === true && savedBaseHost === null;

  const pick = (next: ESignDriver) => {
    setDriver(next);
    setValues(initialValues(driverMeta(drivers, next)));
    setBaseUrl("");
    setCleared(new Set());
    setRetype(new Set());
    save.reset();
  };

  const save = useGuardedMutation({
    mutationFn: () => {
      if (info === undefined) throw new Error("no driver");
      const credentials: Record<string, string> = {};
      for (const field of info.credentialFields) {
        const value =
          field.kind === "pem" ? (values[field.key] ?? "") : (values[field.key] ?? "").trim();
        if (value !== "" && !cleared.has(field.key)) credentials[field.key] = value;
      }
      const clearCredentials = info.credentialFields
        .filter((f) => cleared.has(f.key))
        .map((f) => f.key);
      return call(
        api().PUT("/esign/connection", {
          body: {
            driver: info.meta.driver,
            credentials,
            ...(showBaseUrl && baseUrl.trim() !== "" ? { baseUrl: baseUrl.trim() } : {}),
            ...(clearCredentials.length === 0 ? {} : { clearCredentials }),
          },
        }),
      );
    },
    onError: (error) => {
      const fields = retypeFields(error);
      if (fields !== undefined) setRetype(new Set(fields));
    },
    onSuccess: (result) => {
      queryClient.setQueryData(esignConnectionQuery.queryKey, { connection: result.connection });
      void queryClient.invalidateQueries({ queryKey: ESIGN_KEY });
      toast.success(m.esign_connected_ok({ vendor: result.connection.displayName }));
      onDone(
        result.callbackSecret === undefined
          ? undefined
          : {
              title: m.esign_secret_title({ vendor: result.connection.displayName }),
              secret: result.callbackSecret,
              driver: result.connection.driver,
            },
      );
    },
  });

  // Same vendor: a blank secret or key keeps the stored one (the server merges), so the admin
  // can change one credential without retyping the others. A new vendor needs every field.
  const kept = (field: ESignCredentialField): string | undefined =>
    existing !== null &&
    sameDriver &&
    (field.kind === "secret" || field.kind === "pem") &&
    !cleared.has(field.key) &&
    !retype.has(field.key) &&
    !addressChanges
      ? existing.credentialHints[field.key]
      : undefined;
  /** A saved optional secret can be removed outright (a blank field keeps it). */
  const clearable = (field: ESignCredentialField): boolean =>
    existing !== null &&
    sameDriver &&
    !field.required &&
    (field.kind === "secret" || field.kind === "pem") &&
    existing.credentialHints[field.key] !== undefined;
  const toggleCleared = (key: string, on: boolean) =>
    setCleared((cur) => {
      const next = new Set(cur);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const missing =
    info === undefined ||
    info.credentialFields.some(
      (f) => f.required && kept(f) === undefined && (values[f.key] ?? "").trim() === "",
    ) ||
    (baseUrlRequired && baseUrl.trim() === "");

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
          <AlertTitle>{m.esign_replace_title({ vendor: existing.displayName })}</AlertTitle>
          <AlertDescription>{m.esign_replace_body()}</AlertDescription>
        </Alert>
      )}
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{m.esign_field_vendor()}</legend>
        <div className="grid gap-3 md:grid-cols-2">
          {drivers.map((d) => {
            const id = `${base}-driver-${d.meta.driver}`;
            return (
              <div key={d.meta.driver} className="flex items-start gap-2 rounded-md border p-3">
                <input
                  id={id}
                  type="radio"
                  name={`${base}-driver`}
                  className="mt-1"
                  value={d.meta.driver}
                  checked={driver === d.meta.driver}
                  disabled={!planAllows && existing !== null && d.meta.driver !== existing.driver}
                  aria-describedby={`${id}-desc`}
                  onChange={() => pick(d.meta.driver)}
                />
                <div className="grid gap-1">
                  <label htmlFor={id} className="text-sm font-medium">
                    {d.meta.displayName}
                  </label>
                  <p id={`${id}-desc`} className="text-xs text-muted-foreground">
                    {d.meta.selfHostable ? m.esign_vendor_self_hostable() : m.esign_vendor_cloud()}{" "}
                    {d.meta.supports.embeddedSigning
                      ? m.esign_vendor_embedded()
                      : m.esign_vendor_email_only()}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>

      {info === undefined ? null : (
        <>
          <p className="text-sm text-muted-foreground">
            {m.esign_subprocessor({
              vendor: info.meta.subProcessor.name,
              region: info.meta.subProcessor.region,
            })}{" "}
            <a
              href={info.meta.subProcessor.dpaUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="font-medium underline underline-offset-4"
            >
              {m.esign_subprocessor_dpa({ vendor: info.meta.subProcessor.name })}
            </a>
          </p>
          {showBaseUrl ? (
            <Field
              id={`${base}-base-url`}
              label={m.esign_field_base_url()}
              description={
                savedBaseHost !== null
                  ? m.esign_field_base_url_keep({ host: savedBaseHost })
                  : info.meta.baseUrl.default === undefined
                    ? m.esign_field_base_url_hint_required()
                    : m.esign_field_base_url_hint({ origin: info.meta.baseUrl.default })
              }
              required={baseUrlRequired}
            >
              <Input
                id={`${base}-base-url`}
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                required={baseUrlRequired}
                placeholder={savedBaseHost ?? undefined}
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                {...fieldAria(`${base}-base-url`, { description: true })}
              />
            </Field>
          ) : null}
          {addressChanges ? (
            <Alert>
              <AlertTitle>{m.esign_base_url_change_title()}</AlertTitle>
              <AlertDescription>{m.esign_base_url_change_body()}</AlertDescription>
            </Alert>
          ) : null}
          {info.credentialFields.map((field) => (
            <CredentialInput
              key={`${info.meta.driver}-${field.key}`}
              id={`${base}-${field.key}`}
              driver={info.meta.driver}
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
          {info.meta.callbackSecret === "vendor" ? (
            <p className="text-sm text-muted-foreground">{m.esign_vendor_secret_hint()}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{m.esign_ours_secret_hint()}</p>
          )}
        </>
      )}

      {save.isError ? (
        <SaveRefusal
          error={save.error}
          fieldLabel={(key) => {
            const field = info?.credentialFields.find((f) => f.key === key);
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
          {existing === null ? m.esign_connect_submit() : m.esign_replace_submit()}
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
  const code = esignErrorCode(error);
  const retyped = retypeFields(error);
  if (retyped !== undefined) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>{m.esign_credentials_required_title()}</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>{describeESignError(error)}</p>
          {retyped.length === 0 ? null : (
            <p>
              {m.esign_credentials_required_fields({ fields: retyped.map(fieldLabel).join(", ") })}
            </p>
          )}
        </AlertDescription>
      </Alert>
    );
  }
  if (code !== "esign_credentials_rejected" && code !== "envelopes_open") {
    return <ErrorAlert error={error} />;
  }
  const detail = rejectedDetail(error);
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>
        {code === "envelopes_open" ? m.esign_replace_refused() : m.esign_rejected_title()}
      </AlertTitle>
      <AlertDescription className="space-y-1">
        <p>{describeESignError(error)}</p>
        {detail === undefined ? null : <p className="font-mono text-xs break-all">{detail}</p>}
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
  driver: ESignDriver;
  field: ESignCredentialField;
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
    ? m.esign_field_cleared()
    : keptHint === undefined
      ? undefined
      : m.esign_field_keep({ hint: keptHint });
  const help =
    fieldHelp === undefined
      ? keepHelp
      : keepHelp === undefined
        ? fieldHelp
        : `${fieldHelp} ${keepHelp}`;
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
      ) : field.kind === "pem" ? (
        <Textarea
          id={id}
          rows={6}
          className="font-mono text-xs"
          autoComplete="off"
          spellCheck={false}
          required={required}
          disabled={disabled}
          value={disabled ? "" : value}
          onChange={(e) => onChange(e.target.value)}
          {...aria}
        />
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
          {m.esign_field_clear({ field: label })}
        </label>
      </div>
    </div>
  );
}
