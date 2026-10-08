import {
  type Hook,
  OpenAPIHono,
  type OpenAPIHonoOptions,
  type RouteConfig,
  z,
} from "@hono/zod-openapi";
import type { Context, Env } from "hono";
import {
  API_ERROR_CODES,
  ApiError,
  type ApiErrorCode,
  ErrorBodySchema,
  validationIssues,
} from "./errors.js";

/*
 * OpenAPI conventions (ADR-0002). The document is OpenAPI 3.1, generated from the routes
 * with `getOpenAPI31Document`; `packages/sdk` is generated from the committed
 * `packages/sdk/openapi.json`, and CI's contract job (`oasdiff`, Schemathesis) works on
 * the same document. Rules every route follows so the contract tests stay green:
 *
 *  - every route lists its error statuses through `errorResponses()` (Schemathesis'
 *    `status_code_conformance` fails on an undocumented status);
 *  - request bodies are `.strict()` objects (unknown fields rejected, §10 "API");
 *  - responses are `application/json` except documents/streams, which say so;
 *  - cookie-authenticated routes carry `security: [{ session: [] }]`.
 */
export const API_PREFIX = "/api/v1";
export const SESSION_SECURITY_SCHEME = "session";
/** E3.4: `Authorization: Bearer frk_…` workspace API keys (ADR-0052; legacy `shk_…` still accepted). */
export const API_KEY_SECURITY_SCHEME = "apiKey";
export const REQUEST_ID_HEADER = "X-Request-Id";

/** Documented `Retry-After` for 429/503. */
const RETRY_AFTER_HEADER = {
  "Retry-After": {
    description: "Seconds to wait before retrying",
    schema: { type: "integer" as const, minimum: 1 },
  },
};

const REQUEST_ID_RESPONSE_HEADER = {
  [REQUEST_ID_HEADER]: {
    description: "Correlation id for this request; quote it in support tickets",
    schema: { type: "string" as const },
  },
};

const STATUS_DESCRIPTIONS: Readonly<Record<number, string>> = {
  400: "Malformed request or validation failure",
  401: "Not signed in, or the credential was rejected",
  402: "The workspace's plan does not allow this (`plan_limit`)",
  403: "Signed in but not allowed; may require step-up (`step_up_required`)",
  404: "Not found (also returned when the caller may not know whether it exists)",
  405: "Method not allowed",
  409: "Conflict with current state",
  410: "Gone: the resource existed but has expired",
  413: "Payload too large",
  415: "Unsupported media type",
  421: "Misdirected: the workspace is served by another cell (`wrong_cell`, `X-Fundroom-Cell`; also sent as the deprecated `X-Seedhost-Cell` for one minor release)",
  422: "Understood but refused: a precondition the request must satisfy is missing",
  423: "The workspace is suspended or held for review (`workspace_unavailable`)",
  429: "Rate limited; see `Retry-After`",
  500: "Unexpected server error; the `requestId` locates the log line",
  502: "An upstream vendor (e.g. the e-signature provider) refused or failed the call",
  503: "A dependency (mail, storage, database) is unavailable",
};

/** Response map entries for the given statuses, all with the error envelope. */
export type ResponseEntry = RouteConfig["responses"][string];

export function errorResponses(...statuses: readonly number[]): Record<number, ResponseEntry> {
  const out: Record<number, ResponseEntry> = {};
  for (const status of statuses) {
    const description = STATUS_DESCRIPTIONS[status];
    if (description === undefined) throw new Error(`no description for error status ${status}`);
    out[status] = {
      description,
      content: { "application/json": { schema: ErrorBodySchema } },
      headers: {
        ...REQUEST_ID_RESPONSE_HEADER,
        ...(status === 429 || status === 503 ? RETRY_AFTER_HEADER : {}),
      },
    };
  }
  return out;
}

/** Statuses every route can produce through the kernel middleware, regardless of its own logic. */
export const COMMON_ERROR_STATUSES = [400, 404, 429, 500, 503] as const;

/** `application/json` response entry. */
export function jsonResponse<T extends z.ZodType>(schema: T, description: string) {
  return {
    description,
    headers: REQUEST_ID_RESPONSE_HEADER,
    content: { "application/json": { schema } },
  };
}

/** Strict JSON request body (`additionalProperties: false`). */
export function jsonBody<T extends z.ZodObject>(schema: T, description?: string) {
  return {
    required: true,
    ...(description === undefined ? {} : { description }),
    // `.strict()` keeps the output type; the cast keeps the caller's inferred shape for `c.req.valid("json")`.
    content: { "application/json": { schema: schema.strict() as unknown as T } },
  };
}

export const sessionSecurity = [{ [SESSION_SECURITY_SCHEME]: [] }];

/**
 * Key-callable routes (matrix row `apiKey: true`, E3.4): a session cookie OR an API key. Never
 * both on one request (400 `ambiguous_credentials`).
 */
export const sessionOrApiKeySecurity = [
  { [SESSION_SECURITY_SCHEME]: [] },
  { [API_KEY_SECURITY_SCHEME]: [] },
];

export function requestIdOf(c: Context): string | undefined {
  const v = (c as Context<{ Variables: { requestId?: string } }>).get("requestId");
  return typeof v === "string" ? v : undefined;
}

