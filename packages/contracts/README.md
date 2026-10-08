# @fundroom/contracts

API contract vocabulary: the error envelope,
shared Zod/OpenAPI schemas, the kernel route contracts and the OpenAPI 3.1 document builder.
Route *handlers* live in `apps/server` and in modules; the schemas live here so the SDK, the
web app and the contract tests share one definition.

```ts
import { ApiError, createApi, createRoute, errorResponses, jsonBody, jsonResponse, kernel, z } from "@fundroom/contracts";

const api = createApi();                       // OpenAPIHono with the validation hook installed
api.openapi(
  createRoute({
    method: "post",
    path: "/things",
    request: { body: jsonBody(z.object({ name: z.string() })) },   // strict: unknown fields → 400
    responses: { 200: jsonResponse(ThingSchema, "Created"), ...errorResponses(400, 401, 404, 429, 500, 503) },
    security: sessionSecurity,               // documents the cookie session requirement
  }),
  async (c) => { /* … */ throw new ApiError("not_found", "no such thing"); },
);
```

## Error envelope

Every non-2xx JSON response is

```json
{ "error": { "code": "not_found", "message": "…", "requestId": "0192…", "…": "error-specific fields" } }
```

`code` is stable vocabulary from `API_ERROR_CODES` (documented as the `ErrorCode` enum); `message`
is for developers; `requestId` matches the `X-Request-Id` response header. Identity's `AuthError`
codes are a subset with the same statuses, so `toApiError()` adopts them 1:1. Validation failures
are `validation_failed` with `issues: [{ path: "json.email", message, code }]` (paths only, never
the offending value).

## Rules the contract tests rely on

- Every route lists its error statuses through `errorResponses()`; Schemathesis fails on an
  undocumented status. `COMMON_ERROR_STATUSES` (400/404/429/500/503) can come from kernel
  middleware on any route.
- Request bodies go through `jsonBody()` (`additionalProperties: false`).
- Cookie-authenticated routes carry `security: sessionSecurity`.
- `buildOpenApiDocument(app, { version })` registers the `session` cookie scheme and emits
  OpenAPI 3.1 with `servers: [{ url: "/api/v1" }]`.

`kernel` exports the schemas for health, the capability doc, the modules bootstrap and every
auth/session/device route; `UuidSchema`, `EmailSchema`, `SlugSchema`, `TimestampSchema`,
`paginationQuery()` and `page()` are the shared field vocabulary modules should reuse.
