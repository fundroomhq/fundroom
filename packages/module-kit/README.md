# @fundroom/module-kit

Module manifests and the registry. A module is a workspace
package whose default export is `defineModule({...})`; the composition root (`apps/server`)
wires what it declares. Nothing is discovered at runtime.

```ts
import { defineModule } from "@fundroom/module-kit";

export default defineModule({
  id: "data-room", version: "1.0.0", dependsOn: ["access"],
  schema: "dataroom", migrations: new URL("./migrations/", import.meta.url),
  permissions: ["data-room.read", "data-room.manage"],
  routes: (r) => r.openapi(listDocumentsRoute, listDocuments),   // mounted at /api/v1/data-room
  jobs: [{ name: "data-room.render", handler: renderHandler }],
  events: { emits: ["document.viewed"], handles: { "membership.revoked": purgeRenditions } },
  settingsSchema: z.object({ watermark: z.boolean().default(true) }),
  flags: { "data-room.file-requests": { default: false } },
  slots: { "investor.nav": [{ id: "documents", label: "Documents", to: "/documents", order: 20 }] },
  offeringStatusRules: { hiddenWhen: ["informational"] },
});
```

`defineModule` validates at import time: kebab-case id, SemVer, permissions/jobs/flags prefixed
with the id, a schema whenever there are migrations, no self-dependency.

## Registry

`createModuleRegistry(manifests, { only })` orders modules by `dependsOn` (deterministic
Kahn, ties by id; cycles, duplicates and unknown dependencies throw), applies the `MODULES`
selection (plus transitive dependencies), and merges contributions: `permissions`
(`<module>.<verb>` → module), `migrationSources`, `jobs`, `subscriptions`
(`<module>.<topic_with_underscores>`), `flagDefaults`.

## Enablement and bootstrap

`core.module_enablement` overrides each manifest's `defaultEnabled` per workspace
(`ModuleEnablementRepo.set(module, enabled, config)`); a module whose dependency is off is off.
`createEnablementCache(registry)` resolves this once per workspace with a 15 s TTL
(`invalidate(workspaceId)` after a change). `buildBootstrap()` renders the `/api/v1/modules`
body: enabled/hidden per module (hidden = offering-status rule, investors only), flags, slots
(empty when disabled or hidden), the caller's membership and permissions.

`permissionsFor()` narrows the catalogue to enabled modules and lets `AuthzPort` (the matrix in
`@fundroom/authz`) decide what a role holds; external kinds hold no permission.

## Module routes and `ModuleServices`

`routes(api, services)` receives an `OpenAPIHono<ModuleEnv>` whose variables the kernel
middleware has already set (`requestId`, `log`, `workspace`, `tenant`, `session`, `membership`,
`embed`) and the kernel services behind their ports: `db`, `authz`, `audit`, `queue`,
`storage`, `mailer`, `rateLimiter`, a registry view, `enablement`, `workspaces.invalidate`,
`guards.requirePermission(p, { fresh })` / `guards.requireMember()`, `baseUrl`, `trustProxy`,
`now`, `log`, `clientIp(c)`. Read services inside handlers only: the composition root builds
them as a lazy proxy and generates the OpenAPI document against a throwing stub. A module route
never runs without a workspace or with the module disabled: the server mounts a guard that
answers `setup_required` / `module_disabled` (both 404) first.

### View as investor

`ModuleVariables.viewAs` (and `tenant.viewAs`) is set while a staff session views the workspace
as an investor. `membership` and `tenant` are then the investor's; mutating methods never reach a
module route (403 `view_as_read_only` in the kernel middleware). A **read** route must skip what
the investor's own visit would record — engagement events, exposure stamps, view audits — and a
download or export must answer `view_as_read_only`. Services can test `ctx.viewAs` directly
(`isViewingAs` from `@fundroom/db`). `audit.record` under a view-as context throws a typed
403 error, and the context's transactions are `READ ONLY`, so an omission fails loudly.

## Content blocks

A module that owns data the overview page can show registers `blockHydrators:
[{ type: "document_list", hydrate(data, { tenant, viewer, facts }) }]`; the registry merges
them by type into `registry.blockHydrators` (with the providing module id) and the content
module hydrates after section visibility, only when that module is enabled in the workspace.
