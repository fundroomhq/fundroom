/*
 * Settings screen helper: the copy buttons next to the handoff key id and public key.
 *
 * FundRoom — WordPress plugin. Copyright (C) 2026 FundRoom contributors.
 * This program is free software; you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation; either version 2 of
 * the License, or (at your option) any later version. See LICENSE for the full text.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 *
 * A file rather than an inline script so the admin page needs no `script-src 'unsafe-inline'`, and
 * so this is the only JavaScript wp-admin loads on our behalf. It reads two `data-` attributes and
 * touches nothing else — no network, no storage, no globals.
 */

( function () {
	'use strict';

	function label( button, text ) {
		var original = button.textContent;
		button.textContent = text;
		window.setTimeout( function () {
			button.textContent = original;
		}, 2000 );
	}

	function copy( input ) {
		if ( window.navigator && window.navigator.clipboard && window.navigator.clipboard.writeText ) {
			return window.navigator.clipboard.writeText( input.value );
		}
		// Insecure context, or an older browser: select the field so the keyboard shortcut works.
		input.focus();
		input.select();
		return Promise.reject( new Error( 'clipboard unavailable' ) );
	}

	document.addEventListener( 'click', function ( event ) {
		var button = event.target instanceof Element ? event.target.closest( '.seed-host-copy' ) : null;
		if ( ! button ) {
			return;
		}
		var input = document.getElementById( button.getAttribute( 'data-seed-host-copy' ) || '' );
		if ( ! input ) {
			return;
		}
		event.preventDefault();
		copy( input ).then(
			function () {
				label( button, button.getAttribute( 'data-seed-host-copied' ) || 'Copied' );
			},
			function () {
				// Nothing to report: the field is selected and the value is on screen either way.
			}
		);
	} );
} )();
