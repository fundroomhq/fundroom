import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  Label,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Mail, PenLine } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { openInNewTab } from "../../embed/EmbedFrame.js";
import { useTopLevelPopup } from "../../embed/top-level-popup.js";
import { isApiError, isCode } from "../../lib/api.js";
import type { PendingAcceptance } from "../../lib/compliance-queries.js";
import type { WebConfig } from "../../lib/config.js";
import { useWebConfig } from "../../lib/config-context.js";
import {
  type EndedUnsigned,
  type ESignMemberErrorKind,
  esignErrorKind,
  esignVendorOf,
  lastUnsignedOutcome,
  myNdaEnvelopesQuery,
  ndaPollDelay,
  ndaStatusQuery,
  safeSigningUrl,
  startNda,
} from "../../lib/esign-member-queries.js";
import { formatDate } from "../../lib/format.js";
import { Markdown } from "../../lib/markdown.js";
import { useViewAs } from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { ErrorAlert } from "../error-alert.js";
import { legalKindLabel } from "./common.js";

/*
 * The e-signature NDA ceremony (E3.5, ADR-0053) — what a pending document shows instead of the
 * click-wrap card when its `ceremony` is `esign`.
 *
 * The rules it keeps, and why:
 *
 *  - **Consent to electronic records comes first, unticked.** The ESIGN Act (§101(c)) makes an
 *    electronic record stand in for a paper one only after the consumer has been shown a
 *    disclosure and affirmatively agreed. The box starts empty and the sign button is disabled
 *    until the member ticks it; the server refuses without it anyway (422
 *    `esign_consent_required`) and records the consent itself, hashed over its own canonical
 *    English text — the copy here is a translation of that text, not the evidence.
 *  - **The signature is taken at top level, never inside someone else's page** (ADR-0040
 *    decision 11, design/08 §6). Outside a frame, the vendor's signing page replaces this one
 *    (same tab): the start is an async POST, and a `window.open` after an `await` has lost the
 *    click's user activation, so Safari blocks it — while a same-tab navigation cannot be
 *    blocked, and the vendor's redirect brings the member back to `/sign`, which reads the status
 *    rather than assuming it. Inside a frame nothing is started here at all: the button opens
 *    the top-level popup on the portal origin (synchronously, inside the click, so it is not
 *    blocked) at `/sign?documentId=…`, and consent, start and the vendor redirect all happen
 *    there, first-party. The frame only watches the status.
 *  - **The status is the truth, not the redirect.** Returning from the vendor proves nothing —
 *    the vendor's callback and our pull-verify decide. So the ceremony polls
 *    `GET /esign/nda/status` with a backoff while an envelope is open (TanStack Query stops the
 *    interval while the tab is hidden and when the component unmounts), and only `completed`
 *    unlocks anything — by refetching the bootstrap, which is what decides whether the gate stands.
 *  - **Some vendors never give us a link** (Dropbox Sign has no top-level signing URL, so
 *    `signingUrl` is `null`): the member is told to check their email, and the same polling
 *    notices when they have signed there.
 */

/** Test seam: where a top-level navigation to the vendor goes. */
export const topLevelNavigation = {
  assign(url: string): void {
    window.location.assign(url);
  },
};

/** Is this document rendered inside someone else's page? */
export function isFramed(config: Pick<WebConfig, "tree">): boolean {
  if (config.tree === "embed") return true;
  try {
    return window.top !== window.self;
  } catch {
    // A cross-origin parent makes `window.top` throw in some engines: that is a frame.
    return true;
  }
}

/** 403 `forbidden` with reason `embed_frame`: the start was called from the embed tree. */
function isRefusedInFrame(error: unknown): boolean {
  return (
    isCode(error, "forbidden") && isApiError(error) && error.body.error["reason"] === "embed_frame"
  );
}

/** Tells the frame that opened this popup (if any) that the ceremony finished. Best effort. */
function notifyOpener(): void {
  try {
    const opener = window.opener as Window | null;
    if (opener === null || typeof opener.postMessage !== "function") return;
    // Same message the popup login posts; `openTopLevelPopup` checks the origin on arrival.
    opener.postMessage(
      { v: 1, type: "auth", payload: { state: "esign_completed" } },
      window.location.origin,
    );
  } catch {
    // A severed or cross-origin opener: the frame's own polling notices anyway.
  }
}

type Phase = "idle" | "emailed" | "popup" | "popup_blocked";

