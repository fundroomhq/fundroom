import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  EmptyState,
  Field,
  fieldAria,
  Input,
  LoadingState,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@fundroomhq/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ScanSearch } from "lucide-react";
import { type ChangeEvent, type FormEvent, useId, useState } from "react";
import { describeError, isCode } from "../../lib/api.js";
import {
  detectForensicMark,
  FORENSIC_CONTENT_TYPES,
  FORENSIC_MAX_BYTES,
  type ForensicDetectionResult,
  type ForensicVerdict,
  forensicRecipientsQuery,
} from "../../lib/data-room-forensic.js";
import { formatDateTime } from "../../lib/format.js";
import {
  type DataRoomDocumentDetail,
  peopleQuery,
  useBootstrap,
  type DataRoomVersion as Version,
} from "../../lib/queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { personName } from "../access/common.js";
import { NativeSelect } from "../compliance/common.js";
import { ErrorAlert } from "../error-alert.js";

/*
 * Forensic tracing on the admin document page (E3.13, ADR-0061), for `data-room.forensics`
 * (owner, admin, legal). Two things: "Trace a leak" tests a leaked page image against every
 * recipient who was served a marked copy, and the recipients list says who was served one.
 *
 * The copy is deliberately careful. A score is a statistical test, so the dialog says what the
 * thresholds mean, that a match is evidence about whose copy it was rather than proof of who
 * leaked it, and that the uploaded image is not kept.
 */

const MAX_MB = FORENSIC_MAX_BYTES / 1024 / 1024;

type DataRoomVersion = NonNullable<Version>;

function versionsOf(detail: DataRoomDocumentDetail): DataRoomVersion[] {
  return detail.versions.filter((v): v is DataRoomVersion => v !== null);
}

export function ForensicCard({ detail }: { detail: DataRoomDocumentDetail }) {
  const d = detail.document;
  const versions = versionsOf(detail);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.dataroom_forensic_title()}</CardTitle>
        <CardDescription>{m.dataroom_forensic_body()}</CardDescription>
        <CardAction>
          <TraceLeakDialog detail={detail} versions={versions} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">{m.dataroom_forensic_trace_code_note()}</p>
        {d.protection.forensic === true ? null : (
          <p className="text-sm text-muted-foreground">{m.dataroom_forensic_off_note()}</p>
        )}
        <RecipientsList documentId={d.id} versions={versions} />
      </CardContent>
    </Card>
  );
}

// --- recipients -------------------------------------------------------------------------------------

