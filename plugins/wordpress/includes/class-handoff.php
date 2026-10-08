<?php
/**
 * Ed25519 keypair generation and handoff assertion minting.
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
 * "The person looking at this page is name@example.com", signed by this site.
 *
 * The shape is a compact JWS — three base64url segments — because that is what the portal
 * verifies (`packages/identity/src/services/handoff.ts`). Ed25519 only, and only ever the
 * *public* half of the key leaves this server:
 *
 *  - **EdDSA, not HS256.** A shared secret would mean the portal storing something that can mint
 *    an assertion for this site; with a signature key it stores a public key, so a compromise of
 *    the portal's database cannot impersonate anybody here, and a compromise here cannot be
 *    replayed against another workspace (`aud` binds it to one).
 *  - **No dependency.** `sodium` has been part of PHP core since 7.2, so signing needs no library,
 *    no bundled crypto and no composer autoloader in the shipped plugin.
 *  - **Minted server-side, at render time, and posted over the bridge.** Not in a URL: a URL is
 *    logged by every proxy on the way, survives in browser history and leaks through `Referer`.
 *    The loader posts it to the iframe with `postMessage` instead.
 *  - **60 seconds, single use.** The portal enforces both (it claims the `jti` once). Minting one
 *    per page render is therefore the only correct cadence — which is also why a page carrying an
 *    assertion must not be served from a cache; see `mint()`.
 *
 * What this buys an attacker who takes over this WordPress site: the ability to have the portal
 * sign them in as any *existing* member of the one workspace configured here, at auth level 0.
 * That is the documented trade of the signed host-identity handoff, it is off by default on both sides, and
 * it is why the settings screen says so in those words.
 */
final class Seed_Host_Handoff {

	/** Option holding the base64url Ed25519 secret key. `autoload` off; never rendered. */
	const SECRET_KEY_OPTION = 'seed_host_handoff_secret_key';

	/** Assertion lifetime in seconds. The portal refuses anything longer. */
	const LIFETIME = 60;

	/** Bytes of entropy in a `jti`. 18 bytes is 24 base64url characters. */
	const JTI_BYTES = 18;

	/** Can this server sign at all? */
	public static function is_available(): bool {
		return function_exists( 'sodium_crypto_sign_keypair' )
			&& function_exists( 'sodium_crypto_sign_detached' )
			&& defined( 'SODIUM_CRYPTO_SIGN_SECRETKEYBYTES' );
	}

	/** Is a usable secret key stored? */
	public static function has_secret_key(): bool {
		return '' !== self::secret_key();
	}

	/**
	 * Generates a keypair, stores the secret half, returns the public half.
	 *
	 * The caller stores `id` and `public_key`; both are public values an admin copies into the
	 * portal. `id` becomes the JWS `kid`, so it matches the portal's format for one
	 * (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`) and is random rather than derived from the site URL —
	 * a `kid` is a label, and making it a label that changes when a site moves would break
	 * handoff on a domain change for no gain.
	 *
	 * @return array{id: string, public_key: string}|WP_Error
	 */
	public static function generate_keypair() {
		if ( ! self::is_available() ) {
			return new WP_Error(
				'seed_host_no_sodium',
				__( 'The sodium PHP extension is required to generate a signing key.', 'seed-host' )
			);
		}
		try {
			$keypair    = sodium_crypto_sign_keypair();
			$secret_key = sodium_crypto_sign_secretkey( $keypair );
			$public_key = sodium_crypto_sign_publickey( $keypair );
			$id         = 'wp-' . bin2hex( random_bytes( 8 ) );

			// `autoload` false: this is read on exactly the page views that mint an assertion, so
			// loading it into memory on every request would be a secret sitting in the options
			// cache (and in any object-cache dump) for nothing.
			update_option( self::SECRET_KEY_OPTION, self::b64url_encode( $secret_key ), false );

			sodium_memzero( $secret_key );
			sodium_memzero( $keypair );

			return array(
				'id'         => $id,
				'public_key' => self::b64url_encode( $public_key ),
			);
		} catch ( Exception $e ) {
			// `random_bytes()` throws when the platform has no usable CSPRNG, and sodium throws
			// SodiumException. Either way the honest answer is "this server cannot do this", not a
			// key derived from something weaker.
			return new WP_Error(
				'seed_host_keygen_failed',
				__( 'This server could not generate a signing key.', 'seed-host' )
			);
		}
	}

	/** Forgets the secret key. Used by `uninstall.php`'s equivalent and available for tooling. */
	public static function delete_secret_key(): void {
		delete_option( self::SECRET_KEY_OPTION );
	}

