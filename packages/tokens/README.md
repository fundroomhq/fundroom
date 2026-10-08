# @fundroomhq/tokens

FundRoom's design tokens: one [W3C Design Tokens (DTCG)](https://www.designtokens.org/) document
and the CSS custom properties generated from it. `@fundroomhq/ui` builds its Tailwind v4 theme on
these; anything else that wants to look like FundRoom (the marketing site, an email template, a
host page around the embed) can use them without React or Tailwind.

```
fundroom.tokens.json   color.light / color.dark (the two palettes); font, radius, density,
        │              shadow (mode-independent)
        ▼  pnpm --filter @fundroomhq/tokens codegen   (scripts/build-tokens.mjs)
tokens.css             --sh-color-primary, --sh-font-sans, --sh-radius-base, …
```

## Using the published package

```sh
npm install @fundroomhq/tokens
```

```css
@import "@fundroomhq/tokens/tokens.css";

.callout {
  background: var(--sh-color-primary);
  color: var(--sh-color-primary-fg);
  border-radius: var(--sh-radius-base);
}
```

| Export | File |
|---|---|
| `@fundroomhq/tokens/tokens.css` | the custom properties |
| `@fundroomhq/tokens/tokens.json` | the DTCG document (`fundroom.tokens.json`) |

Every token is a `--sh-<group>-<path>` custom property. `:root` carries the light palette and
everything mode-independent; the dark palette applies under a `.dark` class anywhere above, and
under `prefers-color-scheme: dark` unless a `.light` class says otherwise
(`:root:not(.light)`). A FundRoom workspace brand overrides the same names at runtime, so read
them through `var(...)`, never copy the values.

The file has no `@layer`, no fonts and no `url()`, so it works under a strict CSP and in any build
(or none). The tarball is exactly `package.json`, `tokens.css`, `fundroom.tokens.json`,
`README.md` and `LICENSE`; `scripts/release/pack-check.mjs` in the repository enforces that.

## Versions

Published from the product's `Release` workflow at the product release version (it is in the
core fixed group), with npm provenance: `next` for release candidates, `latest` for stable
releases. A token change is a product change and goes in with a changeset like any other
(`docs/runbooks/releasing.md`).

## In the monorepo

Edit `fundroom.tokens.json`, run `pnpm --filter @fundroomhq/tokens codegen` and then
`pnpm --filter @fundroomhq/ui codegen` (ui keeps a copy of the JSON for `DEFAULT_TOKENS`); commit
all three. CI's `codegen:check` steps fail when either output is stale, and `prepack` refuses
to pack a stale `tokens.css`.

## License

MIT
