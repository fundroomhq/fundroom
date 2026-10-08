<?php
/**
 * The one renderer: container markup, the locally bundled loader, and the init call.
 *
 * @package SeedHost
 * @license GPL-2.0-or-later
 *
 * FundRoom — WordPress plugin. Copyright (C) 2026 FundRoom contributors.
 * This program is free software; you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation; either version 2 of
 * the License, or (at your option) any later version. See LICENSE for the full text.
 */

defined( 'ABSPATH' ) || exit;

/**
 * Renders one embed.
 *
 * There is exactly one function that produces embed markup, and both the shortcode and the block
 * call it. Two renderers would drift: one would learn about the handoff, or the height floor, or
 * the misconfigured case, and the other would not, and nobody would notice until a customer
 * reported that the block behaves differently from the shortcode.
 *
 * The output is a `<div>` and a call to `SeedHost.init()`. The loader script it calls lives in
 * this plugin (`assets/js/embed.js`), placed there at build time from `packages/embed`; nothing
 * is fetched from another server. The loader creates a cross-origin iframe on the portal origin,
 * which is the isolation boundary the whole design rests on: host-page JavaScript can
 * read anything in the host DOM, so investor content is never in the host DOM.
 */
final class Seed_Host_Embed {

	/** Script handle for the bundled loader. */
	const HANDLE = 'seed-host-embed';

	/** Block name; also the directory under `blocks/`. */
	const BLOCK = 'seed-host/portal';

	/**
	 * Counter so several embeds on one page get distinct container ids.
	 *
	 * @var int
	 */
	private static int $instance = 0;

	/** Registers the server-rendered block. `blocks/portal/block.json` is the single source. */
	public static function register_block(): void {
		if ( function_exists( 'register_block_type' ) ) {
			register_block_type( dirname( __DIR__ ) . '/blocks/portal' );
		}
	}

	/**
	 * Renders one embed, or nothing.
	 *
	 * Keys of `$args`, all optional: `path` (string) portal path, falling back to the configured
	 * default; `height` (int) reserved height in pixels, falling back to the configured default;
	 * `title` (string) iframe title, falling back to the loader's own default; `wrapper` (string)
	 * pre-escaped attribute string for the container (block props).
	 *
	 * @param array<string, mixed> $args Embed arguments, as above.
	 * @return string HTML, or '' when there is nothing safe to render.
	 */
	public static function render( array $args = array() ): string {
		$settings = Seed_Host_Settings::get();

		if ( ! Seed_Host_Settings::is_configured() ) {
			return self::unconfigured_notice();
		}

		/*
		 * Feeds, and anything else that will not print our footer scripts, get nothing. A
		 * container with no loader is an empty box a reader cannot act on, and a feed reader that
		 * did run the script would be running it outside the page whose origin the portal's
		 * allow-list was configured for.
		 */
		if ( is_feed() ) {
			return '';
		}

		$path   = Seed_Host_Settings::sanitize_path( isset( $args['path'] ) ? (string) $args['path'] : '' );
		$height = Seed_Host_Settings::clamp_height( isset( $args['height'] ) ? (int) $args['height'] : 0 );
		$title  = isset( $args['title'] ) ? sanitize_text_field( (string) $args['title'] ) : '';

		if ( '' === $path ) {
			$path = (string) $settings['default_path'];
		}
		if ( 0 === $height ) {
			$height = (int) $settings['default_height'];
		}

		++self::$instance;
		$container_id = 'seed-host-portal-' . self::$instance;

		/*
		 * The loader's options, exactly as `@fundroom/embed` documents them. `minHeight` rather
		 * than a fixed height: the iframe reports its own content height over the bridge and the
		 * loader resizes to fit, so the admin's "default height" is the floor that stops the page
		 * jumping before the first `resize` message, not a cap on the content.
		 */
		$options = array(
			'workspace' => (string) $settings['workspace'],
			'baseUrl'   => (string) $settings['base_url'],
			'el'        => '#' . $container_id,
		);
		if ( '' !== $path ) {
			$options['path'] = $path;
		}
		if ( $height > 0 ) {
			$options['minHeight'] = $height;
		}
		if ( '' !== $title ) {
			$options['title'] = $title;
		}
		$locale = self::locale();
		if ( '' !== $locale ) {
			$options['locale'] = $locale;
		}

		/*
		 * Minted here, server-side, once per render, and handed to `init()` — which posts it to
		 * the frame over the bridge. It is never a query parameter: a 60-second bearer
		 * assertion in a URL is one in the access log of every hop, in browser history, and in the
		 * `Referer` of the next navigation.
		 */
		$handoff = Seed_Host_Handoff::mint( $settings );
		if ( is_string( $handoff ) && '' !== $handoff ) {
			$options['handoff'] = $handoff;
		}

		self::enqueue_loader();
		wp_add_inline_script( self::HANDLE, self::init_script( $options ), 'after' );

		$wrapper = isset( $args['wrapper'] ) && is_string( $args['wrapper'] ) ? $args['wrapper'] : '';
		$style   = $height > 0 ? sprintf( 'min-height:%dpx', $height ) : '';

		return sprintf(
			'<div class="seed-host-portal" id="%1$s"%2$s%3$s></div>',
			esc_attr( $container_id ),
			'' !== $style ? ' style="' . esc_attr( $style ) . '"' : '',
			'' !== $wrapper ? ' ' . $wrapper : ''
		);
	}

