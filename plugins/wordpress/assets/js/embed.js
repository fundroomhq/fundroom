/*
 * PLACEHOLDER — replaced at build time.
 *
 * The real contents of this file are the IIFE build of `@fundroom/embed`
 * (`packages/embed/dist/embed.js` in the FundRoom repository), copied here by
 * `scripts/build-wordpress-plugin.mjs`. It defines `window.SeedHost`, whose `init()` creates a
 * cross-origin iframe pointing at the portal.
 *
 * Why the loader is a file in this plugin rather than a `<script src>` pointing at the portal:
 * wp.org guideline 8 requires non-service JavaScript to be bundled locally, and a remote script
 * tag is code from another server running with this site's privileges. An *iframe* to a documented
 * service — which is all the loader creates — is a different thing and is uncontroversial.
 *
 * Source, licence and provenance: the loader is MIT, part of the FundRoom project at
 * https://github.com/fundroomhq/fundroom, under `packages/embed/`. Bundling an MIT file inside
 * this GPLv2-or-later plugin is compatible in that direction; the plugin as distributed is
 * GPLv2-or-later.
 *
 * The committed copy is this comment and nothing else, on purpose: a stale loader checked into
 * the repository is a loader that silently disagrees with the portal it was built against. If you
 * are reading this in an installed plugin, the build did not run — reinstall from a release zip or
 * run `node scripts/build-wordpress-plugin.mjs` in a checkout.
 */

if ( window.console && window.console.error ) {
	window.console.error(
		'[FundRoom] The bundled portal loader is missing from this plugin. Reinstall the plugin from a release zip.'
	);
}
