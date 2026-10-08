import {
  type AiAssistFacts,
  type ResidencyComponentName,
  regionText,
  type VendorJurisdiction,
} from "../residency.js";
import type {
  DataLocation,
  RetentionRow,
  ShippedTemplate,
  SubProcessorRow,
  TemplateContext,
} from "./contract.js";

/*
 * Merge-field substitution (`templates/README.md`, "Merge-field contract").
 *
 * Pure: a template and a context in, Markdown out. Two rules from the README drive the whole
 * implementation. An unset optional scalar renders as the empty string, never as `undefined` and
 * never as the literal `{{company.dpoEmail}}` — a lawyer reading a generated notice should see a
 * sentence with a gap in it, which is obviously wrong, rather than a placeholder, which looks
 * like a bug the reader is meant to ignore. And `subProcessors` / `retention` render as tables on
 * their own line, including when they are empty, because both can legitimately be empty and the
 * templates say in prose what an empty table means.
 */

export interface RenderOptions {
  /** What an unset scalar renders as. The empty string by default; see the note above. */
  readonly placeholder?: string;
}

const CELL_EMPTY = "—";

/** Escapes the one character that would break out of a Markdown table cell. */
function cell(value: string | undefined): string {
  const text = (value ?? "").trim();
  return text.length === 0 ? CELL_EMPTY : text.replace(/\|/gu, "\\|");
}

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
  if (rows.length === 0) {
    // Still a table: the surrounding prose says what an empty one means, and a reader scanning
    // for the table should find it rather than a missing section.
    lines.push(
      `| _None configured._ |${header
        .slice(1)
        .map(() => ` ${CELL_EMPTY} |`)
        .join("")}`,
    );
  } else {
    for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  }
  return lines.join("\n");
}

export function renderSubProcessors(rows: readonly SubProcessorRow[] = []): string {
  return table(
    ["Provider", "Purpose", "Data processed", "Location", "Transfer mechanism"],
    rows.map((r) => [
      cell(r.provider),
      cell(r.purpose),
      cell(r.dataProcessed),
      cell(r.location),
      // Empty means nobody stated one — never "none needed".
      cell(r.transferMechanism ?? "Not stated"),
    ]),
  );
}

export function renderRetention(rows: readonly RetentionRow[] = []): string {
  return table(
    ["Record class", "What it covers", "Retention", "Why"],
    rows.map((r) => [cell(r.recordClass), cell(r.covers), cell(r.retention), cell(r.basis)]),
  );
}

const COMPONENT_LABELS: Readonly<Record<ResidencyComponentName, string>> = {
  database: "Database (all records)",
  jobs: "Background jobs",
  search: "Search index",
  analytics: "Analytics",
  objectStorage: "Object storage (files)",
  backups: "Backups",
  email: "Email delivery",
  telemetry: "Telemetry (traces and metrics)",
  errorReporting: "Error reporting",
  virusScan: "Virus scanning (uploaded files)",
  ai: "AI model (AI assist)",
};

const JURISDICTION_LABELS: Readonly<Record<VendorJurisdiction, string>> = {
  eu: "European Union / EEA",
  uk: "United Kingdom",
  ch: "Switzerland",
  us: "United States",
  ca: "Canada",
  au: "Australia",
  other: "Other",
  varies: "Varies / not identified",
};

/**
 * The `{{dataLocation}}` block: one sentence about the declared region, then the component
 * table. Every fact is the operator's declaration, and the sentence says so. With no region
 * declared (or no `dataLocation` at all) the sentence says THAT, plainly — a DPA must never read
 * "hosted in ." — and the table still lists what is known (a third-party mail provider's country).
 */
