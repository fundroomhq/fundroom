import { Badge, Button } from "@fundroomhq/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import {
  type QaQuestionView,
  type QaTargetKind,
  qaTargetQuestionsQuery,
  questionHeadline,
  questionPublicRest,
} from "../../../lib/qa-queries.js";
import { m } from "../../../paraglide/messages.js";
import { QaAnswerBlock, QaListError, QaStatusBadge, QaWhen } from "./common.js";

/*
 * The "Questions and answers" section under a document or a folder (E3.3): answers the team
 * published to everyone who can see this target, plus the caller's own questions on it. A
 * question that is not the caller's shows only its published wording — the server never sends
 * who asked it or what they originally wrote.
 */
export function QaTargetPanel({
  targetKind,
  targetId,
}: {
  targetKind: QaTargetKind;
  targetId: string;
}) {
  const headingId = useId();
  const list = useInfiniteQuery(qaTargetQuestionsQuery(targetKind, targetId));
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section aria-labelledby={headingId} className="space-y-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {m.dataroom_qa_panel_heading()}
      </h2>
      {list.isPending ? (
        <p className="text-sm text-muted-foreground">{m.common_loading()}</p>
      ) : list.isError ? (
        <QaListError error={list.error} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {targetKind === "document"
            ? m.dataroom_qa_panel_empty_document()
            : m.dataroom_qa_panel_empty_folder()}
        </p>
      ) : (
        <ul className="space-y-3">
          {items.map((q) => (
            <li key={q.id}>
              <QuestionItem q={q} />
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
    </section>
  );
}

function QuestionItem({ q }: { q: QaQuestionView }) {
  const id = useId();
  const text = q.mine ? (q.body ?? "") : questionPublicRest(q);
  return (
    <article aria-labelledby={`${id}-h`} className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`${id}-h`} className="font-medium">
          <Link
            to="/$"
            params={{ _splat: `data-room/questions/${q.id}` }}
            className="underline underline-offset-2 hover:no-underline"
          >
            {questionHeadline(q)}
          </Link>
        </h3>
        {q.mine ? (
          <>
            <Badge variant="outline">{m.dataroom_qa_yours()}</Badge>
            <QaStatusBadge status={q.status} />
          </>
        ) : null}
      </div>
      {text ? <p className="line-clamp-4 whitespace-pre-wrap text-sm">{text}</p> : null}
      <QaWhen q={q} />
      {q.answer ? <QaAnswerBlock answer={q.answer} headingId={`${id}-a`} /> : null}
    </article>
  );
}
