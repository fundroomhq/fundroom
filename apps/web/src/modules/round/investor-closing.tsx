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
  cn,
  toast,
} from "@fundroomhq/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, Circle, Download, Mail } from "lucide-react";
import { ErrorAlert } from "../../components/error-alert.js";
import { describeError, isCode } from "../../lib/api.js";
import { downloadMySignedCopy } from "../../lib/esign-member-queries.js";
import { formatDate } from "../../lib/format.js";
import { useViewAs } from "../../lib/queries.js";
import {
  isDeadSignatureRequest,
  isOpenSignatureRequest,
  isStalledSignatureRequest,
  type MemberClosingChecklist,
  type MemberClosingCommitment,
  roundMemberClosingQuery,
} from "../../lib/round-closing-member-queries.js";
import { m } from "../../paraglide/messages.js";
import { commitmentStatusLabel, commitmentStatusVariant, formatMoney } from "./format.js";

/*
 * The investor's closing checklist (E3.5 §6): one card per commitment of theirs, four stages —
 * documents sent, signed, funds received, confirmed — each with its date once it happened.
 *
 * The subscription agreement is never signed from here. Round envelopes are emailed by the
 * vendor (`embedded: false`), so an open request reads "check your email", and the signed copy,
 * once collected, downloads from the member's own `/esign/me/envelopes/{id}/signed.pdf`. Who may
 * do either is the server's call (`canSign`, `signedDocumentAvailable`): a delegate sees the
 * same stages with neither action.
 *
 * Nothing renders at all while the investor has no commitment — a checklist of empty circles
 * for someone who has only expressed interest would read as a promise the round has not made.
 */

const STAGES: readonly {
  key: string;
  label: () => string;
  at: (c: MemberClosingChecklist) => string | null;
  done: (c: MemberClosingChecklist) => boolean;
}[] = [
  {
    key: "sent",
    label: () => m.round_closing_member_stage_sent(),
    done: (c) => c.documentsSent,
    at: (c) => c.documentsSentAt,
  },
  {
    key: "signed",
    label: () => m.round_closing_member_stage_signed(),
    done: (c) => c.signed,
    at: (c) => c.signedAt,
  },
  {
    key: "wired",
    label: () => m.round_closing_member_stage_wired(),
    done: (c) => c.wired,
    at: (c) => c.wiredAt,
  },
  {
    key: "confirmed",
    label: () => m.round_closing_member_stage_confirmed(),
    done: (c) => c.confirmed,
    at: (c) => c.confirmedAt,
  },
];

function StageList({ checklist }: { checklist: MemberClosingChecklist }) {
  return (
    <ol className="grid gap-2 sm:grid-cols-4" aria-label={m.round_closing_member_stages_label()}>
      {STAGES.map((stage) => {
        const done = stage.done(checklist);
        const at = stage.at(checklist);
        return (
          <li
            key={stage.key}
            className={cn(
              "flex items-start gap-2 rounded-md border p-3 text-sm",
              done ? "border-success/40" : "border-dashed",
            )}
          >
            {done ? (
              <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success" />
            ) : (
              <Circle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="space-y-0.5">
              <span className="block font-medium">{stage.label()}</span>
              <span className="block text-xs text-muted-foreground">
                {done
                  ? at === null
                    ? m.round_closing_member_done()
                    : m.round_closing_member_done_on({ date: formatDate(at) })
                  : m.round_closing_member_pending()}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function SignedCopyButton({ envelopeId }: { envelopeId: string }) {
  const download = useMutation({
    mutationFn: () =>
      downloadMySignedCopy({ id: envelopeId, title: m.round_closing_member_file() }),
    onError: (error) => toast.error(describeError(error).body),
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      loading={download.isPending}
      onClick={() => download.mutate()}
    >
      <Download aria-hidden="true" />
      {m.round_closing_member_download()}
    </Button>
  );
}

function CommitmentClosing({
  commitment,
  readOnly,
  viewingAs,
}: {
  commitment: MemberClosingCommitment;
  /** A delegate's view of their principal's commitment. */
  readOnly: boolean;
  viewingAs: boolean;
}) {
  const req = commitment.signatureRequest;
  const { checklist } = commitment;
  const amount = formatMoney(commitment.amount, commitment.currency);
  // The investor is the one being asked, whether or not the vendor's email has gone out yet;
  // a delegate is told who is being asked instead.
  const forMe = !readOnly && (commitment.canSign || isOpenSignatureRequest(req));
  return (
    <section
      className="space-y-3 rounded-lg border p-4"
      aria-label={m.round_closing_member_commitment_label({ amount })}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-base font-semibold tabular-nums">{amount}</p>
        <Badge variant={commitmentStatusVariant(commitment.status)}>
          {commitmentStatusLabel(commitment.status)}
        </Badge>
      </div>
      <StageList checklist={checklist} />

      {checklist.confirmed ? (
        <Alert variant="success">
          <CheckCircle2 aria-hidden="true" />
          <AlertTitle>{m.round_closing_member_confirmed_title()}</AlertTitle>
          <AlertDescription>
            {checklist.confirmedAt === null
              ? m.round_closing_member_confirmed_body_undated()
              : m.round_closing_member_confirmed_body({ date: formatDate(checklist.confirmedAt) })}
          </AlertDescription>
        </Alert>
      ) : commitment.canSign || isOpenSignatureRequest(req) ? (
        <Alert>
          <Mail aria-hidden="true" />
          <AlertTitle>
            {forMe
              ? m.round_closing_member_email_title()
              : m.round_closing_member_email_other_title()}
          </AlertTitle>
          <AlertDescription>
            {forMe
              ? m.round_closing_member_email_body()
              : m.round_closing_member_email_other_body()}
          </AlertDescription>
        </Alert>
      ) : isStalledSignatureRequest(req, commitment.envelopeId) ? (
        <Alert variant="warning">
          <AlertTitle>{m.round_closing_member_stalled_title()}</AlertTitle>
          <AlertDescription>{m.round_closing_member_stalled_body()}</AlertDescription>
        </Alert>
      ) : isDeadSignatureRequest(req, commitment.envelopeId) ? (
        <Alert variant="warning">
          <AlertTitle>{m.round_closing_member_dead_title()}</AlertTitle>
          <AlertDescription>{m.round_closing_member_dead_body()}</AlertDescription>
        </Alert>
      ) : null}

      {commitment.signedDocumentAvailable && commitment.envelopeId !== null && !viewingAs ? (
        <SignedCopyButton envelopeId={commitment.envelopeId} />
      ) : null}
    </section>
  );
}

export function InvestorClosingCard() {
  const closing = useQuery(roundMemberClosingQuery);
  // Staff viewing as the investor may not download as them (E2.7): no button that can only fail.
  const viewingAs = useViewAs() !== null;
  if (closing.isPending) return null;
  if (closing.isError) {
    // No closing for this member (or none yet): the round page stands without the card.
    if (isCode(closing.error, "not_found")) return null;
    return <ErrorAlert error={closing.error} />;
  }
  const { commitments } = closing.data;
  if (commitments.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.round_closing_member_title()}</CardTitle>
        <CardDescription>{m.round_closing_member_subtitle()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {commitments.map((c) => (
          <CommitmentClosing
            key={c.commitmentId}
            commitment={c}
            readOnly={closing.data.readOnly}
            viewingAs={viewingAs}
          />
        ))}
      </CardContent>
    </Card>
  );
}
