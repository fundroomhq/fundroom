# @fundroomhq/ui

The design system: DTCG tokens rendered to CSS
custom properties, a Tailwind v4 theme that aliases them, shadcn-style React 19 components on
Radix primitives, light/dark/system theming, and Storybook with axe on every story.

## Token pipeline

```
@fundroomhq/tokens (packages/tokens)
  fundroom.tokens.json  W3C Design Tokens (DTCG). color.light / color.dark are the two
        │               palettes; font, radius, density, shadow are mode-independent.
        ▼  pnpm --filter @fundroomhq/tokens codegen  (`codegen:check` fails CI when stale)
  tokens.css            --sh-color-primary, --sh-font-sans, --sh-radius-base, …
        ▼  @import "@fundroomhq/tokens/tokens.css"
src/styles/index.css           @theme inline { --color-primary: var(--sh-color-primary); … }
                               so `bg-primary`, `rounded-lg`, `font-sans` follow the workspace
                               theme at runtime; also the `.dark` variant and base styles.
src/theme/default-tokens.json  copy of the DTCG document, consumed by DEFAULT_TOKENS in
                               @fundroomhq/ui/theme (`pnpm --filter @fundroomhq/ui codegen`)
```

Every token is a `--sh-<group>-<path>` custom property. The workspace brand (derived by
`@fundroom/branding`, kernel rather than a module, like `access` and
`compliance`) and host-posted tokens (embed) override the same names; components never
hard-code colours.

## Using it from an app in this repo

```css
/* app.css */
@import "@fundroomhq/ui/styles.css";
@source "../../../packages/ui/src";   /* let Tailwind see the component classes */
@source "./";                          /* and your own */
```

```tsx
import { Button, Field, Input, ThemeProvider, Toaster } from "@fundroomhq/ui";

<ThemeProvider defaultTheme="system">
  <Toaster />
  …
</ThemeProvider>
```

## Using the published package

`@fundroomhq/ui` and `@fundroomhq/tokens` are published to npm from the product's `Release`
workflow, at the product release version, with npm provenance (`next` for release candidates,
`latest` for stable releases).

```sh
npm install @fundroomhq/ui react react-dom tailwindcss @tailwindcss/vite
```

- **Peer dependencies:** `react` and `react-dom` 19, and **Tailwind CSS v4** (`tailwindcss`
  `^4`). The stylesheet is Tailwind v4 source (`@import "tailwindcss"`, `@theme inline`,
  `@custom-variant`, `@source`), not prebuilt CSS, so it must go through Tailwind v4: the Vite
  plugin (`@tailwindcss/vite`) or `@tailwindcss/postcss`. Tailwind v3 cannot read it.
- `@fundroomhq/tokens`, `tw-animate-css` and sonner's stylesheet come in as dependencies.

```css
/* src/app.css — import it once */
@import "@fundroomhq/ui/styles.css";
@source "./";   /* your own classes */
```

The published `styles.css` already declares `@source` for the compiled components next to it
(`node_modules/@fundroomhq/ui/dist`), so the classes Button, Dialog & co. use are generated even
though Tailwind skips `node_modules` when it detects sources on its own. If you build your own
entry instead of importing `styles.css` (say, only the tokens and your utilities), point Tailwind
at the components yourself, relative to your CSS file:

```css
@import "tailwindcss";
@import "@fundroomhq/tokens/tokens.css";
@source "../node_modules/@fundroomhq/ui/dist";
```

| Export | What |
|---|---|
| `@fundroomhq/ui` | the components (ESM, with `.d.ts`) |
| `@fundroomhq/ui/theme` | `applyThemeTokens`, `dtcgToTokens`, `tokensToCss`, `DEFAULT_TOKENS`, … |
| `@fundroomhq/ui/styles.css` | the Tailwind v4 stylesheet (tokens, theme aliases, base styles) |
| `@fundroomhq/ui/tokens.css` | the same file as `@fundroomhq/tokens/tokens.css` |
| `@fundroomhq/ui/tokens.json` | the same document as `@fundroomhq/tokens/tokens.json` |

