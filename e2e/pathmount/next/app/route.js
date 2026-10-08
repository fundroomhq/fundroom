// next.test — the marketing page (harness only, not part of the recipe). A route handler rather
// than a page so it can set a Path=/ cookie: the spec checks what the recipe forwards to the portal.
export const dynamic = "force-dynamic";

const PAGE =
  '<!doctype html><html lang="en"><title>Acme (Next.js)</title><h1>Acme, served by Next.js</h1><p><a href="/investors/">Investor portal</a></p></html>';

export function GET() {
  return new Response(PAGE, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "set-cookie": "host_session=next-secret; Path=/; Secure; HttpOnly; SameSite=Lax",
    },
  });
}
