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
  Field,
  fieldAria,
  Textarea,
  toast,
} from "@fundroomhq/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { BarChart3, Sparkles } from "lucide-react";
import { useId, useState } from "react";
import {
  type AiUpdateDraftResult,
  aiRequestErrorMessage,
  discardAiRequest,
  isAiRetryable,
  startUpdateDraft,
  useAiRequest,
} from "../../lib/ai-queries.js";
import { api, call } from "../../lib/api.js";
import { formatDate } from "../../lib/format.js";
import { Markdown } from "../../lib/markdown.js";
import { type PageDoc, updatePostsQuery, updateTemplatesQuery } from "../../lib/updates-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { NativeSelect } from "../compliance/common.js";
import { ErrorAlert } from "../error-alert.js";
import { AiPollStatus } from "./poll-status.js";

/*
 * "Draft with AI" (E3.12) on the updates list. The model drafts from the staff member's notes, the
 * template's outline, the last sent update and (with metrics on) the KPIs; the dialog shows the
 * suggestion read-only, and "Create draft" saves it through the normal paths — `POST /updates/posts`
 * (blank) then `PUT …/draft` with the suggested doc — and opens the editor. Nothing is sent to
 * anyone: the draft goes through the usual review and send flow. Closing discards the request.
 */
const NOTES_MAX = 2000;
const TEMPLATES = ["yc", "minimal", "board", "blank"] as const;
type TemplateKey = (typeof TEMPLATES)[number];

function isTemplateKey(v: string): v is TemplateKey {
  return (TEMPLATES as readonly string[]).includes(v);
}

