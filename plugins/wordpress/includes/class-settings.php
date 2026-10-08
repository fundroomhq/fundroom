<?php
/**
 * Settings screen, option storage and validation.
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

// phpcs:disable Generic.Files.LineLength.TooLong -- the admin screen's prose is translatable sentences, which cannot be split across lines without splitting them for translators.

/**
 * Everything an admin can change, and the one screen that changes it.
 *
 * Storage is split across four options rather than one, and the split is load-bearing:
 *
 *  - `seed_host_settings` — the admin-editable array. It goes through the Settings API, so the
 *    form nonce and the `manage_options` capability are checked by `options.php` before our
 *    sanitiser ever runs, and again here because a sanitiser that assumes its caller did the
 *    checking is one refactor away from being wrong.
 *  - `seed_host_handoff_key_id` / `seed_host_handoff_public_key` — generated, never posted by the
 *    form. Keeping them out of the form means a settings save cannot blank them, and no hidden
 *    input carries key material back and forth through the browser.
 *  - `seed_host_handoff_secret_key` — the Ed25519 private key, `autoload` off (see
 *    `Seed_Host_Handoff`). It is written by one code path, read by one code path, and deleted by
 *    `uninstall.php`. It is never rendered, never exported and never sent anywhere.
 */
final class Seed_Host_Settings {

	/** Admin-editable settings, one array option. */
	const OPTION = 'seed_host_settings';

	/** Settings API group; also the `option_page` value `options.php` checks the nonce against. */
	const GROUP = 'seed_host';

	/** `add_options_page` menu slug. */
	const PAGE = 'seed-host';

	/** `admin_post_{action}` for the "generate a new keypair" button. */
	const GENERATE_ACTION = 'seed_host_generate_keypair';

	/** Option holding the JWS `kid` the portal knows this site by. */
	const KEY_ID_OPTION = 'seed_host_handoff_key_id';

	/** Option holding the base64url Ed25519 public key an admin pastes into the portal. */
	const PUBLIC_KEY_OPTION = 'seed_host_handoff_public_key';

	/** Shortest and tallest reserved height, in CSS pixels. */
	const MIN_HEIGHT = 120;
	const MAX_HEIGHT = 5000;

	/**
	 * A workspace slug as the portal spells it: one DNS label, because the slug is also a
	 * subdomain (`<slug>.<canonical>`). Kept in sync with `packages/contracts/src/schemas.ts`.
	 */
	const SLUG_PATTERN = '/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/';

	/**
	 * The shipped defaults.
	 *
	 * Note what is *not* here: no portal URL and no workspace. An install with the plugin active
	 * and nobody having visited the settings screen must be inert, and it is the emptiness of
	 * these two strings that makes it so.
	 *
	 * @return array<string, mixed>
	 */
	public static function defaults(): array {
		return array(
			'base_url'          => '',
			'workspace'         => '',
			'default_path'      => '',
			'default_height'    => 600,
			'handoff_enabled'   => false,
			// Proxy mode (`Seed_Host_Proxy`): off unless an admin turns it on.
			'proxy_enabled'     => false,
			'proxy_prefix'      => Seed_Host_Proxy_Rules::DEFAULT_PREFIX,
			'proxy_max_body_mb' => Seed_Host_Proxy_Rules::DEFAULT_MAX_BODY_MB,
		);
	}

	/**
	 * The effective settings, defaults filled in, types coerced, plus the read-only key material.
	 *
	 * Every consumer goes through here, so a hand-edited or half-migrated option row cannot
	 * produce a string where the renderer expects an int.
	 *
	 * @return array<string, mixed>
	 */
	public static function get(): array {
		$stored = get_option( self::OPTION, array() );
		$stored = is_array( $stored ) ? $stored : array();
		$merged = wp_parse_args( $stored, self::defaults() );

		return array(
			'base_url'           => is_string( $merged['base_url'] ) ? $merged['base_url'] : '',
			'workspace'          => is_string( $merged['workspace'] ) ? $merged['workspace'] : '',
			'default_path'       => is_string( $merged['default_path'] ) ? $merged['default_path'] : '',
			'default_height'     => self::clamp_height( (int) $merged['default_height'] ),
			'handoff_enabled'    => (bool) $merged['handoff_enabled'],
			// Re-validated on read, not only on save: WP-CLI and `update_option()` do not pass
			// through the Settings API sanitiser, and this value decides which URLs are proxied.
			'proxy_enabled'      => (bool) $merged['proxy_enabled'],
			'proxy_prefix'       => is_string( $merged['proxy_prefix'] ) ? Seed_Host_Proxy_Rules::validate_prefix( $merged['proxy_prefix'] ) : '',
			'proxy_max_body_mb'  => Seed_Host_Proxy_Rules::clamp_body_mb( (int) $merged['proxy_max_body_mb'] ),
			'handoff_key_id'     => (string) get_option( self::KEY_ID_OPTION, '' ),
			'handoff_public_key' => (string) get_option( self::PUBLIC_KEY_OPTION, '' ),
		);
	}

