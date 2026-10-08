import {
  Alert,
  AlertDescription,
  AlertTitle,
  EmptyState,
  LoadingState,
  PageHeader,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { FileSignature } from "lucide-react";
import { useCallback } from "react";
import * as z from "zod/mini";
import { ESignCeremony } from "../../components/compliance/esign-ceremony.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, call } from "../../lib/api.js";
import { ceremonyOf, ndaStatusQuery } from "../../lib/esign-member-queries.js";
import { m } from "../../paraglide/messages.js";

/*
 * `/sign?documentId=…` — the top-level home of one e-signature NDA (E3.5, ADR-0040 decision 11).
 *
 * Two ways in, and both need a page that reads the state rather than assuming it:
 *
 *  - **The popup a framed portal opens.** A frame must not start a signature inside someone
 *    else's page, so it opens this path on the portal origin and waits; consent, start and the
 *    vendor redirect all happen here, first-party.
 *  - **The vendor's redirect after signing** (the envelope's `redirectUrl`). Arriving here proves
 *    nothing — the callback and the pull-verify decide — so the page polls the status.
 *
 * A workspace-wide NDA never reaches this component: the portal layout stands the acceptance
 * interstitial (which carries the same ceremony) in front of every route, this one included.
 * What renders here is the resource-scoped case, or the tail after the gate has opened.
 */
const searchSchema = z.object({
  documentId: z.catch(z.optional(z.string().check(z.regex(/^[0-9a-f-]{36}$/iu))), undefined),
});

export const Route = createFileRoute("/_portal/sign")({
  validateSearch: searchSchema,
  component: SignPage,
});

function SignPage() {
  const { documentId } = Route.useSearch();
  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <PageHeader title={m.esign_sign_page_title()} description={m.esign_sign_page_subtitle()} />
      {documentId === undefined ? <NothingToSign /> : <SignDocument documentId={documentId} />}
    </div>
  );
}

function NothingToSign() {
  return (
    <EmptyState
      icon={<FileSignature aria-hidden="true" />}
      title={m.esign_sign_page_empty_title()}
      description={m.esign_sign_page_empty_body()}
    />
  );
}

function SignDocument({ documentId }: { documentId: string }) {
  const queryClient = useQueryClient();
  const gates = useQuery({
    queryKey: ["compliance", "gates"],
    queryFn: () => call(api().GET("/compliance/gates")),
  });
  const status = useQuery(ndaStatusQuery(documentId));
  const unlocked = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    void queryClient.invalidateQueries({ queryKey: ["compliance", "gates"] });
    void queryClient.invalidateQueries({ queryKey: ["data-room"] });
  }, [queryClient]);

  if (gates.isPending) return <LoadingState label={m.common_loading()} />;
  if (gates.isError) return <ErrorAlert error={gates.error} />;
  const doc = gates.data.pending.find(
    (d) => d.documentId === documentId && ceremonyOf(d) === "esign",
  );
  if (doc !== undefined) {
    return <ESignCeremony doc={doc} idPrefix="sign" onCompleted={unlocked} />;
  }
  if (status.data?.status === "completed") {
    return (
      <Alert variant="success">
        <AlertTitle>{m.esign_sign_page_done_title()}</AlertTitle>
        <AlertDescription>
          <p>{m.esign_sign_page_done_body()}</p>
          <p>
            <Link to="/" className="font-medium underline underline-offset-4">
              {m.esign_sign_page_done_link()}
            </Link>
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  if (status.isPending) return <LoadingState label={m.common_loading()} />;
  return <NothingToSign />;
}
