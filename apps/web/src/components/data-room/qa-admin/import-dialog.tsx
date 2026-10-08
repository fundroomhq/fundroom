import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQueryClient } from "@tanstack/react-query";
import { FileSpreadsheet } from "lucide-react";
import { type ChangeEvent, useId, useState } from "react";
import { isCode } from "../../../lib/api.js";
import { QA_ADMIN_KEY, type QaImportResult, qaImport } from "../../../lib/qa-admin-queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";
import { ErrorAlert } from "../../error-alert.js";

/** The server's documented CSV limit (UTF-8 bytes); larger files are refused with 413. */
export const QA_IMPORT_MAX_BYTES = 1_048_576;

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

const TEMPLATE = "target_kind,target_id,subject,question,answer,category,publish\n";

/*
 * Bulk Q&A import (a `fresh` route): paste or choose a CSV → dry run (errors per line) →
 * import. The server is all-or-nothing, so the import is offered only after a clean dry run of
 * exactly the text on screen; editing the text asks for a new dry run.
 */
export function QaImportDialog() {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState(TEMPLATE);
  const [preview, setPreview] = useState<QaImportResult>();
  const [done, setDone] = useState<QaImportResult>();
  /** A chosen file over the limit: not read into the page at all. */
  const [oversizeFile, setOversizeFile] = useState(false);
  const id = useId();
  const fileId = useId();
  const queryClient = useQueryClient();

  const dryRun = useGuardedMutation({
    mutationFn: () => qaImport(csv, true),
    onSuccess: setPreview,
  });
  const run = useGuardedMutation({
    mutationFn: () => qaImport(csv, false),
    onSuccess: (result) => {
      if (result.errors.length > 0) {
        // Something changed between the dry run and the import: nothing was written.
        setPreview(result);
        return;
      }
      setDone(result);
      toast.success(m.dataroom_qa_admin_import_done({ count: result.created }));
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: QA_ADMIN_KEY }),
  });

  function reset() {
    setOversizeFile(false);
    setPreview(undefined);
    setDone(undefined);
    dryRun.reset();
    run.reset();
  }

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    reset();
    if (file.size > QA_IMPORT_MAX_BYTES) {
      setOversizeFile(true);
      return;
    }
    setCsv(await file.text());
  }

  const tooLarge =
    oversizeFile ||
    utf8Bytes(csv) > QA_IMPORT_MAX_BYTES ||
    isCode(dryRun.error ?? run.error, "payload_too_large");
  const clean =
    !tooLarge && preview !== undefined && preview.errors.length === 0 && preview.rows > 0;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          reset();
          setCsv(TEMPLATE);
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <FileSpreadsheet aria-hidden="true" />
          {m.dataroom_qa_admin_import()}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{m.dataroom_qa_admin_import_title()}</DialogTitle>
          <DialogDescription>{m.dataroom_qa_admin_import_body()}</DialogDescription>
        </DialogHeader>
        {done ? (
          <>
            <p role="status" className="text-sm">
              {m.dataroom_qa_admin_import_done({ count: done.created })}
            </p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                {m.common_close()}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <Field id={fileId} label={m.dataroom_qa_admin_import_file()}>
              <Input id={fileId} type="file" accept=".csv,text/csv" onChange={onFile} />
            </Field>
            <Field
              id={id}
              label={m.dataroom_qa_admin_import_field()}
              description={m.dataroom_qa_admin_import_hint()}
            >
              <Textarea
                id={id}
                value={csv}
                onChange={(e) => {
                  setCsv(e.target.value);
                  reset();
                }}
                rows={8}
                className="font-mono text-xs"
                aria-describedby={`${id}-description`}
              />
            </Field>
            {preview ? (
              preview.errors.length === 0 ? (
                <p role="status" className="text-sm">
                  {m.dataroom_qa_admin_import_ready({ count: preview.rows })}
                </p>
              ) : (
                <div className="space-y-2">
                  <Alert variant="destructive" role="alert">
                    <AlertTitle>{m.dataroom_qa_admin_import_errors_title()}</AlertTitle>
                    <AlertDescription>{m.dataroom_qa_admin_import_errors_body()}</AlertDescription>
                  </Alert>
                  <Table aria-label={m.dataroom_qa_admin_import_errors_title()}>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{m.dataroom_qa_admin_import_col_line()}</TableHead>
                        <TableHead>{m.dataroom_qa_admin_import_col_problem()}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {preview.errors.map((e) => (
                        <TableRow key={`${e.line}-${e.message}`}>
                          <TableCell>{e.line}</TableCell>
                          <TableCell>{e.message}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )
            ) : null}
            {tooLarge ? (
              <Alert variant="destructive" role="alert">
                <AlertTitle>{m.dataroom_qa_admin_import_too_large_title()}</AlertTitle>
                <AlertDescription>{m.dataroom_qa_admin_import_too_large_body()}</AlertDescription>
              </Alert>
            ) : (
              <ErrorAlert error={dryRun.error ?? run.error} />
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                loading={dryRun.isPending}
                disabled={tooLarge}
                onClick={() => dryRun.mutate()}
              >
                {m.dataroom_qa_admin_import_check()}
              </Button>
              <Button
                type="button"
                loading={run.isPending}
                disabled={!clean}
                onClick={() => run.mutate()}
              >
                {m.dataroom_qa_admin_import_confirm({ count: preview?.rows ?? 0 })}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
