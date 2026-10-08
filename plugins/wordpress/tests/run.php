<?php
/**
 * Tests for proxy mode that need no WordPress: the pure rules, and the cURL transfer against a
 * stand-in portal served by `php -S`. Development only; not shipped.
 *
 * Run: `composer test` (or `php tests/run.php`). Exit status 0 when every assertion holds.
 *
 * @package SeedHost
 * @license GPL-2.0-or-later
 *
 * FundRoom — WordPress plugin. Copyright (C) 2026 FundRoom contributors.
 * This program is free software; you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation; either version 2 of
 * the License, or (at your option) any later version. See LICENSE for the full text.
 */

// phpcs:disable WordPress.Security.EscapeOutput, WordPress.WP.AlternativeFunctions, WordPress.PHP.DiscouragedPHPFunctions, WordPress.PHP.DevelopmentFunctions, WordPress.WP.GlobalVariablesOverride -- a CLI test runner, never loaded by WordPress.

if ( 'cli' !== PHP_SAPI ) {
	exit;
}

define( 'ABSPATH', __DIR__ . '/' );
require dirname( __DIR__ ) . '/includes/class-proxy-rules.php';
require dirname( __DIR__ ) . '/includes/class-proxy.php';

$seed_host_failures = 0;
$seed_host_passes   = 0;

/**
 * One assertion.
 *
 * @param string $name     What is being checked.
 * @param mixed  $actual   Value produced.
 * @param mixed  $expected Value wanted.
 */
function seed_host_check( string $name, $actual, $expected ): void {
	global $seed_host_failures, $seed_host_passes;
	if ( $actual === $expected ) {
		++$seed_host_passes;
		return;
	}
	++$seed_host_failures;
	fwrite( STDOUT, "FAIL {$name}\n  expected: " . var_export( $expected, true ) . "\n  actual:   " . var_export( $actual, true ) . "\n" );
}

// --- Prefix validation -------------------------------------------------------------------------

$seed_host_prefixes = array(
	'/investors'          => '/investors',
	'/investors/'         => '/investors',
	' /investors '        => '/investors',
	'/ir/portal'          => '/ir/portal',
	'/a.b_c~d-e'          => '/a.b_c~d-e',
	''                    => '',
	'/'                   => '',
	'investors'           => '',
	'//investors'         => '',
	'/investors//x'       => '',
	'/in vestors'         => '',
	'/investors?x=1'      => '',
	'/%69nvestors'        => '',
	'/..'                 => '',
	'/x/../wp-admin'      => '',
	'/x/./y'              => '',
	'/wp-admin'           => '',
	'/WP-Admin'           => '',
	'/wp-admin/investors' => '',
	'/wp-json'            => '',
	'/wp-content'         => '',
	'/wp-includes'        => '',
	'/wp-login.php'       => '',
	'/xmlrpc.php'         => '',
	'/feed'               => '',
	'/.well-known'        => '',
	'/wp-adminx'          => '/wp-adminx',
);
foreach ( $seed_host_prefixes as $seed_host_in => $seed_host_want ) {
	seed_host_check( "validate_prefix('{$seed_host_in}')", Seed_Host_Proxy_Rules::validate_prefix( (string) $seed_host_in ), $seed_host_want );
}
seed_host_check( 'validate_prefix(too long)', Seed_Host_Proxy_Rules::validate_prefix( '/' . str_repeat( 'a', 250 ) ), '' );

seed_host_check( 'clamp_body_mb(0)', Seed_Host_Proxy_Rules::clamp_body_mb( 0 ), 25 );
seed_host_check( 'clamp_body_mb(5)', Seed_Host_Proxy_Rules::clamp_body_mb( 5 ), 5 );
seed_host_check( 'clamp_body_mb(99999)', Seed_Host_Proxy_Rules::clamp_body_mb( 99999 ), 1024 );

// --- Path matching -----------------------------------------------------------------------------

