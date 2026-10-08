<?php
/**
 * Proxy mode: the pure rules — what is forwarded, what is refused, what is rewritten.
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
 * Every decision the proxy makes that does not need WordPress, in one class of static functions.
 *
 * Kept free of WordPress calls on purpose: `tests/run.php` loads this file on a bare `php` binary
 * and asserts on it, so the security-relevant parts — the cookie filter, the prefix validation,
 * the path check and the `Location` rewrite — are tested without a WordPress install. The glue
 * that does need WordPress (options, hooks, cURL, output) is `Seed_Host_Proxy`.
 */
final class Seed_Host_Proxy_Rules {

	/** The public path the proxy is mounted at unless an admin says otherwise. */
	const DEFAULT_PREFIX = '/investors';

	/** Request body cap, in MB, unless an admin says otherwise. */
	const DEFAULT_MAX_BODY_MB = 25;

	/** Bounds for the body cap setting, in MB. */
	const MIN_BODY_MB = 1;
	const MAX_BODY_MB = 1024;

	/**
	 * The portal's cookie basenames (`packages/identity/src/cookies/cookies.ts` COOKIE_BASENAMES,
	 * plus `OAUTH_BINDING_COOKIE` from `apps/server/src/routes/integrations-oauth.ts`). Keep in
	 * step with those two; a portal cookie missing here is a portal feature that silently stops
	 * working behind this proxy, which is the safe direction to be wrong in.
	 */
	const PORTAL_COOKIE_BASENAMES = array( 'sid', 'did', 'auth_req', 'oidc_req', 'sso_req', 'sh_intg' );

	/**
	 * First path segments WordPress (or a common WordPress setup) owns. A prefix starting with one
	 * of these would take that URL space away from WordPress, or hand WordPress URLs to the portal.
	 * Compared case-insensitively. The REST prefix is configurable, so the WordPress-aware check in
	 * `Seed_Host_Proxy` adds `rest_get_url_prefix()` to this list.
	 */
	const RESERVED_SEGMENTS = array(
		'wp-admin',
		'wp-content',
		'wp-includes',
		'wp-json',
		'wp-login.php',
		'wp-signup.php',
		'wp-activate.php',
		'wp-cron.php',
		'wp-comments-post.php',
		'wp-trackback.php',
		'wp-mail.php',
		'wp-links-opml.php',
		'wp-load.php',
		'wp-blog-header.php',
		'wp-config.php',
		'wp-settings.php',
		'wp-sitemap.xml',
		'xmlrpc.php',
		'index.php',
		'robots.txt',
		'favicon.ico',
		'sitemap.xml',
		'feed',
		'comments',
		'embed',
		'trackback',
		'page',
		'search',
		'author',
		'category',
		'tag',
		'type',
		'attachment',
		'.well-known',
	);

	/**
	 * Request headers passed to the portal. An allow-list, not a deny-list: anything WordPress, a
	 * CDN or another plugin adds on the way in stays on this side unless it is named here.
	 *
	 *  - Content negotiation, conditional and range requests: what a browser needs for pages,
	 *    JSON and resumable downloads.
	 *  - `Origin`, `Referer`, `Sec-Fetch-*`: the portal's CSRF check reads these (the mount origin
	 *    is accepted only on requests carrying our `X-Forwarded-Prefix`).
	 *  - `Authorization`: only a portal API key (`Bearer frk_…` or the pre-rename `shk_…`,
	 *    `API_KEY_TOKEN_RE` in `packages/api-keys/src/token.ts`) or SCIM token (`Bearer frs_…` or
	 *    `shs_…`, `SCIM_TOKEN_RE` in `packages/scim/src/token.ts`), see
	 *    `is_portal_authorization()`. Anything else — Basic
	 *    credentials for this site's own HTTP auth, some other service's bearer token — is this
	 *    site's business and stays here. Vendor webhooks are the exception: see
	 *    `WEBHOOK_REQUEST_HEADERS`.
	 *  - `Tus-Resumable` / `Upload-*`: data room uploads (tus) through the app.
	 *  - `Accept-Encoding` is deliberately absent: the portal then answers uncompressed and this
	 *    web server compresses as it is configured to, instead of the two disagreeing about a
	 *    `Content-Encoding` the body no longer has.
	 */
	const FORWARDED_REQUEST_HEADERS = array(
		'accept',
		'accept-language',
		'authorization',
		'content-type',
		'idempotency-key',
		'if-match',
		'if-modified-since',
		'if-none-match',
		'if-range',
		'if-unmodified-since',
		'origin',
		'range',
		'referer',
		'sec-fetch-dest',
		'sec-fetch-mode',
		'sec-fetch-site',
		'sec-fetch-user',
		'sec-gpc',
		'tus-resumable',
		'upload-concat',
		'upload-defer-length',
		'upload-length',
		'upload-metadata',
		'upload-offset',
		'user-agent',
		'x-content-sha256',
		'x-request-id',
	);

