# @fundroom/identity

Identity and session kernel: global users with per-workspace
memberships, server-side opaque sessions, email OTP by default with
magic link, passkeys, TOTP, password and generic OIDC, device tracking, invites,
the Postgres rate limiter, and the cookie / CSRF / step-up recipes as Hono middleware.

## Wiring

```ts
import { createAuthService, createPostgresRateLimiter } from "@fundroom/identity";

const auth = createAuthService(
  {
    db,                     // @fundroom/db Database
    keyRing: config.keyRing,
    mailer,                 // MailerPort; wrap with @fundroom/mail createTemplatedMailer for HTML
    rateLimiter: createPostgresRateLimiter(db),
    audit,                  // @fundroom/audit createAuditService(...)
    baseUrl: config.baseUrl,
    productName: "FundRoom",
  },
  {
    passkeys: { rpId: config.raw.PASSKEY_RP_ID ?? config.baseUrl.hostname, rpName: config.raw.PASSKEY_RP_NAME, origins: [config.baseUrl.origin] },
    password: {
      enabled: config.raw.AUTH_PASSWORD_ENABLED,
      // failMode: HIBP unreachable → accept unchecked (open) or refuse with breach_check_unavailable (closed);
      // both audit auth.password_breach_check_skipped and call onUnavailable (the server counts it).
      breachCheck: { enabled: config.raw.AUTH_HIBP_CHECK, fetch, failMode: config.raw.AUTH_HIBP_FAIL_MODE, onUnavailable },
    },
    oidc: config.raw.OIDC_ISSUER_URL
      ? { providers: { sso: { issuer: config.raw.OIDC_ISSUER_URL, clientId: config.raw.OIDC_CLIENT_ID!, clientSecret: config.raw.OIDC_CLIENT_SECRET, trustEmail: config.raw.OIDC_TRUST_EMAIL, allowedDomains: config.raw.OIDC_ALLOWED_DOMAINS } } }
      : undefined,
  },
);
```

`auth` implements `AuthPort` (`resolveSession`, `revokeSession`, `revokeAllSessions`,
`revokeSessionsForWorkspace`, `touchWorkspace`) and exposes the flows:

| Flow | Start | Finish | Notes |
|---|---|---|---|
| `emailOtp` | `start({ email, workspaceId, ip })` → always `{ status: "sent" }` | `verify({ email, code, …LoginContext })` | 6 digits, 10 min, 5 attempts; codes stored as HMAC under the key ring |
| `magicLink` | `start(…)` → also returns the `auth_req` binding cookie value | `confirm({ token, bindingToken, … })` (POST only); `peek(token)` for the confirm page | Email carries link **and** code; wrong browser → `binding_mismatch`, fall back to the code |
| `passkeys` | `beginRegistration` / `beginAuthentication` | `finishRegistration` / `finishAuthentication` / `finishStepUp` | Discoverable credentials, no email prompt; UV assertion = level 2 |
| `totp` | `beginEnrolment` → otpauth URI | `confirmEnrolment` → 10 recovery codes; `verify` / `verifyRecoveryCode` step the session up | Seeds sealed with AES-GCM; replay guard per time step |
| `password` | `set` (policy + HIBP) | `login`, `reverify` | Off unless `AUTH_PASSWORD_ENABLED`; unknown emails burn the same scrypt time |
| `oidc` | `begin({ provider, redirectUri })` → URL | `complete({ currentUrl })` | PKCE + state + nonce; identity `iss|sub`; verified-email linking only with `trustEmail` |
| `invites` | `create` (mails the link; carries groups, grants and a profile applied on acceptance), `resend`, `list`, `get` | acceptance = any verified login | `revoke` cancels a pending invite; `revokeMembership` is the system-actor form of `memberships.revoke` |
| `memberships` | `listPeople`, `person` | `update` (role with owner rules, profile, expiry), `setGroups`, `revoke` | `revoke` is one transaction: delegates, group rows, grants, their pending invites, `acl_version++`, `membership.revoked`, audit; then the user's sessions here are revoked |
| `groups` | `list`, `get` | `create`, `update`, `delete`, `addMembers`, `removeMember` | names unique case-insensitively; delete revokes member rows and the group's grants |
| `inviteImports` | `dryRun(csv)` | `start(csv)` → `identity.invite_import` job | columns `email, name, firm, groups, expires_at, note`; per-row status in `core.invite_import` |
| `sessions` | `listSessions`, `listDevices`, `revokeDevice`, `revokeByToken`, `stepUp` | | New-device email with one-click revoke |

