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
  fieldAria,
  Input,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { isApiError } from "../../../lib/api.js";
import {
  type AskInput,
  askQuestion,
  QA_KEY,
  type QaTargetKind,
  QUESTION_MAX,
  SUBJECT_MAX,
} from "../../../lib/qa-queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";
import { ErrorAlert } from "../../error-alert.js";

/*
 * "Ask a question" (E3.3 D6): a dialog form against one document or folder. The trigger is a
 * Radix `DialogTrigger`, so closing (cancel, Escape, or a successful send) returns focus to it.
 * The refusals an investor can actually hit get their own words; anything else falls through to
 * the shared ErrorAlert.
 */
export function AskQuestionButton({
  targetKind,
  targetId,
  targetTitle,
  label,
}: {
  targetKind: QaTargetKind;
  targetId: string;
  targetTitle: string;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <MessageSquarePlus aria-hidden="true" />
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        {/* Mounted only while open: reopening starts from an empty form. */}
        {open ? (
          <AskForm
            targetKind={targetKind}
            targetId={targetId}
            targetTitle={targetTitle}
            onCancel={() => setOpen(false)}
            onDone={() => setOpen(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function reasonOf(error: unknown): unknown {
  return isApiError(error) ? error.body.error["reason"] : undefined;
}

/** Investor-worded refusals for the ask route; `null` → the generic ErrorAlert. */
export function askRefusal(error: unknown): { title: string; body: string } | null {
  if (!isApiError(error)) return null;
  const reason = reasonOf(error);
  if (error.code === "conflict" && reason === "too_many_open")
    return { title: m.dataroom_qa_err_too_many_title(), body: m.dataroom_qa_err_too_many_body() };
  if (error.code === "rate_limited")
    return { title: m.dataroom_qa_err_rate_title(), body: m.dataroom_qa_err_rate_body() };
  if (error.code === "forbidden" && reason === "delegate_read_only")
    return { title: m.dataroom_qa_err_delegate_title(), body: m.dataroom_qa_err_delegate_body() };
  if (error.code === "forbidden" && Array.isArray(error.body.error["pendingGates"]))
    return { title: m.dataroom_qa_err_gated_title(), body: m.dataroom_qa_err_gated_body() };
  if (error.code === "validation_failed" && reason === "folder_questions_disabled")
    return { title: m.dataroom_qa_err_folder_title(), body: m.dataroom_qa_err_folder_body() };
  return null;
}

function AskForm({
  targetKind,
  targetId,
  targetTitle,
  onCancel,
  onDone,
}: {
  targetKind: QaTargetKind;
  targetId: string;
  targetTitle: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const base = useId();
  const queryClient = useQueryClient();
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [attempted, setAttempted] = useState(false);

  const subjectLen = subject.trim().length;
  const bodyLen = body.trim().length;
  const subjectError =
    subjectLen === 0
      ? m.dataroom_qa_subject_required()
      : subjectLen > SUBJECT_MAX
        ? m.dataroom_qa_subject_too_long({ max: String(SUBJECT_MAX) })
        : undefined;
  const bodyError =
    bodyLen === 0
      ? m.dataroom_qa_body_required()
      : bodyLen > QUESTION_MAX
        ? m.dataroom_qa_body_too_long({ max: String(QUESTION_MAX) })
        : undefined;
  const show = (e: string | undefined) => (attempted ? e : undefined);

  const ask = useGuardedMutation({
    mutationFn: (input: AskInput) => askQuestion(input),
    onSuccess: () => {
      toast.success(m.dataroom_qa_sent());
      void queryClient.invalidateQueries({ queryKey: QA_KEY });
      onDone();
    },
  });
  const refusal = ask.isError ? askRefusal(ask.error) : null;

  function submit(event: FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (subjectError !== undefined || bodyError !== undefined) {
      // Land on the first field that needs fixing; its error is its description.
      document
        .getElementById(`${base}-${subjectError !== undefined ? "subject" : "body"}`)
        ?.focus();
      return;
    }
    ask.mutate({ targetKind, targetId, subject: subject.trim(), body: body.trim() });
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>{m.dataroom_qa_ask_title()}</DialogTitle>
        <DialogDescription>
          {targetKind === "document"
            ? m.dataroom_qa_ask_description_document({ title: targetTitle })
            : m.dataroom_qa_ask_description_folder({ title: targetTitle })}
        </DialogDescription>
      </DialogHeader>
      <Field
        id={`${base}-subject`}
        label={m.dataroom_qa_subject()}
        description={m.dataroom_qa_char_count({
          count: String(subject.trim().length),
          max: String(SUBJECT_MAX),
        })}
        error={show(subjectError)}
        required
      >
        <Input
          id={`${base}-subject`}
          value={subject}
          required
          autoComplete="off"
          onChange={(e) => setSubject(e.target.value)}
          {...fieldAria(`${base}-subject`, {
            description: true,
            error: show(subjectError) !== undefined,
          })}
        />
      </Field>
      <Field
        id={`${base}-body`}
        label={m.dataroom_qa_body()}
        description={m.dataroom_qa_char_count({
          count: String(body.trim().length),
          max: String(QUESTION_MAX),
        })}
        error={show(bodyError)}
        required
      >
        <Textarea
          id={`${base}-body`}
          rows={6}
          value={body}
          required
          onChange={(e) => setBody(e.target.value)}
          {...fieldAria(`${base}-body`, {
            description: true,
            error: show(bodyError) !== undefined,
          })}
        />
      </Field>
      <p className="text-sm text-muted-foreground">{m.dataroom_qa_privacy_note()}</p>
      {refusal ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{refusal.title}</AlertTitle>
          <AlertDescription>{refusal.body}</AlertDescription>
        </Alert>
      ) : ask.isError ? (
        <ErrorAlert error={ask.error} />
      ) : null}
      <p role="status" className="sr-only">
        {ask.isPending ? m.dataroom_qa_sending() : ""}
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" loading={ask.isPending}>
          {m.dataroom_qa_send()}
        </Button>
      </DialogFooter>
    </form>
  );
}