	/**
	 * Extra request headers forwarded, `Authorization` unconditionally among them, on paths under
	 * `<prefix>/webhooks/` only: the portal's vendor callbacks (`/webhooks/email|esign|
	 * accreditation|integrations/…`), whose verifiers read these. The caller there is a vendor,
	 * not a browser, and its credential is exactly what must reach the portal (Postmark sends
	 * Basic auth). Kept in step with the adapters in `packages/adapters/*`: Resend/Svix and
	 * Standard Webhooks, Parallel Markets, VerifyInvestor, Documenso, DocuSeal (as configured by
	 * the portal), Cal.com, Calendly; DocuSign's numbered `X-DocuSign-Signature-<n>` is matched by
	 * `WEBHOOK_REQUEST_HEADER_PATTERN`.
	 */
	const WEBHOOK_REQUEST_HEADERS = array(
		'authorization',
		'svix-id',
		'svix-timestamp',
		'svix-signature',
		'webhook-id',
		'webhook-timestamp',
		'webhook-signature',
		'parallel-timestamp',
		'parallel-signature',
		'x-signature-sha256',
		'x-documenso-secret',
		'x-fundroom-signature',
		'x-seedhost-signature',
		'x-cal-signature-256',
		'calendly-webhook-signature',
	);

	/** DocuSign Connect HMAC headers, `x-docusign-signature-1` … `-100`. */
	const WEBHOOK_REQUEST_HEADER_PATTERN = '/^x-docusign-signature-(?:[1-9][0-9]?|100)$/';

	/**
	 * Response headers never passed back: hop-by-hop (RFC 9110 §7.6.1), plus the few this side
	 * owns. `Connection` may name more; `response_header_allowed()` takes those too.
	 */
	const DROPPED_RESPONSE_HEADERS = array(
		'connection',
		'keep-alive',
		'proxy-authenticate',
		'proxy-authorization',
		'proxy-connection',
		'te',
		'trailer',
		'transfer-encoding',
		'upgrade',
		// The web server in front of WordPress writes its own. `Host` is not a response header,
		// but PHP's built-in server sends one.
		'date',
		'host',
		'server',
		'x-powered-by',
		// Origin-wide policy the portal must not set for this site: HSTS (with `includeSubDomains`
		// or `preload`) would bind every host under this domain, and `Alt-Svc` would point the
		// browser at an alternative service for the whole origin, not just the prefix.
		'strict-transport-security',
		'alt-svc',
		// Set by `Seed_Host_Proxy` itself, from the upstream value where it matters.
		'vary',
		'cache-control',
		'pragma',
		'expires',
	);

	/** Methods proxied. Anything else is a 405: the portal serves no other. */
	const METHODS = array( 'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE' );

