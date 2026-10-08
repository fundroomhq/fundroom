# @fundroom/domain-cloudflare-saas

`CustomDomainProviderPort` for [Cloudflare for
SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/).
Cloudflare terminates TLS for a workspace's custom hostname and forwards to our origin, so the certificate is
Cloudflare's to issue and ours only to ask for. Set-up (API token, fallback origin, CNAME target):
[`docs/runbooks/custom-domains.md`](../../../docs/runbooks/custom-domains.md#cloudflare-for-saas).

Exports `createCloudflareSaasProvider(deps)`, `mapCustomHostname`, `CloudflareApiError`,
`CLOUDFLARE_CALL_BUDGET`, `CLOUDFLARE_WORKSPACE_BUDGET`, `CLOUDFLARE_INTERACTIVE_BUDGET` and
`CLOUDFLARE_DUPLICATE_CODES`.

- **Order is the security property.** `requires` is `{ cname: true, txt: true }`, and
  `@fundroom/custom-domains` calls `activate` only on `pending → dns_ok`. So our own `_fundroom-challenge` TXT
  has proved control before Cloudflare is ever asked to issue.
- `activate` creates the custom hostname (DV, `http` validation, TLS ≥ 1.2) and returns Cloudflare's id as the
  provider ref. A 409 (codes 1406/1439) is resolved by an exact-hostname lookup and adoption.
- `status` maps the hostname's `status` + `ssl.status`: both `active` = active; `moved`, `deleted`, blocked and
  timed-out states = failed; anything else = pending. It surfaces Cloudflare's ownership and DCV TXT records as
  optional instructions. By id, a 404 is authoritative (`failed`). A search that finds nothing is "unknown",
  never `failed`.
- `deactivate` deletes the hostname (a 404 is fine).
- **Rate limits.** Every call draws, innermost first, on the workspace's budget (60 per 5 minutes), the
  interactive budget for admin-triggered calls (600), and the install's 900 per 5 minutes (the shared Postgres
  rate limiter when given), against Cloudflare's 1 200. Background work therefore keeps at least 300 calls.
  `admit()` charges one call up front, for the release job, which then deletes under a per-hostname lock. A
  429 opens a local breaker until `retry-after` (default 5 min, at most 15).
- The guarded fetch has a 5 s timeout, 1 MiB answers and no redirects. Error messages come from Cloudflare's
  `errors[]` and the status, never the request, so they never carry the token.
