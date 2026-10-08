---
id: nda-clickwrap
version: 1
title: Investor confidentiality agreement
audience: investor
jurisdiction: [us, uk, eu]
requiresAcceptance: true
mergeFields: [company.name, company.legalName, company.jurisdiction, company.address, company.contactEmail, portal.name, effectiveDate, version]
---

> **TEMPLATE — NOT LEGAL ADVICE. HAVE COUNSEL REVIEW BEFORE USE.**
> This document is an engineering starting point generated from public sources. It has not been
> reviewed by securities or privacy counsel, it is not tailored to your facts, and using it
> unchanged may be wrong or harmful in your jurisdiction. Replace every `[BRACKETED]` instruction
> and delete this banner only after your lawyer has signed off.

# Confidentiality agreement

**Effective date:** {{effectiveDate}}  ·  **Version:** {{version}}

Please read this before you open the data room. It is an agreement between you and
**{{company.legalName}}** ("{{company.name}}", "we", "us"). By clicking "I agree" you enter into it, and you
confirm that you are willing to do business electronically. We will record the exact version you accepted,
the time, and the account you accepted it from, and we will give you a copy.

If you are accepting on behalf of a firm — a fund, a family office, an employer — you confirm you have
authority to bind it, and "you" in this agreement means both you and that firm.

## 1. What is confidential

"Confidential information" means any non-public information about {{company.name}} that we make available to
you through {{portal.name}} or otherwise in connection with a possible investment, in any form and whether or
not marked confidential. It includes our financial information and projections, metrics, cap table and
ownership information, round terms, business and product plans, technology, source code, customer and
supplier information, employee and hiring information, board and investor materials, and the fact and
contents of our discussions with you.

It also includes the fact that we are considering or conducting a financing, and any terms of it.

It does not include information that:

1. is or becomes public other than through your act or omission, or that of someone you gave it to;
2. you can show you already knew, free of any duty of confidence, before we disclosed it;
3. you lawfully receive from a third party who is free to disclose it; or
4. you independently developed without using or referring to our confidential information.

## 2. Permitted purpose

You may use confidential information for one purpose only: **evaluating whether to make, and negotiating,
a possible investment in {{company.name}}**. That is the "permitted purpose".

You must not use it for anything else. In particular, and without limiting that: not to compete with us, not
to solicit our customers, suppliers or employees, not to inform an investment in or the operation of another
company, not to trade in any security, and not to train a machine-learning model. Nothing here gives you any
obligation to invest, or us any obligation to offer you the chance.

## 3. No disclosure

You will keep confidential information confidential, and protect it with at least the care you use for your
own confidential information, and never less than reasonable care.

You may share it only with your **permitted recipients**: your partners, employees, professional advisers and
prospective co-investors who need it for the permitted purpose, and only where you have told them it is
confidential and they are bound — by contract, by professional duty, or by this agreement's terms passed on
to them — to at least the same obligations. **[BRACKETED: DECIDE WHETHER PROSPECTIVE CO-INVESTORS SHOULD BE
PERMITTED RECIPIENTS AT ALL, OR ONLY WITH YOUR PRIOR WRITTEN CONSENT.]** You remain responsible for what your
permitted recipients do with it as if you had done it yourself.

You will not copy, download, screenshot, forward, or re-host confidential information except as reasonably
necessary for the permitted purpose. Material in the data room may be watermarked with your identity; you
must not remove or obscure a watermark. Your access is personal to you: do not share your sign-in, and do not
give anyone else access through your account. If you need a colleague to have access, ask us and we will
invite them.

## 4. Compelled disclosure

If law, regulation, a court, or a regulator with jurisdiction over you requires you to disclose confidential
information, you may — but, to the extent you lawfully can, you will first give us prompt written notice so
that we can seek protection, you will disclose only what you are required to disclose, and you will use
reasonable efforts to have it treated confidentially. Where you are subject to routine regulatory
examination that does not target us specifically, no notice is required.

