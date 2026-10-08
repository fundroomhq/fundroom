/*
 * The snippet from `docs/embed/quickstart.md`, moved into a file because `hostile.html` sends a
 * CSP with no `'unsafe-inline'` in `script-src`. Same call, same options; only the delivery
 * differs — which is itself the documented answer for a host page with a strict policy.
 */
SeedHost.init({
  workspace: "acme-inc",
  baseUrl: "https://portal.test",
  el: "#investors",
});
