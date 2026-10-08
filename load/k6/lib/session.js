import { sleep } from "k6";
import http from "k6/http";
import { MAILPIT_URL, OWNER_TOTP_SECRET } from "./config.js";
import { cookieHeader, ok, post } from "./http.js";
import { freshTotpCode, totpCode } from "./totp.js";

/*
 * Email-code sign-in, the only way into a `seed-demo` workspace (no passwords, no TOTP):
 * POST /auth/otp/start → the code arrives in Mailpit → POST /auth/otp/verify → session cookie.
 *
 * Run it in `setup()`, never per iteration: every start is rate-limited per address and per IP
 * (5 per 15 min / 20 per hour), which a load run would exhaust at once. Boot the stack under test
 * with RATE_LIMIT_MULTIPLIER (e.g. 100) so opening a few dozen sessions from one IP is allowed;
 * config refuses that knob in APP_ENV=prod.
 */
function mailIds(email) {
  const q = encodeURIComponent(`to:"${email}"`);
  const res = http.get(`${MAILPIT_URL}/api/v1/search?query=${q}&limit=20`, {
    tags: { name: "mailpit", phase: "setup" },
  });
  if (res.status !== 200) throw new Error(`mailpit search: HTTP ${res.status}`);
  return res.json().messages.map((m) => m.ID);
}

function codeFrom(id) {
  const res = http.get(`${MAILPIT_URL}/api/v1/message/${id}`, {
    tags: { name: "mailpit", phase: "setup" },
  });
  const m = /^ {4}(\d{6})\r?$/m.exec(res.json().Text || ""); // mail text is CRLF
  return m ? m[1] : undefined;
}

/** Signs `email` in and returns `{ email, cookie }`; throws if no code arrives within 30 s. */
export function signIn(email) {
  const before = new Set(mailIds(email));
  ok(post(undefined, "/auth/otp/start", { email }, "/auth/otp/start"), `otp start ${email}`);
  let code;
  for (let i = 0; i < 60 && code === undefined; i++) {
    const fresh = mailIds(email).find((id) => !before.has(id));
    if (fresh !== undefined) code = codeFrom(fresh);
    if (code === undefined) sleep(0.5);
  }
  if (code === undefined) throw new Error(`no sign-in code for ${email} in Mailpit`);
  const verify = post(undefined, "/auth/otp/verify", { email, code }, "/auth/otp/verify");
  ok(verify, `otp verify ${email}`);
  const cookie = cookieHeader(verify);
  if (!cookie.includes("sid=")) throw new Error(`no session cookie for ${email}`);
  return { email, cookie };
}

/*
 * Owners and admins need auth level 2 on every staff route (ADR-0014 §6.2), and a seed-demo owner
 * has no second factor. The first run enrols TOTP over the API and logs the secret; pass it back
 * as OWNER_TOTP_SECRET on later runs against the same stack (the enrolment cannot be repeated).
 */
export function stepUpOwner(owner) {
  let secret = OWNER_TOTP_SECRET;
  let used;
  if (!secret) {
    const enrol = post(owner, "/auth/totp/enrol", {}, "/auth/totp/enrol");
    if (enrol.status >= 300) {
      throw new Error(
        `TOTP enrolment refused (${enrol.status}); the owner already has one — pass -e OWNER_TOTP_SECRET=<secret from the first run>: ${enrol.body}`,
      );
    }
    secret = enrol.json().secretBase32;
    used = totpCode(secret);
    ok(
      post(owner, "/auth/totp/enrol/confirm", { code: used }, "/auth/totp/enrol/confirm"),
      "totp confirm",
    );
    console.warn(`enrolled owner TOTP; reuse with -e OWNER_TOTP_SECRET=${secret}`);
  }
  const code = freshTotpCode(secret, used);
  ok(post(owner, "/auth/totp/verify", { code }, "/auth/totp/verify"), "totp step-up");
  return owner;
}
