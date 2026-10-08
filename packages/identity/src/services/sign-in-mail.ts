import type { OutboundEmail } from "@fundroom/ports";
import type { IdentityDeps } from "./types.js";

/*
 * Sign-in mail is sent *detached* from the start request (E2.10 R1-03).
 *
 * `/auth/otp/start` and `/auth/magic-link/start` answer identically for an address that may sign
 * in and one that may not (P2-02: the ineligible path writes a decoy challenge and sends
 * nothing). Awaiting the send broke that twice over:
 *
 *  - a failing mailer turned into `503 mail_failed` for eligible addresses only, while unknown
 *    ones still got `200 sent` — during an SMTP outage (or one an attacker provokes by degrading
 *    the relay) every address's membership could be read off the status code;
 *  - a send slower than the 250 ms floor made eligible addresses measurably slower.
 *
 * So the send is started and not awaited: the response depends only on the database work both
 * paths do, inside the same minimum duration. A failure is logged for ops (`level: warn`,
 * `auth.sign_in_mail_failed`) and never reaches the caller; the person who asked for the code
 * sees the ordinary "didn't get it? send another" path, which is the retry. Not queued for a
 * later retry on purpose: a code lives ten minutes, and mail that arrives after the relay
 * recovers would carry a code that is already dead or about to be.
 *
 * The send is *started* synchronously, before the caller's first `await`, but nothing waits for
 * it: the server's mail wrappers (branding, suppression) read the database first, so the message
 * can reach the mailer after the response. Tests wait for it (`apps/server/src/test/sign-in-mail.ts`).
 */
export function sendSignInMailDetached(
  deps: IdentityDeps,
  message: OutboundEmail,
  meta: {
    readonly kind: "otp" | "magic_link" | "access_request";
    readonly workspaceId: string | undefined;
  },
): Promise<void> {
  let sending: Promise<unknown>;
  try {
    sending = deps.mailer.send(message);
  } catch (error) {
    sending = Promise.reject(error);
  }
  return sending.then(
    () => {
      deps.log?.(`auth.${meta.kind}_sent`, {
        workspaceId: meta.workspaceId,
      });
    },
    (error: unknown) => {
      // Never the message or the error text: an SMTP reply often quotes the recipient address.
      const code = (error as { responseCode?: unknown; code?: unknown } | null) ?? {};
      deps.log?.("auth.sign_in_mail_failed", {
        level: "warn",
        kind: meta.kind,
        workspaceId: meta.workspaceId,
        error: error instanceof Error ? error.name : "unknown",
        ...(typeof code.responseCode === "number" ? { smtpCode: code.responseCode } : {}),
        ...(typeof code.code === "string" ? { errorCode: code.code.slice(0, 32) } : {}),
      });
    },
  );
}
