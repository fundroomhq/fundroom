---
"@fundroom/module-content": minor
"@fundroom/module-kit": minor
"@fundroom/domain": minor
"@fundroom/audit": minor
"@fundroom/authz": minor
"@fundroom/sdk": minor
"@fundroom/server": minor
"@fundroom/web": minor
---

Content page. New `@fundroom/module-content` (`modules/content`), the first module package: the `content` schema (`page`, immutable `page_revision` with a visibility snapshot, `section_visibility`) with its own migrations and actor-kind RLS; the block registry (`hero`, `rich_text`, `metric_grid`, `document_list`, `team`, `faq`, `embed`, Zod schema per version, upgrades, size caps); draft saved in place with conflict detection, publish as a new immutable revision, restore; section visibility (`authenticated`, `groups`, `staff_only`, `public`) with the `allowPublicSections` guard at write and render time; server-side hydration of reference blocks after visibility with an `unavailable` fallback; preview-as-audience; the template home page seeded on first request; `/api/v1/content/*` (render, pages, draft, visibility, publish, preview, revisions, restore, blocks, settings). `@fundroom/module-kit`: `ModuleServices` (kernel services + `guards` for module routes, `routes(api, services)`), `blockHydrators` on manifests merged into `registry.blockHydrators`, `ModuleRegistryView` / `EnablementView`. `@fundroom/domain`: `content.allowPublicSections` workspace setting, `page.published` event. `@fundroom/audit`: `page.*` and `content.settings_changed` actions. `@fundroom/authz`: `content.read/manage/publish/settings` and the content routes in the matrix. `@fundroom/server`: `moduleServicesOf()`, `content` in `COMPILED_IN_MODULES`. `@fundroom/web`: the investor home renders the published page (safe Markdown subset, hero, team, FAQ, link cards, reference placeholders), `/p/<slug>` custom pages, the `/admin/content` editor (sections, blocks, audiences with groups, autosave, preview-as, history + restore, publish, public-sections switch).
