import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@fundroomhq/ui";
import { useQueryClient } from "@tanstack/react-query";
import { api, call } from "../../lib/api.js";
import {
  clearPendingGrant,
  describeIntegrationError,
  INTEGRATIONS_KEY,
  type IntegrationProvider,
  integrationErrorCode,
  oauthReasonLabel,
  type PendingGrant,
  parkPendingGrant,
  providerName,
} from "../../lib/integrations-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { ErrorAlert } from "../error-alert.js";

/*
 * The OAuth landing (E3.6 FIX1, R1-H1). The callback no longer connects anything: it parks the
 * vendor grant as *pending* and lands here with `#pending=<token>`. Only the admin who started
 * the flow can turn it into a connection, by confirming here (`POST …/oauth/complete`, fresh
 * session). That defeats the confused deputy where someone else's consent link would connect
 * *their* vendor account to *this* workspace behind the admin's back.
 *
 * The card names the provider only (mapped through a fixed list): the URL carries nothing else
 * we would show, and the account label is not in it on purpose.
 */

export function PendingConfirmCard({
  grant,
  onDone,
  onConnected,
}: {
  grant: PendingGrant;
  onDone: () => void;
  onConnected: (provider: IntegrationProvider) => void;
}) {
  const queryClient = useQueryClient();
  const name = providerName(grant.provider);
  const complete = useGuardedMutation({
    mutationFn: () => {
      // A step-up detour leaves the page before `onError` runs; the parked copy brings the
      // grant back when the admin returns. Every settled outcome clears it below.
      parkPendingGrant(grant);
      return call(
        api().POST("/integrations/{provider}/oauth/complete", {
          params: { path: { provider: grant.provider } },
          body: { pendingToken: grant.token },
        }),
      );
    },
    onSuccess: () => {
      clearPendingGrant();
      void queryClient.invalidateQueries({ queryKey: INTEGRATIONS_KEY });
      onConnected(grant.provider);
    },
    onError: () => clearPendingGrant(),
  });
  const refusal = complete.isError ? complete.error : undefined;
  if (
    refusal !== undefined &&
    integrationErrorCode(refusal) === "integration_oauth_pending_invalid"
  ) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>{m.integrations_return_failed({ provider: name })}</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{describeIntegrationError(refusal)}</p>
          <DismissButton onClick={onDone} />
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{m.integrations_pending_title({ provider: name })}</h2>
        </CardTitle>
        <CardDescription>{m.integrations_pending_body({ provider: name })}</CardDescription>
      </CardHeader>
      {refusal === undefined ? null : (
        <CardContent>
          <ErrorAlert error={refusal} />
        </CardContent>
      )}
      <CardFooter className="flex flex-wrap gap-2">
        <Button
          type="button"
          loading={complete.isPending}
          disabled={refusal !== undefined}
          onClick={() => complete.mutate()}
        >
          {m.integrations_pending_confirm({ provider: name })}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={complete.isPending}
          onClick={() => {
            clearPendingGrant();
            onDone();
          }}
        >
          {m.common_cancel()}
        </Button>
      </CardFooter>
    </Card>
  );
}

/** The vendor round trip failed, or the landing URL was unusable (`reason` undefined → generic). */
export function ReturnErrorAlert({
  provider,
  reason,
  onDismiss,
}: {
  provider: IntegrationProvider | undefined;
  reason: string | undefined;
  onDismiss: () => void;
}) {
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>
        {provider === undefined
          ? m.integrations_return_failed_generic()
          : m.integrations_return_failed({ provider: providerName(provider) })}
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{oauthReasonLabel(reason)}</p>
        <DismissButton onClick={onDismiss} />
      </AlertDescription>
    </Alert>
  );
}

/** Shown only after `complete` succeeded — never from anything in a URL. */
export function ConnectedAlert({
  provider,
  onDismiss,
}: {
  provider: IntegrationProvider;
  onDismiss: () => void;
}) {
  return (
    <Alert variant="success">
      <AlertTitle>
        {m.integrations_return_connected({ provider: providerName(provider) })}
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{m.integrations_return_connected_body()}</p>
        <DismissButton onClick={onDismiss} />
      </AlertDescription>
    </Alert>
  );
}

function DismissButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="text-sm font-medium underline underline-offset-4"
      onClick={onClick}
    >
      {m.integrations_return_dismiss()}
    </button>
  );
}
