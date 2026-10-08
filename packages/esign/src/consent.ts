import { createHash } from "node:crypto";

/*
 * Consent to do business electronically (US ESIGN Act §101(c), E3.5 contract §4).
 *
 * Before an e-sign NDA envelope is created for a member, the member ticks a checkbox under this
 * disclosure (the portal shows a translated copy). What is recorded is an attestation of kind
 * `esign-consent:v1` with `{ disclosureVersion, disclosureSha256 }`, where the digest is of the
 * **English canonical text below** — not of whatever translation was on screen. That is a
 * deliberate deviation for counsel to review (ADR-0053): one canonical text keeps the evidence
 * comparable across locales, and the translation is a courtesy rendering of it.
 *
 * Changing a single character of the text changes the digest; bump `ESIGN_DISCLOSURE_VERSION`
 * whenever you do, so a stored attestation always names the text it was given for.
 */

export const ESIGN_DISCLOSURE_VERSION = 1;
export const ESIGN_CONSENT_KIND = `esign-consent:v${ESIGN_DISCLOSURE_VERSION}`;

export const ESIGN_DISCLOSURE_TEXT = [
  "Consent to use electronic records and signatures",
  "",
  "By ticking the box you agree that the documents we ask you to sign may be provided to you " +
    "electronically and that you will sign them electronically, through the e-signature service " +
    "named on the button. Your electronic signature has the same legal effect as a handwritten one.",
  "",
  "You may ask for a paper copy of any document you sign, free of charge, by contacting the " +
    "company that invited you. You may withdraw this consent at any time by telling them; " +
    "withdrawing does not affect documents you have already signed, and you will then be offered " +
    "another way to sign.",
  "",
  "To view and keep the documents you need a current web browser, an email address, and software " +
    "that opens PDF files. You can download a copy of every document you sign from the portal.",
].join("\n");

export const ESIGN_DISCLOSURE_SHA256 = createHash("sha256")
  .update(ESIGN_DISCLOSURE_TEXT, "utf8")
  .digest("hex");

/** What the consent attestation stores (`attestation.data`, schema version 1). */
export interface ESignConsentData {
  readonly disclosureVersion: number;
  readonly disclosureSha256: string;
}

export function consentData(): ESignConsentData {
  return { disclosureVersion: ESIGN_DISCLOSURE_VERSION, disclosureSha256: ESIGN_DISCLOSURE_SHA256 };
}