seed_host_check( 'match exact', Seed_Host_Proxy_Rules::match_prefix( '/investors', '/investors' ), '' );
seed_host_check( 'match slash', Seed_Host_Proxy_Rules::match_prefix( '/investors/', '/investors' ), '/' );
seed_host_check( 'match deep', Seed_Host_Proxy_Rules::match_prefix( '/investors/a/b', '/investors' ), '/a/b' );
seed_host_check( 'no match sibling', Seed_Host_Proxy_Rules::match_prefix( '/investorsx', '/investors' ), null );
seed_host_check( 'no match case', Seed_Host_Proxy_Rules::match_prefix( '/Investors', '/investors' ), null );
seed_host_check( 'no match encoded', Seed_Host_Proxy_Rules::match_prefix( '/%69nvestors/x', '/investors' ), null );
seed_host_check( 'no match root', Seed_Host_Proxy_Rules::match_prefix( '/', '/investors' ), null );
seed_host_check( 'no match empty prefix', Seed_Host_Proxy_Rules::match_prefix( '/x', '' ), null );

$seed_host_rests = array(
	''                  => true,
	'/'                 => true,
	'/assets/app-1a.js' => true,
	'/api/v1/me'        => true,
	'/a%20b'            => true,
	'/..'               => false,
	'/../internal/x'    => false,
	'/a/../../internal' => false,
	'/./x'              => false,
	'/%2e%2e/internal'  => false,
	'/%2E%2E/internal'  => false,
	'/%252e%252e/x'     => false,
	'/a\\..\\b'         => false,
	"/a\nb"             => false,
	'/a b'              => false,
	'/%00'              => false,
	'x'                 => false,
);
foreach ( $seed_host_rests as $seed_host_in => $seed_host_want ) {
	seed_host_check( 'is_safe_rest(' . json_encode( (string) $seed_host_in ) . ')', Seed_Host_Proxy_Rules::is_safe_rest( (string) $seed_host_in ), $seed_host_want );
}

// --- Cookie filter -----------------------------------------------------------------------------

seed_host_check(
	'cookie filter keeps only portal cookies',
	Seed_Host_Proxy_Rules::filter_cookie_header(
		'wordpress_logged_in_abc=admin%7C123; __Secure-sid=S1; host_session=secret; wp-settings-1=x; __Host-did=D; '
		. '__Secure-auth_req=A; __Host-oidc_req=O;__Secure-sso_req=SS; __Secure-sh_intg=I; sid=bare; __Secure-sidx=no; '
		. 'wordpress_sec_abc=z; __secure-sid=lower; comment_author_x=y; __Secure-other=o'
	),
	'__Secure-sid=S1; __Host-did=D; __Secure-auth_req=A; __Host-oidc_req=O; __Secure-sso_req=SS; __Secure-sh_intg=I'
);
seed_host_check( 'cookie filter empty', Seed_Host_Proxy_Rules::filter_cookie_header( '' ), '' );
seed_host_check( 'cookie filter none left', Seed_Host_Proxy_Rules::filter_cookie_header( 'wordpress_test_cookie=WP; host_session=secret' ), '' );
seed_host_check( 'cookie filter no name', Seed_Host_Proxy_Rules::filter_cookie_header( '=__Secure-sid; __Secure-sid' ), '' );
seed_host_check( 'is_portal_cookie __Host-sid', Seed_Host_Proxy_Rules::is_portal_cookie( '__Host-sid' ), true );
seed_host_check( 'is_portal_cookie WordPress', Seed_Host_Proxy_Rules::is_portal_cookie( 'wordpress_logged_in_x' ), false );

// --- Request headers ---------------------------------------------------------------------------

