---
"@fundroom/server": minor
"@fundroom/contracts": minor
"@fundroom/module-kit": minor
"@fundroom/sdk": minor
"@fundroom/config": minor
---

Add the API and contracts layer. `@fundroom/contracts` defines the error envelope (`ApiError`, `Error`/`ErrorCode` components), shared Zod/OpenAPI schemas, the kernel route contracts (health, capability doc, modules bootstrap, auth, sessions, devices) and the OpenAPI 3.1 document builder. `@fundroom/module-kit` ships `defineModule()`, the registry (dependency order, `MODULES` selection, merged jobs/subscriptions/permissions), per-workspace enablement and the `/api/v1/modules` bootstrap. `@fundroom/server` is the composition root: config → adapters, tenant resolution (host label, `/w/<slug>`, `/embed/<slug>`, single-tenant), session + membership + CSRF, `/api/v1` with every identity flow as routes, `/healthz` `/readyz` `/metrics` `/.well-known/fundroom.json` `/csp-report`, pino logs with redaction, OpenTelemetry metrics/traces, graceful shutdown, and the `fundroom` CLI (`serve`, `migrate`, `doctor`, `openapi`, `audit`). `@fundroom/sdk` is the typed client generated from the committed `openapi.json`. `@fundroom/config` gains `INSTANCE_NAME`, `CORS_ALLOWED_ORIGINS`, `WEB_DIST_PATH`, `SHUTDOWN_TIMEOUT_MS`, `METRICS_ENABLED`, `METRICS_TOKEN`.
