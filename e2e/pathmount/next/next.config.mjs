/*
 * FundRoom path mount — Next.js, "preserve" shape. Pair with `proxy.js`.
 *
 * Serves the investor portal at https://<your site>/investors: both the bare path and everything
 * under it are rewritten to the portal, path unchanged. The portal runs with BASE_PATH=/investors
 * and lists https://<your site>/investors in PATH_MOUNTS. Replace portal.test with your portal's
 * host. Next.js forwards every cookie of your site to the portal: keep secrets out of Path=/
 * cookies on this site. (On Vercel the same two rules can live in vercel.json instead; the
 * headers still need `proxy.js`.)
 */
const PORTAL_ORIGIN = "https://portal.test";

/** @type {import("next").NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      { source: "/investors", destination: `${PORTAL_ORIGIN}/investors` },
      { source: "/investors/:path*", destination: `${PORTAL_ORIGIN}/investors/:path*` },
    ];
  },
};

export default nextConfig;