$seed_host_forwarded = Seed_Host_Proxy_Rules::forward_request_headers(
	array(
		'accept'          => 'text/html',
		'cookie'          => 'wordpress_logged_in=x',
		'host'            => 'wp.test',
		'authorization'   => 'Bearer frk_' . str_repeat( 'k', 43 ),
		'x-wp-nonce'      => 'n',
		'accept-encoding' => 'gzip',
		'origin'          => 'https://wp.test',
		'upload-offset'   => '0',
		'referer'         => "https://wp.test/\r\nX-Evil: 1",
		'connection'      => 'keep-alive',
	)
);
seed_host_check(
	'request header allow-list',
	$seed_host_forwarded,
	array(
		'accept'        => 'text/html',
		'authorization' => 'Bearer frk_' . str_repeat( 'k', 43 ),
		'origin'        => 'https://wp.test',
		'upload-offset' => '0',
	)
);
$seed_host_key  = 'frk_' . str_repeat( 'A', 42 ) . '_';
$seed_host_auth = array(
	'Bearer ' . $seed_host_key               => true,
	'bearer  ' . $seed_host_key . ' '        => true,
	'Basic YWRtaW46YWRtaW4='                 => false,
	'Bearer other-service-token'             => false,
	'Bearer frk_short'                       => false,
	'Bearer shk_short'                       => false,
	'Bearer ' . $seed_host_key . 'x'         => false,
	'Bearer ' . $seed_host_key . ', Basic x' => false,
	$seed_host_key                           => false,
	'Bearer frs_' . str_repeat( 'b', 43 )    => true,
	'BEARER frs_' . str_repeat( 'b', 43 )    => true,
	// Tokens minted before the FundRoom rename (A-2) still reach the portal.
	'Bearer shk_' . str_repeat( 'A', 43 )    => true,
	'Bearer shs_' . str_repeat( 'b', 43 )    => true,
	'BEARER shs_' . str_repeat( 'b', 43 )    => true,
	'Bearer FRK_' . str_repeat( 'b', 43 )    => false,
	'Bearer SHK_' . str_repeat( 'b', 43 )    => false,
	'Bearer Frs_' . str_repeat( 'b', 43 )    => false,
	'Bearer Shs_' . str_repeat( 'b', 43 )    => false,
	'Bearer shx_' . str_repeat( 'b', 43 )    => false,
	'Bearer frx_' . str_repeat( 'b', 43 )    => false,
	'Bearer fhk_' . str_repeat( 'b', 43 )    => false,
);
foreach ( $seed_host_auth as $seed_host_in => $seed_host_want ) {
	$seed_host_got = Seed_Host_Proxy_Rules::forward_request_headers( array( 'authorization' => (string) $seed_host_in ) );
	seed_host_check( 'authorization forwarded? ' . $seed_host_in, isset( $seed_host_got['authorization'] ), $seed_host_want );
}
// Vendor webhooks under <prefix>/webhooks/: their auth and signature headers go through.
$seed_host_hook_in   = array(
	'authorization'              => 'Basic cG9zdG1hcms6c2VjcmV0',
	'svix-id'                    => 'msg_1',
	'svix-timestamp'             => '1700000000',
	'svix-signature'             => 'v1,abc',
	'webhook-id'                 => 'w1',
	'webhook-timestamp'          => '1700000000',
	'webhook-signature'          => 'v1,def',
	'parallel-timestamp'         => '1',
	'parallel-signature'         => 'p',
	'x-signature-sha256'         => 's',
	'x-documenso-secret'         => 'd',
	'x-fundroom-signature'       => 'f',
	'x-seedhost-signature'       => 'q',
	'x-cal-signature-256'        => 'c',
	'calendly-webhook-signature' => 't=1,v1=x',
	'x-docusign-signature-1'     => 'ds1',
	'x-docusign-signature-2'     => 'ds2',
	'x-docusign-signature-101'   => 'no',
	'content-type'               => 'application/json',
	'cookie'                     => 'wordpress_logged_in=x',
	'x-wp-nonce'                 => 'n',
);
$seed_host_hook_out  = Seed_Host_Proxy_Rules::forward_request_headers( $seed_host_hook_in, '/webhooks/email/postmark' );
$seed_host_hook_want = $seed_host_hook_in;
unset( $seed_host_hook_want['x-docusign-signature-101'], $seed_host_hook_want['cookie'], $seed_host_hook_want['x-wp-nonce'] );
ksort( $seed_host_hook_out );
ksort( $seed_host_hook_want );
seed_host_check( 'webhook path forwards vendor headers + any Authorization', $seed_host_hook_out, $seed_host_hook_want );
$seed_host_page_out = Seed_Host_Proxy_Rules::forward_request_headers( $seed_host_hook_in, '/home' );
seed_host_check( 'non-webhook path drops vendor headers and Basic auth', $seed_host_page_out, array( 'content-type' => 'application/json' ) );
seed_host_check( 'api webhooks path is not a vendor webhook', Seed_Host_Proxy_Rules::is_webhook_path( '/api/v1/webhooks/endpoints' ), false );
seed_host_check( 'webhooks root without slash is not a webhook path', Seed_Host_Proxy_Rules::is_webhook_path( '/webhooks' ), false );
seed_host_check( 'esign callback is a webhook path', Seed_Host_Proxy_Rules::is_webhook_path( '/webhooks/esign/0f8c' ), true );
seed_host_check( 'xff append', Seed_Host_Proxy_Rules::append_forwarded_for( '203.0.113.9', '10.0.0.2' ), '203.0.113.9, 10.0.0.2' );
seed_host_check( 'xff fresh', Seed_Host_Proxy_Rules::append_forwarded_for( '', '2001:db8::1' ), '2001:db8::1' );
seed_host_check( 'xff bad peer', Seed_Host_Proxy_Rules::append_forwarded_for( '1.2.3.4', 'evil host' ), '1.2.3.4' );

