import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Mail, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { isFramed } from "../../components/compliance/esign-ceremony.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { openInNewTab } from "../../embed/EmbedFrame.js";
import { isApiError } from "../../lib/api.js";
import { useWebConfig } from "../../lib/config-context.js";
import { formatDate } from "../../lib/format.js";
import type { Subject } from "../../lib/round-queries.js";
import {
  handoffHref,
  isStarting,
  isStuckStarting,
  isVendorEnded,
  MY_VERIFICATION_KEY,
  type MyVerification,
  myVerificationQuery,
  pendingVerificationOf,
  RENEWAL_NOT_RECERTIFIED,
  STARTING_WINDOW_MS,
  startVerification,
  VENDOR_START_FAILED,
  vendorErrorOf,
  verificationPollInterval,
} from "../../lib/round-verification-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { EvidenceUpload } from "./interest-form.js";

/*
 * The investor's accreditation verification (E3.7, ADR-0055), driven entirely by
 * `GET /round/current/verification`.
 *
 * How the investor continues is the server's `handoff`, never a guess from the provider name:
 *
 *  - `upload`      — manual review: the evidence upload, and only then (a vendor row must never
 *                    offer an upload — the vendor, not the company, looks at the documents).
 *  - `invite_sent` — the vendor emailed a link; the card says to look for it.
 *  - `widget` / `redirect` — a link to continue with the vendor. A plain top-level navigation:
 *                    the handoff page sets its own CSP and must not be framed.
 *  - `null`        — the vendor start runs in a job after the POST answered, so the card says
 *                    "setting up" and polls quickly for a while (see `verificationPollInterval`).
 *
 * Copy stays neutral: it says what happens next, never whether somebody "qualifies", and it is
 * not legal advice.
 */

function statusBadge(v: MyVerification) {
  switch (v.status) {
    case "verified":
      return <Badge variant="success">{m.round_myverif_status_verified()}</Badge>;
    case "rejected":
      return <Badge variant="outline">{m.round_myverif_status_rejected()}</Badge>;
    case "expired":
      return <Badge variant="outline">{m.round_myverif_status_expired()}</Badge>;
    default:
      return <Badge variant="secondary">{m.round_myverif_status_pending()}</Badge>;
  }
}

function StartForm({
  label,
  onStarted,
}: {
  label: string;
  onStarted: (v: MyVerification) => void;
}) {
  const name = useId();
  const [subject, setSubject] = useState<Subject>("individual");
  const queryClient = useQueryClient();
  const start = useGuardedMutation({
    mutationFn: () => startVerification({ subject }),
    onSuccess: (row) => {
      queryClient.setQueryData(MY_VERIFICATION_KEY, { verification: row });
      onStarted(row);
      toast.success(m.round_myverif_started());
    },
    onError: (error) => {
      // One is already pending: show it rather than an error. The server says which.
      const pending = pendingVerificationOf(error);
      if (pending !== undefined) {
        queryClient.setQueryData(MY_VERIFICATION_KEY, { verification: pending });
        onStarted(pending);
        toast.info(m.round_myverif_already_pending());
      }
    },
  });
  const error = pendingVerificationOf(start.error) === undefined ? start.error : null;
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
    >
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">{m.round_myverif_subject_legend()}</legend>
        <div className="flex flex-wrap gap-4">
          {(["individual", "entity"] as const).map((value) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={name}
                value={value}
                checked={subject === value}
                onChange={() => setSubject(value)}
              />
              {value === "individual" ? m.round_subject_individual() : m.round_subject_entity()}
            </label>
          ))}
        </div>
      </fieldset>
      <ErrorAlert error={error} />
      <Button type="submit" loading={start.isPending}>
        <ShieldCheck aria-hidden="true" />
        {label}
      </Button>
    </form>
  );
}

