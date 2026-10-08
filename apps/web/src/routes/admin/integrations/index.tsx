import { Alert, AlertDescription, AlertTitle, PageHeader } from "@fundroomhq/ui";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate, useRouterState } from "@tanstack/react-router";
import { ShieldOff } from "lucide-react";
import { useEffect, useState } from "react";
import * as z from "zod/mini";
import { CopyButton } from "../../../components/copy-button.js";
import { BookingLinksCard } from "../../../components/integrations-admin/booking-links.js";
import { BookingsCard } from "../../../components/integrations-admin/bookings.js";
import {
  ConnectedAlert,
  PendingConfirmCard,
  ReturnErrorAlert,
} from "../../../components/integrations-admin/oauth-return.js";
import {
  ProvidersSection,
  type RevealedWebhookSecret,
  WebhookSetupSteps,
} from "../../../components/integrations-admin/providers.js";
import { RelatedIntegrations } from "../../../components/integrations-admin/related.js";
import { ShownOnce } from "../../../components/shown-once.js";
import {
  INTEGRATIONS_KEY,
  type IntegrationProvider,
  type OAuthLanding,
  oauthLandingOf,
  parkedPendingGrant,
} from "../../../lib/integrations-queries.js";
import { useBootstrap } from "../../../lib/queries.js";
import { m } from "../../../paraglide/messages.js";

/*
 * `?integration=<p>&result=pending#pending=<token>` (or `result=error&reason=<code>`) is where
 * the server's OAuth callback lands the admin. None of it is trusted beyond choosing what to
 * show: the provider id is mapped through a fixed list, unknown reasons read as the generic
 * failure, and the pending token is only ever sent back to `…/oauth/complete` on an explicit
 * confirm. There is no "connected" landing: success is shown only after that confirm.
 */
const searchSchema = z.object({
  integration: z.catch(z.optional(z.string()), undefined),
  result: z.catch(z.optional(z.string()), undefined),
  reason: z.catch(z.optional(z.string()), undefined),
});

export const Route = createFileRoute("/admin/integrations/")({
  validateSearch: searchSchema,
  component: IntegrationsPage,
});

/*
 * Integrations hub (E3.6, ADR-0054). A kernel screen: connections are kernel rows that
 * several modules consume (metrics reads KPIs, notify posts to Slack, CRM logs bookings), so
 * no single module could own the page.
 */
function IntegrationsPage() {
  const bootstrap = useBootstrap();
  const permissions = bootstrap.data?.permissions ?? [];
  if (!permissions.includes("integrations.read")) {
    return (
      <Alert variant="destructive" role="alert">
        <ShieldOff aria-hidden="true" />
        <AlertTitle>{m.error_forbidden_title()}</AlertTitle>
        <AlertDescription>{m.integrations_forbidden()}</AlertDescription>
      </Alert>
    );
  }
  return <IntegrationsScreen canManage={permissions.includes("integrations.manage")} />;
}

function IntegrationsScreen({ canManage }: { canManage: boolean }) {
  const bootstrap = useBootstrap();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const hash = useRouterState({ select: (st) => st.location.hash });
  // Read once — from the URL, or from the grant parked before a step-up detour — then strip
  // the query and the fragment from the address bar at once: the token must not linger in
  // history, and a reload or a shared URL must not replay anything.
  const [landing, setLanding] = useState<OAuthLanding | undefined>(() => {
    const fromUrl = oauthLandingOf(search, hash);
    if (fromUrl !== undefined) return fromUrl;
    const parked = parkedPendingGrant();
    return parked === undefined ? undefined : { kind: "pending", grant: parked };
  });
  const [connected, setConnected] = useState<IntegrationProvider>();
  const dirtyUrl = search.result !== undefined || search.integration !== undefined || hash !== "";
  useEffect(() => {
    if (!dirtyUrl) return;
    void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
    void navigate({ to: "/admin/integrations", search: {}, hash: "", replace: true });
  }, [dirtyUrl, navigate, queryClient]);
  const [revealed, setRevealed] = useState<RevealedWebhookSecret>();
  const permissions = bootstrap.data?.permissions ?? [];
  return (
    <div className="space-y-8">
      <PageHeader title={m.integrations_title()} description={m.integrations_subtitle()} />
      {connected === undefined ? null : (
        <ConnectedAlert provider={connected} onDismiss={() => setConnected(undefined)} />
      )}
      {landing?.kind === "error" ? (
        <ReturnErrorAlert
          provider={landing.provider}
          reason={landing.reason}
          onDismiss={() => setLanding(undefined)}
        />
      ) : null}
      {landing?.kind === "invalid" ? (
        <ReturnErrorAlert
          provider={landing.provider}
          reason={undefined}
          onDismiss={() => setLanding(undefined)}
        />
      ) : null}
      {landing?.kind === "pending" ? (
        canManage ? (
          <PendingConfirmCard
            grant={landing.grant}
            onDone={() => setLanding(undefined)}
            onConnected={(provider) => {
              setLanding(undefined);
              setConnected(provider);
            }}
          />
        ) : (
          <ReturnErrorAlert
            provider={landing.grant.provider}
            reason={undefined}
            onDismiss={() => setLanding(undefined)}
          />
        )
      ) : null}
      {revealed ? (
        <ShownOnce
          title={revealed.title}
          value={revealed.secret}
          copyLabel={m.integrations_copy_webhook_secret()}
          onDismiss={() => setRevealed(undefined)}
        >
          {revealed.webhookUrl === null ? null : (
            <div className="space-y-2">
              <p>{m.integrations_webhook_secret_url()}</p>
              <code className="block w-full overflow-x-auto rounded border bg-background p-2 font-mono text-xs break-all">
                {revealed.webhookUrl}
              </code>
              <CopyButton value={revealed.webhookUrl} label={m.integrations_copy_webhook_url()} />
            </div>
          )}
          <WebhookSetupSteps provider={revealed.provider} />
        </ShownOnce>
      ) : null}
      {canManage ? null : (
        <p className="text-sm text-muted-foreground">{m.integrations_read_only()}</p>
      )}
      <ProvidersSection canManage={canManage} onSecret={setRevealed} />
      <BookingLinksCard canManage={canManage} canReadGroups={permissions.includes("access.read")} />
      <BookingsCard />
      {bootstrap.data ? <RelatedIntegrations bootstrap={bootstrap.data} /> : null}
    </div>
  );
}