// --- Response headers --------------------------------------------------------------------------

seed_host_check( 'drop transfer-encoding', Seed_Host_Proxy_Rules::response_header_allowed( 'Transfer-Encoding' ), false );
seed_host_check( 'drop connection', Seed_Host_Proxy_Rules::response_header_allowed( 'Connection' ), false );
seed_host_check( 'drop keep-alive', Seed_Host_Proxy_Rules::response_header_allowed( 'keep-alive' ), false );
seed_host_check( 'drop connection-named', Seed_Host_Proxy_Rules::response_header_allowed( 'X-Hop', Seed_Host_Proxy_Rules::connection_tokens( 'close, X-Hop' ) ), false );
seed_host_check( 'drop strict-transport-security', Seed_Host_Proxy_Rules::response_header_allowed( 'Strict-Transport-Security' ), false );
seed_host_check( 'drop alt-svc', Seed_Host_Proxy_Rules::response_header_allowed( 'Alt-Svc' ), false );
seed_host_check( 'keep set-cookie', Seed_Host_Proxy_Rules::response_header_allowed( 'Set-Cookie' ), true );
seed_host_check( 'keep csp', Seed_Host_Proxy_Rules::response_header_allowed( 'Content-Security-Policy' ), true );
seed_host_check( 'keep content-disposition', Seed_Host_Proxy_Rules::response_header_allowed( 'Content-Disposition' ), true );
seed_host_check( 'keep content-range', Seed_Host_Proxy_Rules::response_header_allowed( 'Content-Range' ), true );
seed_host_check( 'reject bad name', Seed_Host_Proxy_Rules::response_header_allowed( 'Bad Name' ), false );

seed_host_check( 'vary merge', Seed_Host_Proxy_Rules::merge_vary( 'Cookie, X-Forwarded-Prefix', array( 'Cookie' ) ), 'Cookie, X-Forwarded-Prefix' );
seed_host_check( 'vary add', Seed_Host_Proxy_Rules::merge_vary( 'Accept-Encoding', array( 'Cookie' ) ), 'Accept-Encoding, Cookie' );
seed_host_check( 'vary empty', Seed_Host_Proxy_Rules::merge_vary( '', array( 'Cookie' ) ), 'Cookie' );
seed_host_check( 'vary star', Seed_Host_Proxy_Rules::merge_vary( '*', array( 'Cookie' ) ), '*' );

seed_host_check( 'cache immutable asset', Seed_Host_Proxy_Rules::upstream_cache_allowed( 200, 'public, max-age=31536000, immutable', false ), true );
seed_host_check( 'cache immutable with cookie', Seed_Host_Proxy_Rules::upstream_cache_allowed( 200, 'public, max-age=31536000, immutable', true ), false );
seed_host_check( 'cache page', Seed_Host_Proxy_Rules::upstream_cache_allowed( 200, 'private, no-store', false ), false );
seed_host_check( 'cache public not immutable', Seed_Host_Proxy_Rules::upstream_cache_allowed( 200, 'public, max-age=60', false ), false );
seed_host_check( 'cache 404', Seed_Host_Proxy_Rules::upstream_cache_allowed( 404, 'public, immutable', false ), false );
seed_host_check( 'cache none', Seed_Host_Proxy_Rules::upstream_cache_allowed( 200, '', false ), false );

