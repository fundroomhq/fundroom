# Runbook: staff SSO and SCIM

When a workspace connects its identity provider — Microsoft Entra ID, Okta, Google Workspace or any
SAML 2.0 or OpenID Connect IdP — its staff sign in through that IdP, and the IdP can provision and
deprovision them over SCIM. This runbook is for workspace admins and for whoever operates the install:
rotating the IdP's signing certificate or the OIDC client secret, a company locked out by enforced SSO,
sign-ins that fail, configurations that will not save, clock skew, a leaked SCIM token, and reading what
happened from the audit log. How the feature works and how to set up each IdP is in the
[SSO guide](../sso/README.md) and the [SCIM guide](../sso/scim.md).

Reference material: `packages/sso` (the
connection, the domains and the login flow), `packages/scim` (the SCIM service),
`apps/server/src/routes/sso-flow.ts` (sign-in and the IdP-facing routes), `apps/server/src/routes/sso.ts`
(the admin API) and `apps/server/src/routes/scim.ts` (`/scim/v2`).

## What has to be true first

- **You know who can act.** Owners and admins can see the connection, the domains and SCIM (**Settings →
  SSO**, `/admin/sso`; `sso.read`), but **only owners change them** (`sso.manage`), each change with a
  fresh step-up. An admin who needs something changed asks an owner.
  The operator sees the logs and the configuration, not the connection: `core.sso_connection`,
  `core.sso_domain`, `core.scim_token` and the `core.scim_*` tables are behind row-level security, and
  reading or changing them directly is a [break-glass](break-glass.md) session with a ticket. Only the
  last resort in [Locked out by enforced SSO](#locked-out-by-enforced-sso) needs one.
- **The operator offers the feature.** `SSO_PROTOCOLS` lists the protocols owners may use (default
  `oidc,saml`; `none` turns SSO off) and `SCIM_ENABLED` (default `true`) turns `/scim/v2` on. See
  [Keys this runbook refers to](#keys-this-runbook-refers-to).
- **The CLI and Postgres** as in [queue-backlog.md](queue-backlog.md): `docker compose run --rm app <command>`
  and `docker compose exec db psql -U seedhost -d seedhost`.

## The moving parts

| URL | Host | What it is |
|---|---|---|
| `{BASE_URL}/sso/oidc/{connectionId}/callback` | canonical | the OIDC redirect URI registered at the IdP |
| `{BASE_URL}/sso/saml/{connectionId}/acs` | canonical | the SAML Assertion Consumer Service (HTTP-POST) |
| `{BASE_URL}/sso/saml/{connectionId}/metadata` | canonical | the SAML SP entity ID *and* its metadata document (public; 404 once the connection is deleted) |
| `/api/v1/auth/sso/begin`, `/api/v1/auth/sso/finish` | workspace | where a sign-in starts and ends |
| `{BASE_URL}/scim/v2` | canonical | the SCIM base URL; the workspace comes from the token |

`BASE_URL` includes any base path. The IdP-facing URLs never use a custom domain, so adding, moving or
removing one needs no change at the IdP.

A sign-in goes: the workspace's login page → `begin` (sets the short-lived `sso_req` cookie in this
browser) → the IdP → back to the canonical host, where the response is verified → a **303** to the
workspace's `finish`, which checks the cookie, links or provisions the person and opens the session.
The handoff from the canonical host to `finish` is single-use, lives two minutes, and must land in the
browser that started the sign-in.

## Sign-in fails

A failed sign-in lands on the workspace's login page with `?sso_error=<code>`; a failed **Test sign-in**
lands on `/admin/sso?sso_test=<code>` and the connection's **last error** says the same.

| Code | Meaning | What to do |
|---|---|---|
| `expired` | the sign-in took too long, or the link was used twice | start again |
| `binding_mismatch` | the sign-in finished in a different browser (or with cookies blocked) from the one that started it | start and finish in the same browser; allow cookies for the workspace's site |
| `invalid_response` | the IdP's answer failed a check: signature, issuer, audience, recipient, request id, a replayed assertion, or timestamps | see below |
| `idp_error` | the IdP itself returned an error (the user cancelled, the user is not assigned to the app, a consent or policy refusal) | read the IdP's sign-in log for the user |
| `unknown_user` | nothing links this person to the workspace: no identity from this connection, no verified domain for their email, no membership with that email | verify the domain, or invite the person first ([linking rules](../sso/README.md#who-can-sign-in)) |
| `not_provisioned` | the email's domain is verified but the person has no membership and JIT is off | turn JIT on, invite them, or provision them over SCIM |
| `suspended` | their membership here is suspended (by an admin or by SCIM `active: false`) | reactivate at the IdP (SCIM) or in **People** |
| `staff_only` | they are an investor or other external member here; SSO is for staff | they use the investor sign-in |
| `disabled` | the connection is disabled, or was disabled or changed while this sign-in was under way | enable it (**Settings → SSO**), or just sign in again |
| `rate_limited` | too many sign-in attempts | wait a minute |
| `reauth_required` | **Sign in again with <IdP>** (step-up): the IdP reported no sign-in time, or one more than 5 minutes old — it did not make the person sign in afresh | Entra OIDC: add the `auth_time` optional claim ([setup](../sso/README.md#oidc)); check the server clock ([Clock skew](#clock-skew)); or step up with a passkey or authenticator code |
| `reauth_mismatch` | **Sign in again with <IdP>**: a different person signed in at the IdP than the one this session belongs to; the session was left as it was | sign in at the IdP as yourself (sign out of the IdP first if it remembered someone else) |
| `forbidden` | (test only) the person running **Test sign-in** was no longer an owner when it finished; nothing was recorded | an owner runs the test |

For `invalid_response`, in order of likelihood:

1. **The IdP's signing certificate changed** (SAML) and the new one is not on the connection — see
   [Rotating the IdP signing certificate](#rotating-the-idp-signing-certificate-saml).
2. **The IdP is configured with the wrong URLs**: the ACS / reply URL, the entity ID / audience URI or the
   OIDC redirect URI must be *exactly* the ones on **Settings → SSO** (canonical host, connection id,
   no trailing slash).
3. **The IdP entity ID or issuer on the connection does not match** what the IdP puts in the assertion
   (SAML `Issuer`) or the ID token (`iss`). Re-import the IdP's metadata, or re-save the issuer.
4. **Only the SAML response is signed, not the assertion.** FundRoom requires a signed assertion. In
   Google Workspace leave **Signed response** off; in Okta and Entra keep the default (assertion signed).
5. **The user started from the IdP's app tile** (IdP-initiated SAML). That is refused by design; point the
   tile at the workspace's login page ([generic SAML](../sso/README.md#generic-saml-20)).
6. **Clock skew** — see [Clock skew](#clock-skew).

## "Signed in with SSO" on account settings, or everyone was signed out

- **`403 sso_session_restricted`** (Settings → Security says the account cannot be managed from an SSO
  session): by design, an SSO session cannot read or change the account's password, factors, sessions,
  devices or language ([why](../sso/README.md#what-an-sso-session-cannot-do)). Sign out and sign in with
  an email code or a passkey to manage the account.
- **Every SSO user was signed out at once**: an owner disabled the connection, pointed it at a different
  IdP, or saved a security-relevant change (client secret or ID, certificates, MFA settings, JIT). The
  audit log shows the `sso.connection_saved` or `sso.state_changed` row. People sign in again.

## A configuration will not save

**Save** checks the configuration live before storing it, and answers `400 sso_invalid_config` with a
`reason`:

| Reason | Meaning | Fix |
|---|---|---|
| `discovery_failed` | the OIDC discovery document (`<issuer>/.well-known/openid-configuration`) could not be fetched or read | see below |
| `issuer_mismatch` | the discovery document names a different issuer from the one typed | type exactly the issuer the document names — Okta's org server (`https://<org>.okta.com`) and its custom servers (`…/oauth2/default`) are different issuers; Entra's `common` and `organizations` endpoints are never accepted: use `https://login.microsoftonline.com/<tenant id>/v2.0` |
| `invalid_metadata` | the pasted SAML metadata is not one IdP `EntityDescriptor` with an HTTP-Redirect SSO URL and a signing certificate | export the IdP metadata again (the *IdP's*, not the SP's) |
| `invalid_certificate` | a certificate is not a valid PEM X.509 certificate, or its key is too weak | paste the certificate as downloaded (Base64 / PEM) |
| `secret_required` | a client secret is needed: on the first save, when switching protocol, and when the issuer changes | paste the secret again |
| `protocol_unavailable` | the operator does not offer this protocol (`SSO_PROTOCOLS`) | ask the operator |

`discovery_failed` from the operator's side. The SSO client is its own guarded HTTP client: https only,
**no redirects**, a 5-second timeout and 1 MiB per answer, and it refuses private addresses except hosts
listed in `SSO_ALLOW_PRIVATE_HOSTS`. So:

- an issuer that redirects (`http://` → `https://`, a missing or extra trailing slash, a vanity domain) fails
  — use the final URL;
- a self-hosted IdP on a private network (Keycloak on `10.x`) fails unless its host is listed in
  `SSO_ALLOW_PRIVATE_HOSTS`;
- the app container must be able to reach the IdP: check from inside it, for example
  `docker compose exec app wget -qO- https://login.microsoftonline.com/<tenant id>/v2.0/.well-known/openid-configuration`
  (if the image has no shell tools, check from the host on the same network).

Saving a connection is limited to 10 saves an hour per workspace (`429`). Each save bumps the connection's
version, which also drops its cached discovery document.

## Rotating the IdP signing certificate (SAML)

A SAML connection can hold **several** IdP signing certificates and accepts an assertion signed by any of
them. Rotate without an outage by adding the new certificate *before* the IdP starts using it:

1. At the IdP, create the new certificate without activating it:
   - **Entra ID:** the enterprise app → **Single sign-on** → **SAML Certificates** → **Edit** → **New
     Certificate** → save; download it as **Certificate (Base64)**. Do not **Make certificate active** yet.
   - **Okta:** the app → **Sign On** → **SAML Signing Certificates** → **Generate new certificate**;
     download it. Do not **Activate** it yet.
   - **Google Workspace:** Admin console → **Security → Authentication → SSO with SAML applications**
     → add a certificate; download it. The app keeps using the old one until you switch it in step 3.
2. In FundRoom, **Settings → SSO** → edit the connection, add the new certificate next to the current one
   (paste both PEM blocks) and save. The screen lists each certificate's SHA-256 fingerprint and expiry.
3. At the IdP, make the new certificate active.
4. **Test sign-in** on **Settings → SSO**.
5. Once it passes, remove the old certificate from the connection and save again.

A change to the certificates is security-relevant: each save in steps 2 and 5 **signs out everyone who
signed in through SSO** (on their next request), and they sign in again. Do it at a quiet time, or
remove the old certificate later with another change you have to make anyway.

If the IdP switched first, every sign-in fails with `invalid_response` until step 2 is done; an owner can
still get in with the [break-glass](#locked-out-by-enforced-sso) if enforcement is on. Keep an eye on the
expiry dates shown on the connection and put the next rotation in the calendar.

## Rotating the OIDC client secret

Entra ID client secrets expire (at most 24 months); Okta and Google keep them until you delete them. When
one expires, sign-ins fail at the token exchange (`invalid_response` or `idp_error`).

1. At the IdP, add a second secret (Entra: **Certificates & secrets → New client secret**; Okta: the
   app's **Client Credentials → Generate new secret**; Google: the OAuth client → **Add secret**). All three
   keep the old one valid meanwhile.
2. In FundRoom, **Settings → SSO** → edit the connection, paste the new secret, save.
3. **Test sign-in.**
4. Delete the old secret at the IdP.

Saving a new secret signs out everyone who signed in through SSO (on their next request); they sign in
again with the new one.

The secret is sealed with the install's key ring and never shown again. Rotating the key ring
([rotate-keys.md](rotate-keys.md)) re-wraps it and needs nothing from the workspace.

## Locked out by enforced SSO

With **Require SSO for staff** on, a staff member without an SSO session for this workspace gets
`403 sso_required`. If the IdP is down, misconfigured or its certificate expired, nobody can sign in
through it.

**1. An owner turns enforcement off (the break-glass).** An **owner** whose session is at authentication
level 2 is always admitted, SSO or not. The owner signs in on the workspace's login page with a
non-SSO method — a passkey, or an email code followed by the passkey or authenticator-app step — and then
**Settings → SSO → Require SSO for staff → off** (step-up). Admins are not covered by the break-glass:
only owners. This is why every owner should enrol a passkey or an authenticator app *before* turning
enforcement on, and should not depend on a mailbox hosted by the same IdP to receive an email code.

**2. Last resort: the operator disables the connection.** When no owner can reach level 2 (no passkey,
no authenticator app, or no owner at all), the operator disables SSO in the database. This is a
[break-glass](break-glass.md) session with a ticket naming the workspace; the owners are emailed and it
is on their audit log.

The workspace row mirrors the connection: `sso_enforced` (enforcement on), and `sso_connection_id` +
`sso_connection_version`, which are set **only while the connection is enabled** and are what an SSO
session is checked against on every request. Turning enforcement off by hand therefore means disabling
the connection and clearing all three mirror columns, so that the two rows agree the way the product
leaves them after **Disable**:

```
fundroom break-glass open --workspace acme --ticket SUP-1432 \
  --reason "Owners locked out by enforced SSO (IdP outage, no owner passkey); disabling SSO" \
  --minutes 15 --operator "Nora Jensen"

fundroom break-glass sql --session <id> --query "SELECT w.id, w.sso_enforced, w.sso_connection_id,
  w.sso_connection_version, c.id AS connection_id, c.enabled, c.enforce, c.version, c.last_error
  FROM core.workspace w LEFT JOIN core.sso_connection c
    ON c.workspace_id = w.id AND c.deleted_at IS NULL
  WHERE w.slug = 'acme'"

fundroom break-glass sql --session <id> --write --query "UPDATE core.sso_connection
  SET enabled = false, enforce = 'off', version = version + 1, updated_at = now()
  WHERE workspace_id = '<workspace uuid>' AND deleted_at IS NULL"

fundroom break-glass sql --session <id> --write --query "UPDATE core.workspace
  SET sso_enforced = false, sso_connection_id = NULL, sso_connection_version = NULL
  WHERE id = '<workspace uuid>'"

fundroom break-glass close --session <id>
```

- Use the workspace **uuid** from the first query: `--workspace` takes the slug, the SQL does not. Each
  statement must filter by workspace: the break-glass role bypasses row-level security.
- Run **both** updates. Requests read the workspace row; the admin screen, saves and sign-ins read the
  connection. `sso_connection_id` and `sso_connection_version` must be both set or both `NULL` (a
  CHECK refuses anything else).
- Why disable rather than only turn enforcement off: the mirror columns may only name an *enabled*
  connection, and the IdP is broken anyway. The version bump makes sure no session opened before the
  lock-out is ever admitted again.
- Every SSO session of the workspace stops working at once (it no longer matches the mirror). Staff sign
  in another way until the owners re-enable SSO.
- **When it takes effect.** On a multi-tenant install the workspace is read on every request, so at once.
  On a single-tenant install (`TENANCY_MODE=single`) each app process caches the workspace for up to
  30 seconds: wait that long, or restart the app (`docker compose restart app`).
- This writes no `sso.state_changed` audit row; the break-glass rows are the record. Once the IdP works
  again, an owner signs in another way, runs **Test sign-in**, enables the connection and turns
  enforcement back on from **Settings → SSO**.

**Dropping a protocol from `SSO_PROTOCOLS` does not turn enforcement off.** A workspace whose connection
uses a protocol the operator no longer offers cannot start an SSO login, but its `sso_enforced` stays
on, so its staff are locked out exactly as above and only an owner's break-glass gets in. Before
removing `oidc` or `saml` from `SSO_PROTOCOLS`, ask the owners of the workspaces that use it to switch
protocol or turn enforcement off first; for a workspace whose owners cannot, disable its connection
with the two updates above.

## Clock skew

SAML assertions are accepted within **180 seconds** of the server's clock; OIDC ID tokens are checked
against it too. A server clock that drifts shows up as every SSO sign-in failing with `invalid_response`
right after the IdP, while email codes and passkeys still work. Check the host:

```
date -u; docker compose exec app date -u   # compare with a reference, e.g. https://time.is/UTC
timedatectl status                          # "System clock synchronized: yes"
```

Containers use the host's clock: fix NTP on the host (`timedatectl set-ntp true`, chrony or
systemd-timesyncd). The IdP's clock is its own problem; the big ones are right.

## A SCIM token leaked

A SCIM token (`frs_…`) lets whoever holds it create, update, suspend and remove **staff memberships** of
this one workspace, within its verified domains, and add people to SCIM groups (which carry whatever role
an owner mapped to the group, `admin` included). It cannot touch owners, investors, global accounts or
any workspace data.

1. **Revoke it now:** an owner, **Settings → SSO → SCIM → Revoke** (`DELETE /api/v1/sso/scim/tokens/{id}`,
   step-up). It answers 401 from the next request. Tokens do not die with the person who created them —
   provisioning has to outlive the admin who set it up — so this page is the only place to end one.
2. **Create a new one** and paste it into the IdP's provisioning settings (Entra: **Provisioning → Admin
   credentials → Secret Token → Test Connection**; Okta: **Provisioning → Integration → API token → Test
   API Credentials**). It is shown once. A workspace can hold two live tokens, so this also works as a
   planned rotation: create, switch the IdP, revoke the old.
3. **See what it did.** Filter the audit log by `scim.` since the leak and look for actors
   `scim:<tokenId>` of the leaked token ([Reading the audit log](#reading-the-audit-log)). Watch for
   `scim.user_created` you do not recognise, `scim.group_updated` adding members to a group mapped to a
   privileged role, and `scim.user_suspended` / `scim.user_deleted` you did not expect.
4. **Repair.** Revoke unknown memberships in **People** (people the IdP does not assign stay revoked).
   Let the IdP put the rest back: Entra **Restart provisioning** (or **Provision on demand** for one user),
   Okta **Push Groups** / re-save the assignments. The IdP is the source of truth for SCIM-managed staff:
   a membership the attacker suspended or deleted comes back when the IdP sends the person as active
   again.

## Reading the audit log

Everything is on the workspace's audit log (**Audit log** in the admin, or `GET /api/v1/audit/events`,
`audit.read`). Filter by action — an exact action, or a prefix ending in `.`:

```
curl -sS "https://<workspace host>/api/v1/audit/events?action=sso.&limit=50" \
  -H "Authorization: Bearer $FUNDROOM_API_KEY"
curl -sS "https://<workspace host>/api/v1/audit/events?action=scim.&from=2026-09-01T00:00:00Z" \
  -H "Authorization: Bearer $FUNDROOM_API_KEY"
curl -sS "https://<workspace host>/api/v1/audit/events?action=auth.login&limit=50" \
  -H "Authorization: Bearer $FUNDROOM_API_KEY"
```

| Action | Actor | Meaning |
|---|---|---|
| `sso.connection_saved` | staff | the connection was created or changed (never the secret) |
| `sso.connection_deleted` | staff | the connection was deleted; its bound sessions were revoked |
| `sso.state_changed` | staff | enabled / disabled, or enforcement turned on or off |
| `sso.test_completed` | staff | a **Test sign-in** finished (meta: the outcome) |
| `sso.domain_added`, `sso.domain_verified`, `sso.domain_removed` | staff | a domain was claimed, proved by its DNS TXT record, or removed |
| `sso.jit_provisioned` | the sign-in | a first SSO sign-in created a staff membership (JIT) at the connection's JIT role |
| `auth.login` | the member | a sign-in; SSO ones have meta `method: "sso"` and `connectionId` |
| `scim.token_created`, `scim.token_revoked` | staff | a SCIM token was created or revoked |
| `scim.user_created`, `scim.user_updated` | `scim:<tokenId>` | the IdP provisioned or updated a user |
| `scim.user_suspended`, `scim.user_reactivated` | `scim:<tokenId>` | `active: false` / `true` from the IdP |
| `scim.user_deleted` | `scim:<tokenId>` | the IdP deleted the user; the membership was revoked (`scim_deprovisioned`) |
| `scim.group_created`, `scim.group_updated`, `scim.group_deleted` | `scim:<tokenId>` | the IdP pushed a group, renamed it or changed its members, or deleted it |
| `scim.group_role_mapped` | staff | an owner mapped a SCIM group to a role, or cleared it |
| `membership.suspended`, `membership.reactivated` | staff or `scim:<tokenId>` | the membership behind a suspend or reactivate |
| `membership.revoked` (reason `scim_deprovisioned` or `scim_rollback`) | `scim:<tokenId>` | the IdP deleted the user, or a SCIM create lost a race after creating the membership, which was revoked again |

Sessions ended by an SSO change carry a revoke reason: `sso_connection_disabled`,
`sso_connection_changed` (a security-relevant save), `sso_connection_replaced` (pointed at a different
IdP) or `sso_connection_deleted`. They stop working on the next request even before that revoke runs.

## Keys this runbook refers to

| Key | Where | Default |
|---|---|---|
| `SSO_PROTOCOLS` | app | `oidc,saml`; `none` = SSO off |
| `SCIM_ENABLED` | app | `true`; `false` answers 404 under `/scim/v2` |
| `SSO_ALLOW_PRIVATE_HOSTS` | app | empty; hosts the SSO client may reach on a private address (test rigs, a private IdP) |
| `BASE_URL` | app | the IdP-facing URLs and the SCIM base URL are built from it, base path included |
| `TENANCY_MODE` | app | `single` caches the workspace (and its enforcement flag) for 30 s per process |
