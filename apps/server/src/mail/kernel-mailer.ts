import { type MailerPort, MailSuppressedError } from "@fundroom/ports";
import type { MailFeedback } from "./feedback.js";

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

/*
 * The composition root's mail wrapper (E2.6 decisions 3 and the `core.mail_message` recording).
 * It sits outside every other decorator, so what it sees is exactly what a module asked to send:
 *
 *  1. **Suppression, before anything else.** A `broadcast` or `notification` message for a
 *     workspace is refused with `MailSuppressedError` when that workspace has suppressed the
 *     address; the adapter is never called, the template never rendered. `transactional` mail
 *     (and a message with no `stream`, which *is* transactional) is never checked — a person
 *     whose address once bounced must still be able to sign in. A failing suppression lookup
 *     fails the send: sending to an address we cannot prove is allowed is the wrong default, and
 *     the caller's retry path already exists.
 *  2. **The provider's own list.** An adapter that is refused by the ESP's suppression list
 *     throws `MailSuppressedError("provider")` (Postmark's 406); the address is then listed in
 *     the workspace with reason `provider` (best effort) and the error goes on to the caller,
 *     which already treats a suppression as "skipped, no retry".
 *  3. **Recording, after the provider accepted it.** One `core.mail_message` row per message sent
 *     on behalf of a workspace, so a later webhook can find its way back. Best effort: the send
 *     has happened; a failed insert is a log line (no address in it), never a failed send.
 *
 * Every database call here runs on `MailFeedbackOptions.sendDb`, a pool of its own, because
 * senders may hold a main-pool connection while they send (see `feedback.ts`).
 *
 * `provider` is the inner mailer's `driver`, and the webhook ingress looks rows up under the
 * configured driver too, so the two agree by construction rather than by each adapter spelling
 * its own name the same way in two places.
 */
export function createKernelMailer(
  inner: MailerPort,
  feedback: Pick<MailFeedback, "suppressionFor" | "recordSent" | "noteProviderSuppression">,
  log: Log = () => {},
): MailerPort {
  const mailer: MailerPort = {
    driver: inner.driver,
    ...(inner.capabilities === undefined ? {} : { capabilities: inner.capabilities }),
    async send(message) {
      const stream = message.stream ?? "transactional";
      const workspaceId = message.workspaceId;
      if (stream !== "transactional" && workspaceId !== undefined) {
        const reason = await feedback.suppressionFor(workspaceId, message.to);
        if (reason !== undefined) throw new MailSuppressedError(reason);
      }
      let sent: Awaited<ReturnType<MailerPort["send"]>>;
      try {
        sent = await inner.send(message);
      } catch (error) {
        if (
          error instanceof MailSuppressedError &&
          error.reason === "provider" &&
          workspaceId !== undefined
        ) {
          try {
            await feedback.noteProviderSuppression(inner.driver, workspaceId, message.to);
          } catch (noteError) {
            log("mail.provider_suppression_failed", {
              level: "warn",
              workspaceId,
              stream,
              error: noteError instanceof Error ? noteError.message : String(noteError),
            });
          }
        }
        throw error;
      }
      if (workspaceId !== undefined) {
        try {
          await feedback.recordSent(inner.driver, message, sent);
        } catch (error) {
          log("mail.record_failed", {
            level: "warn",
            workspaceId,
            stream,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return sent;
    },
    healthCheck: () => inner.healthCheck(),
  };
  if (inner.parseWebhook !== undefined) {
    const parse = inner.parseWebhook.bind(inner);
    return { ...mailer, parseWebhook: parse };
  }
  return mailer;
}
