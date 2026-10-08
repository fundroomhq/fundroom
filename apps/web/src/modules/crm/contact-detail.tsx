import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, CalendarCheck, CalendarClock, CalendarX, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { ConfirmDialog } from "../../components/access/common.js";
import { NativeSelect } from "../../components/compliance/common.js";
import { ErrorAlert } from "../../components/error-alert.js";
import {
  type ActivityKind,
  type ContactActivity,
  type ContactDetail,
  callAs,
  crmApi,
  crmContactActivityQuery,
  crmContactQuery,
  crmStagesQuery,
  type Note,
  type PipelineItem,
  type PipelineStage,
  type Task,
} from "../../lib/crm-queries.js";
import { formatDate, formatDateTime } from "../../lib/format.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { itemSubjectName, nameOfMembership, peopleOf, usePeople } from "./common.js";
import { formatMoney, stageName } from "./format.js";

/*
 * One contact: who they are, which organisation they belong to, where they sit in the
 * pipeline, and the two running records staff actually keep — notes and tasks.
 *
 * Notes are append-and-delete, never edit: a note is a record of what somebody thought at a
 * time, and silently rewriting one would make the history useless. A task's only stateful bit
 * is "done", which is a checkbox rather than a status enum because that is all it is.
 */

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["crm"] });
  };
}

