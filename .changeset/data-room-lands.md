---
"@fundroom/module-data-room": minor
"@fundroom/avscan-noop": minor
"@fundroom/avscan-clamd": minor
"@fundroom/render-pdfium": minor
"@fundroom/ports": minor
"@fundroom/config": minor
"@fundroom/module-kit": minor
"@fundroom/authz": minor
"@fundroom/db": minor
"@fundroom/domain": minor
"@fundroom/audit": patch
"@fundroom/sdk": minor
"@fundroom/server": minor
"@fundroom/web": minor
---

Data room. New module package `@fundroom/module-data-room` (`dataroom` schema: folders with `ltree` paths and index numbering, content-addressed blobs with the scan state machine, documents with immutable versions, renditions, extracted page text, staged uploads; `/api/v1/data-room/*`: tree, folders, templates (Seed, Series A DD, Board), documents, versions, protection, legal hold, recycle bin, purge, uploads, settings; delivery routes for thumbnails, watermarked page images, in-document search, watermarked/original downloads; jobs `data-room.ingest`, `data-room.purge`, `data-room.reconcile`; the `document_list` content hydrator; tus raw route for the filesystem driver). New ports `VirusScanPort` and `DocumentRenderPort` with adapters `@fundroom/avscan-noop`, `@fundroom/avscan-clamd` (INSTREAM) and `@fundroom/render-pdfium` (PDFium WASM rasteriser, pdf-lib sanitise/watermark, sharp). `@fundroom/config`: `AV_DRIVER`, `CLAMD_HOST/PORT/TIMEOUT_MS`, `RENDER_MAX_BYTES`. `@fundroom/module-kit`: `ModuleServices` gains `crypto`, `scanner`, `renderer`, `limits`, `queue.sendInTransaction`, `authz.bump`; manifests may declare `jobs` as a factory over services and `rawRoutes` mounted outside the JSON body limit. `@fundroom/authz` + `@fundroom/db` migration `0005_access_path_inheritance`: a rule on an ancestor path covers every node below it regardless of kind (folder grants reach documents), `GrantRepo`/`PolicyRepo.rewritePaths` for folder moves. `@fundroom/domain`: `dataRoom` workspace settings, `document.ingested` event. `@fundroom/web`: `/admin/data-room` (browser, uploads, document detail, recycle bin, settings) and the investor `/data-room` browser + secure viewer.
