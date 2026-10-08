# @fundroom/api-keys

Workspace API keys: the `frk_` token, how it is stored, what a key row means, and
the data access behind `core.api_key`. The HTTP surface (`/api-keys`, the bearer resolver, the
guards) lives in `apps/server`; the developer-facing guide is [`docs/api/README.md`](../../docs/api/README.md).

It is a kernel package and not a module because a key *authenticates a request*: the bearer
resolver runs before module enablement is consulted, and anything read during that resolution
cannot belong to something a workspace can switch off.

## The decision everything else follows from: a key acts as its creator, capped by its scopes

A key is not a principal of its own. On every request its effective permissions are
`scopes ∩ permissionsForRole(creator's current role)`, and the creator's membership must be live.
The tenant context is the creator's (`actorKind: "staff"`), so row-level security and the audit
chain attribute everything to a real member, with `meta.apiKeyId` saying which integration it was.

The alternative — a key as an independent service principal with its own role — would mean a
second kind of actor in RLS, the audit log, erasure and every "who did this" screen, and a key that
outlives the person who was trusted to create it. Tying it to the creator means demotion narrows it
and departure kills it (401 at once; the hourly `api-keys.sweep` then revokes it as
`creator_inactive`), and erasure revokes it (`erased`).

A key never satisfies a step-up (`fresh`) requirement, `session`, `member` or `owner-or-admin`, and
only reaches routes whose matrix row has `apiKey: true`. Scopes are limited to `apiKeyScopes()` from
`@fundroom/authz` (permissions required by at least one such row) and must be held by the creator
when the key is minted.

## The token

- `frk_` + base64url(32 random bytes) = 47 characters, from `mintApiKeyToken()`. Returned once by
  create and rotate; stored nowhere. Keys minted before the FundRoom rename start `shk_`
  (`LEGACY_API_KEY_TOKEN_PREFIX`); they are accepted permanently. `API_KEY_TOKEN_RE` and
  `looksLikeApiKey()` take both prefixes (`API_KEY_TOKEN_PREFIXES`), the lookup hashes the whole
  token so an old key finds its row unchanged, and core migration `0027_fundroom_identifiers`
  widened the `api_key_prefix_shape` check to `^(shk|frk)_`. Rotating an old key mints an `frk_` one.
- Stored as `sha256(token)` (`apiKeyTokenHash`). 256 bits of entropy make a slow KDF pointless and
  keep the lookup one indexed equality.
- `isPlausibleApiKey()` (`API_KEY_TOKEN_RE`) runs before any hashing or database work, so an
  unauthenticated caller cannot make the server index-probe arbitrary input. `looksLikeApiKey()`
  (prefix only) lets the resolver ignore every other `Authorization: Bearer` value.
- The first 12 characters (`displayPrefix`) are kept in clear so people can tell keys apart; the
  `frk_` prefix is what secret scanners match (`.gitleaks.toml`, rule `fundroom-api-key`, which also
  matches `shk_`).

## Layout

- `token.ts` — minting, hashing, plausibility, display prefix. No database.
- `types.ts` — `ApiKeyRecord`, `ApiKeyView`, `apiKeyStatus()` (`live | expired | revoked`) and the
  limits: 50 live keys per workspace, name ≤ 80, note ≤ 500, lifetime ≤ 2 years, rotation grace
  0–168 h (default 24), 600 requests / 60 s per key, `last_used_at` written at most once a minute.
- `repos/api-key-repo.ts` — `ApiKeyRepo(ctx, tx)`. Drizzle stays in `repos/`
  (`only-repos-touch-drizzle`).
- `service.ts` — create, rotate, revoke, authenticate and the creator-liveness sweep.
