import type {
  CommitmentStatus,
  OrgKind,
  PipelineStage,
  SubjectKind,
} from "../../lib/crm-queries.js";
import { m } from "../../paraglide/messages.js";
import { getLocale } from "../../paraglide/runtime.js";

/*
 * How a CRM record reads on screen. The enums the server sends are stable keys; the words for
 * them live here so the screens stay string-free, and every one of them falls back to the raw
 * key rather than to an empty cell — a tenant may add a custom stage (§D10) and an unknown
 * value should still say something true.
 */

/**
 * A money figure for a human. The amount arrives as a decimal string and this is the only
 * place the CRM screens make a float of one — to *draw* it. Nothing is ever added up here:
 * the reconciliation panel sums with `@fundroom/decimal` precisely because a total is a
 * different kind of claim from a label.
 */
export function formatMoney(
  amount: string | null | undefined,
  currency: string | null | undefined,
): string {
  if (typeof amount !== "string" || amount.trim() === "") return m.crm_amount_none();
  const n = Number(amount);
  if (!Number.isFinite(n)) return m.crm_amount_none();
  const locale = getLocale();
  if (typeof currency === "string" && /^[A-Z]{3}$/u.test(currency)) {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      // A board full of `.00` is noise; a figure with real cents still shows them.
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(n);
  }
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(n);
}

export function orgKindLabel(kind: OrgKind | string | null | undefined): string {
  switch (kind) {
    case "fund":
      return m.crm_org_kind_fund();
    case "angel_group":
      return m.crm_org_kind_angel_group();
    case "corporate":
      return m.crm_org_kind_corporate();
    case "family_office":
      return m.crm_org_kind_family_office();
    case "other":
      return m.crm_org_kind_other();
    default:
      return typeof kind === "string" && kind !== "" ? kind : m.crm_org_kind_unknown();
  }
}

/**
 * The stage's name, or something honest when the board has an item pointing at a stage the
 * stage list does not carry (a stage renamed or removed in another tab).
 */
export function stageName(
  stage: PipelineStage | undefined,
  stages: readonly PipelineStage[] = [],
  stageId?: string,
): string {
  const found = stage ?? stages.find((s) => s.id === stageId);
  if (found !== undefined) return found.name;
  return m.crm_stage_unknown();
}

export function subjectKindLabel(kind: SubjectKind | string): string {
  switch (kind) {
    case "contact":
      return m.crm_subject_contact();
    case "organization":
      return m.crm_subject_organization();
    case "pipeline_item":
      return m.crm_subject_pipeline_item();
    default:
      return kind;
  }
}

export function commitmentStatusLabel(status: CommitmentStatus | string): string {
  switch (status) {
    case "soft":
      return m.crm_commitment_soft();
    case "verbal":
      return m.crm_commitment_verbal();
    case "signed":
      return m.crm_commitment_signed();
    case "wired":
      return m.crm_commitment_wired();
    case "withdrawn":
      return m.crm_commitment_withdrawn();
    default:
      return status;
  }
}