Every login ends in `completeLogin()`: it checks *eligibility* (a non-revoked membership or a
pending invite for the workspace; start endpoints never reveal the answer), creates the global
user on first verified login, activates or creates the membership, and mints the session with
the population's lifetimes (clamped by `PLATFORM_BOUNDS`).

## Share links

A share-link visitor has neither a membership nor an invitation, so they are the third eligibility
source — and the *only* new one. `decideEligibility` is pure and says so in one place:

```ts
return { eligible: facts.linkAdmits === true, … };   // `undefined` means no link was named
```

`linkAdmits: undefined` is not `false`. It means nobody asked about a link, which is every ordinary
login, and treating it as anything looser would turn each workspace's OTP start endpoint into an
open mailer for arbitrary addresses.

Three rules hold this together, and none of them is optional.

1. **`checkEligibility`'s `linkId` is reachable only from the token-scoped `/links/{token}` routes.**
   It must never be threaded into the `/auth/otp/start` request schema. A link id, unlike its token,
   is not a secret — it shows up in admin screens, audit rows, logs and URLs — so accepting one
   there would let anybody holding the id skip the link's passcode, which is checked by the link's
   own `start` route and nowhere else.
2. **The OTP challenge is bound to the link** through `core.auth_challenge.binding_hash`
   (`linkBindingHash(linkId)`, the same column the magic link uses for its browser cookie). A code
   minted by link A cannot be spent at link B, and a link-bound code cannot be spent at the ordinary
   sign-in page at all. That is what makes the passcode's transitive enforcement real.
3. **`establishMembership` writes the `core.share_link_visit` row under the `system` context.** The
   row is an authorization edge — `PrincipalRepo` walks it to emit the `link` grant subject — so RLS
   gives `external` no INSERT policy on that table. Under the visitor's own context the write would
   fail silently and their grants would never materialise.

Identity never imports `@fundroom/share-links`; it declares `ShareLinkAccess` (`admits` / `bind`),
share-links implements it structurally, and the composition root wires `deps.shareLinks`. With
nothing wired, a link id admits nobody and every flow behaves exactly as it did before E2.3.

Rate limits (`RATE_LIMITS.shareLinkResolve` / `shareLinkPasscode` / `shareLinkOtpStart`, keyed with
`shareLinkRateKey`) count **the link**, and the OTP one counts link + address. Never `clientIp()`
alone: behind the shipped Caddy `TRUST_PROXY=true` takes the first `X-Forwarded-For` hop, which the
attacker writes.

## Audit and events

Every flow records audit rows through `deps.audit` and publishes catalogue events to the
outbox (`@fundroom/events`): `auth.login` / `auth.login_failed` (workspace chain, or the
platform chain for host-level logins), `invite.created` / `invite.revoked`,
`membership.created` / `membership.revoked` (in the same transaction as the change, plus the
`membership.created` / `membership.revoked` / `invite.created` / `user.created` events),
`auth.sessions_revoked_workspace` (workspace chain) and, in the platform chain so no tenant
learns about a user's other workspaces, `auth.session_revoked`, `auth.sessions_revoked_all`
(+ `session.revoked` event), `auth.device_revoked`, `auth.mfa_enrolled` / `auth.mfa_disabled`,
`auth.passkey_added` / `auth.passkey_removed`, `auth.password_changed`.
`createIdentityJobs({ db, sessions, rateLimiter })` returns the hourly `identity.sweep`
(dead sessions, expired invites, stale rate-limit windows) for `registerJobs`.

