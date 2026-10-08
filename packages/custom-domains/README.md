# @fundroom/custom-domains

Everything about a custom portal domain that is a *decision* rather than a query: what a typed hostname reduces to, the challenge token
it must publish, the records to show the founder, the verdict on what DNS actually answered, and
the state machine that turns that verdict into a status — plus the data access and the services
that drive them.

The decision layer (`hostname.ts`, `token.ts`, `records.ts`, `verify.ts`, `state.ts`) has no
database and no network, `node:crypto` only, so the same rules run in the verify job, in the
weekly re-verify sweep, in an admin's "Verify now", and in a unit test with nothing behind it.
Drizzle is confined to `repos/` (the `only-repos-touch-drizzle` rule), the `compliance`
precedent.

It is `packages/custom-domains` and not a module because the hostname → workspace lookup runs in
the tenant classifier, before tenant context or module enablement exists; the
name is `custom-domains` because `packages/domain` is the ubiquitous-language package and means
something else entirely.

## Normalisation is the security boundary

`normalizeHostname` and `checkHostname` are not input validation with a friendly error message.
The string they return is written to `core.custom_domain.hostname` and later compared against a
request's `Host` header — so if the write path and the lookup path can disagree about what
`INVESTORS.Acme.com.` means, whoever controls that difference chooses which workspace serves a
request. Every accepted hostname is therefore reduced to exactly one ASCII spelling (IDNA via
`node:url`'s `domainToASCII`, lower-cased, root label stripped) and anything that cannot be
reduced unambiguously is refused rather than repaired.

The refusals each close a hole rather than tidy the input:

| Refusal | Why it cannot be accepted |
|---|---|
| `wildcard` | We verify and serve one exact name; `*.acme.com` would silently claim subdomains the customer later delegates elsewhere. |
| `ip_literal` | Includes the spellings `inet_aton` accepts — `127.1`, `0x7f.0.0.1`, `2130706433` — and fullwidth digits, which IDNA folds to ASCII *after* the naive check would have passed them. |
| `reserved` | `localhost`, `.local`, `.internal`, `.home.arpa`, `.arpa` and the RFC 2606 names mean something else on every machine in the building, and no CA will sign them. |
| `public_suffix` | A bare `com` or `co.uk` would claim everything underneath it. A deliberately short static list, not the PSL: it is a safety net against a typo, and the TXT challenge is what actually stops a claim nobody can prove. |
| `canonical_host` / `canonical_subdomain` | The canonical host and everything under it already route through the slug classifier. A row for one gives a second, contradictory answer for a hostname that already belongs to someone — a tenant-resolution bypass, not a duplicate row. |
| `too_long` | 63 octets per label, 253 total (RFC 1035 §2.3.4). |

A trailing dot is stripped, not refused — it is a legitimate FQDN spelling — but only one of them,
because `acme.com..` contains an empty label and normalising that away would give one hostname two
spellings.

## The token is derived, so nothing has to remember it

`challengeToken(key, workspaceId, hostname)` is `base32(HMAC-SHA256(key, "<workspace>:<hostname>"))`
truncated to 32 characters. Re-rendering the admin screen, a second replica and
the verify job all produce the same string without a read; losing the row loses nothing. It proves
control of a zone and authorises no request, so publishing it in public DNS costs us nothing, and
being an HMAC it carries no fragment of the key. Rotating the key invalidates every outstanding
challenge, which is the correct behaviour and not a migration.

`expectedRecords` derives the CNAME and TXT rows on every read and stores neither:
a stored copy of the instructions goes stale the day the operator moves their edge host, and the
stale copy is the one a founder would paste into their DNS form.

The TXT name is `_fundroom-challenge.<hostname>` (`CHALLENGE_LABEL`). Domains verified before the
rename publish `_seedhost-challenge.<hostname>` (`LEGACY_CHALLENGE_LABEL`), and that label is
accepted **permanently**: the weekly re-verify would otherwise demote every one of them. The service
resolves the new label first and the old one, in its own lookup, only when the new answer does not
carry the row's token; the two answers are never merged. `evaluate` takes an optional `txtLabel`,
so the sentence and the stored answer name the label that decided, and `txtCarriesToken` is the
shared match. `expectedRecords` shows only the new label.

## The verdict says what DNS said

`evaluate` takes the configured provider's `requires` — `{ cname, txt }` off
`CustomDomainProviderPort` — and returns `ok`, `cnameOk`, `txtOk` and one sentence. The requirement
is an input rather than a rule in this file because the two checks answer different questions: the
TXT challenge proves **control of the name**, the CNAME proves **traffic reaches our edge**. On a
`caddy-ask` install both matter, because it issues the certificate. On a `manual` install the
operator terminates TLS on their own edge and there is no hostname of ours to point at, so
verification is TXT-only — an `ok` hardcoded to `cnameOk && txtOk` showed those operators a TXT
record, accepted it, and then failed the domain on a CNAME nobody had mentioned (and with no target
configured, could never verify it at all). A check the provider does not require is neither gated on
nor mentioned in the sentence; `cnameOk` still reports what DNS said, so the UI can show the answer
without it being a verdict.

`evaluate` returns `ok`, `cnameOk`, `txtOk` and one sentence. The sentence is the reason this is
not a boolean: "verification failed" tells a founder nothing, while "investors.acme.com resolves to
shops.myshopify.com, not edge.fundroom.app (1.1.1.1)" tells them which record to fix — and it is
the "last resolver answer" the UI shows. NXDOMAIN, SERVFAIL, REFUSED, a missing
record and a wrong token each read differently, and a value echoed back out of somebody else's zone
is stripped of control characters and truncated first.

Two tolerances matter. A CNAME chain is accepted wherever the target appears in it, because the
common shape is a customer CNAME into a proxy that CNAMEs on to our edge and traffic arriving at
our edge is all the CNAME row has to establish. An `A`/`AAAA` answer is accepted for apex
CNAME-flattening — in that case the caller resolves `A` instead of `CNAME` and
passes the edge's expected address as `cnameTarget`, since `evaluate` is pure and cannot look up
its own addresses. Neither tolerance weakens the claim: it is the TXT record, compared in constant
time because it is a secret proof, that establishes *who controls the name*.

A positive verdict also requires `rcode === "ok"`. A SERVFAIL or a "the resolvers disagreed"
answer that happens to carry a record is not an answer we are entitled to act on, and it is what
`modules/updates`' `lookupTxt` has always meant by "we could not look".

### Where the apex's expected addresses come from

A zone apex cannot hold a CNAME, so `acme.com` itself is served by publishing `A`/`AAAA` records —
through the DNS host's ALIAS/flattening feature, or by hand. `service/domains.ts` therefore has a
second pass: when the CNAME is required, did not match, and the name exists without one, it
resolves the hostname's address records and matches them against the edge's.

The edge's addresses come from one of two places, and **the default needs no configuration**:

1. Unset `CUSTOM_DOMAIN_EDGE_ADDRESSES` — the normal case — resolves `CUSTOM_DOMAIN_CNAME_TARGET`'s
   own `A`/`AAAA` through the same DoH resolvers and accepts the apex when the two sets intersect.
   That is what flattening *is*; it asks the operator to know nothing, and it stays correct the day
   the edge's address changes. The answer is identical for every row, so it is memoised for 60 s —
   one extra lookup per sweep, not per row.
2. `CUSTOM_DOMAIN_EDGE_ADDRESSES`, a csv of IP literals, is an **override** for an edge on stable
   anycast addresses that its own DNS does not describe. When set it is used instead of resolving
   the target.

This branch used to run only when an `edgeAddresses` list was passed, and nothing ever passed one:
no config key existed and the container never set it. So apex support was dead in every shipped
configuration while the screen, the verdict sentence and the docs all said it worked, and
a customer who published the only record an apex can hold sat `pending` for 72 h and then
`failed`.

## The layer around it

| File | What it owns |
|---|---|
| `repos/domains-repo.ts` | The only drizzle import. `CustomDomainRepo` (tenant context) plus `findIssuableByHostname` / `listDomainsForSweep` (host context). |
| `service/domains.ts` | `createCustomDomainService`: list / add / verify-now / remove, and `check()` — the one verification pass the button and both jobs share. |
| `service/lookup.ts` | `createCustomDomainLookup`: the hostname → workspace answer for `ask` and the tenant classifier, cached 60 s, positive and negative, **bounded**. |
| `service/jobs.ts` | `domains.verify` (every 5 min, with backoff) and `domains.reverify` (weekly). |

Three rules the layer exists to enforce, each of which has a bug behind it:

1. **Host context for the lookup and for the candidate reads; tenant context for everything
   else.** `ask` and the classifier answer from a hostname alone, before any workspace is known,
   and the sweeps span workspaces — the table's RLS fence admits the `host` actor kind for exactly
   those callers. Admin operations run under `withTenant`, because the change and its audit row
   have to commit together inside the workspace's own fence. Backwards, this gives either zero
   rows or a fence that no longer fences.
2. **A demotion resets `first_attempt_at`.** There is no generic status setter on the repo: the
   only way to reach `pending` from a verified status is `demote()`, which resets that column in
   the same statement. The 72 h deadline is measured from it, so a demoted row that kept the date
   it was first added would be `failed` on the next 5-minute tick — "serving" to "dead", with no
   retry in between.
3. **One SQLSTATE, three meanings.** All three unique indexes raise `23505`, and two of them mean
   opposite things: `custom_domain_claim_idx` means *another* workspace holds the verified claim
   (answered without naming it — that would be a tenancy leak), while
   `custom_domain_one_per_workspace_idx` means *this* workspace already has one (answered by
   naming their own hostname, which is the only actionable reply). `uniqueViolationOf()` reads the
   constraint name so no violation escapes as a 500.

The lookup cache is attacker-facing: `?domain=` on the `ask` endpoint is unauthenticated input
from the public internet, so the cache is capped (1 000 entries, clear-on-full) and not merely
TTL'd — a TTL-only negative cache is a memory-pressure vector, one entry per hostname an attacker
cares to invent. Every status change invalidates both that cache and the workspace resolver's,
because `ResolvedWorkspace.primaryHost` now lives inside the latter — and so does
`deleteWorkspace`, which is the fourth transition and the one nobody listed: a soft-deleted
workspace keeps its `core.custom_domain` rows for the retention window, so a cached entry is the
only thing that could still route a closed portal and still let `ask` mint a certificate for it.

**The lookup also carries the rate limit** (`LOOKUP_MISS_MAX_PER_WINDOW`), because what needs
protecting is Postgres: one global counter of cache *misses*, behind the negative cache, so the
thing being limited is database reads rather than requests. The `ask` route used to hold a limiter
keyed on the client IP, which `TRUST_PROXY=true` plus Caddy *appending* to `X-Forwarded-For` made
attacker-supplied — a fresh bucket per spoofed value, while every legitimate ask shared one bucket
keyed on Caddy's own container IP. Over the ceiling the answer is "not found": Caddy treats any
non-2xx as "do not issue", and a 404 does not tell a prober they found a rate limit.

## The state machine is where the patience lives

`nextState` implements the verification state machine: `pending → dns_ok` on a good verdict,
`pending → failed` at `VERIFY_DEADLINE_MS` (72 h), `active → pending` after `REVERIFY_GRACE`
consecutive failures, `failed → pending` when an admin retries. The grace exists because taking a
working portal offline over one bad DoH answer is worse than a late demotion.

Two things it cannot do, being pure, and that its caller must:

1. **Reset `first_attempt_at` whenever it returns `pending` from another state.** The 72 h deadline
   is measured from that column, so a domain demoted out of `active` while carrying a months-old
   `first_attempt_at` would flip straight to `failed` on the next sweep.
2. **Drive `dns_ok → active`.** `nextState` never returns `active` from `dns_ok`, and that is the
   missing transition: a verdict about DNS is not evidence that a certificate was issued. A zone
   with a CAA record excluding our CA, or an ACME account that is rate-limited, leaves the hostname
   answering a TLS error — and `active` is what `primaryHost` keys off, so promoting on a good poll
   starts minting email links at a hostname that does not answer, with no demotion path for "the
   certificate never issued". The one place the fact is observable is the request path:
   `service/lookup.ts` fires `markServing` when the classifier resolves a live request through the
   hostname, at most once per host per 60-second cache entry, off the response path, and unable to
   fail the request. `ask` is deliberately *not* the trigger — it asks before the certificate
   exists, which is the whole reason it answers on `dns_ok`.

A refused promotion still counts as a failed attempt. When the claim index rejects the write, the
row does not advance, but the state machine is re-run with `ok: false` so the backoff grows and the
72 h deadline still reaches `failed` with an audit row — otherwise a row whose verdict was `ok` and
whose promotion was permanently refused polled the customer's nameservers every five minutes
forever, with no operator signal.
