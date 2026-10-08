# @fundroom/share-links

Everything about a share link that is a *decision* rather than a query: the token and how it is stored, who a link may
admit, what a passcode buys, what the offering mode permits a link to *look like*, and the writes
that bind a visitor to it — plus the data access behind them.

The decision layer (`policy.ts`, `token.ts`) has no database and no clock of its own, so the same
rules run at OTP start, at redemption, in the admin preview and in a unit test with nothing behind
them. Drizzle is confined to `repos/` (the `only-repos-touch-drizzle` rule), the `compliance` and
`custom-domains` precedent.

It is a kernel package and not a module because a link is a **grant subject**:
`core.access_grant.subject_kind` has held `'link'` since `0004_access.sql`, and
`core.share_link_visit` is the authorization edge `PrincipalRepo` walks to emit that subject for a
membership. A disabled module must not be able to take that away.

## The decision everything else follows from: a visitor becomes a membership

There is no anonymous principal and there must not be one. A visitor who passes a link's admission
controls and verifies an email becomes a real `core.membership` with `kind='external'`,
`role='investor'`, `source='link:<id>'`. The **link stays the grant subject** — grants are written
once against `subject_kind='link'` and never copied per visitor — so revoking the link stops
emitting the subject and one write revokes everybody it let in.

This package owns the admission half of that: `mint`, `resolve`, `checkPasscode`, `admits`,
`redeem`, `noteView`, `revoke`. Creating the membership is `@fundroom/identity`'s
`establishMembership`, which reaches this package through the structural `ShareLinkAccess`
interface *it* declares and the server wires (`createShareLinkAccess`). The dependency runs
share-links → identity and never the other way, so there is no cycle.

## One wire answer for every "no"

Unknown, revoked, paused, expired, use-exhausted and view-exhausted all collapse into
**`not_found`**. Never 403, never 410, never 429.

That is not tidiness. A share-link URL is an unauthenticated surface, and a caller who could tell
"revoked" from "never existed" could enumerate live links — and knowing that a link *exists* is
already the interesting fact about a confidential data room. The same reasoning made
`requirePermission` answer 404 rather than 403 (`apps/server/src/middleware/authz.ts:262`).

The real reason is not thrown away: it stays on the row, which the admin screen reads directly, and
every refusal writes a `share_link.admission_refused` audit entry carrying the reason in `meta`. So
the admin sees "17 passcode failures in the last hour" while the wire keeps saying 404.

Routes must pair this with `withMinimumDuration` on any path that branches on whether a token
exists, or the timing answers what the status code refuses to.

## The two secrets are stored differently, on purpose

| | Entropy | Stored as | Why |
|---|---|---|---|
| Token | 256 bits (`randomToken()`) | `sha256(token)` | No dictionary exists to run against a stolen digest, and an unkeyed hash makes the lookup one indexed equality on `share_link_token_hash_idx`. Exactly what `InviteRepo.findByTokenHash` does. |
| Passcode | whatever a human typed | `HMAC(k, "share_link:v1:<id> <passcode>")` | `sha256("hunter2")` in a leaked backup **is** the passcode. A keyed MAC is not, unless the key ring leaks too. |

The passcode's scope carries the **link id**, so the same passcode on two links produces two
different MACs: an attacker holding the column cannot see that two links share a passcode, and a
MAC cannot be replayed from one link onto another. `verifyCode` walks every ring entry, so rotating
the key does not lock every live link out.

`mint()` returns the plaintext token exactly once and stores it nowhere. `resolve()` guards length
and alphabet *before* hashing, so an unauthenticated prober cannot make us digest and index-probe
arbitrary input, and it **never consumes**.

## Passcode attempts are counted on the link row, never on an IP

`passcode_attempts` and `passcode_locked_until` live on `core.share_link`, exactly the way
`core.auth_challenge.attempts` / `max_attempts` already works for OTP. Behind the shipped Caddy,
`TRUST_PROXY=true` takes the first `X-Forwarded-For` hop, which is attacker-supplied: an IP-keyed limit hands the attacker a fresh bucket per spoofed value while every
honest visitor shares Caddy's own container IP. **Count the thing being guessed.** An IP bucket may
be added on top; it may never be the only one.

Three details that are each a hole if they go the other way:

1. **The attempt is counted before the comparison.** A process that dies between the two has still
   spent the attempt; the opposite order is a free guess per crash.
