---
"@fundroomhq/ui": minor
"@fundroom/web": minor
"@fundroom/server": minor
---

Add the design system and the web app shell. `@fundroomhq/ui` ships DTCG tokens rendered to `--sh-*` custom properties, a Tailwind v4 theme that maps shadcn variable names onto them, light/dark/system theming, shadcn-style React 19 components (buttons, forms, OTP input, cards, alerts, dialogs, menus, tabs, tables, toasts, layout shell, empty/error/loading states), a runtime theming API (`@fundroomhq/ui/theme`) and Storybook with the axe addon. `@fundroom/web` is the Vite + React 19 + TanStack Router SPA: investor, admin and embed route trees driven by the `/api/v1/modules` bootstrap, sign-in with email code, magic link, passkeys (including conditional UI), password and OIDC, step-up, invite landing, session/device/passkey/TOTP/password settings, the embed cookie probe and postMessage bridge, Paraglide i18n (`en`). `@fundroom/server` now serves the built SPA from `WEB_DIST_PATH` as a per-request template: CSP nonce substitution, base-path URL rewriting, and an injected `seed-host:config` meta carrying the router base, API base, route tree, workspace and auth methods.
