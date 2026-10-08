---
id: cookie-notice
version: 1
title: Cookie and tracking notice
audience: investor
jurisdiction: [us, uk, eu]
requiresAcceptance: false
mergeFields: [company.name, company.contactEmail, portal.url, portal.name, effectiveDate, version]
---

> **TEMPLATE — NOT LEGAL ADVICE. HAVE COUNSEL REVIEW BEFORE USE.**
> This document is an engineering starting point generated from public sources. It has not been
> reviewed by securities or privacy counsel, it is not tailored to your facts, and using it
> unchanged may be wrong or harmful in your jurisdiction. Replace every `[BRACKETED]` instruction
> and delete this banner only after your lawyer has signed off.

# Cookie and tracking notice

**Effective date:** {{effectiveDate}}  ·  **Version:** {{version}}

This notice explains what {{company.name}} stores on your device when you use the investor portal at
{{portal.url}}, and what choices you have. It sits alongside the investor privacy notice, which explains what
we do with the data itself.

## Strictly necessary

These cannot be turned off, because without them the portal cannot know that you are signed in or protect you
from cross-site request forgery. They are set by the portal itself, they are first-party, and they carry no
advertising identifier.

| Name | Purpose | Lifetime |
|---|---|---|
| Session cookie | Keeps you signed in | Session, or up to **[BRACKETED: 30] days** if you chose to stay signed in |
| CSRF token | Protects form and API submissions | Session |
| Preference storage | Remembers your language and theme | 1 year |

We also keep server-side access logs (time, IP address, route, document version). These are not stored on
your device and are not cookies; they are described in the privacy notice under access logging.

## Analytics and engagement measurement

If the portal's analytics mode is set to "engagement", we additionally measure how long a page or document
section was open, how far you read, and whether an emailed update was opened or its links followed. This is
not strictly necessary, so it is subject to your choice:

- **European Union / EEA:** off unless you opt in. No engagement measurement, no email open pixel, and no
  storage on your device for analytics happens before you say yes.
- **United Kingdom:** on by default where permitted, with a clear and easy opt-out shown to you on first
  visit and available at any time in your account settings.
- **United States and elsewhere:** on by default with this notice. You may opt out at any time, and we honour
  the **Global Privacy Control** browser signal automatically as an opt-out.

Whatever the region, you can change your choice at any time from the privacy controls in your portal account,
or by emailing {{company.contactEmail}}. Turning analytics off does not affect your access to anything.

We do not use third-party advertising cookies, we do not load advertising or social media pixels, and we do
not sell or share personal data for cross-context behavioural advertising.

## Email

Emails we send you about access, security and account matters carry no tracking. Investor updates may carry
an open pixel and link tracking, but only where the analytics mode is "engagement" **and** your consent state
allows it. Where it does not, the message is sent without either.

## When the portal is embedded in another website

Where {{portal.name}} appears inside a page on another website, the portal runs in its own frame on its own
origin. In that mode:

- the portal sets no third-party cookies and does not read the host page's storage;
- the host website's consent management platform is authoritative, and the portal takes its analytics consent
  from that platform through the embed API; and
- **the portal does not show a cookie banner of its own.** Showing two banners on one page is worse for you
  and confuses the record of what you agreed to, so we defer. If the host site has no consent manager, the
  company operating the portal may enable our banner explicitly.

## Managing cookies in your browser

You can block or delete cookies in your browser settings. Blocking the strictly necessary cookies will stop
you signing in. Deleting them signs you out and resets your saved analytics choice, which will then be asked
again where the region requires it.

Questions: {{company.contactEmail}}.
