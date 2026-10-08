import { Badge, Button, ErrorState, LoadingState } from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { api, call, describeError } from "../../../lib/api.js";
import { useWebConfig } from "../../../lib/config-context.js";
import { formatDate } from "../../../lib/format.js";
import { m } from "../../../paraglide/messages.js";

/** Invite landing (§13.1): shows nothing gated; the invite is consumed on first verified login. */
export const Route = createFileRoute("/_auth/invite/$token")({ component: InvitePage });

function InvitePage() {
  const { token } = Route.useParams();
  const config = useWebConfig();
  const invite = useQuery({
    queryKey: ["invites", token],
    queryFn: () => call(api().GET("/invites/{token}", { params: { path: { token } } })),
    retry: false,
  });

  if (invite.isPending) return <LoadingState label={m.common_loading()} />;
  if (invite.isError || !invite.data.valid) {
    const d = invite.isError ? describeError(invite.error) : undefined;
    return (
      <ErrorState
        title={m.invite_invalid_title()}
        description={d?.body ?? m.invite_invalid_body()}
        requestId={d?.requestId}
        requestIdLabel={m.common_request_id_label()}
      />
    );
  }
  const kind = invite.data.kind === "staff" ? m.kind_staff() : m.kind_external();
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">{m.invite_title()}</h1>
        <p className="text-sm text-muted-foreground">
          {m.invite_body({ workspace: config.workspace?.name ?? config.instanceName })}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge variant="secondary">{kind}</Badge>
          {invite.data.emailHint ? <span>{invite.data.emailHint}</span> : null}
        </div>
        {invite.data.expiresAt ? (
          <p className="text-xs text-muted-foreground">
            {m.invite_expires({ when: formatDate(invite.data.expiresAt) })}
          </p>
        ) : null}
      </div>
      <Button asChild className="w-full">
        <Link to="/login" search={{ returnTo: "/" }}>
          {m.invite_continue()}
        </Link>
      </Button>
    </div>
  );
}
