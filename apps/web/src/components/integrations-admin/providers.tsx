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
import { ExternalLink } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { api, call } from "../../lib/api.js";
import { formatDateTime } from "../../lib/format.js";
import {
  capabilityLabel,
  credentialFieldHelp,
  credentialFieldLabel,
  describeIntegrationError,
  describeRotateError,
  INTEGRATIONS_KEY,
  type IntegrationConnection,
  type IntegrationProvider,
  type IntegrationProviderInfo,
  integrationConnectionsQuery,
  integrationErrorCode,
  integrationProvidersQuery,
  OAUTH_RETURN_PATH,
  OPERATOR_DOCS_URL,
  oauthNavigation,
  statusLabel,
  statusVariant,
} from "../../lib/integrations-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { ConfirmDialog } from "../access/common.js";
import {
  PlanFeatureNotice,
  usePlanAllowsFeature,
  usePlanRemovalWarning,
} from "../billing/plan-feature-notice.js";
import { CopyButton } from "../copy-button.js";
import { ErrorAlert } from "../error-alert.js";
import { TypedConfirmDialog } from "../typed-confirm-dialog.js";

/*
 * One card per provider the deployment knows (E3.6, ADR-0054). What the admin must not get wrong:
 *
 *  - **Who can connect what.** An OAuth provider needs the operator's app registration
 *    (`INTEGRATIONS_<P>_CLIENT_ID/_SECRET`); without it the provider is `available: false` and
 *    the card says so and points at the operator docs instead of offering a button that 409s.
 *  - **What we will read.** The adapter's plain-language scope list and its sub-processor line
 *    are shown before connecting, not after.
 *  - **Credentials are write-only.** Secret providers get a form generated from the adapter's
 *    `credentialFields`; a Stripe *secret* key (`sk_…`) is refused here as well as by the
 *    server (least privilege: a restricted `rk_…` key only).
 *  - **Health is visible.** `degraded` (vendor failing, still retried) and `reauth_required`
 *    (the vendor refused the token — reconnect) each say what to do.
 *  - **The Cal.com webhook secret exists once**, in the connect or rotate response, so it is
 *    handed to the page's `ShownOnce` with the URL it belongs to.
 */

export interface RevealedWebhookSecret {
  readonly title: string;
  readonly secret: string;
  readonly provider: IntegrationProvider;
  readonly webhookUrl: string | null;
}

