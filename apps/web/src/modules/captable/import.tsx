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
  Field,
  fieldAria,
  Input,
  PageHeader,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useId, useState } from "react";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import { api, call, isApiError } from "../../lib/api.js";
import {
  CAPTABLE_FORMATS,
  type CaptableFormat,
  type CaptableImportBody,
  type CaptableImportPreview,
  type CaptableImportProblem,
} from "../../lib/captable-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { formatLabel, importReasonLabel, problemText } from "./format.js";
import { ClassTable, TotalsCard } from "./summary.js";

/*
 * Cap table import (E3.6 §8): paste → dry run → import as a **draft**. The shape of the metrics
 * CSV import (`modules/metrics/csv-import.tsx`) and for the same two load-bearing reasons:
 *
 *  - **editing anything that would be sent clears the preview** — the format, the date, the
 *    note or the CSV — so a dry run that no longer describes the input cannot be confirmed;
 *  - **the import button is disabled until a dry run has succeeded.**
 *
 * An import never reaches an investor by itself: it creates a draft, and publishing it is a
 * separate, step-up-guarded act on the snapshot's own page.
 */

const TEMPLATE = "holder_name,holder_email,class,kind,shares,amount,currency,issued_on\n";

/** `captable_import_invalid` names what was wrong with the file; say it rather than "error". */
export function ImportErrorAlert({ error }: { error: unknown }) {
  if (isApiError(error) && error.code === "captable_import_invalid") {
    const reason = error.body.error["reason"];
    const raw = error.body.error["problems"];
    const problems = (Array.isArray(raw) ? raw : []) as CaptableImportProblem[];
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>{m.captable_import_invalid_title()}</AlertTitle>
        <AlertDescription>
          <p>
            {typeof reason === "string" && reason !== ""
              ? importReasonLabel(reason)
              : error.body.error.message}
          </p>
          {problems.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5">
              {problems.map((p, i) => (
                <li key={i}>{problemText(p)}</li>
              ))}
            </ul>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }
  return <ErrorAlert error={error} />;
}

/** Holders the dry run could not link to a member, each named once. */
function unmatchedNames(preview: CaptableImportPreview): string[] {
  const names = new Set<string>();
  for (const line of preview.lines) if (line.membershipId === null) names.add(line.holderName);
  return [...names];
}

function DryRunPreview({ preview }: { preview: CaptableImportPreview }) {
  const unmatched = unmatchedNames(preview);
  return (
    <section className="space-y-4" aria-labelledby="captable-preview-title">
      <h2 id="captable-preview-title" className="text-lg font-semibold">
        {m.captable_preview_title()}
      </h2>
      <p className="text-sm" role="status">
        {m.captable_dry_run_summary({
          rows: String(preview.rows),
          classes: String(preview.summary.classes.length),
          matched: String(preview.matched),
          unmatched: String(preview.unmatched),
        })}
      </p>
      {preview.warnings.length > 0 ? (
        <Alert>
          <AlertTitle>
            {m.captable_dry_run_warnings({ count: String(preview.warnings.length) })}
          </AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-5">
              {preview.warnings.map((w, i) => (
                <li key={i}>{problemText(w)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}
      {unmatched.length > 0 ? (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">{m.captable_unmatched_title()}</h3>
          <p className="text-sm text-muted-foreground">{m.captable_unmatched_body()}</p>
          <ul className="list-disc pl-5 text-sm">
            {unmatched.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <TotalsCard summary={preview.summary} />
      <ClassTable classes={preview.summary.classes} caption={m.captable_classes_caption()} />
    </section>
  );
}

export function ImportScreen() {
  const base = useId();
  const [format, setFormat] = useState<CaptableFormat>("template");
  const [asOf, setAsOf] = useState("");
  const [note, setNote] = useState("");
  const [csv, setCsv] = useState(TEMPLATE);
  const [preview, setPreview] = useState<CaptableImportPreview>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const body = (): CaptableImportBody => ({
    format,
    csv,
    asOf,
    ...(note.trim() === "" ? {} : { note: note.trim() }),
  });
  /** Any edit to what would be sent invalidates the preview that described the old input. */
  const edit =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPreview(undefined);
    };

  const dryRun = useGuardedMutation({
    mutationFn: () => call(api().POST("/captable/import/dry-run", { body: body() })),
    onSuccess: setPreview,
  });
  const create = useGuardedMutation({
    mutationFn: () => call(api().POST("/captable/import", { body: body() })),
    onSuccess: (r) => {
      toast.success(m.captable_import_done());
      void queryClient.invalidateQueries({ queryKey: ["captable"] });
      void navigate({ to: "/admin/$", params: { _splat: `captable/snapshots/${r.snapshot.id}` } });
    },
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={m.captable_import_title()}
        description={m.captable_import_subtitle()}
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/$" params={{ _splat: "captable" }}>
              <ArrowLeft aria-hidden="true" />
              {m.captable_back()}
            </Link>
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>{m.captable_import_card_title()}</CardTitle>
          <CardDescription>{m.captable_import_card_body()}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              dryRun.mutate();
            }}
          >
            <div className="grid gap-4 md:grid-cols-3">
              <Field
                id={`${base}-format`}
                label={m.captable_field_format()}
                description={m.captable_field_format_help()}
              >
                <NativeSelect
                  id={`${base}-format`}
                  value={format}
                  {...fieldAria(`${base}-format`, { description: true })}
                  onChange={(e) => edit(setFormat)(e.target.value as CaptableFormat)}
                >
                  {CAPTABLE_FORMATS.map((f) => (
                    <option key={f} value={f}>
                      {formatLabel(f)}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
              <Field
                id={`${base}-asof`}
                label={m.captable_field_as_of()}
                description={m.captable_field_as_of_help()}
                required
              >
                <Input
                  id={`${base}-asof`}
                  type="date"
                  required
                  value={asOf}
                  {...fieldAria(`${base}-asof`, { description: true })}
                  onChange={(e) => edit(setAsOf)(e.target.value)}
                />
              </Field>
              <Field id={`${base}-note`} label={m.captable_field_note()}>
                <Input
                  id={`${base}-note`}
                  maxLength={500}
                  value={note}
                  onChange={(e) => edit(setNote)(e.target.value)}
                />
              </Field>
            </div>
            <Field
              id={`${base}-csv`}
              label={m.captable_field_csv()}
              description={m.captable_field_csv_help()}
              required
            >
              <Textarea
                id={`${base}-csv`}
                required
                rows={10}
                className="font-mono text-xs"
                value={csv}
                {...fieldAria(`${base}-csv`, { description: true })}
                onChange={(e) => edit(setCsv)(e.target.value)}
              />
            </Field>
            <ImportErrorAlert error={dryRun.error ?? create.error} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="outline" loading={dryRun.isPending}>
                {m.captable_dry_run()}
              </Button>
              <Button
                type="button"
                loading={create.isPending}
                disabled={preview === undefined}
                onClick={() => create.mutate()}
              >
                {m.captable_import_confirm()}
              </Button>
            </div>
            {preview === undefined ? (
              <p className="text-sm text-muted-foreground">{m.captable_dry_run_first()}</p>
            ) : null}
          </form>
        </CardContent>
      </Card>
      {preview === undefined ? null : <DryRunPreview preview={preview} />}
    </div>
  );
}
