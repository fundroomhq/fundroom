---
id: dpa
version: 3
title: Data processing agreement
audience: tenant-admin
jurisdiction: [uk, eu, us]
requiresAcceptance: true
mergeFields: [company.legalName, company.address, company.contactEmail, company.dpoEmail, portal.name, host.operator, subProcessors, dataLocation, effectiveDate, version]
---

> **TEMPLATE — NOT LEGAL ADVICE. HAVE COUNSEL REVIEW BEFORE USE.**
> This document is an engineering starting point generated from public sources. It has not been
> reviewed by securities or privacy counsel, it is not tailored to your facts, and using it
> unchanged may be wrong or harmful in your jurisdiction. Replace every `[BRACKETED]` instruction
> and delete this banner only after your lawyer has signed off.

# Data processing agreement

**Effective date:** {{effectiveDate}}  ·  **Version:** {{version}}

This agreement is between **{{company.legalName}}** of {{company.address}} (the "customer", acting as
**controller**) and **{{host.operator}}** (the "operator", acting as **processor**). It forms part of the
terms of service for the hosted {{portal.name}} service and governs the operator's processing of personal
data on the customer's behalf. Where this agreement and the terms of service conflict on data protection,
this agreement wins.

If you self-host rather than using the operator's hosted service, there is no processor and this agreement
does not apply; read `controller-checklist.md` instead.

## 1. Definitions and roles

"Data protection law" means the EU GDPR, the UK GDPR and Data Protection Act 2018, applicable US state
privacy laws, and any other law applicable to the processing. "Controller", "processor", "personal data",
"processing", "data subject", "personal data breach" and "supervisory authority" have the meanings given in
the GDPR; "business", "service provider" and "sale" have the meanings given in the California Consumer
Privacy Act.

The customer is the controller of investor and staff personal data in its workspace and determines the
purposes and means of processing. The operator is the processor, and for CCPA purposes a **service
provider**: it will not sell or share personal data, will not retain, use or disclose it for any purpose
other than performing the service, will not use it for its own commercial purposes, and will not combine it
with personal data from other sources except as permitted for a service provider.

The operator is an independent controller only for its own account, billing, and security telemetry relating
to the customer's administrators, which is described in the operator's own privacy policy and is outside this
agreement.

## 2. Details of processing (Article 28(3) / Article 30)

**Subject matter and duration:** provision of the hosted investor portal, for the term of the terms of
service plus the return-and-deletion period in clause 10.

**Nature and purpose:** hosting, storage, transmission, rendering, indexing, searching, watermarking,
emailing, logging, backup and deletion of the customer's content and records, and support at the customer's
request; and, only where the customer turns AI assist on, sending extracts of that content to the AI model
the operator has configured to produce draft updates and suggested answers for the customer's staff to
review. The operator never uses the customer's data to train a model, and the software sends no training
opt-in to the AI model's provider; where that provider is a third party, its own terms govern its use of the
extracts it receives, as stated in the sub-processor list.

**Categories of data subjects:** the customer's staff and administrators; the customer's investors,
prospective investors, their delegates and advisers; anyone the customer's users name in content they upload.

**Categories of personal data:** identity and contact data; authentication and session data; access,
document-view and audit records; investor relationship metadata; accreditation and qualified-investor answers
and supporting evidence, which may include financial information; engagement analytics where enabled; email
delivery records; and whatever personal data the customer chooses to put into documents, updates and metrics.

**Special category data:** none is required by the service. The customer must not upload special category
data or government identity documents unless it has told the operator in advance and the parties have agreed
the additional measures. Identity documents uploaded as verification evidence are high-sensitivity and are
handled under clause 7.

## 3. Instructions

The operator will process personal data only on the customer's documented instructions, which comprise this
agreement, the terms of service, the configuration the customer sets in the product, and support requests.
The operator will tell the customer if, in its opinion, an instruction infringes data protection law, and may
suspend that instruction until resolved. Where the operator is required by law to process beyond
instructions, it will tell the customer first unless that law prohibits it.

## 4. Confidentiality and personnel

The operator will ensure that everyone authorised to process the customer's personal data is under a binding
duty of confidentiality that survives their engagement, is trained on data protection, and has access only to
what their role requires. Administrative access to customer data is limited, logged, and for production
support only.

## 5. Security (Article 32)

The operator will implement and maintain appropriate technical and organisational measures, taking account of
the state of the art, the costs, and the risks to data subjects. Those measures include, as a minimum:

- encryption in transit (TLS 1.2 or better) and at rest, with per-tenant data keys so that destroying a key
  renders that tenant's data unrecoverable;
- strict tenant isolation, enforced in application code and backed by database row-level security;
- role-based access control, multi-factor authentication for administrative access, and session revocation;
- an append-only, tamper-evident audit log of authentication, authorisation decisions, data access and
  configuration changes;
- vulnerability management, dependency scanning and patching on a documented cadence, secure development
  practices, code review, and signed releases with a published software bill of materials;
- backups, tested restores, and a documented business continuity and disaster recovery plan; and
- logging and alerting sufficient to detect and investigate a breach.

The operator makes no claim to any third-party certification or attestation except where it publishes one;
none is claimed in this template. **[BRACKETED: IF AND WHEN THE OPERATOR HOLDS AN INDEPENDENT ATTESTATION,
NAME IT HERE AND NOWHERE ELSE.]**

## 6. Sub-processors