export function renderDataLocation(location?: DataLocation): string {
  const region = location?.region ?? null;
  const place = regionText(region);
  const sentence =
    region === null || place === null
      ? "**The operator has not declared a data region for this deployment.** This document " +
        "therefore does not state where the customer's data is hosted; ask the operator before " +
        "relying on it for any residency requirement."
      : `The operator declares that this workspace's data is hosted in **${cell(place)}**` +
        `${region.label.length > 0 ? ` (region \`${region.code}\`)` : ""}` +
        `${region.jurisdiction === null ? "" : `, jurisdiction: ${JURISDICTION_LABELS[region.jurisdiction]}`}. ` +
        "These locations are declared by the operator; the software cannot verify where " +
        "infrastructure physically is.";
  const rows = (location?.components ?? []).map((c) => [
    cell(COMPONENT_LABELS[c.component]),
    cell(c.location ?? "Not declared"),
    cell(c.jurisdiction === null ? undefined : JURISDICTION_LABELS[c.jurisdiction]),
    c.inRegion === null ? "Unknown" : c.inRegion ? "Yes" : "**No**",
  ]);
  return `${sentence}\n\n${table(["Component", "Location", "Jurisdiction", "In the declared region"], rows)}`;
}

/** How long drafts and suggestions stay in the portal (`AI_RESULT_RETENTION_HOURS`). */
function keptFor(hours: number): string {
  const span =
    hours % 24 === 0
      ? `${hours / 24} ${hours === 24 ? "day" : "days"}`
      : `${hours} ${hours === 1 ? "hour" : "hours"}`;
  return (
    `Drafts and suggestions are kept in the portal for about ${span} (up to an hour longer) and ` +
    "then deleted; if that period is shortened, the shorter period applies to new suggestions. " +
    "Only text a member of staff saves as their own is kept beyond that."
  );
}

/**
 * The `{{aiAssist}}` block (E3.12): what AI assist does with an investor's data in THIS workspace.
 * Off (or unknown) says so in words that stay true if AI assist is turned on later (the rendered
 * notice is a published snapshot). On: only the features in use, that the model only drafts for
 * staff (no decision about the reader), and where it runs — as the operator states it, or a named
 * third party with its location and retention. Training is claimed only where it is known.
 */
export function renderAiAssist(facts?: AiAssistFacts): string {
  if (facts === null || facts === undefined) {
    return (
      "We do not use AI assist at present. If we turn it on, we will update this notice before " +
      "any of your data is sent to an AI model."
    );
  }
  const { updateDraft, qaAnswer } = facts.features;
  const uses = [
    updateDraft ? "to draft investor updates" : null,
    qaAnswer ? "to suggest answers to questions asked in the portal" : null,
  ].filter((x) => x !== null);
  const material = [
    updateDraft ? "update text and key figures" : null,
    qaAnswer
      ? "passages of data-room documents and the text of investor questions, which can include " +
        "your name and anything you wrote in a question"
      : null,
  ].filter((x) => x !== null);
  const common =
    `Our staff can use AI assist ${uses.join(" and ")}. To do that, the portal sends an AI model ` +
    `the material a draft is built from: ${material.join("; ")}. The model only drafts: a member ` +
    "of our staff reviews every draft and suggestion, nothing it writes reaches you unless a " +
    "person saves and publishes it, and it makes no decision about you. The portal never uses " +
    `your data to train a model. ${keptFor(facts.resultRetentionHours)}`;
  if (facts.hosting === "self_hosted") {
    return (
      `${common} The model runs on infrastructure that the portal's operator states it runs ` +
      "itself, so this material is not sent to a third-party AI provider."
    );
  }
  const where =
    facts.location === null
      ? ", whose processing location the host has not stated,"
      : ` (${facts.location.trim()}),`;
  const training =
    facts.trainsOnInputs === false
      ? "The provider does not use it to train models."
      : "The host has not stated whether the provider uses this data to train models.";
  return (
    `${common} The model is provided by **${facts.provider.trim()}**${where} a third party ` +
    "listed below among the host's sub-processors; the material leaves the operator's " +
    `infrastructure to reach it. ${training} ${facts.retention.trim()}`
  ).trim();
}

/** A `Date` is a calendar day in UTC: these documents state an effective date, not an instant. */
function renderDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

/** Resolves one `{{field}}` against the context, or `undefined` when the context has no answer. */
function lookup(field: string, context: TemplateContext): string | undefined {
  switch (field) {
    case "company.name":
      return context.company?.name;
    case "company.legalName":
      return context.company?.legalName;
    case "company.jurisdiction":
      return context.company?.jurisdiction;
    case "company.address":
      return context.company?.address;
    case "company.contactEmail":
      return context.company?.contactEmail;
    case "company.dpoEmail":
      return context.company?.dpoEmail;
    case "portal.url":
      return context.portal?.url;
    case "portal.name":
      return context.portal?.name;
    case "workspace.dataRegion":
      return context.workspace?.dataRegion;
    case "workspace.offeringStatus":
      return context.workspace?.offeringStatus;
    case "host.operator":
      return context.host?.operator;
    case "host.isManaged":
      return context.host?.isManaged === undefined
        ? undefined
        : context.host.isManaged
          ? "yes"
          : "no";
    case "subProcessors":
      return renderSubProcessors(context.subProcessors ?? []);
    case "workspaceSubProcessors":
      return renderSubProcessors(context.workspaceSubProcessors ?? []);
    case "retention":
      return renderRetention(context.retention ?? []);
    case "dataLocation":
      return renderDataLocation(context.dataLocation);
    case "aiAssist":
      return renderAiAssist(context.aiAssist);
    case "effectiveDate":
      return context.effectiveDate === undefined ? undefined : renderDate(context.effectiveDate);
    case "version":
      return context.version === undefined ? undefined : String(context.version);
    default:
      return undefined;
  }
}

/**
 * Substitutes every `{{field}}` in `template.body`. `version` defaults to the template's own
 * version, which is what every template that echoes it means by it; everything else comes from
 * the context. An unrecognised field renders as the placeholder rather than throwing: the
 * generator already rejected unknown fields at build time, and a custom tenant body that
 * contains a stray `{{…}}` should degrade, not 500 in front of an investor.
 */
export function renderTemplate(
  template: Pick<ShippedTemplate, "body" | "version">,
  context: TemplateContext = {},
  options: RenderOptions = {},
): string {
  const placeholder = options.placeholder ?? "";
  const withVersion: TemplateContext = { ...context, version: context.version ?? template.version };
  return template.body.replace(/\{\{\s*([^}]+?)\s*\}\}/gu, (_match, field: string) => {
    return lookup(field, withVersion) ?? placeholder;
  });
}
