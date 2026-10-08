<?php
/**
 * The `[seed_host]` shortcode.
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
 * `[seed_host path="/updates" height="800" title="Investor updates"]`
 *
 * A thin adapter: it turns shortcode attributes into the renderer's arguments and does no
 * validation of its own, because `Seed_Host_Embed::render()` validates what it is given. Two
 * places deciding what a valid path is would eventually disagree about one.
 */
final class Seed_Host_Shortcode {

	/** The tag. Prefixed, because the shortcode namespace is global to the site. */
	const TAG = 'seed_host';

	/** Registers the shortcode. */
	public static function register(): void {
		add_shortcode( self::TAG, array( __CLASS__, 'render' ) );
	}

	/**
	 * Renders `[seed_host]` through the one renderer.
	 *
	 * @param mixed $atts Shortcode attributes; WordPress passes '' when there are none.
	 * @return string
	 */
	public static function render( $atts = array() ): string {
		$atts = shortcode_atts(
			array(
				'path'   => '',
				'height' => '',
				'title'  => '',
			),
			is_array( $atts ) ? $atts : array(),
			self::TAG
		);

		return Seed_Host_Embed::render(
			array(
				'path'   => (string) $atts['path'],
				'height' => (int) $atts['height'],
				'title'  => (string) $atts['title'],
			)
		);
	}
}
