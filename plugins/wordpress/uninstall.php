<?php
/**
 * Uninstall: forget everything, including the private key.
 *
 * @package SeedHost
 * @license GPL-2.0-or-later
 *
 * FundRoom — WordPress plugin. Copyright (C) 2026 FundRoom contributors.
 * This program is free software; you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation; either version 2 of
 * the License, or (at your option) any later version. See LICENSE for the full text.
 *
 * WordPress runs this file with the plugin *not* loaded, so the option names are written out here
 * rather than read from `Seed_Host_Settings` — a class that is not in scope. Keep this list in
 * step with `includes/class-settings.php` and `includes/class-handoff.php`; there is nothing else
 * to clean up, because the plugin creates no tables, no post types, no user meta and no scheduled
 * events. Proxy mode's settings (`proxy_enabled`, `proxy_prefix`, `proxy_max_body_mb`) are keys of
 * `seed_host_settings`, not options of their own; its rewrite rule lives in WordPress's cached
 * `rewrite_rules`, which the deactivation hook already dropped and which is dropped again below
 * for a site that had proxy mode on, so the prefix cannot outlive the plugin.
 *
 * The one entry that matters is `seed_host_handoff_secret_key`: the Ed25519 private key this site
 * signs handoff assertions with. Leaving key material behind after an uninstall would mean a site
 * that no longer has the plugin still has something that can impersonate its members to the
 * portal. Deleting it here is the counterpart of the portal's own "remove this key" action, which
 * an admin should also use.
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

/** Every option this plugin has ever written. */
const SEED_HOST_UNINSTALL_OPTIONS = array(
	'seed_host_settings',
	'seed_host_handoff_key_id',
	'seed_host_handoff_public_key',
	'seed_host_handoff_secret_key',
);

/** Deletes this plugin's options on whichever site is current. */
function seed_host_delete_site_options(): void {
	$settings = get_option( 'seed_host_settings' );
	if ( is_array( $settings ) && ! empty( $settings['proxy_enabled'] ) ) {
		// WordPress rebuilds this on the next request, now without the proxy's rule.
		delete_option( 'rewrite_rules' );
	}
	foreach ( SEED_HOST_UNINSTALL_OPTIONS as $option ) {
		delete_option( $option );
	}
}

if ( ! is_multisite() ) {
	seed_host_delete_site_options();
	return;
}

/*
 * Multisite: each site has its own options, so each site has its own key. Walked in batches
 * because a network can have tens of thousands of sites and `get_sites()` with no limit would load
 * every one of them into memory during an uninstall.
 */
$seed_host_offset = 0;
$seed_host_batch  = 100;
do {
	$seed_host_site_ids = get_sites(
		array(
			'fields'  => 'ids',
			'number'  => $seed_host_batch,
			'offset'  => $seed_host_offset,
			// Stable ordering, so the offset walk cannot skip or repeat a site.
			'orderby' => 'id',
			'order'   => 'ASC',
		)
	);
	foreach ( $seed_host_site_ids as $seed_host_site_id ) {
		switch_to_blog( (int) $seed_host_site_id );
		seed_host_delete_site_options();
		restore_current_blog();
	}
	$seed_host_offset += $seed_host_batch;
	$seed_host_count   = count( $seed_host_site_ids );
} while ( $seed_host_count === $seed_host_batch );

// Network-wide rows, in case a future version stores one. Cheap, and the alternative is an orphan
// nobody thinks to look for.
foreach ( SEED_HOST_UNINSTALL_OPTIONS as $seed_host_option ) {
	delete_site_option( $seed_host_option );
}
