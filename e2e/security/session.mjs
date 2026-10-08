#!/usr/bin/env node
/*
 * Sign in to a throwaway FundRoom stack through the public API and print session cookies for a
 * DAST scanner (`.github/workflows/zap.yml`). Plain node (>= 20), no dependencies: like the rest
 * of e2e/, it talks to the built image the way a stranger's client would.
 *
 *   node e2e/security/session.mjs --url http://localhost:3400 --mailpit http://localhost:8425
 *
 * What it does, per role:
 *   owner     POST /auth/otp/start → code from Mailpit → POST /auth/otp/verify (level 1). Then
 *             level 2, because every owner route needs it: with --totp-secret, POST /auth/totp/verify;
 *             otherwise (a `seed-demo` owner has no second factor) enrol one through the API —
 *             POST /auth/totp/enrol (allowed on the fresh level-1 session) + /enrol/confirm, which
 *             steps the session up — and print the new secret so a later step-up can reuse it.
 *   investor  the first active investor from GET /access/people (as the owner), or --investor;
 *             email code only (level 1 is all an investor needs).
 *
 * Output (stdout), one KEY=value per line — append it to $GITHUB_ENV or `eval` it:
 *   OWNER_COOKIE=__Host-sid=…        (the value for a `Cookie:` request header)
 *   OWNER_TOTP_SECRET=…
 *   INVESTOR_EMAIL=…
 *   INVESTOR_COOKIE=__Host-sid=…
 * `--format json` prints one JSON object instead. Progress goes to stderr.
 *
 * `--populate` (as the owner, after step-up) gives the crawler objects to find: the "seed" data-room
 * folder template, one update draft and one content page (CRM is off by default, so not seeded). `seed-demo` is
 * kernel-only (people, no module data), and an authenticated crawl of empty lists finds little.
 * Each call is best-effort: a failure is logged, not fatal.
 *
 * `--check "<cookie>"` only asks GET /me with that cookie and exits 0 if the session is alive —
 * used after a scan to prove the crawl stayed authenticated (a spider that clicks "Sign out"
 * would silently turn an authenticated scan into an anonymous one).
 *
 * The Origin header on unsafe requests is the connect URL's own origin: CSRF compares Origin with
 * the request's Host, so the stack's BASE_URL may differ (compose.zap.yaml sets http://app:3000
 * for the in-network scanner while this script connects through the published port).
 */
import { createHmac } from "node:crypto";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    url: { type: "string", default: process.env.ZAP_APP_URL ?? "http://localhost:3400" },
    mailpit: { type: "string", default: process.env.ZAP_MAILPIT_URL ?? "http://localhost:8425" },
    owner: { type: "string", default: "founder@example.com" },
    "totp-secret": { type: "string" },
    investor: { type: "string" },
    "no-investor": { type: "boolean", default: false },
    format: { type: "string", default: "env" },
    check: { type: "string" },
    populate: { type: "boolean", default: false },
  },
});

