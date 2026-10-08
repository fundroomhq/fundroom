---
id: retention-schedule
version: 1
title: Records retention schedule
audience: tenant-admin
jurisdiction: [global]
requiresAcceptance: false
mergeFields: [company.legalName, company.contactEmail, retention, effectiveDate, version]
---

> **TEMPLATE — NOT LEGAL ADVICE. HAVE COUNSEL REVIEW BEFORE USE.**
> This document is an engineering starting point generated from public sources. It has not been
> reviewed by securities or privacy counsel, it is not tailored to your facts, and using it
> unchanged may be wrong or harmful in your jurisdiction. Replace every `[BRACKETED]` instruction
> and delete this banner only after your lawyer has signed off.

# Records retention schedule

**Effective date:** {{effectiveDate}}  ·  **Version:** {{version}}

This is {{company.legalName}}'s default retention schedule for the investor portal. It exists because two
duties pull in opposite directions: data protection law says keep personal data no longer than you need it,
and securities practice says keep the evidence of an offering long enough to defend it. The compromise below
resolves that per record class.

The live, configured values for this deployment are:

{{retention}}

Where the configured values and the defaults below disagree, the configured values are what the system
actually does — and somebody should be able to explain why they differ.

## Defaults

| Record class | What it covers | Default retention | Why |
|---|---|---|---|
| Offering materials | Round and terms pages, decks, data-room documents and every published version, investor updates | **6 years after the offering closes** or the security is retired, whichever is later | The core rule below |
| Acceptances and certifications | Privacy notice and confidentiality acceptances, accreditation self-certifications, e-sign certificates, the document hashes they refer to | **6 years after the offering closes**, and at least 6 years after the acceptance | Evidence that the right person agreed to the right version |
| Verification evidence | Third-party verification results, professional letters, documents uploaded as proof | **6 years after the offering closes**; uploaded source documents deleted **90 days after the verification decision** | Keep the decision and its provenance; do not keep tax returns |
| Access and audit logs | Sign-ins, permission decisions, document views and downloads, admin configuration changes | **6 years** for entries that evidence disclosure of offering material; **[BRACKETED: 1-2] years** for routine security entries | Answers "who saw what, when" |
| Engagement analytics | Dwell time, section reads, email opens and clicks | **[BRACKETED: 13 / 25] months**, then aggregated | Not offering evidence; the shortest period that still supports a year-on-year comparison |
| Email delivery records | Sent, delivered, bounced, complained, unsubscribed | **[BRACKETED: 2] years**; unsubscribe records kept **indefinitely** | Deliverability and proof of consent; an unsubscribe must outlive everything or you will email the person again |
| Account and identity records | Membership, roles, group membership, relationship provenance | **6 years after access ends** | Part of the offering record |
| Backups | Encrypted snapshots of all of the above | **[BRACKETED: 30-35] days**, on a rolling cycle | Recovery, not archive |
| Support correspondence | Tickets and emails about the portal | **[BRACKETED: 2] years** | Ordinary business need |

## The six-year rule

There is no single statutory retention period for a private issuer's offering records. The default above
comes from practice: US federal claims under the anti-fraud rules are subject to a repose period measured in
years, most state periods are shorter, and counsel commonly advise keeping offering materials, investor
acknowledgements, verification evidence and access logs for **at least six years** after the offering closes.
Six years is the floor, not a target — for a security that remains outstanding, keeping the records for its
life plus the limitation period is the safer reading. Confirm the number with your counsel and record their
answer here: **[BRACKETED: COUNSEL'S RECOMMENDED PERIOD AND DATE OF ADVICE]**.

## Legal hold

A legal hold overrides every period in this schedule.

- A hold is placed when litigation, a regulatory inquiry, a dispute with an investor, or an investigation is
  reasonably anticipated — not when it arrives.
- While a hold is in force on a record, the record cannot be deleted, purged, or overwritten. That includes
  deletion requested by a data subject under a right to erasure: we will preserve the record, tell the person
  why, and act on the request once the hold lifts.
- A hold is recorded with who placed it, when, its scope, and the reason. Lifting it is recorded the same way.
- Holds are reviewed at least **[BRACKETED: every 6 months]** so that they do not become a way of keeping
  everything forever.

## Deletion mechanics

Deletion is a two-stage process: a logical delete that removes the record from every view immediately, then a
scheduled hard delete once the retention period and any hold have expired. Backups are not selectively
edited; they age out on their own cycle, and restoring one does not resurrect deleted records, because the
deletion is replayed.

Where a record must be kept but the person need not be identifiable, we pseudonymise rather than delete: the
audit log keeps its entry and its hash chain, with the subject key replaced. That preserves the integrity of
the evidence while honouring the substance of an erasure request.

Questions about this schedule: {{company.contactEmail}}.