	/** Is there enough configuration to render an embed at all? */
	public static function is_configured(): bool {
		$settings = self::get();
		return '' !== $settings['base_url'] && '' !== $settings['workspace'];
	}

	/** Registers the option and the form. Runs on `admin_init` only. */
	public static function register(): void {
		register_setting(
			self::GROUP,
			self::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => array( __CLASS__, 'sanitize' ),
				'default'           => self::defaults(),
				// The portal URL and workspace slug are public, but there is no reason for the
				// REST API to carry this site's embed configuration to anyone who can read
				// `/wp/v2/settings`, and `show_in_rest` on an array option also means shipping a
				// schema we would then have to keep in step with the sanitiser.
				'show_in_rest'      => false,
			)
		);

		add_settings_section(
			'seed_host_portal',
			__( 'Portal', 'seed-host' ),
			array( __CLASS__, 'render_portal_section' ),
			self::PAGE
		);

		$fields = array(
			'base_url'       => __( 'Portal address', 'seed-host' ),
			'workspace'      => __( 'Workspace slug', 'seed-host' ),
			'default_path'   => __( 'Default page', 'seed-host' ),
			'default_height' => __( 'Default height', 'seed-host' ),
		);
		foreach ( $fields as $key => $label ) {
			add_settings_field(
				'seed_host_' . $key,
				$label,
				array( __CLASS__, 'render_field_' . $key ),
				self::PAGE,
				'seed_host_portal',
				array( 'label_for' => 'seed_host_' . $key )
			);
		}

		add_settings_section(
			'seed_host_handoff',
			__( 'Visitor identity handoff', 'seed-host' ),
			array( __CLASS__, 'render_handoff_section' ),
			self::PAGE
		);
		add_settings_field(
			'seed_host_handoff_enabled',
			__( 'Sign in logged-in users', 'seed-host' ),
			array( __CLASS__, 'render_field_handoff_enabled' ),
			self::PAGE,
			'seed_host_handoff'
		);