function errorCopy(kind: ESignMemberErrorKind, vendor: string): { title: string; body: string } {
  switch (kind) {
    case "consent_required":
      return { title: m.esign_err_consent_title(), body: m.esign_err_consent_body() };
    case "not_configured":
      return { title: m.esign_err_not_configured_title(), body: m.esign_err_not_configured_body() };
    case "provider":
      return { title: m.esign_err_provider_title(), body: m.esign_err_provider_body({ vendor }) };
    case "superseded":
      return { title: m.esign_nda_superseded_title(), body: m.esign_nda_superseded_body() };
    case "esign_required":
      return { title: m.esign_err_required_title(), body: m.esign_err_required_body() };
    case "not_pending":
      return { title: m.esign_err_not_pending_title(), body: m.esign_err_not_pending_body() };
    case "creating":
      return { title: m.esign_err_creating_title(), body: m.esign_err_creating_body() };
    case "start_budget":
      return { title: m.esign_err_budget_title(), body: m.esign_err_budget_body() };
    case "text_unsupported":
      return {
        title: m.esign_err_text_unsupported_title(),
        body: m.esign_err_text_unsupported_body(),
      };
  }
}

/** Why the member is being asked again: their last request for this document ended unsigned. */
function outcomeCopy(outcome: EndedUnsigned, vendor: string): { title: string; body: string } {
  switch (outcome) {
    case "declined":
      return {
        title: m.esign_nda_prev_declined_title(),
        body: m.esign_nda_prev_declined_body({ vendor }),
      };
    case "voided":
      return { title: m.esign_nda_prev_voided_title(), body: m.esign_nda_prev_voided_body() };
    case "expired":
      return { title: m.esign_nda_prev_expired_title(), body: m.esign_nda_prev_expired_body() };
    case "error":
      return { title: m.esign_nda_prev_error_title(), body: m.esign_nda_prev_error_body() };
  }
}

function CeremonyError({ error, vendor }: { error: unknown; vendor: string }) {
  const kind = esignErrorKind(error);
  if (kind === undefined) return <ErrorAlert error={error} />;
  const copy = errorCopy(kind, vendor);
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>{copy.body}</AlertDescription>
    </Alert>
  );
}

/** The ESIGN consumer disclosure and the box that consents to it. */
function ConsentBlock({
  boxId,
  checked,
  onCheckedChange,
}: {
  boxId: string;
  checked: boolean;
  onCheckedChange: (on: boolean) => void;
}) {
  return (
    <div className="space-y-3 rounded-md border bg-muted/30 p-4 text-sm">
      <h3 className="font-medium">{m.esign_consent_title()}</h3>
      <div className="space-y-2 text-muted-foreground" id={`${boxId}-disclosure`}>
        <p>{m.esign_consent_disclosure_1()}</p>
        <p>{m.esign_consent_disclosure_2()}</p>
        <p>{m.esign_consent_disclosure_3()}</p>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id={boxId}
          checked={checked}
          aria-describedby={`${boxId}-disclosure`}
          onCheckedChange={(on) => onCheckedChange(on === true)}
        />
        <Label htmlFor={boxId} className="leading-snug">
          {m.esign_consent_agree()}
        </Label>
      </div>
    </div>
  );
}

export interface ESignCeremonyProps {
  readonly doc: PendingAcceptance;
  /** Distinguishes control ids when two ceremonies can be mounted at once. */
  readonly idPrefix: string;
  /** Rendered beside the sign button (the interstitial puts "Sign out" there). */
  readonly secondaryAction?: ReactNode;
  /**
   * Called when the server reports the NDA signed — and again, on a backoff, for as long as the
   * surface keeps this card mounted. It must be idempotent (a refetch); the surface decides what
   * unlocks, and unmounting the card is what says it has.
   */
  readonly onCompleted: () => void;
}