The customer gives general written authorisation for the operator to engage sub-processors. The current list
for this deployment, derived from its configured adapters, is:

{{subProcessors}}

The operator will impose data protection terms on each sub-processor that are no less protective than this
agreement, and remains fully liable to the customer for its sub-processors' performance.

The operator will give the customer **at least 30 days' notice** before adding or replacing a sub-processor,
by email to the customer's administrative contact and by updating the published list. The customer may object
on reasonable data-protection grounds within that period; the parties will work in good faith to find a
solution, and if none is found the customer may terminate the affected service without penalty for the unused
remainder of any prepaid term.

## 7. Assistance to the customer

Taking into account the nature of the processing and the information available to it, the operator will
assist the customer:

- **Data subject requests.** The operator will not respond to a data subject directly except to redirect them
  to the customer. It will notify the customer of any request it receives **within 5 business days**, and
  will provide the product features (subject lookup, export, rectification, erasure with pseudonymisation of
  audit keys) that let the customer respond within its own statutory deadline. Where those features are not
  enough, the operator will give reasonable additional assistance.
- **Impact assessments and prior consultation.** The operator will provide the information the customer
  reasonably needs for a data protection impact assessment or a consultation with a supervisory authority.
- **Security and breach.** See clause 8.

## 8. Personal data breach

The operator will notify the customer **without undue delay and in any event within 48 hours** of becoming
aware of a personal data breach affecting the customer's personal data. The notification will describe, so
far as known: the nature of the breach, the categories and approximate numbers of data subjects and records,
the likely consequences, the measures taken or proposed, and a contact point. Where the information is not
all available at once, it will be provided in phases without undue further delay.

The operator will not notify supervisory authorities or data subjects on the customer's behalf unless the
customer instructs it to. The customer, as controller, owns those notifications and their deadlines
(72 hours to a supervisory authority under the GDPR; US state deadlines vary).

## 9. Audit

The operator will make available the information necessary to demonstrate compliance with Article 28, in the
form of its security documentation, its sub-processor list, and written answers to the customer's
questionnaire, **once per 12-month period** and on 30 days' notice. The customer may conduct or mandate an
on-site or technical audit where a supervisory authority requires it, or following a personal data breach
affecting the customer, subject to reasonable notice, confidentiality, scope agreed in advance, no access to
other customers' data, and the customer bearing its own costs and the operator's reasonable costs.

## 10. Return and deletion

On termination or expiry, the operator will, at the customer's election, return the customer's personal data
in a commonly used machine-readable format or delete it, and delete existing copies, within the export and
deletion windows set out in the terms of service — unless the law requires retention, or a legal hold placed
by the customer applies. Backups are deleted on their normal expiry cycle and remain protected by the
measures in clause 5 until then. The operator will certify deletion in writing on request.

## 11. Data location and international transfers

Where the customer's data is hosted, and where each part of the service keeps or sends it, is set out in the
Annex "Data location" below. Those locations are **declared by the operator**; the software that runs the
service cannot itself verify where infrastructure physically is. Sub-processors, their locations and the
transfer mechanism relied on for each are listed in clause 6.

Where the operator or a sub-processor transfers personal data out of the EEA, the UK or Switzerland to a
country without an adequacy decision, the following apply automatically and form part of this agreement:

- **EU standard contractual clauses (Commission Implementing Decision (EU) 2021/914).** **Module Two
  (controller to processor)** applies where the customer is a controller. **Module Three (processor to
  processor)** applies where the customer is itself a processor for its own controller. Clause 7 (docking) is
  included; clause 9 option 2 (general written authorisation) applies with the 30-day notice period in clause
  6; clause 11's optional redress body is not used; clause 17 governing law and clause 18 forum are those of
  **[BRACKETED: MEMBER STATE]**. Annex I is populated from clause 2 and clause 6 of this agreement; Annex II
  from clause 5.
- **UK transfers.** The UK International Data Transfer Addendum to the EU SCCs (version B1.0) applies, with
  the tables completed from this agreement; alternatively the parties may use the UK International Data
  Transfer Agreement. **[BRACKETED: PICK ONE AND SAY SO.]**
- **Switzerland.** The SCCs apply with the Swiss adaptations, the FDPIC as supervisory authority and Swiss
  law where the transfer is governed by the revised FADP.
- A transfer risk assessment is carried out and kept up to date for each such transfer, and the operator will
  share it on request.

Where the importer certifies under a framework that the exporting jurisdiction has recognised as adequate,
the parties may rely on that instead, but the clauses above remain in place as a fallback if the recognition
is suspended or annulled.

## 12. Liability and general

The limitations and exclusions of liability in the terms of service apply to this agreement, except where
data protection law prohibits it. This agreement takes effect on the effective date and continues for as long
as the operator processes the customer's personal data. It is governed by the law of the terms of service,
save that the SCCs are governed as set out in clause 11.

Contacts for data protection matters: the customer at {{company.dpoEmail}}, failing which
{{company.contactEmail}}; the operator at **[BRACKETED: OPERATOR PRIVACY CONTACT]**.

## Annex: Data location

{{dataLocation}}

"In the declared region" compares jurisdictions (for example, European Union with European Union); "Unknown"
means the operator has not declared the component's location or it varies with where a request is served.
Backups are kept wherever the operator declares. Email and backups are always listed, as "Not declared" when the
operator has not said where they are; telemetry and virus scanning appear only when the deployment uses them.
