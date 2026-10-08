<?php
/**
 * Server-side render for the `seed-host/portal` block.
 *
 * @package SeedHost
 * @license GPL-2.0-or-later
 *
 * FundRoom — WordPress plugin. Copyright (C) 2026 FundRoom contributors.
 * This program is free software; you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation; either version 2 of
 * the License, or (at your option) any later version. See LICENSE for the full text.
 *
 * Server-rendered rather than saved into post content, for three reasons:
 *
 *  1. The handoff assertion must be minted per request — it is valid for 60 seconds. A saved
 *     block would either hold a stale one or hold none at all.
 *  2. The portal address and workspace live in settings. A saved block would freeze whatever they
 *     were when the post was written, and changing them would mean re-editing every page.
 *  3. Post content is stored HTML. Anything the renderer decides — the container id, the height
 *     floor, the "not configured" case — stays server-side where it can change with an update.
 *
 * WordPress puts `$attributes`, `$content` and `$block` in scope here.
 *
 * @var array<string, mixed> $attributes Block attributes, already coerced to the block.json types.
 */

defined( 'ABSPATH' ) || exit;

$seed_host_attributes = isset( $attributes ) && is_array( $attributes ) ? $attributes : array();

// `get_block_wrapper_attributes()` carries the alignment and custom class name the editor set. It
// is pre-escaped by core and goes on the container element the renderer emits, which is also why
// `block.json` does not enable `anchor` support: the container already has an `id` of its own.
$seed_host_html = Seed_Host_Embed::render(
	array(
		'path'    => isset( $seed_host_attributes['path'] ) ? (string) $seed_host_attributes['path'] : '',
		'height'  => isset( $seed_host_attributes['height'] ) ? (int) $seed_host_attributes['height'] : 0,
		'title'   => isset( $seed_host_attributes['title'] ) ? (string) $seed_host_attributes['title'] : '',
		'wrapper' => get_block_wrapper_attributes(),
	)
);
// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- render() escapes every value it emits.
echo $seed_host_html;
