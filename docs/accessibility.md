# Accessibility

How FundRoom approaches accessibility, what is checked automatically, and where the known gaps are.
This page is for maintainers and operators. The statement investors see is a separate document; see
[the accessibility statement](#the-per-workspace-accessibility-statement) below.

## Conformance target

**WCAG 2.2 level AA** for everything an investor or a staff member uses: the investor portal (also
when it is embedded), the admin, sign-in and first-run setup. The bar: zero axe
violations on every key page. A merge is blocked on it (see [CI](#what-is-automated)).

Automated checks catch roughly a third to a half of WCAG failures. They do not replace a manual pass
with a screen reader (NVDA + Firefox, VoiceOver + Safari) and keyboard only before claiming
conformance in a workspace's statement.

## What is automated

| Layer | Where | What it sees | What it cannot see |
|---|---|---|---|
| **jsdom axe per screen** | `apps/web/src/test/a11y.ts` (`expectNoA11yViolations`), called by almost every screen test in `apps/web/src/screens/*.test.tsx` (vitest project `web`) | WCAG 2.0/2.1/2.2 A + AA rules on the rendered DOM: names, roles, labels, landmarks, ARIA validity, list/table structure, duplicate ids | **No colour contrast** (jsdom has no layout or computed colours, so `color-contrast` is off and `link-in-text-block` cannot fire), focus visibility, target size, reflow |
| **Playwright axe on key pages** | `e2e/support/axe.ts` (`expectNoAxeViolations`), `e2e/tests/30-a11y.test.ts` (`@a11y`) and every first-run wizard step in `e2e/tests/00-setup.test.ts` | The same rule set in real Chromium, **including colour contrast**, `link-in-text-block`, `target-size` and other layout-dependent rules. Every violation fails, whatever its impact. Each page's full axe result is attached to the Playwright HTML report | Anything that needs judgement: reading order, alt text quality, whether a focus move makes sense |
| **Viewer keyboard e2e** | `30-a11y`, "viewer: keyboard only" | Real key presses: Tab reaches the pages area, arrows page, `+` zooms, go-to-page moves focus, `?` opens the help, Escape returns focus, the toolbar is a single tab stop | Screen-reader output |
| **Storybook a11y addon** | `packages/ui` stories, CI job `design-system` | Components in isolation, in `error` mode (a violation fails the build) | Composition into screens |

Pages covered by `30-a11y`: `/login`, `/login/verify`, `/accessibility` (signed out); the investor
home, data room list, document viewer (with a shortcut-dialog pass), a sent update, `/settings`,
`/settings/security`, `/search?q=…`; the admin home, people, data room, update editor, audit log and
`/admin/settings/export`. The spec seeds its own data after `00-setup`: a two-page text PDF uploaded
over tus, a role grant so investors can view it, the wizard's update sent, and a second draft.

The CI job **`a11y`** runs on every pull request, not only labelled ones. It builds, boots
`deploy/compose/compose.ci.yaml`, runs `pnpm --filter @fundroom/e2e test:a11y`
(`--grep "@setup|@a11y"`, Chromium) and always uploads the report as the `a11y-report` artifact.
`ci-ok` requires it. The labelled `e2e` job leaves `@a11y` out so it does not run twice.

Locally:

```sh
export E2E_APP_PORT=3100 E2E_MAILPIT_PORT=8125
export E2E_BASE_URL=http://localhost:3100 E2E_MAILPIT_URL=http://localhost:8125
pnpm --filter @fundroom/e2e stack:up
pnpm --filter @fundroom/e2e test:a11y
pnpm --filter @fundroom/e2e stack:down      # -v: the next run needs a fresh install
```

`00-setup` writes the owner's TOTP secret to `e2e/.state/stack.json` (gitignored), and `30-a11y`
reads it. `30-a11y` also stores its seed and signed-in browser states there, so a worker restart
after one failing page does not upload and send everything again.

**Lesson learned:** jsdom axe missed a `text-primary hover:underline` link inside muted body text
(1.4:1 against its surroundings, no persistent underline), and real-browser axe caught it straight
away. Links inside running text need a persistent `underline`. Do not treat a green jsdom run as
proof of contrast.

## The document viewer

`apps/web/src/components/data-room/viewer.tsx`. Pages are server-rendered, watermarked images. Every part of the viewer can be used without a pointer, at every viewport width.

### Keyboard map

| Where | Keys | Action |
|---|---|---|
| Pages area (focusable scroll region, in the tab order) | `→` / `Page Down` | Next page |
| | `←` / `Page Up` | Previous page |
| | `Home` / `End` | First / last page |
| | `+` or `=` | Zoom in (50 → 75 → 100 → 150 → 200 %; from "Fit width", steps up from 100 %) |
| | `-` | Zoom out |
| | `0` | Fit width |
| Anywhere in the viewer except a text field | `?` | Open the keyboard-shortcut list |
| Toolbar ("Viewer controls") | `←` `→` (wrapping), `Home` `End` | Move between controls. The toolbar is one tab stop (WAI-ARIA toolbar pattern, roving `tabindex`) |
| Shortcut dialog | `Esc` | Close. Focus goes back to the element that had it when the dialog opened |
| Go to page (number field) | type a number, `Enter` | Show that page and move focus to it. Out-of-range input is marked `aria-invalid` and gets an assertive error message |

Notes:

- Handled keys call `preventDefault`, so the region does not also scroll natively. Keys pressed with
  `Ctrl`, `Cmd` or `Alt` are never handled (browser zoom and history stay the browser's). `Space` is
  left to the browser and scrolls the region. The current page follows the scroll position.
- Arrow keys in the toolbar move focus, not pages. The toolbar and the pages area are siblings, so
  their handlers never see each other's events.
- Unavailable toolbar controls (Previous on page 1, Zoom in at 200 %) use `aria-disabled`, not
  `disabled`, so the focused control does not disappear from under the keyboard.
- Opening a page from a thumbnail, a search hit or go-to-page moves focus to that page's `<figure>`
  (named "Page n" by its caption) with `preventScroll`, then scrolls it into view once.
  `prefers-reduced-motion: reduce` makes that scroll instant instead of smooth.
- Changes are announced through polite live regions: the page counter ("Page 2 of 12") and the
  zoom level ("Zoom: 150%").
- Below the `lg` breakpoint the thumbnail list is hidden. Go-to-page, the Previous/Next buttons and
  the arrow keys reach every page. Thumbnails exist for every page, load lazily (`loading="lazy"`),
  and use `alt=""` because the button text ("Page n") already names them.
- Touch swipe paging always has a button alternative (WCAG 2.5.7).

### Text layer

For each mounted page (the current page and one either side), the viewer fetches
`GET /data-room/documents/{id}/pages/{n}/text` (`{ pageNo, pageCount, text }`, the same view check
as the page image) and renders the text inside the page figure as visually hidden paragraphs. A
screen reader reads the page's content, not only "Page 3 of Pitch deck". The layer is not a
selectable overlay: sighted users see only the watermarked image, and `select-none` keeps the text
out of a select-all copy. The query is keyed by version and not retried. On 403, 404 or 409 (gated,
missing, not viewable), on any other failure, and on empty text, the figure says "This page has no
text layer."

## Known limitations

- **Scanned PDFs have no text layer.** Text comes from the PDF's own text. There is no OCR, so a
  scan (or a slide exported as an image) reads as "This page has no text layer". A workspace that
  needs these to be accessible should upload a tagged or OCR'd PDF.
- **Page images are images of text** (WCAG 1.4.5). This is required by the security model
  (watermark burned in, no original bytes). The text layer covers screen readers, zoom
  goes to 200 %, and the download (where the document policy allows it) is the original file.
  Reflow at 400 % (1.4.10) does not apply inside a page image.
- **Charts:** metric charts (`apps/web/src/components/charts/chart-svg.tsx`) are `role="img"` with a
  sentence summary as their accessible name, and every chart renders its figures as a real `<table>`
  beside it: visually hidden by default, visible on request (`table="visible"`), or left out only
  where the same numbers are already in a table on the page (the metric tiles). No known gap here.
  Keep it that way for any new chart.
- **Emails** (sign-in codes, updates) use the shared mail layout. They are not covered by
  automated axe runs.
- **Embedded portals:** the portal inside a customer's iframe is covered by axe in
  `20-embed-hosts` (inside the frame). The host page is the customer's responsibility.
- **Automated coverage is partial.** Screen-reader behaviour, reading order and the quality of
  customer-supplied content (document titles, update bodies, alt text on uploaded images) need
  manual review.

## The per-workspace accessibility statement

Each workspace publishes its own statement at **`/accessibility`**. The page needs no sign-in and is
linked from the portal footer and the sign-in layout. It is served by the public route
`GET /api/v1/compliance/accessibility-statement`, which resolves the workspace from the host like
other public endpoints and returns `{ source, title, bodyMarkdown, effectiveDate, version }`:

1. **`source: "published"`**: the workspace's published legal document of kind
   `accessibility_statement` (Admin → Legal, created from the "Accessibility statement" template
   or written from scratch, then published like any other legal document, with a version and an
   effective date).
2. **`source: "default"`**: when nothing is published, the `accessibility-statement` template
   (`packages/compliance/templates/accessibility-statement.md`) rendered with the workspace's facts
   (legal name, contact email, portal URL and name). The template is an engineering starting point.
   Its bracketed conformance claim ("fully / partially conformant / not assessed") and assessment
   method must be filled in, and counsel should review it before the workspace publishes its own
   version.

The statement is the workspace's claim, not the software's. This document lists what the software
checks. Only the operator can say what they have assessed.
