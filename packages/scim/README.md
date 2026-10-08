# @fundroom/scim

SCIM 2.0 provisioning of staff: the per-workspace SCIM token, the SCIM user and group
projections, group → role mapping, and the service behind `{BASE_URL}/scim/v2`. The HTTP surface lives
in `apps/server` (`routes/scim.ts` for the protocol, `routes/sso.ts` for the admin API); the admin guide
is [`docs/sso/scim.md`](../../docs/sso/scim.md). SSO itself is [`@fundroom/sso`](../sso/README.md).

## The decision everything else follows from: SCIM is its own narrow principal

A SCIM token is **not** an API key. An API key acts as its creator, capped by scopes, and
dies with the creator's membership. Provisioning must do the opposite — keep deprovisioning people
after the admin who set it up has left — so the token is a principal of its own, and what keeps it
safe is how little it can do:

- one workspace, taken from the token row, never from the `Host` header;
- only `/scim/v2` routes admit it;
- only **staff memberships** of that workspace: create, update, suspend, reactivate, revoke, and the
  role via mapped groups;
- only emails in the workspace's **verified SSO domains**;
- **never owners** (role recompute skips them; deactivating or deleting one is `400 mutability`);
- **never global user fields**: SCIM's `userName`, emails, names and `externalId` live on the
  per-workspace `core.scim_user`. A SCIM `PUT` that changed a global email would reroute that person's
  email-code sign-in in every workspace; this cannot happen.

Its creator is recorded but nullable (`ON DELETE SET NULL`): a token **outlives its creator** and ends
only when an owner revokes it on the SSO page (`sso.manage` is owner-only). Audit rows name a system
actor `scim:<tokenId>`. A token of a deleted workspace answers 401.

## Public surface

- `ScimTokenView`, `ScimAdminView` (`enabled` = `SCIM_ENABLED`, `baseUrl` = `{BASE_URL}/scim/v2`, tokens,
  counts), `ScimUserRow`, `ScimGroupRow`, `MappableRole`
  (`"admin" | "editor" | "viewer" | "finance" | "legal"`).
- `createScimService(deps)` → `ScimService`:
  - admin: `adminView`, `createToken` (returns the token once; `scim_token_limit` at 2 live),
    `revokeToken`, `listUsers` (cursor-paginated), `listGroups`, `setGroupRole` (recomputes members'
    roles);
  - protocol: `authenticate(bearer)` → `{ workspaceId, tokenId }` or `null`, and the Users / Groups
    operations called by `routes/scim.ts`.

## The token

- `frs_` + base64url(32 random bytes), returned once, stored as `sha256` (unique). 256 bits of entropy
  make a slow KDF pointless and keep the lookup one indexed equality. Tokens minted before the
  FundRoom rename start `shs_` (`LEGACY_SCIM_TOKEN_PREFIX`) and are accepted permanently
  (`SCIM_TOKEN_RE` takes both); `.gitleaks.toml` rule `fundroom-scim-token` matches either.
- At most **2 live tokens** per workspace, so a rotation can overlap.
- `last_used_at`, revocation, a display prefix; per-token rate limit **1200 requests a minute, counted
  per process** (`SCIM_RATE_LIMIT_PER_MINUTE`; `429` SCIM error with `Retry-After`) — N app processes
  admit up to N × 1200; request bodies capped at 1 MiB. An unknown or revoked token is
  a 401 SCIM error. `SCIM_ENABLED=false` makes everything under `/scim/v2` 404.

## Semantics

- **Create** = `MembershipService.provisionStaff({ source: "scim" })`: find or create the global user by
  email (a new user gets a verified email identity; an existing one is never modified), adopt an
  existing staff membership, or create one. `409 uniqueness` when the person is an external member
  here, or another SCIM user already maps that membership; `400 invalidValue` when `userName`/work email
  is outside the verified domains.
- **`active: false`** → `suspend` (sessions for the workspace revoked, `membership.suspended`);
  **`active: true`** → `unsuspend`; **`DELETE`** → membership `revoke` (reason `scim_deprovisioned`) and
  `scim_user.deleted_at`. Suspended users are still returned.
- **Roles.** A SCIM-managed non-owner's role is the highest mapped role among its groups by precedence
  `admin > legal > finance > editor > viewer`, else the default (the SSO connection's JIT role, or
  `viewer` without a connection). Recomputed on group-membership changes and mapping changes. Mapping
  is an owner action in FundRoom (`scim.group_role_mapped`), never something the IdP can set.
- **Protocol:** hand-rolled rather than a library, because the grammar Entra and Okta send is tiny and
  every write runs inside `withTenant()` with membership and audit semantics no library knows. Filters
  `eq` on `userName`, `externalId`, `emails[type eq "work"].value`, `emails.value` (users) and
  `displayName`, `externalId` (groups), joined by `and`; anything else `400 invalidFilter`. PATCH
  accepts both Entra dialects (capitalised ops, string booleans, path-less dotted keys) and Okta's; all
  operations of one request are one transaction. Responses are `application/scim+json`; errors follow
  RFC 7644 §3.12.
- **Lock order**: the `scim.workspace:<workspace>` advisory lock → `scim_user` / `scim_group` rows →
  memberships in erasure's order (every staff owner row `FOR NO KEY UPDATE`, then the remaining target
  memberships, by id; `lockForRecompute`) → workspace row (via `lockAuditChain`) → audit → outbox. Every
  write path takes all its row locks before its first audit row.
- **Erasure tombstones** the member's `scim_user` (`deleted_at`, `active: false`): later SCIM writes
  to it are 404. A later IdP `POST` for the same person creates a new SCIM user and re-provisions
  them — the workspace (the controller) decides; stop assigning the person in the IdP.
- **A membership revoked outside SCIM** reads `active: false`; the IdP's next `active: true` (PATCH/PUT)
  or a `POST` for the same `userName`/`externalId` re-provisions through `provisionStaff` and relinks
  that SCIM user (the IdP is the source of truth for SCIM-managed staff).
- **Create is three steps** (check under the lock → `provisionStaff`, which runs its own transactions →
  write under the lock). When the last step refuses (a racing create won), a membership the second
  step created is revoked again (`scim_rollback`); an adopted one — including an invitation the
  second step activated — is left as it is.
- **Erasure** (`prelockErasureSubject` locks the member's `scim_user` rows first): `user_name` →
  `erased-<id>@invalid`; email, display, given and family names and `externalId` → null; plus the
  tombstone above.

## Known limitations

- **Crash window in create / re-provision.** `provisionStaff` commits its own transactions before the
  SCIM write transaction runs. If the process dies between the two (or the compensating revoke itself
  fails — it is only logged, `scim.compensate_failed`), the workspace keeps a live staff membership
  with no SCIM user. There is no sweep: the IdP's retry of the same POST adopts and links it; otherwise
  an admin revokes it on the People page.
- **An activated invitation can stay without a SCIM user** when a racing create for another person
  wins step 3: the invitation had been issued anyway, so it is not revoked.

## Not done here

- SCIM groups do **not** feed access groups (`core.group`) or data-room grants — roles only.
- A `userName` change does not repoint the membership to another global account.
- Bulk operations, sorting, ETags, `/Me`, password changes, enterprise-extension attributes.
- Entra-issued JWT or OAuth client-credentials authentication (bearer secret only).
