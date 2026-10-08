/*
 * FundRoom path mount — Cloudflare Worker, "preserve" shape.
 *
 * Serves the investor portal at https://<your site>/investors. Deploy on a route that covers
 * your site (e.g. `www.acme.com/*`): /investors and /investors/* are proxied to the portal, every
 * other path goes to your origin untouched. The portal runs with BASE_PATH=/investors and lists
 * https://<your site>/investors in PATH_MOUNTS. Replace PORTAL_ORIGIN with your portal's origin.
 *
 * Only the portal's own cookies are forwarded: your site's cookies (analytics, CMS sessions)
 * never reach the portal, and the portal's cookies are scoped to Path=/investors so your site's
 * other pages never see them.
 */

const PORTAL_ORIGIN = "https://portal.test";
const PREFIX = "/investors";

/** The portal's cookie names (`__Host-`/`__Secure-` + basename). Nothing else is forwarded. */
const PORTAL_COOKIE = /^__(?:Host|Secure)-(?:sid|did|auth_req|oidc_req|sso_req|sh_intg)$/u;

/** Connection-level headers: meaningful for one hop only, never forwarded. */
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function portalCookies(header) {
  if (header === null) return "";
  return header
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => PORTAL_COOKIE.test(pair.slice(0, pair.indexOf("="))))
    .join("; ");
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== PREFIX && !url.pathname.startsWith(`${PREFIX}/`)) {
      return fetch(request); // not the portal: your site as usual
    }
    const site = `https://${url.host}`;

    const headers = new Headers(request.headers);
    for (const name of HOP_BY_HOP) headers.delete(name);
    headers.delete("host");
    const cookies = portalCookies(request.headers.get("cookie"));
    if (cookies === "") headers.delete("cookie");
    else headers.set("cookie", cookies);
    // The visitor's address, appended the way Cloudflare's own proxy does (CF-Connecting-IP is
    // the client; any X-Forwarded-For the visitor sent stays in front of it).
    const client = request.headers.get("cf-connecting-ip");
    if (client !== null) {
      const prior = request.headers.get("x-forwarded-for");
      headers.set("x-forwarded-for", prior === null ? client : `${prior}, ${client}`);
    }
    headers.set("x-forwarded-host", url.host);
    headers.set("x-forwarded-proto", "https");
    headers.set("x-forwarded-prefix", PREFIX);

    const upstream = await fetch(`${PORTAL_ORIGIN}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });

    const response = new Response(upstream.body, upstream);
    // Transport policy is your site's, not the portal's: never let the portal's HSTS (which could
    // carry includeSubDomains/preload) or its HTTP/3 advertisement speak for your origin.
    response.headers.delete("strict-transport-security");
    response.headers.delete("alt-svc");
    // An absolute redirect to the portal's own host comes back onto this site.
    const location = response.headers.get("location");
    if (location?.startsWith(`${PORTAL_ORIGIN}${PREFIX}`)) {
      response.headers.set("location", site + location.slice(PORTAL_ORIGIN.length));
    }
    return response;
  },
};