function RecipientsList({
  documentId,
  versions,
}: {
  documentId: string;
  versions: DataRoomVersion[];
}) {
  const filterId = useId();
  const [versionId, setVersionId] = useState("");
  const recipients = useInfiniteQuery(forensicRecipientsQuery(documentId, versionId || undefined));
  const items = recipients.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section aria-labelledby={`${filterId}-heading`} className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h3 id={`${filterId}-heading`} className="text-sm font-medium">
          {m.dataroom_forensic_recipients_title()}
        </h3>
        {versions.length > 1 ? (
          <Field id={filterId} label={m.dataroom_forensic_recipients_version()}>
            <NativeSelect
              id={filterId}
              value={versionId}
              onChange={(e) => setVersionId(e.target.value)}
            >
              <option value="">{m.dataroom_forensic_all_versions()}</option>
              {versions.map((v) => (
                <option key={v.id} value={v.id}>
                  {m.common_version_short({ version: v.versionNo })}
                </option>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
      </div>
      {recipients.isPending ? <LoadingState lines={3} label={m.common_loading()} /> : null}
      {recipients.isError ? <ErrorAlert error={recipients.error} /> : null}
      {recipients.data ? (
        items.length === 0 ? (
          <EmptyState
            title={m.dataroom_forensic_recipients_empty()}
            description={m.dataroom_forensic_recipients_empty_body()}
          />
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.dataroom_forensic_col_recipient()}</TableHead>
                  <TableHead>{m.dataroom_forensic_col_version()}</TableHead>
                  <TableHead>{m.dataroom_forensic_col_trace()}</TableHead>
                  <TableHead>{m.dataroom_forensic_col_first_served()}</TableHead>
                  <TableHead>{m.dataroom_forensic_col_last_served()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((r) => (
                  <TableRow key={`${r.membershipId}:${r.versionId}`}>
                    <TableCell>
                      <span className="block">{r.displayName}</span>
                      {r.email ? (
                        <span className="block text-xs text-muted-foreground">{r.email}</span>
                      ) : null}
                      {r.servedUnderViewAs ? (
                        <ViewAsBadge investorId={r.viewAsMembershipId} />
                      ) : null}
                    </TableCell>
                    <TableCell>{m.common_version_short({ version: r.versionNo })}</TableCell>
                    <TableCell>
                      {/* The `trace XXXXXXXX` code printed on this recipient's marked downloads. */}
                      <code className="font-mono text-xs">{r.trace}</code>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(r.firstServedAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatDateTime(r.lastServedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {items.some((r) => r.servedUnderViewAs) ? <ViewAsNote /> : null}
            {recipients.hasNextPage ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                loading={recipients.isFetchingNextPage}
                onClick={() => void recipients.fetchNextPage()}
              >
                {m.common_load_more()}
              </Button>
            ) : null}
          </>
        )
      ) : null}
    </section>
  );
}

/*
 * View-as (E3.13 FIX2/FIX3): staff viewing the portal as an investor are served pages carrying
 * their OWN mark, never the investor's. `servedUnderViewAs` means that staff member was served
 * this version under view-as AT LEAST ONCE (not that every copy, or the leaked one, was such a
 * copy); `viewAsMembershipId` is only the last investor viewed as. The copy says exactly that.
 */
function ViewAsBadge({ investorId }: { investorId: string | null }) {
  const bootstrap = useBootstrap();
  const canReadPeople = (bootstrap.data?.permissions ?? []).includes("access.read");
  const people = useQuery({ ...peopleQuery({}), enabled: canReadPeople && investorId !== null });
  const investor = people.data?.items.find((p) => p.membershipId === investorId);
  return (
    <Badge variant="outline" className="mt-1">
      {investor
        ? m.dataroom_forensic_view_as_badge_named({ name: personName(investor) })
        : m.dataroom_forensic_view_as_badge()}
    </Badge>
  );
}

function ViewAsNote() {
  return <p className="text-xs text-muted-foreground">{m.dataroom_forensic_view_as_note()}</p>;
}

// --- trace a leak ---------------------------------------------------------------------------------

interface FormErrors {
  image?: string | undefined;
  page?: string | undefined;
}

/** The sentence for a refused detection: every forensic code, plus the HTTP-level refusals. */
export function forensicErrorMessage(error: unknown): string {
  if (isCode(error, "not_found")) return m.dataroom_forensic_error_not_found();
  if (isCode(error, "payload_too_large", "unsupported_media_type"))
    return m.error_forensic_image_invalid_body();
  return describeError(error).body;
}

function TraceLeakDialog({
  detail,
  versions,
}: {
  detail: DataRoomDocumentDetail;
  versions: DataRoomVersion[];
}) {
  const ids = useId();
  const d = detail.document;
  const [open, setOpen] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [page, setPage] = useState("1");
  const [versionId, setVersionId] = useState("");
  const [errors, setErrors] = useState<FormErrors>({});
  const detect = useGuardedMutation({
    mutationFn: (input: { image: File; page: number; versionId?: string | undefined }) =>
      detectForensicMark(d.id, input),
  });

  const chosen = versions.find((v) => v.id === versionId) ?? detail.currentVersion ?? undefined;
  const pageCount = chosen?.pageCount ?? d.pageCount ?? undefined;

  function reset() {
    setImage(null);
    setPage("1");
    setVersionId("");
    setErrors({});
    detect.reset();
  }

  function onImage(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    setImage(file);
    setErrors((x) => ({ ...x, image: file ? imageProblem(file) : undefined }));
    detect.reset();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const next: FormErrors = {};
    if (image === null) next.image = m.dataroom_forensic_image_required();
    else {
      const problem = imageProblem(image);
      if (problem) next.image = problem;
    }
    const n = Number(page);
    if (!Number.isInteger(n) || n < 1) next.page = m.dataroom_forensic_page_invalid();
    else if (pageCount !== undefined && n > pageCount)
      next.page = m.dataroom_forensic_page_too_high({ count: pageCount });
    setErrors(next);
    if (Object.keys(next).length > 0 || image === null) return;
    detect.mutate({ image, page: n, versionId: versionId || undefined });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <ScanSearch aria-hidden="true" />
          {m.dataroom_forensic_trace_open()}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{m.dataroom_forensic_trace_title({ title: d.title })}</DialogTitle>
          <DialogDescription>{m.dataroom_forensic_trace_body()}</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit} noValidate>
          <Field
            id={`${ids}-image`}
            label={m.dataroom_forensic_image()}
            description={m.dataroom_forensic_image_hint({ max: String(MAX_MB) })}
            error={errors.image}
            required
          >
            <Input
              id={`${ids}-image`}
              type="file"
              accept={FORENSIC_CONTENT_TYPES.join(",")}
              required
              onChange={onImage}
              {...fieldAria(`${ids}-image`, { description: true, error: !!errors.image })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id={`${ids}-page`}
              label={m.dataroom_forensic_page()}
              description={
                pageCount === undefined
                  ? undefined
                  : m.dataroom_forensic_page_hint({ count: pageCount })
              }
              error={errors.page}
              required
            >
              <Input
                id={`${ids}-page`}
                type="number"
                inputMode="numeric"
                min={1}
                max={pageCount}
                step={1}
                required
                value={page}
                onChange={(e) => setPage(e.target.value)}
                {...fieldAria(`${ids}-page`, {
                  description: pageCount !== undefined,
                  error: !!errors.page,
                })}
              />
            </Field>
            {versions.length > 1 ? (
              <Field
                id={`${ids}-version`}
                label={m.dataroom_forensic_version()}
                description={m.dataroom_forensic_version_hint()}
              >
                <NativeSelect
                  id={`${ids}-version`}
                  value={versionId}
                  onChange={(e) => {
                    setVersionId(e.target.value);
                    detect.reset();
                  }}
                  {...fieldAria(`${ids}-version`, { description: true })}
                >
                  <option value="">{m.dataroom_forensic_version_current()}</option>
                  {versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {m.dataroom_forensic_version_option({
                        version: v.versionNo,
                        date: formatDateTime(v.createdAt),
                      })}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            ) : null}
          </div>
          <Alert role="note">
            <AlertTitle>{m.dataroom_forensic_explain_title()}</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-5">
                <li>{m.dataroom_forensic_explain_match()}</li>
                <li>{m.dataroom_forensic_explain_inconclusive()}</li>
                <li>{m.dataroom_forensic_explain_evidence()}</li>
                <li>{m.dataroom_forensic_explain_privacy()}</li>
              </ul>
            </AlertDescription>
          </Alert>
          {detect.isError ? (
            <Alert variant="destructive" role="alert">
              <AlertTitle>{describeError(detect.error).title}</AlertTitle>
              <AlertDescription>{forensicErrorMessage(detect.error)}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {m.common_close()}
              </Button>
            </DialogClose>
            <Button type="submit" loading={detect.isPending}>
              {m.dataroom_forensic_trace_submit()}
            </Button>
          </DialogFooter>
          {detect.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              {m.dataroom_forensic_trace_pending()}
            </p>
          ) : null}
        </form>
        {detect.data ? <TraceResult result={detect.data} versions={versions} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function imageProblem(file: File): string | undefined {
  if (!(FORENSIC_CONTENT_TYPES as readonly string[]).includes(file.type))
    return m.dataroom_forensic_image_type();
  if (file.size > FORENSIC_MAX_BYTES)
    return m.dataroom_forensic_image_too_large({ max: String(MAX_MB) });
  if (file.size === 0) return m.dataroom_forensic_image_empty();
  return undefined;
}

function VerdictChip({ verdict }: { verdict: ForensicVerdict }) {
  switch (verdict) {
    case "match":
      return <Badge variant="destructive">{m.dataroom_forensic_verdict_match()}</Badge>;
    case "inconclusive":
      return <Badge variant="warning">{m.dataroom_forensic_verdict_inconclusive()}</Badge>;
    case "no_match":
      return <Badge variant="outline">{m.dataroom_forensic_verdict_no_match()}</Badge>;
  }
}

function TraceResult({
  result,
  versions,
}: {
  result: ForensicDetectionResult;
  versions: DataRoomVersion[];
}) {
  const headingId = useId();
  const version = versions.find((v) => v.id === result.versionId);
  const matches = result.results.filter((r) => r.verdict === "match").length;
  const viewAs = result.results.some((r) => r.servedUnderViewAs);
  return (
    <section aria-labelledby={headingId} className="space-y-3" aria-live="polite">
      <h3 id={headingId} className="font-medium">
        {m.dataroom_forensic_result_title()}
      </h3>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">{m.dataroom_forensic_result_tested()}</dt>
        <dd>
          {version
            ? m.dataroom_forensic_result_tested_value({
                page: String(result.page),
                version: version.versionNo,
              })
            : m.dataroom_forensic_result_tested_page({ page: String(result.page) })}
        </dd>
        <dt className="text-muted-foreground">{m.dataroom_forensic_result_candidates()}</dt>
        <dd className="tabular-nums">{result.candidatesTested}</dd>
        <dt className="text-muted-foreground">{m.dataroom_forensic_result_no_match()}</dt>
        <dd className="tabular-nums">{result.noMatchCount}</dd>
        <dt className="text-muted-foreground">{m.dataroom_forensic_result_alignment()}</dt>
        <dd className="tabular-nums">{result.alignment.quality.toFixed(2)}</dd>
        <dt className="text-muted-foreground">{m.dataroom_forensic_result_thresholds()}</dt>
        <dd>
          {m.dataroom_forensic_result_thresholds_value({
            match: result.thresholds.match.toFixed(1),
            inconclusive: result.thresholds.inconclusive.toFixed(1),
          })}
        </dd>
      </dl>
      {result.tamperSuspected ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{m.dataroom_forensic_result_tamper_title()}</AlertTitle>
          <AlertDescription>{m.dataroom_forensic_result_tamper_body()}</AlertDescription>
        </Alert>
      ) : null}
      {result.keysMissing > 0 ? (
        <Alert role="note">
          <AlertDescription>
            {m.dataroom_forensic_result_keys_missing({ count: result.keysMissing })}
          </AlertDescription>
        </Alert>
      ) : null}
      {result.results.length === 0 ? (
        <Alert role="status">
          <AlertTitle>{m.dataroom_forensic_result_none_title()}</AlertTitle>
          <AlertDescription>{m.dataroom_forensic_result_none_body()}</AlertDescription>
        </Alert>
      ) : (
        <>
          <p className="text-sm">
            {matches > 0
              ? m.dataroom_forensic_result_match_note()
              : m.dataroom_forensic_result_inconclusive_note()}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.dataroom_forensic_col_recipient()}</TableHead>
                <TableHead>{m.dataroom_forensic_col_verdict()}</TableHead>
                <TableHead>{m.dataroom_forensic_col_score()}</TableHead>
                <TableHead>{m.dataroom_forensic_col_first_served()}</TableHead>
                <TableHead>{m.dataroom_forensic_col_last_served()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {result.results.map((r) => (
                <TableRow key={r.membershipId}>
                  <TableCell>
                    <span className="block">{r.displayName}</span>
                    {r.email ? (
                      <span className="block text-xs text-muted-foreground">{r.email}</span>
                    ) : null}
                    {r.servedUnderViewAs ? <ViewAsBadge investorId={r.viewAsMembershipId} /> : null}
                  </TableCell>
                  <TableCell>
                    <VerdictChip verdict={r.verdict} />
                  </TableCell>
                  <TableCell className="font-mono tabular-nums">{r.z.toFixed(1)}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(r.firstServedAt)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(r.lastServedAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {viewAs ? <ViewAsNote /> : null}
        </>
      )}
    </section>
  );
}
