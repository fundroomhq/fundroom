---
"@fundroom/server": minor
"@fundroom/web": minor
"@fundroom/config": minor
"@fundroom/mail": minor
"@fundroom/identity": patch
"@fundroom/sdk": patch
"@fundroom/embed": patch
"@fundroom/outbound-http": patch
"@fundroom/clickwrap": patch
"@fundroom/esign": patch
"@fundroom/portability": patch
"@fundroom/audit": patch
"@fundroom/branding": patch
"@fundroom/i18n": patch
"@fundroom/contracts": patch
"@fundroom/sanctions-ofac": patch
---

The product is now called **FundRoom**, step 1 of the rename: what people
see. `INSTANCE_NAME` and `PASSKEY_RP_NAME` default to `FundRoom`; emails, the setup banner, the
"Powered by" line, SDK and embed error messages, export and audit-bundle READMEs and docs say
FundRoom; the mail default accent is the app primary `#1d4ed8` (was `#1f4b99`); a new interim mark
ships as `favicon.svg`, PNG icons and `site.webmanifest`; outbound `User-Agent` is
`FundRoom/<version>`. The image is `ghcr.io/fundroomhq/fundroom` and the Helm chart is
`deploy/helm/fundroom` (`oci://ghcr.io/fundroomhq/charts/fundroom`; its selector labels change, so
reinstall a release made from a local checkout of the old chart). PaaS templates name their
services `fundroom*`, dev hosts are `*.fundroom.localhost`, the security contact is
`security@fundroom.com` and the update index defaults to `https://releases.fundroom.com/index.json`.
The WordPress plugin is displayed as FundRoom; its slug and text domain stay `seed-host`.
Identifiers (`@seed-host/*`, the `seedhost` CLI, `SEEDHOST_*`, `_seedhost-challenge`, headers,
meters, metrics) are renamed with aliases in the next step. Cryptographic labels and export format
ids never change.
