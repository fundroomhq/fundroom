# @fundroom/sso

Staff single sign-on: a workspace's one OIDC or SAML connection, its DNS-verified
email domains, the SP-initiated login flow with its canonical-host handoff, identity linking and JIT
provisioning, and the enforcement flag. The HTTP surface lives in `apps/server`
(`routes/sso.ts` for the admin API, `routes/sso-flow.ts` for sign-in and the IdP-facing routes); the
admin guide is [`docs/sso/README.md`](../../docs/sso/README.md), the runbook
[`docs/runbooks/sso.md`](../../docs/runbooks/sso.md). SCIM is [`@fundroom/scim`](../scim/README.md).

It is a kernel package (manifest `sso`, `required`; `sso.read` owner + admin, `sso.manage` **owner
only**, because whoever configures the IdP can make it vouch for any staff email, the owner's included)
and not a module because enforcement is read on
every staff request through the tenant resolver, and the login flows run before module enablement is
known: anything read during tenant resolution cannot be a module.

## The decision everything else follows from: the IdP is tenant-controlled

A workspace owner chooses the IdP, so whatever it asserts — any email, `email_verified: true`, any
`amr` — is only as trustworthy as that admin. Three rules contain it:

- **Sessions are bound to the workspace — and to the connection's version.** A session opened through
  SSO carries `{ workspaceId, connectionId, connectionVersion }` and is ignored (not revoked) unless the
  resolved workspace is that one *and* its mirror (`core.workspace.sso_connection_id` /
  `sso_connection_version`, set only while the connection is enabled) names the same connection and
  version. A login the IdP should not have been able to produce still opens only the workspace that
  configured it, and a disable or a security-relevant save ends every bound session on the next request.
- **A bound session cannot touch the global account** (`403 sso_session_restricted`): factors, password,
  recovery codes, other sessions and devices, locale; `/me` lists only the bound workspace. Step-up with
  factors already enrolled is allowed, on a budget of its own per workspace
  (`totp:user:<id>:sso:<workspace>`; the per-IP bucket counts failures only), and password
  re-verification is refused. Enforced in `@fundroom/identity`
  (`assertMayChangeAccount`) and route guards in `apps/server`.
- **Emails are trusted by domain proof, never by `email_verified`.** Linking to an existing account by
  email, and JIT, need the email's domain to be a *verified* `sso_domain` of this workspace (DNS TXT,
  exclusive install-wide once verified); the only other link is an email that already holds a
  non-revoked membership here, which the workspace itself granted.
- **IdP claims never write global user fields.** Email and name on `core.user` are left alone; the
  account may belong to other workspaces.

## Public surface

- `SSO_KEY_PURPOSE` (`"sso-credentials"`), `SsoProtocol` (`"oidc" | "saml"`), `StaffJitRole`
  (`"editor" | "viewer" | "finance" | "legal"` — never owner or admin).
- `SsoConnectionView`, `SsoSpInfo` (the four IdP-facing URLs), `SaveSsoConnectionInput`
  (OIDC issuer/client/secret, or SAML metadata XML *or* entity ID + SSO URL + PEM certificates),
  `SsoDomainView`.
