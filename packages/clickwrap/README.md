# `@fundroom/clickwrap`

The click-wrap **certificate**: the evidence artefact that makes an NDA acceptance hold up six
years later, when the person who clicked has left, the browser they used no longer exists, and
somebody's counsel wants to know exactly what text was agreed to and how anyone can tell.

A click-wrap acceptance is not a signed NDA, and the certificate says so. The JSON is the artefact;
the PDF is a rendering of it.

---

## The one decision everything follows from

**The canonical JSON is the artefact. The PDF is a rendering of it.**

pdf-lib is not byte-stable. It assigns object ids in insertion order and, left alone, stamps
`CreationDate`/`ModDate` from the wall clock, so a PDF's sha256 is not a reproducible function of
its content and must never be the hashed object. This is the same split the audit log already makes for
audit rows: `audit.canonical()` renders a row as a jsonb object with a fixed key set and hashes
*that text*, and the row's storage representation is free to change underneath it.

So an acceptance produces, inside one transaction:

| step | who | what |
|---|---|---|
| 1 | `@fundroom/compliance` | writes `core.attestation`, audits `legal.document_accepted`, keeps that event's `seq` and `hash` |
| 2 | this package | builds the canonical `CertificateDocument`, which **cites** that event; `certificateSha256 = sha256(utf8(canonical))` |
| 3 | this package | audits `legal.certificate_issued`, whose `meta` **cites** `certificateSha256`; keeps *that* event's `seq` and `hash` |
| 4 | this package | stores the encrypted JSON **and** the rendered PDF, returns `{ reference, sha256 }` |
| 5 | `@fundroom/compliance` | puts `reference` in `attestation.evidence_ref` |

The certificate is bound to the audit chain in **both directions** — the JSON cites the acceptance
event, a later event cites the JSON — with no cycle and no second hash chain. `audit.anchor` stays
unused; this epic adds no external anchoring adapter, because what we actually ship today is the
per-workspace hash chain plus the daily HMAC-signed `audit.checkpoint`.

## What `canonicalize` guarantees, and how

It is pure and deterministic: the same facts always produce the same bytes. The discipline is
copied from `audit.canonical()` line for line.

- **A fixed key set.** Not "the keys this object happens to have". An absent fact is an explicit
  `null`; a key is never omitted, because `{"a":1}` and `{"a":1,"b":null}` are different preimages
  for the same facts. `CertificateDocument` therefore has no optional property.
- **Fixed key order**, the declaration order, emitted by a literal template so the format is
  readable top to bottom in one expression instead of inferred from a runtime object's insertion
  order.
- **No insignificant whitespace.**
- **Timestamps `YYYY-MM-DDTHH:MM:SS.ssssssZ`, UTC only** — exactly what
  `to_char(…, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` produces in `audit.canonical()`. A `Date` only
  carries milliseconds, so the last three places are always `000`; they are emitted anyway,
  because the format has to be *one* format.
- **A format version inside the preimage**, so a future key set can never collide with this one.
- **Everything validated before it is emitted.** Canonicality is not only key order: if
  `"0192…-A"` and `"0192…-a"` were both accepted as the same id, one fact would have two digests.
  Ids and digests must be lower case; free text must carry no control characters; `versionNo` and
  `auditSeq` must be positive safe integers. `assertValidCertificateDocument` throws otherwise.
- **Extra keys are dropped, not rejected** — because the canonical text, not the caller's object,
  is what gets stored. What is hashed is exactly what is kept.

What the tests prove (`document.test.ts`): a frozen golden string and digest; the emitted key
order; that reversing and sorting the input's keys at every level changes nothing; that a
`JSON.parse`/`JSON.stringify` round trip changes nothing; that `canonicalize` is its own fixed
point; that **every** single-field change produces a different digest (walked exhaustively over
the leaf paths, with a collision check); that a missing key throws rather than defaulting to
`null`; that `null` and `""` are not the same thing; that non-Latin text and lone surrogates
round-trip byte-stably.

## Privacy

A conventional click-wrap record captures "authenticated user id,
verified email (OTP), **IP, user agent**, timestamps (server-side, UTC), optional typed name".

