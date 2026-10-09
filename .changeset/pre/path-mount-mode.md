---
"@fundroom/config": minor
"@fundroom/http": minor
"@fundroom/identity": minor
"@fundroom/sso": patch
"@fundroom/server": minor
"@fundroom/web": minor
---

Path-mount mode: the portal can be served under a path of the customer's own site — `https://acme.com/investors` — through their reverse proxy, alongside its own address, in either the "preserve" shape (the path reaches the portal unchanged) or the "replace" shape (a public `/portal` in front of an internal `/investors`).

`@fundroom/config` adds `PATH_MOUNTS`, the allow-list that gates it: comma-separated `origin + prefix` URLs, at most 16, https in staging and production, single-tenant installs only. `BASE_URL` may now be one of those URLs, and a mounted install refuses `HSTS_INCLUDE_SUBDOMAINS`/`HSTS_PRELOAD` and any mount origin in `CORS_ALLOWED_ORIGINS`. `doctor` prints the mounts and warns about prefixes it cannot tell apart. `@fundroom/http` adds `matchPathMount`: a request is mounted only when its single `X-Forwarded-Prefix` names a listed prefix byte for byte, and `X-Forwarded-Host` can only choose among mounts sharing a prefix (failing closed when it does not). `securityHeaders` gains per-request `cspReportUri` and `omitHsts`. `@fundroom/identity` adds the `partitioned_path_mount` cookie mode (an embed under a base path was sending `__Host-…; Path=/`) and `isPathScopedMode`. `@fundroom/sso` builds IdP-facing URLs from `BASE_URL` itself rather than its origin plus `BASE_PATH`.

`@fundroom/server` resolves a per-request public base and origin that everything presentational reads: runtime config, `index.html` asset URLs, cookie name and `Path`, relative redirects, the CSP report endpoint, the CSRF origin, logo URLs. Everything canonical — email and magic links, OIDC and SAML callbacks (including the OIDC token request's `redirect_uri`), vendor webhooks, `security.txt`, the OpenAPI `servers` entry — comes from `BASE_URL`. Private responses carry `Vary: Cookie, X-Forwarded-Prefix`. Mounted responses carry no HSTS. Passkeys are offered only on the relying party's origin. Fixed along the way: double-prefixed URLs from (`workspaceUrl` callers) and the shipped Caddy edge's `ask`, `/internal/*`, `/metrics` and health-check paths under a base path (`FUNDROOM_BASE_PATH`). `@fundroom/web` loads lazy chunks relative to the entry script, so they resolve under any prefix without a rebuild, and reloads once when a stale tab asks for a chunk that a deploy removed.

Recipes for nginx, Caddy, Cloudflare Workers, Next.js and WordPress are files under `e2e/pathmount/` that the new `50-path-mount` suite runs verbatim in real servers; Vercel and Netlify are documented as untested. The WordPress plugin (versioned separately, 0.2.0) gains an opt-in proxy mode that streams the portal through PHP under one path and forwards only the portal's own cookies. Docs: `docs/embed/path-mount.md`, the recipe pages, `docs/runbooks/path-mount.md`, threat-model entries T13–T17.
