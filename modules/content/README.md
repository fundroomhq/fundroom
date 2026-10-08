# @fundroom/module-content

The investor overview page
and the first module package: it owns the `content` Postgres schema, ships its own migrations,
mounts `/api/v1/content` from its manifest and is `required` (no workspace can switch it off).

## Model

- `content.page` — `home` (one per workspace, seeded from the template on first request) or
  `custom` (`/p/<slug>`); `draft_revision_id` and `published_revision_id` point into revisions.
- `content.page_revision` — the whole page tree as jsonb. Revision 0 is the draft, edited in
  place; `publish` copies it into revision N with `published_at` and a `visibility` snapshot,
  and a trigger makes published rows immutable. Restore = copy an old revision into the draft.
- `content.section_visibility` — section key → rule, apart from the document so audience
  changes are not content revisions. Rules: `authenticated` (default), `groups`, `staff_only`,
  `public` (only with the workspace setting `content.allowPublicSections`).

RLS: staff and system actors see everything in their workspace; external actors read published
pages and revisions only. Signed-out rendering runs as `system` and filters to public sections.

## Blocks

`src/blocks.ts` is the registry: a Zod schema per `schemaVersion` and an upgrade path per type.
`validateDoc()` normalises a document (defaults, upgrades, embed provider from the host) and
refuses unknown types, newer versions, duplicate keys/ids and documents over 512 KiB.

| Type | Kind | Data |
|---|---|---|
| `hero` | static | heading, subheading, image URL, call to action (same-site path or https) |
| `rich_text` | static | Markdown subset (`# ## ###`, paragraphs, lists, bold, italic, code, links) rendered client-side to elements, never HTML |
| `team` | static | members (name, title, bio, photo, LinkedIn) |
| `faq` | static | question / answer pairs |
| `embed` | static | https URL + title; rendered as a link card (app CSP is `frame-src 'none'`) |
| `metric_grid` | reference | metric definition ids; hydrated by the metrics module |
| `document_list` | reference | folder id / document ids; hydrated by the data room |
| `disclaimer` | reference | a legal-document slug (`null` = the workspace default); hydrated by this module from `ModuleServices.legal` |

`disclaimer` is the one reference block content hydrates itself (`src/disclaimer.ts`): the text
is a kernel fact, a tenant legal document with its own versions, not another module's data. The
block stores a slug and never the words, and publishing stamps the version in force onto
`page_revision.disclaimer_version` so "this revision was published under v3" stays provable. A
workspace with no disclaimer hydrates to an empty payload and the client shows nothing.

A module provides a hydrator on its manifest: `blockHydrators: [{ type: "document_list",
hydrate(data, { tenant, viewer, facts }) }]`. The renderer applies visibility first, then
hydrates only the surviving reference blocks, only when the providing module is enabled in the
workspace; a missing provider or a thrown hydration becomes `unavailable` on the block.

## API

`GET /content/render/{slug}` (public shape: members get their audience's sections, staff get
every section badged, signed-out visitors get public sections or `unauthenticated`),
`GET/POST /content/pages`, `GET/PATCH/DELETE /content/pages/{id}`, `PUT …/draft`
(`baseSavedAt` → 409 on concurrent edits), `PUT …/visibility`, `POST …/publish`,
`GET …/preview?as=authenticated|public|staff|group:<id>`, `GET …/revisions[/{revisionId}]`,
`POST …/revisions/{revisionId}/restore`, `GET /content/blocks`, `GET/PATCH /content/settings`.
Permissions: `content.read` (all staff), `content.manage` and `content.publish` (owner, admin,
editor), `content.settings` (owner, admin); rows in `packages/authz/matrix/authz-matrix.yaml`.

Audit: `page.created / updated / published / visibility_changed / deleted`,
`content.settings_changed`. Outbox: `page.published`.

## Search

`src/search.ts` is the module's `search` provider (`version` 1). One `core.search_entry` per
(published page, section), kind `page`, `refId` = page id, `part` = section key, title = page
title (+ ` — <section title>`), body = plain text of the section's **static** blocks in the
**published** revision: hero heading/subheading, `rich_text` through `@fundroom/markdown`'s
`markdownToText`, FAQ questions and answers, team names/roles/bios, embed titles. Reference
blocks (`metric_grid`, `document_list`, `disclaimer`, `round_summary`) are skipped — their owners
hydrate them per viewer and index them under their own ACL. The ACL comes from the revision's
visibility snapshot: `public`/`authenticated` → `members`, `groups` → those groups, `staff_only`
→ `staff`. `href` is `/` for the home page, `/p/<slug>` otherwise.

Kept current on the writer's transaction by `indexPage`: publish (and the template home page,
published at birth), rename/re-slug of a published page, and delete (removes). Drafts and
visibility edits change nothing until the next publish, exactly like the investor render.
`contentSearch.entries` is the full rebuild (every live published page).

## Portability

`src/portability.ts`: `page`, `page_revision`, `section_visibility` all travel as rows, in that
(FK) order; the page → revision pointers are deferred FKs and resolve at the import's commit, and
group ids inside rules/snapshots ride the engine's generic id remap. Nothing is secret, keyed or
stored outside Postgres (images are URLs). `afterImport` requests a search rebuild.
