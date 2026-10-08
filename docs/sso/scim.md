# SCIM provisioning

With SCIM 2.0 (RFC 7643/7644) the company's identity provider keeps the workspace's **staff** in step
with its own directory: it creates a staff membership when someone is assigned to the app, updates
their name, **suspends** them when they are deactivated or unassigned, and maps IdP groups to staff
roles. It is set up under **Settings → SSO → SCIM** by an **owner** (admins can see it but not change
it), and tested against
**Microsoft Entra ID** and **Okta**.

SCIM is usually paired with [SSO](README.md) — SCIM decides who has a membership, SSO is how they sign
in — but it works without an SSO connection. Either way it needs at least one
[verified domain](README.md#verified-domains). Operational problems (a leaked token, a lock-out) are in
the [SSO runbook](../runbooks/sso.md).

## What SCIM can and cannot do

- It manages **staff memberships of this one workspace**: create, update, suspend, reactivate, revoke,
  and the role through group mappings. Nothing else — no investors, no documents, no settings.
- **It never changes a person's FundRoom account.** The account (email, name, sign-in methods) may
  belong to other workspaces too; SCIM's names and emails are kept on a per-workspace SCIM record and
  shown in **Settings → SSO → SCIM → Users**. A brand-new account created by SCIM starts with the
  email it was given; after that SCIM never touches it.
- **It never touches owners.** An owner's role is never recomputed from groups, and deactivating or
  deleting an owner is refused (`400`, `scimType: mutability`). Change owners in **People**.
- **Only verified domains.** A user's `userName` (and work email) must be in one of the workspace's
  verified domains; anything else is refused (`400`, `scimType: invalidValue`).
- **Investors stay investors.** Creating a SCIM user for someone who is an investor or other external
  member of this workspace is refused (`409`, `scimType: uniqueness`).

## Connecting the IdP

1. **Settings → SSO → SCIM**. Copy the **SCIM base URL**: `{BASE_URL}/scim/v2` (the install's canonical
   address, base path included — never a custom domain; the workspace is identified by the token).
2. **Create token**, give it a name ("Entra provisioning"). The token (`frs_…`) is **shown once**: paste
   it into the IdP straight away. It is stored only as a hash. (Tokens created before the FundRoom
   rename start `shs_`; they keep working, so an IdP already set up needs no change.) A workspace can have **two** live tokens,
   so you can rotate: create the new one, switch the IdP to it, revoke the old one. A token **outlives the
   person who created it** — deprovisioning must keep working after that person leaves — so revoke tokens
   you no longer use here; nothing else ends them.
3. Set up the IdP as below, and assign people and groups.
4. Map groups to roles once the IdP has pushed them ([Groups and roles](#groups-and-roles)).

If the SCIM tab says SCIM is off, the operator has set `SCIM_ENABLED=false`.

### Microsoft Entra ID

Use the same enterprise application as SAML SSO, or, for OIDC SSO, the enterprise application Entra
created for the app registration.

1. The enterprise app → **Provisioning → Get started** (or **New configuration**) → **Provisioning Mode:
   Automatic**.
2. **Admin Credentials:**
   - **Tenant URL:** the SCIM base URL, `{BASE_URL}/scim/v2`. You may append `?aadOptscim062020` (Entra's
     flag for standards-compliant PATCH requests); both forms work.
   - **Secret Token:** the `frs_…` token.
   - **Test Connection.**
3. **Mappings → Provision Microsoft Entra ID Users.** The defaults work. Check that `userName` gets an
   address in a verified domain: Entra maps `userPrincipalName` to it, which is often the right address
   but is `…@<tenant>.onmicrosoft.com` for cloud-only accounts that were never given your domain —
   those are refused. Map `mail` instead if your UPNs are not your email addresses.
4. **Mappings → Provision Microsoft Entra ID Groups:** leave it on if you want to map groups to roles.
5. **Settings → Scope:** *Sync only assigned users and groups*.
6. **Provisioning Status: On → Save.** Entra's first cycle starts within minutes, then runs about every
   40 minutes. **Provision on demand** pushes one user now.

Entra deactivates first (`active: false`) when someone is unassigned or disabled, and deletes only later
or when configured to.

### Okta

SCIM goes on the app integration you created for SSO (OIDC or SAML).

1. The app → **General → App Settings → Edit → Provisioning: SCIM** → Save.
2. **Provisioning → Integration → Edit:**
   - **SCIM connector base URL:** `{BASE_URL}/scim/v2`;
   - **Unique identifier field for users:** `userName`;
   - **Supported provisioning actions:** *Push New Users*, *Push Profile Updates*, *Push Groups*;
   - **Authentication Mode:** *HTTP Header*, **Authorization:** the `frs_…` token (Okta sends it as
     `Bearer`);
   - **Test Connector Configuration**, then Save.
3. **Provisioning → To App → Edit:** enable *Create Users*, *Update User Attributes* and *Deactivate
   Users*.
4. **Assignments:** assign people or groups. **Push Groups:** push the groups you want to map to roles.

Okta never deletes users over SCIM: unassigning or deactivating someone sends `active: false`, which
suspends the membership.

## Deactivate, reactivate, delete

| From the IdP | In FundRoom |
|---|---|
| create (`POST /Users`) | a staff membership in this workspace, at the role its groups give it (else the default role). An existing FundRoom account with that email is used — never a second one. If the person already is staff here, that membership is taken over by SCIM |
| `active: false` | the membership is **suspended**: the person can no longer use this workspace and their sessions for it are signed out. Nothing is deleted |
| `active: true` | the membership is **reactivated**; if it had been revoked in the meantime, the person is **provisioned again** |
| `DELETE /Users/{id}` | the membership is **revoked** (reason `scim_deprovisioned`). Their account and their memberships in other workspaces are untouched; what they did here stays in the audit log. Creating them again gives a new membership |

Suspended users, and users whose membership was revoked outside SCIM, are still returned by `GET /Users`
with `active: false`, so the IdP keeps seeing them.

**The IdP is the source of truth for the people it manages.** Revoking or suspending a SCIM-managed
member in **People** takes effect at once, but it is **not durable**: if the IdP still assigns the person,
its next `active: true` or `POST` for them provisions them again. To remove someone for good, unassign them
in the IdP.

**Erasure.** When a member's personal data is erased (a DSAR), their SCIM record is scrubbed and closed:
the IdP gets `404` for it from then on. If the IdP still assigns the person it will create them again with
a new `POST`, and FundRoom provisions them — the workspace decides, so stop assigning them in the IdP
first.

## Groups and roles

IdP groups pushed over SCIM appear in **Settings → SSO → SCIM → Groups**. An owner can map each to a
staff role: `admin`, `legal`, `finance`, `editor` or `viewer` — **never `owner`**. Mapping is done in
FundRoom, not in the IdP, and is itself audited (`scim.group_role_mapped`).

A SCIM-managed member's role is the **highest** role among the mapped groups they belong to, in this
order:

```
admin  >  legal  >  finance  >  editor  >  viewer
```

A member in no mapped group gets the **default role**: the SSO connection's JIT role, or `viewer` when
there is no connection. The role is recomputed whenever the IdP changes a group's members and whenever an
owner changes a mapping. Owners are skipped.

Mapping a group to `admin` hands the IdP the power to make admins: whoever can add people to that group
in your directory can. Map `admin` only to a group your IdP team guards as carefully as the FundRoom
admin role itself.

## The protocol

Base URL `{BASE_URL}/scim/v2`, `Authorization: Bearer frs_…`.

| Endpoint | |
|---|---|
| `GET /ServiceProviderConfig`, `/ResourceTypes`, `/Schemas` | discovery |
| `GET /Users` | filter, `startIndex` (1-based), `count` |
| `POST /Users` | create; `201` with the `id` |
| `GET`, `PUT`, `PATCH`, `DELETE /Users/{id}` | `DELETE` answers `204` |
| `GET /Groups` | filter, `excludedAttributes=members`, `startIndex`, `count` |
| `POST /Groups` | create |
| `GET`, `PUT`, `PATCH`, `DELETE /Groups/{id}` | |

- **Filters:** `userName eq "…"`, `externalId eq "…"`, `emails[type eq "work"].value eq "…"` and
  `emails.value eq "…"` on users; `displayName eq "…"` and `externalId eq "…"` on groups; joined with
  `and`. Anything else is `400 invalidFilter`. No sorting, no bulk, no ETags, no password changes.
- **User attributes:** `userName` (required, case-insensitive, unique in the workspace), `externalId`,
  `name.givenName`, `name.familyName`, `displayName`, `emails` (the `work` one), `active`. A `password`
  is ignored.
- **Group attributes:** `displayName` (unique in the workspace, case-insensitive), `externalId`,
  `members` (`value` = a SCIM user id).
- **PATCH:** `add`, `replace` and `remove`, in any letter case, with or without a `path`, including the
  shapes Entra and Okta send: `active` as `false` or `"False"`, a path-less `replace` with a
  `{"active": false}` or `{"name.givenName": …}` value, `emails[type eq "work"].value`, adding and
  removing group `members` (`members[value eq "…"]`) and replacing them all. All operations of one
  request apply together or not at all.
- **Content types:** requests as `application/scim+json` or `application/json`; responses are
  `application/scim+json`. Errors follow RFC 7644 §3.12 (`schemas`, `status` as a string, `scimType`,
  `detail`).

| Status | `scimType` | When |
|---|---|---|
| 400 | `invalidFilter`, `invalidSyntax`, `invalidPath` | a filter, body or PATCH path FundRoom does not accept |
| 400 | `invalidValue` | the `userName` or work email is not in a verified domain; an unknown group member |
| 400 | `mutability` | deactivating or deleting an owner |
| 401 | — | missing, unknown or revoked token |
| 404 | — | no such user or group in this workspace; or SCIM is turned off (`SCIM_ENABLED=false`) |
| 409 | `uniqueness` | the `userName`, `externalId` or group name is taken, or the person is an external member here |
| 413 | — | body over 1 MiB |
| 429 | — | over **1200 requests a minute** for this token (counted per server process, so an install running several app processes admits proportionally more); `Retry-After` says when to try again |

## Known limitations

- **SCIM groups do not grant access to documents.** They set staff roles only; they do not feed the
  workspace's access groups (**People → Groups**) or data-room grants.
- **Changing `userName` does not move the membership to another account.** The SCIM record is updated,
  but the membership stays with the account it was created for. To move someone to a different address,
  delete and re-create them at the IdP.
- **Owners are outside SCIM.** Assign owners in the IdP if you like; SCIM will neither demote, suspend
  nor remove them.
- **A crash in the middle of a create can leave a membership without a SCIM user.** Creating a user
  commits the membership before the SCIM record. If the server dies in between, the person is staff here
  but not SCIM-managed; the IdP's retry of the same create picks the membership up, otherwise revoke it
  in **People**. When a create loses a race with another one after it made the membership, it revokes
  that membership again (`scim_rollback`); it never touches a membership or invitation that already
  existed.
- **Only bearer tokens** — no Entra-issued JWTs, no OAuth client credentials.
- **No enterprise extension attributes** are used.

## The admin API

Under `/api/v1`; reading needs `sso.read` (owners and admins), changing needs `sso.manage` (owners only)
and step-up:
`GET /sso/scim` (enabled, base URL, tokens, counts), `POST /sso/scim/tokens` (`{name}` → the token, once;
`409 scim_token_limit` with two live ones), `DELETE /sso/scim/tokens/{id}`, `GET /sso/scim/users`
(paginated with `cursor`), `GET /sso/scim/groups`, `PUT /sso/scim/groups/{id}/role`
(`{role: "admin"|"legal"|"finance"|"editor"|"viewer"|null}`). `404 scim_disabled` means the operator
has turned SCIM off (`SCIM_ENABLED=false`).

Everything SCIM does is on the workspace's audit log with the actor `scim:<token id>`; see the
[runbook](../runbooks/sso.md#reading-the-audit-log).