Access changes go through `@fundroom/authz` (`bumpAcl` in the same transaction, `GrantRepo`
for the invite's grants and the revocation cascade); this package never evaluates access.

## View as investor

`sessions.startViewAs({ sessionId, workspaceId, staffMembershipId, targetMembershipId, reason,
ttlMs })` writes the four `core.session.view_as_*` columns (all or none, CHECKed) and audits
`access.view_as_started` in that workspace (actor = the staff membership, subject = the investor,
`meta.reason` is the staff-authored reason). A view already held — in any workspace — is replaced
and audited `access.view_as_ended` (`reason: "replaced"`, or `"expired"` if it had lapsed).
`sessions.endViewAs({ sessionId, reason, expected? })` clears it under a row lock; with
`expected` it clears only that exact view, so concurrent requests noticing an expiry audit it
once. `resolveSession` returns the stored view as `AuthenticatedSession.viewAs` (possibly
expired — the HTTP layer decides whether it applies); revoking a session with a live view audits
its end (`reason: "logout"` / `"session_revoked"`). The per-request re-checks (expiry, staff still
active with `access.manage`, target still an active external member) live in
`apps/server/src/middleware/auth.ts`, not here.

## Access review, member sessions, ownership transfer

`createAccessReviewService({ db, audit })` builds the access review report: one row per
non-revoked membership (bounded at `ACCESS_REVIEW_MAX_MEMBERS` = 5000, `summary.truncated` when
it bites) with groups, direct grant count, last activity *here*, live sessions, the newest `nda:*`
and `accredited` attestations and the attestation-bound gates still pending in
`effective_access`. Flags: `stale` (active, no activity for `ACCESS_REVIEW_STALE_DAYS` = 90),
`never_active`, `expiring` (within `ACCESS_REVIEW_EXPIRING_DAYS` = 14), `accreditation_lapsed`,
`accreditation_diverges` and `pending_gates`. Divergence answers the open question with a
report instead of a behaviour change: the strictest applicable `accredited` gate's `maxAgeDays`
(read exactly as `pendingGatesAtRebuild` reads it, default 365) gives a lapse date of
`signedAt + maxAgeDays`, and `diverges` is true when that and `attestation.expires_at` differ by
more than a day. The pure `buildAccessReviewRows(facts, now)` is what the unit tests drive.

**Evidence and attestation.** Every report carries `reportSha256`: the sha256 of the canonical
JSON (keys sorted at every depth, `canonicalJson`) of its *evidence form*
`accessReviewEvidence(report)` = `{ schemaVersion, generatedAt, members, summary }` — without the
review history (`lastReview`, `nextReviewDueAt`) and with each `lastActiveAt` recorded **to the
day** (midnight UTC). `complete(ctx, { attest: { reportSha256, generatedAt } })` rebuilds the
report *as of `generatedAt`* (flags, and live-session counts as of that instant: sessions created
or revoked later do not change it) and refuses with `conflict` / `reason: "report_changed"` when
the digest differs, or when `generatedAt` is more than `ACCESS_REVIEW_ATTEST_MAX_AGE_MS` (a day)
old. That makes the GET → POST round trip deterministic for an unchanged workspace; the day
quantisation exists because sessions touch `last_seen_at` every few minutes (the reviewer's own
included), so a full timestamp would make every attestation fail. What does move the digest is a
real change: a member added or removed, a role, status, group, grant, attestation or expiry
changed, a member active for the first time in days, or midnight UTC passing. `complete()` then
stores the evidence itself (`core.access_review.report`, `report_schema_version` =
`ACCESS_REVIEW_REPORT_SCHEMA_VERSION`) with its digest in the append-only table and audits
`access.review_completed`; `storedReport(ctx, id)` returns it re-serialised canonically, so its
sha256 is the record's `reportSha256` (`GET /access/reviews/{id}/report`). Without `attest` the
report is built as of now (API callers that never showed anyone a report).

`createAccessReviewJobs({ deps, now })` is the daily `access-review.overdue` job (`41 6 * * *`,
E3.2). For every live, non-platform workspace, the next review is due `ACCESS_REVIEW_INTERVAL_DAYS`
(90) after the last completed one, or after the workspace's creation if it was never reviewed
(`accessReviewDueAt`). An overdue workspace gets the `access.review_overdue` audit row (system
actor, meta `{dueAt, lastReviewId, week}`) and the `access_review.overdue {dueAt, lastReviewId}`
event (the notify module alerts `access.manage` holders), at most once per ISO week (UTC): the
week's audit row is the marker, checked and written in one tenant transaction under a
per-workspace advisory lock, so reruns are no-ops. The report's `nextReviewDueAt` is unchanged
(null until the first review).

`createAdminSessionService({ db, audit })` is the workspace admin's view of a member's sessions.
`core.session` is global; **only sessions whose `last_workspace_id` is this workspace** are listed
or revocable (another workspace's session answers `not_found`, like an unknown one). Target
rules: staff targets need `canManageStaff`, an owner's sessions only an owner may revoke.
`revokeAllForMember` also burns the member's unconsumed login challenges for this workspace;
`revokeWorkspace` (danger zone) revokes every external member's — and optionally every staff
member's — this-workspace sessions except the caller's; `revokeAllInWorkspace` backs workspace
deletion. Transactions are sequenced (tenant read → host revoke + `session.revoked` outbox →
tenant audit), never nested. Every one of these paths writes `access.view_as_ended`
(`reason: "session_revoked"`, in the viewed workspace) for a revoked session that was viewing as
an investor, as `SessionService.revokeSession` does.

**Sessions are global, so a workspace's revoke signs the person out everywhere.** A session is one
sign-in, not one per workspace; "this workspace's sessions" means the ones it *last served*.
Revoking such a session ends the sign-in, so a person who belongs to several workspaces is signed
out of the others too and signs in again there. This is kept on purpose:
"unbinding" the session from this workspace instead would leave a sign-in the admin asked to end
able to come straight back here, and a session cannot be revoked for one workspace only. The route
descriptions and the danger-zone copy say so.

`memberships.transferOwnership(ctx, { toMembershipId, keepOwner }, actor)`: owner only; the target
must be an active staff member (else `not_found`); target → owner, caller → admin unless
`keepOwner`; one `membership.role_changed` per moved role plus `access.ownership_transferred`,
`acl_version` bumped, all in one transaction.

## Security hardening

- **Factor management.** When a user holds a second factor (a confirmed TOTP or any passkey),
  every factor change needs `AuthService.canManageFactors`. That means a level-2 session, or a
  step-up in the step-up window with one of the user's own non-UV passkeys. `hasSecondFactor`
  reports whether the user holds one. A password is not a second factor, and enrolling the first
  second factor stays open at level 1. `requireFactorProof` in `apps/server/src/routes/auth.ts`
  enforces the rule. After each change, `afterFactorChange` (`services/factor-change.ts`) signs
  out the user's other sessions (`credential_changed`) and mails a security notice.
- **Session rotation.** `sessions.stepUp` rotates the token. Concurrent step-ups are serialised on
  the session row, and a loser holding a stale `presentedToken` gets no new token. Logins take
  `replacesSessionId` (the resolved session's id, never a client value) and revoke that session
  (`replaced`) once the new one exists.
- **Email OTP.** An address that may not sign in gets a *decoy* challenge: the same row, but a
  random secret hash, so `verify` behaves the same for every address. The hourly `identity.sweep`
  deletes challenges `CHALLENGE_RETENTION_MS` (6 h) after they expire.
- **TOTP and recovery codes.** Each attempt uses up a `totpPerUser` rate-limit slot before the
  code is checked. The credential is read `FOR UPDATE` for the compare-and-write, so the same step
  or code cannot succeed twice. Recovery codes are stored as salted scrypt hashes,
  `rc1$<salt>$<hash>` (N=2^14, r=8, p=1). Older HMAC sets still verify until regenerated
  (`auth.recovery_codes_regenerated`).
- **Passwords.** scrypt uses `DEFAULT_SCRYPT` N=2^16, r=8, p=2, and weaker hashes are re-hashed on
  the next login. Replacing or removing a password needs `currentPassword`, which is limited by
  `passwordPerEmail`.
- **OIDC.** The auth level comes from the ID token's `amr`/`acr`: level 2 when they show MFA or a
  `mfaAcrValues` match, otherwise level 1. `trustMfa` forces level 2. `begin` returns a
  `bindingToken` for a browser-binding cookie, and a callback without it is refused
  (`binding_mismatch`).
- **Owner rows.** `MembershipRepo.lockOwners()` locks every owner membership (`FOR UPDATE`, id
  order) before the owner count on demotion, revocation and transfer. Two owners demoting each
  other at once therefore cannot leave the workspace with no owner.

## Access requests

`createAccessRequestService(identityDeps, { requestAutoApprove, inviteDailyCap? })` runs the public request-access form and the approval queue.

- **`start`** never throws, and every outcome returns `{ expiresAt }` inside a 250 ms floor. A real start writes a `core.access_request_challenge` holding that start's name, firm and reason, and mails a keyed-hash code detached.
  - Members, invited and suspended addresses get a "you already have access" mail and no challenge.
  - A honeypot, spent budgets (`accessRequestStart*` in `RATE_LIMITS`) and the 500-pending cap all get the success answer and no mail.
- **`verify({ email, code })`** counts the attempt first, then compares the code against every live challenge for the address in constant time. A match deletes the address's challenges and creates or refreshes the pending request with the matched text. It then applies the deny cooldown and, when `requestAutoApprove(offeringStatus)` allows, domain auto-approve.
- **`list` / `get`** take the caller's tx. **`approve` / `deny`** open their own transactions and mail after commit, so never call them inside `withTenant`.
- **`approve`** writes an invite through `writeInvite` with `invite.access_request_id`. On acceptance, `establishMembership` sets `source = "request"` and records the relationship through `identityDeps.relationships`.
- **`createAccessRequestJobs`** registers the hourly `access-requests.sweep`.

## Errors

Flows throw `AuthError` with a stable `code` (`invalid_code`, `too_many_attempts`,
`rate_limited`, `not_eligible`, `invalid_credential`, `binding_mismatch`, `step_up_required`, …)
and an HTTP status; `error.toBody()` is the JSON envelope. Unknown-email and wrong-code paths
share the same code and timing.

## HTTP (`@fundroom/identity/http`)

```ts
app.use("*", sessionMiddleware({ auth, cookieMode: (c) => (c.req.path.startsWith("/embed") ? "partitioned" : "first_party") }));
app.use("*", csrfMiddleware({ selfOrigin: config.baseUrl.origin }));
app.post("/export", requireSession(), requireAuthLevel(2), requireFreshAuth(), handler);
```

`issueSessionCookies` / `clearSessionCookies` / `issueAuthRequestCookie` write the cookie
recipes (`__Host-sid` Lax; `Partitioned` for embed; `__Secure-sid` + base path for
path mount).

## Testing

Unit tests need nothing. `identity.integration.test.ts` runs every flow against Testcontainers
Postgres with RLS on and the role switch on, using an in-process fake IdP (jose-signed id
tokens) and a fake WebAuthn authenticator behind the `PasskeyOptions.webauthn` seam.

## Emails

`src/mail/templates.ts` builds plain-text messages and is the source of truth for wording. Each
one also carries `template: { name, props }` (`auth.otp`, `auth.magic_link`, `auth.new_device`,
`auth.invite`, `auth.share_link_otp`; JSON-safe props, dates as ISO strings) so `@fundroom/mail`'s
`createTemplatedMailer` can render the HTML version without this package importing React. A
bare `MailerPort` sends the text alone.
