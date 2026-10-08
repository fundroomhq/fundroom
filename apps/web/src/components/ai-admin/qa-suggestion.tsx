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
} from "@fundroomhq/ui";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Sparkles } from "lucide-react";
import { useId, useState } from "react";
import {
  type AiQaAnswerResult,
  aiRequestErrorMessage,
  discardAiRequest,
  isAiRetryable,
  startQaSuggestion,
  useAiRequest,
} from "../../lib/ai-queries.js";
import { useGuardedMutation } from "../../lib/use-guarded-mutation.js";
import { m } from "../../paraglide/messages.js";
import { ErrorAlert } from "../error-alert.js";
import { AiPollStatus } from "./poll-status.js";

/*
 * "Suggest an answer" (E3.12) on a Q&A question. The model answers only from documents the ASKER
 * may view, and the server keeps only citations whose quote it found in the passage it sent; the
 * panel shows the outcome, the text and the numbered sources (each a link to the page it quotes).
 * "Use this text" puts the text into the answer editor — nothing is saved until staff save it,
 * which makes them the answer's author, so four-eyes approval still applies.
 *
 * `requestId` lives with the caller so a save (which remounts the editor) keeps the panel.
 */
export function QaSuggestion({
  questionId,
  requestId,
  onRequest,
  editorText,
  onUse,
}: {
  questionId: string;
  requestId: string | null;
  onRequest: (id: string | null) => void;
  /** What the answer editor holds now (a different, non-empty text asks before replacing it). */
  editorText: string;
  onUse: (text: string) => void;
}) {
  const start = useGuardedMutation({
    mutationFn: () => startQaSuggestion(questionId),
    onSuccess: (r) => onRequest(r.requestId),
  });
  const discard = () => {
    if (requestId !== null) void discardAiRequest(requestId);
    onRequest(null);
  };
  if (requestId === null) {
    return (
      <div className="space-y-2">
        <Button
          type="button"
          variant="outline"
          loading={start.isPending}
          onClick={() => start.mutate()}
        >
          <Sparkles aria-hidden="true" />
          {m.ai_qa_suggest()}
        </Button>
        {start.isError ? <ErrorAlert error={start.error} /> : null}
      </div>
    );
  }
  return (
    <SuggestionPanel
      requestId={requestId}
      editorText={editorText}
      onUse={onUse}
      onDiscard={discard}
      onRetry={() => {
        discard();
        start.mutate();
      }}
    />
  );
}

function SuggestionPanel({
  requestId,
  editorText,
  onUse,
  onDiscard,
  onRetry,
}: {
  requestId: string;
  editorText: string;
  onUse: (text: string) => void;
  onDiscard: () => void;
  onRetry: () => void;
}) {
  const headingId = useId();
  const poll = useAiRequest(requestId);
  const data = poll.data;
  const terminal = poll.terminal;
  const result = data?.status === "done" && data.result?.kind === "qa_answer" ? data.result : null;
  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-md border border-dashed p-4">
      <h3 id={headingId} className="flex items-center gap-2 font-semibold">
        <Sparkles aria-hidden="true" className="size-4 text-muted-foreground" />
        {m.ai_qa_panel_title()}
      </h3>
      <div className="flex flex-wrap items-center gap-3">
        <AiPollStatus poll={poll} />
        {!terminal && poll.error === null ? (
          <Button type="button" variant="outline" size="sm" onClick={onDiscard}>
            {poll.gaveUp ? m.ai_discard() : m.common_cancel()}
          </Button>
        ) : null}
      </div>
      {data !== undefined && terminal && result === null ? (
        <>
          <Alert variant="destructive" role="alert">
            <AlertTitle>{m.ai_error_title()}</AlertTitle>
            <AlertDescription>{aiRequestErrorMessage(data)}</AlertDescription>
          </Alert>
          <div className="flex flex-wrap gap-2">
            {isAiRetryable(data) ? (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                {m.ai_try_again()}
              </Button>
            ) : null}
            <Button type="button" variant="outline" size="sm" onClick={onDiscard}>
              {m.ai_discard()}
            </Button>
          </div>
        </>
      ) : null}
      {poll.error !== null ? (
        <Button type="button" variant="outline" size="sm" onClick={onDiscard}>
          {m.ai_discard()}
        </Button>
      ) : null}
      {result !== null ? (
        <SuggestionResult
          result={result}
          editorText={editorText}
          onUse={onUse}
          onDiscard={onDiscard}
        />
      ) : null}
    </section>
  );
}

