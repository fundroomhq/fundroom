/*
 * Test support for the integration suites (not imported by the server).
 *
 * `POST /auth/otp/start` sends its mail detached (E2.10 R1-03): the send is started but not
 * awaited, and the container's mailer chain (templating/branding, suppression) does database reads
 * before the message reaches the memory mailer. On a loaded machine the response can therefore
 * arrive before the mail does, and "the last mail sent" may be something else entirely: the
 * security notice a TOTP enrolment sends (`afterFactorChange`), a notification job's alert, or
 * nothing yet. So a suite asks for *the code mail to this address sent after a given point*, and
 * waits a bounded while for it.
 */
import type { MemoryMailer } from "@fundroom/mail";

const CODE_LINE = /^\s{4}(\d{6})$/mu;

type SentMail = MemoryMailer["sent"][number];

/** Anything that records what it sent: the memory mailer, or a suite's own fake. */
export interface SentMailLog {
  readonly sent: readonly SentMail[];
}

/**
 * The first mail to `to` sent after the first `since` (take `mailer.sent.length` before the
 * request) that satisfies `match`, waiting a bounded while for it. For mails the server sends
 * detached (OTP / magic-link / access-request mail), which can land after the response.
 */
export async function awaitMail(
  mailer: SentMailLog,
  opts: {
    readonly to: string;
    readonly since: number;
    readonly match?: (mail: SentMail) => boolean;
    readonly timeoutMs?: number;
  },
): Promise<SentMail> {
  const { to, since, match, timeoutMs = 15_000 } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const mail of mailer.sent.slice(since)) {
      if (mail.to === to && (!match || match(mail))) return mail;
    }
    if (Date.now() > deadline) {
      const seen = mailer.sent
        .slice(since)
        .map((m) => `${m.to}: ${m.subject}`)
        .join("\n");
      throw new Error(`no matching mail to ${to} within ${timeoutMs} ms; sent:\n${seen}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * The sign-in code from the first mail to `email` carrying one, among the mails sent after the
 * first `since` (take `mailer.sent.length` before calling `/auth/otp/start`).
 */
export async function awaitSignInCode(
  mailer: SentMailLog,
  email: string,
  since: number,
  timeoutMs = 15_000,
): Promise<string> {
  const mail = await awaitMail(mailer, {
    to: email,
    since,
    match: (m) => CODE_LINE.test(m.text),
    timeoutMs,
  }).catch((error: unknown) => {
    throw new Error(
      `no sign-in code mailed to ${email}: ${error instanceof Error ? error.message : error}`,
    );
  });
  const code = CODE_LINE.exec(mail.text)?.[1];
  if (!code) throw new Error(`no sign-in code in mail to ${email}`);
  return code;
}
