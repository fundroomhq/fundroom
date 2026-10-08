import { z } from "zod";

/*
 * Accreditation self-certification (E2.3, contract D5, design/04 §1.5, design/05:173).
 *
 * Self-certification only. E2.5 owns the vendor path — the `verification` record and
 * `AccreditationVerificationPort` — and the difference is not a detail: under Rule 506(c) an
 * issuer must take *reasonable steps to verify* accredited status, which needs evidence beyond
 * the investor's word. The shipped questionnaire says so in its own second paragraph. What this
 * file records is what the investor told us, dated, with the version of the form they were shown.
 *
 * The categories are **data, not a code enum** (design/04 §1.5). That is a deliberate constraint
 * and the reason is jurisdictional: Rule 501(a)'s list has been amended twice in five years, the
 * UK's thresholds moved in 2024, and a deployment in a jurisdiction we have not thought about
 * needs its own list. A `type AccreditationCategory = "income" | …` would put a securities
 * regulator's vocabulary in a TypeScript union, where changing it is a migration and a release.
 * Here a category is an id, a section and a label, the answers are ids, and an unknown id from a
 * tenant's own edited questionnaire round-trips rather than failing to parse.
 */

/** Which regime's section a category belongs to. Free text for the same reason as the ids. */
export const ACCREDITATION_SECTIONS = ["us", "uk", "eu", "ca"] as const;
export type AccreditationSection = (typeof ACCREDITATION_SECTIONS)[number];

export interface AccreditationCategory {
  /** Stable id stored in the attestation's `data`; never renamed once shipped. */
  readonly id: string;
  readonly section: AccreditationSection;
  /** Individual or entity — the questionnaire groups on it. */
  readonly subject: "individual" | "entity";
  /** One line, matching the shipped template's wording closely enough to be recognisable. */
  readonly label: string;
}

/**
 * The shipped question set, version 1, mirroring
 * `templates/accreditation-self-certification.md` (template version 1).
 *
 * `QUESTIONNAIRE_VERSION` is **not** the legal document's version: the document is versioned per
 * tenant by `core.legal_document_version`, and a tenant may edit the text without changing what is
 * being asked. This number changes only when the set of answerable categories changes, so a stored
 * answer can always be read back against the list it was collected under.
 */
export const ACCREDITATION_QUESTIONNAIRE_VERSION = 1;

export const ACCREDITATION_CATEGORIES: readonly AccreditationCategory[] = Object.freeze([
  // United States — Regulation D, Rule 501(a).
  { id: "us.income", section: "us", subject: "individual", label: "Income test" },
  { id: "us.net_worth", section: "us", subject: "individual", label: "Net worth test" },
  {
    id: "us.licensed_professional",
    section: "us",
    subject: "individual",
    label: "Licensed professional (Series 7, 65 or 82)",
  },
  {
    id: "us.knowledgeable_employee",
    section: "us",
    subject: "individual",
    label: "Knowledgeable employee of the issuing private fund",
  },
  {
    id: "us.insider",
    section: "us",
    subject: "individual",
    label: "Director, executive officer or general partner",
  },
  {
    id: "us.family_client",
    section: "us",
    subject: "individual",
    label: "Family client of a qualifying family office",
  },
  {
    id: "us.entity_assets",
    section: "us",
    subject: "entity",
    label: "Entity with total assets over US$5,000,000",
  },
  {
    id: "us.entity_all_accredited",
    section: "us",
    subject: "entity",
    label: "Entity whose every equity owner is accredited",
  },
  {
    id: "us.entity_institutional",
    section: "us",
    subject: "entity",
    label: "Institutional entity (bank, broker-dealer, insurer, adviser, …)",
  },
  { id: "us.entity_plan", section: "us", subject: "entity", label: "Employee benefit plan" },
  {
    id: "us.entity_investments",
    section: "us",
    subject: "entity",
    label: "Entity owning investments over US$5,000,000",
  },
  {
    id: "us.entity_family_office",
    section: "us",
    subject: "entity",
    label: "Family office with AUM over US$5,000,000",
  },
  // United Kingdom — the financial promotion regime.
  {
    id: "uk.high_net_worth",
    section: "uk",
    subject: "individual",
    label: "Certified high net worth individual",
  },
  {
    id: "uk.self_certified_sophisticated",
    section: "uk",
    subject: "individual",
    label: "Self-certified sophisticated investor",
  },
  {
    id: "uk.certified_sophisticated",
    section: "uk",
    subject: "individual",
    label: "Certified sophisticated investor",
  },
  {
    id: "uk.professional_client",
    section: "uk",
    subject: "individual",
    label: "Professional client or eligible counterparty",
  },
  // European Union / EEA — MiFID II and the Prospectus Regulation.
  {
    id: "eu.professional_per_se",
    section: "eu",
    subject: "entity",
    label: "Professional client per se (MiFID II Annex II §I)",
  },
  {
    id: "eu.professional_elective",
    section: "eu",
    subject: "individual",
    label: "Professional client on request (elective)",
  },
  {
    id: "eu.qualified_investor",
    section: "eu",
    subject: "individual",
    label: "Qualified investor (Prospectus Regulation)",
  },
  // Canada — National Instrument 45-106.
  { id: "ca.income", section: "ca", subject: "individual", label: "Income test" },
  {
    id: "ca.financial_assets",
    section: "ca",
    subject: "individual",
    label: "Financial assets test",
  },
  { id: "ca.net_assets", section: "ca", subject: "individual", label: "Net assets test" },
  { id: "ca.entity", section: "ca", subject: "entity", label: "Entity test" },
]);

