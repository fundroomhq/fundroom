<?php
/**
 * A stand-in portal for `tests/run.php`, served by `php -S`. Development only; not shipped.
 *
 * @package SeedHost
 * @license GPL-2.0-or-later
 *
 * FundRoom — WordPress plugin. Copyright (C) 2026 FundRoom contributors.
 * This program is free software; you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation; either version 2 of
 * the License, or (at your option) any later version. See LICENSE for the full text.
 */

// phpcs:disable WordPress.Security, WordPress.WP.AlternativeFunctions, WordPress.PHP.DiscouragedPHPFunctions, WordPress.PHP.NoSilencedErrors -- a test fixture under `php -S`, never loaded by WordPress.

if ( 'cli-server' !== PHP_SAPI ) {
	exit;
}

$seed_host_path = (string) parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );

if ( '/base/echo' === $seed_host_path ) {
	$seed_host_body = file_get_contents( 'php://input' );
	$seed_host_out  = (string) json_encode(
		array(
			'method'  => $_SERVER['REQUEST_METHOD'],
			'uri'     => $_SERVER['REQUEST_URI'],
			'headers' => array_change_key_case( getallheaders(), CASE_LOWER ),
			'length'  => strlen( $seed_host_body ),
			'sha256'  => hash( 'sha256', $seed_host_body ),
		)
	);
	header( 'Content-Type: application/json' );
	header( 'Content-Length: ' . strlen( $seed_host_out ) );
	echo $seed_host_out;
	return true;
}

if ( '/base/redirect' === $seed_host_path ) {
	http_response_code( 302 );
	header( 'Location: http://' . $_SERVER['HTTP_HOST'] . '/base/next?x=1' );
	header( 'Set-Cookie: __Secure-sid=a; Path=/investors; Secure; HttpOnly', false );
	header( 'Set-Cookie: __Secure-did=b; Path=/investors; Secure; HttpOnly', false );
	header( 'Cache-Control: no-store' );
	return true;
}

if ( '/base/next' === $seed_host_path ) {
	echo 'followed';
	return true;
}

if ( '/base/big' === $seed_host_path ) {
	$seed_host_chunk = str_repeat( 'x', 1024 * 1024 );
	$seed_host_count = 20;
	header( 'Content-Type: application/octet-stream' );
	header( 'Content-Length: ' . ( strlen( $seed_host_chunk ) * $seed_host_count ) );
	for ( $seed_host_i = 0; $seed_host_i < $seed_host_count; $seed_host_i++ ) {
		echo $seed_host_chunk;
		flush();
	}
	return true;
}

http_response_code( 404 );
echo 'not found';
return true;
