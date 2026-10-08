# Staff single sign-on (SSO)

A company that runs its own identity provider — **Microsoft Entra ID**, **Okta**, **Google
Workspace**, or any **OpenID Connect** or **SAML 2.0** IdP — can connect it to its workspace, so
that its staff sign in with the company account instead of an email code. With it come:

- **verified domains** — proof, by a DNS record, that the company owns `acme.com`, which is what lets
  FundRoom link and create accounts from what the IdP says;
- **just-in-time (JIT) provisioning** — a colleague in a verified domain who signs in for the first
  time gets a staff membership at a role you choose (never owner or admin);
- **enforced SSO** — a switch that makes the IdP the only way staff get into the workspace, with a
  break-glass for owners;
- **SCIM 2.0 provisioning** — the IdP creates, updates, suspends and removes staff memberships and
  maps its groups to roles. SCIM has [its own guide](scim.md).

This guide is for the workspace owner who connects the IdP, the admins who look after it, and the
operator who runs the install. What to do when something goes wrong in production is in the
[SSO runbook](../runbooks/sso.md).

SSO is for **staff** (owners, admins, editors, viewers, finance, legal). Investors and other external
members keep their own sign-in and are never affected by anything on this page.

## How it works

```
staff member on the workspace's login page (its own address, custom domain or not)
        │  "Sign in with Acme SSO"            ── begin: sets a short-lived cookie in this browser
        ▼
the company's IdP (Entra ID, Okta, Google, …)
        │  the IdP sends the browser back to FundRoom's canonical host (BASE_URL)
        ▼
{BASE_URL}/sso/oidc/<id>/callback   or   {BASE_URL}/sso/saml/<id>/acs
        │  every signature, issuer, audience and timestamp is checked here
        ▼  303, within 2 minutes, to the address the sign-in began on
workspace's /api/v1/auth/sso/finish      ── same browser? (the cookie) → link or provision → session
```