- `createSsoService(deps)` → `SsoService`:
  - `getConnection`, `saveConnection` (live-verifies discovery or metadata *outside* any transaction;
    see [Saves](#saves)), `setState` (`enabled`, `enforce: "off" | "staff"`; flipping `enabled` bumps
    `version`), `deleteConnection`, `protocolsOffered`, `spInfo(connectionId)`;
  - `listDomains`, `addDomain`, `verifyDomain` (TXT `_fundroom-sso.<domain>` =
    `fundroom-sso=<token>` through `DnsResolverPort`; the pre-rename `_seedhost-sso` name and
    `seedhost-sso=` prefix, exported as `LEGACY_SSO_TXT_LABEL` / `LEGACY_SSO_TXT_PREFIX`, are
    accepted permanently, each label in its own lookup), `removeDomain`;
  - `verifiedDomains(tx, workspaceId)` and `defaultStaffRole(tx, workspaceId)` for SCIM — these run on
    the **caller's** transaction (a second pool connection inside a transaction can deadlock the pool);
  - the login-flow entry points used only by `routes/sso-flow.ts` (`publicInfo`, `discover`, `begin`,
    `oidcCallback`, `samlAcs`, `spMetadata`, `finish`), and the linking and JIT decision at finish.
- `SSO_FLOW_ERROR_CODES` — what `/login?sso_error=` and `/admin/sso?sso_test=` can carry: `expired`,
  `binding_mismatch`, `invalid_response`, `idp_error`, `unknown_user`, `not_provisioned`, `suspended`,
  `staff_only`, `disabled`, `rate_limited`, `forbidden` (a tester who lost `sso.manage` mid-test),
  `reauth_required` (a re-authentication whose IdP time is missing or over 5 minutes old),
  `reauth_mismatch` (a re-authentication by a different user).
- `SsoError` (code, status, details), adopted by the server's error mapping.
- `@fundroom/sso/testing` — a self-signed certificate helper and a SAML test IdP for integration tests.

## Saves

- A save that changes **which IdP is trusted** — protocol, OIDC issuer, SAML IdP entity ID — creates a
  **new connection id**: the old row is soft-deleted, its bound sessions revoked, the mirror cleared, and
  the new row starts `enabled = false`, `enforce = off`. Identities are keyed
  `<connectionId>|<subject>`, so a new IdP's subjects can never match an old IdP's.
- An in-place save that is **security-relevant** — client secret or client ID, SAML certificates, MFA
  mapping, JIT — bumps `version`, so bound sessions stop matching the mirror at once.
- A **cosmetic** save (name, IdP sign-on URL) keeps `version` and every session.
- Every write sets the workspace mirror in the same transaction, right before the audit, then
  `resolver.invalidate()`. The post-commit session revoke (reasons `sso_connection_disabled`,
  `sso_connection_changed`, `sso_connection_replaced`, `sso_connection_deleted`) is cleanup only: retried
  once, logged on failure (`sso.session_revoke_failed`), never surfaced — the mirror already shut the
  sessions out.
- SAML updates by fields that omit `certificates` keep the saved ones, as long as the entity ID is
  unchanged.

## The flow

1. **Begin** (workspace origin): a challenge row with the connection, `returnTo`, PKCE/nonce (OIDC) or
   the AuthnRequest id (SAML), and the origin the user **began on** (host, `BASE_URL` port, base path,
   `/w/<slug>`), captured server-side from the resolved request and checked against the workspace's own
   origins — never taken from client input. Bound to the browser by the `sso_req` cookie on that host.
   RelayState and `state` are opaque random handles, never URLs.
2. **Callback / ACS** (canonical host, ops tree, before the session and CSRF chain): all cryptographic
   checks first; only then, in one host transaction, the begin challenge is consumed, the SAML assertion
   id recorded and a single-use `sso_handoff` challenge written (2-minute TTL, the begin challenge's
   binding hash, the connection `version` verified against). Garbage cannot cancel someone's login, and
   parallel posts yield one handoff. Then a **303** to the began-on origin's `/api/v1/auth/sso/finish?h=…`.
3. **Finish** (that origin): binding cookie checked, handoff consumed, *then* identity resolution, JIT
   and the session. No user or membership row is written before the binding check. The link transaction
   locks the connection (`FOR SHARE`: same id, enabled, same `version`) and then the membership (a live
   staff seat); if either changed, the just-minted session is revoked (`sso_error=disabled` /
   `not_provisioned`). `last_login_at` is written in its own short transaction afterwards.
4. **Session time.** The session's `authTime` is `min(now, IdP time)` (OIDC `auth_time`, SAML
   `AuthnInstant`); with no IdP time it is minted stale (older than the step-up window), so fresh-gated
   routes ask for a step-up.
5. **Re-authentication** (`begin {reauth: true}` from a bound session, offered by the SPA for freshness
   only, never for the MFA-level step-up): OIDC `prompt=login` + `max_age=0`, SAML `ForceAuthn`. The IdP
   time must be within 5 minutes (else `reauth_required`) and the resolved user must be the session's
   (else `reauth_mismatch`, current session untouched); success mints a fresh bound session replacing the
   old one. Entra OIDC needs the `auth_time` optional claim for this to ever succeed.
