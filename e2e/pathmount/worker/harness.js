/*
 * worker.test — the customer's site. Harness only, never documented.
 *
 * On Cloudflare the recipe's `fetch(request)` fallthrough reaches the site's origin; here there
 * is no origin, so this wrapper answers `/` with the marketing page (which sets a Path=/ cookie
 * the recipe must *not* forward) and hands every other request to the recipe module unchanged.
 */
import recipe from "./seed-host-mount.js";

const PAGE =
  '<!doctype html><html lang="en"><title>Acme (Worker)</title><h1>Acme, served by a Worker</h1><p><a href="/investors/">Investor portal</a></p></html>';

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === "/") {
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "set-cookie": "host_session=worker-secret; Path=/; Secure; HttpOnly; SameSite=Lax",
        },
      });
    }
    if (pathname === "/favicon.ico") return new Response(null, { status: 404 });
    return await recipe.fetch(request, env, ctx);
  },
};
