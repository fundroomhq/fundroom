/*
 * Test support for the integration suites (not imported by the server).
 *
 * A step-up rotates the session token (F-12, ASVS 7.2.4): `POST /auth/totp/enrol/confirm`,
 * `/auth/totp/verify`, `/auth/totp/recovery`, `/auth/passkeys/step-up/finish` and
 * `/auth/password/reverify` answer with a new session `Set-Cookie`, and the cookie the request
 * carried stops working. A browser swaps it in by itself; a test that keeps a `Cookie` header in
 * a string has to do the same, which is all this does.
 */

/** Name → value of a `Cookie` request header. */
function parseCookieHeader(header: string): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of header.split(";")) {
    const pair = part.trim();
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    jar.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return jar;
}

/**
 * The `Cookie` header a browser would send after `res`: every cookie `res` sets replaces the one of
 * the same name, and a cookie it clears (`Max-Age=0` or an empty value) is dropped.
 */
export function withSetCookies(cookie: string, res: Response): string {
  const jar = parseCookieHeader(cookie);
  for (const line of res.headers.getSetCookie()) {
    const [pair = ""] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (value === "" || /;\s*max-age=0\b/iu.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

/** The response's session `Set-Cookie` line (any cookie recipe), if it set one. */
export function sessionSetCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => /^(?:__Host-|__Secure-)?sid=/u.test(c));
}
