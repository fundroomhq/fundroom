/**
 * Posting a short alert into a team chat through an incoming webhook (E2.6, design/03 C2/F8).
 * The default adapter `@fundroom/chat-slack` speaks Slack's incoming-webhook format.
 *
 * The port is one write method and one pure check, for the same reason `SpreadsheetPort` is one
 * read: a module that can post to a chat must not thereby hold a general outbound `fetch`
 * (ADR-0039's argument for `dns`). The adapter pins the destination host (`hooks.slack.com`),
 * follows no redirects and refuses anything else, so a pasted URL cannot turn an alert into a
 * request against an address of the pasting admin's choosing.
 *
 * A webhook URL is a bearer credential: whoever holds it can post into the channel. Callers
 * store it envelope-encrypted, never log it, never return it, and adapters never put it in a
 * `detail`.
 */

export interface ChatMessage {
  /** Plain text, already rendered; the adapter escapes whatever its format treats as markup. */
  readonly text: string;
  /** Optional deep link rendered as a button or trailing link. Absolute https URL. */
  readonly link?: { readonly url: string; readonly label: string } | undefined;
}

/**
 * Why a post failed, chosen for what it tells an admin to do: `invalid_url` and `not_found` mean
 * "paste a new webhook" (Slack answers 404/410 `no_service` once a webhook is revoked),
 * `rate_limited` and `unavailable` mean "we will retry".
 */
export type ChatPostFailure =
  | "invalid_url"
  | "not_found"
  | "rejected"
  | "rate_limited"
  | "unavailable";

export type ChatPostResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: ChatPostFailure;
      readonly retryAfterMs?: number | undefined;
      /** Safe for an admin to read: never contains the URL. */
      readonly detail?: string | undefined;
    };

export interface ChatWebhookPort {
  readonly driver: string;
  /** Pure: whether this adapter would post to `url` at all. Used at save time, before storing. */
  validateUrl(url: string): { readonly ok: true } | { readonly ok: false; readonly reason: string };
  /** Never throws for a remote-side problem; answers a `ChatPostResult`. */
  post(url: string, message: ChatMessage): Promise<ChatPostResult>;
}
