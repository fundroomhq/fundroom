---
id: controller-checklist
version: 1
title: Self-hoster controller checklist
audience: tenant-admin
jurisdiction: [global]
requiresAcceptance: false
mergeFields: [company.legalName, company.contactEmail, company.dpoEmail, portal.url, workspace.dataRegion, subProcessors, effectiveDate, version]
---

> **TEMPLATE — NOT LEGAL ADVICE. HAVE COUNSEL REVIEW BEFORE USE.**
> This document is an engineering starting point generated from public sources. It has not been
> reviewed by securities or privacy counsel, it is not tailored to your facts, and using it
> unchanged may be wrong or harmful in your jurisdiction. Replace every `[BRACKETED]` instruction
> and delete this banner only after your lawyer has signed off.

# Controller checklist for self-hosted deployments

**Effective date:** {{effectiveDate}}  ·  **Version:** {{version}}

You are running {{portal.url}} yourself. That means there is no hosting provider to sign a data processing
agreement with, because there is no processor: **{{company.legalName}} is both the controller and the
operator.** Everything a managed host would have owed you under a DPA, you now owe your investors yourself.

This is the substitute for `dpa.md`. Work through it, record the answers somewhere durable, and revisit it
whenever you change an adapter, a region, or a retention setting.

## 1. Establish the record

- [ ] Write a **record of processing activities** (GDPR Article 30). The portal can generate a starting point
      from your configuration: data categories, purposes, recipients, retention and transfers. Review it,
      add anything you do outside the portal (your CRM, your spreadsheet of investors), and keep it current.
- [ ] Decide whether you need a **data protection officer**. Most seed-stage companies do not, but Quebec
      requires a privacy officer and some regimes require a named contact regardless. Record who is
      accountable: {{company.dpoEmail}}, failing which {{company.contactEmail}}.
- [ ] If you are outside the EU or UK but have investors there, decide whether you need an **Article 27
      representative**.

## 2. Tell people what you do

- [ ] Publish your **investor privacy notice** (`privacy-notice.md`), tailored, with a real contact address,
      and require acceptance before first access.
- [ ] Publish your **cookie notice** (`cookie-notice.md`) and set the analytics mode deliberately. If you
      have EU investors and you leave engagement analytics on without consent, that is the most likely thing
      on this list to get you a complaint.
- [ ] Publish a **sub-processor list** (`sub-processors.md`) and keep it accurate.

## 3. Own your vendors

Every adapter you configure is a sub-processor you chose. For each one in:

{{subProcessors}}

- [ ] Sign **their** data processing agreement (your email provider, object storage, verification service,
      e-sign vendor, error tracker, and your hosting or cloud provider).
- [ ] Check where they process data, and whether that is compatible with {{workspace.dataRegion}} and with
      what your privacy notice says.
- [ ] Put the transfer mechanism in place where data leaves the EEA or the UK: standard contractual clauses
      plus the UK addendum, and a transfer risk assessment.
- [ ] Tell your investors before you add or swap one, if the change is material.

## 4. Configure retention and holds

- [ ] Set the retention policy per record class; the defaults are in `retention-schedule.md`.
- [ ] Confirm you understand the **six-year floor** on offering records, acceptances, certifications,
      verification evidence and the access logs that evidence disclosure.
- [ ] Know how to place and lift a **legal hold**, and that a hold overrides an erasure request.
- [ ] Check that your backups expire on a schedule you can describe, and that restoring one does not
      resurrect data you deleted on request.

## 5. Handle requests and incidents

- [ ] Write down how a data subject reaches you, who triages, and what the deadline is (one month in the
      UK and EU, 45 days in most US states). Test it once with a dummy request.
- [ ] Know how to export, rectify, and erase a subject in the portal, and what erasure does to audit records
      (it pseudonymises the subject key rather than breaking the log).
- [ ] Keep a **breach register**: date discovered, what happened, categories and numbers affected, decision
      on notification and the reasoning, and what you changed afterwards. You have 72 hours to notify a
      supervisory authority under the GDPR where the breach is notifiable.
- [ ] Decide in advance who declares an incident and who talks to investors.

## 6. Secure the deployment

You inherit the product's controls but you operate them. At minimum:

- [ ] TLS everywhere, with a real certificate.
- [ ] Secrets in a secret store or file-based secrets, never in a shell history or a committed `.env`.
- [ ] Multi-factor authentication on every administrator.
- [ ] Backups taken, encrypted, and **restored at least once** so you know they work.
- [ ] Patching: watch releases, and apply security updates promptly.
- [ ] Access review: check quarterly who can get into the portal and into the server, and remove what is
      stale.
- [ ] Log retention long enough to investigate something you discover late — a year is a reasonable floor.

## 7. What you cannot outsource

Nothing here makes you compliant by itself. Two things in particular are yours and only yours: deciding
**who gets in** to the portal, and deciding **what you tell them**. The software can log both decisions
faithfully; it cannot make either one for you.
