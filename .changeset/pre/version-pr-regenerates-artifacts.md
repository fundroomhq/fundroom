---
"@fundroom/server": patch
"@fundroom/web": patch
"@fundroom/embed": patch
---

The version PR passes its own CI. `pnpm version-packages` now runs `scripts/release/version-artifacts.mjs` after `changeset version`, which regenerates the files that carry a version: the embed loader's `src/generated/artifacts.ts` (banner, pinned URL segment, SRI digests) and the OpenAPI document's `info.version`. The loader's `VERSION` is generated from `package.json` (`src/generated/version.ts`) instead of being a hand-kept constant. The pinned loader URL also accepts a pre-release version (`/embed/1.0.0-rc.0/embed.js`), which the router refused with a 404, and the web app's list of server paths matches it.
