# @fundroom/web

The FundRoom SPA: Vite 8 + React 19 + TanStack Router (file routes, per-route code splitting)
+ TanStack Query, components from `@fundroomhq/ui`, network layer `@fundroom/sdk`, messages
compiled by Paraglide. It is served by `@fundroom/server`'s `web` role from `WEB_DIST_PATH`; it never talks to anything but `/api/v1` on its own origin.

## How the page boots

1. The server renders `dist/index.html` per request: the CSP nonce replaces `__CSP_NONCE__`
   on every script/style tag (Vite `html.cspNonce`), root-relative asset URLs are rewritten
   under `BASE_PATH`, and a `<meta name="seed-host:config">` carries the runtime config.
2. `src/lib/config.ts` (`readWebConfig`, `WebConfigSchema`) parses that meta:
   `routerBase` (→ router `basepath`), `apiBase` (→ SDK origin), `tree` (`app` | `admin` |
   `embed`), `workspace`, `branding` (name, tagline, logo URL and the derived `--sh-*` tokens
   for both palettes, applied before the first paint by `src/lib/brand-theme.tsx`),
   `canonicalOrigin`, `embedOrigins`, `auth.methods`, `setupRequired`.
   Without the meta (Vite dev server) it falls back to same-origin defaults and the capability
   document at `/.well-known/fundroom.json`.
3. `src/main.tsx` builds the router (`src/router.tsx`, context = config + `QueryClient`) and
   mounts `src/app.tsx` (providers: config, query, theme, tooltip, toaster).
4. `GET /api/v1/modules` (`useBootstrap`) and `GET /api/v1/me` (`useMe`) in `src/lib/queries.ts`
   decide what renders: enabled modules, nav slots (`investor.nav`, `admin.nav`), the caller's
   membership and permissions. A 401 on `/me` means "signed out", never an error.

## Route trees (`src/routes/`)

| Tree | Files | Notes |
|---|---|---|
| Auth (signed out) | `_auth.tsx`, `_auth/login/index.tsx`, `_auth/login/verify.tsx`, `_auth/auth/magic-link.tsx`, `_auth/auth/step-up.tsx`, `_auth/auth/popup.tsx`, `_auth/invite/$token.tsx`, `_auth/unsubscribe.tsx` | Email code, magic link (POST-to-confirm, never on GET), passkeys incl. conditional UI, password and OIDC when the server lists them; step-up for `step_up_required`; popup mode posts `{v:1,type:"auth"}` to its opener; `unsubscribe` takes the signed token from an update email's footer and needs no sign-in |
| Investor | `_portal.tsx`, `_portal/index.tsx`, `_portal/p/$slug.tsx`, `_portal/settings.tsx`, `_portal/settings/index.tsx`, `_portal/settings/security.tsx`, `_portal/$.tsx` | Signed out → `/login?returnTo=…`; no live membership → "no access" (no oracle); `p/$slug` is a published custom content page; security = sessions, devices, passkeys, TOTP (QR + recovery codes shown once), password |
| Admin | `admin.tsx`, `admin/index.tsx`, `admin/branding/index.tsx`, `admin/modules/index.tsx`, `admin/people/index.tsx`, `admin/people/$membershipId.tsx`, `admin/groups/index.tsx`, `admin/groups/$groupId.tsx`, `admin/legal/index.tsx`, `admin/legal/$documentId.tsx`, `admin/$.tsx` | Staff membership required, otherwise the generic not-found; refused inside an embed with a link to `${canonicalOrigin}/admin`. These are the kernel screens; a module's admin screens come from its own bundle through `$.tsx` |
| Setup | `setup.tsx` | The first-run wizard, shown while `setupRequired`. The step lives in the URL (`/setup?step=…`) and a cold load resumes at the first step `GET /setup/status`'s `progress` says is unfinished — there is no wizard-state table |

The same investor routes render under all three router bases (`/`, `/w/<slug>`,
`/embed/<slug>`); the embed tree additionally wraps everything in `src/embed/EmbedFrame.tsx`:
cookie probe (`SameSite=None; Secure; Partitioned` set-then-read; failure → "Open in a new
tab" on the canonical origin), the postMessage bridge (`src/embed/bridge.ts`: `ready`,
`resize`, `navigate`, `auth` out; `theme`, `navigate` in; origins pinned to `embedOrigins`,
never `*`), compact density, no full-height shell.

`$.tsx` catch-alls resolve the first path segment against enabled, non-hidden modules from
the bootstrap and `src/modules/registry.ts` (module id → lazy component; empty until Phase 1).
Enabled with no client bundle → an explicit empty state; not a module → not-found.

## Errors and auth edge cases

`src/lib/api.ts` wraps the SDK client (`X-Request-Id` per call), `describeError()` turns the
error envelope into a title/body/request id, and `use-guarded-mutation.ts` routes
`unauthenticated` to the login page and `step_up_required` (`reason: level | fresh`) to
`/auth/step-up?returnTo=…` from any mutation. Rate limits show the `Retry-After` seconds.

## Develop

```sh
# terminal 1: the API on :3000 (accept the Vite origin for the CSRF check)
CORS_ALLOWED_ORIGINS=http://localhost:5173 pnpm --filter @fundroom/server dev
# terminal 2: the SPA on :5173, proxying /api and /.well-known
pnpm --filter @fundroom/web dev
# or serve the production build through the server
pnpm --filter @fundroom/web build && WEB_DIST_PATH=$PWD/apps/web/dist pnpm --filter @fundroom/server start
```

- `pnpm --filter @fundroom/web codegen` compiles `messages/*.json` to `src/paraglide/`
  (gitignored) and regenerates `src/routeTree.gen.ts` (committed; CI fails when stale).
  `build` and the root `typecheck` run it first.
- Messages: add a key to `messages/en.json` (snake_case, prefixed by screen), use it as
  `m.key({ param })` from `./paraglide/messages.js`. Components in `@fundroomhq/ui` take
  strings as props; nothing in the design system imports Paraglide.
- Tests: `pnpm --filter @fundroom/web test` (Vitest project `web`, jsdom). Screens render
  through `src/test/render.tsx` against `src/test/mock-api.ts`; every screen test runs axe
  (`src/test/a11y.ts`, WCAG 2.2 AA tags, contrast excluded in jsdom).
- Budget: initial JS per tree < 180 KB gz. Check `vite build` output; the investor entry
  is currently ≈ 146 KB gz (react 68, tanstack 36, index 30, preload helper 12).
  `@simplewebauthn/browser` and `qrcode` load lazily.
