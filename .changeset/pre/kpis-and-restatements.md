---
"@fundroom/module-metrics": minor
"@fundroom/charts": minor
"@fundroom/csv": minor
"@fundroom/sheets-google": minor
"@fundroom/module-updates": minor
"@fundroom/module-content": patch
"@fundroom/module-data-room": patch
"@fundroom/module-kit": minor
"@fundroom/ports": minor
"@fundroom/render-pdfium": minor
"@fundroom/domain": minor
"@fundroom/authz": minor
"@fundroom/config": minor
"@fundroom/identity": patch
"@fundroom/sdk": minor
"@fundroom/server": minor
"@fundroom/web": minor
---

KPIs. New module package `@fundroom/module-metrics` (`metrics` schema: definitions with unit, aggregation, direction, period granularity, decimals, an optional formula and a per-metric audience; append-only `point` rows where a correction supersedes rather than edits, with a deferred GiST exclusion keeping one live value per period and a trigger refusing every other kind of update; `source` recording provenance; CSV imports and one Google Sheets connection per workspace). `/api/v1/metrics/*`: the definition catalogue, the period grid with its no-op rule, per-cell revision history, the investor series read, a two-step CSV import with an admin-chosen column mapping, the Sheets connection and an on-demand sync, module settings, and a public chart image addressed by a capability token. Jobs `metrics.import` and the nightly `metrics.sheets_sync`; derived metrics recomputed through the outbox on `metric.points_changed`, where a division by zero or a missing input produces no point rather than a zero. Metrics is the first module in the product that is **off by default**, so its routes answer 404 where it has not been enabled.

New `@fundroom/charts` — chart geometry as a list of drawing operations with no DOM, no palette and no renderer, replayed as React SVG in the browser and through pdf-lib into PDFium on the server, so the chart in an investor's inbox and the chart on the page cannot disagree. New `DocumentRenderPort.renderVector` and its `VectorOp` vocabulary implement the second half in `@fundroom/render-pdfium`. New `@fundroom/csv`, the RFC-4180-ish parser extracted from the invite importer now that a second surface needs it, with its first real test suite. New `@fundroom/sheets-google` behind a `SpreadsheetPort`, service-account only, reached through a new narrowly-scoped `ModuleServices.spreadsheets` rather than a general outbound fetch; `SPREADSHEET_DRIVER` selects it or a `noop`.

Investor updates now carry their KPIs: `metric_grid` blocks are hydrated per audience in the send path through the block-hydrator registry, rendered as a chart image plus the same figures in text in both parts of the mail, and the image URL names an audience rather than a person, so it cannot become the tracking pixel this product does not ship. `BlockHydrationContext` gains an optional `medium` so a capability URL is minted for mail and never for a page a session already protects. Web: `/admin/metrics` (period grid, catalogue, revision history, CSV import with column mapping, Sheets connection and KPI settings), `/metrics` for investors, a real `metric_grid` block renderer replacing the placeholder, and a metric picker in the overview-page editor. Matrix permissions `metrics.read|manage|settings`; `WorkspaceSettings.metrics`; events `metric.points_changed` and `metric.restated`. Requires the `btree_gist` extension.

Also fixes three defects that predate this epic and were found while building it. The in-viewer data-room watermark rendered as a grid of empty boxes in the shipped image — the runtime is distroless and has no fonts, so the SVG text path drew `.notdef` glyphs silently while development on macOS looked perfect; the image now bundles a font and a fontconfig file, and the renderer gained a probe that compares each glyph against a code point no font can have — because under a missing font every glyph is the same rectangle, so a "did anything draw?" check passes — asserted once at boot, so a fontless image refuses to start rather than quietly serving blank watermarks. `GET /api/v1/openapi.json` rebuilds the API against a throwing stub, so `modules/content` and `modules/data-room`, which captured their services unconditionally, had disclaimer and document-list hydration permanently broken by any single fetch of the contract document; `isLiveModuleServices` in `@fundroom/module-kit` guards both. And `@fundroom/identity` ignored its injected clock when reading a pending invitation, which production never saw because its clock is real.
