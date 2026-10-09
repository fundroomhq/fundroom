---
"@fundroom/share-links": minor
"@fundroom/clickwrap": minor
"@fundroom/db": minor
"@fundroom/authz": minor
"@fundroom/compliance": minor
"@fundroom/identity": minor
"@fundroom/audit": minor
"@fundroom/mail": minor
"@fundroom/storage": minor
"@fundroom/contracts": minor
"@fundroom/module-kit": minor
"@fundroom/sdk": minor
"@fundroom/server": minor
"@fundroom/web": minor
"@fundroom/module-data-room": minor
---

Share links and the NDA click-wrap engine. A founder can send a tracked, policy-bound link to someone who is not in the directory yet, and that person can verify an email, accept an NDA and read exactly what the link opened — with a signed certificate of what they agreed to and when.

New `@fundroom/share-links`: the link row and its token (256 bits, stored only as a digest, resolved without ever being consumed), and the **admission** rules — the domain allow-list and named contacts, the rate-limited passcode, expiry, the use cap and the view cap — all pure and all collapsing every refusal a stranger can provoke into one wire answer, because a caller who could tell "revoked" from "never existed" could enumerate live links and learn that a link they were refused exists. `linkPolicyPermitted` implements the offering-mode table as a function rather than a boolean: under `506b` a link must name an audience, and an "any verified email" link is refused. New `@fundroom/clickwrap`: the certificate as a **canonical JSON document** — a fixed key set with no optional properties, declaration key order, `audit.canonical()`'s timestamp rendering, the format version inside the preimage — plus its digest and a PDF rendering of it. The JSON cites the acceptance's audit `seq` and `hash`; a `legal.certificate_issued` event then carries the JSON's sha256; the PDF prints both anchors and says it is a rendering. pdf-lib stamps dates from the wall clock and orders objects by insertion, so hashing a PDF would be hashing a clock.

`@fundroom/db` migrations `core/0008_share_links` and `core/0009_link_policy_target`: `core.share_link` and `core.share_link_visit`, with **no permissive RLS policy for `external`** on the link itself — row security is row-level, so no policy could return the row while withholding `token_hash` and `passcode_hash`, and a link visitor is an external member the moment they are admitted — and own-row reads but **no external writes** on the visit, which is an authorization edge a visitor who could insert one would use to grant themselves everything the link carries. The two files are split because Postgres permits `ALTER TYPE … ADD VALUE` inside a transaction but not the use of the value it just added, and recreating the `access_policy_target_shape` CHECK with a `link` arm counts as using it. That one enum value is the epic's entire schema-vocabulary change: `policy_kind` is untouched, because four of the seven link policies turned out to be admission controls rather than gates.

`@fundroom/authz`: `link` subjects are real — `Principal` carries the links a membership was admitted through, `subjectsOf` emits them, and `PrincipalRepo` walks `core.share_link_visit` so link grants materialise into `core.effective_access` with **no change to `AuthzPort`**. The `nda` gate now stores `{documentId}` and the policy repository resolves the current `<slug>:v<n>` stamp when it loads the gate, which fixes a latent bug — the gate matched `nda:<version>` while acceptances wrote `<slug>:v<n>`, so an accepted NDA settled its gate only if the document's slug was literally `nda`, and the pinned version went stale on publish — and makes re-acceptance on version change a property of the model: publishing already bumps `acl_version`, the stamp moves, and prior acceptors go pending with nothing rewritten.

`@fundroom/identity`: eligibility gains a third source so a link visitor can receive an OTP at all, reachable only from the token-scoped `/links/{token}` routes and never from the generic OTP start — otherwise possession of a link **id**, which is not a secret, would buy eligibility and bypass the passcode. The OTP challenge is bound to its link through `auth_challenge.binding_hash`, because passcode transitivity holds per link and a code minted by a passcode-free link could otherwise be spent at a protected one. `@fundroom/compliance`: the certificate seam, acceptance evidence gaining an optional typed name, accreditation self-certification writing **two** attestation rows (agreement to a text, which never expires, and accreditation as of a date, which expires in twelve months and carries its categories as data), and the acceptance register's keyset pagination pushed into the repository with CSV and JSON export — the CSV quoted per RFC 4180 *and* guarded against a leading `=` so a tenant-controlled slug cannot execute in a spreadsheet.

Also: the data room's weekly storage reconciler no longer deletes other epics' objects. It swept the whole `ws/<workspace>/` prefix and removed anything the key parser merely *recognised* and its own tables did not know — so every workspace logo has been deleted on the first weekly run more than a day after upload since E1.7 shipped, and click-wrap certificates would have followed. Recognising a key is not owning it, so the test is now an ownership allow-list and an unknown key area is left alone. `pendingFor` no longer makes one query per gating document on the bootstrap's hot path.