const APP = opt.url.replace(/\/+$/u, "");
const API = `${APP}/api/v1`;
const ORIGIN = new URL(APP).origin;
const log = (msg) => process.stderr.write(`[session] ${msg}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, { body, cookie } = {}) {
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") headers.origin = ORIGIN;
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { res, json, text };
}

function expectOk(r, what) {
  if (!r.res.ok) throw new Error(`${what}: HTTP ${r.res.status} ${r.text.slice(0, 300)}`);
  return r;
}

/** The session cookie from a login response, as `name=value` for a Cookie header. */
function sessionCookie(res) {
  const all = res.headers.getSetCookie?.() ?? [];
  const sid = all.map((c) => c.split(";")[0]).find((c) => /^(?:__Host-|__Secure-)?sid=/u.test(c));
  if (!sid) throw new Error(`no session cookie in: ${JSON.stringify(all)}`);
  return sid;
}

/** Newest sign-in code mailed to `to` after `after`, via Mailpit's search + message APIs. */
async function codeFor(to, after) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const q = encodeURIComponent(`to:${to}`);
    const res = await fetch(`${opt.mailpit}/api/v1/search?query=${q}`);
    if (res.ok) {
      const { messages = [] } = await res.json();
      const hit = messages.find(
        (m) =>
          m.To?.some((t) => t.Address.toLowerCase() === to.toLowerCase()) &&
          /code/iu.test(m.Subject ?? "") &&
          new Date(m.Created) >= after,
      );
      if (hit) {
        const detail = await (await fetch(`${opt.mailpit}/api/v1/message/${hit.ID}`)).json();
        const m = /^\s*(\d{6})\s*$/mu.exec(detail.Text ?? "");
        if (!m) throw new Error(`no six-digit code in the mail to ${to}`);
        return m[1];
      }
    }
    if (Date.now() > deadline) throw new Error(`no sign-in code for ${to} within 30 s`);
    await sleep(500);
  }
}

async function emailLogin(email) {
  const after = new Date(Date.now() - 2000);
  expectOk(await api("POST", "/auth/otp/start", { body: { email } }), `otp/start ${email}`);
  const code = await codeFor(email, after);
  const r = expectOk(
    await api("POST", "/auth/otp/verify", { body: { email, code } }),
    `otp/verify ${email}`,
  );
  log(`${email}: signed in (email code, level 1)`);
  return sessionCookie(r.res);
}

/* RFC 6238 (SHA-1, 6 digits, 30 s) — same parameters and code as e2e/fixtures/stack.ts. */
function base32Decode(value) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let acc = 0;
  const out = [];
  for (const ch of value.replace(/=+$/u, "").toUpperCase()) {
    const i = alphabet.indexOf(ch);
    if (i < 0) continue;
    acc = (acc << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function totpCode(secret, atMs = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 30_000)));
  const mac = createHmac("sha1", base32Decode(secret)).update(counter).digest();
  const o = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[o] & 0x7f) << 24) | (mac[o + 1] << 16) | (mac[o + 2] << 8) | (mac[o + 3] ?? 0);
  return String(bin % 1_000_000).padStart(6, "0");
}

async function ownerSession() {
  const cookie = await emailLogin(opt.owner);
  let secret = opt["totp-secret"];
  if (secret) {
    expectOk(
      await api("POST", "/auth/totp/verify", { body: { code: totpCode(secret) }, cookie }),
      "totp/verify",
    );
    log(`${opt.owner}: stepped up with the given TOTP secret (level 2)`);
  } else {
    const enrol = expectOk(await api("POST", "/auth/totp/enrol", { cookie }), "totp/enrol");
    secret = enrol.json.secretBase32;
    expectOk(
      await api("POST", "/auth/totp/enrol/confirm", { body: { code: totpCode(secret) }, cookie }),
      "totp/enrol/confirm",
    );
    log(`${opt.owner}: enrolled TOTP through the API and stepped up (level 2)`);
  }
  const me = expectOk(await api("GET", "/me", { cookie }), "GET /me as owner");
  log(`owner /me: ${JSON.stringify(me.json).slice(0, 200)}`);
  return { cookie, secret };
}

async function populate(cookie) {
  const calls = [
    ["POST", "/data-room/templates/seed/apply", {}],
    ["POST", "/updates/posts", { title: "DAST scan update", template: "minimal" }],
    ["POST", "/content/pages", { slug: "dast-scan", title: "DAST scan page" }],
  ];
  for (const [method, path, body] of calls) {
    const r = await api(method, path, { body, cookie });
    log(
      `populate ${method} ${path} → ${r.res.status}${r.res.ok ? "" : ` ${r.text.slice(0, 160)}`}`,
    );
  }
}

async function pickInvestor(ownerCookie) {
  if (opt.investor) return opt.investor;
  const r = expectOk(await api("GET", "/access/people", { cookie: ownerCookie }), "access/people");
  const rows = r.json?.items ?? r.json?.people ?? r.json?.data ?? r.json ?? [];
  const hit = (Array.isArray(rows) ? rows : []).find(
    (p) => (p.role === "investor" || p.kind === "external") && p.status !== "invited" && p.email,
  );
  if (!hit) throw new Error(`no active investor in /access/people: ${r.text.slice(0, 300)}`);
  return hit.email;
}

async function main() {
  if (opt.check !== undefined) {
    const r = await api("GET", "/me", { cookie: opt.check });
    log(`GET /me → ${r.res.status}`);
    return r.res.ok ? 0 : 1;
  }
  const owner = await ownerSession();
  const out = { OWNER_COOKIE: owner.cookie, OWNER_TOTP_SECRET: owner.secret };
  if (opt.populate) await populate(owner.cookie);
  if (!opt["no-investor"]) {
    const email = await pickInvestor(owner.cookie);
    out.INVESTOR_EMAIL = email;
    out.INVESTOR_COOKIE = await emailLogin(email);
    expectOk(await api("GET", "/me", { cookie: out.INVESTOR_COOKIE }), "GET /me as investor");
  }
  if (opt.format === "json") {
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } else {
    for (const [k, v] of Object.entries(out)) process.stdout.write(`${k}=${v}\n`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
