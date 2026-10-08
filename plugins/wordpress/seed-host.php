<?php
/**
 * Plugin Name:       FundRoom
 * Plugin URI:        https://github.com/fundroomhq/fundroom
 * Description:       Your FundRoom investor portal on your site: block, shortcode, identity handoff, proxy mode.
 * Version:           0.2.0
 * Requires at least: 6.4
 * Requires PHP:      8.1
 * Author:            FundRoom
 * Author URI:        https://github.com/fundroomhq/fundroom
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       seed-host
 * Update URI:        https://wordpress.org/plugins/seed-host/
 *
 * @package SeedHost
 */

/*
 * FundRoom — WordPress plugin
 * Copyright (C) 2026 FundRoom contributors
 *
 * This program is free software; you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation; either version 2 of
 * the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See
 * the GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License along with this program; if
 * not, see <https://www.gnu.org/licenses/gpl-2.0.html>.
 */

/*
 * The whole plugin, in one paragraph: it renders a `<div>` and calls `SeedHost.init()` from a
 * loader script that ships *inside this zip*, and the loader creates a cross-origin iframe on the
 * portal's own origin. That is the entire default integration. The portal is not proxied, no
 * investor data passes through WordPress, and nothing in this directory makes a server-side
 * request to the portal — not on activation, not on a settings save, not on a page view —
 * **except in the opt-in proxy mode** (`includes/class-proxy.php`), which an
 * administrator has to switch on under "Advanced: proxy mode" and which then forwards requests
 * under one path of this site (say `/investors`) to the portal. Off, it registers nothing but
 * three hooks that return immediately.
 *
 * That property is not an accident of the implementation; it is the wp.org guideline 8
 * contract and the reason the plugin can be this small:
 *
 *  - **The loader is local.** `assets/js/embed.js` is placed there by
 *    `scripts/build-wordpress-plugin.mjs` from `packages/embed/dist/embed.js`. A remote `<script>`
 *    would be "loading code from another server"; an *iframe* to a documented service is not, and
 *    is what this plugin ends up creating.
 *  - **Nothing happens until an admin opts in.** No scheduled event and no default option row: an
 *    unconfigured install registers a shortcode and a block that both render nothing (see
 *    `Seed_Host_Embed::render()`). The activation and deactivation hooks exist only to drop
 *    WordPress's cached rewrite rules when proxy mode is on, and do nothing otherwise.
 *  - **The settings screen is native WP admin.** Iframing our own dashboard into wp-admin is
 *    explicitly disallowed, and would also be the wrong shape: the values below belong to this
 *    site, not to the portal.
 *  - **GPLv2-or-later.** The FundRoom core is MIT; this directory is GPL, which is what
 *    distributing through the wp.org directory requires. Every file carries the header.
 */

defined( 'ABSPATH' ) || exit;

/**
 * Plugin version. Stamped from `readme.txt`'s `Stable tag` by the build script, together with the
 * `Version:` header above — those two are the only places a version number lives.
 */
define( 'SEED_HOST_VERSION', '0.2.0' );

/** Absolute path to this file; `plugin_basename()`/`plugins_url()` derive everything else. */
define( 'SEED_HOST_FILE', __FILE__ );

require_once __DIR__ . '/includes/class-settings.php';
require_once __DIR__ . '/includes/class-handoff.php';
require_once __DIR__ . '/includes/class-embed.php';
require_once __DIR__ . '/includes/class-shortcode.php';
require_once __DIR__ . '/includes/class-proxy-rules.php';
require_once __DIR__ . '/includes/class-proxy.php';

/*
 * Hook registration only. Reading options here rather than in the callbacks would put a database
 * query on every request including the ones that render no embed, and `init` is the earliest
 * point at which translations and the block registry are ready.
 */
add_action( 'init', array( 'Seed_Host_Shortcode', 'register' ) );
add_action( 'init', array( 'Seed_Host_Embed', 'register_block' ) );

add_action( 'admin_init', array( 'Seed_Host_Settings', 'register' ) );
add_action( 'admin_menu', array( 'Seed_Host_Settings', 'add_menu' ) );
add_action( 'admin_notices', array( 'Seed_Host_Settings', 'admin_notices' ) );
add_action(
	'admin_post_' . Seed_Host_Settings::GENERATE_ACTION,
	array( 'Seed_Host_Settings', 'handle_generate_keypair' )
);
add_filter( 'plugin_action_links_' . plugin_basename( __FILE__ ), array( 'Seed_Host_Settings', 'action_links' ) );

/*
 * Proxy mode. `parse_request` at priority 0 is the earliest point with WordPress's routing done
 * and nothing queried or printed; the handler returns at once unless proxy mode is on and the
 * request path is under its prefix. The option hooks drop cached rewrite rules when the proxy
 * settings change, whether through the settings screen, WP-CLI or `update_option()`.
 */
add_action( 'init', array( 'Seed_Host_Proxy', 'register_rewrite' ) );
add_filter( 'query_vars', array( 'Seed_Host_Proxy', 'query_vars' ) );
add_action( 'parse_request', array( 'Seed_Host_Proxy', 'maybe_handle' ), 0 );
add_action( 'update_option_seed_host_settings', array( 'Seed_Host_Proxy', 'on_settings_change' ), 10, 2 );
add_action( 'add_option_seed_host_settings', array( 'Seed_Host_Proxy', 'on_settings_change' ), 10, 2 );
register_activation_hook( __FILE__, array( 'Seed_Host_Proxy', 'on_activation_change' ) );
register_deactivation_hook( __FILE__, array( 'Seed_Host_Proxy', 'on_activation_change' ) );