const CATEGORY_IDS = new Set(ACCREDITATION_CATEGORIES.map((c) => c.id));

export function isAccreditationCategory(id: string): boolean {
  return CATEGORY_IDS.has(id);
}

/** A category id as stored: kebab/snake segments joined by dots, bounded. */
const CATEGORY_ID_RE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}$/u;

/**
 * The answers a signer gave. `categories` may be empty — "none of these apply" is a real answer
 * and one the 506(b) path acts on — and ids outside the shipped set are accepted so a tenant whose
 * counsel added a category to their own copy of the form does not lose the answer.
 */
export const AccreditationAnswersSchema = z
  .object({
    categories: z.array(z.string().regex(CATEGORY_ID_RE)).max(40),
    /** Which section of the form was completed. */
    section: z.enum(ACCREDITATION_SECTIONS).optional(),
    /** The free-text sophistication statement 506(b) asks of a non-accredited purchaser. */
    note: z.string().max(4000).optional(),
    /** Version of the question set the answers were collected under. */
    questionnaireVersion: z.number().int().min(1).optional(),
  })
  .strict();

export type AccreditationAnswers = z.output<typeof AccreditationAnswersSchema>;

/** How long a self-certification stands before it must be given again (`design/05:173`). */
export const ACCREDITATION_VALID_MONTHS = 12;

/**
 * `signedAt` plus twelve calendar months, clamped so 29 February + 12 months is 28 February and
 * not 1 March. Calendar months rather than 365 days because the form says "12 months" and an
 * investor asked to re-certify a day early in a leap year is a support ticket about nothing.
 */
export function accreditationExpiry(signedAt: Date): Date {
  const out = new Date(signedAt.getTime());
  const day = out.getUTCDate();
  out.setUTCMonth(out.getUTCMonth() + ACCREDITATION_VALID_MONTHS);
  if (out.getUTCDate() !== day) out.setUTCDate(0);
  return out;
}

/** One attestation row to write, as data, so the two-row rule can be tested without a database. */
export interface AttestationSpec {
  readonly kind: string;
  readonly signedAt: Date;
  readonly expiresAt: Date | null;
  readonly data: Readonly<Record<string, unknown>>;
}

/**
 * The **two** rows an accreditation acceptance writes (contract D5). Do not collapse them: they
 * are different facts, and each is read by something different.
 *
 * 1. `<slug>:v<n>` — "this person agreed to *this text*". No expiry, because agreeing to a text is
 *    not a thing that expires; superseded, yes, expired, no. This is the click-wrap record, the
 *    one the certificate is issued against, and the one `pendingFor` looks for.
 * 2. `accredited` — "this person is accredited **as of this date**", carrying the category answers
 *    and expiring twelve months later. This is the row the `accredited` gate reads
 *    (`packages/authz/src/evaluate.ts`: a bare `kind === "accredited"` inside a `maxAgeDays`
 *    window), and `expires_at` is meaningful only on it.
 *
 * Collapsing them would force one row to mean both, and then either the click-wrap record expires
 * — losing evidence the tenant must keep for six years after close — or the accreditation never
 * does, which is the thing the form's own renewal clause promises will not happen.
 */
export function accreditationAttestations(input: {
  readonly stamp: string;
  readonly signedAt: Date;
  readonly answers: AccreditationAnswers;
  /** The click-wrap evidence payload, shared by both rows so either alone is self-describing. */
  readonly acceptance: Readonly<Record<string, unknown>>;
}): readonly [AttestationSpec, AttestationSpec] {
  const answers = {
    categories: [...input.answers.categories],
    ...(input.answers.section === undefined ? {} : { section: input.answers.section }),
    ...(input.answers.note === undefined ? {} : { note: input.answers.note }),
    questionnaireVersion: input.answers.questionnaireVersion ?? ACCREDITATION_QUESTIONNAIRE_VERSION,
  };
  return [
    {
      kind: input.stamp,
      signedAt: input.signedAt,
      expiresAt: null,
      data: { ...input.acceptance, accreditation: answers },
    },
    {
      kind: "accredited",
      signedAt: input.signedAt,
      expiresAt: accreditationExpiry(input.signedAt),
      data: {
        ...input.acceptance,
        accreditation: answers,
        method: "self_certified",
        validMonths: ACCREDITATION_VALID_MONTHS,
      },
    },
  ];
}
