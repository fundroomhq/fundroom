import { createHmac } from "node:crypto";

/*
 * Facts about the CI stack (deploy/compose/compose.ci.yaml). The token and addresses are
 * fixtures, not secrets: the stack is thrown away after every run.
 */
export const SETUP_TOKEN = process.env["E2E_SETUP_TOKEN"] ?? "e2e-setup-token-0123456789";
export const MAILPIT_URL = process.env["E2E_MAILPIT_URL"] ?? "http://localhost:8025";

export const OWNER = {
  name: "Sam Founder",
  email: "sam@example.com",
  workspace: "Acme Inc.",
  slug: "acme-inc",
} as const;

interface MailpitMessage {
  readonly ID: string;
  readonly To: readonly { readonly Address: string }[];
  readonly Subject: string;
  readonly Created: string;
}

/** Newest message to `to` (subject match optional), polling Mailpit's API. */
export async function waitForMail(
  to: string,
  options: { subject?: RegExp; timeoutMs?: number; after?: Date } = {},
): Promise<{ id: string; subject: string; text: string }> {
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  for (;;) {
    const res = await fetch(`${MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`);
    if (res.ok) {
      const body = (await res.json()) as { messages: MailpitMessage[] };
      const match = body.messages.find(
        (msg) =>
          msg.To.some((t) => t.Address.toLowerCase() === to.toLowerCase()) &&
          (options.subject === undefined || options.subject.test(msg.Subject)) &&
          (options.after === undefined || new Date(msg.Created) >= options.after),
      );
      if (match) {
        const full = await fetch(`${MAILPIT_URL}/api/v1/message/${match.ID}`);
        const detail = (await full.json()) as { Text: string; Subject: string };
        return { id: match.ID, subject: detail.Subject, text: detail.Text };
      }
    }
    if (Date.now() > deadline) throw new Error(`no mail to ${to} within the timeout`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** The six-digit code the OTP email prints on its own indented line. */
export function codeFrom(text: string): string {
  const m = /^\s*(\d{6})\s*$/mu.exec(text);
  if (!m?.[1]) throw new Error(`no sign-in code in:\n${text}`);
  return m[1];
}

/*
 * RFC 6238 TOTP, six digits, SHA-1, a 30-second period — the parameters
 * `packages/identity/src/services/totp.ts` enrols with. Twenty lines of node:crypto rather than
 * a dependency: the e2e package deliberately has no workspace imports, so that it exercises the
 * built image the way a stranger's browser would, and a shared helper would blur that.
 */
function base32Decode(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let acc = 0;
  const out: number[] = [];
  for (const ch of value.replace(/=+$/u, "").toUpperCase()) {
    const index = alphabet.indexOf(ch);
    if (index < 0) continue;
    acc = (acc << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

export function totpCode(secretBase32: string, atMs: number = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const mac = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 1_000_000).padStart(6, "0");
}

/**
 * A code the server has not seen yet. TOTP verification refuses a replay inside the same
 * window, so a second step-up minutes later must not hand back the code enrolment consumed.
 */
export async function freshTotpCode(secretBase32: string, avoid?: string): Promise<string> {
  const deadline = Date.now() + 40_000;
  for (;;) {
    const code = totpCode(secretBase32);
    if (code !== avoid) return code;
    if (Date.now() > deadline) throw new Error("no fresh TOTP code within the window");
    await new Promise((r) => setTimeout(r, 1000));
  }
}