The tarball is `dist/` only (no sources, tests, stories or source maps); `pnpm
packages:pack-check` packs it, checks that, and builds a Vite + Tailwind v4 + React 19 page from
the two tarballs. In this repo `./styles.css` resolves to `src/styles/index.css`;
`publishConfig.exports` points the published one at `dist/styles/index.css`, a copy whose
`@source` names `dist/` instead of `src/components` (`scripts/build-styles.mjs`).

Components take every visible string as a prop (`skipToContentLabel`, `closeLabel`, `labels`)
— the package carries no i18n; the app passes Paraglide messages.

## Dark mode contract

- `ThemeProvider` sets `.light` or `.dark` on `<html>` (never both) and persists the choice
  under `seed-host:theme` (storage access is guarded; blocked storage just loses persistence).
- `system` removes both classes; `tokens.css` then applies the dark palette under
  `prefers-color-scheme: dark` (guarded by `:root:not(.light)`).
- `forcedTheme` pins the theme, e.g. from a host page's `color-scheme` token in embed mode.
- Storybook's toolbar toggles the same classes, so stories render exactly as the app.

## Embed constraints

Nothing here uses `position: fixed` or `100vh`: dialog overlays are `absolute` inside the
`relative` `AppShell`, toasts are top-centre, and `AppShell fullHeight={false}` drops the
`min-h-dvh` for iframes so the host's `ResizeObserver` measures real content height.

## Runtime theming (`@fundroomhq/ui/theme`)

```ts
import { applyThemeTokens, clearThemeTokens, DEFAULT_TOKENS, dtcgToTokens, tokensToCss } from "@fundroomhq/ui/theme";

const tokens = config.branding?.tokens[resolvedTheme] ?? {}; // the derived --sh-* map
applyThemeTokens(tokens);                                    // inline on <html>, resolved mode only
tokensToCss(tokens, ".embed");                               // for server-rendered CSS
dtcgToTokens(themeDocument, resolvedTheme);                  // flatten a DTCG doc you were handed
```

The map comes from `@fundroom/branding` (see `apps/web/src/lib/brand-theme.tsx`, which applies
the resolved mode's map in a layout effect so the first paint is already branded — the server
injects both palettes into the page config). The DTCG document is the other direction: an output
served by `GET /branding/theme`, for a consumer that has to merge it over the defaults itself.

Names must match `--sh-[a-z0-9-]+` and values may not contain `;`, `}`, `<`, `url(` or
`expression(`; anything else is skipped, so no token map can inject CSS. That allow-list is not
what keeps a portal legible, though — it would happily set the foreground to the background,
which is why the tokens are derived rather than stored.

## Components

Button, Input, Textarea, Label, Checkbox, Switch, Select, Field (+ `fieldAria`), InputOTP,
Card, Alert, Badge, Skeleton, Separator, Spinner, VisuallyHidden, Dialog, DropdownMenu, Tabs,
Tooltip, Avatar, Table, Toaster/`toast`, EmptyState, ErrorState, LoadingState, PageHeader,
AppShell (+ Sidebar/Header, NavList), ThemeProvider/`useTheme`, ThemeToggle.

### Adding one

1. `src/components/<name>.tsx` — a function component with `data-slot`, `cn(...)`, cva for
   variants, Radix via `import { X as XPrimitive } from "radix-ui"`. Relative imports end in
   `.js`.
2. Export it from `src/index.ts`.
3. `<name>.stories.tsx` (CSF3) and `<name>.test.tsx` (Testing Library +
   `expectNoA11yViolations` from `src/test/a11y.ts`).

## Storybook and accessibility

`pnpm storybook` (dev) / `pnpm storybook:build`. `@storybook/addon-a11y` runs axe on every
story with `test: "error"`, so a violation fails the story. Unit tests run axe through
`axe-core` in jsdom (colour-contrast off there — no layout engine; Storybook and the Playwright
run cover it). `pnpm test` runs the `ui` Vitest project.