export function ESignCeremony({ doc, idPrefix, secondaryAction, onCompleted }: ESignCeremonyProps) {
  const config = useWebConfig();
  // The server has the last word on "is this a frame" (403 `embed_frame` on the start); when it
  // says so, the ceremony switches to the popup even if the browser-side check missed it.
  const [serverSaysFramed, setServerSaysFramed] = useState(false);
  const framed = serverSaysFramed || isFramed(config);
  const viewingAs = useViewAs() !== null;
  const queryClient = useQueryClient();
  const runAtTopLevel = useTopLevelPopup();
  const vendor = esignVendorOf(doc);
  const vendorName = vendor?.displayName ?? m.esign_vendor_fallback();
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");

  const status = useQuery({
    ...ndaStatusQuery(doc.documentId),
    refetchInterval: (query) => {
      const s = query.state.data?.status;
      const watching =
        s === "open" || ((phase === "popup" || phase === "emailed") && s !== "completed");
      return watching ? ndaPollDelay(query.state.dataUpdateCount) : false;
    },
    // Hidden tab: no polling. Focus brings a refetch, which is when the member is back anyway
    // (from the vendor's tab, the popup, or their inbox).
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    staleTime: 0,
  });
  const current = status.data?.status;
  // Nothing open: if the last request for this document ended unsigned, say how, so the
  // sign button below reads as "again" rather than as if nothing had happened.
  const history = useQuery({ ...myNdaEnvelopesQuery, enabled: current === "none" });
  const previous =
    current === "none" && history.data !== undefined
      ? lastUnsignedOutcome(history.data.items, doc.documentId)
      : undefined;

  /*
   * Completion unlocks by refreshing whatever decides the gate. The envelope can read
   * `completed` a moment before the acceptance is on record (the signed copy is collected and
   * the attestation written by a job), so while this card is still mounted — i.e. the surface
   * still lists the document as owed — the refresh repeats on the same backoff. The surface
   * unmounting this card is what ends it.
   */
  const onCompletedRef = useRef(onCompleted);
  onCompletedRef.current = onCompleted;
  useEffect(() => {
    if (current !== "completed") return;
    if (!framed) notifyOpener();
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (typeof document === "undefined" || document.visibilityState !== "hidden") {
        onCompletedRef.current();
      }
      timer = setTimeout(tick, ndaPollDelay(++attempt));
    };
    tick();
    return () => clearTimeout(timer);
  }, [current, framed]);

  // A newer version outranks the one on screen: fetch it, so the text signed is the text shown.
  const refreshedForSupersede = useRef(false);
  useEffect(() => {
    if (current !== "superseded" || refreshedForSupersede.current) return;
    refreshedForSupersede.current = true;
    void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
    void queryClient.invalidateQueries({ queryKey: ["compliance", "gates"] });
  }, [current, queryClient]);

  const start = useGuardedMutation({
    mutationFn: () => startNda(doc.documentId),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: ndaStatusQuery(doc.documentId).queryKey });
      const url = safeSigningUrl(result.signingUrl);
      if (url === undefined) {
        setPhase("emailed");
        return;
      }
      topLevelNavigation.assign(url);
    },
    onError: (error) => {
      if (isRefusedInFrame(error)) {
        setServerSaysFramed(true);
        return;
      }
      const kind = esignErrorKind(error);
      if (kind === "superseded" || kind === "not_pending") {
        // The document on screen is no longer what is owed: fetch what is.
        void queryClient.invalidateQueries({ queryKey: ["bootstrap"] });
        void queryClient.invalidateQueries({ queryKey: ["compliance", "gates"] });
      }
      if (kind === "creating") {
        // Another tab's start is still reaching the vendor: the status turns `open` shortly and
        // the card offers to continue with that envelope.
        void queryClient.invalidateQueries({ queryKey: ndaStatusQuery(doc.documentId).queryKey });
      }
    },
  });

  const openPopup = () => {
    setPhase("popup");
    void runAtTopLevel("/sign", { documentId: doc.documentId }).then((outcome) => {
      if (outcome === "blocked") setPhase("popup_blocked");
      else void status.refetch();
    });
  };

  /*
   * `esign: null` on an e-sign document means the workspace's vendor connection is gone: the
   * server would refuse the start (409 `esign_not_configured`), so say so up front instead of
   * offering a button that can only fail. Staff viewing as the member are read-only (E2.7).
   */
  const unavailable = vendor === undefined;
  const blocked = viewingAs || unavailable;
  const boxId = `${idPrefix}-esign-consent-${doc.documentId}`;
  const inProgress = current === "open" || phase === "emailed";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{doc.title}</CardTitle>
        <CardDescription>
          {m.acceptance_gate_version({
            kind: legalKindLabel(doc.kind),
            version: String(doc.versionNo),
            date: formatDate(doc.effectiveAt),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">{m.esign_nda_intro({ vendor: vendorName })}</p>
        <section
          className="max-h-72 space-y-3 overflow-y-auto rounded-md border p-4 text-sm"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a focusable scroll region so the text can be read without a mouse (WAI-ARIA scrollable region pattern)
          tabIndex={0}
          aria-label={m.acceptance_gate_document_label({ title: doc.title })}
        >
          <Markdown source={doc.body} />
        </section>

        {start.isError && !isRefusedInFrame(start.error) ? (
          <CeremonyError error={start.error} vendor={vendorName} />
        ) : null}
        {status.isError ? <ErrorAlert error={status.error} /> : null}
        {unavailable && current !== "completed" ? (
          <Alert variant="warning">
            <AlertTitle>{m.esign_err_not_configured_title()}</AlertTitle>
            <AlertDescription>{m.esign_err_not_configured_body()}</AlertDescription>
          </Alert>
        ) : null}

        {current === "completed" ? (
          <Alert variant="success">
            <AlertTitle>{m.esign_nda_completed_title()}</AlertTitle>
            <AlertDescription>{m.esign_nda_completed_body()}</AlertDescription>
          </Alert>
        ) : null}

        {current === "failed" ? (
          <Alert variant="warning">
            <AlertTitle>{m.esign_nda_failed_title()}</AlertTitle>
            <AlertDescription>{m.esign_nda_failed_body({ vendor: vendorName })}</AlertDescription>
          </Alert>
        ) : null}

        {previous === undefined || phase !== "idle" ? null : (
          <Alert variant="warning">
            <AlertTitle>{outcomeCopy(previous, vendorName).title}</AlertTitle>
            <AlertDescription>{outcomeCopy(previous, vendorName).body}</AlertDescription>
          </Alert>
        )}

        {current === "superseded" ? (
          <Alert variant="warning">
            <AlertTitle>{m.esign_nda_superseded_title()}</AlertTitle>
            <AlertDescription>{m.esign_nda_superseded_body()}</AlertDescription>
          </Alert>
        ) : null}

        {current === "completed" ? null : phase === "popup" || phase === "popup_blocked" ? (
          <PopupWaiting
            blocked={phase === "popup_blocked"}
            vendor={vendorName}
            onRetry={openPopup}
            onNewTab={() =>
              openInNewTab(
                config.canonicalOrigin,
                `/sign?documentId=${encodeURIComponent(doc.documentId)}`,
              )
            }
          />
        ) : inProgress ? (
          <div className="space-y-3">
            {phase === "emailed" ? (
              <Alert>
                <Mail aria-hidden="true" />
                <AlertTitle>{m.esign_nda_emailed_title()}</AlertTitle>
                <AlertDescription>
                  {m.esign_nda_emailed_body({ vendor: vendorName })}
                </AlertDescription>
              </Alert>
            ) : (
              <Alert>
                <PenLine aria-hidden="true" />
                <AlertTitle>{m.esign_nda_open_title()}</AlertTitle>
                <AlertDescription>{m.esign_nda_open_body({ vendor: vendorName })}</AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap items-center gap-3">
              {/*
               * Resuming re-posts the start, which the server answers idempotently with the open
               * envelope (and a fresh link when the vendor has one). An open envelope exists only
               * because this member already consented, and the server holds that record.
               */}
              {framed ? (
                <Button type="button" variant="outline" disabled={blocked} onClick={openPopup}>
                  <ExternalLink aria-hidden="true" />
                  {m.esign_nda_continue_window()}
                </Button>
              ) : phase === "emailed" ? null : (
                <Button
                  type="button"
                  variant="outline"
                  loading={start.isPending}
                  disabled={blocked}
                  onClick={() => start.mutate()}
                >
                  {m.esign_nda_continue({ vendor: vendorName })}
                </Button>
              )}
              {secondaryAction}
            </div>
          </div>
        ) : framed ? (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{m.esign_nda_framed_body()}</p>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" disabled={blocked} onClick={openPopup}>
                <ExternalLink aria-hidden="true" />
                {m.esign_nda_sign_window({ vendor: vendorName })}
              </Button>
              {secondaryAction}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <ConsentBlock boxId={boxId} checked={consent} onCheckedChange={setConsent} />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                loading={start.isPending}
                disabled={!consent || blocked || status.isPending}
                onClick={() => start.mutate()}
              >
                <PenLine aria-hidden="true" />
                {m.esign_nda_sign({ vendor: vendorName })}
              </Button>
              {secondaryAction}
            </div>
            <p className="text-muted-foreground text-xs">{m.esign_nda_footnote()}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PopupWaiting({
  blocked,
  vendor,
  onRetry,
  onNewTab,
}: {
  blocked: boolean;
  vendor: string;
  onRetry: () => void;
  onNewTab: () => void;
}) {
  return (
    <div className="space-y-3">
      {blocked ? (
        <Alert variant="warning">
          <AlertTitle>{m.esign_nda_popup_blocked_title()}</AlertTitle>
          <AlertDescription>{m.esign_nda_popup_blocked_body()}</AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <ExternalLink aria-hidden="true" />
          <AlertTitle>{m.esign_nda_popup_title()}</AlertTitle>
          <AlertDescription>{m.esign_nda_popup_body({ vendor })}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" onClick={onRetry}>
          {m.esign_nda_popup_reopen()}
        </Button>
        {blocked ? (
          <Button type="button" variant="ghost" onClick={onNewTab}>
            {m.esign_nda_popup_new_tab()}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