	/**
	 * A mount prefix, or '' if the input is not one.
	 *
	 * Same shape as the portal's `BASE_PATH` / `PATH_MOUNTS` prefix: one or more `/segment`s of
	 * unreserved characters, no trailing slash. A trailing slash is forgiven (removed), because
	 * `/investors/` is what people type; anything else is refused rather than repaired. A first
	 * segment WordPress owns is refused: see `RESERVED_SEGMENTS`.
	 *
	 * @param string $raw Admin input.
	 */
	public static function validate_prefix( string $raw ): string {
		$value = trim( $raw );
		if ( strlen( $value ) > 1 ) {
			$value = rtrim( $value, '/' );
		}
		if ( '' === $value || strlen( $value ) > 200 ) {
			return '';
		}
		if ( ! preg_match( '#^(/[A-Za-z0-9._~-]+)+$#', $value ) ) {
			return '';
		}
		$segments = explode( '/', substr( $value, 1 ) );
		foreach ( $segments as $segment ) {
			if ( '.' === $segment || '..' === $segment ) {
				return '';
			}
		}
		if ( in_array( strtolower( $segments[0] ), self::RESERVED_SEGMENTS, true ) ) {
			return '';
		}
		return $value;
	}

	/**
	 * The body cap in MB, clamped.
	 *
	 * @param int $mb Stored or submitted value.
	 */
	public static function clamp_body_mb( int $mb ): int {
		if ( $mb <= 0 ) {
			return self::DEFAULT_MAX_BODY_MB;
		}
		return max( self::MIN_BODY_MB, min( self::MAX_BODY_MB, $mb ) );
	}

	/**
	 * The part of a request path after the mount prefix, or null when the path is not under it.
	 *
	 * `/investors` → '', `/investors/` → '/', `/investors/x` → '/x', `/investorsx` → null. Exact
	 * byte comparison: `/Investors` and `/%69nvestors` are WordPress's, not ours.
	 *
	 * @param string $path   Request path (no query string), as sent by the browser.
	 * @param string $prefix Validated mount prefix.
	 */
	public static function match_prefix( string $path, string $prefix ): ?string {
		if ( '' === $prefix ) {
			return null;
		}
		if ( $path === $prefix ) {
			return '';
		}
		if ( 0 === strpos( $path, $prefix . '/' ) ) {
			return substr( $path, strlen( $prefix ) );
		}
		return null;
	}

	/**
	 * Is this remainder safe to append to the upstream base?
	 *
	 * The upstream sees `base_url . $rest`. A dot segment (raw or percent-encoded) would let a
	 * visitor walk out of the portal's base path to whatever else that origin serves — including
	 * endpoints only reachable from inside the network, which is where this server sits. A
	 * backslash is a path separator to some parsers; control characters and whitespace have no
	 * business in a request target at all.
	 *
	 * @param string $rest Output of `match_prefix()`.
	 */
	public static function is_safe_rest( string $rest ): bool {
		if ( '' === $rest ) {
			return true;
		}
		if ( '/' !== $rest[0] ) {
			return false;
		}
		if ( preg_match( '/[\x00-\x20\x7f\\\\]/', $rest ) ) {
			return false;
		}
		// Decode repeatedly so `%252e` cannot survive as a dot segment one hop later.
		$decoded = $rest;
		for ( $i = 0; $i < 3; $i++ ) {
			$next = rawurldecode( $decoded );
			if ( $next === $decoded ) {
				break;
			}
			$decoded = $next;
		}
		if ( preg_match( '/[\x00-\x1f\x7f\\\\]/', $decoded ) ) {
			return false;
		}
		foreach ( explode( '/', $decoded ) as $segment ) {
			if ( '.' === $segment || '..' === $segment ) {
				return false;
			}
		}
		return true;
	}

