import { Badge, cn } from "@fundroomhq/ui";
import type * as React from "react";
import { isApiError } from "../../lib/api.js";
import type {
  ConsentPurpose,
  LegalAudience,
  LegalDocumentKind,
  OfferingStatus,
  Relationship,
} from "../../lib/compliance-queries.js";
import { m } from "../../paraglide/messages.js";

/*
 * Localised names for the compliance vocabulary (E1.6). The server sends stable keys — the
 * offering status, the document kind, the relationship warning code — and the copy for each
 * lives here so the screens stay string-free.
 */
/**
 * The 409 the server answers while a switch to Rule 506(c) is still unconfirmed. Shared by the
 * admin offering form and the setup wizard's offering step: both have to do the same round trip,
 * and a second copy of this predicate would be a second thing to get wrong.
 */
export function requiresConfirmation(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.code === "conflict" &&
    error.body.error["requiresConfirmation"] === true
  );
}

export function offeringStatusLabel(status: OfferingStatus | string): string {
  switch (status) {
    case "none":
      return m.offering_status_none();
    case "informational":
      return m.offering_status_informational();
    case "506b":
      return m.offering_status_506b();
    case "506c":
      return m.offering_status_506c();
    case "non_us":
      return m.offering_status_non_us();
    default:
      return status;
  }
}

export function OfferingStatusBadge({ status }: { status: OfferingStatus }) {
  return (
    <Badge variant={status === "506c" ? "secondary" : "outline"}>
      {offeringStatusLabel(status)}
    </Badge>
  );
}

export function legalKindLabel(kind: LegalDocumentKind | string): string {
  switch (kind) {
    case "privacy_notice":
      return m.legal_kind_privacy_notice();
    case "nda":
      return m.legal_kind_nda();
    case "terms":
      return m.legal_kind_terms();
    case "disclaimer":
      return m.legal_kind_disclaimer();
    case "accreditation":
      return m.legal_kind_accreditation();
    case "cookie_notice":
      return m.legal_kind_cookie_notice();
    case "accessibility_statement":
      return m.legal_kind_accessibility_statement();
    default:
      return kind;
  }
}

export function legalAudienceLabel(audience: LegalAudience | string): string {
  switch (audience) {
    case "external":
      return m.legal_audience_external();
    case "staff":
      return m.legal_audience_staff();
    default:
      return m.legal_audience_all();
  }
}

export function relationshipSourceLabel(source: string): string {
  switch (source) {
    case "founder_invite":
      return m.relationship_source_founder_invite();
    case "intro":
      return m.relationship_source_intro();
    case "prior_investor":
      return m.relationship_source_prior_investor();
    case "event":
      return m.relationship_source_event();
    case "other":
      return m.relationship_source_other();
    default:
      return source;
  }
}

/** The heuristic's code carries the meaning; the server's English message is the fallback. */
export function relationshipWarningLabel(warning: NonNullable<Relationship["warning"]>): string {
  switch (warning.code) {
    case "no_source":
      return m.relationship_warning_no_source();
    case "no_date":
      return m.relationship_warning_no_date();
    case "access_too_soon":
      return m.relationship_warning_access_too_soon();
    case "exposure_before_relationship":
      return m.relationship_warning_exposure_before_relationship();
    default:
      return warning.message;
  }
}

export function consentPurposeLabel(purpose: ConsentPurpose | string): string {
  switch (purpose) {
    case "analytics_engagement":
      return m.consent_purpose_analytics();
    case "email_tracking":
      return m.consent_purpose_email();
    default:
      return purpose;
  }
}

export function consentModeLabel(mode: string): string {
  switch (mode) {
    case "opt_in":
      return m.consent_mode_opt_in();
    case "opt_out":
      return m.consent_mode_opt_out();
    default:
      return m.consent_mode_notice_only();
  }
}

/*
 * A native `<select>`. Radix's Select is the house control, but these screens are exercised
 * hard in jsdom (which has no pointer geometry for a listbox popper) and a native select is
 * both testable and the better keyboard control for a short enum.
 */
export function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        "flex h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-colors disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-ring focus-visible:outline-hidden focus-visible:ring-[3px] focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    />
  );
}
