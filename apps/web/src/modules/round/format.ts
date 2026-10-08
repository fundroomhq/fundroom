import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";

/*
 * How a round reads on screen (E2.5 §W).
 *
 * Every enum the server sends has a label here rather than in a component, and every one of
 * them ends in `default: return raw`: a status this build has never heard of is shown as the
 * server spelled it, which is ugly and honest, rather than as an empty string or as the wrong
 * neighbouring case.
 *
 * `formatMoney` is the only place in the module that makes a number out of an amount, and it
 * does so **only to print it**. `numeric(20, 6)` does not survive a round trip through a
 * double (contract §5), so nothing here — and nothing in the module — ever compares two
 * amounts by parsing them.
 */

export function formatMoney(amount: string | null | undefined, currency: string): string {
  if (typeof amount !== "string" || amount.trim() === "") return m.round_no_amount();
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  const locale = getLocale();
  const cents = Math.abs(n % 1) > 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: cents ? 2 : 0,
      maximumFractionDigits: cents ? 2 : 0,
    }).format(n);
  } catch {
    // An unknown ISO code throws rather than guessing. The figure still has to be readable.
    return `${new Intl.NumberFormat(locale).format(n)} ${currency}`;
  }
}

/** A percentage the server already rounded to two places: shown as it arrived, with a `%`. */
export function formatPercent(percent: string | null | undefined): string {
  if (typeof percent !== "string" || percent.trim() === "") return m.round_no_amount();
  const n = Number(percent);
  if (!Number.isFinite(n)) return percent;
  return `${new Intl.NumberFormat(getLocale(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n)}%`;
}

/** A rate somebody typed into the terms form: "20", "7.5", "0". Trailing zeros are not kept. */
export function formatRate(percent: string | null | undefined): string {
  if (typeof percent !== "string" || percent.trim() === "") return m.round_no_amount();
  const n = Number(percent);
  if (!Number.isFinite(n)) return percent;
  return `${new Intl.NumberFormat(getLocale(), {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n)}%`;
}

export function instrumentLabel(kind: string): string {
  switch (kind) {
    case "safe":
      return m.round_instrument_safe();
    case "note":
      return m.round_instrument_note();
    case "priced":
      return m.round_instrument_priced();
    default:
      return kind;
  }
}

export function stageLabel(stage: string): string {
  switch (stage) {
    case "pre_seed":
      return m.round_stage_pre_seed();
    case "seed":
      return m.round_stage_seed();
    case "series_a":
      return m.round_stage_series_a();
    case "series_b":
      return m.round_stage_series_b();
    case "bridge":
      return m.round_stage_bridge();
    case "other":
      return m.round_stage_other();
    default:
      return stage;
  }
}

export function roundStatusLabel(status: string): string {
  switch (status) {
    case "planning":
      return m.round_status_planning();
    case "open":
      return m.round_status_open();
    case "closed":
      return m.round_status_closed();
    default:
      return status;
  }
}

export function commitmentStatusLabel(status: string): string {
  switch (status) {
    case "soft":
      return m.round_commitment_soft();
    case "verbal":
      return m.round_commitment_verbal();
    case "signed":
      return m.round_commitment_signed();
    case "wired":
      return m.round_commitment_wired();
    case "withdrawn":
      return m.round_commitment_withdrawn();
    default:
      return status;
  }
}

export function interestStatusLabel(status: string): string {
  switch (status) {
    case "submitted":
      return m.round_interest_status_submitted();
    case "accepted":
      return m.round_interest_status_accepted();
    case "declined":
      return m.round_interest_status_declined();
    case "withdrawn":
      return m.round_interest_status_withdrawn();
    default:
      return status;
  }
}

/** What the accreditation path asks of this person, said as a thing rather than as a code. */
export function pathLabel(path: string): string {
  switch (path) {
    case "none":
      return m.round_path_none();
    case "self_attested":
      return m.round_path_self_attested();
    case "self_certified":
      return m.round_path_self_certified();
    case "verification_required":
      return m.round_path_verification_required();
    default:
      return path;
  }
}

export function verificationStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return m.round_verification_pending();
    case "verified":
      return m.round_verification_verified();
    case "rejected":
      return m.round_verification_rejected();
    case "expired":
      return m.round_verification_expired();
    default:
      return status;
  }
}

export function methodLabel(method: string): string {
  switch (method) {
    case "document_review":
      return m.round_method_document_review();
    case "third_party":
      return m.round_method_third_party();
    case "professional_letter":
      return m.round_method_professional_letter();
    case "minimum_investment":
      return m.round_method_minimum_investment();
    default:
      return method;
  }
}

export function subjectLabel(subject: string): string {
  switch (subject) {
    case "individual":
      return m.round_subject_individual();
    case "entity":
      return m.round_subject_entity();
    default:
      return subject;
  }
}

/**
 * The badge tone for a commitment status. Tone is never the *only* carrier of the meaning —
 * every badge in this module also says the word — so this is decoration, and a status the
 * build does not know gets the neutral outline rather than a guess.
 */
export function commitmentStatusVariant(
  status: string,
): "default" | "secondary" | "outline" | "destructive" | "success" | "warning" {
  switch (status) {
    case "wired":
      return "success";
    case "signed":
      return "default";
    case "verbal":
      return "secondary";
    case "withdrawn":
      return "destructive";
    default:
      return "outline";
  }
}

export function interestStatusVariant(
  status: string,
): "default" | "secondary" | "outline" | "destructive" | "success" | "warning" {
  switch (status) {
    case "accepted":
      return "success";
    case "declined":
      return "destructive";
    case "submitted":
      return "secondary";
    default:
      return "outline";
  }
}

export function verificationStatusVariant(
  status: string,
): "default" | "secondary" | "outline" | "destructive" | "success" | "warning" {
  switch (status) {
    case "verified":
      return "success";
    case "rejected":
      return "destructive";
    case "pending":
      return "warning";
    default:
      return "outline";
  }
}
