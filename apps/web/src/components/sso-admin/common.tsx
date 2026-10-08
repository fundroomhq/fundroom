import { Alert, AlertDescription, AlertTitle } from "@fundroomhq/ui";
import {
  describeSsoError,
  isSsoRefusal,
  type SsoProtocol,
  type SsoSpInfo,
} from "../../lib/sso-queries.js";
import { m } from "../../paraglide/messages.js";
import { CopyButton } from "../copy-button.js";
import { ErrorAlert } from "../error-alert.js";

/** A value the admin pastes into the identity provider (or DNS), with its copy button. */
export function CopyRow({
  label,
  value,
  copyLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
}) {
  return (
    <div className="grid gap-1">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="flex flex-wrap items-center gap-2">
        <code className="block min-w-0 flex-1 overflow-x-auto rounded border bg-muted/40 p-2 font-mono text-xs break-all">
          {value}
        </code>
        <CopyButton value={value} label={copyLabel} />
      </dd>
    </div>
  );
}

/**
 * What goes into the identity provider's app registration. The addresses live on the
 * canonical host (not a custom domain), so changing the workspace's domain never breaks them.
 */
export function SpInfoPanel({
  protocol,
  sp,
  headingId,
}: {
  protocol: SsoProtocol;
  sp: SsoSpInfo | null;
  headingId: string;
}) {
  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-md border p-4">
      <h3 id={headingId} className="font-semibold">
        {m.sso_admin_sp_title()}
      </h3>
      {sp === null ? (
        <p className="text-sm text-muted-foreground">{m.sso_admin_sp_after_save()}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {protocol === "oidc" ? m.sso_admin_sp_body_oidc() : m.sso_admin_sp_body_saml()}
          </p>
          <dl className="space-y-3">
            {protocol === "oidc" ? (
              <CopyRow
                label={m.sso_admin_sp_redirect_uri()}
                value={sp.oidcRedirectUri}
                copyLabel={m.sso_admin_copy_redirect_uri()}
              />
            ) : (
              <>
                <CopyRow
                  label={m.sso_admin_sp_acs_url()}
                  value={sp.samlAcsUrl}
                  copyLabel={m.sso_admin_copy_acs_url()}
                />
                <CopyRow
                  label={m.sso_admin_sp_entity_id()}
                  value={sp.samlEntityId}
                  copyLabel={m.sso_admin_copy_entity_id()}
                />
                <CopyRow
                  label={m.sso_admin_sp_metadata_url()}
                  value={sp.samlMetadataUrl}
                  copyLabel={m.sso_admin_copy_metadata_url()}
                />
              </>
            )}
          </dl>
        </>
      )}
    </section>
  );
}

/** A refusal from the SSO routes in one sentence, or the generic alert for anything else. */
export function SsoRefusal({ error, title }: { error: unknown; title?: string }) {
  if (!isSsoRefusal(error)) return <ErrorAlert error={error} />;
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{title ?? m.sso_admin_action_refused_title()}</AlertTitle>
      <AlertDescription>
        <p>{describeSsoError(error)}</p>
      </AlertDescription>
    </Alert>
  );
}