function SuggestionResult({
  result,
  editorText,
  onUse,
  onDiscard,
}: {
  result: AiQaAnswerResult;
  editorText: string;
  onUse: (text: string) => void;
  onDiscard: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [used, setUsed] = useState(false);
  const use = () => {
    const current = editorText.trim();
    if (current !== "" && current !== result.body.trim()) {
      setConfirming(true);
      return;
    }
    apply();
  };
  const apply = () => {
    setConfirming(false);
    setUsed(true);
    onUse(result.body);
  };
  return (
    <div className="space-y-3">
      <Alert variant="warning">
        <AlertTitle>{m.ai_suggestion_label()}</AlertTitle>
        <AlertDescription>{m.ai_qa_check_sources()}</AlertDescription>
      </Alert>
      {result.outcome === "insufficient" ? (
        <Alert variant="warning">
          <AlertTitle>{m.ai_qa_insufficient_title()}</AlertTitle>
          <AlertDescription>{m.ai_qa_insufficient_body()}</AlertDescription>
        </Alert>
      ) : null}
      {result.outcome === "unsupported" ? (
        <Alert variant="warning">
          <AlertTitle>{m.ai_qa_unsupported_title()}</AlertTitle>
          <AlertDescription>{m.ai_qa_unsupported_body()}</AlertDescription>
        </Alert>
      ) : null}
      {result.body.trim() === "" ? null : (
        <p className="whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-sm">{result.body}</p>
      )}
      {result.citations.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">{m.ai_qa_sources()}</h4>
          <ol className="space-y-2 text-sm">
            {result.citations.map((c) => (
              <li key={c.n} className="space-y-1">
                <span className="font-mono text-xs">[{c.n}]</span>{" "}
                <Link
                  to="/$"
                  params={{ _splat: `data-room/documents/${c.documentId}` }}
                  hash={`page-${c.pageNo}`}
                  // A new tab: following a source must not lose the unsaved answer or this panel.
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`${m.ai_qa_source_link({ title: c.documentTitle, page: String(c.pageNo) })} ${m.ai_qa_source_new_tab()}`}
                  className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
                >
                  {m.ai_qa_source_link({ title: c.documentTitle, page: String(c.pageNo) })}
                  <ExternalLink aria-hidden="true" className="size-3" />
                </Link>
                <blockquote className="border-l-2 pl-3 text-muted-foreground">{c.quote}</blockquote>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {m.ai_qa_searched({ n: result.searchedDocuments })} {m.ai_qa_audience_checked()}
        {result.droppedCitations > 0 ? ` ${m.ai_qa_dropped({ n: result.droppedCitations })}` : ""}
      </p>
      {used ? (
        <p role="status" className="text-sm">
          {m.ai_qa_used()}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={use} disabled={result.body.trim() === ""}>
          {m.ai_qa_use()}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onDiscard}>
          {m.ai_discard()}
        </Button>
      </div>
      {confirming ? (
        <Dialog open onOpenChange={(open) => (open ? null : setConfirming(false))}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{m.ai_qa_replace_title()}</DialogTitle>
              <DialogDescription>{m.ai_qa_replace_body()}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirming(false)}>
                {m.common_cancel()}
              </Button>
              <Button type="button" onClick={apply}>
                {m.ai_qa_replace_confirm()}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