	/**
	 * Is this cookie name one of the portal's own?
	 *
	 * @param string $name Cookie name, exactly as sent.
	 */
	public static function is_portal_cookie( string $name ): bool {
		foreach ( self::PORTAL_COOKIE_BASENAMES as $basename ) {
			if ( '__Secure-' . $basename === $name || '__Host-' . $basename === $name ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * The browser's `Cookie` header reduced to the portal's cookies, or '' when none remain.
	 *
	 * This is the line between the two applications sharing an origin: WordPress's login
	 * cookies (`wordpress_logged_in_*`, `wordpress_sec_*`), comment cookies, analytics and every
	 * other plugin's cookie stay here. Parsed from the raw header rather than `$_COOKIE`, which
	 * PHP has already mangled (dots and spaces in names become underscores) and WordPress has
	 * slashed; the pairs we keep are forwarded byte for byte.
	 *
	 * @param string $header Raw `Cookie` request header.
	 */
	public static function filter_cookie_header( string $header ): string {
		$kept = array();
		foreach ( explode( ';', $header ) as $pair ) {
			$pair = trim( $pair );
			$eq   = strpos( $pair, '=' );
			if ( false === $eq || 0 === $eq ) {
				continue;
			}
			$name = substr( $pair, 0, $eq );
			if ( self::is_portal_cookie( $name ) && ! preg_match( '/[\x00-\x1f\x7f]/', $pair ) ) {
				$kept[] = $pair;
			}
		}
		return implode( '; ', $kept );
	}

	/**
	 * Incoming request headers (lower-cased name => value) reduced to the allow-list.
	 *
	 * On a vendor webhook path (`is_webhook_path()`) the webhook headers are added, and
	 * `Authorization` is forwarded whatever its shape.
	 *
	 * @param array<string, string> $incoming Request headers, names lower-cased.
	 * @param string                $rest     Path after the mount prefix.
	 * @return array<string, string>
	 */
	public static function forward_request_headers( array $incoming, string $rest = '' ): array {
		$webhook = self::is_webhook_path( $rest );
		$out     = array();
		foreach ( $incoming as $name => $value ) {
			$name = strtolower( (string) $name );
			if ( ! is_string( $value ) || '' === $value || preg_match( '/[\r\n\x00]/', $value ) ) {
				continue;
			}
			$listed      = in_array( $name, self::FORWARDED_REQUEST_HEADERS, true );
			$for_webhook = $webhook && (
				in_array( $name, self::WEBHOOK_REQUEST_HEADERS, true )
				|| preg_match( self::WEBHOOK_REQUEST_HEADER_PATTERN, $name )
			);
			if ( ! $listed && ! $for_webhook ) {
				continue;
			}
			if ( 'authorization' === $name && ! $webhook && ! self::is_portal_authorization( $value ) ) {
				continue;
			}
			$out[ $name ] = $value;
		}
		return $out;
	}

	/**
	 * Is this path (after the prefix) one of the portal's vendor webhook endpoints?
	 *
	 * @param string $rest Path after the mount prefix, already checked by `is_safe_rest()`.
	 */
	public static function is_webhook_path( string $rest ): bool {
		return 0 === strpos( $rest, '/webhooks/' );
	}

	/**
	 * Is this `Authorization` value a portal API key (`Bearer frk_<43 base64url>`) or SCIM token
	 * (`Bearer frs_<43 base64url>`)? Tokens minted before the FundRoom rename carry `shk_`/`shs_`
	 * and are still accepted by the portal, so they pass here too.
	 *
	 * The scheme is matched case-insensitively and with the portal's own spacing rules
	 * (`bearerOf()` in `apps/server/src/middleware/auth.ts`); the token exactly, its
	 * `frk_`/`frs_`/`shk_`/`shs_` literal case-sensitively, as the portal's own token regexes do.
	 *
	 * @param string $value `Authorization` request header.
	 */
	public static function is_portal_authorization( string $value ): bool {
		return (bool) preg_match( '/^[Bb][Ee][Aa][Rr][Ee][Rr] +(?:fr|sh)[ks]_[A-Za-z0-9_-]{43}[ \t]*$/', $value );
	}

	/**
	 * `X-Forwarded-For` with this hop's peer appended, the way nginx's
	 * `$proxy_add_x_forwarded_for` does. Whether any of it is believed is the portal's
	 * `TRUST_PROXY` decision, not ours.
	 *
	 * @param string $existing    Incoming `X-Forwarded-For`, possibly ''.
	 * @param string $remote_addr This request's peer address.
	 */
	public static function append_forwarded_for( string $existing, string $remote_addr ): string {
		$existing    = trim( preg_replace( '/[\r\n\x00]/', '', $existing ) );
		$remote_addr = trim( $remote_addr );
		if ( '' === $remote_addr || ! preg_match( '/^[0-9A-Fa-f:.]+$/', $remote_addr ) ) {
			return $existing;
		}
		return '' === $existing ? $remote_addr : $existing . ', ' . $remote_addr;
	}

	/**
	 * May this upstream response header be passed back to the browser?
	 *
	 * @param string             $name             Header name, any case.
	 * @param array<int, string> $connection_named Lower-cased tokens from the upstream `Connection`.
	 */
	public static function response_header_allowed( string $name, array $connection_named = array() ): bool {
		$lower = strtolower( trim( $name ) );
		if ( '' === $lower || ! preg_match( '/^[!#$%&\'*+.^_`|~0-9a-z-]+$/', $lower ) ) {
			return false;
		}
		return ! in_array( $lower, self::DROPPED_RESPONSE_HEADERS, true )
			&& ! in_array( $lower, $connection_named, true );
	}

	/**
	 * Header names listed in a `Connection` header value, lower-cased.
	 *
	 * @param string $value `Connection` header value.
	 * @return array<int, string>
	 */
	public static function connection_tokens( string $value ): array {
		$tokens = array();
		foreach ( explode( ',', $value ) as $token ) {
			$token = strtolower( trim( $token ) );
			if ( '' !== $token ) {
				$tokens[] = $token;
			}
		}
		return $tokens;
	}

	/**
	 * Rewrites an absolute upstream `Location` so the browser stays on the mount.
	 *
	 * The portal honours `X-Forwarded-Prefix`, so its own redirects are relative and already carry
	 * the public prefix; those pass through untouched, as does a redirect to anywhere else (an
	 * identity provider, say). Only a URL under the upstream base — `https://portal.example/base/x`
	 * — is mapped to `https://this-site/prefix/x`.
	 *
	 * @param string $location      Upstream `Location` value.
	 * @param string $upstream_base `base_url`: origin plus base path, no trailing slash.
	 * @param string $public_base   This site's origin plus the mount prefix, no trailing slash.
	 */
	public static function rewrite_location( string $location, string $upstream_base, string $public_base ): string {
		$location = trim( $location );
		if ( '' === $upstream_base || ! preg_match( '#^https?://#i', $location ) ) {
			return $location;
		}
		$split = self::split_origin( $upstream_base );
		$have  = self::split_origin( $location );
		if ( null === $split || null === $have || $split[0] !== $have[0] ) {
			return $location;
		}
		$base_path = $split[1];
		$rest      = $have[1];
		if ( '' !== $base_path ) {
			if ( 0 !== strpos( $rest, $base_path ) ) {
				return $location;
			}
			$after = (string) substr( $rest, strlen( $base_path ) );
			// `/investors-old/x` is not under `/investors`.
			if ( '' !== $after && false === strpos( '/?#', $after[0] ) ) {
				return $location;
			}
			$rest = $after;
		}
		return $public_base . $rest;
	}

	/**
	 * `[lower-cased origin, everything after it]` for an absolute http(s) URL, or null.
	 *
	 * Default ports are dropped from the origin so `https://x:443` and `https://x` compare equal.
	 *
	 * @param string $url Absolute URL.
	 * @return array{0: string, 1: string}|null
	 */
	private static function split_origin( string $url ): ?array {
		if ( ! preg_match( '#^(https?)://([^/?\#]+)(.*)$#is', $url, $m ) ) {
			return null;
		}
		$scheme    = strtolower( $m[1] );
		$authority = strtolower( $m[2] );
		if ( false !== strpos( $authority, '@' ) ) {
			return null;
		}
		$default_port = ( 'https' === $scheme && str_ends_with( $authority, ':443' ) )
			|| ( 'http' === $scheme && str_ends_with( $authority, ':80' ) );
		if ( $default_port ) {
			$authority = substr( $authority, 0, strrpos( $authority, ':' ) );
		}
		return array( $scheme . '://' . $authority, $m[3] );
	}

	/**
	 * May this upstream be proxied to?
	 *
	 * Always for https. Plain http only for a development portal — loopback, `*.localhost`, `*.test`
	 * — or when the site itself says it is a local or development install: an http upstream on
	 * a real network means investor sessions crossing it in clear.
	 *
	 * @param string $base_url    Sanitised `base_url`.
	 * @param string $environment `wp_get_environment_type()`.
	 */
	public static function upstream_allowed( string $base_url, string $environment = 'production' ): bool {
		if ( 0 === strpos( $base_url, 'https://' ) ) {
			return true;
		}
		if ( 0 !== strpos( $base_url, 'http://' ) ) {
			return false;
		}
		if ( in_array( $environment, array( 'local', 'development' ), true ) ) {
			return true;
		}
		if ( ! preg_match( '#^http://(\[[^\]]+\]|[^/:]+)#i', $base_url, $m ) ) {
			return false;
		}
		$host = strtolower( trim( $m[1], '[]' ) );
		return 'localhost' === $host
			|| '::1' === $host
			|| str_ends_with( $host, '.localhost' )
			|| str_ends_with( $host, '.test' )
			|| (bool) preg_match( '/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/', $host );
	}

	/**
	 * May the upstream's own caching headers stand, instead of `private, no-store`?
	 *
	 * Only for what the portal marks `public` and `immutable` — its content-hashed `assets/*`,
	 * which are identical under every base path — on a 200 that sets no cookie.
	 * Everything else, and in particular every page and API response, is forced uncacheable:
	 * those are one investor's data on an origin whose caches were configured for a marketing
	 * site.
	 *
	 * @param int    $status        Upstream status.
	 * @param string $cache_control Upstream `Cache-Control`, possibly ''.
	 * @param bool   $sets_cookie   Whether the upstream response carries any `Set-Cookie`.
	 */
	public static function upstream_cache_allowed( int $status, string $cache_control, bool $sets_cookie ): bool {
		if ( 200 !== $status || $sets_cookie ) {
			return false;
		}
		$directives = self::connection_tokens( $cache_control );
		return in_array( 'public', $directives, true )
			&& in_array( 'immutable', $directives, true )
			&& ! in_array( 'private', $directives, true )
			&& ! in_array( 'no-store', $directives, true );
	}

	/**
	 * A `Vary` value with more field names merged in, case-insensitively, order kept.
	 *
	 * @param string             $existing Existing `Vary`, possibly ''.
	 * @param array<int, string> $add      Field names to add.
	 */
	public static function merge_vary( string $existing, array $add ): string {
		$out  = array();
		$seen = array();
		foreach ( array_merge( explode( ',', $existing ), $add ) as $field ) {
			$field = trim( $field );
			$key   = strtolower( $field );
			if ( '' === $field || isset( $seen[ $key ] ) ) {
				continue;
			}
			if ( '*' === $field ) {
				return '*';
			}
			$seen[ $key ] = true;
			$out[]        = $field;
		}
		return implode( ', ', $out );
	}

	/**
	 * The status code from an HTTP status line (`HTTP/1.1 200 OK`, `HTTP/2 204`), or 0.
	 *
	 * @param string $line Raw header line.
	 */
	public static function parse_status_line( string $line ): int {
		return preg_match( '#^HTTP/\d(?:\.\d)?\s+(\d{3})\b#', $line, $m ) ? (int) $m[1] : 0;
	}
}
