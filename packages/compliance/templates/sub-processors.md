---
id: sub-processors
version: 2
title: Sub-processor list
audience: public
jurisdiction: [global]
requiresAcceptance: false
mergeFields: [company.contactEmail, subProcessors, dataLocation, effectiveDate, version]
---

> **TEMPLATE — NOT LEGAL ADVICE. HAVE COUNSEL REVIEW BEFORE USE.**
> This document is an engineering starting point generated from public sources. It has not been
> reviewed by securities or privacy counsel, it is not tailored to your facts, and using it
> unchanged may be wrong or harmful in your jurisdiction. Replace every `[BRACKETED]` instruction
> and delete this banner only after your lawyer has signed off.

# Sub-processors

**Effective date:** {{effectiveDate}}  ·  **Version:** {{version}}

This list is **generated from the adapters the operator of this deployment has configured** — its email
provider or mail relay, its object storage when a third party holds it, its custom-domain edge network, and
its billing and sanctions-screening providers. It does not list the database or backups (their location is in
the table below), and it does not list services an individual company connected to its own workspace
(e-signature, accreditation verification, accounting or chat tools): each company lists those in its own
privacy notice. It is not a hand-maintained marketing page, and it changes when the deployment changes.

A "sub-processor" here means a third party that processes personal data on behalf of the operator of this
portal. A service that stores nothing and sees nothing — a library, a CDN serving only static assets with no
logging of end users — is not one, but if you are unsure, list it.

## Current sub-processors

{{subProcessors}}

If that table is empty, the software could not identify a third party in this deployment's configuration:
it runs with local or operator-run object storage and an operator-run mail relay. Anything the operator uses
that the software cannot see (a hosting provider, a relay run by someone else) is for the operator to add. That is a legitimate configuration, and it is worth saying so explicitly rather than
leaving a blank page.

## Where data is stored

{{dataLocation}}

## What each entry should tell a reader

| Column | Meaning |
|---|---|
| Provider | Legal name of the company |
| Purpose | What it does for the portal, in plain words |
| Data processed | The categories it can see |
| Location | Where the processing happens |
| Transfer mechanism | Adequacy, standard contractual clauses plus the UK addendum, or not applicable |

## Change notification

We will publish a change to this list, and notify the affected customers' administrative contacts by email,
**at least 30 days before** a new sub-processor starts processing personal data, or before an existing one is
replaced. A customer may object on reasonable data-protection grounds within that period; the objection
process and its consequences are set out in the data processing agreement.

Emergency substitutions — where a provider fails or must be replaced for security reasons — may take effect
sooner, and we will notify as soon as we can and explain why.

To subscribe to changes, or to ask about a particular provider, email {{company.contactEmail}}.