export function ProvidersSection({
  canManage,
  onSecret,
}: {
  canManage: boolean;
  onSecret: (revealed: RevealedWebhookSecret) => void;
}) {
  const providers = useQuery(integrationProvidersQuery);
  const connections = useQuery(integrationConnectionsQuery);
  return (
    <section aria-labelledby="integrations-providers-heading" className="space-y-4">
      <h2 id="integrations-providers-heading" className="text-lg font-semibold">
        {m.integrations_providers_title()}
      </h2>
      {/* A-3: what is connected keeps syncing and can be maintained (reconnect, replace, verify);
          connecting a provider the workspace has no connection for needs the feature. */}
      <PlanFeatureNotice feature="integrations" />
      {providers.isPending || connections.isPending ? (
        <LoadingState lines={3} label={m.common_loading()} />
      ) : null}
      {providers.isError ? <ErrorAlert error={providers.error} /> : null}
      {connections.isError ? <ErrorAlert error={connections.error} /> : null}
      {providers.data && connections.data ? (
        <ul className="grid gap-4 lg:grid-cols-2">
          {providers.data.providers.map((info) => (
            <li key={info.provider}>
              <ProviderCard
                info={info}
                connection={connections.data.connections.find((c) => c.provider === info.provider)}
                canManage={canManage}
                onSecret={onSecret}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

function ProviderCard({
  info,
  connection,
  canManage,
  onSecret,
}: {
  info: IntegrationProviderInfo;
  connection: IntegrationConnection | undefined;
  canManage: boolean;
  onSecret: (revealed: RevealedWebhookSecret) => void;
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle>
            <h3>{info.displayName}</h3>
          </CardTitle>
          {connection === undefined ? (
            <Badge variant="outline">
              {info.available ? m.integrations_status_none() : m.integrations_status_unavailable()}
            </Badge>
          ) : (
            <Badge variant={statusVariant(connection.status)}>
              {statusLabel(connection.status)}
            </Badge>
          )}
          {connection?.environment === "sandbox" ? (
            <Badge variant="secondary">{m.integrations_sandbox()}</Badge>
          ) : null}
        </div>
        <CardDescription>
          {info.capabilities.map((c) => capabilityLabel(c)).join(" · ")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {connection === undefined ? (
          <NotConnected info={info} canManage={canManage} onSecret={onSecret} />
        ) : (
          <Connected
            info={info}
            connection={connection}
            canManage={canManage}
            onSecret={onSecret}
          />
        )}
      </CardContent>
    </Card>
  );
}

// --- not connected ----------------------------------------------------------------------------

function NotConnected({
  info,
  canManage,
  onSecret,
}: {
  info: IntegrationProviderInfo;
  canManage: boolean;
  onSecret: (revealed: RevealedWebhookSecret) => void;
}) {
  const [open, setOpen] = useState(false);
  const planAllows = usePlanAllowsFeature("integrations");
  if (!info.available) {
    return (
      <div className="space-y-2 text-sm">
        <p>{m.integrations_unavailable_body({ provider: info.displayName })}</p>
        <p>
          <a
            href={OPERATOR_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
          >
            {m.integrations_operator_docs()}
            <ExternalLink aria-hidden="true" className="size-3.5" />
            <span className="sr-only">{m.integrations_opens_new_tab()}</span>
          </a>
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <ScopeExplanation info={info} />
      {!canManage ? (
        <p className="text-sm text-muted-foreground">{m.integrations_not_connected_read_only()}</p>
      ) : info.auth === "oauth2" ? (
        <OAuthConnectButton
          info={info}
          label={m.integrations_connect({ provider: info.displayName })}
        />
      ) : open ? (
        <SecretConnectForm
          info={info}
          replacing={false}
          onDone={(revealed) => {
            setOpen(false);
            if (revealed) onSecret(revealed);
          }}
          onCancel={() => setOpen(false)}
        />
      ) : (
        <Button type="button" disabled={!planAllows} onClick={() => setOpen(true)}>
          {m.integrations_connect({ provider: info.displayName })}
        </Button>
      )}
    </div>
  );
}

function ScopeExplanation({ info }: { info: IntegrationProviderInfo }) {
  const listId = useId();
  return (
    <div className="space-y-2 text-sm">
      {info.scopeExplanation.length === 0 ? null : (
        <>
          <p id={listId} className="font-medium">
            {m.integrations_scope_title()}
          </p>
          <ul aria-labelledby={listId} className="list-disc space-y-1 pl-5">
            {info.scopeExplanation.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </>
      )}
      {info.kpiMetrics.length === 0 ? null : (
        <p className="text-muted-foreground">
          {m.integrations_kpi_metrics({
            metrics: info.kpiMetrics.map((k) => k.label).join(", "),
          })}
        </p>
      )}
      <p className="text-muted-foreground">
        {m.integrations_subprocessor({
          vendor: info.subProcessor.name,
          region: info.subProcessor.region,
        })}{" "}
        <a
          href={info.subProcessor.dpaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium underline underline-offset-4"
        >
          {m.integrations_subprocessor_dpa({ vendor: info.subProcessor.name })}
        </a>
      </p>
    </div>
  );
}

/**
 * OAuth: ask the server for a single-use start URL (a fresh session is required, so this may
 * detour through step-up first), then hand the whole window to it. The vendor's consent screen
 * and the callback happen at top level; the callback lands back on this page with a result.
 */
function OAuthConnectButton({
  info,
  label,
  variant = "default",
  connected = false,
}: {
  info: IntegrationProviderInfo;
  label: string;
  variant?: "default" | "outline";
  /** Reconnecting a provider already connected is maintenance, allowed on any plan (A-3). */
  connected?: boolean;
}) {
  const planAllows = usePlanAllowsFeature("integrations") || connected;
  const begin = useGuardedMutation({
    mutationFn: () =>
      call(
        api().POST("/integrations/{provider}/oauth/begin", {
          params: { path: { provider: info.provider } },
          body: { returnPath: OAUTH_RETURN_PATH },
        }),
      ),
    onSuccess: (result) => oauthNavigation.assign(result.startUrl),
    onError: (error) => toast.error(describeIntegrationError(error)),
  });
  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant={variant}
        loading={begin.isPending || begin.isSuccess}
        disabled={!planAllows}
        onClick={() => begin.mutate()}
      >
        {label}
      </Button>
      <p className="text-xs text-muted-foreground">
        {m.integrations_oauth_hint({ provider: info.displayName })}
      </p>
    </div>
  );
}

// --- secret connect form ----------------------------------------------------------------------

function refusedLocally(provider: IntegrationProvider, key: string, value: string): boolean {
  // Least privilege: a Stripe secret key can do anything; only a restricted key is accepted.
  return provider === "stripe" && key === "restrictedKey" && /^sk_/u.test(value.trim());
}

function SecretConnectForm({
  info,
  replacing,
  onDone,
  onCancel,
}: {
  info: IntegrationProviderInfo;
  replacing: boolean;
  onDone: (revealed: RevealedWebhookSecret | undefined) => void;
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const base = useId();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(info.credentialFields.map((f) => [f.key, ""])),
  );
  const save = useGuardedMutation({
    mutationFn: () => {
      const credentials: Record<string, string> = {};
      for (const field of info.credentialFields) {
        const value = (values[field.key] ?? "").trim();
        if (value !== "") credentials[field.key] = value;
      }
      return call(
        api().POST("/integrations/{provider}/connect", {
          params: { path: { provider: info.provider } },
          body: { credentials },
        }),
      );
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
      toast.success(m.integrations_connected_ok({ provider: info.displayName }));
      onDone(
        result.webhookSecret === undefined || info.provider !== "calcom"
          ? undefined
          : {
              title: m.integrations_webhook_secret_title({ provider: info.displayName }),
              secret: result.webhookSecret,
              provider: info.provider,
              webhookUrl: result.connection.webhookUrl,
            },
      );
    },
  });
  const refused = info.credentialFields.some((f) =>
    refusedLocally(info.provider, f.key, values[f.key] ?? ""),
  );
  const missing = info.credentialFields.some(
    (f) => f.required && (values[f.key] ?? "").trim() === "",
  );
  return (
    <form
      className="space-y-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!missing && !refused) save.mutate();
      }}
    >
      {replacing ? (
        <p className="text-sm text-muted-foreground">
          {m.integrations_replace_body({ provider: info.displayName })}
        </p>
      ) : null}
      {info.credentialFields.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {m.integrations_no_credentials({ provider: info.displayName })}
        </p>
      ) : null}
      {info.credentialFields.map((field) => {
        const id = `${base}-${field.key}`;
        const value = values[field.key] ?? "";
        const bad = refusedLocally(info.provider, field.key, value);
        const help = credentialFieldHelp(info.provider, field);
        return (
          <Field
            key={field.key}
            id={id}
            label={credentialFieldLabel(info.provider, field)}
            description={help}
            error={bad ? m.integrations_error_secret_key_refused() : undefined}
            required={field.required}
          >
            <Input
              id={id}
              type={field.kind === "secret" ? "password" : "text"}
              autoComplete={field.kind === "secret" ? "new-password" : "off"}
              spellCheck={false}
              required={field.required}
              value={value}
              onChange={(e) => setValues((cur) => ({ ...cur, [field.key]: e.target.value }))}
              {...fieldAria(id, { description: help !== undefined, error: bad })}
            />
          </Field>
        );
      })}
      {save.isError ? <ConnectRefusal error={save.error} /> : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={save.isPending} disabled={missing || refused}>
          {info.credentialFields.length === 0
            ? m.integrations_connect({ provider: info.displayName })
            : m.integrations_verify_and_connect()}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          {m.common_cancel()}
        </Button>
      </div>
    </form>
  );
}

function ConnectRefusal({ error }: { error: unknown }) {
  const code = integrationErrorCode(error);
  if (code === undefined || !code.startsWith("integration_")) return <ErrorAlert error={error} />;
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{m.integrations_connect_refused()}</AlertTitle>
      <AlertDescription>{describeIntegrationError(error)}</AlertDescription>
    </Alert>
  );
}

// --- connected --------------------------------------------------------------------------------

function Connected({
  info,
  connection,
  canManage,
  onSecret,
}: {
  info: IntegrationProviderInfo;
  connection: IntegrationConnection;
  canManage: boolean;
  onSecret: (revealed: RevealedWebhookSecret) => void;
}) {
  const queryClient = useQueryClient();
  const [replacing, setReplacing] = useState(false);
  // A-3 (RR3 RL4): reconnecting this provider later would be a new connection.
  const warnRemoval = usePlanRemovalWarning("integrations");
  const invalidate = () => queryClient.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
  const path = { params: { path: { provider: info.provider } } };
  const verify = useGuardedMutation({
    mutationFn: () => call(api().POST("/integrations/{provider}/verify", path)),
    onSuccess: (result) => {
      if (result.status === "active") toast.success(m.integrations_verified_ok());
      else toast.error(m.integrations_verified_failed());
      void invalidate();
    },
    onError: (error) => toast.error(describeIntegrationError(error)),
  });
  const rotate = useGuardedMutation({
    mutationFn: () => call(api().POST("/integrations/{provider}/rotate-webhook-secret", path)),
    onSuccess: (result) => {
      toast.success(m.integrations_webhook_secret_rotated_ok());
      if (info.provider === "calcom") {
        onSecret({
          title: m.integrations_webhook_secret_rotated_title({ provider: info.displayName }),
          secret: result.webhookSecret,
          provider: info.provider,
          webhookUrl: result.connection.webhookUrl,
        });
      }
      void invalidate();
    },
    // Shown inline below (a lost subscription needs more than a passing toast); a refusal may
    // also have degraded the connection, so its health is re-read.
    onError: () => void invalidate(),
  });
  const disconnect = useGuardedMutation({
    mutationFn: () => call(api().DELETE("/integrations/{provider}", path)),
    onSuccess: () => {
      toast.success(m.integrations_disconnected_ok({ provider: info.displayName }));
      void invalidate();
    },
    onError: (error) => toast.error(describeIntegrationError(error)),
  });
  const booking = info.capabilities.includes("booking");
  const accounts = connection.availableAccounts ?? [];
  const chooseAccount =
    accounts.length > 1 || (accounts.length > 0 && connection.externalAccountId === null);
  return (
    <div className="space-y-4">
      {connection.status === "degraded" ? (
        <Alert variant="warning">
          <AlertTitle>{m.integrations_degraded_title()}</AlertTitle>
          <AlertDescription>
            {m.integrations_degraded_body({ count: connection.consecutiveFailures })}
          </AlertDescription>
        </Alert>
      ) : null}
      {connection.status === "reauth_required" ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{m.integrations_reauth_title()}</AlertTitle>
          <AlertDescription>
            {m.integrations_reauth_body({ provider: info.displayName })}
          </AlertDescription>
        </Alert>
      ) : null}
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-muted-foreground">{m.integrations_account()}</dt>
        <dd>{connection.accountLabel ?? m.integrations_account_unknown()}</dd>
        <dt className="text-muted-foreground">{m.integrations_connected_at()}</dt>
        <dd>{formatDateTime(connection.connectedAt)}</dd>
        <dt className="text-muted-foreground">{m.integrations_last_success()}</dt>
        <dd>
          {connection.lastSuccessAt === null
            ? m.integrations_never()
            : formatDateTime(connection.lastSuccessAt)}
        </dd>
        {connection.lastFailureAt === null ? null : (
          <>
            <dt className="text-muted-foreground">{m.integrations_last_failure()}</dt>
            <dd>
              {formatDateTime(connection.lastFailureAt)}
              {connection.lastError === null ? null : (
                <span className="block font-mono text-xs break-all">{connection.lastError}</span>
              )}
            </dd>
          </>
        )}
      </dl>

      {chooseAccount ? (
        <AccountChooser info={info} connection={connection} canManage={canManage} />
      ) : null}

      {booking && connection.webhookUrl !== null ? (
        <WebhookDetails info={info} webhookUrl={connection.webhookUrl} />
      ) : null}

      {rotate.isError ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{m.integrations_rotate_refused()}</AlertTitle>
          <AlertDescription>{describeRotateError(rotate.error, info.displayName)}</AlertDescription>
        </Alert>
      ) : null}

      {replacing ? (
        <SecretConnectForm
          info={info}
          replacing
          onDone={(revealed) => {
            setReplacing(false);
            if (revealed) onSecret(revealed);
          }}
          onCancel={() => setReplacing(false)}
        />
      ) : null}

      {canManage && !replacing ? (
        <div className="flex flex-wrap items-start gap-2">
          {info.auth === "oauth2" ? (
            <OAuthConnectButton
              info={info}
              variant={connection.status === "reauth_required" ? "default" : "outline"}
              label={m.integrations_reconnect()}
              connected
            />
          ) : info.credentialFields.length > 0 ? (
            <Button
              type="button"
              variant={connection.status === "reauth_required" ? "default" : "outline"}
              onClick={() => setReplacing(true)}
            >
              {m.integrations_replace_credentials()}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            loading={verify.isPending}
            onClick={() => verify.mutate()}
          >
            {m.integrations_verify()}
          </Button>
          {booking ? (
            <ConfirmDialog
              trigger={
                <Button type="button" variant="outline" disabled={rotate.isPending}>
                  {m.integrations_rotate_webhook_secret()}
                </Button>
              }
              title={m.integrations_rotate_webhook_secret_title()}
              description={
                info.provider === "calcom"
                  ? m.integrations_rotate_webhook_secret_body_manual({
                      provider: info.displayName,
                    })
                  : m.integrations_rotate_webhook_secret_body_auto({
                      provider: info.displayName,
                    })
              }
              confirmLabel={m.integrations_rotate_webhook_secret()}
              pending={rotate.isPending}
              onConfirm={() => rotate.mutate()}
            />
          ) : null}
          <TypedConfirmDialog
            trigger={
              <Button type="button" variant="destructive">
                {m.integrations_disconnect()}
              </Button>
            }
            title={m.integrations_disconnect_title({ provider: info.displayName })}
            description={warnRemoval(disconnectBody(info))}
            phrase={info.provider}
            confirmLabel={m.integrations_disconnect()}
            pending={disconnect.isPending}
            onConfirm={() => disconnect.mutate()}
          />
        </div>
      ) : null}
    </div>
  );
}

function disconnectBody(info: IntegrationProviderInfo): string {
  if (info.capabilities.includes("kpi")) {
    return m.integrations_disconnect_body_kpi({ provider: info.displayName });
  }
  if (info.capabilities.includes("chat")) {
    return m.integrations_disconnect_body_chat({ provider: info.displayName });
  }
  return m.integrations_disconnect_body_booking({ provider: info.displayName });
}

/** Where booking events are delivered, and (Cal.com) what to paste where. */
function WebhookDetails({
  info,
  webhookUrl,
}: {
  info: IntegrationProviderInfo;
  webhookUrl: string;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h4 id={headingId} className="text-sm font-semibold">
        {m.integrations_webhook_title()}
      </h4>
      <div className="flex flex-wrap items-center gap-2">
        <code className="block min-w-0 flex-1 overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-xs break-all">
          {webhookUrl}
        </code>
        <CopyButton value={webhookUrl} label={m.integrations_copy_webhook_url()} />
      </div>
      <p className="text-sm text-muted-foreground">
        {info.provider === "calcom"
          ? m.integrations_webhook_calcom_hint()
          : m.integrations_webhook_calendly_hint()}
      </p>
    </section>
  );
}

/** The Cal.com steps shown beside a freshly minted secret. */
export function WebhookSetupSteps({ provider }: { provider: IntegrationProvider }) {
  if (provider !== "calcom") return null;
  return (
    <ol className="list-decimal space-y-1 pl-5 text-sm">
      <li>{m.integrations_calcom_setup_1()}</li>
      <li>{m.integrations_calcom_setup_2()}</li>
      <li>{m.integrations_calcom_setup_3()}</li>
    </ol>
  );
}

/** Xero: one grant may cover several organisations; exactly one feeds the metrics. */
function AccountChooser({
  info,
  connection,
  canManage,
}: {
  info: IntegrationProviderInfo;
  connection: IntegrationConnection;
  canManage: boolean;
}) {
  const queryClient = useQueryClient();
  const base = useId();
  const accounts = connection.availableAccounts ?? [];
  const [chosen, setChosen] = useState<string | undefined>(
    connection.externalAccountId ?? undefined,
  );
  const select = useGuardedMutation({
    mutationFn: (externalAccountId: string) =>
      call(
        api().PUT("/integrations/{provider}/account", {
          params: { path: { provider: info.provider } },
          body: { externalAccountId },
        }),
      ),
    onSuccess: () => {
      toast.success(m.integrations_account_selected_ok());
      void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
    },
    onError: (error) => toast.error(describeIntegrationError(error)),
  });
  return (
    <form
      className="space-y-3 rounded-md border p-4"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (chosen !== undefined) select.mutate(chosen);
      }}
    >
      <fieldset className="space-y-2" disabled={!canManage}>
        <legend className="text-sm font-medium">{m.integrations_account_choose()}</legend>
        {connection.externalAccountId === null ? (
          <p className="text-sm text-muted-foreground">{m.integrations_account_choose_body()}</p>
        ) : null}
        {accounts.map((account) => {
          const id = `${base}-${account.id}`;
          return (
            <div key={account.id} className="flex items-center gap-2">
              <input
                id={id}
                type="radio"
                name={`${base}-account`}
                value={account.id}
                checked={chosen === account.id}
                onChange={() => setChosen(account.id)}
              />
              <label htmlFor={id} className="text-sm">
                {account.name}
              </label>
            </div>
          );
        })}
      </fieldset>
      {canManage ? (
        <Button
          type="submit"
          size="sm"
          loading={select.isPending}
          disabled={chosen === undefined || chosen === connection.externalAccountId}
        >
          {m.integrations_account_use()}
        </Button>
      ) : null}
    </form>
  );
}
