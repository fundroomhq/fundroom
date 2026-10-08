<?php
/**
 * Dependency and version manifest for `index.js`.
 *
 * @package SeedHost
 * @license GPL-2.0-or-later
 *
 * FundRoom — WordPress plugin. Copyright (C) 2026 FundRoom contributors.
 * This program is free software; you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation; either version 2 of
 * the License, or (at your option) any later version. See LICENSE for the full text.
 *
 * `register_block_type()` requires this file next to every `editorScript`; `@wordpress/scripts`
 * normally generates it. This plugin has no build step for the editor script (see `index.js`), so
 * the list is maintained by hand — which is possible precisely because the script uses the `wp.*`
 * globals and its dependencies are the five packages named below.
 */

defined( 'ABSPATH' ) || exit;

return array(
	'dependencies' => array(
		'wp-blocks',
		'wp-block-editor',
		'wp-components',
		'wp-element',
		'wp-i18n',
	),
	'version'      => defined( 'SEED_HOST_VERSION' ) ? SEED_HOST_VERSION : '0.1.0',
);