/** Renders an `ApiError` (status, envelope, extra headers) on a Hono context. */
export function errorResponse(c: Context, error: ApiError): Response {
  for (const [k, v] of Object.entries(error.headers)) c.header(k, v);
  return c.json(error.toBody(requestIdOf(c)), error.status);
}

/** The validation hook for every `OpenAPIHono`: Zod failures become `validation_failed`. */
// biome-ignore lint/suspicious/noExplicitAny: mirrors OpenAPIHonoOptions["defaultHook"], which is Hook<any, E, any, any>
export const validationHook: Hook<any, any, any, any> = (result, c) => {
  if (result.success) return;
  const target = (result as { target?: string }).target;
  const issues = validationIssues(result.error.issues, target);
  return errorResponse(
    c as Context,
    new ApiError("validation_failed", "request validation failed", { issues }),
  );
};

export type ApiOptions<E extends Env> = ConstructorParameters<typeof OpenAPIHono<E>>[0] &
  OpenAPIHonoOptions<E>;

/** An `OpenAPIHono` with the kernel's validation hook and strict routing defaults. */
export function createApi<E extends Env = Env>(options: ApiOptions<E> = {}): OpenAPIHono<E> {
  return new OpenAPIHono<E>({ strict: false, defaultHook: validationHook, ...options });
}

export interface OpenApiDocumentOptions {
  readonly title?: string | undefined;
  readonly version: string;
  readonly description?: string | undefined;
  /** Server URL, usually the API prefix; absolute when generating for a specific install. */
  readonly serverUrl?: string | undefined;
}

/** The generated document, typed loosely on purpose: consumers (`oasdiff`, openapi-typescript) read JSON. */
export type OpenApiDocument = ReturnType<OpenAPIHono["getOpenAPI31Document"]>;

/** Builds the OpenAPI 3.1 document for an API app; registers the session security scheme. */
export function buildOpenApiDocument(
  app: OpenAPIHono<never>,
  options: OpenApiDocumentOptions,
): OpenApiDocument {
  app.openAPIRegistry.registerComponent("securitySchemes", SESSION_SECURITY_SCHEME, {
    type: "apiKey",
    in: "cookie",
    name: "__Host-sid",
    description:
      "Server-side session cookie set by the auth endpoints (`__Host-sid`; `__Secure-sid` on a path-mounted install). Mutating requests must also pass the Origin/Sec-Fetch-Site CSRF check.",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", API_KEY_SECURITY_SCHEME, {
    type: "http",
    scheme: "bearer",
    bearerFormat: "frk_…",
    description:
      "A workspace API key (`Authorization: Bearer frk_…`; keys created before the FundRoom rename start `shk_` and keep working), created by an owner or admin under Settings → API keys. It acts as the member who created it, capped by its scopes, and may call only the routes that list this scheme. Never send a session cookie with it.",
  });
  const doc = app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: options.title ?? "FundRoom API",
      version: options.version,
      ...(options.description === undefined ? {} : { description: options.description }),
      license: { name: "MIT" },
    },
    servers: [{ url: options.serverUrl ?? API_PREFIX }],
  });
  repairPatterns(doc);
  return doc;
}

/*
 * E2.10 ZAP-05. `@asteasolutions/zod-to-openapi` (9.1) renders a zod regex as
 * `regex.toString()` with the leading and a *trailing* `/` stripped, so `/^[A-Z]{3}$/u` became
 * the pattern `^[A-Z]{3}$/u`, which no string matches, and every client, gateway or fuzzer that
 * honours `pattern` rejected every valid value. `pattern` is an ECMA-262 regex with no flags, so
 * the flags are cut off here — or, when the flags change what the source means, the pattern is
 * dropped (a missing pattern under-constrains the contract; a wrong one breaks it):
 *
 *   u / v   `\p{…}`, `\P{…}`, `\u{…}` and v-mode class set syntax mean something else (or
 *           nothing) without the flag → dropped when the source uses them, kept otherwise
 *   i m s   case-insensitivity, multiline `^`/`$` and dotAll have no flag-free spelling → dropped
 *   g y d   no effect on whether a string matches → cut
 *
 * The server still validates with the original regex; this only touches the document.
 */
const FLAG_SUFFIX_RE = /(?<!\\)((?:\\\\)*)\/([dgimsuvy]+)$/u;
const UNICODE_ONLY_RE = /\\[pP]\{|\\u\{/u;
const SET_NOTATION_RE = /--|&&|\\q\{/u;

/** The flag-free pattern for a string the generator produced, or undefined to drop it. */
export function repairPattern(pattern: string): string | undefined {
  const match = FLAG_SUFFIX_RE.exec(pattern);
  if (match === null) return pattern;
  const source = pattern.slice(0, match.index) + (match[1] ?? "");
  const flags = match[2] ?? "";
  if (/[ims]/u.test(flags)) return undefined;
  if (/[uv]/u.test(flags) && UNICODE_ONLY_RE.test(source)) return undefined;
  if (flags.includes("v") && SET_NOTATION_RE.test(source)) return undefined;
  return source;
}

function repairPatterns(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) repairPatterns(item);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key === "pattern" && typeof value === "string") {
      const fixed = repairPattern(value);
      if (fixed === undefined) delete record[key];
      else record[key] = fixed;
    } else {
      repairPatterns(value);
    }
  }
}

/** Status for an error code (used by tests and by modules that document their own codes). */
export function statusOf(code: ApiErrorCode): number {
  return API_ERROR_CODES[code];
}

export { z };
