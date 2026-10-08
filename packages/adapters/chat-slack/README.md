# @fundroom/chat-slack

`ChatWebhookPort` over [Slack incoming webhooks](https://api.slack.com/messaging/webhooks). The composition root always wires it as `ModuleServices.chat` (no config key: a workspace
admin pastes a webhook URL per channel) and gives it its own SSRF-guarded outbound instance (5 s,
64 KiB, no redirects). `notify` uses it for workspace-level alerts (hot leads, round interest and
commitments, verification requests).

```ts
import { createSlackChat } from "@fundroom/chat-slack";

const chat = createSlackChat({ fetch: chatOutbound.fetch, now });
chat.validateUrl(pasted);                  // { ok: true } | { ok: false, reason }, before storing
await chat.post(url, { text: "Hot lead: Ada (score 82)", link: { url, label: "Open" } });
```

- **The URL is a destination and a credential.** Host pinned to `hooks.slack.com`: https only,
  default port, no userinfo, query or fragment, and the path must be `/services/…` or
  `/workflows/…` (2–5 opaque segments, ≤ 500 characters). The request URL is **rebuilt** from the
  validated parts, never the pasted string, so a parser disagreement cannot change the target.
  Callers store the URL envelope-encrypted and never return or log it.
- **No redirects:** `redirect: "manual"` here and `maxRedirects: 0` on the guarded agent; a 3xx
  (or the guard's redirect refusal) is `rejected`, not followed.
- **Payload:** `{ text }` with Slack's `&`, `<`, `>` escaped (so `<!channel>` in a member's name
  cannot ping anyone), text capped at 3 000 characters; `link` becomes a trailing `<url|label>`
  and is dropped unless it is an absolute https URL.
- **Failures** are a typed `ChatPostResult`, never a throw for a remote-side problem:
  404/410 → `not_found` (webhook revoked: paste a new one), 403 and other 4xx/3xx → `rejected`,
  429 → `rate_limited` with `retryAfterMs` from `Retry-After` (seconds or HTTP-date, default
  60 s, clamped to 1 h), 5xx and transport errors → `unavailable`. `notify` disables a channel
  after repeated `not_found`/`rejected` and retries the other two.
- **Nothing leaks the secret:** no `detail` contains the URL or any part of its path, Slack's
  response text is never echoed, and the adapter logs nothing (callers log the typed reason).
- `driver` is `"slack"`. Tests use the `ContainerOptions.chat` / `StartOptions.chat` seam.
