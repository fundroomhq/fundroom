---
"@fundroom/config": patch
"@fundroom/db": patch
"@fundroom/identity": patch
"@fundroom/contracts": patch
"@fundroom/sdk": patch
"@fundroom/server": patch
"@fundroom/web": patch
---

Deploy & first run: distroless multi-arch image (`deploy/docker/Dockerfile`) with `serve`/`migrate` entrypoints, generated master key and setup token in `DATA_DIR`, database wait, pg/undici OTel preload and a Node `HEALTHCHECK`; Compose reference stack with profiles, S3 override, dev stack (Mailpit, local-CA Caddy for `*.fundroom.localhost`) and CI stack; Caddyfile with on-demand TLS `ask` (`/internal/tls/ask`); `/api/v1/setup/*` (status, token verify, owner bootstrap, mail + storage probes) and the `/setup` wizard in the SPA; `fundroom setup-token` and `fundroom seed-demo` with deterministic synthetic factories; `@fundroom/e2e` Playwright + axe suite against the CI stack; new config keys `DATA_DIR`, `SETUP_TOKEN`, `DATABASE_WAIT_TIMEOUT_MS`.