		add_settings_section(
			'seed_host_proxy',
			__( 'Advanced: proxy mode', 'seed-host' ),
			array( __CLASS__, 'render_proxy_section' ),
			self::PAGE
		);
		$proxy_fields = array(
			'proxy_enabled'     => __( 'Serve the portal from this site', 'seed-host' ),
			'proxy_prefix'      => __( 'Portal path', 'seed-host' ),
			'proxy_max_body_mb' => __( 'Largest upload', 'seed-host' ),
		);
		foreach ( $proxy_fields as $key => $label ) {
			add_settings_field(
				'seed_host_' . $key,
				$label,
				array( __CLASS__, 'render_field_' . $key ),
				self::PAGE,
				'seed_host_proxy',
				'proxy_enabled' === $key ? array() : array( 'label_for' => 'seed_host_' . $key )
			);
		}
	}

	/** Adds Settings → FundRoom. */
	public static function add_menu(): void {
		add_options_page(
			__( 'FundRoom', 'seed-host' ),
			__( 'FundRoom', 'seed-host' ),
			'manage_options',
			self::PAGE,
			array( __CLASS__, 'render_page' )
		);
	}

	/**
	 * Adds a Settings link on the plugins list.
	 *
	 * @param array<int, string> $links Existing action links.
	 * @return array<int, string>
	 */
	public static function action_links( $links ): array {
		$links = is_array( $links ) ? $links : array();
		$link  = sprintf(
			'<a href="%s">%s</a>',
			esc_url( self::page_url() ),
			esc_html__( 'Settings', 'seed-host' )
		);
		return array_merge( array( $link ), $links );
	}

	/** URL of this plugin's settings screen. */
	public static function page_url(): string {
		return admin_url( 'options-general.php?page=' . self::PAGE );
	}

	/**
	 * Validates one settings submission.
	 *
	 * Returns the *current* stored settings on any refusal rather than an empty array: a
	 * capability or nonce failure must not blank a working configuration.
	 *
	 * @param mixed $input Raw `$_POST` value for this option.
	 * @return array<string, mixed>
	 */
	public static function sanitize( $input ): array {
		$current = self::get();
		unset( $current['handoff_key_id'], $current['handoff_public_key'] );

		// `options.php` has already checked this, and checks it again here because
		// `update_option()` can be reached from anywhere and a sanitiser is not a safe place to
		// assume a caller.
		if ( ! current_user_can( 'manage_options' ) ) {
			return $current;
		}

		/*
		 * Nonce. `check_admin_referer()` would `wp_die()`, which is wrong for a sanitiser that
		 * also runs on programmatic writes (the keypair button calls `update_option()` after
		 * doing its own capability and nonce checks). So the check is scoped to the case that is
		 * unambiguously a form post of *this* option page.
		 */
		// phpcs:ignore WordPress.Security.NonceVerification.Missing -- this *is* the nonce check.
		$option_page = isset( $_POST['option_page'] ) ? sanitize_text_field( wp_unslash( $_POST['option_page'] ) ) : '';
		if ( self::GROUP === $option_page && ! check_admin_referer( self::GROUP . '-options' ) ) {
			return $current;
		}

		if ( ! is_array( $input ) ) {
			return $current;
		}

		$out = self::defaults();

		$base_url_raw    = isset( $input['base_url'] ) && is_string( $input['base_url'] ) ? $input['base_url'] : '';
		$out['base_url'] = self::sanitize_base_url( $base_url_raw );
		if ( '' !== trim( $base_url_raw ) && '' === $out['base_url'] ) {
			add_settings_error(
				self::OPTION,
				'seed_host_base_url',
				__( 'The portal address must be a full https:// address with no query string, for example https://portal.example.com', 'seed-host' )
			);
		} elseif ( '' !== $out['base_url'] && 0 !== strpos( $out['base_url'], 'https://' ) ) {
			// Not a refusal: a plain-http portal is a normal local development setup. It is a
			// warning because the portal's session cookie is `Secure; Partitioned`, which a
			// browser will not store for an http origin, so the embed will only ever offer its
			// "open in a new tab" fallback.
			add_settings_error(
				self::OPTION,
				'seed_host_base_url_http',
				__( 'This portal address is not https. Sign-in inside the embed will not work, because the portal session cookie requires a secure origin. Use http only for local development.', 'seed-host' ),
				'warning'
			);
		}

		$workspace_raw    = isset( $input['workspace'] ) && is_string( $input['workspace'] ) ? $input['workspace'] : '';
		$out['workspace'] = self::sanitize_workspace( $workspace_raw );
		if ( '' !== trim( $workspace_raw ) && '' === $out['workspace'] ) {
			add_settings_error(
				self::OPTION,
				'seed_host_workspace',
				__( 'The workspace slug may contain only lowercase letters, digits and hyphens, and must start and end with a letter or digit.', 'seed-host' )
			);
		}

		$path_raw            = isset( $input['default_path'] ) && is_string( $input['default_path'] ) ? $input['default_path'] : '';
		$out['default_path'] = self::sanitize_path( $path_raw );
		if ( '' !== trim( $path_raw ) && '' === $out['default_path'] ) {
			add_settings_error(
				self::OPTION,
				'seed_host_default_path',
				__( 'The default page must be a path inside the portal, such as /updates. It cannot be a full URL.', 'seed-host' )
			);
		}

		$out['default_height'] = self::clamp_height(
			isset( $input['default_height'] ) ? (int) $input['default_height'] : 600
		);

		$out['handoff_enabled'] = ! empty( $input['handoff_enabled'] );
		if ( $out['handoff_enabled'] && '' === get_option( self::KEY_ID_OPTION, '' ) ) {
			add_settings_error(
				self::OPTION,
				'seed_host_handoff_no_key',
				__( 'Handoff is on but this site has no signing key yet. Generate one below and register its public key in the portal.', 'seed-host' ),
				'warning'
			);
		}

		self::sanitize_proxy( $input, $current, $out );

		return $out;
	}

	/**
	 * The proxy-mode part of a settings submission. Refuses to turn proxy mode on with settings
	 * it could not run with, and says why, rather than saving a switch that silently does nothing.
	 *
	 * @param array<string, mixed> $input   Raw submission.
	 * @param array<string, mixed> $current Stored settings.
	 * @param array<string, mixed> $out     Sanitised settings so far; completed in place.
	 */
	private static function sanitize_proxy( array $input, array $current, array &$out ): void {
		$prefix_raw = isset( $input['proxy_prefix'] ) && is_string( $input['proxy_prefix'] ) ? $input['proxy_prefix'] : '';
		$prefix     = Seed_Host_Proxy_Rules::validate_prefix( $prefix_raw );
		if ( '' !== $prefix && '' === Seed_Host_Proxy::relative_prefix( $prefix ) ) {
			$prefix = '';
		}
		if ( '' === $prefix ) {
			if ( '' !== trim( $prefix_raw ) ) {
				add_settings_error(
					self::OPTION,
					'seed_host_proxy_prefix',
					__( 'The portal path must look like /investors: one or more segments of letters, digits, ".", "_", "~" or "-", inside this site, and not a path WordPress uses itself (such as /wp-admin or /wp-json).', 'seed-host' )
				);
			}
			$prefix = '' !== $current['proxy_prefix'] ? $current['proxy_prefix'] : Seed_Host_Proxy_Rules::DEFAULT_PREFIX;
		}
		$out['proxy_prefix'] = $prefix;

		$out['proxy_max_body_mb'] = Seed_Host_Proxy_Rules::clamp_body_mb(
			isset( $input['proxy_max_body_mb'] ) ? (int) $input['proxy_max_body_mb'] : Seed_Host_Proxy_Rules::DEFAULT_MAX_BODY_MB
		);

		$out['proxy_enabled'] = ! empty( $input['proxy_enabled'] );
		if ( ! $out['proxy_enabled'] ) {
			return;
		}
		$problem = Seed_Host_Proxy::problem( $out );
		if ( '' !== $problem ) {
			$out['proxy_enabled'] = false;
			add_settings_error( self::OPTION, 'seed_host_proxy', $problem . ' ' . __( 'Proxy mode has been left off.', 'seed-host' ) );
			return;
		}
		$relative = Seed_Host_Proxy::relative_prefix( $out['proxy_prefix'] );
		if ( null !== get_page_by_path( $relative ) ) {
			add_settings_error(
				self::OPTION,
				'seed_host_proxy_page',
				sprintf(
					/* translators: %s: the proxy path, such as /investors. */
					__( 'A WordPress page already lives at %s. While proxy mode is on, visitors to that address get the portal instead.', 'seed-host' ),
					$out['proxy_prefix']
				),
				'warning'
			);
		}
	}

	/**
	 * A portal base address: scheme, host, optional port, optional base path. No credentials, no
	 * query, no fragment, no trailing slash.
	 *
	 * Rebuilt from the parsed parts rather than trimmed in place, so anything the parser did not
	 * account for is dropped instead of surviving into a URL a browser will resolve.
	 *
	 * @param string $raw Admin input.
	 */
	public static function sanitize_base_url( string $raw ): string {
		$value = trim( $raw );
		if ( '' === $value ) {
			return '';
		}
		if ( strlen( $value ) > 255 ) {
			return '';
		}
		$parts = wp_parse_url( esc_url_raw( $value, array( 'http', 'https' ) ) );
		if ( ! is_array( $parts ) || empty( $parts['host'] ) || empty( $parts['scheme'] ) ) {
			return '';
		}
		$scheme = strtolower( $parts['scheme'] );
		if ( 'http' !== $scheme && 'https' !== $scheme ) {
			return '';
		}
		if ( ! empty( $parts['user'] ) || ! empty( $parts['pass'] ) || ! empty( $parts['query'] ) || ! empty( $parts['fragment'] ) ) {
			return '';
		}
		$origin = $scheme . '://' . strtolower( $parts['host'] );
		if ( ! empty( $parts['port'] ) ) {
			$port = (int) $parts['port'];
			if ( $port < 1 || $port > 65535 ) {
				return '';
			}
			$is_default = ( 'https' === $scheme && 443 === $port ) || ( 'http' === $scheme && 80 === $port );
			if ( ! $is_default ) {
				$origin .= ':' . $port;
			}
		}
		$path = isset( $parts['path'] ) ? rtrim( $parts['path'], '/' ) : '';
		if ( '' !== $path && ! preg_match( '#^(/[A-Za-z0-9._~-]+)+$#', $path ) ) {
			// A base path is `PUBLIC_BASE_PATH` on the portal side: a couple of plain segments.
			// Anything else is a page URL someone pasted.
			return '';
		}
		return $origin . $path;
	}

	/**
	 * A workspace slug, or '' if it is not one.
	 *
	 * @param string $raw Admin input.
	 */
	public static function sanitize_workspace( string $raw ): string {
		$value = strtolower( trim( $raw ) );
		return preg_match( self::SLUG_PATTERN, $value ) ? $value : '';
	}

	/**
	 * A path inside the portal, or '' if the input is not one.
	 *
	 * Refused rather than repaired: `//evil.example` is a protocol-relative URL, and a "helpful"
	 * fix that kept the authority would point the iframe at somebody else's site.
	 *
	 * @param string $raw Admin input.
	 */
	public static function sanitize_path( string $raw ): string {
		$value = trim( $raw );
		if ( '' === $value ) {
			return '';
		}
		if ( strlen( $value ) > 512 ) {
			return '';
		}
		// Any scheme, and any authority, means this is a URL rather than a path.
		if ( preg_match( '#^[A-Za-z][A-Za-z0-9+.-]*:#', $value ) || 0 === strpos( $value, '//' ) ) {
			return '';
		}
		if ( 0 !== strpos( $value, '/' ) ) {
			$value = '/' . $value;
		}
		// Control characters, whitespace, quotes and the characters a URL parser treats
		// specially. The value is about to be JSON-encoded into a script and then used as a URL;
		// neither context should have to be the one that catches these.
		if ( preg_match( '/[\x00-\x20\x7f"\'<>\\\\^`{|}]/', $value ) ) {
			return '';
		}
		return $value;
	}

	/**
	 * Keeps a reserved height inside something a page can actually lay out.
	 *
	 * @param int $value Height in pixels.
	 */
	public static function clamp_height( int $value ): int {
		if ( $value <= 0 ) {
			return 0;
		}
		return max( self::MIN_HEIGHT, min( self::MAX_HEIGHT, $value ) );
	}

	/** Generates a fresh Ed25519 keypair. Capability + nonce checked; redirects back. */
	public static function handle_generate_keypair(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die(
				esc_html__( 'You do not have permission to change FundRoom settings.', 'seed-host' ),
				403
			);
		}
		check_admin_referer( self::GENERATE_ACTION );

		$result = Seed_Host_Handoff::generate_keypair();
		$notice = is_wp_error( $result ) ? 'keys-failed' : 'keys-generated';
		if ( ! is_wp_error( $result ) ) {
			update_option( self::KEY_ID_OPTION, $result['id'], true );
			update_option( self::PUBLIC_KEY_OPTION, $result['public_key'], true );
		}

		wp_safe_redirect( add_query_arg( 'seed_host_notice', $notice, self::page_url() ) );
		exit;
	}

	/** Renders the settings screen. */
	public static function render_page(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$settings = self::get();
		?>
		<div class="wrap">
			<h1><?php echo esc_html__( 'FundRoom', 'seed-host' ); ?></h1>
			<p>
				<?php
				echo esc_html__(
					'Point this site at your investor portal, then place the portal on a page with the Investor portal block or the [seed_host] shortcode.',
					'seed-host'
				);
				?>
			</p>
			<?php
			self::render_action_notice();
			settings_errors( self::OPTION );
			?>
			<form action="options.php" method="post">
				<?php
				settings_fields( self::GROUP );
				do_settings_sections( self::PAGE );
				submit_button();
				?>
			</form>

			<?php self::render_key_panel( $settings ); ?>

			<h2><?php echo esc_html__( 'Placing the portal on a page', 'seed-host' ); ?></h2>
			<p>
				<?php echo esc_html__( 'Add the "Investor portal" block, or paste this shortcode:', 'seed-host' ); ?>
			</p>
			<p><code>[seed_host]</code></p>
			<p>
				<?php echo esc_html__( 'Both accept an optional page and height, for example:', 'seed-host' ); ?>
			</p>
			<p><code>[seed_host path="/updates" height="800"]</code></p>
			<?php if ( self::is_configured() ) : ?>
				<p>
					<a href="<?php echo esc_url( Seed_Host_Embed::canonical_url( $settings, '' ) ); ?>" target="_blank" rel="noopener noreferrer">
						<?php echo esc_html__( 'Open this workspace on the portal', 'seed-host' ); ?>
					</a>
				</p>
			<?php endif; ?>
		</div>
		<?php
	}

	/** Section blurb: the portal coordinates. */
	public static function render_portal_section(): void {
		echo '<p>' . esc_html__( 'These two values come from the Embed screen in your portal workspace settings.', 'seed-host' ) . '</p>';
	}

	/** Section blurb: what handoff is and what it costs. */
	public static function render_handoff_section(): void {
		echo '<p>' . esc_html__(
			'If this site already knows who its visitors are, it can tell the portal — so a member who is logged in here does not have to sign in again inside the embed.',
			'seed-host'
		) . '</p>';
		echo '<p>' . esc_html__(
			'This site signs a statement saying "the person viewing this page is name@example.com", valid for 60 seconds and usable once. The portal believes it only if the workspace has turned on "trust host identity", the key below is registered there, and that address already belongs to a member. Anyone who can log in to this site as an administrator can therefore cause the portal to sign someone in as any of its members — leave this off unless you need it.',
			'seed-host'
		) . '</p>';
	}

	/** Portal address field. */
	public static function render_field_base_url(): void {
		$settings = self::get();
		printf(
			'<input type="url" inputmode="url" class="regular-text code" id="seed_host_base_url" name="%s[base_url]" value="%s" placeholder="https://portal.example.com" autocomplete="off" spellcheck="false" />',
			esc_attr( self::OPTION ),
			esc_attr( $settings['base_url'] )
		);
		echo '<p class="description">' . esc_html__( 'The address your portal is served from, including its base path if it has one, with no trailing slash. Proxy mode forwards to this address.', 'seed-host' ) . '</p>';
	}

	/** Workspace slug field. */
	public static function render_field_workspace(): void {
		$settings = self::get();
		printf(
			'<input type="text" class="regular-text code" id="seed_host_workspace" name="%s[workspace]" value="%s" placeholder="acme" autocomplete="off" spellcheck="false" pattern="[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?" />',
			esc_attr( self::OPTION ),
			esc_attr( $settings['workspace'] )
		);
		echo '<p class="description">' . esc_html__( 'Lowercase letters, digits and hyphens.', 'seed-host' ) . '</p>';
	}

	/** Default path field. */
	public static function render_field_default_path(): void {
		$settings = self::get();
		printf(
			'<input type="text" class="regular-text code" id="seed_host_default_path" name="%s[default_path]" value="%s" placeholder="/updates" autocomplete="off" spellcheck="false" />',
			esc_attr( self::OPTION ),
			esc_attr( $settings['default_path'] )
		);
		echo '<p class="description">' . esc_html__( 'Where the embed opens when a block or shortcode does not say. Leave empty for the portal home page.', 'seed-host' ) . '</p>';
	}

	/** Default height field. */
	public static function render_field_default_height(): void {
		$settings = self::get();
		printf(
			'<input type="number" class="small-text" id="seed_host_default_height" name="%s[default_height]" value="%d" min="%d" max="%d" step="10" />',
			esc_attr( self::OPTION ),
			(int) $settings['default_height'],
			(int) self::MIN_HEIGHT,
			(int) self::MAX_HEIGHT
		);
		echo ' <span>' . esc_html__( 'pixels', 'seed-host' ) . '</span>';
		echo '<p class="description">' . esc_html__( 'The space reserved before the portal reports its own height. The embed grows and shrinks to fit its content; this is the floor, so the page does not jump while it loads.', 'seed-host' ) . '</p>';
	}

	/** Handoff on/off. */
	public static function render_field_handoff_enabled(): void {
		$settings = self::get();
		printf(
			'<label for="seed_host_handoff_enabled"><input type="checkbox" id="seed_host_handoff_enabled" name="%s[handoff_enabled]" value="1" %s /> %s</label>',
			esc_attr( self::OPTION ),
			checked( $settings['handoff_enabled'], true, false ),
			esc_html__( 'Tell the portal who the logged-in WordPress user is', 'seed-host' )
		);
		if ( ! Seed_Host_Handoff::is_available() ) {
			echo '<p class="description" style="color:#b32d2e">' . esc_html__(
				'This server has no sodium extension, so this site cannot sign anything. Handoff will stay off until PHP is built with sodium (it is part of PHP core from 7.2).',
				'seed-host'
			) . '</p>';
		}
	}

	/** Section blurb: what proxy mode is, what it costs, and the one portal setting it needs. */
	public static function render_proxy_section(): void {
		$settings = self::get();
		echo '<p>' . esc_html__(
			'Instead of a frame, this site can forward everything under one path (for example /investors) to the portal, so investors never leave this address. Only turn this on if you need it: the embed above is the safer default.',
			'seed-host'
		) . '</p>';
		echo '<div class="notice notice-warning inline"><p><strong>' . esc_html__( 'What proxy mode changes', 'seed-host' ) . '</strong></p><ul style="list-style:disc;margin-left:2em">';
		echo '<li>' . esc_html__( 'The portal then shares this site\'s origin. Any script injection anywhere on this WordPress site — a vulnerable plugin, a compromised theme, an administrator\'s custom code — can read investor data and act as a signed-in investor. The frame keeps the portal on its own origin and does not have this exposure.', 'seed-host' ) . '</li>';
		echo '<li>' . esc_html__( 'Every page cache and CDN in front of this site must exclude the portal path. This plugin marks proxied responses as private and uncacheable, but a cache configured to ignore that would serve one investor\'s pages to another.', 'seed-host' ) . '</li>';
		echo '<li>' . esc_html__( 'Requests under the path are made from this server to the portal. WordPress\'s own cookies are never forwarded; only the portal\'s cookies are.', 'seed-host' ) . '</li>';
		echo '</ul></div>';
		if ( '' !== $settings['proxy_prefix'] ) {
			echo '<p>' . esc_html__( 'The portal must also be told about this address. Add this to its PATH_MOUNTS setting (comma-separated, alongside any others) and restart it:', 'seed-host' ) . '</p>';
			echo '<p><code>' . esc_html( Seed_Host_Proxy::mount_url( $settings['proxy_prefix'] ) ) . '</code></p>';
		}
	}

	/** Proxy on/off. */
	public static function render_field_proxy_enabled(): void {
		$settings = self::get();
		printf(
			'<label for="seed_host_proxy_enabled"><input type="checkbox" id="seed_host_proxy_enabled" name="%s[proxy_enabled]" value="1" %s /> %s</label>',
			esc_attr( self::OPTION ),
			checked( $settings['proxy_enabled'], true, false ),
			esc_html__( 'Forward the portal path to the portal (proxy mode)', 'seed-host' )
		);
		if ( ! Seed_Host_Proxy::is_available() ) {
			echo '<p class="description" style="color:#b32d2e">' . esc_html__(
				'This server has no PHP cURL extension, so proxy mode cannot run here.',
				'seed-host'
			) . '</p>';
		}
	}

	/** Proxy path. */
	public static function render_field_proxy_prefix(): void {
		$settings = self::get();
		printf(
			'<input type="text" class="regular-text code" id="seed_host_proxy_prefix" name="%s[proxy_prefix]" value="%s" placeholder="%s" autocomplete="off" spellcheck="false" />',
			esc_attr( self::OPTION ),
			esc_attr( $settings['proxy_prefix'] ),
			esc_attr( Seed_Host_Proxy_Rules::DEFAULT_PREFIX )
		);
		echo '<p class="description">' . esc_html__( 'The path on this site the portal appears under, from the domain root, with no trailing slash. It must not be a path WordPress uses (/wp-admin, /wp-json and so on), and a page at that address is replaced by the portal. Use the portal address above for its full address including any base path, for example https://portal.example.com or https://portal.example.com/investors.', 'seed-host' ) . '</p>';
	}

	/** Request body cap. */
	public static function render_field_proxy_max_body_mb(): void {
		$settings = self::get();
		printf(
			'<input type="number" class="small-text" id="seed_host_proxy_max_body_mb" name="%s[proxy_max_body_mb]" value="%d" min="%d" max="%d" step="1" />',
			esc_attr( self::OPTION ),
			(int) $settings['proxy_max_body_mb'],
			(int) Seed_Host_Proxy_Rules::MIN_BODY_MB,
			(int) Seed_Host_Proxy_Rules::MAX_BODY_MB
		);
		echo ' <span>' . esc_html__( 'MB', 'seed-host' ) . '</span>';
		echo '<p class="description">' . esc_html__( 'The largest request body forwarded to the portal; anything larger is refused with "413 Request body too large". Data room uploads are sent in 8 MB pieces, so the default of 25 MB is enough. PHP\'s own post_max_size may be lower.', 'seed-host' ) . '</p>';
	}

	/**
	 * The signing key panel: the values an admin copies into the portal, plus the rotate button.
	 *
	 * Deliberately outside the settings form — HTML forms do not nest, and this button is an
	 * action rather than a setting.
	 *
	 * @param array<string, mixed> $settings Effective settings.
	 */
	private static function render_key_panel( array $settings ): void {
		$key_id     = (string) $settings['handoff_key_id'];
		$public_key = (string) $settings['handoff_public_key'];
		$has_key    = '' !== $key_id && '' !== $public_key;

		self::enqueue_admin_assets();
		?>
		<h2 id="seed-host-key"><?php echo esc_html__( 'Handoff signing key', 'seed-host' ); ?></h2>
		<?php if ( $has_key ) : ?>
			<p><?php echo esc_html__( 'Paste both values into Embed → Handoff keys in your portal workspace settings. The private half stays on this server and is never sent anywhere.', 'seed-host' ); ?></p>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="seed_host_key_id"><?php echo esc_html__( 'Key ID', 'seed-host' ); ?></label></th>
					<td>
						<input type="text" class="regular-text code" id="seed_host_key_id" value="<?php echo esc_attr( $key_id ); ?>" readonly onfocus="this.select()" />
						<button type="button" class="button seed-host-copy" data-seed-host-copy="seed_host_key_id" data-seed-host-copied="<?php echo esc_attr__( 'Copied', 'seed-host' ); ?>"><?php echo esc_html__( 'Copy', 'seed-host' ); ?></button>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="seed_host_public_key"><?php echo esc_html__( 'Public key', 'seed-host' ); ?></label></th>
					<td>
						<input type="text" class="large-text code" id="seed_host_public_key" value="<?php echo esc_attr( $public_key ); ?>" readonly onfocus="this.select()" />
						<p><button type="button" class="button seed-host-copy" data-seed-host-copy="seed_host_public_key" data-seed-host-copied="<?php echo esc_attr__( 'Copied', 'seed-host' ); ?>"><?php echo esc_html__( 'Copy', 'seed-host' ); ?></button></p>
						<p class="description"><?php echo esc_html__( 'Ed25519, base64url. The portal will not accept an assertion signed by a key it does not have.', 'seed-host' ); ?></p>
					</td>
				</tr>
			</table>
		<?php else : ?>
			<p><?php echo esc_html__( 'No signing key yet. Generate one, then register its public half in the portal.', 'seed-host' ); ?></p>
		<?php endif; ?>
		<form action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" method="post">
			<input type="hidden" name="action" value="<?php echo esc_attr( self::GENERATE_ACTION ); ?>" />
			<?php wp_nonce_field( self::GENERATE_ACTION ); ?>
			<?php if ( $has_key ) : ?>
				<p class="description">
					<?php echo esc_html__( 'Generating a new keypair replaces the current one immediately. Handoff stops working until you register the new public key in the portal, so add the new key there before removing the old one.', 'seed-host' ); ?>
				</p>
			<?php endif; ?>
			<?php
			submit_button(
				$has_key
					? __( 'Generate a new keypair', 'seed-host' )
					: __( 'Generate a keypair', 'seed-host' ),
				$has_key ? 'secondary' : 'primary',
				'submit',
				true,
				Seed_Host_Handoff::is_available() ? array() : array( 'disabled' => 'disabled' )
			);
			?>
		</form>
		<?php
	}

	/** Registers and enqueues the one admin script (a copy button; no inline JS). */
	private static function enqueue_admin_assets(): void {
		$handle = 'seed-host-admin';
		if ( ! wp_script_is( $handle, 'registered' ) ) {
			wp_register_script(
				$handle,
				plugins_url( 'assets/js/admin.js', SEED_HOST_FILE ),
				array(),
				SEED_HOST_VERSION,
				array( 'in_footer' => true )
			);
		}
		wp_enqueue_script( $handle );
	}

	/** One-shot notice after the keypair button redirects back. */
	private static function render_action_notice(): void {
		// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only flag on a redirect; it selects a message and nothing else.
		$notice = isset( $_GET['seed_host_notice'] ) ? sanitize_key( wp_unslash( $_GET['seed_host_notice'] ) ) : '';
		if ( 'keys-generated' === $notice ) {
			wp_admin_notice(
				esc_html__( 'A new signing keypair was generated. Register the public key below in your portal workspace settings.', 'seed-host' ),
				array( 'type' => 'success' )
			);
		} elseif ( 'keys-failed' === $notice ) {
			wp_admin_notice(
				esc_html__( 'This server could not generate a keypair. The sodium PHP extension is required.', 'seed-host' ),
				array( 'type' => 'error' )
			);
		}
	}

	/**
	 * Admin notices: the things that make an embed render nothing, said once, where an admin will
	 * see them.
	 *
	 * Scoped to the dashboard, the plugins list and our own screen. A notice on every admin page
	 * is how a plugin trains people to ignore its notices.
	 */
	public static function admin_notices(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$screen = function_exists( 'get_current_screen' ) ? get_current_screen() : null;
		$id     = $screen instanceof WP_Screen ? $screen->id : '';
		if ( ! in_array( $id, array( 'dashboard', 'plugins', 'settings_page_' . self::PAGE ), true ) ) {
			return;
		}

		$settings = self::get();
		$on_page  = ( 'settings_page_' . self::PAGE ) === $id;

		if ( $settings['proxy_enabled'] ) {
			$problem = Seed_Host_Proxy::problem( $settings );
			if ( '' !== $problem ) {
				wp_admin_notice(
					esc_html__( 'FundRoom: proxy mode is on but is not running.', 'seed-host' ) . ' ' . esc_html( $problem ),
					array( 'type' => 'error' )
				);
			} elseif ( $on_page ) {
				wp_admin_notice(
					sprintf(
						/* translators: %s: the proxied address, such as https://example.com/investors. */
						esc_html__( 'FundRoom proxy mode is on: %s is served by the portal, on this site\'s origin. See "Advanced: proxy mode" below for what that exposes.', 'seed-host' ),
						'<code>' . esc_html( Seed_Host_Proxy::mount_url( $settings['proxy_prefix'] ) ) . '</code>'
					),
					array( 'type' => 'warning' )
				);
			}
		}

		if ( ! self::is_configured() ) {
			// Not on our own screen: that would be telling someone reading the form that they
			// have not filled in the form.
			if ( ! $on_page ) {
				wp_admin_notice(
					sprintf(
						/* translators: %s: link to the plugin settings screen. */
						esc_html__( 'FundRoom is not connected to a portal yet, so its block and shortcode render nothing. %s', 'seed-host' ),
						'<a href="' . esc_url( self::page_url() ) . '">' . esc_html__( 'Add your portal address and workspace', 'seed-host' ) . '</a>'
					),
					array( 'type' => 'warning' )
				);
			}
			return;
		}

		if ( ! $settings['handoff_enabled'] ) {
			return;
		}
		if ( ! Seed_Host_Handoff::is_available() ) {
			wp_admin_notice(
				esc_html__( 'FundRoom: identity handoff is on, but this server has no sodium extension, so nothing can be signed. No identity is being sent.', 'seed-host' ),
				array( 'type' => 'error' )
			);
			return;
		}
		if ( '' === $settings['handoff_key_id'] || ! Seed_Host_Handoff::has_secret_key() ) {
			wp_admin_notice(
				sprintf(
					/* translators: %s: link to the plugin settings screen. */
					esc_html__( 'FundRoom: identity handoff is on but this site has no signing key. %s', 'seed-host' ),
					'<a href="' . esc_url( self::page_url() ) . '#seed-host-key">' . esc_html__( 'Generate one', 'seed-host' ) . '</a>'
				),
				array( 'type' => 'warning' )
			);
			return;
		}
		if ( '' === Seed_Host_Handoff::site_issuer() ) {
			wp_admin_notice(
				esc_html__( 'FundRoom: identity handoff is on, but this site is not served over https. The portal only accepts assertions from an https site, so no identity is being sent.', 'seed-host' ),
				array( 'type' => 'warning' )
			);
		}
	}
}
