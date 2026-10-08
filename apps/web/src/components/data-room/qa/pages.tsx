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
  EmptyState,
  LoadingState,
  PageHeader,
  toast,
} from "@fundroomhq/ui";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, MessageSquare } from "lucide-react";
import { useId, useRef, useState } from "react";
import { isApiError, isCode } from "../../../lib/api.js";
import { formatDate, formatDateTime } from "../../../lib/format.js";
import {
  isPending,
  myQuestionsQuery,
  QA_KEY,
  type QaQuestionView,
  qaQuestionQuery,
  qaTargetSplat,
  questionHeadline,
  questionPublicRest,
  withdrawQuestion,
} from "../../../lib/qa-queries.js";
import { useGuardedMutation } from "../../../lib/use-guarded-mutation.js";
import { m } from "../../../paraglide/messages.js";
import { ErrorAlert } from "../../error-alert.js";
import { NotFoundScreen } from "../../status-screens.js";
import { QaAnswerBlock, QaListError, QaStatusBadge } from "./common.js";

/*
 * `/data-room/questions` (the caller's own questions) and `/data-room/questions/<id>` (one
 * question). The detail page is also where search results and "your question was answered"
 * emails land, so it renders a published question seen by someone who did not ask it: the
 * published wording and the answer, nothing about the asker.
 */
function BackToDataRoom() {
  return (
    <Button asChild variant="ghost" size="sm">
      <Link to="/$" params={{ _splat: "data-room" }}>
        <ArrowLeft aria-hidden="true" />
        {m.dataroom_qa_back_to_data_room()}
      </Link>
    </Button>
  );
}