**This package deliberately does not store the IP address, the User-Agent string, or the email
address.** It stores `emailSha256`, `ipHash` (a keyed HMAC under the workspace's `legal-ip` data
key) and `uaFamily` (`chrome`, `firefox`, …). That is the compliance kernel's decision,
implemented in `packages/compliance/src/privacy.ts`, and this package follows it:

- the reasoning stands. An acceptance record has to survive six years after an offering closes,
  which makes it the last place that should hold identifiers we would not keep anywhere else. A
  keyed hash answers the only two questions anyone actually asks of it — "same network?", "same
  browser?" — without keeping the identifier;
- a plain digest would not be enough (IPv4 is 2^32 wide and a dump would be enumerable), which is
  why `ipHashOf` is a keyed MAC under a per-workspace key. Two workspaces never hash one visitor
  alike;
- what is lost is the ability to answer "which address was this?" years later. If a regulator or a
  court ever requires the raw value, the honest answer is that we chose not to retain it, and that
  is a defensible position under GDPR data minimisation — but it *is* a choice, not an oversight.

A known gap, reported rather than papered over: "consent to electronic
records captured once per subject, with the ESIGN consumer disclosure text". There is no
`electronic_records` value in `core.consent_purpose` (`0006_compliance.sql:34` has only
`analytics_engagement` and `email_tracking`), so nothing captures it today. The frozen
`CertificateDocument` has no field for it either, so this certificate says, in plain English, that
it does **not** record that consent rather than implying it does. Closing this gap needs a schema
change and belongs to whoever opens `core.consent_purpose` next.

## The PDF

