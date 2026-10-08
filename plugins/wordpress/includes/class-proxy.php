<?php
/**
 * Proxy mode: serve the portal under a path of this site (opt-in, off by default).
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
 * The advanced alternative to the iframe: `https://this-site/investors/*` is forwarded to the
 * portal, so investors never leave this site's address.
 *
 * This is the one place in the plugin that makes server-side requests to the portal, and it makes
 * them only when an administrator has turned proxy mode on. What it costs, which the settings
 * screen says in the same words: the portal then shares this site's origin, so any script
 * injection anywhere on this WordPress site can read investor data, and any cache in front of
 * this site must leave the prefix alone. The embed (iframe) keeps the portal on its own origin
 * and remains the default.
 *
 * Shape of a proxied request:
 *
 *  - Matched on the **raw request path** in `parse_request`, before WordPress has queried anything
 *    or a theme has printed a byte, and `exit`s when done. A rewrite rule and query var are also
 *    registered so WordPress's own router agrees the URL space is taken (and `wp rewrite list`
 *    shows it), but the raw-path match is the authority: it cannot be stale.
 *  - Forwarded to `base_url . rest-of-path` with the query string as sent, and
 *    `X-Forwarded-Prefix: <prefix>` — the portal, which lists `https://this-site/<prefix>` in its
 *    `PATH_MOUNTS`, then renders its URLs, cookies and redirects under the prefix.
 *  - Only the portal's own cookies go upstream (`Seed_Host_Proxy_Rules::filter_cookie_header()`):
 *    a WordPress login cookie never reaches the portal.
 *  - Streamed both ways through cURL; see `transfer()` for why not the WordPress HTTP API.
 *  - Never cached: `DONOTCACHEPAGE` & co, `nocache_headers()`, `Cache-Control: private, no-store`
 *    and `Vary: Cookie`, except for the portal's content-hashed immutable assets.
 */
final class Seed_Host_Proxy {

	/** Query var the rewrite rule sets. */
	const QUERY_VAR = 'seed_host_proxy';

	/** Seconds to wait for a TCP + TLS connection to the portal. */
	const CONNECT_TIMEOUT = 10;

	/** Seconds a whole exchange may take, large downloads included. Filterable. */
	const TIMEOUT = 300;

	/** A transfer slower than 1 byte/s for this many seconds is abandoned. */
	const STALL_SECONDS = 60;

	/**
	 * Effective proxy configuration, or null when proxy mode is off or cannot run.
	 *
	 * @return array{prefix: string, relative: string, base_url: string, max_body: int}|null
	 */
	public static function config(): ?array {
		$settings = Seed_Host_Settings::get();
		if ( ! $settings['proxy_enabled'] || '' !== self::problem( $settings ) ) {
			return null;
		}
		return array(
			'prefix'   => $settings['proxy_prefix'],
			'relative' => self::relative_prefix( $settings['proxy_prefix'] ),
			'base_url' => $settings['base_url'],
			'max_body' => $settings['proxy_max_body_mb'] * 1024 * 1024,
		);
	}

	/**
	 * Why proxy mode cannot run with these settings, or '' when it can.
	 *
	 * Checked on save (the sanitiser turns proxy mode back off and says why) *and* on every
	 * request (`config()`), because WP-CLI and `update_option()` bypass the Settings API.
	 *
	 * @param array<string, mixed> $settings Effective settings.
	 */
	public static function problem( array $settings ): string {
		if ( '' === $settings['base_url'] ) {
			return __( 'Proxy mode needs the portal address.', 'seed-host' );
		}
		if ( ! Seed_Host_Proxy_Rules::upstream_allowed( $settings['base_url'], wp_get_environment_type() ) ) {
			// phpcs:ignore Generic.Files.LineLength.TooLong -- one translatable sentence.
			return __( 'Proxy mode needs an https:// portal address. Plain http is accepted only for a local development portal (localhost, *.localhost or *.test).', 'seed-host' );
		}
		if ( ! self::is_available() ) {
			return __( 'Proxy mode needs the PHP cURL extension, which this server does not have.', 'seed-host' );
		}
		if ( '' === $settings['proxy_prefix'] || '' === self::relative_prefix( $settings['proxy_prefix'] ) ) {
			return sprintf(
				/* translators: %s: this site's home path, such as "/" or "/blog". */
				__( 'The proxy path must be one or more segments of letters, digits, ".", "_", "~" or "-", such as /investors. It must sit inside this site (under %s) and must not be a path WordPress uses itself.', 'seed-host' ), // phpcs:ignore Generic.Files.LineLength.TooLong -- one translatable sentence.
				'' === self::home_path() ? '/' : self::home_path()
			);
		}
		return '';
	}

