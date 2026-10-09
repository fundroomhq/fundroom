---
"@fundroom/forensic": minor
"@fundroom/anchor-rfc3161": minor
"@fundroom/anchor-rekor": minor
"@fundroom/authz-openfga": minor
"@fundroom/render-pdfium": minor
"@fundroom/module-data-room": minor
"@fundroom/share-links": minor
"@fundroom/module-kit": minor
"@fundroom/domain": minor
"@fundroom/db": minor
"@fundroom/ports": minor
"@fundroom/config": minor
"@fundroom/contracts": minor
"@fundroom/audit": minor
"@fundroom/authz": minor
"@fundroom/portability": minor
"@fundroom/server": minor
"@fundroom/web": minor
---

Evidence and authz depth. Forensic watermarking: a per-document `forensic`
protection embeds an invisible, keyed mark unique to each recipient in every served page image, and
staff with `data-room.forensics` can test a leaked image against everyone who received that version
("Trace a leak"); downloads carry a trace code. Share-link `forceWatermark` is now enforced. External
audit anchoring: a daily RFC 6962 Merkle root over all checkpoints is time-stamped by RFC 3161 TSAs
and/or logged in Sigstore Rekor v2 (`AUDIT_ANCHOR_DRIVERS`), with per-checkpoint proofs, export
bundle v2 and `fundroom audit anchor|verify-anchor`. An optional OpenFGA engine behind the authz
port (`AUTHZ_ENGINE=openfga`, shadow or enforce; enforce can only narrow Postgres' answer). Core
migration `0026_evidence_authz`, data-room `0007_forensic`. Also fixes a Postgres rebuild bug where a
document-level rule hid capabilities inherited from its folder.
