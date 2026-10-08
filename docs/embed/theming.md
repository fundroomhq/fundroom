# Theming the embed

The frame is a different origin, so it cannot inherit the host page's CSS, fonts or cascade — that isolation is the point of the architecture, not a gap in it. What crosses the boundary instead is a small, flat set of design tokens.

Expect the embed to be a *coordinated* surface rather than an invisible one. On a strongly branded site it will read as a distinct panel, and the honest way to design around that is to give it a container that looks deliberate rather than trying to make the seam disappear.

## The token model

Tokens are CSS custom properties, all prefixed `--sh-`, consumed by every component in the app. The workspace's brand is stored and served in [W3C Design Tokens (DTCG)](https://tr.designtokens.org/format/) format; the host page supplies overrides as plain `name: value` pairs.

The ones a workspace brand sets today:

| Token | What it colours |
|---|---|
| `--sh-color-primary` | Primary actions and emphasis |
| `--sh-color-primary-fg` | Text and icons on top of `primary` |
| `--sh-color-ring` | Focus rings |
| `--sh-color-accent` | Accent surfaces |
| `--sh-color-accent-fg` | Text on accent surfaces |
| `--sh-color-sidebar-accent` | Accent inside the navigation |
| `--sh-color-sidebar-accent-fg` | Text on it |
| `--sh-color-chart-1` | The first series in any chart |
| `--sh-font-sans` | The sans-serif stack |
| `--sh-radius-base` | Corner radius everywhere |

Colour values are CSS colours; `--sh-font-sans` is a full font stack; `--sh-radius-base` is a length.

**Fonts are the limit case.** You can name any stack you like, but the frame can only *render* a font it can actually fetch — a system font, a public web font, or a font file whose server allows the portal origin via CORS. A self-hosted font on `acme.com` with no CORS headers will not load in the frame, and the stack falls back. Name a system fallback you are happy with rather than discovering which one you got.

The embed also runs at a slightly compact density (`--sh-density-base: 0.875`) automatically, because an embed is usually a panel inside a page rather than a full screen.

## Precedence

Highest wins:

1. **`init({ theme })`** — what the snippet sets for this placement.
2. **Tokens posted by the host page** — `portal.setTheme(tokens)`, later.
3. **The workspace theme** — what the founder set in the branding screen.
4. **Defaults** — the product's own palette.

The mechanism behind (1) and (2) is a single `theme` bridge message; the frame remembers which token names the host has claimed, so a later theme change on our side cannot put the workspace brand back on top of a name the host set. The practical rule: **once the host names a token, it owns it for the life of the frame.** To hand a token back to the workspace brand, reload the frame; there is no "unset" value.

Only the names you send are affected. Sending `{"--sh-color-primary": "#0b5"}` overrides exactly one token and leaves the rest of the workspace brand intact — which is usually what you want, and much better than shipping a whole palette that drifts from the site's.

```js
portal.setTheme({
  "--sh-color-primary": "#0b5cff",
  "--sh-color-primary-fg": "#ffffff",
  "--sh-radius-base": "0.25rem",
  "--sh-font-sans": "Inter, ui-sans-serif, system-ui, sans-serif",
});
```

## `/embed/<slug>/theme.json`

```
GET https://portal.example/embed/acme/theme.json
```

Public, cacheable for five minutes, `Access-Control-Allow-Origin: *`, no credentials, no secrets — it is brand tokens and nothing more. Fetch it if you want to *read* the workspace's brand: to match the surrounding page to the portal rather than the other way round, or to build a preview in a page builder.

The document is DTCG, with light and dark stated separately:

```json
{
  "$schema": "https://tr.designtokens.org/format/",
  "$description": "Workspace brand overrides; merge over the FundRoom default theme.",
  "color": {
    "$type": "color",
    "light": { "primary": { "$value": "#1d4ed8" }, "primary-fg": { "$value": "#ffffff" } },
    "dark":  { "primary": { "$value": "#93c5fd" }, "primary-fg": { "$value": "#0b1220" } }
  },
  "font":   { "$type": "fontFamily", "sans": { "$value": ["Inter", "system-ui", "sans-serif"] } },
  "radius": { "$type": "dimension", "base": { "$value": { "value": 0.5, "unit": "rem" } } }
}
```

Read it as *overrides*, not a complete theme. A group is absent when the workspace left that part of the brand at its default, so merge what is there over the defaults rather than expecting every key. The mapping to custom properties is the group path with `--sh-` in front: `color.light.primary` → `--sh-color-primary` in light mode, `font.sans` → `--sh-font-sans`, `radius.base` → `--sh-radius-base`.

## Dark mode

Colour scheme travels as a pseudo-token on the same `theme` message:

```js
portal.setTheme({ "--sh-color-scheme": "dark" });
```

| Value | Behaviour |
|---|---|
| `"light"` | Force light. |
| `"dark"` | Force dark. |
| `"auto"` | Follow the browser's `prefers-color-scheme`, evaluated inside the frame. |

It is a pseudo-token because it is not a CSS value the frame writes anywhere: it selects which of the two palettes in the theme document applies. Both palettes are always present, so the switch is instant and needs no fetch.

If your host page has its own dark-mode toggle, wire it to `setTheme` — do not rely on `"auto"` to agree with a manual toggle. `prefers-color-scheme` inside the frame reports the *operating system's* preference, which is exactly what your toggle exists to override.

## Layout constraints inside a frame

An iframe is a viewport with someone else's page around it. Four rules fall out of that, and the app already follows them — they are here so that you know what to expect, and so that anyone extending the portal knows what breaks.

- **No fixed headers or footers.** `position: fixed` is relative to the *frame's* viewport, so a fixed header pins to the top of the frame and scrolls away with the host page — it looks broken in a way that is hard to name and easy to blame on the browser.
- **No `100vh`.** Viewport units inside a frame measure the frame, which is sized from its content, which is measured from the viewport. The circularity shows up as a frame that grows on every resize message or collapses to nothing.
- **Dialogs stay inside the frame.** A full-viewport modal overlay clips to the frame's box, so a dialog taller than the frame is unreachable and one anchored to the viewport centre lands wherever the frame happens to be. Dialogs render inline, sized to fit; anything that genuinely needs a real top-level context — a signature, a sensitive account change — opens a popup on the portal origin instead of pretending to be a modal.
- **Height comes from the parent.** The frame measures its own content and posts `resize`; the loader applies it, clamped by `minHeight` and `maxHeight`. Set `minHeight` to roughly the height you expect so the host page does not shift while the frame settles, and set `maxHeight` on anything long — a document list, the data room — so it scrolls internally instead of pushing your footer off the bottom of a very tall page.

Anchor links inside the frame post `scroll-to` with a `y` in frame coordinates, because the frame has no scroll of its own to do it with; the loader translates that into a scroll of the host page. With a raw iframe there is no loader, so an in-frame anchor does nothing visible — one more reason to prefer the loader snippet where the platform allows it.