export function MyQuestionsPage() {
  const list = useInfiniteQuery(myQuestionsQuery);
  if (list.isPending) return <LoadingState label={m.common_loading()} />;
  if (list.isError)
    return isCode(list.error, "not_found") ? (
      <NotFoundScreen />
    ) : (
      <QaListError error={list.error} />
    );
  const items = list.data.pages.flatMap((p) => p.items);
  return (
    <div className="space-y-6">
      <PageHeader
        title={m.dataroom_qa_my_questions()}
        description={m.dataroom_qa_my_questions_subtitle()}
        actions={<BackToDataRoom />}
      />
      {items.length === 0 ? (
        <EmptyState
          icon={<MessageSquare aria-hidden="true" />}
          title={m.dataroom_qa_mine_empty_title()}
          description={m.dataroom_qa_mine_empty_body()}
        />
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((q) => (
            <li key={q.id} className="flex flex-wrap items-start gap-3 p-3">
              <div className="min-w-0 flex-1 space-y-1">
                <Link
                  to="/$"
                  params={{ _splat: `data-room/questions/${q.id}` }}
                  className="font-medium underline underline-offset-2 hover:no-underline"
                >
                  {questionHeadline(q)}
                </Link>
                {q.createdAt ? (
                  <p className="text-xs text-muted-foreground">
                    {q.targetTitle
                      ? m.dataroom_qa_about_asked({
                          title: q.targetTitle,
                          when: formatDate(q.createdAt),
                        })
                      : m.dataroom_qa_asked_on({ when: formatDate(q.createdAt) })}
                  </p>
                ) : null}
              </div>
              <QaStatusBadge status={q.status} />
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          loading={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {m.dataroom_qa_show_more()}
        </Button>
      ) : null}
    </div>
  );
}

export function QuestionDetailPage({ id }: { id: string }) {
  const q = useQuery(qaQuestionQuery(id));
  if (q.isPending) return <LoadingState label={m.common_loading()} />;
  if (q.isError) {
    if (isCode(q.error, "not_found", "validation_failed")) return <NotFoundScreen />;
    // S1: a published question about a document whose access requirement (an NDA, say) is
    // still pending answers 403 with the gates — say what is missing, show nothing else.
    if (
      isCode(q.error, "forbidden") &&
      isApiError(q.error) &&
      Array.isArray(q.error.body.error["pendingGates"])
    )
      return (
        <div className="space-y-6">
          <PageHeader title={m.dataroom_qa_question_heading()} actions={<BackToDataRoom />} />
          <Alert variant="warning" role="alert">
            <AlertTitle>{m.dataroom_qa_err_gated_title()}</AlertTitle>
            <AlertDescription>{m.dataroom_qa_gated_detail_body()}</AlertDescription>
          </Alert>
        </div>
      );
    return <ErrorAlert error={q.error} />;
  }
  return <Detail q={q.data} />;
}

function Detail({ q }: { q: QaQuestionView }) {
  const base = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const questionText = q.mine ? (q.body ?? "") : questionPublicRest(q);
  const targetLabel =
    q.targetKind === "document" ? m.dataroom_qa_target_document() : m.dataroom_qa_target_folder();
  return (
    <article className="space-y-6" aria-labelledby={`${base}-title`}>
      <PageHeader
        title={
          <span id={`${base}-title`} ref={headingRef} tabIndex={-1} className="outline-none">
            {questionHeadline(q)}
          </span>
        }
        description={q.mine ? m.dataroom_qa_detail_mine() : m.dataroom_qa_detail_published()}
        actions={
          <div className="flex flex-wrap gap-2">
            {q.mine ? (
              <Button asChild variant="ghost" size="sm">
                <Link to="/$" params={{ _splat: "data-room/questions" }}>
                  <ArrowLeft aria-hidden="true" />
                  {m.dataroom_qa_my_questions()}
                </Link>
              </Button>
            ) : (
              <BackToDataRoom />
            )}
            {q.mine && isPending(q.status) ? (
              <WithdrawButton id={q.id} onWithdrawn={() => headingRef.current?.focus()} />
            ) : null}
          </div>
        }
      />
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
        {q.mine ? (
          <>
            <dt className="text-muted-foreground">{m.dataroom_qa_field_status()}</dt>
            <dd>
              <QaStatusBadge status={q.status} />
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">{targetLabel}</dt>
        <dd>
          {q.targetTitle ? (
            <Link
              to="/$"
              params={{ _splat: qaTargetSplat(q.targetKind, q.targetId) }}
              className="underline underline-offset-2 hover:no-underline"
            >
              {q.targetTitle}
            </Link>
          ) : (
            <span className="text-muted-foreground">{m.dataroom_qa_target_unavailable()}</span>
          )}
        </dd>
        {q.mine && q.createdAt ? (
          <>
            <dt className="text-muted-foreground">{m.dataroom_qa_field_asked()}</dt>
            <dd>{formatDateTime(q.createdAt)}</dd>
          </>
        ) : null}
        {!q.mine && q.publishedAt ? (
          <>
            <dt className="text-muted-foreground">{m.dataroom_qa_field_published()}</dt>
            <dd>{formatDateTime(q.publishedAt)}</dd>
          </>
        ) : null}
      </dl>

      {questionText ? (
        <section aria-labelledby={`${base}-q`} className="space-y-1">
          <h2 id={`${base}-q`} className="text-sm font-semibold">
            {q.mine ? m.dataroom_qa_your_question() : m.dataroom_qa_question_heading()}
          </h2>
          <p className="whitespace-pre-wrap text-sm">{questionText}</p>
        </section>
      ) : null}

      {q.mine && q.status === "published" && q.publicText ? (
        <section aria-labelledby={`${base}-p`} className="space-y-1">
          <h2 id={`${base}-p`} className="text-sm font-semibold">
            {m.dataroom_qa_published_wording()}
          </h2>
          <p className="text-xs text-muted-foreground">{m.dataroom_qa_published_wording_hint()}</p>
          <p className="whitespace-pre-wrap text-sm">{q.publicText}</p>
        </section>
      ) : null}

      {q.answer ? (
        <div className="space-y-2">
          <QaAnswerBlock answer={q.answer} headingLevel={2} headingId={`${base}-a`} />
          {q.mine ? (
            <p className="text-xs text-muted-foreground">
              {q.status === "published"
                ? m.dataroom_qa_visibility_target()
                : m.dataroom_qa_visibility_asker()}
            </p>
          ) : null}
        </div>
      ) : q.mine && isPending(q.status) ? (
        <p className="text-sm text-muted-foreground">{m.dataroom_qa_waiting()}</p>
      ) : q.mine && q.status === "closed" ? (
        <p className="text-sm text-muted-foreground">{m.dataroom_qa_closed_note()}</p>
      ) : null}
    </article>
  );
}

/*
 * Withdraw asks first. The dialog stays open while the request runs so a refusal is shown where
 * the reader is looking; on success the button disappears with the pending state, so focus
 * moves to the page heading instead of being dropped on the body.
 */
function WithdrawButton({ id, onWithdrawn }: { id: string; onWithdrawn: () => void }) {
  const [open, setOpen] = useState(false);
  const done = useRef(false);
  const queryClient = useQueryClient();
  const withdraw = useGuardedMutation({
    mutationFn: () => withdrawQuestion(id),
    onSuccess: (view) => {
      toast.success(m.dataroom_qa_withdrawn());
      queryClient.setQueryData(qaQuestionQuery(id).queryKey, view);
      void queryClient.invalidateQueries({ queryKey: QA_KEY });
      done.current = true;
      setOpen(false);
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (withdraw.isPending) return;
        setOpen(next);
        if (next) withdraw.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {m.dataroom_qa_withdraw()}
        </Button>
      </DialogTrigger>
      <DialogContent
        onCloseAutoFocus={(e) => {
          if (!done.current) return;
          e.preventDefault();
          onWithdrawn();
        }}
      >
        <DialogHeader>
          <DialogTitle>{m.dataroom_qa_withdraw_title()}</DialogTitle>
          <DialogDescription>{m.dataroom_qa_withdraw_body()}</DialogDescription>
        </DialogHeader>
        {withdraw.isError ? <ErrorAlert error={withdraw.error} /> : null}
        <p role="status" className="sr-only">
          {withdraw.isPending ? m.dataroom_qa_withdrawing() : ""}
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            {m.common_cancel()}
          </Button>
          <Button
            type="button"
            variant="destructive"
            loading={withdraw.isPending}
            onClick={() => withdraw.mutate()}
          >
            {m.dataroom_qa_withdraw_confirm()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
