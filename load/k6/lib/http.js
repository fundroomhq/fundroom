import http from "k6/http";
import { HOST, PUBLIC_ORIGIN, TARGET_URL } from "./config.js";

/*
 * Thin wrappers over k6/http that add what the app needs on every request:
 *  - `Host`: the app resolves the workspace (and its canonical origin) from it;
 *  - `Origin` on unsafe methods: the CSRF check refuses a POST without a matching one;
 *  - the session cookie **as a header**. The cookie is `__Host-sid; Secure`, and k6's cookie jar,
 *    like a browser, will not send a Secure cookie over plain http — so it is never left to the
 *    jar (`jar: null` keeps the jar from adding a stale copy).
 * Every request is tagged `kind: read|write` (the §16 budgets differ) and `name` (a stable URL
 * pattern, so `/documents/<uuid>` does not explode k6's metric cardinality).
 */
const API = `${TARGET_URL}/api/v1`;

/*
 * `phase` tag: `setup` for sign-in and seeding (run from setup(), in its own VU, so this module
 * variable is set only there), `run` for the measured traffic. Thresholds select `phase:run`.
 */
let phase = "run";
export function setPhase(p) {
  phase = p;
}

function params(session, kind, name, extra) {
  const headers = { Host: HOST, Accept: "application/json" };
  if (session?.cookie) headers.Cookie = session.cookie;
  if (kind === "write") headers.Origin = PUBLIC_ORIGIN;
  return {
    headers: { ...headers, ...(extra?.headers || {}) },
    tags: { kind, name, phase, ...(extra?.tags || {}) },
    jar: null,
    redirects: 0,
    ...(extra?.responseType ? { responseType: extra.responseType } : {}),
    ...(extra?.responseCallback ? { responseCallback: extra.responseCallback } : {}),
  };
}

export function get(session, path, name, extra) {
  return http.get(`${API}${path}`, params(session, "read", name || path, extra));
}

export function post(session, path, body, name, extra) {
  const p = params(session, "write", name || path, extra);
  if (body !== undefined && typeof body !== "string" && !(body instanceof ArrayBuffer)) {
    p.headers["Content-Type"] = "application/json";
    return http.post(`${API}${path}`, JSON.stringify(body), p);
  }
  return http.post(`${API}${path}`, body === undefined ? null : body, p);
}

export function send(session, method, path, body, name, extra) {
  const p = params(session, "write", name || path, extra);
  let payload = body;
  if (body !== undefined && typeof body !== "string" && !(body instanceof ArrayBuffer)) {
    p.headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  return http.request(method, `${API}${path}`, payload === undefined ? null : payload, p);
}

/** JSON body of a 2xx response, or throws with the status and body (setup must fail loudly). */
export function ok(res, what) {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${what}: HTTP ${res.status} ${String(res.body).slice(0, 300)}`);
  }
  return res.body ? res.json() : undefined;
}

/** `name=value; name=value` from every Set-Cookie on a response. */
export function cookieHeader(res) {
  const out = [];
  for (const name of Object.keys(res.cookies)) {
    const c = res.cookies[name][0];
    if (c?.value) out.push(`${name}=${c.value}`);
  }
  return out.join("; ");
}
