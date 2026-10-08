import createClient, { type Client, type ClientOptions, type Middleware } from "openapi-fetch";
import type { components, paths } from "./generated/openapi.js";

/*
 * `@fundroom/sdk` (ADR-0002): the only network layer for the web app, the embed and
 * integrations. Types come from `openapi.json` next to this package, which
 * `fundroom openapi` writes from the server's routes; CI fails when the two drift.
 *
 * Two ways to authenticate:
 *  - session (default): the client sends cookies (`credentials: "include"`), so a cross-origin
 *    caller must be on the workspace's CORS allow-list; same-origin callers (the SPA) need
 *    nothing else.
 *  - API key (E3.4, ADR-0052): `apiKey: "frk_…"` sends `Authorization: Bearer frk_…` and no
 *    cookies (`credentials: "omit"`; a request carrying both is refused as
 *    `ambiguous_credentials`). Server-side only: a key in a browser bundle is a leaked key, so
 *    the client refuses to build in a browser unless `dangerouslyAllowBrowser: true`.
 */
export type FundRoomPaths = paths;
export type FundRoomSchemas = components["schemas"];
export type ErrorBody = FundRoomSchemas["Error"];
export type ErrorCode = FundRoomSchemas["ErrorCode"];
export type FundRoomClient = Client<paths>;

export interface FundRoomClientOptions extends Omit<ClientOptions, "baseUrl"> {
  /** Origin (+ base path) of the portal, e.g. `https://investors.acme.com`. Default: same origin. */
  readonly origin?: string | undefined;
  /** Client-generated request id sent as `X-Request-Id` (echoed back, shown in errors). */
  readonly requestId?: (() => string) | undefined;
  /**
   * A workspace API key (`frk_…`, or `shk_…` from before the FundRoom rename; 47 characters).
   * Sent as `Authorization: Bearer <key>` with
   * `credentials: "omit"`. Server-side only — see `dangerouslyAllowBrowser`.
   */
  readonly apiKey?: string | undefined;
  /**
   * Allow `apiKey` where a DOM is present (`window` and `document` defined). Anyone who can open
   * the page can read the key, which acts as its creator with every scope it holds; only for
   * internal tools whose every user may hold that key. Default false.
   */
  readonly dangerouslyAllowBrowser?: boolean | undefined;
}

/**
 * The shape of a FundRoom API key: `frk_` + base64url(32 bytes). Keys created before the FundRoom
 * rename start `shk_` and are still accepted by the server, so both pass.
 */
export const API_KEY_PATTERN = /^(?:frk|shk)_[A-Za-z0-9_-]{43}$/u;

function looksLikeBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown };
  return typeof g.window !== "undefined" && typeof g.document !== "undefined";
}

export const API_PREFIX = "/api/v1";

/** True when a JSON body is the server's error envelope. */
export function isErrorBody(value: unknown): value is ErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const error = (value as { error?: unknown }).error;
  return (
    typeof error === "object" &&
    error !== null &&
    typeof (error as { code?: unknown }).code === "string" &&
    typeof (error as { message?: unknown }).message === "string"
  );
}

/** Thrown by `unwrap()`; carries the envelope, status and request id. */
export class FundRoomApiError extends Error {
  override readonly name = "FundRoomApiError";
  constructor(
    readonly status: number,
    readonly body: ErrorBody,
    readonly requestId: string | undefined,
  ) {
    super(`${body.error.code}: ${body.error.message}`);
  }
  get code(): ErrorCode {
    return this.body.error.code;
  }
}

/** `const me = unwrap(await client.GET("/me"))` — data or a typed throw. */
export function unwrap<T>(result: { data?: T; error?: unknown; response: Response }): T {
  if (result.error !== undefined || result.data === undefined) {
    const body: ErrorBody = isErrorBody(result.error)
      ? result.error
      : { error: { code: "internal_error", message: `HTTP ${result.response.status}` } };
    throw new FundRoomApiError(
      result.response.status,
      body,
      result.response.headers.get("x-request-id") ?? undefined,
    );
  }
  return result.data;
}

export function createFundRoomClient(options: FundRoomClientOptions = {}): FundRoomClient {
  const { origin, requestId, apiKey, dangerouslyAllowBrowser, ...rest } = options;
  if (apiKey !== undefined) {
    // The message never echoes the value: it is a credential.
    if (!API_KEY_PATTERN.test(apiKey)) {
      throw new TypeError("apiKey is not a FundRoom API key (expected frk_ + 43 characters)");
    }
    if (looksLikeBrowser() && dangerouslyAllowBrowser !== true) {
      throw new Error(
        "Refusing to use a FundRoom API key in a browser: anyone who can open the page can read it. " +
          "Call the API from a server, or pass dangerouslyAllowBrowser: true if you accept that.",
      );
    }
  }
  const client = createClient<paths>({
    ...rest,
    baseUrl: `${(origin ?? "").replace(/\/$/u, "")}${API_PREFIX}`,
    // A key request must carry no cookie: session + key is refused as ambiguous_credentials.
    credentials: apiKey !== undefined ? "omit" : (rest.credentials ?? "include"),
  });
  if (apiKey !== undefined) {
    const authorization = `Bearer ${apiKey}`;
    client.use({
      onRequest({ request }) {
        request.headers.set("authorization", authorization);
        return request;
      },
    });
  }
  if (requestId) {
    const middleware: Middleware = {
      onRequest({ request }) {
        if (!request.headers.has("x-request-id")) request.headers.set("x-request-id", requestId());
        return request;
      },
    };
    client.use(middleware);
  }
  return client;
}

export {
  type SignPayloadInput,
  signPayload,
  type VerifiedWebhook,
  type VerifyWebhookInput,
  verifyWebhook,
  WEBHOOK_ID_HEADER,
  WEBHOOK_SECRET_PREFIX,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_TOLERANCE_SECONDS,
  type WebhookHeaders,
  WebhookVerificationError,
  type WebhookVerificationReason,
} from "./webhooks.js";

/**
 * The JSON body of a FundRoom webhook delivery (Standard Webhooks). `data` carries ids only
 * (never session identifiers); fetch details with an API key.
 */
export interface FundRoomWebhookEvent<TData = Record<string, unknown>> {
  /** The delivery id (= `webhook-id`), stable across retries of the same delivery. */
  readonly id: string;
  /**
   * The event's id, the same on every delivery of that event — including a manual redelivery,
   * which gets a new `id`. Dedupe on this for at-most-once processing. `ping:<uuid>` for tests.
   */
  readonly eventId: string;
  /** The topic, e.g. `document.viewed`, or `webhook.ping` for a test send. */
  readonly type: string;
  /** ISO 8601 time the event happened. */
  readonly timestamp: string;
  readonly workspaceId: string;
  readonly data: TData;
  readonly schemaVersion: number;
}
