#!/bin/sh
# wp.test seeding (harness): install WordPress, activate the FundRoom plugin from
# plugins/wordpress (mounted), and turn its proxy mode on at /investors — the WP-CLI equivalent
# of Settings → FundRoom → Advanced. Runs in the official WP-CLI image against the same volume
# as the apache container, then idles so `docker compose up --wait` can read it as healthy.
set -eu
cd /var/www/html

# The apache container's entrypoint writes wp-config.php (from WORDPRESS_* env) on first start.
until [ -f wp-config.php ]; do sleep 1; done
until wp db check >/dev/null 2>&1; do sleep 1; done

if ! wp core is-installed 2>/dev/null; then
  wp core install --url=https://wp.test --title="Acme (WordPress)" \
    --admin_user=admin --admin_password=e2e-admin-password-not-a-secret \
    --admin_email=admin@example.com --skip-email
fi
wp plugin activate seed-host

# Proxy mode (plugins/wordpress README "Proxy mode"). base_url is the portal root including its
# BASE_PATH; proxy_prefix is the public path on this site.
wp option update seed_host_settings \
  '{"base_url":"https://portal.test/investors","workspace":"acme-inc","proxy_enabled":true,"proxy_prefix":"/investors","proxy_max_body_mb":25}' \
  --format=json
wp rewrite structure '/%postname%/' --hard
wp rewrite flush --hard

touch /tmp/seeded
echo "wp.test seeded"
exec tail -f /dev/null
