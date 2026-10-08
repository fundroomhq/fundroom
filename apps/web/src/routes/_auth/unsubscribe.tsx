import { Button } from "@fundroomhq/ui";
import { useMutation } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import * as z from "zod/mini";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, call } from "../../lib/api.js";
import { m } from "../../paraglide/messages.js";

/*
 * The footer "Unsubscribe" link of an update email lands here (E1.4). The signed token in
 * the URL identifies the member; no sign-in is needed. Mail clients that support RFC 8058
 * POST to the API directly and never see this page.
 */
const searchSchema = z.object({ token: z.catch(z.optional(z.string()), undefined) });

export const Route = createFileRoute("/_auth/unsubscribe")({
  validateSearch: searchSchema,
  component: UnsubscribePage,
});

function UnsubscribePage() {
  const { token } = Route.useSearch();
  const redeem = useMutation({
    mutationFn: (t: string) =>
      call(api().POST("/updates/unsubscribe", { params: { query: { token: t } } })),
  });
  const { mutate } = redeem;
  useEffect(() => {
    if (token) mutate(token);
  }, [token, mutate]);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">{m.unsubscribe_title()}</h1>
      {!token ? <ErrorAlert error={new Error(m.unsubscribe_missing())} /> : null}
      {redeem.isPending ? (
        <p className="text-sm text-muted-foreground">{m.common_loading()}</p>
      ) : null}
      {redeem.isError ? <ErrorAlert error={redeem.error} /> : null}
      {redeem.data ? (
        <p className="text-sm" role="status">
          {redeem.data.alreadyUnsubscribed
            ? m.unsubscribe_already({ email: redeem.data.email })
            : m.unsubscribe_done({ email: redeem.data.email })}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">{m.unsubscribe_note()}</p>
      <Button asChild variant="outline">
        <Link to="/$" params={{ _splat: "updates" }}>
          {m.unsubscribe_manage()}
        </Link>
      </Button>
    </div>
  );
}