	/**
	 * Mints one assertion for the current visitor, or null when we must not.
	 *
	 * Every early return below is a case where sending *nothing* is correct: no identity claim is
	 * the anonymous flow, which works — the visitor signs in inside the iframe with a magic link
	 * or a passkey. A broken or stale claim, by contrast, is a rejection the visitor cannot act on.
	 *
	 * @param array<string, mixed> $settings Effective settings from `Seed_Host_Settings::get()`.
	 * @return string|null Compact JWS, or null.
	 */
	public static function mint( array $settings ): ?string {
		if ( empty( $settings['handoff_enabled'] ) ) {
			return null;
		}
		if ( ! is_user_logged_in() ) {
			return null;
		}
		if ( ! self::is_available() ) {
			return null;
		}

		$key_id = isset( $settings['handoff_key_id'] ) ? (string) $settings['handoff_key_id'] : '';
		if ( ! preg_match( '/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/', $key_id ) ) {
			return null;
		}

		$workspace = isset( $settings['workspace'] ) ? (string) $settings['workspace'] : '';
		if ( '' === $workspace ) {
			return null;
		}

		// An https origin with no path, because that is the only `iss` the portal accepts: an
		// issuer it had to repair is not the issuer the site believes it sent, and this value ends
		// up in an audit record a human reads.
		$issuer = self::site_issuer();
		if ( '' === $issuer ) {
			return null;
		}

		$user = wp_get_current_user();
		if ( ! $user instanceof WP_User || 0 === $user->ID ) {
			return null;
		}
		$email = sanitize_email( (string) $user->user_email );
		if ( '' === $email || ! is_email( $email ) ) {
			return null;
		}

		$secret_key = self::secret_key();
		if ( '' === $secret_key ) {
			return null;
		}

		try {
			$jti = self::jti();
		} catch ( Exception $e ) {
			// No CSPRNG means no unique id, and an assertion whose `jti` we cannot make unique is
			// one the portal's replay check would be right to refuse. Anonymous flow instead.
			sodium_memzero( $secret_key );
			return null;
		}

		$now    = time();
		$header = array(
			'alg' => 'EdDSA',
			'typ' => 'JWT',
			'kid' => $key_id,
		);
		$claims = array(
			'iss' => $issuer,
			'aud' => $workspace,
			'sub' => $email,
			'iat' => $now,
			'exp' => $now + self::LIFETIME,
			'jti' => $jti,
		);

		$flags       = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;
		$header_json = wp_json_encode( $header, $flags );
		$claims_json = wp_json_encode( $claims, $flags );
		if ( ! is_string( $header_json ) || ! is_string( $claims_json ) ) {
			sodium_memzero( $secret_key );
			return null;
		}

		$signing_input = self::b64url_encode( $header_json ) . '.' . self::b64url_encode( $claims_json );
		try {
			$signature = sodium_crypto_sign_detached( $signing_input, $secret_key );
		} catch ( Exception $e ) {
			sodium_memzero( $secret_key );
			return null;
		}
		sodium_memzero( $secret_key );

		/*
		 * This response is now personal and expires in a minute. Most page caches already skip
		 * logged-in users — which is the only case that gets here — but "most" is not a
		 * guarantee, and a cached assertion is both useless (single use, 60 s) and wrong (it names
		 * one person to everybody who gets the cached copy). `DONOTCACHEPAGE` is the de facto
		 * signal every major caching plugin honours; `nocache_headers()` covers proxies.
		 */
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			// phpcs:ignore WordPress.NamingConventions.PrefixAllGlobals.NonPrefixedConstantFound -- page caches' shared constant.
			define( 'DONOTCACHEPAGE', true );
		}
		if ( ! headers_sent() ) {
			nocache_headers();
		}

		return $signing_input . '.' . self::b64url_encode( $signature );
	}

	/**
	 * This site as an https origin — scheme, host, non-default port — or '' if it is not one.
	 *
	 * Rebuilt from the parsed parts rather than passed through, and that is the point. The portal's
	 * verifier accepts `iss` only as a bare https origin with no path, query, fragment or
	 * credentials, so on a subdirectory install `home_url()` is `https://acme.example/blog` and
	 * handing it over directly would get every assertion refused with reason `claims` — a failure
	 * that looks like a key problem and is not. `site_url()` is not used at all: it can point at a
	 * different, wp-admin-only host, and `iss` should name the address the visitor is on.
	 *
	 * Returning '' for a non-https site is likewise deliberate rather than lenient: the verifier
	 * refuses a plain-http issuer, so minting one would be emitting a token we know will be
	 * rejected. `Seed_Host_Settings::admin_notices()` says so on screen instead; the iframe itself
	 * still works and the visitor signs in inside it.
	 */
	public static function site_issuer(): string {
		$parts = wp_parse_url( home_url() );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) ) {
			return '';
		}
		if ( 'https' !== strtolower( (string) ( $parts['scheme'] ?? '' ) ) ) {
			return '';
		}
		$origin = 'https://' . strtolower( (string) $parts['host'] );
		if ( ! empty( $parts['port'] ) && 443 !== (int) $parts['port'] ) {
			$origin .= ':' . (int) $parts['port'];
		}
		return $origin;
	}

	/** The stored secret key as raw bytes, or '' when there is not a usable one. */
	private static function secret_key(): string {
		$stored = get_option( self::SECRET_KEY_OPTION, '' );
		if ( ! is_string( $stored ) || '' === $stored ) {
			return '';
		}
		$bytes = self::b64url_decode( $stored );
		if ( ! defined( 'SODIUM_CRYPTO_SIGN_SECRETKEYBYTES' )
			|| SODIUM_CRYPTO_SIGN_SECRETKEYBYTES !== strlen( $bytes ) ) {
			return '';
		}
		return $bytes;
	}

	/**
	 * A single-use id in the format the portal's replay check accepts
	 * (`^[A-Za-z0-9_.-]{8,200}$`). Random, not a counter: the portal turns it into an idempotency
	 * key, and a guessable one would let a third party burn a legitimate visitor's assertion.
	 *
	 * @throws Exception When the platform has no usable source of randomness.
	 */
	private static function jti(): string {
		return self::b64url_encode( random_bytes( self::JTI_BYTES ) );
	}

	/**
	 * Base64url, unpadded — the only encoding a compact JWS has.
	 *
	 * @param string $bytes Raw bytes.
	 */
	private static function b64url_encode( string $bytes ): string {
		return sodium_bin2base64( $bytes, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING );
	}

	/**
	 * Inverse of `b64url_encode`; '' on anything that is not that encoding.
	 *
	 * @param string $text Base64url text.
	 */
	private static function b64url_decode( string $text ): string {
		try {
			return sodium_base642bin( $text, SODIUM_BASE64_VARIANT_URLSAFE_NO_PADDING );
		} catch ( Exception $e ) {
			return '';
		}
	}
}