- **One connection per workspace**, OpenID Connect (OIDC) *or* SAML 2.0; there is never a second live
  one. Pointing it at a different IdP replaces it
  ([Changing or removing the connection](#changing-or-removing-the-connection)).
- **The IdP only ever sees the install's canonical host** (`BASE_URL`), never the workspace's custom
  domain. You register the redirect / ACS URL once, and adding, moving or removing a custom domain
  never breaks it. The connection's id is part of every URL, so each workspace's registration is its
  own.
- **The session belongs to this workspace.** A session opened through a workspace's SSO is ignored
  everywhere else: in another workspace, on the install's own host. Someone who is staff in two
  workspaces signs in to each on its own terms. This is what makes it safe for a company's IdP to
  assert *any* email: whatever it says, the session only opens the workspace that configured it. For
  the same reason an SSO session cannot touch the person's FundRoom account
  ([below](#what-an-sso-session-cannot-do)).
- **Back where you started.** The sign-in ends on the address it began on — the custom domain, the
  workspace's subdomain or `/w/<slug>` path — because that is where the browser's sign-in cookie lives.
- **SP-initiated only.** Every sign-in starts on FundRoom. A SAML response nobody asked for — the
  IdP's app tile, IdP-initiated SSO — is refused. Point the tile at the workspace's login page
  instead ([Generic SAML 2.0](#generic-saml-20)).

## Before you start

- **Who.** Only **owners** change SSO under **Settings → SSO** (`/admin/sso`; `sso.manage`): the
  connection, domains, SCIM tokens and group mappings. Admins can see all of it (`sso.read`) but change
  nothing — whoever configures the IdP can make it vouch for any staff email, the owner's included.
  Every change is a step-up action.
- **Which protocol.** Both work with all three big IdPs. Prefer **OIDC** when you can: fewer moving
  parts, and nothing to rotate but a client secret. Use **SAML** when your IdP team standardises on it,
  or for an IdP with no OIDC.
- **The operator offers it.** If the protocol you want is not offered, the operator has limited
  `SSO_PROTOCOLS` ([Operator settings](#operator-settings)).
- **Owners have a second factor.** Before you turn on [enforcement](#enforcing-sso-for-staff), every
  owner should have a passkey or an authenticator app: that is the break-glass.

## Setting up, in order

1. **Create the connection** under **Settings → SSO**: pick the protocol, give it a name staff will
   recognise ("Acme SSO" — it is shown on the login button), and fill in what your IdP gives you
   ([per-IdP steps below](#microsoft-entra-id)). The screen shows the URLs to register at the IdP
   once the connection exists. Saving checks the configuration live (OIDC discovery, SAML metadata and
   certificates) before anything is stored; see the [runbook](../runbooks/sso.md#a-configuration-will-not-save)
   for what each refusal means. At most 10 saves an hour.
2. **Register FundRoom at the IdP** with those URLs and assign the people or groups who should have
   access.
3. **Add and verify your domains** ([below](#verified-domains)).
4. **Test sign-in** ([below](#test-sign-in)). It works while the connection is still disabled.
5. **Enable** the connection. The login page now offers SSO.
6. Optionally **turn on JIT**, **connect SCIM** ([scim.md](scim.md)) and **require SSO for staff**.
   Changing JIT or the MFA settings later signs out everyone who signed in through SSO
   ([Changing or removing the connection](#changing-or-removing-the-connection)), so settle them before
   you roll out.

## Verified domains

A domain is verified by publishing a DNS TXT record:

| Name | Value |
|---|---|
| `_fundroom-sso.<domain>` | `fundroom-sso=<token>` |

A record published before the rename (`_seedhost-sso.<domain>` = `seedhost-sso=<token>`) is still
accepted, and will stay accepted; any mix of the two names and the two value prefixes works as long as
the token is right. New records should use the names above.

**Settings → SSO → Domains → Add** shows the exact name and value for each domain. Publish it at your
DNS provider, then **Verify**. The check is made against public DNS resolvers; a record that has not
propagated yet leaves the domain `pending` with the reason in **last error** — try again later. A
verified domain can belong to **one workspace on the whole install**: if another workspace has already
verified it, yours is refused (`409 sso_domain_taken`). Pending claims do not block anyone.

Add every domain your staff's email addresses use (`acme.com`, `acme.co.uk`, …). Subdomains are
separate domains. Removing a domain stops it counting for linking, JIT and SCIM from then on; it does not
remove anyone.

## Who can sign in

When the IdP's answer has been verified, FundRoom decides who this is, in this order:

1. **Someone who signed in through this connection before** — the IdP's stable id for them (OIDC
   `sub`, SAML NameID) is remembered for this connection → that person.
2. **An email in one of the workspace's verified domains** → the FundRoom account with that email
   (it is linked to the IdP identity), or, if there is none and **JIT** is on, a new account.
3. **The email of someone who already has a membership here** (active, invited or suspended — anything
   but revoked) → that person, linked.
4. Otherwise the sign-in is refused (`unknown_user`).

Then the membership decides:

| Membership in this workspace | Result |
|---|---|
| staff, active | signed in |
| staff, invited | the invitation is accepted and they are signed in |
| staff, suspended | refused (`suspended`) |
| investor or other external | refused (`staff_only`) — SSO is for staff |
| none, the email's domain is verified and JIT is on | a staff membership is created at the JIT role (`sso.jit_provisioned`) |
| none, otherwise | refused (`not_provisioned`) |

Things worth knowing:

- **`email_verified` is not used.** Entra ID never sends it, and a company's IdP can send anything.
  Trust comes from the DNS proof of the domain, or from a membership the workspace already gave the
  person.
- **FundRoom never changes an account's email or name from the IdP.** The account may belong to
  other workspaces; what your IdP says is not the last word for them.
- **Someone outside your verified domains** (a contractor on `@gmail.com`) can still sign in with SSO,
  *if* you invite them first with the email the IdP will send (rule 3). Use the IdP's primary email.
- **The IdP must send an email** on the first sign-in, or rules 2 and 3 cannot match. Each IdP section
  below says how.

### Just-in-time provisioning

With **JIT** on, a first sign-in by someone in a verified domain with no membership creates a staff
membership at the connection's **JIT role**: `viewer` (the default), `editor`, `finance` or `legal`. JIT
can never make an owner or an admin; promote people in **People**, or map IdP groups to roles with
[SCIM](scim.md#groups-and-roles). JIT only applies to verified domains, never to rule 3.

## MFA

Owners and admins must meet the workspace's MFA policy. Whether an SSO sign-in counts as MFA is up to the
IdP's answer and your settings on the connection:

- **OIDC:** it counts when the ID token's `amr` shows a second factor (`mfa`, or two kinds of factor such
  as `pwd` + `otp`), or its `acr` is one of the values you list under **MFA values**.
- **SAML:** it counts when the assertion's `AuthnContextClassRef` is one of the values you list under
  **MFA values**.
- **Trust the IdP's MFA:** every sign-in through the connection counts. Turn it on only when the IdP
  itself requires MFA for everyone assigned to the app (a Conditional Access policy in Entra, an
  authentication policy in Okta, 2-Step Verification enforced in Google Workspace).

Otherwise the sign-in is single-factor, and owners and admins are asked for their passkey or
authenticator code on top. An SSO session cannot enrol one, so an owner or admin who works through SSO
needs either the IdP's MFA to count (above) or a passkey or authenticator app enrolled beforehand, signed
in another way.

## Test sign-in

**Settings → SSO → Test sign-in** runs a real sign-in against the IdP with every check, including the
[linking rules](#who-can-sign-in), but **changes nothing**: no account is linked, no membership created,
no session opened. It works while the connection is disabled, so you can finish the setup before anyone
sees the button. You come back to **Settings → SSO** with the outcome (`ok` or the same code a failed
sign-in shows; the [runbook](../runbooks/sso.md#sign-in-fails) explains each). It records **last
tested**, and **last error** on failure. Only an owner can run a test, and that is checked again when the
test finishes: if the tester stopped being an owner meanwhile, the outcome is `forbidden` and nothing is
recorded.

## What an SSO session cannot do

The person behind an SSO session has one FundRoom account, which may belong to other workspaces too,
and the IdP that vouched for them is the workspace's, not theirs. So a session opened through SSO can use
the workspace but **cannot read or change the account's security**: password, authenticator app,
passkeys, recovery codes, signing out everywhere, the list of their other sessions and devices, and the
language setting. Those answer `403 sso_session_restricted`, and **Settings → Security** says so. To
manage their account, people sign in another way (an email code or a passkey).

What still works from an SSO session:

- **Step-up**, which owners and admins meet before sensitive actions ([below](#step-up-on-an-sso-session)).
- **Signing out** of this session.
- `/me` lists **only this workspace**, not the person's other memberships.

### Step-up on an SSO session

Sensitive admin actions ask for a **recent** sign-in, and some for **MFA level**. For an SSO session:

- **When it counts as signed in.** The sign-in time is the one the IdP reports (OIDC `auth_time`, SAML
  `AuthnInstant`), not the moment FundRoom opened the session. An IdP that reports no time gives a
  session that is never recent, so every recent-sign-in action asks for a step-up.
- **Recent sign-in:** the person can use a passkey, authenticator code or recovery code they already
  have, or **Sign in again with <IdP>**. That sends them back to the IdP with a forced re-login (OIDC
  `prompt=login` and `max_age=0`, SAML `ForceAuthn`) and replaces the session with a fresh one. It fails
  with `reauth_required` if the IdP's sign-in time is more than 5 minutes old or missing, and with
  `reauth_mismatch` if a different person signs in at the IdP; the current session is left as it was.
- **MFA level:** only a passkey, authenticator code or recovery code the person already has; signing in
  again at the IdP is not offered for this. A **password** is never accepted from an SSO session.
- **An SSO session cannot enrol a factor** ([above](#what-an-sso-session-cannot-do)). Owners and admins
  who work through SSO should therefore either have the IdP's MFA count ([MFA](#mfa)) or enrol a passkey
  or authenticator app beforehand, signed in another way.
- **Limits.** Failed step-up attempts from an SSO session count against a limit of their own for this
  workspace, separate from the person's normal limits, so a hostile IdP cannot lock the person out
  elsewhere. A per-address limit counts failed attempts only.

## Enforcing SSO for staff

**Require SSO for staff** makes the IdP the only way in for staff:

- a staff member may use the workspace only with a session opened through **this workspace's**
  connection. Signed in any other way — an email code, a passkey, another workspace's SSO, the
  install-wide OIDC provider — they are told to use SSO (`403 sso_required`);
- **investors and other external members are never affected;**
- **owners keep a break-glass**: an owner whose session is at MFA level (a passkey, or an email code plus
  the passkey or authenticator step) is always let in, SSO or not. That is how an owner turns enforcement
  off when the IdP is down. Admins have no break-glass;
- **API keys keep working.** Keys are scoped machine credentials, minted by a member at MFA level
  (**Settings → API keys**); enforcement does not stop them. Revoke the ones you no longer want.
  A key still dies with its creator's membership (suspended or revoked).

You can turn it on only when the connection is **enabled** and has completed at least **one successful
SSO sign-in or a successful test** (`409 sso_enforce_precondition`, reason `not_enabled` or
`never_signed_in`). Disabling or deleting the connection turns enforcement off.

If every owner is locked out anyway, the operator can turn enforcement off; see the
[runbook](../runbooks/sso.md#locked-out-by-enforced-sso).

## Microsoft Entra ID

### OIDC

1. In the Entra admin center: **Identity → Applications → App registrations → New registration**.
   - **Supported account types:** *Accounts in this organizational directory only* (single tenant).
   - **Redirect URI:** platform **Web**, the **OIDC redirect URI** from **Settings → SSO**
     (`{BASE_URL}/sso/oidc/<connection id>/callback`).
2. **Certificates & secrets → New client secret.** Copy the **Value** (not the Secret ID). Note its
   expiry: Entra secrets expire, see the [runbook](../runbooks/sso.md#rotating-the-oidc-client-secret).
3. **Token configuration → Add optional claim → ID →** tick **`email`** and **`auth_time`**.
   - `email`: Entra does not put it in the ID token otherwise, and FundRoom needs it for the first
     sign-in. Each user needs the **Email** (`mail`) attribute set in Entra.
   - `auth_time`: without it Entra's sign-ins are never recent, and **Sign in again with Entra**
     ([step-up](#step-up-on-an-sso-session)) always fails with `reauth_required`.
4. **Overview:** copy the **Application (client) ID** and the **Directory (tenant) ID**.
5. In FundRoom: protocol **OIDC**,
   - **Issuer:** `https://login.microsoftonline.com/<tenant id>/v2.0` — with your tenant id. Never the
     `common` or `organizations` endpoints: their issuer is a template that belongs to every Entra
     tenant in the world, and FundRoom refuses them;
   - **Client ID** and **client secret** from steps 4 and 2.
6. To restrict who may sign in: **Enterprise applications →** the app **→ Properties → Assignment
   required: Yes**, then **Users and groups → Add**.
7. **MFA:** Entra's ID token carries `amr` (`mfa` after a second factor), so leave **Trust the IdP's MFA**
   off unless a Conditional Access policy requires MFA for the app and you prefer not to depend on `amr`.

### SAML

1. **Identity → Applications → Enterprise applications → New application → Create your own application**
   → *Integrate any other application you don't find in the gallery (Non-gallery)*.
2. **Single sign-on → SAML.** Under **Basic SAML Configuration** (or **Upload metadata file** with the
   SP metadata from **Settings → SSO**):
   - **Identifier (Entity ID):** the **SP entity ID** (`{BASE_URL}/sso/saml/<connection id>/metadata`);
   - **Reply URL (Assertion Consumer Service URL):** the **ACS URL**
     (`{BASE_URL}/sso/saml/<connection id>/acs`);
   - **Sign on URL:** the workspace's login page (`https://<workspace address>/login`).
3. **Attributes & Claims:** keep the `emailaddress` claim (`user.mail`). For **Unique User Identifier
   (Name ID)** prefer **Persistent** format with source `user.objectid`: the default, the UPN, changes
   when someone is renamed, and a changed NameID looks like a new person.
4. **SAML Certificates:** keep **Signing Option** at *Sign SAML assertion* (the default) and the
   algorithm at SHA-256. Download **Federation Metadata XML**.
5. In FundRoom: protocol **SAML**, paste the federation metadata XML. FundRoom reads the IdP entity ID,
   the sign-on URL and the signing certificate from it.
6. **Users and groups:** assign who may sign in.

## Okta

### OIDC

1. **Applications → Create App Integration → OIDC - OpenID Connect → Web Application.**
   - **Grant type:** Authorization Code.
   - **Sign-in redirect URIs:** the **OIDC redirect URI** from **Settings → SSO**.
   - **Sign-out redirect URIs:** none needed.
   - **Assignments:** the people or groups who may sign in.
2. Copy the **Client ID** and a **Client secret**.
3. **Issuer:** your Okta org URL, `https://<org>.okta.com` (the org authorization server), or a custom
   authorization server such as `https://<org>.okta.com/oauth2/default` if your Okta admins use one.
   They are different issuers: type exactly the one whose
   `/.well-known/openid-configuration` you mean.
4. In FundRoom: protocol **OIDC**, the issuer, client ID and secret.
5. **MFA:** Okta sends `amr`; an Okta authentication policy that requires MFA for the app makes it show.

### SAML

1. **Applications → Create App Integration → SAML 2.0.**
2. **Configure SAML:**
   - **Single sign-on URL:** the **ACS URL**; keep *Use this for Recipient URL and Destination URL*
     ticked;
   - **Audience URI (SP Entity ID):** the **SP entity ID**;
   - **Name ID format:** *Persistent* (or *EmailAddress*); **Application username:** *Email*;
   - **Attribute Statements:** `email` → `user.email`;
   - leave **Assertion Signature** at *Signed* and the algorithm at RSA-SHA256.
3. On the app's **Sign On** tab, open the **Metadata URL** and save the XML (or copy it).
4. In FundRoom: protocol **SAML**, paste the metadata XML.
5. **Assignments:** who may sign in. To hide the tile or point it at FundRoom's login page, see
   [Generic SAML 2.0](#generic-saml-20).

## Google Workspace

### OIDC

1. In the Google Cloud console, in a project owned by your Workspace organisation: **APIs & Services →
   OAuth consent screen**, user type **Internal**. *Internal* is what keeps accounts outside your
   Workspace organisation — consumer Gmail, other companies — from signing in to the app at all.
2. **Credentials → Create credentials → OAuth client ID → Web application.** **Authorized redirect
   URIs:** the **OIDC redirect URI** from **Settings → SSO**. Copy the client ID and secret.
3. In FundRoom: protocol **OIDC**, **Issuer** `https://accounts.google.com`, the client ID and secret.
4. **The `hd` claim.** Google's ID token carries `hd`, the Workspace domain of the account, and no `hd`
   for consumer accounts. FundRoom does not rely on it: the issuer is shared by every Google account, so
   what decides who gets in is the *Internal* consent screen above plus the [linking rules](#who-can-sign-in)
   — only emails in your verified domains, or people you already invited, get anywhere.
5. **MFA:** Google sends no `amr`. If 2-Step Verification is enforced for everyone in your organisation,
   turn on **Trust the IdP's MFA**; otherwise owners and admins are asked for their FundRoom passkey or
   authenticator code.

### SAML

1. Google Admin console: **Apps → Web and mobile apps → Add app → Add custom SAML app.**
2. **Google Identity Provider details:** download the **IdP metadata**.
3. **Service provider details:**
   - **ACS URL:** the **ACS URL**; **Entity ID:** the **SP entity ID**;
   - **Name ID format:** *PERSISTENT* or *EMAIL*; **Name ID:** *Basic Information → Primary email*;
   - leave **Signed response** *off*: Google then signs the assertion, which is what FundRoom requires.
     With it on, Google signs only the outer response and every sign-in fails `invalid_response`.
4. **Attribute mapping:** *Primary email* → `email`.
5. Turn the app **ON** for the organisational units or groups who may sign in.
6. In FundRoom: protocol **SAML**, paste the IdP metadata.

## Generic SAML 2.0

Any SAML 2.0 IdP that signs its assertions works. What FundRoom is, as a service provider:

| | |
|---|---|
| SP metadata | `{BASE_URL}/sso/saml/<connection id>/metadata` — most IdPs can import it |
| SP entity ID (audience) | the same URL |
| ACS URL | `{BASE_URL}/sso/saml/<connection id>/acs`, **HTTP-POST** binding |
| AuthnRequest | HTTP-Redirect binding, to the IdP's SSO URL |
| NameID | *persistent* preferred; *emailAddress* works. The NameID is how FundRoom recognises the person next time, so it must never change for them |
| Email | the person's email address, as an email-format NameID or an email attribute (the IdP sections above name the attribute) |
| Signing | **the assertion must be signed** (RSA-SHA256); a signed response around an unsigned assertion is refused. Encrypted assertions are not supported |
| IdP-initiated SSO | **not supported** |

**What you give FundRoom:** the IdP's metadata XML, or its entity ID, its SSO URL (HTTP-Redirect) and
its signing certificate(s) in PEM. Several certificates can be pasted, which is how you
[rotate one without an outage](../runbooks/sso.md#rotating-the-idp-signing-certificate-saml).

**The IdP's app tile.** A response the IdP sends on its own is refused: FundRoom accepts only the answer
to a request this browser started, which is what stops a stolen or misdirected assertion from being
replayed at FundRoom. Point the tile (Entra's *Sign on URL*, Okta's app embed link or a bookmark app,
Google's *Start URL*) at the workspace's login page, `https://<workspace address>/login`; from there it is
one click on the SSO button.

## Generic OIDC

Any OpenID Connect provider with discovery (Keycloak, Auth0, JumpCloud, Ping, …): register a web
application (authorization code flow, confidential client) with the **OIDC redirect URI**, then give
FundRoom the **issuer** exactly as its `/.well-known/openid-configuration` names it, the client ID and
the secret. The ID token must carry `email` (request scopes `openid email profile`), and the issuer must
answer over https without redirects. A provider on a private network needs the operator's
`SSO_ALLOW_PRIVATE_HOSTS`.

## Changing or removing the connection

- **Pointing it at a different IdP** — switching protocol, a new OIDC issuer, a new SAML IdP entity ID —
  **replaces the connection**: the old one is deleted (its sessions signed out, enforcement off) and a
  new one is created with a **new id**, so **new URLs to register at the IdP**, and it starts
  **disabled**. Test it and enable it again. People who signed in through the old IdP are linked again by
  the [rules above](#who-can-sign-in) on their next sign-in; the new IdP's ids never match the old ones.
  An OIDC issuer change or a protocol switch also needs the client secret (`sso_invalid_config`, reason
  `secret_required`).
- **A security-relevant change** — the client secret or client ID, the SAML certificates, the MFA
  settings, JIT — keeps the id and URLs, but **signs out everyone who signed in through SSO**, on their
  next request: their sessions were opened under the old settings. They simply sign in again.
- **Other changes** (the name, the IdP's sign-on URL) keep everyone signed in.
- **Disabling** hides the SSO button, refuses SSO sign-ins (`disabled`), turns enforcement off and
  signs out every SSO session at once. Enabling again does not bring those sessions back.
- **Deleting** does the same, and makes the connection's URLs answer 404. Remove FundRoom at the IdP
  too.

## What is stored

- **The connection**: protocol, name, issuer and client ID, or IdP entity ID, SSO URL and certificates;
  JIT and MFA settings; status, last error and when it was last verified, tested and used. The OIDC
  client secret is **sealed** (encrypted with a per-workspace key, purpose `sso-credentials`) and never
  shown again. SSO and SCIM configuration are not part of a workspace export.
- **Domains** with their verification token and status.
- **Linked identities**: for each person who signed in, the connection id and the IdP's id for them.
- **SAML assertion ids**, briefly, so an assertion cannot be used twice.
- **Sessions** opened through SSO carry the workspace and connection they belong to.

Erasing a member (a DSAR) deletes their SSO identities for this workspace's connection and scrubs their
SCIM record.

## The API

Admin routes under `/api/v1` (reading: owners and admins, `sso.read`; changing: owners only,
`sso.manage`, with step-up):
`GET|PUT|DELETE /sso/connection`, `PUT /sso/connection/state` (`{enabled, enforce: "off"|"staff"}`),
`GET|POST /sso/domains`, `POST /sso/domains/{id}/verify`, `DELETE /sso/domains/{id}`, and the SCIM ones
in [scim.md](scim.md#the-admin-api). Sign-in routes (public): `GET /auth/sso` (is SSO available here, and
enforced), `POST /auth/sso/discover` (`{email}` → does this email's domain use SSO here),
`POST /auth/sso/begin`, `GET /auth/sso/finish`.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `sso_invalid_config` | the configuration failed its live check; `reason` is `discovery_failed`, `issuer_mismatch`, `invalid_metadata`, `invalid_certificate`, `secret_required` or `protocol_unavailable` ([runbook](../runbooks/sso.md#a-configuration-will-not-save)) |
| 400 | `sso_domain_invalid` | not a domain name that can be verified |
| 403 | `sso_required` | enforced SSO: this staff session was not opened through the workspace's SSO (`reason: enforced`; `breakGlass: true` for an owner, who may step up) |
| 403 | `sso_session_restricted` | an SSO session tried to read or change the account's security ([above](#what-an-sso-session-cannot-do)) |
| 404 | `sso_not_configured` | the workspace has no connection |
| 409 | `sso_disabled` | the connection is disabled (sign-in; a test still works) |
| 409 | `sso_enforce_precondition` | enforcement needs an enabled connection that has signed someone in (`reason`: `not_enabled`, `never_signed_in`) |
| 409 | `sso_domain_taken` | another workspace has verified this domain |
| 409 | `sso_domain_unverified` | the DNS check failed (`reason`) |
| 429 | `rate_limited` | 10 connection saves an hour per workspace; sign-in attempts per address |

A failed sign-in never answers JSON: the browser lands on `/login?sso_error=<code>`
([codes](../runbooks/sso.md#sign-in-fails)).

## Operator settings

| Key | Default | Meaning |
|---|---|---|
| `SSO_PROTOCOLS` | `oidc,saml` | Comma list of protocols workspace owners may use. **`none` turns SSO off** everywhere. An empty value means the default. |
| `SCIM_ENABLED` | `true` | `false` answers 404 for everything under `/scim/v2` ([scim.md](scim.md)). |
| `SSO_ALLOW_PRIVATE_HOSTS` | empty | Hosts the SSO client may reach on a private address: a self-hosted IdP on the internal network, test rigs. |

The SSO client (OIDC discovery and keys, token exchange) is its own guarded HTTP client: https only
(except listed hosts), **no redirects**, a 5-second timeout and 1 MiB per answer. The IdP-facing routes
are served on `BASE_URL` (base path included), which must be reachable from your staff's browsers; the
IdP's servers never call FundRoom, except SCIM.

**The install-wide OIDC provider** (`OIDC_ISSUER_URL` and friends) is a different, older feature: one
operator-configured IdP for the whole install. It keeps working. Its sessions are not bound to a
workspace, so they never satisfy a workspace's **Require SSO for staff**.