seed_host_check( 'status 1.1', Seed_Host_Proxy_Rules::parse_status_line( "HTTP/1.1 206 Partial Content\r\n" ), 206 );
seed_host_check( 'status 2', Seed_Host_Proxy_Rules::parse_status_line( "HTTP/2 204\r\n" ), 204 );
seed_host_check( 'status header', Seed_Host_Proxy_Rules::parse_status_line( "Content-Type: x\r\n" ), 0 );

// --- Location rewrite --------------------------------------------------------------------------

$seed_host_up  = 'https://portal.test/investors';
$seed_host_pub = 'https://wp.test/investors';
$seed_host_loc = array(
	'https://portal.test/investors/home'         => 'https://wp.test/investors/home',
	'https://portal.test/investors'              => 'https://wp.test/investors',
	'https://portal.test/investors/'             => 'https://wp.test/investors/',
	'https://portal.test/investors?x=1'          => 'https://wp.test/investors?x=1',
	'https://PORTAL.test:443/investors/a'        => 'https://wp.test/investors/a',
	'https://portal.test/investors-old/a'        => 'https://portal.test/investors-old/a',
	'https://portal.test/other'                  => 'https://portal.test/other',
	'http://portal.test/investors/a'             => 'http://portal.test/investors/a',
	'https://idp.example/authorize?x=1'          => 'https://idp.example/authorize?x=1',
	'/investors/home'                            => '/investors/home',
	'home'                                       => 'home',
	'https://user@portal.test/investors/a'       => 'https://user@portal.test/investors/a',
	'https://portal.test.evil.example/investors' => 'https://portal.test.evil.example/investors',
);
foreach ( $seed_host_loc as $seed_host_in => $seed_host_want ) {
	seed_host_check( "rewrite_location({$seed_host_in})", Seed_Host_Proxy_Rules::rewrite_location( (string) $seed_host_in, $seed_host_up, $seed_host_pub ), $seed_host_want );
}
seed_host_check( 'rewrite_location root upstream', Seed_Host_Proxy_Rules::rewrite_location( 'https://portal.test/x?y', 'https://portal.test', 'https://wp.test/ir' ), 'https://wp.test/ir/x?y' );
seed_host_check( 'rewrite_location root upstream bare', Seed_Host_Proxy_Rules::rewrite_location( 'https://portal.test', 'https://portal.test', 'https://wp.test/ir' ), 'https://wp.test/ir' );

// --- Upstream policy ---------------------------------------------------------------------------

seed_host_check( 'upstream https', Seed_Host_Proxy_Rules::upstream_allowed( 'https://portal.example.com/x' ), true );
seed_host_check( 'upstream http public', Seed_Host_Proxy_Rules::upstream_allowed( 'http://portal.example.com' ), false );
seed_host_check( 'upstream http localhost', Seed_Host_Proxy_Rules::upstream_allowed( 'http://localhost:3000' ), true );
seed_host_check( 'upstream http 127', Seed_Host_Proxy_Rules::upstream_allowed( 'http://127.0.0.1:3000/investors' ), true );
seed_host_check( 'upstream http ::1', Seed_Host_Proxy_Rules::upstream_allowed( 'http://[::1]:3000' ), true );
seed_host_check( 'upstream http .test', Seed_Host_Proxy_Rules::upstream_allowed( 'http://portal.test' ), true );
seed_host_check( 'upstream http .localhost', Seed_Host_Proxy_Rules::upstream_allowed( 'http://app.localhost' ), true );
seed_host_check( 'upstream http testing.com', Seed_Host_Proxy_Rules::upstream_allowed( 'http://portal.testing.com' ), false );
seed_host_check( 'upstream http dev env', Seed_Host_Proxy_Rules::upstream_allowed( 'http://app:3000', 'development' ), true );
seed_host_check( 'upstream ftp', Seed_Host_Proxy_Rules::upstream_allowed( 'ftp://portal.test', 'local' ), false );