## 5. No licence, no representations, no obligation

Confidential information stays ours. Nothing in this agreement transfers or licenses any intellectual
property, or any right beyond the permitted purpose.

We make **no representation or warranty** as to the accuracy or completeness of any confidential information,
and we have no duty to update it. You will rely only on the representations and warranties, if any, in a
signed definitive agreement between us, and on your own investigation. Nothing here is an offer to sell or a
solicitation of an offer to buy any security; any offering will be made only through definitive documents.

Neither party is obliged to proceed with, or continue, any discussions. Either may stop at any time, for any
reason, without liability under this agreement.

## 6. Term, return and destruction

This agreement takes effect when you accept it. Your obligations continue for **[BRACKETED: THREE / FIVE]
years** from that date, except that obligations relating to trade secrets continue for as long as the
information remains a trade secret under applicable law.

On our written request, or when you decide not to invest, you will stop using confidential information and
will return or destroy it, including copies and extracts, and confirm you have done so. You may keep (a) one
archival copy required by law, regulation or your bona fide internal compliance policy, and (b) copies in
routine backups you do not selectively delete — in each case subject to this agreement's confidentiality
obligations for as long as you keep them.

Revoking your portal access does not end these obligations. Sections 1 to 5, this section, and sections 7 and
8 survive.

## 7. Remedies

Money may not be an adequate remedy for a breach of this agreement, and we may seek injunctive or other
equitable relief in addition to any other remedy, without needing to prove actual damage or to post a bond,
to the extent the court allows.

Failure to enforce a term is not a waiver of it. If a term is held unenforceable, the rest survives and the
court should give the unenforceable term the narrowest reading that makes it enforceable.

## 8. Governing law and jurisdiction

This agreement is governed by the laws of **[BRACKETED: GOVERNING LAW — TYPICALLY THE COMPANY'S HOME
JURISDICTION, {{company.jurisdiction}}]**, without regard to its conflict-of-laws rules, and the courts of
**[BRACKETED: EXCLUSIVE FORUM]** have exclusive jurisdiction, save that either party may seek injunctive
relief in any court of competent jurisdiction.

This is the entire agreement between us on confidentiality and replaces any earlier understanding on the same
subject. If we change it, we will ask you to accept the new version before you continue; your earlier
acceptance stays on record and continues to govern what you received under it.

Questions: {{company.contactEmail}}, {{company.address}}.

## Jurisdiction variants

The wording above is drafted to work in all three markets, with these deltas for counsel to consider.

**United States.** The default drafting above is US-shaped: equitable relief without proof of damage,
"trade secret" carve-out to the term, and an exclusive forum clause. Consider adding a notice under the
Defend Trade Secrets Act immunity provision if you want its fee-shifting benefits; consider whether a
non-solicitation of employees is enforceable in the relevant state (California is hostile to restraints);
and confirm that the click-wrap presentation gives conspicuous notice and requires an affirmative act,
which is what the case law turns on.

**United Kingdom.** "Confidential information" may need a broader equitable-duty framing, since English law
protects confidence outside contract. Equitable relief is a matter for the court's discretion — soften "we
may seek" rather than asserting entitlement. Exclude the Contracts (Rights of Third Parties) Act 1999 unless
you intend permitted recipients to have rights. Where the investor is a natural person and you are relying on
a financial promotion exemption, remember this agreement is not a substitute for the investor statement
required by that exemption. English law and the courts of England and Wales are the usual choices.

**European Union.** Trade-secret protection is harmonised by the Trade Secrets Directive as implemented
locally, and its definition requires that you took reasonable steps to keep the information secret — the
portal's access controls and this agreement are part of that evidence, so say so. Some Member States limit
penalty-style remedies and require clear, specific drafting for non-compete and non-solicit provisions.
Check local formality rules where the signer is a consumer rather than a professional, and confirm that a
simple electronic signature is acceptable for this instrument in the relevant Member State — it usually is
for a commercial confidentiality agreement.
