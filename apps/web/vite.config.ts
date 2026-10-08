import { paraglideVitePlugin } from "@inlang/paraglide-js";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { renderBuiltAssetUrl } from "./src/lib/asset-urls.js";

/*
 * The SPA is served by the server's `web` role from `WEB_DIST_PATH` (ADR-0030):
 *  - `html.cspNonce` stamps `nonce="__CSP_NONCE__"` on every generated script/style tag; the
 *    server replaces the placeholder per request with the CSP nonce (strict-dynamic, no
 *    'unsafe-inline' for CSP3 browsers).
 *  - `base` stays `/`; the server rewrites index.html's root-relative asset URLs under the
 *    request's public base (BASE_PATH or a path mount, E3.9). Everything JS or CSS loads after
 *    that is file-relative (`renderBuiltAssetUrl`, src/lib/asset-urls.ts), so lazy chunks and
 *    their preloads follow whatever base the entry script was served under.
 *  - Route trees are code-split per route file (autoCodeSplitting), so the investor bundle
 *    never carries admin code.
 */
/*
 * Sonner (the toaster in @fundroomhq/ui) injects its stylesheet as a `<style>` element without a
 * nonce when its module is evaluated. The document CSP (`style-src 'self' 'nonce-…'`, no
 * 'unsafe-inline') refuses it — the "two violations per page load" E2.2 and E2.4 recorded — and
 * sonner has no option to turn it off. So the build makes `__insertCSS` a no-op and the same
 * CSS ships in the bundled stylesheet instead (`@import "sonner/dist/styles.css"` in
 * packages/ui/src/styles/index.css). A sonner release that renames the helper fails the build
 * here rather than quietly bringing the violation back (e2e/tests/40-csp.test.ts would catch it
 * too, but later).
 */
export function sonnerWithoutRuntimeCss(): Plugin {
  const helper = "function __insertCSS(code) {";
  return {
    name: "fundroom:sonner-without-runtime-css",
    enforce: "pre",
    transform(code, id) {
      if (!/[\\/]node_modules[\\/]sonner[\\/]dist[\\/]index\.m?js$/u.test(id)) return undefined;
      if (!code.includes(helper)) {
        throw new Error(`sonner no longer defines ${helper} — revisit sonnerWithoutRuntimeCss`);
      }
      return { code: code.replace(helper, `${helper} return;`), map: null };
    },
  };
}

export default defineConfig({
  plugins: [
    paraglideVitePlugin({
      project: "./project.inlang",
      outdir: "./src/paraglide",
      strategy: ["cookie", "preferredLanguage", "baseLocale"],
    }),
    tanstackRouter({ target: "react", autoCodeSplitting: true, routesDirectory: "./src/routes" }),
    react(),
    tailwindcss(),
    sonnerWithoutRuntimeCss(),
  ],
  html: { cspNonce: "__CSP_NONCE__" },
  experimental: { renderBuiltUrl: renderBuiltAssetUrl },
  build: {
    target: "es2022",
    // F-32 (ASVS 15.2.3): maps are written for error tooling but not referenced from the bundles
    // (no `sourceMappingURL`); the image deletes them and the server 404s any `/assets/*.map`.
    sourcemap: "hidden",
    rollupOptions: {
      output: {
        // Rolldown (Vite 8) takes the function form only.
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/u.test(id)) return "react";
          if (id.includes("@tanstack")) return "tanstack";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/.well-known": "http://127.0.0.1:3000",
    },
  },
});
