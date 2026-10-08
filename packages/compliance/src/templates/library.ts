import type { LegalAudience, LegalDocumentKind } from "@fundroom/db";
import { TEMPLATE_IDS, TEMPLATES, type TemplateId } from "../generated/templates.js";
import type { ShippedTemplate, TemplateAudience } from "./contract.js";

/*
 * Reading the shipped library (`src/generated/templates.ts`, compiled from `templates/*.md`).
 *
 * The library is upstream, never a tenant's copy: seeding a workspace renders a template into a
 * `core.legal_document` + first version, and from then on the tenant's document is what serves.
 * Everything here is therefore a pure read of a frozen record.
 */

export { TEMPLATE_IDS, TEMPLATES, type TemplateId };

export function listTemplates(): readonly ShippedTemplate[] {
  return TEMPLATE_IDS.map((id) => TEMPLATES[id]);
}

export function isTemplateId(id: string): id is TemplateId {
  return (TEMPLATE_IDS as readonly string[]).includes(id);
}

export function templateById(id: string): ShippedTemplate | undefined {
  return isTemplateId(id) ? TEMPLATES[id] : undefined;
}

/**
 * The database's `legal_audience` for a template's audience. The library's vocabulary is about
 * *where a document surfaces* (five values); the column's is about *who may read the row* (three).
 * `repo` maps to `staff` because a file that lives in the repository has no portal surface at all,
 * and a staff-only row is the conservative reading of "not for investors".
 */
export function audienceToLegal(audience: TemplateAudience): LegalAudience {
  switch (audience) {
    case "investor":
      return "external";
    case "public":
      return "all";
    default:
      return "staff";
  }
}

/**
 * The `legal_document_kind` a template seeds. Derived from the id rather than stored in the
 * frontmatter: the frontmatter is the library's own contract (`templates/README.md`) and should
 * not carry a database enum, but every shipped template does map onto exactly one kind.
 */
export function kindForTemplate(id: string): LegalDocumentKind {
  switch (id) {
    case "privacy-notice":
      return "privacy_notice";
    case "cookie-notice":
      return "cookie_notice";
    case "nda-clickwrap":
      return "nda";
    case "accreditation-self-certification":
      return "accreditation";
    // E2.8: served publicly at /accessibility (GET /compliance/accessibility-statement).
    case "accessibility-statement":
      return "accessibility_statement";
    case "tos":
    case "dpa":
      return "terms";
    default:
      return "disclaimer";
  }
}