	/** Can this server proxy at all? */
	public static function is_available(): bool {
		return function_exists( 'curl_init' ) && function_exists( 'curl_setopt_array' );
	}

	/** Path of `home_url()`, no trailing slash ('' for a site at the root). */
	public static function home_path(): string {
		$path = wp_parse_url( home_url( '/' ), PHP_URL_PATH );
		return is_string( $path ) ? rtrim( $path, '/' ) : '';
	}

	/** This site's public origin, from `home_url()`. */
	public static function home_origin(): string {
		$parts = wp_parse_url( home_url( '/' ) );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) ) {
			return '';
		}
		$scheme = isset( $parts['scheme'] ) ? strtolower( $parts['scheme'] ) : 'https';
		$origin = $scheme . '://' . strtolower( $parts['host'] );
		if ( ! empty( $parts['port'] ) ) {
			$origin .= ':' . (int) $parts['port'];
		}
		return $origin;
	}

	/**
	 * The `PATH_MOUNTS` entry the portal needs for this site: origin plus prefix.
	 *
	 * @param string $prefix Validated full prefix.
	 */
	public static function mount_url( string $prefix ): string {
		return self::home_origin() . $prefix;
	}

	/**
	 * The prefix relative to this site's home path (no leading slash), or '' when it is not a
	 * valid mount inside this site.
	 *
	 * The prefix is the full public path — what the browser sees and what goes into
	 * `X-Forwarded-Prefix` and `PATH_MOUNTS` — while WordPress routes relative to its home path,
	 * so a site at `/blog` mounts the portal at `/blog/investors`. The part after the home path is
	 * validated again, so `/blog/wp-admin` is refused just as `/wp-admin` is, and a prefix equal to
	 * the home path (which would take over the whole site) is refused outright.
	 *
	 * @param string $prefix Validated full prefix.
	 */
	public static function relative_prefix( string $prefix ): string {
		$home = self::home_path();
		if ( '' !== $home ) {
			if ( 0 !== strpos( $prefix, $home . '/' ) ) {
				return '';
			}
			$prefix = substr( $prefix, strlen( $home ) );
		}
		if ( '' === Seed_Host_Proxy_Rules::validate_prefix( $prefix ) ) {
			return '';
		}
		$first = strtolower( (string) strtok( ltrim( $prefix, '/' ), '/' ) );
		if ( strtolower( rest_get_url_prefix() ) === $first ) {
			return '';
		}
		return ltrim( $prefix, '/' );
	}

	/** `init`: the rewrite rule, when proxy mode is on. */
	public static function register_rewrite(): void {
		$config = self::config();
		if ( null === $config ) {
			return;
		}
		add_rewrite_rule(
			'^' . preg_quote( $config['relative'], '#' ) . '(?:/.*)?$',
			'index.php?' . self::QUERY_VAR . '=1',
			'top'
		);
	}

	/**
	 * `query_vars`: lets the rewrite rule's var through.
	 *
	 * @param mixed $vars Public query vars.
	 * @return array<int, string>
	 */
	public static function query_vars( $vars ): array {
		$vars   = is_array( $vars ) ? $vars : array();
		$vars[] = self::QUERY_VAR;
		return $vars;
	}

	/**
	 * `update_option_seed_host_settings` / `add_option_seed_host_settings`: drop the cached
	 * rewrite rules when anything proxy-related changed, so the next request rebuilds them.
	 *
	 * Deleting the option rather than calling `flush_rewrite_rules()` here: the rules registered in
	 * *this* request were built from the old settings on `init`, so flushing now would store the
	 * old rule. WordPress regenerates an absent `rewrite_rules` option on the next request, from
	 * rules registered with the new settings. This also runs for WP-CLI and `update_option()`.
	 *
	 * @param mixed $old_value Previous value (or the option name, on `add_option_*`).
	 * @param mixed $value     New value.
	 */
	public static function on_settings_change( $old_value, $value ): void {
		$old  = is_array( $old_value ) ? $old_value : array();
		$new  = is_array( $value ) ? $value : array();
		$keys = array( 'proxy_enabled', 'proxy_prefix' );
		foreach ( $keys as $key ) {
			if ( ( $old[ $key ] ?? null ) !== ( $new[ $key ] ?? null ) ) {
				delete_option( 'rewrite_rules' );
				return;
			}
		}
	}

	/** Activation and deactivation: rebuild rewrite rules on the next request if proxying. */
	public static function on_activation_change(): void {
		$settings = Seed_Host_Settings::get();
		if ( $settings['proxy_enabled'] ) {
			delete_option( 'rewrite_rules' );
		}
	}

	/**
	 * `parse_request`: take over a request under the prefix, or return and let WordPress carry on.
	 *
	 * Priority 0, and before `wp()` has queried posts, sent headers or loaded a template, so no
	 * theme output can surround the portal's bytes.
	 */
	public static function maybe_handle(): void {
		$config = self::config();
		if ( null === $config ) {
			return;
		}
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- the request target is matched byte for byte and validated by `is_safe_rest()`; sanitising would change what is forwarded.
		$target = isset( $_SERVER['REQUEST_URI'] ) ? wp_unslash( (string) $_SERVER['REQUEST_URI'] ) : '';
		$qpos   = strpos( $target, '?' );
		$path   = false === $qpos ? $target : substr( $target, 0, $qpos );
		$query  = false === $qpos ? '' : substr( $target, $qpos + 1 );
		$rest   = Seed_Host_Proxy_Rules::match_prefix( $path, $config['prefix'] );
		if ( null === $rest ) {
			return;
		}
		self::handle( $config, $rest, $query );
		exit;
	}

	/**
	 * Proxies one request and writes the response. Never returns control to WordPress's
	 * template loader (the caller exits).
	 *
	 * @param array{prefix: string, relative: string, base_url: string, max_body: int} $config Effective config.
	 * @param string                                                                   $rest   Path after the prefix.
	 * @param string                                                                   $query  Raw query string.
	 */
	private static function handle( array $config, string $rest, string $query ): void {
		self::no_cache_signals();

		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- compared against a fixed list.
		$method = isset( $_SERVER['REQUEST_METHOD'] ) ? wp_unslash( (string) $_SERVER['REQUEST_METHOD'] ) : 'GET';
		$method = strtoupper( $method );
		if ( ! in_array( $method, Seed_Host_Proxy_Rules::METHODS, true ) ) {
			$allow = 'Allow: ' . implode( ', ', Seed_Host_Proxy_Rules::METHODS );
			self::plain_error( 405, 'Method not allowed.', array( $allow ) );
			return;
		}
		if ( ! Seed_Host_Proxy_Rules::is_safe_rest( $rest ) || preg_match( '/[\x00-\x20\x7f#]/', $query ) ) {
			self::plain_error( 400, 'Bad request.' );
			return;
		}

		$incoming = self::incoming_headers();
		$body     = null;
		$length   = 0;
		if ( in_array( $method, array( 'POST', 'PUT', 'PATCH', 'DELETE' ), true ) ) {
			$declared = isset( $incoming['content-length'] ) ? (int) $incoming['content-length'] : 0;
			if ( $declared > $config['max_body'] ) {
				self::plain_error( 413, 'Request body too large.' );
				return;
			}
			$body = self::read_body( $config['max_body'] );
			if ( null === $body ) {
				self::plain_error( 413, 'Request body too large.' );
				return;
			}
			$stat   = fstat( $body );
			$length = is_array( $stat ) ? (int) $stat['size'] : 0;
		}

		$headers                       = Seed_Host_Proxy_Rules::forward_request_headers( $incoming, $rest );
		$headers['x-forwarded-prefix'] = $config['prefix'];
		$headers['x-forwarded-proto']  = is_ssl() ? 'https' : 'http';
		$host                          = $incoming['host'] ?? '';
		$host_re                       = '/^(?:[A-Za-z0-9.\-]+|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/';
		$host_ok                       = (bool) preg_match( $host_re, $host );
		if ( $host_ok ) {
			$headers['x-forwarded-host'] = $host;
		}
		// phpcs:ignore WordPress.Security.ValidatedSanitizedInput.InputNotSanitized -- validated as an IP literal by `append_forwarded_for()`.
		$remote_addr = isset( $_SERVER['REMOTE_ADDR'] ) ? wp_unslash( (string) $_SERVER['REMOTE_ADDR'] ) : '';
		$xff         = Seed_Host_Proxy_Rules::append_forwarded_for( $incoming['x-forwarded-for'] ?? '', $remote_addr );
		if ( '' !== $xff ) {
			$headers['x-forwarded-for'] = $xff;
		}
		$cookies = Seed_Host_Proxy_Rules::filter_cookie_header( $incoming['cookie'] ?? '' );
		if ( '' !== $cookies ) {
			$headers['cookie'] = $cookies;
		}

		$url         = $config['base_url'] . $rest . ( '' === $query ? '' : '?' . $query );
		$public_base = self::home_origin() . $config['prefix'];
		$emitted     = false;

		$upstream = $config['base_url'];
		$on_head  = static function ( int $status, array $head ) use ( &$emitted, $upstream, $public_base ): void {
			$emitted = true;
			self::emit_head( $status, $head, $upstream, $public_base );
			self::end_output_buffers();
		};
		$on_chunk = static function ( string $data ): bool {
			// phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- the portal's response body (HTML, JSON, a PDF...), passed through byte for byte; escaping would corrupt it.
			echo $data;
			flush();
			return ! connection_aborted();
		};

		/**
		 * Filters the CA bundle file the proxy verifies the portal's certificate against.
		 * Empty (the default) means the system CA store, which is where an internal CA belongs.
		 *
		 * @param string $ca_file Absolute path to a PEM bundle, or ''.
		 */
		$ca_file = (string) apply_filters( 'seed_host_proxy_ca_file', '' );

		/**
		 * Filters the maximum seconds one proxied exchange may take.
		 *
		 * @param int $timeout Seconds.
		 */
		$timeout = max( 10, (int) apply_filters( 'seed_host_proxy_timeout', self::TIMEOUT ) );

		$result = self::transfer(
			array(
				'method'  => $method,
				'url'     => $url,
				'headers' => $headers,
				'body'    => $body,
				'length'  => $length,
				'ca_file' => $ca_file,
				'timeout' => $timeout,
			),
			$on_head,
			$on_chunk
		);

		if ( is_resource( $body ) ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_fclose -- php://temp, see read_body().
			fclose( $body );
		}

		if ( ! $emitted ) {
			if ( '' !== $result['error'] ) {
				if ( defined( 'WP_DEBUG' ) && WP_DEBUG ) {
					// phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log -- debug-only diagnostics; the visitor sees a generic 502.
					error_log( 'FundRoom proxy: upstream request failed: ' . $result['error'] );
				}
				self::plain_error( 502, 'Bad gateway: the investor portal could not be reached. Try again shortly.' );
				return;
			}
			self::emit_head( $result['status'], $result['headers'], $config['base_url'], $public_base );
			self::end_output_buffers();
		}
	}

	/**
	 * Runs one upstream exchange with cURL, streaming the response to the callbacks as it
	 * arrives.
	 *
	 * Why cURL and not `wp_remote_request()`: the WordPress HTTP API returns only once the whole
	 * response has arrived, holding the body in memory (or, with `stream`, in a file that is then
	 * read back). A proxied data room download can be hundreds of megabytes; buffering it would
	 * exhaust `memory_limit`, delay the first byte until the last, and break range requests for
	 * video. There is no HTTP API hook that hands over body chunks as they arrive, so this is the
	 * case the plugin guidelines' "use the HTTP API where possible" leaves open. It is also why
	 * cURL verifies against the system CA store: an internal CA is installed there, not in
	 * WordPress's bundled `ca-bundle.crt`. Redirects are never followed; they are the browser's.
	 *
	 * No WordPress calls in here, so `tests/run.php` drives it against a local server.
	 *
	 * `$request` keys: `method`, `url`, `headers` (lower-cased name => value), `body` (a stream
	 * resource or null), `length` (body bytes), `ca_file` ('' for the system store), `timeout`.
	 * `$on_head( int $status, array $headers )` is called once, before the first body byte, with
	 * headers as `[ name, value ]` pairs; `$on_chunk( string $data ): bool` gets the body bytes
	 * and returns false to abort. A bodyless response (HEAD, 204, 304) never calls either: the
	 * caller emits the returned status and headers itself.
	 *
	 * @param array    $request  Request, as above.
	 * @param callable $on_head  Head callback.
	 * @param callable $on_chunk Body callback.
	 * @return array{status: int, headers: array<int, array{0: string, 1: string}>, error: string}
	 */
	public static function transfer( array $request, callable $on_head, callable $on_chunk ): array {
		$status  = 0;
		$headers = array();
		$started = false;

		$header_lines = array( 'Expect:' );
		foreach ( $request['headers'] as $name => $value ) {
			$header_lines[] = $name . ': ' . $value;
		}

		// phpcs:disable WordPress.WP.AlternativeFunctions.curl_curl_init, WordPress.WP.AlternativeFunctions.curl_curl_setopt_array, WordPress.WP.AlternativeFunctions.curl_curl_exec, WordPress.WP.AlternativeFunctions.curl_curl_errno, WordPress.WP.AlternativeFunctions.curl_curl_error, WordPress.WP.AlternativeFunctions.curl_curl_close -- streaming proxy; see the docblock.
		$ch = curl_init();
		if ( false === $ch ) {
			return array(
				'status'  => 0,
				'headers' => array(),
				'error'   => 'curl_init failed',
			);
		}
		$options = array(
			CURLOPT_URL             => $request['url'],
			CURLOPT_PROTOCOLS       => CURLPROTO_HTTP | CURLPROTO_HTTPS,
			CURLOPT_FOLLOWLOCATION  => false,
			CURLOPT_CONNECTTIMEOUT  => self::CONNECT_TIMEOUT,
			CURLOPT_TIMEOUT         => $request['timeout'],
			CURLOPT_LOW_SPEED_LIMIT => 1,
			CURLOPT_LOW_SPEED_TIME  => self::STALL_SECONDS,
			CURLOPT_SSL_VERIFYPEER  => true,
			CURLOPT_SSL_VERIFYHOST  => 2,
			CURLOPT_HTTPHEADER      => $header_lines,
			CURLOPT_RETURNTRANSFER  => false,
			CURLOPT_HEADERFUNCTION  => static function ( $handle, string $line ) use ( &$status, &$headers ): int {
				$code = Seed_Host_Proxy_Rules::parse_status_line( $line );
				if ( $code > 0 ) {
					// A new status line: an interim 1xx before it is forgotten.
					$status  = $code;
					$headers = array();
					return strlen( $line );
				}
				$colon = strpos( $line, ':' );
				if ( false !== $colon ) {
					$headers[] = array( trim( substr( $line, 0, $colon ) ), trim( substr( $line, $colon + 1 ) ) );
				}
				return strlen( $line );
			},
			CURLOPT_WRITEFUNCTION   => static function ( $handle, string $data ) use ( &$status, &$headers, &$started, $on_head, $on_chunk ): int { // phpcs:ignore Generic.Files.LineLength.TooLong
				if ( ! $started ) {
					$started = true;
					$on_head( $status, $headers );
				}
				return $on_chunk( $data ) ? strlen( $data ) : 0;
			},
		);
		if ( '' !== $request['ca_file'] ) {
			$options[ CURLOPT_CAINFO ] = $request['ca_file'];
		}
		if ( 'HEAD' === $request['method'] ) {
			$options[ CURLOPT_NOBODY ] = true;
		} elseif ( 'GET' === $request['method'] ) {
			$options[ CURLOPT_HTTPGET ] = true;
		} else {
			$options[ CURLOPT_CUSTOMREQUEST ] = $request['method'];
			if ( is_resource( $request['body'] ) && ( $request['length'] > 0 || 'DELETE' !== $request['method'] ) ) {
				// Streamed from the spooled body, with a Content-Length (0 included, which some
				// servers insist on for a bodyless POST).
				rewind( $request['body'] );
				$options[ CURLOPT_UPLOAD ]     = true;
				$options[ CURLOPT_INFILE ]     = $request['body'];
				$options[ CURLOPT_INFILESIZE ] = $request['length'];
			}
		}
		curl_setopt_array( $ch, $options );
		$ok    = curl_exec( $ch );
		$errno = curl_errno( $ch );
		$error = '';
		if ( false === $ok || 0 !== $errno ) {
			$error = curl_error( $ch );
			$error = '' === $error ? 'curl error ' . $errno : $error;
		}
		curl_close( $ch );
		// phpcs:enable

		if ( '' === $error && 0 === $status ) {
			$error = 'no status line from upstream';
		}
		return array(
			'status'  => $status,
			'headers' => $headers,
			'error'   => $error,
		);
	}

	/**
	 * Status and headers for a proxied response.
	 *
	 * Starts from nothing (`header_remove()`), so no header WordPress or another plugin queued
	 * before `parse_request` — a session cookie of its own, an `X-Pingback` — rides along.
	 *
	 * @param int                                     $status        Upstream status.
	 * @param array<int, array{0: string, 1: string}> $headers       Upstream headers.
	 * @param string                                  $upstream_base `base_url`.
	 * @param string                                  $public_base   This site's origin plus prefix.
	 */
	private static function emit_head( int $status, array $headers, string $upstream_base, string $public_base ): void {
		if ( headers_sent() ) {
			return;
		}
		header_remove();
		http_response_code( $status );

		$connection    = array();
		$cache_control = '';
		$vary          = '';
		$sets_cookie   = false;
		foreach ( $headers as $header ) {
			$lower = strtolower( $header[0] );
			if ( 'connection' === $lower ) {
				$connection = array_merge( $connection, Seed_Host_Proxy_Rules::connection_tokens( $header[1] ) );
			} elseif ( 'cache-control' === $lower ) {
				$cache_control .= ( '' === $cache_control ? '' : ', ' ) . $header[1];
			} elseif ( 'vary' === $lower ) {
				$vary .= ( '' === $vary ? '' : ', ' ) . $header[1];
			} elseif ( 'set-cookie' === $lower ) {
				$sets_cookie = true;
			}
		}

		// Cache policy first: `nocache_headers()` also removes `Last-Modified`, which must not take
		// the upstream's with it.
		if ( Seed_Host_Proxy_Rules::upstream_cache_allowed( $status, $cache_control, $sets_cookie ) ) {
			header( 'Cache-Control: ' . $cache_control );
			if ( '' !== $vary ) {
				header( 'Vary: ' . Seed_Host_Proxy_Rules::merge_vary( $vary, array() ) );
			}
		} else {
			self::no_cache_headers();
			header( 'Vary: ' . Seed_Host_Proxy_Rules::merge_vary( $vary, array( 'Cookie' ) ) );
		}

		foreach ( $headers as $header ) {
			list( $name, $value ) = $header;
			$allowed              = Seed_Host_Proxy_Rules::response_header_allowed( $name, $connection );
			if ( ! $allowed || preg_match( '/[\r\n\x00]/', $value ) ) {
				continue;
			}
			if ( 'location' === strtolower( $name ) ) {
				$value = Seed_Host_Proxy_Rules::rewrite_location( $value, $upstream_base, $public_base );
			}
			header( $name . ': ' . $value, false );
		}
	}

	/** `nocache_headers()`, tightened to `private, no-store`, plus LiteSpeed's own header. */
	private static function no_cache_headers(): void {
		nocache_headers();
		header( 'Cache-Control: private, no-store' );
		header( 'X-LiteSpeed-Cache-Control: no-cache' );
	}

	/**
	 * Tells every page cache we know of to keep its hands off this response.
	 *
	 * `DONOTCACHEPAGE` is honoured by WP Super Cache, W3 Total Cache, WP Rocket, WP Fastest Cache
	 * and most hosting caches; the object/DB constants are W3TC's. LiteSpeed has an action. These
	 * run before the output buffers are dropped, because a page cache decides whether to store a
	 * page in its buffer callback.
	 */
	private static function no_cache_signals(): void {
		// phpcs:disable WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- the page-cache plugins' shared constants.
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			define( 'DONOTCACHEPAGE', true );
		}
		if ( ! defined( 'DONOTCACHEOBJECT' ) ) {
			define( 'DONOTCACHEOBJECT', true );
		}
		if ( ! defined( 'DONOTCACHEDB' ) ) {
			define( 'DONOTCACHEDB', true );
		}
		// phpcs:enable
		// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedHooknameFound -- LiteSpeed Cache's documented action; a no-op without it.
		do_action( 'litespeed_control_set_nocache', 'FundRoom proxy' );
		// WP Rocket: do not write a cache file for this request.
		add_filter( 'do_rocket_generate_caching_files', '__return_false' );
	}

	/**
	 * Drops any output buffers (a page cache's, a theme's) so the body streams instead of
	 * accumulating in PHP memory, and turns off PHP-level compression, which would buffer too.
	 */
	private static function end_output_buffers(): void {
		// phpcs:ignore WordPress.PHP.IniSet.Risky -- per-request, before any output; zlib compression would buffer the whole streamed body.
		ini_set( 'zlib.output_compression', 'Off' );
		while ( ob_get_level() > 0 ) {
			ob_end_clean();
		}
	}

	/**
	 * The request headers, lower-cased name => raw value.
	 *
	 * Raw on purpose: these are forwarded byte for byte after the allow-list in
	 * `Seed_Host_Proxy_Rules`, never stored or printed. `wp_unslash()` undoes WordPress's
	 * `wp_magic_quotes()` on `$_SERVER`.
	 *
	 * @return array<string, string>
	 */
	private static function incoming_headers(): array {
		$out = array();
		foreach ( $_SERVER as $key => $value ) {
			if ( ! is_string( $key ) || ! is_string( $value ) ) {
				continue;
			}
			if ( 0 === strpos( $key, 'HTTP_' ) ) {
				$name = strtolower( str_replace( '_', '-', substr( $key, 5 ) ) );
			} elseif ( 'CONTENT_TYPE' === $key || 'CONTENT_LENGTH' === $key ) {
				$name = strtolower( str_replace( '_', '-', $key ) );
			} else {
				continue;
			}
			$out[ $name ] = wp_unslash( $value );
		}
		return $out;
	}

	/**
	 * Spools the request body into a `php://temp` stream (memory up to 2 MB, then a temp file),
	 * refusing past the cap. Returns null when the cap is exceeded.
	 *
	 * `php://input` rather than `$_POST`: the portal speaks JSON and tus, which PHP does not parse,
	 * and a form post must reach the portal as the bytes the browser sent. The WordPress
	 * filesystem API is for files on disk and cannot read a request body.
	 *
	 * @param int $max_bytes Cap.
	 * @return resource|null
	 */
	private static function read_body( int $max_bytes ) {
		// phpcs:disable WordPress.WP.AlternativeFunctions.file_system_operations_fopen, WordPress.WP.AlternativeFunctions.file_system_operations_fread, WordPress.WP.AlternativeFunctions.file_system_operations_fwrite, WordPress.WP.AlternativeFunctions.file_system_operations_fclose -- request body streams, see above.
		$in  = fopen( 'php://input', 'rb' );
		$out = fopen( 'php://temp/maxmemory:2097152', 'w+b' );
		if ( false === $in || false === $out ) {
			return null;
		}
		$total = 0;
		while ( ! feof( $in ) ) {
			$chunk = fread( $in, 65536 );
			if ( false === $chunk || '' === $chunk ) {
				break;
			}
			$total += strlen( $chunk );
			if ( $total > $max_bytes ) {
				fclose( $in );
				fclose( $out );
				return null;
			}
			fwrite( $out, $chunk );
		}
		fclose( $in );
		// phpcs:enable
		rewind( $out );
		return $out;
	}

	/**
	 * A short plain-text error. Nothing from the upstream, ever: a connection error message can
	 * name internal hosts and addresses.
	 *
	 * @param int                $status  HTTP status.
	 * @param string             $message Fixed message.
	 * @param array<int, string> $extra   Extra header lines.
	 */
	private static function plain_error( int $status, string $message, array $extra = array() ): void {
		if ( ! headers_sent() ) {
			header_remove();
			http_response_code( $status );
			self::no_cache_headers();
			header( 'Content-Type: text/plain; charset=utf-8' );
			header( 'X-Content-Type-Options: nosniff' );
			foreach ( $extra as $line ) {
				header( $line );
			}
		}
		self::end_output_buffers();
		echo esc_html( $message ) . "\n";
	}
}
