# Runbook: central auth origin

With `CENTRAL_AUTH=on`, people sign in once on the install's canonical host (`BASE_URL`), and every workspace
host — a verified custom domain like `investors.acme.com`, or `acme.<your domain>` — gets its own session with
one "Continue". That session is bound to that one workspace. It also makes passkeys work on custom domains,
and means a domain change no longer forces everyone to type a code again. This runbook is for whoever runs
the install: turning it on, how a sign-in travels, the error codes a user can land on, step-up and sign-out,
and what it does not protect against.

Reference material: `packages/identity/src/services/central-auth.ts` and `apps/server/src/routes/central-auth.ts`. It reuses the
workspace-bound session of staff SSO.

## What has to be true first

- **Workspace hosts exist.** Central auth serves only requests on a workspace's `<slug>.<canonical>` host or
  its **active** custom domain. A single-tenant install has neither, so it never offers or serves it. A
  path-mounted request ([path-mount.md](path-mount.md)) is never served either: a mount is someone else's
  origin, and its visitors sign in there the ordinary way.
- **The canonical host is reachable by every user**, and is where they will enter codes, passkeys and
  authenticator codes. Brand it accordingly: the sign-in page there shows the install's name
  (`INSTANCE_NAME`), not a workspace's.
- It does **not** need `CONTROL_PLANE=on`, and works with `TENANCY_MODE=multi` whether or not you run the
  control plane.

```
CENTRAL_AUTH=on
```

Restart the server processes. Nothing is migrated and nobody is signed out.

## How a sign-in travels

```
investors.acme.com/login  ── "Continue" ──▶  investors.acme.com/auth/central/start?return=/documents
   sets __Host-auth_creq (a random verifier) on investors.acme.com, 303 ─▶
portal.example.com/auth/central/authorize?req=…
   not signed in here?  ─▶ /login?returnTo=… (email code / passkey / TOTP), then back
   signed in, a live member of the workspace ─▶ 303 with a one-time code (60 s)
investors.acme.com/auth/central/finish?code=…
   checks the verifier cookie, spends the code, mints a session BOUND to this workspace ─▶ /documents
```

| Step | Host | Lives |
|---|---|---|
| request (`central_request` challenge + `__Host-auth_creq` cookie) | workspace host | 10 minutes |
| handoff code (`central_handoff` challenge) | canonical → workspace host | 60 seconds, single use |

The session minted on the workspace host has the auth level and auth time of the canonical session. It is
never stronger and never fresher, so a passkey sign-in on the canonical host counts as level 2 on the
workspace host, and an email-code sign-in stays level 1.

The workspace-host login page shows **Continue** as the primary way in. Email code and magic link on the
workspace host still work exactly as before, and an invitation is still accepted there: someone with only
an `invited` membership is not handed off.

`GET /auth/central/start` writes a row for an anonymous visitor, so it is limited to 30 requests a minute per
client address.

## Where a user can land, and why

A failed hand-off returns to the workspace host's login page with `?error=<code>`:

| Code | Meaning | What to do |
|---|---|---|
| `no_access` | signed in on the canonical host, but not a live member of this workspace (no membership, revoked, suspended, expired, or only invited) | an admin invites them, or they accept the invitation on the workspace host |
| `expired` | the request (10 min) or the code (60 s) ran out, the link was used twice, or an unknown code came back | start again |
| `binding_mismatch` | the sign-in finished in a different browser from the one that started it, or cookies are blocked for the workspace host | start and finish in the same browser; allow cookies for the workspace's site |
| `reauth_mismatch` | a re-authentication was completed by a different person on the canonical host than the one signed in on the workspace host | sign out on the canonical host, sign in as the right person |
| `session_ended` | the canonical session was revoked or expired, or the membership ended, while the hand-off was in flight | sign in again |

`?sso=1` means: staff of a workspace that enforces SSO. They are sent to that workspace's own SSO sign-in
instead ([sso.md](sso.md)), which mints its own bound session. A canonical session never satisfies SSO
enforcement.

