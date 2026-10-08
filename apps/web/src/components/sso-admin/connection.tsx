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
import { TriangleAlert } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { callNoContent } from "../../lib/access-admin-queries.js";
import { api, call, isPlanEntitlementRefusal } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import {
  JIT_ROLES,
  protocolLabel,
  type SaveSsoConnectionBody,
  SSO_KEY,
  type SsoConnection,
  type SsoConnectionResponse,
  type SsoEnforce,
  type SsoProtocol,
  type StaffJitRole,
  splitLines,
  splitPems,
  ssoConnectionQuery,
  ssoTestNavigation,
} from "../../lib/sso-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { ConfirmDialog, roleLabel } from "../access/common.js";
import {
  PlanChangeHint,
  PlanFeatureNotice,
  usePlanAllowsFeature,
  usePlanRemovalWarning,
} from "../billing/plan-feature-notice.js";
import { NativeSelect } from "../compliance/common.js";
import { ErrorAlert } from "../error-alert.js";
import { SpInfoPanel, SsoRefusal } from "./common.js";

/*
 * The workspace's one SSO connection (E3.8, ADR-0056).
 *
 * What the admin must not get wrong, and the screen is shaped around it:
 *
 *  - **No connection is a valid state.** Staff sign in with email codes and passkeys.
 *  - **The operator decides which protocols are offered** (`protocolsOffered`).
 *  - **Secrets are write-only.** A blank client secret keeps the saved one — except when the
 *    issuer changes (a new provider must not inherit the old one's secret) or there is none.
 *  - **Test before enforcing.** "Test sign-in" runs the full round trip without signing
 *    anyone in; enforcement needs the connection on and one successful sign-in or test.
 *  - **Enforcement has a break-glass.** An owner with a passkey or authenticator app can
 *    still sign in without SSO, so a broken identity provider never locks the workspace.
 */