// --- Transfer against a stand-in portal --------------------------------------------------------

if ( ! function_exists( 'curl_init' ) || ! function_exists( 'proc_open' ) ) {
	fwrite( STDOUT, "SKIP transfer tests: needs ext-curl and proc_open\n" );
} else {
	$seed_host_port = 18000 + ( getmypid() % 2000 );
	$seed_host_proc = proc_open(
		array( PHP_BINARY, '-S', '127.0.0.1:' . $seed_host_port, __DIR__ . '/upstream.php' ),
		array(
			0 => array( 'pipe', 'r' ),
			1 => array( 'file', '/dev/null', 'w' ),
			2 => array( 'file', '/dev/null', 'w' ),
		),
		$seed_host_pipes
	);
	$seed_host_base = 'http://127.0.0.1:' . $seed_host_port . '/base';
	for ( $seed_host_i = 0; $seed_host_i < 50; $seed_host_i++ ) {
		// phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged -- polling until the server is up; failure is expected.
		$seed_host_sock = @fsockopen( '127.0.0.1', $seed_host_port );
		if ( $seed_host_sock ) {
			fclose( $seed_host_sock );
			break;
		}
		usleep( 100000 );
	}

	/**
	 * One exchange, collecting what the proxy would emit.
	 *
	 * @param array<string, mixed> $request Overrides.
	 * @return array{status: int, headers: array<int, array{0: string, 1: string}>, body: string, chunks: int, head_first: bool, result: array<string, mixed>}
	 */
	function seed_host_run( array $request ): array {
		$out           = array(
			'status'     => 0,
			'headers'    => array(),
			'body'       => '',
			'chunks'     => 0,
			'head_first' => true,
		);
		$request       = array_merge(
			array(
				'method'  => 'GET',
				'headers' => array(),
				'body'    => null,
				'length'  => 0,
				'ca_file' => '',
				'timeout' => 30,
			),
			$request
		);
		$result        = Seed_Host_Proxy::transfer(
			$request,
			static function ( int $status, array $headers ) use ( &$out ): void {
				$out['status']  = $status;
				$out['headers'] = $headers;
			},
			static function ( string $data ) use ( &$out ): bool {
				if ( 0 === $out['status'] ) {
					$out['head_first'] = false;
				}
				++$out['chunks'];
				$out['body'] .= $data;
				return true;
			}
		);
		$out['result'] = $result;
		if ( 0 === $out['status'] ) {
			$out['status']  = $result['status'];
			$out['headers'] = $result['headers'];
		}
		return $out;
	}

	/**
	 * Values of one response header, case-insensitively.
	 *
	 * @param array<int, array{0: string, 1: string}> $headers Headers.
	 * @param string                                  $name    Name.
	 * @return array<int, string>
	 */
	function seed_host_header_values( array $headers, string $name ): array {
		$values = array();
		foreach ( $headers as $header ) {
			if ( strtolower( $header[0] ) === strtolower( $name ) ) {
				$values[] = $header[1];
			}
		}
		return $values;
	}

	// GET with query and forwarded headers.
	$seed_host_r    = seed_host_run(
		array(
			'url'     => $seed_host_base . '/echo?a=1&b=%2F',
			'headers' => array(
				'x-forwarded-prefix' => '/investors',
				'cookie'             => '__Secure-sid=S1',
			),
		)
	);
	$seed_host_echo = json_decode( $seed_host_r['body'], true );
	seed_host_check( 'GET status', $seed_host_r['status'], 200 );
	seed_host_check( 'GET error', $seed_host_r['result']['error'], '' );
	seed_host_check( 'GET uri preserved', $seed_host_echo['uri'] ?? null, '/base/echo?a=1&b=%2F' );
	seed_host_check( 'GET prefix header', $seed_host_echo['headers']['x-forwarded-prefix'] ?? null, '/investors' );
	seed_host_check( 'GET cookie', $seed_host_echo['headers']['cookie'] ?? null, '__Secure-sid=S1' );
	seed_host_check( 'GET no expect', isset( $seed_host_echo['headers']['expect'] ), false );
	seed_host_check( 'GET no accept-encoding', isset( $seed_host_echo['headers']['accept-encoding'] ), false );

	// POST body streamed from a spooled stream.
	$seed_host_payload = str_repeat( '{"k":"v"}', 300000 );
	$seed_host_stream  = fopen( 'php://temp', 'w+b' );
	fwrite( $seed_host_stream, $seed_host_payload );
	$seed_host_r    = seed_host_run(
		array(
			'method'  => 'POST',
			'url'     => $seed_host_base . '/echo',
			'headers' => array( 'content-type' => 'application/json' ),
			'body'    => $seed_host_stream,
			'length'  => strlen( $seed_host_payload ),
		)
	);
	$seed_host_echo = json_decode( $seed_host_r['body'], true );
	seed_host_check( 'POST method', $seed_host_echo['method'] ?? null, 'POST' );
	seed_host_check( 'POST length', $seed_host_echo['length'] ?? null, strlen( $seed_host_payload ) );
	seed_host_check( 'POST sha256', $seed_host_echo['sha256'] ?? null, hash( 'sha256', $seed_host_payload ) );
	seed_host_check( 'POST content-type', $seed_host_echo['headers']['content-type'] ?? null, 'application/json' );

	// Empty-bodied POST still says Content-Length: 0.
	$seed_host_empty = fopen( 'php://temp', 'w+b' );
	$seed_host_r     = seed_host_run(
		array(
			'method' => 'POST',
			'url'    => $seed_host_base . '/echo',
			'body'   => $seed_host_empty,
			'length' => 0,
		)
	);
	$seed_host_echo  = json_decode( $seed_host_r['body'], true );
	seed_host_check( 'empty POST method', $seed_host_echo['method'] ?? null, 'POST' );
	seed_host_check( 'empty POST content-length', $seed_host_echo['headers']['content-length'] ?? null, '0' );
	seed_host_check( 'empty POST no form content-type', isset( $seed_host_echo['headers']['content-type'] ), false );

	// PATCH (tus) and DELETE.
	$seed_host_patch = fopen( 'php://temp', 'w+b' );
	fwrite( $seed_host_patch, 'abc' );
	$seed_host_r    = seed_host_run(
		array(
			'method'  => 'PATCH',
			'url'     => $seed_host_base . '/echo',
			'headers' => array(
				'content-type'  => 'application/offset+octet-stream',
				'upload-offset' => '0',
			),
			'body'    => $seed_host_patch,
			'length'  => 3,
		)
	);
	$seed_host_echo = json_decode( $seed_host_r['body'], true );
	seed_host_check( 'PATCH method', $seed_host_echo['method'] ?? null, 'PATCH' );
	seed_host_check( 'PATCH length', $seed_host_echo['length'] ?? null, 3 );
	seed_host_check( 'PATCH upload-offset', $seed_host_echo['headers']['upload-offset'] ?? null, '0' );
	$seed_host_r    = seed_host_run(
		array(
			'method' => 'DELETE',
			'url'    => $seed_host_base . '/echo',
		)
	);
	$seed_host_echo = json_decode( $seed_host_r['body'], true );
	seed_host_check( 'DELETE method', $seed_host_echo['method'] ?? null, 'DELETE' );

	// HEAD: status and headers, no body.
	$seed_host_r = seed_host_run(
		array(
			'method' => 'HEAD',
			'url'    => $seed_host_base . '/echo',
		)
	);
	seed_host_check( 'HEAD status', $seed_host_r['status'], 200 );
	seed_host_check( 'HEAD body', $seed_host_r['body'], '' );
	seed_host_check( 'HEAD content-type', seed_host_header_values( $seed_host_r['headers'], 'content-type' ), array( 'application/json' ) );

	// Redirects are passed through, not followed; every Set-Cookie survives.
	$seed_host_r = seed_host_run( array( 'url' => $seed_host_base . '/redirect' ) );
	seed_host_check( 'redirect status', $seed_host_r['status'], 302 );
	seed_host_check( 'redirect not followed', false !== strpos( $seed_host_r['body'], 'followed' ), false );
	seed_host_check( 'redirect location', seed_host_header_values( $seed_host_r['headers'], 'location' ), array( 'http://127.0.0.1:' . $seed_host_port . '/base/next?x=1' ) );
	seed_host_check( 'redirect set-cookie count', count( seed_host_header_values( $seed_host_r['headers'], 'set-cookie' ) ), 2 );
	seed_host_check(
		'redirect location rewritten',
		Seed_Host_Proxy_Rules::rewrite_location( seed_host_header_values( $seed_host_r['headers'], 'location' )[0] ?? '', $seed_host_base, 'https://wp.test/investors' ),
		'https://wp.test/investors/next?x=1'
	);

	// 20 MB streamed in chunks, head before body, without holding it all in memory.
	$seed_host_before = memory_get_usage();
	$seed_host_peak   = 0;
	$seed_host_bytes  = 0;
	$seed_host_chunks = 0;
	$seed_host_status = 0;
	$seed_host_first  = true;
	$seed_host_result = Seed_Host_Proxy::transfer(
		array(
			'method'  => 'GET',
			'url'     => $seed_host_base . '/big',
			'headers' => array(),
			'body'    => null,
			'length'  => 0,
			'ca_file' => '',
			'timeout' => 60,
		),
		static function ( int $status ) use ( &$seed_host_status ): void {
			$seed_host_status = $status;
		},
		static function ( string $data ) use ( &$seed_host_bytes, &$seed_host_chunks, &$seed_host_peak, &$seed_host_status, &$seed_host_first ): bool {
			if ( 0 === $seed_host_status ) {
				$seed_host_first = false;
			}
			$seed_host_bytes += strlen( $data );
			++$seed_host_chunks;
			$seed_host_peak = max( $seed_host_peak, memory_get_usage() );
			return true;
		}
	);
	seed_host_check( 'stream status', $seed_host_status, 200 );
	seed_host_check( 'stream head first', $seed_host_first, true );
	seed_host_check( 'stream bytes', $seed_host_bytes, 20 * 1024 * 1024 );
	seed_host_check( 'stream in many chunks', $seed_host_chunks > 20, true );
	seed_host_check( 'stream memory bounded (< 4 MB growth)', ( $seed_host_peak - $seed_host_before ) < 4 * 1024 * 1024, true );

	// Abort: returning false from the chunk callback stops the transfer.
	$seed_host_seen   = 0;
	$seed_host_result = Seed_Host_Proxy::transfer(
		array(
			'method'  => 'GET',
			'url'     => $seed_host_base . '/big',
			'headers' => array(),
			'body'    => null,
			'length'  => 0,
			'ca_file' => '',
			'timeout' => 60,
		),
		static function (): void {},
		static function ( string $data ) use ( &$seed_host_seen ): bool {
			$seed_host_seen += strlen( $data );
			return false;
		}
	);
	seed_host_check( 'abort stops early', $seed_host_seen < 20 * 1024 * 1024, true );
	seed_host_check( 'abort reports an error', '' !== $seed_host_result['error'], true );

	// Unreachable upstream: an error, no status, and nothing emitted.
	$seed_host_r = seed_host_run( array( 'url' => 'http://127.0.0.1:1/base/echo' ) );
	seed_host_check( 'unreachable error', '' !== $seed_host_r['result']['error'], true );
	seed_host_check( 'unreachable no status', $seed_host_r['status'], 0 );

	// Only http(s).
	$seed_host_r = seed_host_run( array( 'url' => 'file:///etc/passwd' ) );
	seed_host_check( 'file:// refused', '' !== $seed_host_r['result']['error'], true );
	seed_host_check( 'file:// no body', $seed_host_r['body'], '' );

	proc_terminate( $seed_host_proc );
	proc_close( $seed_host_proc );
}

fwrite( STDOUT, sprintf( "%d passed, %d failed\n", $seed_host_passes, $seed_host_failures ) );
exit( $seed_host_failures > 0 ? 1 : 0 );