## What a bound session can and cannot do

It works in this workspace only: it is ignored on every other workspace and on the canonical host itself. It
cannot read or change the person's global account (password, second factors, passkeys, recovery codes, other
sessions and devices, locale); those answer `403 bound_session_restricted`, and the web app hides them. Account
security is managed on the canonical host.

- **Re-authentication** through the canonical host goes round again: `/auth/central/start?…&reauth=1`. The canonical host
  requires its own proof to be no older than 5 minutes, and asks for a fresh one (`/auth/step-up`) if it is
  older.
- **Sign-out** on a workspace host ends only that workspace's session. The canonical session and other
  workspaces' sessions stay. **Sign out everywhere** exists only on the canonical host, and ends the bound
  sessions too.
- Every bound session records the canonical session it came from. Ending that canonical session (sign-out,
  an admin or device revocation, the concurrent-session cap) also ends the bound sessions minted from it.
  Signing in again in the same browser carries them over to the new canonical session instead. Bound sessions
  minted from the person's other canonical sessions stay.
- Step-up on a bound session may also use a factor the person already has (passkey or TOTP), on a budget of
  its own for that workspace, as with an SSO-bound session. It raises only that session.
- Bound sessions have a cap of their own: three per person per workspace, the least recently used
  replaced by a new hand-off. They never count against or sign out the person's canonical or operator
  sessions.

## Passkeys on custom domains

A passkey belongs to one relying party, the `BASE_URL` host (`PASSKEY_RP_ID`). With central auth, passkeys
are used on the canonical host and the result is handed off, so they now work for every custom domain. With
`CENTRAL_AUTH=off` a custom domain still refuses the passkey ceremony up front.

WebAuthn "related origins" (`/.well-known/webauthn`) are deliberately not used: browsers guarantee only five
distinct registrable names, and the file would publish your customer list.

## What it does not protect against

A custom domain's DNS belongs to the customer. Whoever controls `investors.acme.com` can receive the handoff
code **and** the verifier cookie of that workspace's own members, or start a request themselves and lure a
signed-in member into authorizing it. What they get is bounded by the binding:

- a session for that member, in **that** workspace only (which the workspace's admins already control);
- no access to the member's global account or other workspaces;
- no stronger or fresher proof than the member already had.

On `<slug>.<canonical>` hosts, which you control, the verifier cookie fully protects the code. This is an
accepted residual risk; report a way around the binding, not its existence.

## Troubleshooting

- **"Continue" is missing.** `CENTRAL_AUTH` is off, the page is on the canonical host itself, the custom
  domain is not `active` yet, or the request is path-mounted. The page config's `centralAuth` is non-null
  exactly when the button should show.
- **Every hand-off ends in `binding_mismatch`.** The `__Host-auth_creq` cookie is not coming back to the
  workspace host: a browser or extension blocking cookies for it, or an edge stripping `Set-Cookie`. The
  cookie is host-only, `Secure`, and set on a top-level navigation. Check the finish request in the browser's
  network panel.
- **A loop between the workspace host and the canonical login.** The canonical session is not being kept:
  check that `BASE_URL` is the host users actually reach, and that the canonical login completes (it returns
  with a full page load to `/auth/central/authorize`).
- **Signed in by magic link, then nothing happened.** A magic link on the canonical host lands on `/` and
  loses the pending hand-off (known gap). Press **Continue** on the workspace host again, or sign in with the
  emailed code instead.
- **Audit.** A completed hand-off is `session.central_handoff` on the workspace's chain, with the member as
  actor. There is no separate `auth.login` row for it.

## Keys this runbook refers to

| Key | Default | Notes |
|---|---|---|
| `CENTRAL_AUTH` | `off` | any tenancy mode; only workspace hosts are served |
| `BASE_URL` | — | its host is the auth origin |
| `PASSKEY_RP_ID` | the `BASE_URL` host | leave it so with central auth |