export function SsoConnectionCard({ canManage }: { canManage: boolean }) {
  const connection = useQuery(ssoConnectionQuery);
  // A-3: without `sso` on the plan nothing new can be connected or switched on; the existing
  // connection keeps signing people in, and can still be maintained (same protocol), tested,
  // switched off or deleted.
  const planAllows = usePlanAllowsFeature("sso");
  const [editing, setEditing] = useState(false);
  const data = connection.data;
  const current = data?.connection ?? null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.sso_admin_connection_title()}</CardTitle>
        <CardDescription>{m.sso_admin_connection_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <PlanFeatureNotice feature="sso" />
        {connection.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
        {connection.isError ? <ErrorAlert error={connection.error} /> : null}
        {data === undefined ? null : current === null || (editing && canManage) ? (
          <>
            {current === null ? (
              <p className="text-sm text-muted-foreground">{m.sso_admin_not_connected()}</p>
            ) : null}
            {!canManage ? (
              <p className="text-sm text-muted-foreground">
                {m.sso_admin_not_connected_read_only()}
              </p>
            ) : data.protocolsOffered.length === 0 && current === null ? (
              <Alert>
                <AlertTitle>{m.sso_admin_none_offered_title()}</AlertTitle>
                <AlertDescription>{m.sso_admin_none_offered_body()}</AlertDescription>
              </Alert>
            ) : (
              <ConnectionForm
                data={data}
                existing={current}
                planAllows={planAllows}
                onDone={() => setEditing(false)}
                onCancel={current === null ? undefined : () => setEditing(false)}
              />
            )}
          </>
        ) : (
          <>
            <ConnectionSummary
              connection={current}
              canManage={canManage}
              onEdit={() => setEditing(true)}
            />
            <SignInPolicy connection={current} canManage={canManage} planAllows={planAllows} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function useSetConnection() {
  const queryClient = useQueryClient();
  return (connection: SsoConnection | null) => {
    queryClient.setQueryData<SsoConnectionResponse>(ssoConnectionQuery.queryKey, (prev) =>
      prev === undefined
        ? prev
        : { ...prev, connection, spPreview: connection === null ? null : connection.sp },
    );
    void queryClient.invalidateQueries({ queryKey: SSO_KEY });
  };
}

// --- connected --------------------------------------------------------------------------------

function ConnectionSummary({
  connection,
  canManage,
  onEdit,
}: {
  connection: SsoConnection;
  canManage: boolean;
  onEdit: () => void;
}) {
  const setConnection = useSetConnection();
  const spHeading = useId();
  const warnRemoval = usePlanRemovalWarning("sso");
  const test = useGuardedMutation({
    mutationFn: () => call(api().POST("/auth/sso/begin", { body: { test: true } })),
    onSuccess: (result) => ssoTestNavigation.assign(result.url),
  });
  const remove = useGuardedMutation({
    mutationFn: () => callNoContent(api().DELETE("/sso/connection")),
    onSuccess: () => {
      toast.success(m.sso_admin_deleted_ok());
      setConnection(null);
    },
  });
  const never = m.sso_admin_never();
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-lg font-semibold">{connection.name}</h3>
        <Badge variant="outline">{protocolLabel(connection.protocol)}</Badge>
        <Badge variant={connection.enabled ? "success" : "secondary"}>
          {connection.enabled ? m.sso_admin_state_on() : m.sso_admin_state_off()}
        </Badge>
        {connection.enforce === "staff" ? (
          <Badge variant="warning">{m.sso_admin_badge_enforced()}</Badge>
        ) : null}
        {connection.status === "error" ? (
          <Badge variant="destructive">{m.sso_admin_status_error()}</Badge>
        ) : null}
      </div>
      {connection.lastError === null ? null : (
        <Alert variant={connection.status === "error" ? "destructive" : "default"}>
          <AlertTitle>{m.sso_admin_last_error_title()}</AlertTitle>
          <AlertDescription>
            <p className="font-mono text-xs break-all">{connection.lastError}</p>
          </AlertDescription>
        </Alert>
      )}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        {connection.oidc === null ? null : (
          <>
            <dt className="text-muted-foreground">{m.sso_admin_field_issuer()}</dt>
            <dd className="break-all">{connection.oidc.issuer}</dd>
            <dt className="text-muted-foreground">{m.sso_admin_field_client_id()}</dt>
            <dd className="break-all">{connection.oidc.clientId}</dd>
            <dt className="text-muted-foreground">{m.sso_admin_field_client_secret()}</dt>
            <dd>
              {connection.oidc.hasSecret ? m.sso_admin_secret_saved() : m.sso_admin_secret_none()}
            </dd>
          </>
        )}
        {connection.saml === null ? null : (
          <>
            <dt className="text-muted-foreground">{m.sso_admin_field_idp_entity_id()}</dt>
            <dd className="break-all">{connection.saml.idpEntityId}</dd>
            <dt className="text-muted-foreground">{m.sso_admin_field_idp_sso_url()}</dt>
            <dd className="break-all">{connection.saml.idpSsoUrl}</dd>
            <dt className="text-muted-foreground">{m.sso_admin_field_certificates()}</dt>
            <dd>
              <ul className="space-y-1">
                {connection.saml.certificates.map((cert) => (
                  <li key={cert.fingerprintSha256}>
                    <span>{cert.subject}</span>{" "}
                    <span className="text-muted-foreground">
                      {m.sso_admin_cert_expires({ date: formatDateTime(cert.notAfter) })}
                    </span>
                    <code className="block font-mono text-xs break-all">
                      {cert.fingerprintSha256}
                    </code>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">{m.sso_admin_jit_label()}</dt>
        <dd>
          {connection.jit.enabled
            ? m.sso_admin_jit_on({ role: roleLabel(connection.jit.role) })
            : m.sso_admin_jit_off()}
        </dd>
        <dt className="text-muted-foreground">{m.sso_admin_mfa_label()}</dt>
        <dd>
          {connection.mfa.trust
            ? m.sso_admin_mfa_trusted()
            : connection.mfa.values.length === 0
              ? m.sso_admin_mfa_not_trusted()
              : m.sso_admin_mfa_values({ values: connection.mfa.values.join(", ") })}
        </dd>
        <dt className="text-muted-foreground">{m.sso_admin_last_verified()}</dt>
        <dd>
          {connection.lastVerifiedAt === null ? never : formatDateTime(connection.lastVerifiedAt)}
        </dd>
        <dt className="text-muted-foreground">{m.sso_admin_last_tested()}</dt>
        <dd>
          {connection.lastTestedAt === null ? never : formatDateTime(connection.lastTestedAt)}
        </dd>
        <dt className="text-muted-foreground">{m.sso_admin_last_login()}</dt>
        <dd>{connection.lastLoginAt === null ? never : formatDateTime(connection.lastLoginAt)}</dd>
      </dl>

      <SpInfoPanel protocol={connection.protocol} sp={connection.sp} headingId={spHeading} />

      {canManage ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              loading={test.isPending}
              onClick={() => test.mutate()}
            >
              {m.sso_admin_test()}
            </Button>
            <Button type="button" variant="outline" onClick={onEdit}>
              {m.sso_admin_edit()}
            </Button>
            <ConfirmDialog
              trigger={
                <Button type="button" variant="destructive">
                  {m.sso_admin_delete()}
                </Button>
              }
              title={m.sso_admin_delete_title({ name: connection.name })}
              description={warnRemoval(m.sso_admin_delete_body())}
              confirmLabel={m.sso_admin_delete()}
              pending={remove.isPending}
              onConfirm={() => remove.mutate()}
            />
          </div>
          <p className="text-sm text-muted-foreground">{m.sso_admin_test_help()}</p>
        </div>
      ) : null}
      {test.isError ? (
        <SsoRefusal error={test.error} title={m.sso_admin_test_failed_title()} />
      ) : null}
      {remove.isError ? <SsoRefusal error={remove.error} /> : null}
    </div>
  );
}

// --- enable / enforce -------------------------------------------------------------------------

function SignInPolicy({
  connection,
  canManage,
  planAllows,
}: {
  connection: SsoConnection;
  canManage: boolean;
  /** Without it, sign-in and enforcement can only be switched off, not on (A-3). */
  planAllows: boolean;
}) {
  const base = useId();
  const setConnection = useSetConnection();
  const [enabled, setEnabled] = useState(connection.enabled);
  const [enforce, setEnforce] = useState<SsoEnforce>(connection.enforce);
  const save = useGuardedMutation({
    mutationFn: (body: { enabled: boolean; enforce: SsoEnforce }) =>
      call(api().PUT("/sso/connection/state", { body })),
    onSuccess: (result) => {
      toast.success(m.sso_admin_state_saved());
      setEnabled(result.connection.enabled);
      setEnforce(result.connection.enforce);
      setConnection(result.connection);
    },
  });
  const changed = enabled !== connection.enabled || enforce !== connection.enforce;
  const headingId = `${base}-policy`;
  if (!canManage) {
    return (
      <section aria-labelledby={headingId} className="space-y-2">
        <h3 id={headingId} className="font-semibold">
          {m.sso_admin_policy_title()}
        </h3>
        <p className="text-sm">
          {connection.enforce === "staff"
            ? m.sso_admin_policy_read_enforced()
            : connection.enabled
              ? m.sso_admin_policy_read_optional()
              : m.sso_admin_policy_read_off()}
        </p>
      </section>
    );
  }
  return (
    <form
      aria-labelledby={headingId}
      className="space-y-4 rounded-md border p-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (changed) save.mutate({ enabled, enforce: enabled ? enforce : "off" });
      }}
    >
      <h3 id={headingId} className="font-semibold">
        {m.sso_admin_policy_title()}
      </h3>
      <div className="flex items-start gap-2">
        <input
          id={`${base}-enabled`}
          type="checkbox"
          className="mt-1 size-4"
          checked={enabled}
          disabled={!planAllows && !connection.enabled}
          aria-describedby={`${base}-enabled-desc`}
          onChange={(e) => {
            setEnabled(e.target.checked);
            if (!e.target.checked) setEnforce("off");
            save.reset();
          }}
        />
        <div className="grid gap-1">
          <label htmlFor={`${base}-enabled`} className="text-sm font-medium">
            {m.sso_admin_enabled_label({ name: connection.name })}
          </label>
          <p id={`${base}-enabled-desc`} className="text-xs text-muted-foreground">
            {m.sso_admin_enabled_help()}
          </p>
        </div>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{m.sso_admin_enforce_legend()}</legend>
        {(["off", "staff"] as const).map((value) => {
          const id = `${base}-enforce-${value}`;
          return (
            <div key={value} className="flex items-start gap-2">
              <input
                id={id}
                type="radio"
                name={`${base}-enforce`}
                className="mt-1"
                value={value}
                checked={enforce === value}
                disabled={
                  value === "staff" && (!enabled || (!planAllows && connection.enforce !== "staff"))
                }
                aria-describedby={`${id}-desc`}
                onChange={() => {
                  setEnforce(value);
                  save.reset();
                }}
              />
              <div className="grid gap-1">
                <label htmlFor={id} className="text-sm font-medium">
                  {value === "off" ? m.sso_admin_enforce_off() : m.sso_admin_enforce_staff()}
                </label>
                <p id={`${id}-desc`} className="text-xs text-muted-foreground">
                  {value === "off"
                    ? m.sso_admin_enforce_off_help()
                    : m.sso_admin_enforce_staff_help()}
                </p>
              </div>
            </div>
          );
        })}
        <p className="text-xs text-muted-foreground">
          {m.sso_admin_enforce_api_keys()}{" "}
          <Link to="/admin/api-keys" className="font-medium underline underline-offset-4">
            {m.sso_admin_enforce_api_keys_link()}
          </Link>
        </p>
      </fieldset>
      {enforce === "staff" ? (
        <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>{m.sso_admin_breakglass_title()}</AlertTitle>
          <AlertDescription>
            <p>{m.sso_admin_breakglass_body()}</p>
          </AlertDescription>
        </Alert>
      ) : null}
      {save.isError ? (
        <SsoRefusal error={save.error} title={m.sso_admin_policy_refused_title()} />
      ) : null}
      <Button type="submit" loading={save.isPending} disabled={!changed}>
        {m.sso_admin_policy_save()}
      </Button>
    </form>
  );
}

// --- create / edit ----------------------------------------------------------------------------

type SamlSource = "metadata" | "manual";

function ConnectionForm({
  data,
  existing,
  planAllows,
  onDone,
  onCancel,
}: {
  data: SsoConnectionResponse;
  existing: SsoConnection | null;
  planAllows: boolean;
  onDone: () => void;
  onCancel: (() => void) | undefined;
}) {
  const base = useId();
  const setConnection = useSetConnection();
  // The operator's offer, plus the connection's own protocol (it keeps working when withdrawn).
  const offered: SsoProtocol[] = (["oidc", "saml"] as const).filter(
    (p) => data.protocolsOffered.includes(p) || existing?.protocol === p,
  );
  const [protocol, setProtocol] = useState<SsoProtocol | undefined>(
    existing?.protocol ?? (offered.length === 1 ? offered[0] : undefined),
  );
  const [name, setName] = useState(existing?.name ?? "");
  const [issuer, setIssuer] = useState(existing?.oidc?.issuer ?? "");
  const [clientId, setClientId] = useState(existing?.oidc?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [samlSource, setSamlSource] = useState<SamlSource>(
    existing?.saml != null ? "manual" : "metadata",
  );
  const [metadataXml, setMetadataXml] = useState("");
  const [idpEntityId, setIdpEntityId] = useState(existing?.saml?.idpEntityId ?? "");
  const [idpSsoUrl, setIdpSsoUrl] = useState(existing?.saml?.idpSsoUrl ?? "");
  const [certificates, setCertificates] = useState("");
  const [jitEnabled, setJitEnabled] = useState(existing?.jit.enabled ?? false);
  const [jitRole, setJitRole] = useState<StaffJitRole>(existing?.jit.role ?? "viewer");
  const [mfaTrust, setMfaTrust] = useState(existing?.mfa.trust ?? false);
  const [mfaValues, setMfaValues] = useState((existing?.mfa.values ?? []).join("\n"));

  // A blank secret keeps the saved one only for the same OIDC provider that has one.
  const savedOidc = existing?.oidc ?? null;
  const secretKept = savedOidc?.hasSecret === true && issuer.trim() === savedOidc.issuer;
  // Certificates come back as fingerprints only, so a blank box keeps the saved ones.
  const certsKept = existing?.saml != null;
  // A-3 (RR3 RM2, decision 18): on a plan without SSO the existing connection can be re-keyed,
  // not pointed at another identity provider (a new issuer / IdP entity ID is a new connection),
  // and JIT accounts / trusted IdP MFA cannot be switched on. The OIDC issuer and the typed
  // SAML entity ID are compared here; pasted metadata can only be checked by the server.
  const frozen = !planAllows && existing !== null;
  const issuerChanged =
    frozen && protocol === "oidc" && savedOidc !== null && issuer.trim() !== savedOidc.issuer;
  const entityChanged =
    frozen &&
    protocol === "saml" &&
    samlSource === "manual" &&
    existing?.saml != null &&
    idpEntityId.trim() !== existing.saml.idpEntityId;
  const identityChanged = issuerChanged || entityChanged;
  const frozenHelp = frozen ? m.sso_admin_plan_same_provider() : undefined;
  const withFrozen = (help: string): string =>
    frozenHelp === undefined ? help : `${help} ${frozenHelp}`;
  // Switching them off, or keeping them on, is allowed; switching them on is not.
  const jitLocked = frozen && existing?.jit.enabled !== true && !jitEnabled;
  const mfaLocked = frozen && existing?.mfa.trust !== true && !mfaTrust;

  const save = useGuardedMutation({
    mutationFn: () => {
      const common = {
        name: name.trim(),
        jit: { enabled: jitEnabled, role: jitRole },
        mfa: { trust: mfaTrust, values: splitLines(mfaValues) },
      };
      let body: SaveSsoConnectionBody;
      if (protocol === "oidc") {
        const secret = clientSecret.trim();
        body = {
          ...common,
          protocol,
          issuer: issuer.trim(),
          clientId: clientId.trim(),
          ...(secret === "" ? {} : { clientSecret: secret }),
        };
      } else if (samlSource === "metadata") {
        body = { ...common, protocol: "saml", metadataXml: metadataXml.trim() };
      } else {
        const pems = splitPems(certificates);
        body = {
          ...common,
          protocol: "saml",
          idpEntityId: idpEntityId.trim(),
          idpSsoUrl: idpSsoUrl.trim(),
          ...(pems.length === 0 ? {} : { certificates: pems }),
        };
      }
      return call(api().PUT("/sso/connection", { body }));
    },
    onSuccess: (result) => {
      toast.success(m.sso_admin_saved_ok({ name: result.connection.name }));
      setConnection(result.connection);
      onDone();
    },
  });

  const blank = (s: string) => s.trim() === "";
  const missing =
    protocol === undefined ||
    blank(name) ||
    (protocol === "oidc"
      ? blank(issuer) || blank(clientId) || (!secretKept && blank(clientSecret))
      : samlSource === "metadata"
        ? blank(metadataXml)
        : blank(idpEntityId) || blank(idpSsoUrl) || (!certsKept && blank(certificates)));

  const pick = (next: SsoProtocol) => {
    setProtocol(next);
    save.reset();
  };

  const sp = existing?.sp ?? data.spPreview;
  const secretHelp = secretKept
    ? m.sso_admin_secret_keep()
    : savedOidc?.hasSecret === true && !issuerChanged
      ? m.sso_admin_secret_issuer_changed()
      : undefined;
  const certHelp = certsKept ? m.sso_admin_certs_keep() : m.sso_admin_certs_help();

  return (
    <form
      className="space-y-6"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!missing) save.mutate();
      }}
    >
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">{m.sso_admin_field_protocol()}</legend>
        <div className="grid gap-3 md:grid-cols-2">
          {offered.map((p) => {
            const id = `${base}-protocol-${p}`;
            return (
              <div key={p} className="flex items-start gap-2 rounded-md border p-3">
                <input
                  id={id}
                  type="radio"
                  name={`${base}-protocol`}
                  className="mt-1"
                  value={p}
                  checked={protocol === p}
                  // A-3: on a plan without SSO the existing connection can be maintained (new
                  // certificate, secret, metadata) but not switched to another protocol.
                  disabled={!planAllows && existing !== null && p !== existing.protocol}
                  aria-describedby={`${id}-desc`}
                  onChange={() => pick(p)}
                />
                <div className="grid gap-1">
                  <label htmlFor={id} className="text-sm font-medium">
                    {protocolLabel(p)}
                  </label>
                  <p id={`${id}-desc`} className="text-xs text-muted-foreground">
                    {p === "oidc"
                      ? m.sso_admin_protocol_oidc_help()
                      : m.sso_admin_protocol_saml_help()}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>

      {existing !== null && protocol !== undefined && protocol !== existing.protocol ? (
        <Alert>
          <AlertTitle>{m.sso_admin_switch_title()}</AlertTitle>
          <AlertDescription>{m.sso_admin_switch_body()}</AlertDescription>
        </Alert>
      ) : null}

      {protocol === undefined ? null : (
        <>
          <SpInfoPanel protocol={protocol} sp={sp} headingId={`${base}-sp`} />
          <TextField
            id={`${base}-name`}
            label={m.sso_admin_field_name()}
            help={m.sso_admin_field_name_help()}
            value={name}
            onChange={setName}
            required
            maxLength={100}
          />
          {protocol === "oidc" ? (
            <>
              <TextField
                id={`${base}-issuer`}
                label={m.sso_admin_field_issuer()}
                help={withFrozen(m.sso_admin_field_issuer_help())}
                error={issuerChanged ? m.sso_admin_plan_provider_changed() : undefined}
                value={issuer}
                onChange={setIssuer}
                required
                type="url"
              />
              <TextField
                id={`${base}-client-id`}
                label={m.sso_admin_field_client_id()}
                value={clientId}
                onChange={setClientId}
                required
              />
              <TextField
                id={`${base}-client-secret`}
                label={m.sso_admin_field_client_secret()}
                help={secretHelp}
                value={clientSecret}
                onChange={setClientSecret}
                required={!secretKept}
                type="password"
              />
            </>
          ) : (
            <>
              <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{m.sso_admin_saml_source()}</legend>
                {(["metadata", "manual"] as const).map((value) => {
                  const id = `${base}-saml-${value}`;
                  return (
                    <div key={value} className="flex items-center gap-2">
                      <input
                        id={id}
                        type="radio"
                        name={`${base}-saml-source`}
                        value={value}
                        checked={samlSource === value}
                        onChange={() => {
                          setSamlSource(value);
                          save.reset();
                        }}
                      />
                      <label htmlFor={id} className="text-sm">
                        {value === "metadata"
                          ? m.sso_admin_saml_source_metadata()
                          : m.sso_admin_saml_source_manual()}
                      </label>
                    </div>
                  );
                })}
              </fieldset>
              {samlSource === "metadata" ? (
                <TextAreaField
                  id={`${base}-metadata`}
                  label={m.sso_admin_field_metadata()}
                  help={withFrozen(m.sso_admin_field_metadata_help())}
                  value={metadataXml}
                  onChange={setMetadataXml}
                  required
                  mono
                />
              ) : (
                <>
                  <TextField
                    id={`${base}-entity-id`}
                    label={m.sso_admin_field_idp_entity_id()}
                    help={frozenHelp}
                    error={entityChanged ? m.sso_admin_plan_provider_changed() : undefined}
                    value={idpEntityId}
                    onChange={setIdpEntityId}
                    required
                  />
                  <TextField
                    id={`${base}-sso-url`}
                    label={m.sso_admin_field_idp_sso_url()}
                    help={m.sso_admin_field_idp_sso_url_help()}
                    value={idpSsoUrl}
                    onChange={setIdpSsoUrl}
                    required
                    type="url"
                  />
                  <TextAreaField
                    id={`${base}-certs`}
                    label={m.sso_admin_field_certificates()}
                    help={certHelp}
                    value={certificates}
                    onChange={setCertificates}
                    required={!certsKept}
                    mono
                  />
                </>
              )}
            </>
          )}

          <fieldset className="space-y-3 rounded-md border p-4">
            <legend className="px-1 text-sm font-medium">{m.sso_admin_jit_label()}</legend>
            <Checkbox
              id={`${base}-jit`}
              label={m.sso_admin_jit_toggle()}
              help={jitLocked ? withFrozen(m.sso_admin_jit_help()) : m.sso_admin_jit_help()}
              disabled={jitLocked}
              checked={jitEnabled}
              onChange={setJitEnabled}
            />
            {jitEnabled ? (
              <Field id={`${base}-jit-role`} label={m.sso_admin_jit_role()}>
                <NativeSelect
                  id={`${base}-jit-role`}
                  value={jitRole}
                  onChange={(e) => setJitRole(e.target.value as StaffJitRole)}
                >
                  {JIT_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {roleLabel(role)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
          </fieldset>

          <fieldset className="space-y-3 rounded-md border p-4">
            <legend className="px-1 text-sm font-medium">{m.sso_admin_mfa_label()}</legend>
            <Checkbox
              id={`${base}-mfa-trust`}
              label={m.sso_admin_mfa_trust_toggle()}
              help={
                mfaLocked ? withFrozen(m.sso_admin_mfa_trust_help()) : m.sso_admin_mfa_trust_help()
              }
              disabled={mfaLocked}
              checked={mfaTrust}
              onChange={setMfaTrust}
            />
            {mfaTrust ? null : (
              <TextAreaField
                id={`${base}-mfa-values`}
                label={m.sso_admin_field_mfa_values()}
                help={
                  protocol === "oidc"
                    ? m.sso_admin_field_mfa_values_help_oidc()
                    : m.sso_admin_field_mfa_values_help_saml()
                }
                value={mfaValues}
                onChange={setMfaValues}
                mono
              />
            )}
          </fieldset>
        </>
      )}

      {save.isError ? (
        frozen && isPlanEntitlementRefusal(save.error) ? (
          // The server compared what the client could not (pasted metadata): say which part of
          // the save the plan refused, keeping the form's own title.
          <Alert variant="destructive" role="alert">
            <AlertTitle>{m.sso_admin_save_refused_title()}</AlertTitle>
            <AlertDescription>
              <p>{m.sso_admin_plan_switch_refused()}</p>
              <PlanChangeHint />
            </AlertDescription>
          </Alert>
        ) : (
          <SsoRefusal error={save.error} title={m.sso_admin_save_refused_title()} />
        )
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          loading={save.isPending}
          disabled={missing || (!planAllows && existing === null) || identityChanged}
        >
          {m.sso_admin_save()}
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

// --- small fields -----------------------------------------------------------------------------

function TextField({
  id,
  label,
  help,
  value,
  onChange,
  required = false,
  type = "text",
  maxLength,
  error,
}: {
  id: string;
  label: string;
  help?: string | undefined;
  error?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  type?: "text" | "url" | "password";
  maxLength?: number;
}) {
  return (
    <Field
      id={id}
      label={label}
      description={help}
      required={required}
      {...(error === undefined ? {} : { error })}
    >
      <Input
        id={id}
        type={type}
        autoComplete={type === "password" ? "new-password" : "off"}
        spellCheck={false}
        required={required}
        maxLength={maxLength}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...fieldAria(id, { description: help !== undefined, error: error !== undefined })}
      />
    </Field>
  );
}

function TextAreaField({
  id,
  label,
  help,
  value,
  onChange,
  required = false,
  mono = false,
}: {
  id: string;
  label: string;
  help?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  mono?: boolean;
}) {
  return (
    <Field id={id} label={label} description={help} required={required}>
      <Textarea
        id={id}
        rows={6}
        spellCheck={false}
        required={required}
        className={mono ? "font-mono text-xs" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...fieldAria(id, { description: help !== undefined })}
      />
    </Field>
  );
}

function Checkbox({
  id,
  label,
  help,
  checked,
  onChange,
  disabled = false,
}: {
  id: string;
  label: string;
  help: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <input
        id={id}
        type="checkbox"
        className="mt-1 size-4"
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-desc`}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div className="grid gap-1">
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        <p id={`${id}-desc`} className="text-xs text-muted-foreground">
          {help}
        </p>
      </div>
    </div>
  );
}
