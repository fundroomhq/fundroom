import { Button, Checkbox, ErrorState, Label, LoadingState } from "@fundroomhq/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import * as z from "zod/mini";
import { ErrorAlert } from "../../../components/error-alert.js";
import { api, call, describeError } from "../../../lib/api.js";
import { refreshSession } from "../../../lib/queries.js";
import { m } from "../../../paraglide/messages.js";

const searchSchema = z.object({ token: z.catch(z.string(), "") });

/** Never auto-consumes: mail scanners follow links, so the user presses the button. */
export const Route = createFileRoute("/_auth/auth/magic-link")({
  validateSearch: searchSchema,
  component: MagicLinkPage,
});

function MagicLinkPage() {
  const { token } = Route.useSearch();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [remember, setRemember] = useState(false);
  const rememberId = useId();
  const peek = useQuery({
    queryKey: ["auth", "magic-link", "peek", token],
    queryFn: () => call(api().GET("/auth/magic-link/peek", { params: { query: { token } } })),
    enabled: token.length >= 16,
    retry: false,
  });
  const confirm = useMutation({
    mutationFn: () =>
      call(api().POST("/auth/magic-link/confirm", { body: { token, rememberDevice: remember } })),
    onSuccess: async () => {
      await refreshSession(queryClient);
      await navigate({ to: "/", replace: true });
    },
  });

  if (token.length < 16 || (peek.data && !peek.data.valid) || peek.isError) {
    const d = peek.isError ? describeError(peek.error) : undefined;
    return (
      <ErrorState
        title={m.magic_link_invalid_title()}
        description={d?.body ?? m.magic_link_invalid_body()}
        requestId={d?.requestId}
        requestIdLabel={m.common_request_id_label()}
        onRetry={() => void navigate({ to: "/login", search: {} })}
        retryLabel={m.magic_link_request_new()}
      />
    );
  }
  if (peek.isPending) return <LoadingState label={m.common_loading()} />;

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">{m.magic_link_title()}</h1>
        <p className="text-sm text-muted-foreground">
          {m.magic_link_body({ email: peek.data.emailHint ?? "" })}
        </p>
        {peek.data.requestedFrom ? (
          <p className="text-xs text-muted-foreground">
            {m.magic_link_requested_from({ from: peek.data.requestedFrom })}
          </p>
        ) : null}
      </div>
      <ErrorAlert error={confirm.error} />
      <div className="flex items-center gap-2">
        <Checkbox
          id={rememberId}
          checked={remember}
          onCheckedChange={(v) => setRemember(v === true)}
        />
        <Label htmlFor={rememberId} className="font-normal">
          {m.login_remember()}
        </Label>
      </div>
      <Button
        type="button"
        className="w-full"
        loading={confirm.isPending}
        onClick={() => confirm.mutate()}
      >
        {m.magic_link_confirm()}
      </Button>
      <Button asChild variant="link" size="sm">
        <Link to="/login" search={{}}>
          {m.magic_link_not_you()}
        </Link>
      </Button>
    </div>
  );
}
