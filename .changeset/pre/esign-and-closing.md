---
"@fundroom/esign": minor
"@fundroom/esign-documenso": minor
"@fundroom/esign-docuseal": minor
"@fundroom/esign-docusign": minor
"@fundroom/esign-dropbox-sign": minor
"@fundroom/ports": minor
"@fundroom/config": minor
"@fundroom/db": minor
"@fundroom/storage": minor
"@fundroom/crypto": patch
"@fundroom/audit": minor
"@fundroom/search": patch
"@fundroom/authz": minor
"@fundroom/identity": patch
"@fundroom/compliance": minor
"@fundroom/clickwrap": patch
"@fundroom/portability": minor
"@fundroom/domain": minor
"@fundroom/contracts": minor
"@fundroom/module-kit": minor
"@fundroom/module-round": minor
"@fundroom/module-data-room": minor
"@fundroom/module-notify": minor
"@fundroom/sdk": minor
"@fundroom/server": minor
"@fundroom/web": minor
---

Add e-signature, the round closing workflow and signed-document vaulting.

**E-signature.** A workspace connects one vendor under `/admin/esign`: Documenso or DocuSeal (cloud or self-hosted), DocuSign or Dropbox Sign, reached over their APIs only. Credentials are sealed per workspace, verified with the vendor before they are stored, and never shown again. Vendor callbacks arrive at `/webhooks/esign/{connectionId}`. They are authenticated per vendor and treated only as a wake-up: the server then asks the vendor for the envelope's status. A five-minute sweep backs them up. Signed PDFs (and the vendor's certificate where separate) are size-capped, scanned and stored encrypted.

**E-sign NDA.** A legal document's ceremony can be click-wrap (default) or e-signature (NDA documents only). Investors record ESIGN consent to electronic records, sign in the vendor's UI (opened top-level, never inside an embed frame), and the completed envelope writes the same acceptance a click-wrap does, so the portal gate and NDA gates on folders and documents open as before.

**Closing workflow.** A round's Closing tab sends subscription documents from a vendor template, prefilled from the round's terms, and tracks each commitment through documents sent, signed, wired and confirmed, with a summary of counts and amounts. Investors see their own checklist and download their signed copy.

**Vaulting.** Completed envelopes are filed into the data room under legal hold, in staff-only folders that no investor, delegate or share-link grant can open.

**Fixes found along the way.**
- An NDA or accreditation gate on a sub-folder or document now applies to members granted an ancestor folder (it previously did not).
- The workspace row is now always locked before the audit chain, removing a class of deadlocks between settings, acceptance, group and document writers.
- The first concurrent use of a new encryption-key purpose no longer fails with an aborted transaction.

**Configuration.** New: `ESIGN_DRIVERS`, `ESIGN_ALLOW_PRIVATE_HOSTS`, `ESIGN_MAX_ARTIFACT_BYTES`. Migrations: core `0019_esign`, round `0004_closing`, data-room `0004_vault` and `0005_staff_only`, notify `0010_esign_event_types`. Operator guide in `docs/esign/`.
