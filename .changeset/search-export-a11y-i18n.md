---
"@fundroom/server": minor
"@fundroom/web": minor
"@fundroomhq/ui": minor
"@fundroom/db": minor
"@fundroom/contracts": minor
"@fundroom/module-kit": minor
"@fundroom/identity": minor
"@fundroom/mail": minor
"@fundroom/compliance": minor
"@fundroom/config": minor
"@fundroom/sdk": minor
"@fundroom/search": minor
"@fundroom/portability": minor
"@fundroom/i18n": minor
"@fundroom/module-data-room": minor
"@fundroom/module-content": minor
"@fundroom/module-updates": minor
"@fundroom/module-round": minor
"@fundroom/module-metrics": minor
"@fundroom/module-crm": minor
"@fundroom/module-notify": minor
"@fundroom/module-analytics": minor
---

Add search, workspace export and import, accessibility and i18n coverage.

- **Search.** `GET /api/v1/search` and a search box in the portal and admin headers (`/` or Ctrl/Cmd+K).
  - The index covers data-room documents and folders (with extracted PDF text), published content-page sections and sent updates.
  - Access is filtered on every query by row security plus an authz check per document. A gated document is findable by its title only; nothing in the response depends on its body.
  - Queries are lexed by Postgres's own parser, so emails, file names, decimals and hyphenated dates are found as written.
  - `fundroom search reindex` rebuilds the index, and a 10-minute sweep rebuilds it by itself after deploys and imports.
- **Workspace export.**
  - `/admin/settings/export` (owner, step-up) and `fundroom workspace export` produce a signed, streamed zip. It holds every table as JSONL, the audit chain, and every document in plaintext.
  - Exports are stored encrypted, expire after seven days, and can be checked offline with `fundroom workspace verify-export`.
- **Workspace import.**
  - `fundroom workspace import <file> --slug <new>` recreates the workspace with fresh ids.
  - Members are matched to existing accounts by email, and blobs are re-encrypted under the new workspace's keys. Search and access are rebuilt afterwards.
  - It refuses unsigned files unless `--allow-unverified` is given, along with malformed archives and any file that names objects or rows of another workspace.
- **Accessibility.**
  - The data-room viewer is keyboard-complete: zoom keys, go to page, a roving toolbar, a `?` shortcut sheet and thumbnails for every page. Each page has a screen-reader text layer (`GET /data-room/documents/{id}/pages/{n}/text`).
  - A public `/accessibility` statement is served per workspace.
  - A new `a11y` CI job runs real-browser axe (WCAG 2.2 AA including contrast) on 16 key pages for every pull request.
  - The muted text colour now meets 4.5:1 everywhere.
- **i18n.**
  - An `en-XA` pseudo-locale proves the investor UI has no hard-coded English, and `pnpm lint:i18n` enforces that for every future change.
  - The UI package has no English defaults, messages use real plurals, and emails render in the recipient's language.
  - Users choose their language in settings (`PUT /me/locale`), and admins set a workspace default (`PUT /workspace/locale`).
- **Fixes.**
  - Database pools now log idle-connection errors instead of crashing the process.
  - Three GitHub workflows used `hashFiles` in job-level conditions, which GitHub rejects, so they never started. They are fixed, and a new actionlint check keeps them that way.
