/*
 * FundRoom path mount — Next.js request headers for the rewrites in `next.config.mjs`.
 *
 * A rewrite alone cannot add request headers, and the portal needs two: `X-Forwarded-Prefix`
 * (which mount this is) and `X-Forwarded-Host` (your site's host, not the portal's). This proxy
 * (Next.js 16's name for middleware) adds them on the mount's paths only.
 */
import { NextResponse } from "next/server";

export function proxy(request) {
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-prefix", "/investors");
  headers.set("x-forwarded-host", request.headers.get("host") ?? request.nextUrl.host);
  headers.set("x-forwarded-proto", "https");
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/investors", "/investors/:path*"],
};