2. **The lock is checked before the match.** A correct guess must not clear a lockout somebody
   else's guessing earned, and a locked link must not be an oracle for whoever finally gets it
   right.
3. **The lock resets the counter.** The lock is the punishment. A counter left at the ceiling makes
   the first attempt after the lock expires instantly "locked" again, and the link never accepts
   its own passcode a second time.

And one that is structural: **`checkPasscode` returns a refusal rather than throwing.** It runs in
the caller's transaction, so a thrown refusal would roll the attempt counter back and hand the
guesser unlimited tries. A route that turns the return value into an exception before committing
has removed the rate limit.

## Domain matching is exact, and subdomains are excluded deliberately

`@acme.com` admits `jane@acme.com` and nothing else. Not `evil-acme.com` (a suffix match would
admit it), not `acme.com.evil.net` (a prefix match would), and **not `mail.acme.com`**.

That last one is a choice, not an oversight. Subdomains of a corporate domain are routinely
delegated to third parties — marketing suites, status pages, acquired companies — so "anyone under
acme.com" is a wider audience than the admin who typed `acme.com` meant, and under Rule 506(b) the
size of the audience is the whole question. An admin who wants a subdomain adds it explicitly.

Both sides are reduced to one spelling before they are compared (lower-cased, trimmed, a leading
`@` stripped, one trailing dot stripped, every label non-empty), and `normalizeLinkPolicy` drops an
entry it cannot use rather than throwing — a single unparseable domain must not take a live link
offline.

## Offering mode gates issuance *and shape*

`permits(status).shareLinks` in `@fundroom/compliance` is already the "may links be issued at all"
boolean. `linkPolicyPermitted(status, policy)` here is the **stricter, shape-aware version of the
same offering-status table**, and it lives in this package rather than in compliance because it
takes a `LinkPolicy` — and compliance must not learn about share links to answer it.

| status | offering table | `linkPolicyPermitted` |
|---|---|---|
| `none` | no links | `links_not_permitted` |
| `informational` | no links | `links_not_permitted` |
| `506b` | email-verify **+ allowlist** only | `audience_too_open` unless a domain or named-email list is set |
| `506c` | permitted with tracking | permitted |
| `non_us` | permitted | permitted |

506(b) forbids general solicitation, and a link that admits any verified email *is* general
solicitation the moment it is forwarded — proving an address says nothing about a pre-existing
relationship. A status added to `core.offering_status` without a decision here is refused, not
permitted: a new regulatory mode must not inherit "links are fine" by omission. The rule is not
re-derived in the browser; the admin screen renders the server's refusal.

## Counters are claimed in one statement

`max_uses` counts **distinct memberships admitted**; `max_views` counts **distinct view sessions**
("counts *unique sessions*, not requests"). `SELECT uses; if (uses < max) UPDATE`
loses the race every time two redemptions arrive together — both read 4, both write 5, and a link
capped at 5 has admitted six people. So every increment is

```sql
UPDATE core.share_link SET uses = uses + 1
 WHERE id = $1 AND status = 'active' AND … AND (max_uses IS NULL OR uses < max_uses)
 RETURNING uses
```

— guard and write in one statement under one row lock, with "no row returned" as the refusal.
Nothing above `repos/` may decide a cap from a snapshot it read earlier. `service/links.test.ts`
proves it both ways: five concurrent redemptions of a link capped at two admit exactly two, and the
companion test turns the conditional off to show all five would get in.

Only a **new** binding spends a seat. `upsertVisit` reads Postgres's own `xmax = 0` to say whether
this call inserted or updated, because a `SELECT` then an `INSERT` is two statements and two
chances to both decide "new"; a visitor returning on a second device does not burn another use. A
binding an admin revoked individually is never resurrected by re-opening the URL.

### `isOpen` and `isLive` are two different questions

- **`isOpen`** — active, not revoked, not expired. This is *exactly* the predicate
  `PrincipalRepo.listActive()` uses to decide whether to emit a `link` subject. Keeping the two
  spellings identical is what makes "revoking takes access away" true rather than plausible.
- **`isLive`** — `isOpen`, and with budget left. This is the *admission* predicate.

A use cap limits how many people may come in, not how long the ones who did may stay. So an
exhausted link resolves as `not_found` for a new visitor while the people already inside keep their
access, and `redeem` checks `isOpen` — the cap is then spent, or refused, by the one statement that
can settle it. (Checking `isLive` there refused returning visitors the moment a link filled up,
while `PrincipalRepo` went on emitting its subject for them: a link that had stopped letting its
own people back in while still granting them everything. The test that caught it is
"lets a bound visitor back in after the link filled up".)

