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
  EmptyState,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  toast,
} from "@fundroomhq/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { FileJson } from "lucide-react";
import { useId } from "react";
import { describeError } from "../../lib/api.js";
import {
  type AuditAnchorItem,
  type AuditAnchorSummary,
  auditAnchorsQuery,
  downloadAnchorProof,
} from "../../lib/audit-queries.js";
import { formatDateTime } from "../../lib/format.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { PlanFeatureNotice, usePlanAllowsFeature } from "../billing/plan-feature-notice.js";
import { ErrorAlert } from "../error-alert.js";

/*
 * External anchoring on the audit page (E3.13, ADR-0061). Every night the server hashes each
 * workspace's newest checkpoint into a Merkle tree and has the root witnessed by an RFC 3161
 * time-stamp authority and/or a Rekor transparency log. This card says whether the operator has
 * turned that on, lists checkpoints with their receipts, and (for `audit.export`) hands out the
 * self-contained proof a third party checks offline with `fundroom audit verify-anchor`.
 */

/** A shell command, not copy: the CLI's own syntax. */
const VERIFY_ANCHOR_COMMAND =
  "fundroom audit verify-anchor audit-anchor-proof-<seq>.json --anchor-cert <tsa.pem>";

/** A driver id as a reader would name it; unknown kinds are shown verbatim. */
export function anchorKindLabel(kind: string): string {
  switch (kind) {
    case "rfc3161":
      return m.audit_anchor_kind_rfc3161();
    case "rekor":
      return m.audit_anchor_kind_rekor();
    default:
      return kind;
  }
}

/**
 * A transparency-log (Rekor) receipt proves the root is in a public append-only log, not when:
 * its time is ours (the submitter's). Only an RFC 3161 time-stamp is trusted time (ADR-0061).
 */
function presenceOnly(kind: string): boolean {
  return kind === "rekor";
}

/** Never green unless a receipt exists; a checkpoint whose retries ran out says so. */
function AnchorStateBadge({ state }: { state: AuditAnchorItem["state"] }) {
  switch (state) {
    case "anchored":
      return <Badge variant="success">{m.audit_anchors_status_anchored()}</Badge>;
    case "pending":
      return <Badge variant="outline">{m.audit_anchors_status_pending()}</Badge>;
    case "failed":
      return <Badge variant="destructive">{m.audit_anchors_status_failed()}</Badge>;
  }
}

