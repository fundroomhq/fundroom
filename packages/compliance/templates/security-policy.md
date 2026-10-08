---
id: security-policy
version: 1
title: Security policy and responsible disclosure
audience: public
jurisdiction: [global]
requiresAcceptance: false
mergeFields: [portal.url, effectiveDate, version]
---

> **TEMPLATE — NOT LEGAL ADVICE. HAVE COUNSEL REVIEW BEFORE USE.**
> This document is an engineering starting point generated from public sources. It has not been
> reviewed by securities or privacy counsel, it is not tailored to your facts, and using it
> unchanged may be wrong or harmful in your jurisdiction. Replace every `[BRACKETED]` instruction
> and delete this banner only after your lawyer has signed off.

# Security policy and responsible disclosure

**Effective date:** {{effectiveDate}}  ·  **Version:** {{version}}

We would rather hear about a vulnerability from you than from an attacker. If you have found one in
{{portal.url}}, please tell us.

## How to report

- Email **[BRACKETED: security@yourdomain]**, or use the form at **[BRACKETED: URL]**.
- PGP key: **[BRACKETED: FINGERPRINT AND KEY URL, OR DELETE THIS LINE]**.
- Include: what you found, where, how to reproduce it, what an attacker could do with it, and how we can
  reach you. A short proof of concept helps more than a scanner report.
- Please do not file it as a public issue or post it publicly before we have had a chance to fix it.

## Response targets

| Stage | Target |
|---|---|
| Acknowledge your report | 2 business days |
| Initial assessment and severity | 5 business days |
| Status update | Every 10 business days until closed |
| Fix for a critical issue | 30 days, or a documented mitigation |
| Coordinated public disclosure | 90 days from the report, or sooner by agreement |

We will credit you when we publish, unless you prefer otherwise. **[BRACKETED: WE DO / DO NOT PAY BOUNTIES.
IF YOU DO, LINK THE SCOPE AND REWARD TABLE.]**

## Scope

In scope: {{portal.url}} and its API, the published application images, and the source repository.

Out of scope: third-party services we do not run; deployments run by other people (report those to their
operator); findings that require a compromised device or a privileged insider; missing best-practice headers
with no demonstrated impact; rate-limit, spam and social-engineering reports; and results from automated
scanners with no verified exploitability.

## Rules of engagement, and safe harbour

If you act in good faith and follow these rules, we will treat your research as authorised. We will not bring
or support a legal claim against you under computer-misuse, anti-circumvention or contract law, and if a
third party brings one, we will make clear that your activity was authorised.

Please:

- Use only your own test account and your own data. **Do not access, modify, download or retain anyone
  else's data, and stop as soon as you can tell that you could.**
- Do not degrade the service: no denial-of-service, no automated load testing, no spam.
- Do not use social engineering, phishing, or physical intrusion against anyone.
- Give us reasonable time to fix an issue before you discuss it publicly.
- Comply with the law. Safe harbour is our promise, not an exemption from anyone else's.

If you are unsure whether something is in scope, ask first.

## For self-hosted deployments

If you run your own installation, you are its operator. Security updates are published with each release;
subscribe to release notifications and apply them. Report vulnerabilities **in the software** to us; report
problems **with a specific deployment** to whoever runs it.

## security.txt

Serve this at `/.well-known/security.txt`:

```
Contact: mailto:[BRACKETED: security@yourdomain]
Expires: [BRACKETED: ISO 8601 DATE, LESS THAN A YEAR AWAY]
Policy: {{portal.url}}/security
Preferred-Languages: en
Canonical: {{portal.url}}/.well-known/security.txt
```
