# @fundroom/integration-slack

`IntegrationAdapter` for a Slack app installed with OAuth v2 (bot token): public channel list and
`chat.postMessage`. It backs the notify channel kind `slack_app`; the older
incoming-webhook kind (`@fundroom/chat-slack`) is unchanged. Stateless: the kernel
`@fundroom/integrations` owns the connection, unseals the token and passes it per call. Runtime
dependency: `@fundroom/ports` only; every call goes through the injected, SSRF-guarded
`deps.fetch` with `redirect: "manual"` (the guarded agent also has `maxRedirects: 0`), and a
response over 2 MiB is `too_large`.

## Endpoints used

All Web API calls are `POST https://slack.com/api/<method>`.

| Adapter method | Slack call | Confidence |
|---|---|---|
| `meta.oauth.authorizeUrl` | `https://slack.com/oauth/v2/authorize` (kernel adds `client_id`, `scope`, `redirect_uri`, `state`) | verified (Slack OAuth docs) |
| `exchangeCode` | `oauth.v2.access` form `{code, redirect_uri}`, client credentials as HTTP Basic | verified (Basic is Slack's documented preference) |
| `refresh` | `oauth.v2.access` form `{grant_type: refresh_token, refresh_token}` | verified (token rotation docs) |
| `revoke` | `auth.revoke` (Bearer) | verified |
| `verify` | `auth.test` (Bearer) → `team` as the account label, `team_id` as `externalAccountId` | verified |
| `chat.listChannels` | `conversations.list` form `{types: public_channel, exclude_archived: true, limit: 200, cursor}`; follows `response_metadata.next_cursor`; stops at 50 pages (`too_large`); result sorted by name | verified |
| `chat.post` | `chat.postMessage` JSON `{channel, text, blocks?, unfurl_links: false, unfurl_media: false}` | verified |

Bot scopes requested: `chat:write`, `chat:write.public` (post to public channels without inviting
the bot), `channels:read` (list public channels). `scopeSeparator` is `,`.

## Mapping notes

- **Token set**: `access_token` (must be a `bot` token), `scope`, `team.id` → `externalAccountId`,
  `extra = {teamName, botUserId, appId, enterpriseId?}`. Token rotation is off by default for a
  Slack app; when the operator turns it on, `refresh_token` and `expires_in` are honoured
  (`expiresAt = now + expires_in`) and a refresh returns the rotated refresh token.
- **Text**: `&`, `<`, `>` are escaped exactly like `@fundroom/chat-slack` (`escapeSlackText`), so a
  message can never ping `@channel` or render a link; text is capped at 4 000 characters. `blocks`
  (at most 50) are passed through **unescaped** — callers that build blocks own their escaping
  (notify posts text only).
- **Channel ids** must match `^[A-Z0-9]{1,40}$`; anything else is `not_found` without a call.
- **Errors**: Slack answers HTTP 200 with `{ok:false, error}`. `invalid_auth`, `not_authed`,
  `token_revoked`, `token_expired`, `account_inactive`, `invalid_refresh_token`, `invalid_grant`,
  `invalid_code`, `code_already_used`, bad client/redirect → `unauthorized`; `missing_scope`,
  `not_in_channel`, `not_allowed_token_type`, `restricted_action*`, `ekm_access_denied`,
  `access_denied` → `forbidden`; `channel_not_found`, `is_archived` → `not_found`; `ratelimited` →
  `rate_limited`; `internal_error`, `fatal_error`, `service_unavailable`, `request_timeout` →
  `unavailable`; any other token → `malformed`. HTTP 429 → `rate_limited` (detail
  `retry after <n>s`), 5xx → `unavailable`, 3xx → `malformed`. The detail is only ever the Slack
  error token (`^[a-z0-9_.]{1,64}$`) or a fixed phrase — never the token or free text.

## Deviations / inferred

- **No PKCE.** Slack made PKCE generally available on 2026-03-30, but enabling it is an app setting
  that marks the app a *public* client (for desktop/mobile apps without a secret). FundRoom is a
  confidential server-side client with the secret in env, so `pkce: false`.
- The test seam `createSlackAdapter(deps, {apiBaseUrl, authBaseUrl})` rebases the API and the
  authorize page (for `ContainerOptions.integrationAdapters`); production uses the shared `slackMeta`.
- Enterprise Grid org-wide installs are not specifically supported: `team.id` is `null` there, so
  `externalAccountId` comes from `auth.test`'s `team_id` at verify.

## Operator setup (vendor side)

1. <https://api.slack.com/apps> → **Create New App** → From scratch.
2. **OAuth & Permissions** → Redirect URLs: `${BASE_URL}/oauth/integrations/callback`; Bot Token
   Scopes: `chat:write`, `chat:write.public`, `channels:read`. Leave token rotation off (supported
   if on). Leave PKCE off.
3. **Manage Distribution** → activate public distribution if more than one Slack workspace installs it.
4. Put **Client ID** / **Client Secret** in `INTEGRATIONS_SLACK_CLIENT_ID` / `INTEGRATIONS_SLACK_CLIENT_SECRET`.

## Testing

`src/index.test.ts` (fake fetch, no network): meta and test seam, code exchange (Basic auth, token
rotation fields, user-token refusal), refresh → `unauthorized`, revoke never throws, verify,
the error-token table, HTTP/transport failures (429 + Retry-After, 5xx, redirect, non-JSON, 2 MiB
cap, guard errors), pagination with cursor and the 50-page cap, escaping, blocks, and that the
bearer token never appears in a failure.