export function DraftWithAiButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        <Sparkles aria-hidden="true" />
        {m.ai_draft_button()}
      </Button>
      {open ? <DraftWithAiDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function DraftWithAiDialog({ onClose }: { onClose: () => void }) {
  const [requestId, setRequestId] = useState<string | null>(null);
  const close = () => {
    if (requestId !== null) void discardAiRequest(requestId);
    onClose();
  };
  return (
    <Dialog open onOpenChange={(open) => (open ? null : close())}>
      <DialogContent className="sm:max-w-3xl">
        {requestId === null ? (
          <DraftForm onStarted={setRequestId} onCancel={close} />
        ) : (
          <DraftProgress
            requestId={requestId}
            onRetry={() => {
              void discardAiRequest(requestId);
              setRequestId(null);
            }}
            onClose={close}
            onApplied={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DraftForm({
  onStarted,
  onCancel,
}: {
  onStarted: (requestId: string) => void;
  onCancel: () => void;
}) {
  const ids = { notes: useId(), template: useId() };
  const [notes, setNotes] = useState("");
  const [template, setTemplate] = useState<TemplateKey>("yc");
  const templates = useQuery(updateTemplatesQuery);
  const start = useGuardedMutation({
    mutationFn: () =>
      startUpdateDraft({ notes: notes.trim() === "" ? null : notes.trim(), template }),
    onSuccess: (r) => onStarted(r.requestId),
  });
  const options = templates.data?.templates ?? [];
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        start.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>{m.ai_draft_title()}</DialogTitle>
        <DialogDescription>{m.ai_draft_body()}</DialogDescription>
      </DialogHeader>
      <Field id={ids.template} label={m.updates_field_template()}>
        <NativeSelect
          id={ids.template}
          value={template}
          onChange={(e) => {
            if (isTemplateKey(e.target.value)) setTemplate(e.target.value);
          }}
        >
          {(options.length > 0 ? options : TEMPLATES.map((key) => ({ key, name: key }))).map(
            (t) => (
              <option key={t.key} value={t.key}>
                {t.name}
              </option>
            ),
          )}
        </NativeSelect>
      </Field>
      <Field
        id={ids.notes}
        label={m.ai_draft_notes_label()}
        description={m.ai_draft_notes_help({ max: String(NOTES_MAX) })}
      >
        <Textarea
          id={ids.notes}
          rows={6}
          maxLength={NOTES_MAX}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          {...fieldAria(ids.notes, { description: true })}
        />
      </Field>
      <p className="text-sm text-muted-foreground">{m.ai_draft_review_note()}</p>
      {start.isError ? <ErrorAlert error={start.error} /> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" loading={start.isPending}>
          <Sparkles aria-hidden="true" />
          {m.ai_draft_start()}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DraftProgress({
  requestId,
  onRetry,
  onClose,
  onApplied,
}: {
  requestId: string;
  onRetry: () => void;
  onClose: () => void;
  onApplied: () => void;
}) {
  const poll = useAiRequest(requestId);
  const data = poll.data;
  const terminal = poll.terminal;
  const result =
    data?.status === "done" && data.result?.kind === "update_draft" ? data.result : null;
  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{m.ai_draft_title()}</DialogTitle>
        <DialogDescription>{m.ai_draft_suggestion_body()}</DialogDescription>
      </DialogHeader>
      <AiPollStatus poll={poll} />
      {data !== undefined && terminal && result === null ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{m.ai_error_title()}</AlertTitle>
          <AlertDescription>{aiRequestErrorMessage(data)}</AlertDescription>
        </Alert>
      ) : null}
      {result !== null ? (
        <DraftPreview
          requestId={requestId}
          result={result}
          onApplied={onApplied}
          onDiscard={onClose}
        />
      ) : (
        <DialogFooter>
          {terminal && data !== undefined && isAiRetryable(data) ? (
            <Button type="button" variant="outline" onClick={onRetry}>
              {m.ai_try_again()}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose}>
            {terminal ? m.common_close() : m.common_cancel()}
          </Button>
        </DialogFooter>
      )}
    </div>
  );
}

function DraftPreview({
  requestId,
  result,
  onApplied,
  onDiscard,
}: {
  requestId: string;
  result: AiUpdateDraftResult;
  onApplied: () => void;
  onDiscard: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const title = result.title.trim() === "" ? m.ai_draft_untitled() : result.title.trim();
  // The contract types `doc` loosely (contracts cannot import the content module's schema); the
  // updates task validated it as a post doc, and the draft PUT validates it again.
  const doc = result.doc as unknown as PageDoc;
  const create = useGuardedMutation({
    mutationFn: async () => {
      const created = await call(
        api().POST("/updates/posts", { body: { title, template: "blank" } }),
      );
      const id = created.post.id;
      const putDraft = () =>
        call(
          api().PUT("/updates/posts/{id}/draft", {
            params: { path: { id } },
            body: { doc, baseSavedAt: created.post.savedAt },
          }),
        );
      // R3-L6: the two writes are not atomic. Retry the draft once; if it still fails, delete the
      // empty post so a second press does not leave another one behind.
      try {
        await putDraft();
      } catch {
        try {
          await putDraft();
        } catch (error) {
          await api()
            .DELETE("/updates/posts/{id}", { params: { path: { id } } })
            .catch(() => undefined);
          throw error;
        }
      }
      return id;
    },
    onSuccess: (postId) => {
      void discardAiRequest(requestId);
      toast.success(m.ai_draft_created());
      void queryClient.invalidateQueries({ queryKey: updatePostsQuery.queryKey });
      onApplied();
      void navigate({ to: "/admin/$", params: { _splat: `updates/${postId}` } });
    },
  });
  const last = result.sources.lastUpdate;
  return (
    <>
      <Alert variant="warning">
        <Sparkles aria-hidden="true" />
        <AlertTitle>{m.ai_suggestion_label()}</AlertTitle>
        <AlertDescription>{m.ai_draft_check_figures()}</AlertDescription>
      </Alert>
      <FigureList
        figures={result.unverifiedNumbers}
        title={m.ai_draft_unverified_title()}
        body={m.ai_draft_unverified_body()}
      />
      <FigureList
        figures={result.numbersFromLastUpdate}
        title={m.ai_draft_last_update_figures_title()}
        body={m.ai_draft_last_update_figures_body()}
      />
      <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
        <li>{result.sources.kpis ? m.ai_draft_source_kpis() : m.ai_draft_source_no_kpis()}</li>
        <li>
          {last === null
            ? m.ai_draft_source_no_last_update()
            : m.ai_draft_source_last_update({ title: last.title, when: formatDate(last.sentAt) })}
        </li>
      </ul>
      <section
        aria-label={m.ai_draft_preview_label()}
        className="max-h-[50vh] space-y-4 overflow-y-auto rounded-md border p-4"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be focusable for keyboard users (WCAG 2.1.1).
        tabIndex={0}
      >
        <h3 className="text-lg font-semibold">{title}</h3>
        {(doc.sections ?? []).map((section) => (
          <div key={section.key} className="space-y-2">
            {section.title ? <h4 className="font-semibold">{section.title}</h4> : null}
            {section.blocks.map((block) =>
              block.type === "rich_text" ? (
                <Markdown
                  key={block.id}
                  source={String((block.data as { text?: unknown }).text ?? "")}
                  className="prose prose-neutral prose-sm max-w-none dark:prose-invert"
                />
              ) : block.type === "metric_grid" ? (
                <p key={block.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                  <BarChart3 aria-hidden="true" className="size-4" />
                  {m.ai_draft_metric_grid({
                    n: ((block.data as { definitionIds?: unknown[] }).definitionIds ?? []).length,
                  })}
                </p>
              ) : null,
            )}
          </div>
        ))}
      </section>
      {create.isError ? <ErrorAlert error={create.error} /> : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDiscard}>
          {m.ai_discard()}
        </Button>
        <Button type="button" loading={create.isPending} onClick={() => create.mutate()}>
          {m.ai_draft_create()}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Figures the reader must check: not in the KPIs or notes, or only in the previous update. */
function FigureList({
  figures,
  title,
  body,
}: {
  figures: readonly string[];
  title: string;
  body: string;
}) {
  if (figures.length === 0) return null;
  return (
    <Alert variant="warning">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{body}</p>
        <ul className="mt-1 flex flex-wrap gap-2">
          {figures.map((n) => (
            <li key={n} className="rounded border px-1.5 font-mono text-xs">
              {n}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
