# @fundroom/sdk

Typed API client: `openapi-typescript` types generated from `openapi.json` in this
package, wrapped by `openapi-fetch`. This is the only network layer for the web app, the embed
and integrations.

```ts
import { createFundRoomClient, unwrap } from "@fundroom/sdk";

const api = createFundRoomClient({ origin: "https://investors.acme.com" }); // same origin: omit
await api.POST("/auth/otp/start", { body: { email } });
const me = unwrap(await api.GET("/me"));            // typed data, or throws FundRoomApiError
```

- Cookies are sent (`credentials: "include"`); a cross-origin caller must be on the
  workspace's CORS allow-list.
- `unwrap()` turns the error envelope into `FundRoomApiError` (`code`, `status`, `requestId`,
  `body`); `isErrorBody()` recognises the envelope.
- `requestId: () => string` adds `X-Request-Id` to every call; the server echoes it.

## Server-side: API keys

```ts
const api = createFundRoomClient({
  origin: "https://investors.acme.com",
  apiKey: process.env.FUNDROOM_API_KEY, // frk_…
});
const contacts = unwrap(await api.GET("/crm/contacts", {}));
```

- `apiKey` sends `Authorization: Bearer frk_…` and forces `credentials: "omit"` (a request with
  both a session cookie and a key is refused as `ambiguous_credentials`).
- A malformed key throws `TypeError` at construction (the message never echoes it).
- **Server-side only**: with a DOM present (`window` and `document`) the client refuses a key
  unless `dangerouslyAllowBrowser: true` — anyone who can open the page can read the key.
- A key reaches only the routes whose OpenAPI `security` lists `apiKey`; see
  [`docs/api/README.md`](../../docs/api/README.md) for scopes, limits and errors.

## Receiving webhooks

```ts
import { verifyWebhook, WebhookVerificationError } from "@fundroom/sdk"; // or "@fundroom/sdk/webhooks"

const body = await request.text(); // the raw body, never re-serialised JSON
await verifyWebhook({ headers: request.headers, body, secret: process.env.FUNDROOM_WEBHOOK_SECRET });
```

`verifyWebhook` (Standard Webhooks, WebCrypto only: Node ≥ 20, Deno, Bun, edge runtimes) checks the
three `webhook-*` headers, a 5-minute timestamp tolerance and every `v1,` signature, and throws
`WebhookVerificationError` (`.reason`) otherwise. `signPayload` signs test requests;
`FundRoomWebhookEvent` types the body. `src/webhooks.ts` is a copy of
`packages/webhooks/src/signature.ts` (the SDK must not depend on that server-side package);
`webhooks.test.ts` fails if they drift. Guide: [`docs/api/webhooks.md`](../../docs/api/webhooks.md).

## Keeping the contract current

`openapi.json` is written by `pnpm --filter @fundroom/server openapi` and committed; `pnpm
--filter @fundroom/sdk generate` (part of `build`) regenerates `src/generated/openapi.ts`
from it. CI's contract job runs `openapi:check` and fails when the committed document is behind
the routes, and `oasdiff` flags breaking changes against the base branch (label `api-major` to
allow them).