Pausing and revoking are different: both stop the subject being emitted, so **pausing a link
suspends access for everyone it has already admitted**, not merely new admissions. The admin UI has
to say so.

## Every method runs as `system` or `staff` — never as the visitor

`core.share_link` has **no permissive RLS policy for `external` at all**. Postgres RLS is
row-level, so there is no policy that could hand back the row while withholding `token_hash` and
`passcode_hash` — and a share-link visitor *is* an external member the moment they are admitted.
`core.share_link_visit` is the same story from the other side: external gets `FOR SELECT` on its own
row and no INSERT or UPDATE at all, because writing that row is equivalent to granting oneself
everything the link carries without ever holding the token, the passcode or the OTP.

Under an `external` context these methods would therefore see **zero rows and raise nothing** — the
worst failure shape there is, because it is indistinguishable from "no such link" and would be
debugged for a day. So every method refuses an `external` context up front, loudly, with
`ShareLinkError("forbidden", …, { reason: "external_context" })`.

The public link routes run under `systemContext(workspaceId)`, which the tenant classifier has
resolved from the host or slug long before any membership exists. A fact the visitor's UI needs off
the link — its label, its `forceWatermark` — is projected server-side from that read. Adding an
`external` policy to `core.share_link` is not the fix; it would carry both digests with it.

## The layer around it

| File | What it owns |
|---|---|
| `policy.ts` | Pure. `LinkPolicy`, `normalizeDomain`/`normalizeLinkPolicy`, `isOpen`/`isLive`, `emailRefusal`, `admits`, `passcodeVerdict`, `linkPolicyPermitted`. |
| `token.ts` | Pure crypto over `@fundroom/identity`'s primitives: `mintToken`, `tokenHash`, `isPlausibleToken`, `hashPasscode`, `verifyPasscode`. |
| `repos/share-link-repo.ts` | The only drizzle import. `ShareLinkRepo implements ShareLinkStore`; every cap is a conditional `UPDATE … RETURNING`. |
| `service/types.ts` | `LinkRecord`/`LinkSummary`/`LinkVisit` (this package's row shapes, not the schema's), `ShareLinkStore`, `ShareLinkDeps`, `ViewSessionLedger`. |
| `service/links.ts` | `createShareLinkService`, and `createShareLinkAccess` — the two-method object identity's `ShareLinkAccess` describes. |

The row shapes are this package's own, mapped from `core.share_link` in the repository. That keeps
the service and its tests off the schema (a fake store is one object, not twenty-three columns),
means a column added upstream is a change in one file, and makes it impossible for a `LinkSummary`
to carry `token_hash` or `passcode_hash` out to a route — `passcodeRequired` is a boolean, derived
once, and the digest never leaves the repository.

`createShareLinkAccess` is a separate object rather than two more methods because
`ShareLinkService.admits` is the **pure** two-argument function while `ShareLinkAccess.admits` is
the async four-argument one; an overload making one name mean both would be a trap for whoever
wires them together. Its `admits` answers `false` for a link that does not exist, which is the same
collapse the wire makes — `checkEligibility` must not be able to distinguish "no such link" from
"not your email", or the OTP start endpoint becomes the enumeration oracle the 404 was protecting.

## Known gap: view sessions are deduplicated in process

`core.share_link_visit` has no column recording which sessions have been counted, so there is
nothing for a `WHERE` clause to test and the dedup cannot be pushed into SQL. `noteView` therefore
claims the `(workspace, link, membership, session)` key in a `ViewSessionLedger` first, and the
default implementation is a bounded per-process set (cleared wholesale when full, because the key
contains an attacker-chosen session id).

A restart or a second node can therefore count one session twice. That errs in the safe direction —
a view budget is reached *sooner* than a perfect dedup would reach it, never later — and the ledger
is an injected interface precisely so a durable implementation can replace it without touching
anything above it. The exact fix is a row per counted session (`core.share_link_view`, keyed
`(link_id, membership_id, session_id)`, with `INSERT … ON CONFLICT DO NOTHING RETURNING` gating the
increment); a cheaper approximation is a `last_session_id` column on `core.share_link_visit`. Both
are schema changes this package does not own.