Evidence a lawyer opens in six years with nothing but a PDF reader. It prints who signed (display
name, typed name, membership id, email digest), the document title, version and body sha256, the
UTC acceptance timestamp, the browser family, the network hash, the share link, the certificate's
own sha256, **both** audit anchors, and two plain-English sections: what a click-wrap acceptance
records, and what it is not ("A click-wrap acceptance is
not a signed NDA…"). A closing section says how to verify the copy.

Only the standard 14 fonts are used, so no font file is embedded and nothing has to be kept
shipping for six years. The price is WinAnsi: a name in Chinese, Greek or emoji cannot be drawn.
`sanitizeForWinAnsi` replaces what it cannot encode with `?` rather than letting pdf-lib throw
mid-render. **That loss is confined to the rendering** — the canonical JSON keeps the exact bytes
the signer typed, and the JSON is the artefact.

`CreationDate`, `ModDate`, `Producer` and `Creator` are pinned to values derived from the document
itself, so nothing in the renderer reads the clock and two renderings come out byte-identical on
this version of pdf-lib (a test asserts it with `Date` faked a year apart). That is **not a
guarantee**: pdf-lib assigns object ids in insertion order, and an upgrade that reorders its own
writes, changes xref formatting or adds an `/ID` would change the bytes without changing a fact.
It does not matter, because the PDF's digest is never the evidence. The pinning is there so a diff
of two renderings shows content changes rather than timestamps.

The PDF is tested by **parsing it back** — `PDFDocument.load`, then decoding the page content
streams and reading the drawn strings — never by comparing bytes to a fixture. Note the trap the
test helper documents: `PDFDocument.load` defaults to `updateMetadata: true` and rewrites
`Producer` and `ModDate` on the copy it hands back, so any reader must pass
`{ updateMetadata: false }` or it destroys what it came to inspect.

**The PDF is not regenerable from the JSON alone.** It prints the `legal.certificate_issued`
anchor, and that event is not inside the JSON (it cannot be — it cites the JSON's digest). It is
regenerable from the JSON *plus* that audit event, and the page says exactly that rather than
claiming more.

## Storage

Certificates are as confidential as data-room documents and are treated identically: SHE1
ciphertext under the workspace DEK (`encryptBytes`), served only through the app with
per-request authz, never through a presigned URL. The serving route belongs to E2.3
work package E.

```
ws/<workspace_id>/certificates/<certificate_id>/certificate.json
ws/<workspace_id>/certificates/<certificate_id>/certificate.pdf
```

`certificateKey`, `certificatePrefix` and the `parseObjectKey` arm live in
`@fundroom/storage` (`src/keys.ts`) beside `blobKey`, `renditionKey` and `brandingLogoKey`. An
area of its own, not a rendition and not a blob, because: a certificate is not content-addressed
(its digest is the evidence anchor and belongs in the audit chain, not in a name a bucket owner
can change); it is not derived from a document version, and it outlives the version it cites; and
retention and legal hold apply to `certificatePrefix` as a unit.

### Both forms are stored; the PDF is not re-rendered on demand

Storing the rendered PDF is the safer choice, for three separate
reasons:

1. **Delivery.** The signer must be able to get a copy immediately, and the company must
   keep one for the retention period. Re-rendering makes delivery depend on this package still
   existing and still behaving identically — in year six, that is exactly what will not be true.
2. **It is not re-derivable on its own** (see above): it needs the issuance audit event as well.
3. **pdf-lib is a moving dependency.** A re-rendered PDF could differ from the one the signer was
   handed, and "the copy we gave you is not the copy we have" is the worst possible sentence in an
   evidence dispute.

The cost is a few kilobytes per acceptance. `fetch(ctx, tx, reference, "pdf")` returns the stored
bytes, not a fresh render.

### The reference

`cert:v1:<certificateId>:she1:<keyId>` — what goes into `attestation.evidence_ref`.

The key id travels in the reference rather than in the object's user metadata for the same reason
the data room keeps `blob.encryption` on the row: the database is the durable record, and a
bucket-level copy or lifecycle transition can lose user metadata without losing bytes. It is not a
secret — the wrapped DEK never leaves Postgres and unwrapping it needs the KMS.

The **workspace id is deliberately absent**. `fetch` builds the object key from `ctx.workspaceId`,
so a reference copied into another tenant's row resolves under *that* tenant's prefix and finds
nothing, instead of pointing at the original workspace's object. A reference this package did not
write (an `ESignPort` reference, say) returns `undefined` rather than throwing.

## The seam with `@fundroom/compliance`

Neither package imports the other (contract S2). `@fundroom/compliance` declares
`CertificateIssuer` structurally in `src/service/certificates.ts`; this package implements that
shape; the composition root wires them. `issuer.test.ts` keeps a verbatim copy of the declared
interface and assigns the implementation to it, so `pnpm --filter @fundroom/clickwrap typecheck`
fails the moment the two halves drift.

There is no `ESignPort` and that is deliberate. Click-wrap is synchronous and in-process; vendor
e-sign (R12, Phase 3) is asynchronous envelopes with webhooks and status polling. A port shaped
around the first would be the wrong shape for the second, and a wrong abstraction with one
implementation is worse than none.

### `CertificateIssuerDeps.facts`

`IssueCertificateInput` is exactly what compliance declares — flat, mirroring what
`AcceptanceService.accept()` has in hand. It deliberately does **not** carry the workspace's name
and host, the signer's email digest, or the signer's display name, and the frozen
`CertificateDocument` needs all four. None of them are things the compliance service knows: the
host is a per-request tenancy fact, and the rest live on `core.workspace` / `core.membership`,
which this package must not query (only `repos/` may touch drizzle). They arrive through
`CertificateIssuerDeps.facts`, a resolver the composition root supplies — which is the one place
that knows all four.

## Not done here

- **Serving the bytes.** The download route, its `x-requires` entry and the authz-matrix row are
  work package E.
- **The acceptance register export** and re-acceptance on version change — those live in
  `@fundroom/compliance`; re-acceptance falls out of the gate stamp moving (contract D4) and
  needs nothing from this package.
- **External anchoring** (RFC 3161, S3 Object Lock). `audit.anchor` exists and stays empty.
- **`electronic_records` consent** — see above; it needs a schema change.
- **NFC normalisation of names.** `canonicalize` does not normalise Unicode. Two visually
  identical names in different normal forms hash differently, which is the correct behaviour for a
  hash over bytes that were actually shown, but it means a digest is a digest of *these bytes*,
  not of *this name*.