	/**
	 * The canonical portal URL for this workspace — where a visitor lands if they open the portal
	 * directly rather than through the embed.
	 *
	 * `/w/<slug>` is the portal's own public route for a workspace, so this is a link, not a
	 * guess. Used on the settings screen; the loader builds its own fallback link.
	 *
	 * @param array<string, mixed> $settings Effective settings.
	 * @param string               $path     Optional path inside the workspace.
	 */
	public static function canonical_url( array $settings, string $path = '' ): string {
		$base = rtrim( (string) $settings['base_url'], '/' );
		$slug = (string) $settings['workspace'];
		if ( '' === $base || '' === $slug ) {
			return '';
		}
		return $base . '/w/' . $slug . Seed_Host_Settings::sanitize_path( $path );
	}

	/** Registers the bundled loader if needed and enqueues it. */
	private static function enqueue_loader(): void {
		if ( ! wp_script_is( self::HANDLE, 'registered' ) ) {
			/*
			 * Registered lazily rather than on `wp_enqueue_scripts`, for two reasons: a page with
			 * no embed on it should not carry the script at all, and a shortcode is expanded
			 * during `the_content`, which is after that hook has already run. Footer, with no
			 * `defer`/`async` strategy, so the `after` inline script below is printed immediately
			 * after it and `window.SeedHost` is there when it runs.
			 */
			wp_register_script(
				self::HANDLE,
				plugins_url( 'assets/js/embed.js', SEED_HOST_FILE ),
				array(),
				SEED_HOST_VERSION,
				array( 'in_footer' => true )
			);
		}
		wp_enqueue_script( self::HANDLE );
	}

	/**
	 * The inline `SeedHost.init()` call.
	 *
	 * ES5 on purpose: this runs in whatever browser the host site supports, and a syntax error in
	 * an inline script takes the rest of the footer with it.
	 *
	 * @param array<string, mixed> $options Loader options.
	 */
	private static function init_script( array $options ): string {
		/*
		 * `JSON_HEX_TAG | JSON_HEX_AMP` on top of the default slash escaping, because this JSON is
		 * printed inside a `<script>` element: `</script>` inside any string value would otherwise
		 * end the element early. Every value here has already been validated, so this is the
		 * second line of defence rather than the first.
		 */
		$json = wp_json_encode( $options, JSON_HEX_TAG | JSON_HEX_AMP | JSON_UNESCAPED_UNICODE );
		if ( ! is_string( $json ) ) {
			return '';
		}

		return '(function(){'
			. 'var o=' . $json . ';'
			. 'if(!window.SeedHost||!document.querySelector(o.el)){return;}'
			. 'try{'
			. 'var p=window.SeedHost.init(o);'
			. 'if(p&&typeof p.catch==="function"){'
			. 'p.catch(function(e){if(window.console&&window.console.error){window.console.error("[FundRoom]",e);}});'
			. '}'
			. '}catch(e){if(window.console&&window.console.error){window.console.error("[FundRoom]",e);}}'
			. '})();';
	}

	/**
	 * The host page's locale as a BCP 47 tag (`en_GB` → `en-GB`), or '' when there is nothing
	 * useful to send. The portal negotiates from this and falls back to its own default.
	 */
	private static function locale(): string {
		$locale = str_replace( '_', '-', (string) determine_locale() );
		// Strip a WordPress locale variant suffix (`de-DE-formal`), which is not a language tag.
		$parts = explode( '-', $locale );
		if ( count( $parts ) > 2 ) {
			$parts = array_slice( $parts, 0, 2 );
		}
		$tag = implode( '-', $parts );
		return preg_match( '/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/', $tag ) ? $tag : '';
	}

	/**
	 * What an unconfigured embed renders.
	 *
	 * Visitors get nothing at all — never a broken iframe, never a box explaining our
	 * configuration to the public. Someone who can fix it gets a line saying so, because the
	 * alternative is an editor placing a block, seeing an empty page, and having no idea why.
	 * The persistent version of this message is `Seed_Host_Settings::admin_notices()`.
	 */
	private static function unconfigured_notice(): string {
		if ( ! current_user_can( 'manage_options' ) ) {
			return '';
		}
		return sprintf(
			'<p class="seed-host-portal-notice"><em>%s</em></p>',
			sprintf(
				/* translators: %s: link to the plugin settings screen. */
				esc_html__( 'FundRoom is not connected to a portal yet, so nothing is shown here. %s', 'seed-host' ),
				'<a href="' . esc_url( Seed_Host_Settings::page_url() ) . '">'
					. esc_html__( 'Open FundRoom settings', 'seed-host' )
					. '</a>'
			)
		);
	}
}
