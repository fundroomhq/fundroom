/**
 * Editor script for the `seed-host/portal` block.
 *
 * FundRoom — WordPress plugin. Copyright (C) 2026 FundRoom contributors.
 * This program is free software; you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation; either version 2 of
 * the License, or (at your option) any later version. See LICENSE for the full text.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * Deliberately plain ES5 against the `wp.*` globals, with no build step and no JSX:
 *
 *  - wp.org review reads shipped JavaScript, and a reviewer should be able to read this file and
 *    see that it registers a block and nothing else. A bundle means also shipping and explaining
 *    the sources it was built from.
 *  - The block is server-rendered, so the editor needs a settings panel and a placeholder —
 *    roughly eighty lines. A toolchain to produce eighty lines is a toolchain to keep working.
 *  - The dependency list lives in `index.asset.php`, which is what `register_block_type()` reads.
 *
 * The placeholder does not render a live portal. Rendering one in the editor would mean minting a
 * handoff assertion into an editor preview — a 60-second bearer token in a REST response, cached
 * by the block editor — for a preview of a frame nobody is going to read while editing.
 */

( function ( blocks, element, blockEditor, components, i18n ) {
	'use strict';

	if ( ! blocks || ! element || ! blockEditor || ! components ) {
		return;
	}

	// Note for future edits: `__next40pxDefaultSize` is not passed to these controls. It only
	// exists in @wordpress/components from WP 6.6, and on 6.4/6.5 TextControl forwards unknown
	// props straight to the <input>, where React logs an unknown-attribute warning.
	var el = element.createElement;
	var __ = i18n && i18n.__ ? i18n.__ : function ( text ) { return text; };
	var sprintf = i18n && i18n.sprintf ? i18n.sprintf : function ( format, value ) {
		return String( format ).replace( '%s', value );
	};

	blocks.registerBlockType( 'seed-host/portal', {
		edit: function ( props ) {
			var attributes = props.attributes || {};
			var setAttributes = props.setAttributes;
			var blockProps = blockEditor.useBlockProps();

			var inspector = el(
				blockEditor.InspectorControls,
				null,
				el(
					components.PanelBody,
					{ title: __( 'Portal', 'seed-host' ), initialOpen: true },
					el( components.TextControl, {
						label: __( 'Page', 'seed-host' ),
						help: __( 'A path inside the portal, such as /updates. Leave empty to use the default from Settings → FundRoom.', 'seed-host' ),
						value: attributes.path || '',
						placeholder: '/updates',
						__nextHasNoMarginBottom: true,
						onChange: function ( value ) {
							setAttributes( { path: value } );
						},
					} ),
					el( components.TextControl, {
						label: __( 'Height (pixels)', 'seed-host' ),
						help: __( 'Space reserved before the portal reports its own height. Leave empty to use the default.', 'seed-host' ),
						type: 'number',
						min: 120,
						max: 5000,
						step: 10,
						value: attributes.height ? String( attributes.height ) : '',
						__nextHasNoMarginBottom: true,
						onChange: function ( value ) {
							var parsed = parseInt( value, 10 );
							setAttributes( { height: isNaN( parsed ) ? 0 : parsed } );
						},
					} ),
					el( components.TextControl, {
						label: __( 'Frame title', 'seed-host' ),
						help: __( 'Describes the embedded portal to screen readers. Leave empty for the default.', 'seed-host' ),
						value: attributes.title || '',
						__nextHasNoMarginBottom: true,
						onChange: function ( value ) {
							setAttributes( { title: value } );
						},
					} )
				)
			);

			var summary = attributes.path
				? /* translators: %s: a path inside the portal, such as /updates. */
					sprintf( __( 'Opens at %s', 'seed-host' ), attributes.path )
				: __( 'Opens at the page set in Settings → FundRoom.', 'seed-host' );

			var placeholder = el(
				components.Placeholder,
				{
					icon: 'chart-line',
					label: __( 'Investor portal', 'seed-host' ),
					instructions: __(
						'Your investor portal is loaded here when someone views this page. Connect a portal in Settings → FundRoom.',
						'seed-host'
					),
				},
				el( 'p', null, summary )
			);

			return el( 'div', blockProps, inspector, placeholder );
		},
		// No `save`: the block is rendered by `render.php` on every request, so there is nothing
		// to store in post content.
		save: function () {
			return null;
		},
	} );
} )(
	( window.wp || {} ).blocks,
	( window.wp || {} ).element,
	( window.wp || {} ).blockEditor,
	( window.wp || {} ).components,
	( window.wp || {} ).i18n
);
