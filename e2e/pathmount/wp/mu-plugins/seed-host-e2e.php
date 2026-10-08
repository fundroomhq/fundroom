<?php
/**
 * Plugin Name: FundRoom e2e harness (wp.test)
 * Description: Test scaffolding for the path-mount e2e stack. Never shipped, never documented.
 *
 * Two things, neither part of the recipe:
 *
 *  1. The proxy's hop to https://portal.test is verified against the edge's internal CA
 *     (`/edge-ca/root.crt`, the edge's data volume mounted read-only) through the plugin's own
 *     `seed_host_proxy_ca_file` filter. A production site trusts the portal's public certificate
 *     through the system store and needs nothing here.
 *  2. The front page sets two cookies on Path=/ — a site cookie and one shaped like WordPress's own
 *     login cookie — so the spec can assert the proxy forwards neither to the portal.
 *
 * @package SeedHostE2E
 */

add_filter(
	'seed_host_proxy_ca_file',
	static function () {
		return '/edge-ca/root.crt';
	}
);

add_action(
	'template_redirect',
	static function () {
		if ( ! is_front_page() ) {
			return;
		}
		$attrs = array(
			'path'     => '/',
			'secure'   => true,
			'httponly' => true,
			'samesite' => 'Lax',
		);
		setcookie( 'host_session', 'wp-secret', $attrs );
		setcookie( 'wordpress_logged_in_e2e', 'wp-login-secret', $attrs );
	}
);