function NotesCard({
  contactId,
  notes,
  canManage,
}: {
  contactId: string;
  notes: readonly Note[];
  canManage: boolean;
}) {
  const base = useId();
  const [body, setBody] = useState("");
  const invalidate = useInvalidate();

  const add = useGuardedMutation({
    mutationFn: () =>
      callAs<Note>(
        crmApi().POST("/crm/notes", {
          body: { subjectKind: "contact", subjectId: contactId, body: body.trim() },
        }),
      ),
    onSuccess: () => {
      toast.success(m.crm_note_added());
      setBody("");
      invalidate();
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.crm_notes_title()}</CardTitle>
        <CardDescription>{m.crm_notes_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canManage ? (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <ErrorAlert error={add.error} />
            <Field id={`${base}-note`} label={m.crm_note_field()}>
              <Textarea
                id={`${base}-note`}
                rows={3}
                maxLength={20_000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </Field>
            <Button type="submit" loading={add.isPending} disabled={body.trim() === ""}>
              {m.crm_note_add()}
            </Button>
          </form>
        ) : null}
        {notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.crm_notes_empty()}</p>
        ) : (
          <ul className="space-y-3">
            {notes.map((note) => (
              <NoteRow key={note.id} note={note} canManage={canManage} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function NoteRow({ note, canManage }: { note: Note; canManage: boolean }) {
  const invalidate = useInvalidate();
  const remove = useGuardedMutation({
    mutationFn: () =>
      callAs<unknown>(crmApi().DELETE("/crm/notes/{id}", { params: { path: { id: note.id } } })),
    onSuccess: () => {
      toast.success(m.crm_note_deleted());
      invalidate();
    },
  });
  return (
    <li className="rounded-md border p-3">
      <p className="whitespace-pre-wrap text-sm">{note.body}</p>
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {m.crm_note_meta({
            author: note.authorName ?? m.crm_note_author_unknown(),
            when: formatDateTime(note.createdAt),
          })}
        </p>
        {canManage ? (
          <ConfirmDialog
            trigger={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={m.crm_note_delete({ when: formatDateTime(note.createdAt) })}
              >
                <Trash2 aria-hidden="true" className="size-4" />
              </Button>
            }
            title={m.crm_note_delete({ when: formatDateTime(note.createdAt) })}
            description={m.crm_note_delete_body()}
            confirmLabel={m.crm_delete_confirm()}
            pending={remove.isPending}
            onConfirm={() => remove.mutate()}
          />
        ) : null}
      </div>
    </li>
  );
}

function TaskRow({ task, canManage }: { task: Task; canManage: boolean }) {
  const invalidate = useInvalidate();
  const toggle = useGuardedMutation({
    mutationFn: (done: boolean) =>
      callAs<Task>(
        crmApi().PATCH("/crm/tasks/{id}", { params: { path: { id: task.id } }, body: { done } }),
      ),
    onSuccess: () => invalidate(),
  });
  const remove = useGuardedMutation({
    mutationFn: () =>
      callAs<unknown>(crmApi().DELETE("/crm/tasks/{id}", { params: { path: { id: task.id } } })),
    onSuccess: () => {
      toast.success(m.crm_task_deleted());
      invalidate();
    },
  });
  const done = task.doneAt !== null;
  return (
    <li className="flex items-start justify-between gap-2 rounded-md border p-3">
      <div className="space-y-1">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={done}
            disabled={!canManage || toggle.isPending}
            onChange={(e) => toggle.mutate(e.target.checked)}
          />
          <span className={done ? "text-muted-foreground line-through" : ""}>{task.title}</span>
        </label>
        <p className="text-xs text-muted-foreground">
          {task.dueAt === null
            ? m.crm_task_no_due()
            : m.crm_task_due({ date: formatDate(task.dueAt) })}
          {done ? ` · ${m.crm_task_done_at({ when: formatDateTime(task.doneAt ?? "") })}` : ""}
        </p>
        <ErrorAlert error={toggle.error} />
      </div>
      {canManage ? (
        <ConfirmDialog
          trigger={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={m.crm_task_delete({ title: task.title })}
            >
              <Trash2 aria-hidden="true" className="size-4" />
            </Button>
          }
          title={m.crm_task_delete({ title: task.title })}
          description={m.crm_task_delete_body()}
          confirmLabel={m.crm_delete_confirm()}
          pending={remove.isPending}
          onConfirm={() => remove.mutate()}
        />
      ) : null}
    </li>
  );
}

function TasksCard({
  contactId,
  tasks,
  canManage,
}: {
  contactId: string;
  tasks: readonly Task[];
  canManage: boolean;
}) {
  const base = useId();
  const [title, setTitle] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [assignee, setAssignee] = useState("");
  const people = usePeople({ kind: "staff" });
  const invalidate = useInvalidate();

  const add = useGuardedMutation({
    mutationFn: () =>
      callAs<Task>(
        crmApi().POST("/crm/tasks", {
          body: {
            subjectKind: "contact",
            subjectId: contactId,
            title: title.trim(),
            // A date input gives a plain day; the column is a timestamp, so it is sent as the
            // start of that day in UTC rather than as whatever the browser's zone would make
            // of it at parse time.
            ...(dueAt === "" ? {} : { dueAt: `${dueAt}T00:00:00.000Z` }),
            ...(assignee === "" ? {} : { assigneeMembershipId: assignee }),
          },
        }),
      ),
    onSuccess: () => {
      toast.success(m.crm_task_added());
      setTitle("");
      setDueAt("");
      setAssignee("");
      invalidate();
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.crm_tasks_title()}</CardTitle>
        <CardDescription>{m.crm_tasks_body()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canManage ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate();
            }}
          >
            <ErrorAlert error={add.error} />
            <Field id={`${base}-title`} label={m.crm_task_field_title()} required>
              <Input
                id={`${base}-title`}
                required
                maxLength={200}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={`${base}-due`} label={m.crm_task_field_due()}>
                <Input
                  id={`${base}-due`}
                  type="date"
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                />
              </Field>
              <Field id={`${base}-assignee`} label={m.crm_task_field_assignee()}>
                <NativeSelect
                  id={`${base}-assignee`}
                  value={assignee}
                  onChange={(e) => setAssignee(e.target.value)}
                >
                  <option value="">{m.crm_task_unassigned()}</option>
                  {peopleOf(people).map((p) => (
                    <option key={p.membershipId} value={p.membershipId}>
                      {p.displayName}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <Button type="submit" loading={add.isPending} disabled={title.trim() === ""}>
              {m.crm_task_add()}
            </Button>
          </form>
        ) : null}
        {tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.crm_tasks_empty()}</p>
        ) : (
          <ul className="space-y-2">
            {tasks.map((task) => (
              <TaskRow key={task.id} task={task} canManage={canManage} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function PipelineItemsCard({
  items,
  stages,
}: {
  items: readonly PipelineItem[];
  stages: readonly PipelineStage[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.crm_detail_pipeline_title()}</CardTitle>
        <CardDescription>{m.crm_detail_pipeline_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.crm_detail_pipeline_empty()}</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id} className="rounded-md border p-3 text-sm">
                <p className="font-medium">{itemSubjectName(item)}</p>
                <p className="text-muted-foreground">
                  {m.crm_detail_pipeline_row({
                    stage: stageName(undefined, stages, item.stageId),
                    amount: formatMoney(item.amount, item.currency),
                  })}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function activityLabel(kind: ActivityKind): string {
  switch (kind) {
    case "meeting_booked":
      return m.crm_activity_meeting_booked();
    case "meeting_cancelled":
      return m.crm_activity_meeting_cancelled();
    case "meeting_rescheduled":
      return m.crm_activity_meeting_rescheduled();
  }
}

function ActivityIcon({ kind }: { kind: ActivityKind }) {
  const props = { "aria-hidden": true, className: "mt-0.5 size-4 shrink-0 text-muted-foreground" };
  switch (kind) {
    case "meeting_booked":
      return <CalendarCheck {...props} />;
    case "meeting_cancelled":
      return <CalendarX {...props} />;
    case "meeting_rescheduled":
      return <CalendarClock {...props} />;
  }
}

/** Newest first by when it happened; the server already answers that way, this only makes sure. */
function newestFirst(activities: readonly ContactActivity[]): ContactActivity[] {
  return [...activities].sort((a, b) =>
    a.occurredAt === b.occurredAt ? 0 : a.occurredAt < b.occurredAt ? 1 : -1,
  );
}

/*
 * Meetings booked through a connected Calendly or Cal.com (E3.6). Read-only: every row came from
 * a verified booking webhook, so there is nothing here for staff to type or delete. Its own
 * query, so a failure costs this card and not the contact.
 */
function ActivityCard({ contactId }: { contactId: string }) {
  const activity = useQuery(crmContactActivityQuery(contactId));
  const items = newestFirst(activity.data?.activities ?? []);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.crm_activity_title()}</CardTitle>
        <CardDescription>{m.crm_activity_body()}</CardDescription>
      </CardHeader>
      <CardContent>
        {activity.isPending ? <LoadingState label={m.common_loading()} /> : null}
        {activity.isError ? <ErrorAlert error={activity.error} /> : null}
        {activity.data ? (
          items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.crm_activity_empty()}</p>
          ) : (
            <ol className="space-y-2" aria-label={m.crm_activity_title()}>
              {items.map((item) => (
                <li key={item.id} className="flex items-start gap-2 rounded-md border p-3 text-sm">
                  <ActivityIcon kind={item.kind} />
                  <div className="space-y-1">
                    <p className="font-medium">
                      {activityLabel(item.kind)}
                      {item.title === null ? null : ` · ${item.title}`}
                    </p>
                    <p className="text-muted-foreground">
                      {m.crm_activity_meeting_at({ when: formatDateTime(item.startsAt) })}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {m.crm_activity_recorded_at({ when: formatDateTime(item.occurredAt) })}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ContactDetailScreen({ id, canManage }: { id: string; canManage: boolean }) {
  const detail = useQuery(crmContactQuery(id));
  const stages = useQuery(crmStagesQuery);
  const people = usePeople({ kind: "staff" });
  const data: ContactDetail | undefined = detail.data;

  if (detail.isPending) return <LoadingState label={m.common_loading()} />;
  if (detail.isError) return <ErrorAlert error={detail.error} />;
  if (data === undefined) return null;

  const { contact, organization } = data;
  const owner = contact.ownerName ?? nameOfMembership(peopleOf(people), contact.ownerMembershipId);

  return (
    <div className="space-y-6">
      <PageHeader
        title={contact.displayName}
        description={contact.title ?? m.crm_detail_no_title()}
        actions={
          <Button asChild variant="outline">
            <Link to="/admin/$" params={{ _splat: "crm/contacts" }}>
              <ArrowLeft aria-hidden="true" />
              {m.crm_back_to_contacts()}
            </Link>
          </Button>
        }
      />
      <Card>
        <CardHeader>
          <CardTitle>{m.crm_detail_about()}</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted-foreground">{m.crm_col_email()}</dt>
              <dd className="text-sm">{contact.email ?? m.crm_no_email()}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{m.crm_col_organization()}</dt>
              <dd className="text-sm">
                {organization === null ? (
                  m.crm_org_none()
                ) : (
                  <Link
                    to="/admin/$"
                    params={{ _splat: "crm/organizations" }}
                    className="text-primary underline underline-offset-4"
                  >
                    {organization.name}
                  </Link>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{m.crm_col_owner()}</dt>
              <dd className="text-sm">{owner ?? m.crm_owner_none()}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">{m.crm_col_member()}</dt>
              <dd className="text-sm">
                <Badge variant={contact.membershipId === null ? "outline" : "secondary"}>
                  {contact.membershipId === null
                    ? m.crm_member_not_linked()
                    : m.crm_member_linked()}
                </Badge>
              </dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="text-sm text-muted-foreground">{m.crm_col_tags()}</dt>
              <dd className="flex flex-wrap gap-1 text-sm">
                {contact.tags.length === 0
                  ? m.crm_no_tags()
                  : contact.tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <PipelineItemsCard items={data.pipelineItems} stages={stages.data?.stages ?? []} />
      <ActivityCard contactId={contact.id} />
      <NotesCard contactId={contact.id} notes={data.notes} canManage={canManage} />
      <TasksCard contactId={contact.id} tasks={data.tasks} canManage={canManage} />
    </div>
  );
}
