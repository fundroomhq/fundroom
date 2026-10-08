import { Alert, AlertDescription, AlertTitle, Button } from "@fundroomhq/ui";
import { Loader2 } from "lucide-react";
import type { useAiRequest } from "../../lib/ai-queries.js";
import { isApiError } from "../../lib/api.js";
import { m } from "../../paraglide/messages.js";
import { ErrorAlert } from "../error-alert.js";

/*
 * What a polled AI request looks like before it has a result: working (and, through a transient
 * failure, "still trying"), given up after the polling window (with "Check again"), or a hard
 * error (the request is gone or no longer the viewer's).
 */
export function AiPollStatus({ poll }: { poll: ReturnType<typeof useAiRequest> }) {
  if (poll.error !== null) {
    // RR3-L9: a 404 while polling means the row is gone (discarded, e.g. because a document it
    // drew on changed, or expired), not that something broke.
    if (isApiError(poll.error) && poll.error.status === 404) {
      return (
        <Alert variant="warning" role="alert">
          <AlertTitle>{m.ai_error_title()}</AlertTitle>
          <AlertDescription>{m.ai_error_gone()}</AlertDescription>
        </Alert>
      );
    }
    return <ErrorAlert error={poll.error} />;
  }
  if (poll.gaveUp) {
    return (
      <Alert variant="warning" role="alert">
        <AlertTitle>{m.ai_gave_up_title()}</AlertTitle>
        <AlertDescription>
          <p>{m.ai_gave_up_body()}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={poll.checkAgain}
          >
            {m.ai_check_again()}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (poll.terminal) return null;
  return (
    <p role="status" className="flex items-center gap-2 text-sm">
      <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      {poll.retrying ? m.ai_working_retrying() : m.ai_working()}
    </p>
  );
}