6. **Test** logins stop before step 3's writes: the tester's `sso.manage` is re-checked under the
   connection lock (`sso_test=forbidden` if lost), `last_tested_at`/`last_error` are recorded, and no
   identity, membership or session is written.

The 303 is also what makes SAML's cross-site POST work with `SameSite=Lax` cookies.

## Security properties

- **OIDC** on `openid-client` v6: discovery through the SSRF-guarded `ssoOutbound` client (https, no
  redirects, 5 s, 1 MiB; private hosts only via `SSO_ALLOW_PRIVATE_HOSTS`), cached per
  `(connectionId, version)`; PKCE S256, `state`, `nonce`; a redirect URI per connection (mix-up
  defence); issuer must equal the configured one exactly, so Entra's `common` / `organizations`
  templates never pass. MFA level from `oidcAuthLevel` (trust flag, `acr` in the configured values,
  `amr`).
- **SAML** on `@node-saml/node-saml` 5.1.0, pinned, with pnpm overrides flooring `xml-crypto` and
  `@xmldom/xmldom` above their 2025–2026 advisories. `wantAssertionsSigned: true`,
  `wantAuthnResponseSigned: false`, no IdP-initiated login. After node-saml accepts, our own checks on
  the **signed assertion only** (`getAssertionXml()`), closing the gaps 5.1.0 leaves:
  - signed `SubjectConfirmationData/@InResponseTo` equals the request id sealed in the begin challenge,
    which is found by the hash of RelayState and consumed atomically;
  - `SubjectConfirmationData/@Recipient` equals our ACS URL;
  - assertion `Issuer` equals the connection's IdP entity ID; audience equals our per-connection SP
    entity ID;
  - 180 s clock skew;
  - the email comes from an emailAddress-format (or email-shaped) NameID, else the `email`, `mail`,
    `…/claims/emailaddress` or `urn:oid:0.9.2342.19200300.100.1.3` attribute;
  - assertion id inserted into `core.sso_assertion_replay (connection_id, assertion_id)`, refused on
    conflict.
  MFA level 2 only with the trust flag or an `AuthnContextClassRef` in the configured values.
- **IdP metadata** is parsed by our own code on `@xmldom/xmldom` + `xpath`: one `EntityDescriptor`, the
  HTTP-Redirect SSO URL (https), every signing certificate (validated with `node:crypto`
  `X509Certificate`). Several certificates may be stored, for rollover.
- **Identities** are `oidc` / `saml` rows keyed `${connectionId}|${subject}` (OIDC `sub`, SAML NameID),
  never a global `iss|sub`.
- **Secrets** (the OIDC client secret) are sealed under `sso-credentials` and never leave the service;
  the view exposes `hasSecret` and certificate fingerprints, expiry and subject only.
- **Enforcement** is mirrored to `core.workspace.sso_enforced` in the same transaction as the
  connection change, so middleware reads it off the resolved workspace. It can be turned on only with an
  enabled connection that has logged someone in or passed a test (`last_login_at`, or `last_tested_at`
  with no `last_error`); disabling or deleting forces it off. Owners at authentication level 2 are
  always admitted (break-glass). API keys are not affected by enforcement.
- **Linking** never uses `email_verified`; verified domains match exactly (no subdomain inheritance), and
  Google's `hd` is not checked — the domain proof replaces it. A first SSO link to an existing account
  sends no notice mail (identity has no fitting notice yet).
- **Lock order**: the `sso.connection:<workspace>` advisory lock → the connection row (`FOR UPDATE` in
  writers, `FOR SHARE` in finish) → the membership → the workspace
  row (only via `lockAuditChain` or the `core.workspace` update right before the audit) → audit →
  outbox.
- **Erasure** deletes a member's `oidc`/`saml` identities whose identifier starts with one of this
  workspace's connection ids.

## Not done here

- Encrypted SAML assertions, SAML single logout, signed AuthnRequests.
- IdP-initiated SAML (refused by design; point the IdP tile at the workspace login page).
- A SAML metadata URL that is re-fetched automatically (admins paste the XML).
- Bumping node-saml to 5.2.x when it ships (the post-checks above stay as defence in depth).
- SSO sessions that span workspaces.
- A notice mail when SSO first links to an existing account.