export function AnchorsCard({ canExport }: { canExport: boolean }) {
  const anchors = useInfiniteQuery(auditAnchorsQuery());
  const first = anchors.data?.pages[0];
  const configured = first?.configured ?? [];
  // A-3 (decision 20): every workspace is anchored whatever its plan; downloading a proof is
  // what needs `anchoring`. The server says which (`planAllows`); the bootstrap's plan stands in
  // until the first page arrives.
  const planByBootstrap = usePlanAllowsFeature("anchoring");
  const proofsAllowed = first?.planAllows ?? planByBootstrap;
  const noticeId = useId();
  const items = anchors.data?.pages.flatMap((page) => page.items) ?? [];
  // Off: say so, and only list checkpoints if some were anchored before it was turned off.
  const showList = configured.length > 0 || items.some((item) => item.anchored);
  const proof = useGuardedMutation({
    mutationFn: (item: AuditAnchorItem) => downloadAnchorProof(item),
    onSuccess: (result) => toast.success(m.audit_anchors_proof_saved({ file: result.filename })),
    onError: (error) => toast.error(describeError(error).body),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.audit_anchors_title()}</CardTitle>
        <CardDescription>{m.audit_anchors_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {anchors.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
        {anchors.isError ? <ErrorAlert error={anchors.error} /> : null}
        {first ? (
          configured.length === 0 ? (
            <Alert role="note">
              <AlertTitle>{m.audit_anchors_off_title()}</AlertTitle>
              <AlertDescription>
                <p>{m.audit_anchors_off_body()}</p>
                <p className="mt-2">{m.audit_anchors_off_operator()}</p>
              </AlertDescription>
            </Alert>
          ) : (
            <div className="space-y-1 text-sm">
              <p className="font-medium">{m.audit_anchors_configured()}</p>
              <ul aria-label={m.audit_anchors_configured()} className="flex flex-wrap gap-2">
                {configured.map((kind) => (
                  <li key={kind}>
                    <Badge variant="secondary">{anchorKindLabel(kind)}</Badge>
                  </li>
                ))}
              </ul>
            </div>
          )
        ) : null}
        {first ? (
          <PlanFeatureNotice feature="anchoring" id={noticeId} allowed={proofsAllowed} />
        ) : null}
        {first && showList ? (
          items.length === 0 ? (
            <EmptyState
              title={m.audit_anchors_empty()}
              description={m.audit_anchors_empty_body()}
            />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{m.audit_anchors_col_checkpoint()}</TableHead>
                    <TableHead>{m.audit_anchors_col_status()}</TableHead>
                    <TableHead>{m.audit_anchors_col_receipts()}</TableHead>
                    {canExport ? (
                      <TableHead>
                        <span className="sr-only">{m.audit_anchors_col_proof()}</span>
                      </TableHead>
                    ) : null}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => (
                    <TableRow key={item.checkpointId}>
                      <TableCell className="whitespace-nowrap">
                        <span className="block font-medium">
                          {m.audit_anchors_checkpoint_seq({ seq: String(item.seq) })}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatDateTime(item.createdAt)}
                        </span>
                      </TableCell>
                      <TableCell>
                        <AnchorStateBadge state={item.state} />
                      </TableCell>
                      <TableCell>
                        {item.receipts.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <ul className="space-y-1">
                            {item.receipts.map((receipt) => (
                              <li key={receipt.kind} className="text-xs">
                                <span className="font-medium">{anchorKindLabel(receipt.kind)}</span>
                                {" · "}
                                {presenceOnly(receipt.kind)
                                  ? m.audit_anchors_receipt_presence({
                                      time: formatDateTime(receipt.anchoredAt),
                                    })
                                  : m.audit_anchors_receipt_timestamped({
                                      time: formatDateTime(receipt.anchoredAt),
                                    })}
                                <span className="block break-all font-mono text-muted-foreground">
                                  {receipt.reference}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </TableCell>
                      {canExport ? (
                        <TableCell>
                          {item.anchored ? (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              loading={
                                proof.isPending &&
                                proof.variables?.checkpointId === item.checkpointId
                              }
                              aria-label={m.audit_anchors_proof_named({ seq: String(item.seq) })}
                              // The notice above says why (decision 20).
                              disabled={!proofsAllowed}
                              aria-describedby={proofsAllowed ? undefined : noticeId}
                              onClick={() => proof.mutate(item)}
                            >
                              <FileJson aria-hidden="true" />
                              {m.audit_anchors_proof()}
                            </Button>
                          ) : null}
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {anchors.hasNextPage ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  loading={anchors.isFetchingNextPage}
                  onClick={() => void anchors.fetchNextPage()}
                >
                  {m.common_load_more()}
                </Button>
              ) : null}
            </>
          )
        ) : null}
        {first && configured.length > 0 ? (
          <div className="space-y-1 text-sm text-muted-foreground">
            <p>{m.audit_anchors_pending_note()}</p>
            {canExport ? (
              <>
                <p>{m.audit_anchors_howto()}</p>
                <pre className="overflow-auto rounded bg-muted p-2 font-mono text-xs text-foreground">
                  {VERIFY_ANCHOR_COMMAND}
                </pre>
              </>
            ) : (
              <p>{m.audit_anchors_proof_forbidden()}</p>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The verify card's anchor line: counts of each outcome, problems listed by the card itself. */
export function AnchorSummary({ anchors }: { anchors: AuditAnchorSummary }) {
  const rows: [string, number][] = [
    [m.audit_verify_anchors_checked(), anchors.checked],
    [m.audit_verify_anchors_verified(), anchors.verified],
    [m.audit_verify_anchors_unverified_origin(), anchors.unverifiedOrigin],
    [m.audit_verify_anchors_failed(), anchors.failed],
    [m.audit_verify_anchors_missing(), anchors.missing],
  ];
  if (anchors.presenceOnly !== undefined)
    rows.splice(2, 0, [m.audit_verify_anchors_presence_only(), anchors.presenceOnly]);
  if (anchors.late !== undefined) rows.push([m.audit_verify_anchors_late(), anchors.late]);
  return (
    <section aria-label={m.audit_verify_anchors_title()} className="mt-3 space-y-1">
      <h3 className="font-medium">{m.audit_verify_anchors_title()}</h3>
      <dl className="grid grid-cols-[1fr_max-content] gap-x-4 gap-y-0.5">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt>{label}</dt>
            <dd className="text-right font-mono tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {anchors.unverifiedOrigin > 0 ? <p>{m.audit_verify_anchors_unverified_note()}</p> : null}
      {anchors.missing > 0 ? <p>{m.audit_verify_anchors_missing_note()}</p> : null}
      {(anchors.presenceOnly ?? 0) > 0 ? (
        <p>{m.audit_verify_anchors_presence_only_note()}</p>
      ) : null}
      {(anchors.late ?? 0) > 0 ? <p>{m.audit_verify_anchors_late_note()}</p> : null}
    </section>
  );
}