function Pending({
  v,
  startingSince,
  onRefresh,
  refreshing,
}: {
  v: MyVerification;
  startingSince: number | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const provider = v.providerLabel;
  // Re-render once when the fast-polling window closes, so the copy can say so.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (startingSince === null) return undefined;
    const left = STARTING_WINDOW_MS - (Date.now() - startingSince);
    if (left <= 0) return undefined;
    const timer = setTimeout(() => setTick((n) => n + 1), left + 50);
    return () => clearTimeout(timer);
  }, [startingSince]);

  const config = useWebConfig();
  const framed = isFramed(config);

  // Round stopped working this row for good (member left or erased, imported row): no retry.
  if (isVendorEnded(v)) {
    return <p className="text-sm">{m.round_myverif_vendor_ended({ provider })}</p>;
  }
  const handoff = v.handoff;
  // A renewal the vendor answered with the accreditation already on file: say why it is still
  // open, then show the usual way to continue. Polling carries on.
  const renewalNote =
    vendorErrorOf(v) === RENEWAL_NOT_RECERTIFIED ? (
      <p className="text-sm">{m.round_myverif_renewal_not_recertified({ provider })}</p>
    ) : null;
  if (handoff === null) {
    if (v.vendorStatus === VENDOR_START_FAILED) {
      return <p className="text-sm">{m.round_myverif_start_failed({ provider })}</p>;
    }
    if (!isStarting(v)) {
      return <p className="text-sm">{m.round_myverif_pending_review()}</p>;
    }
    // Stuck for 15 minutes: round's sweep re-runs it, so say so instead of spinning.
    if (isStuckStarting(v, Date.now())) {
      return <p className="text-sm">{m.round_myverif_starting_stuck({ provider })}</p>;
    }
    const gaveUp = startingSince !== null && Date.now() - startingSince >= STARTING_WINDOW_MS;
    return gaveUp ? (
      <div className="space-y-3">
        <p className="text-sm">{m.round_myverif_starting_slow({ provider })}</p>
        <Button type="button" variant="outline" loading={refreshing} onClick={onRefresh}>
          <RefreshCw aria-hidden="true" />
          {m.round_myverif_check_again()}
        </Button>
      </div>
    ) : (
      <p role="status" className="text-sm">
        {m.round_myverif_starting({ provider })}
      </p>
    );
  }
  switch (handoff.kind) {
    case "upload":
      return (
        <div className="space-y-3">
          <p className="text-sm">{m.round_myverif_pending_upload()}</p>
          <EvidenceUpload verificationId={v.id} />
        </div>
      );
    case "invite_sent":
      return (
        <div className="space-y-3">
          {renewalNote}
          <p className="flex items-start gap-2 text-sm">
            <Mail aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <span>{m.round_myverif_invite_sent({ provider })}</span>
          </p>
        </div>
      );
    case "widget":
    case "redirect": {
      /*
       * Embedded: the handoff page refuses to be framed (`frame-ancestors 'none'`, XFO DENY) and
       * a new tab may not carry the frame's partitioned session, so the investor is sent to the
       * portal at its own address and continues there.
       */
      if (framed) {
        const portalPath = "/round";
        const portalHref = `${config.canonicalOrigin.replace(/\/$/u, "")}${portalPath}`;
        return (
          <div className="space-y-3">
            {renewalNote}
            <p className="text-sm">{m.round_myverif_embedded({ provider })}</p>
            <Button asChild variant="outline">
              <a
                href={portalHref}
                target="_blank"
                rel="noopener"
                onClick={(e) => {
                  e.preventDefault();
                  openInNewTab(config.canonicalOrigin, portalPath);
                }}
              >
                <ExternalLink aria-hidden="true" />
                {m.round_myverif_open_portal()}
              </a>
            </Button>
          </div>
        );
      }
      const href = handoffHref(handoff.url);
      return (
        <div className="space-y-3">
          {renewalNote}
          <p className="text-sm">{m.round_myverif_continue_hint({ provider })}</p>
          {href === undefined ? null : (
            <Button asChild>
              <a href={href} rel="noopener noreferrer">
                <ExternalLink aria-hidden="true" />
                {m.round_myverif_continue({ provider })}
              </a>
            </Button>
          )}
        </div>
      );
    }
    default:
      return null;
  }
}

export function VerificationCard({ needed }: { needed: boolean }) {
  const startingSince = useRef<number | null>(null);
  const [renewing, setRenewing] = useState(false);
  const query = useQuery({
    ...myVerificationQuery,
    refetchInterval: (q) => {
      const v = q.state.data?.verification;
      if (!isStarting(v)) startingSince.current = null;
      else startingSince.current ??= Date.now();
      return verificationPollInterval(v, startingSince.current, Date.now());
    },
    // Explicit: a hidden tab does not poll.
    refetchIntervalInBackground: false,
  });

  const v = query.data?.verification ?? null;
  if (isStarting(v)) startingSince.current ??= Date.now();
  else startingSince.current = null;

  // The module answers 404 when the route is not there (an older server); draw nothing.
  if (query.isError && isApiError(query.error) && query.error.status === 404) return null;
  if (query.isPending) return null;
  if (v === null && !needed && !query.isError) return null;

  const onStarted = (row: MyVerification) => {
    setRenewing(false);
    startingSince.current = isStarting(row) ? Date.now() : null;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <ShieldCheck aria-hidden="true" className="size-5" />
          {m.round_myverif_title()}
          {v === null ? null : statusBadge(v)}
        </CardTitle>
        <CardDescription>{m.round_myverif_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ErrorAlert error={query.isError ? query.error : null} />
        {v === null ? (
          query.isError ? null : (
            <>
              <p className="text-sm">{m.round_myverif_none()}</p>
              <StartForm label={m.round_myverif_start()} onStarted={onStarted} />
            </>
          )
        ) : v.status === "pending" ? (
          <Pending
            v={v}
            startingSince={startingSince.current}
            refreshing={query.isFetching}
            onRefresh={() => {
              startingSince.current = Date.now();
              void query.refetch();
            }}
          />
        ) : (
          <>
            <p className="text-sm">
              {v.status === "verified"
                ? v.expiresAt === null
                  ? m.round_myverif_verified({ provider: v.providerLabel })
                  : m.round_myverif_verified_until({
                      provider: v.providerLabel,
                      date: formatDate(v.expiresAt),
                    })
                : v.status === "rejected"
                  ? m.round_myverif_rejected()
                  : m.round_myverif_expired()}
            </p>
            {!v.canRenew ? null : renewing || v.status !== "verified" ? (
              <StartForm
                label={
                  v.status === "verified" ? m.round_myverif_renew() : m.round_myverif_start_again()
                }
                onStarted={onStarted}
              />
            ) : (
              <Button type="button" variant="outline" onClick={() => setRenewing(true)}>
                <RefreshCw aria-hidden="true" />
                {m.round_myverif_renew()}
              </Button>
            )}
          </>
        )}
        <p className="text-xs text-muted-foreground">{m.round_myverif_not_advice()}</p>
      </CardContent>
    </Card>
  );
}
