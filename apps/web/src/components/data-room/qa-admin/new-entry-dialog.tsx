import {
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
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquarePlus } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { QA_ADMIN_KEY, type QaTargetKind, qaCreateEntry } from "../../../lib/qa-admin-queries.js";
import { type DataRoomTree, dataRoomTreeQuery } from "../../../lib/queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";
import { NativeSelect } from "../../compliance/common.js";
import { ErrorAlert } from "../../error-alert.js";

interface TargetOption {
  value: string;
  label: string;
}

/** Folders (the root first) and documents of the live tree, labelled with their index. */
function targetOptions(tree: DataRoomTree): { folders: TargetOption[]; documents: TargetOption[] } {
  const label = (index: string | null, name: string) =>
    index === null || index === "" ? name : `${index} ${name}`;
  const byIndex = (a: { index: string | null }, b: { index: string | null }) =>
    (a.index ?? "").localeCompare(b.index ?? "", undefined, { numeric: true });
  const folders = [
    { value: `folder:${tree.rootId}`, label: m.dataroom_qa_admin_target_root() },
    ...tree.folders
      .filter((f) => f.deletedAt === null)
      .sort(byIndex)
      .map((f) => ({ value: `folder:${f.id}`, label: label(f.index, f.name) })),
  ];
  const documents = tree.documents
    .filter((d) => d.deletedAt === null)
    .sort(byIndex)
    .map((d) => ({ value: `document:${d.id}`, label: label(d.index, d.title) }));
  return { folders, documents };
}

/*
 * A staff-authored Q&A entry (an FAQ with no asker): the server creates it assigned to its
 * author with the answer drafted; releasing it to the target's audience is a separate step on
 * the detail page, where approval (if the workspace requires it) applies as usual.
 */
export function QaNewEntryDialog() {
  const base = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const tree = useQuery({ ...dataRoomTreeQuery, enabled: open });
  const [target, setTarget] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [answer, setAnswer] = useState("");
  const [attempted, setAttempted] = useState(false);
  const create = useGuardedMutation({
    mutationFn: () => {
      const [kind, id] = target.split(":") as [QaTargetKind, string];
      return qaCreateEntry({
        targetKind: kind,
        targetId: id,
        subject: subject.trim(),
        body: body.trim(),
        answer: answer.trim(),
      });
    },
    onSuccess: (created) => {
      toast.success(m.dataroom_qa_admin_entry_created());
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: QA_ADMIN_KEY });
      void navigate({ to: "/admin/$", params: { _splat: `data-room/questions/${created.id}` } });
    },
  });
  const errors = {
    target: target === "" ? m.dataroom_qa_admin_entry_target_required() : undefined,
    subject: subject.trim() === "" ? m.dataroom_qa_admin_entry_subject_required() : undefined,
    body: body.trim() === "" ? m.dataroom_qa_admin_entry_body_required() : undefined,
    answer: answer.trim() === "" ? m.dataroom_qa_admin_entry_answer_required() : undefined,
  };
  const show = (e: string | undefined) => (attempted ? e : undefined);

  function submit(e: FormEvent) {
    e.preventDefault();
    setAttempted(true);
    if (Object.values(errors).some((v) => v !== undefined)) return;
    create.mutate();
  }

  const options = tree.data ? targetOptions(tree.data) : undefined;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setAttempted(false);
          create.reset();
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button">
          <MessageSquarePlus aria-hidden="true" />
          {m.dataroom_qa_admin_new_entry()}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl">
        <form className="space-y-4" onSubmit={submit} noValidate>
          <DialogHeader>
            <DialogTitle>{m.dataroom_qa_admin_new_entry()}</DialogTitle>
            <DialogDescription>{m.dataroom_qa_admin_entry_body()}</DialogDescription>
          </DialogHeader>
          {tree.isError ? <ErrorAlert error={tree.error} /> : null}
          <Field
            id={`${base}-target`}
            label={m.dataroom_qa_admin_field_target()}
            error={show(errors.target)}
            required
          >
            <NativeSelect
              id={`${base}-target`}
              value={target}
              required
              disabled={options === undefined}
              onChange={(e) => setTarget(e.target.value)}
              {...fieldAria(`${base}-target`, { error: show(errors.target) !== undefined })}
            >
              <option value="">{m.dataroom_qa_admin_target_choose()}</option>
              {options ? (
                <>
                  <optgroup label={m.dataroom_qa_admin_target_folders()}>
                    {options.folders.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                  {options.documents.length > 0 ? (
                    <optgroup label={m.dataroom_qa_admin_target_documents()}>
                      {options.documents.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </>
              ) : null}
            </NativeSelect>
          </Field>
          <Field
            id={`${base}-subject`}
            label={m.dataroom_qa_admin_field_subject()}
            error={show(errors.subject)}
            required
          >
            <Input
              id={`${base}-subject`}
              value={subject}
              maxLength={200}
              required
              onChange={(e) => setSubject(e.target.value)}
              {...fieldAria(`${base}-subject`, { error: show(errors.subject) !== undefined })}
            />
          </Field>
          <Field
            id={`${base}-body`}
            label={m.dataroom_qa_admin_field_question()}
            error={show(errors.body)}
            required
          >
            <Textarea
              id={`${base}-body`}
              value={body}
              rows={4}
              maxLength={5000}
              required
              onChange={(e) => setBody(e.target.value)}
              {...fieldAria(`${base}-body`, { error: show(errors.body) !== undefined })}
            />
          </Field>
          <Field
            id={`${base}-answer`}
            label={m.dataroom_qa_admin_field_answer()}
            error={show(errors.answer)}
            required
          >
            <Textarea
              id={`${base}-answer`}
              value={answer}
              rows={6}
              maxLength={20000}
              required
              onChange={(e) => setAnswer(e.target.value)}
              {...fieldAria(`${base}-answer`, { error: show(errors.answer) !== undefined })}
            />
          </Field>
          <ErrorAlert error={create.error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {m.common_cancel()}
            </Button>
            <Button type="submit" loading={create.isPending}>
              {m.dataroom_qa_admin_entry_submit()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
