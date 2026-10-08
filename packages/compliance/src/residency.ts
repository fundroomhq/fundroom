import type {
  AccreditationVendorMeta,
  BillingSubProcessor,
  ESignVendorMeta,
  IntegrationProviderMeta,
  Jurisdiction,
  ModelProviderInfo,
  SanctionsSubProcessor,
  SubProcessorMeta,
} from "@fundroom/ports";

/*
 * Residency facts (E3.11, ADR-0059): the one place that turns the adapters' sub-processor
 * metadata — five historical shapes plus the E3.11 `SubProcessorMeta` — into one normalised list,
 * builds the component table ("where does each part of the service keep data"), and computes the
 * out-of-region flags. Pure: the server reads config and connections, this decides.
 *
 * Every location here is OPERATOR-DECLARED. The software cannot verify where a database or a
 * bucket physically is, and every sentence this module renders says so.
 */

export type VendorJurisdiction = Jurisdiction | "varies";

/** The deployment's declared region (`DATA_REGION*`); `null` = none declared. */
export interface ResidencyRegion {
  readonly code: string;
  /** '' when the operator gave no label. */
  readonly label: string;
  readonly jurisdiction: Jurisdiction | null;
}

export const RESIDENCY_COMPONENT_NAMES = [
  "database",
  "jobs",
  "search",
  "analytics",
  "objectStorage",
  "backups",
  "email",
  "telemetry",
  "errorReporting",
  "virusScan",
  "ai",
] as const;
export type ResidencyComponentName = (typeof RESIDENCY_COMPONENT_NAMES)[number];

export interface ResidencyComponent {
  readonly component: ResidencyComponentName;
  /** Human text; `null` = not declared / not known. */
  readonly location: string | null;
  readonly jurisdiction: VendorJurisdiction | null;
  /** `null` when the region or the component's jurisdiction is unknown or `varies`. */
  readonly inRegion: boolean | null;
}

export type SubProcessorScope = "deployment" | "workspace";

/** A sub-processor as the residency page and the DPA show it. */
export interface ResidencySubProcessor {
  readonly name: string;
  readonly purpose: string;
  readonly dataProcessed: string;
  readonly location: string;
  readonly jurisdiction: VendorJurisdiction;
  readonly transferMechanism: string | null;
  readonly dpaUrl: string | null;
  readonly certifications: readonly string[];
  readonly scope: SubProcessorScope;
  readonly outsideRegion: boolean | null;
}

// --- jurisdiction inference ------------------------------------------------------------------

/**
 * Location texts that name exactly one jurisdiction. Used only when an adapter declares no
 * `jurisdiction`: anything not in this list (two regions, "or", a self-hosted alternative) is
 * `varies`, never a guess.
 */
const EXACT_LOCATIONS: Readonly<Record<string, Jurisdiction>> = {
  "united states": "us",
  us: "us",
  usa: "us",
  "united kingdom": "uk",
  uk: "uk",
  switzerland: "ch",
  canada: "ca",
  australia: "au",
  eu: "eu",
  "european union": "eu",
  "eu (germany)": "eu",
  germany: "eu",
  ireland: "eu",
  france: "eu",
  netherlands: "eu",
};

export function inferJurisdiction(location: string): VendorJurisdiction {
  return EXACT_LOCATIONS[location.trim().toLowerCase()] ?? "varies";
}

// --- normalisers ---------------------------------------------------------------------------------

const ESIGN_DATA =
  "Signer names and email addresses, the documents sent for signature, and the signing audit trail";
const INTEGRATION_DATA =
  "Account identifiers and the records exchanged through the connection (figures read into metrics, notifications or bookings sent)";
const ACCREDITATION_DATA =
  "Investor names, email addresses and the accreditation evidence and answers they give the vendor";
const BILLING_DATA =
  "The workspace's billing contact, company name and address, and payment details (held by the provider)";
const SANCTIONS_DATA = "The legal name and country of the customer company being screened";

function withJurisdiction(
  explicit: VendorJurisdiction | undefined,
  location: string,
): VendorJurisdiction {
  return explicit ?? inferJurisdiction(location);
}

/** E-sign vendor (`ESignVendorMeta.subProcessor`, E3.5). */
export function fromESignSubProcessor(sp: ESignVendorMeta["subProcessor"]): SubProcessorMeta {
  return {
    name: sp.name,
    purpose: sp.purpose,
    dataProcessed: ESIGN_DATA,
    location: sp.region,
    jurisdiction: withJurisdiction(sp.jurisdiction, sp.region),
    dpaUrl: sp.dpaUrl,
    certifications: [...sp.certifications],
  };
}

/** Integration provider (`IntegrationProviderMeta.subProcessor`, E3.6). */
export function fromIntegrationSubProcessor(
  sp: IntegrationProviderMeta["subProcessor"],
): SubProcessorMeta {
  return {
    name: sp.name,
    purpose: sp.purpose,
    dataProcessed: INTEGRATION_DATA,
    location: sp.region,
    jurisdiction: withJurisdiction(sp.jurisdiction, sp.region),
    dpaUrl: sp.dpaUrl,
  };
}

/** Accreditation vendor (`AccreditationVendorMeta.subProcessor`, E3.7). */
export function fromAccreditationSubProcessor(
  sp: AccreditationVendorMeta["subProcessor"],
): SubProcessorMeta {
  return {
    name: sp.name,
    purpose: sp.purpose,
    dataProcessed: ACCREDITATION_DATA,
    location: sp.location,
    jurisdiction: withJurisdiction(sp.jurisdiction, sp.location),
    dpaUrl: sp.url,
  };
}

/** Billing provider (`BillingPort.meta.subProcessor`, E3.10); `null` (manual) → `null`. */
export function fromBillingSubProcessor(sp: BillingSubProcessor | null): SubProcessorMeta | null {
  if (sp === null) return null;
  return {
    name: sp.name,
    purpose: sp.purpose,
    dataProcessed: BILLING_DATA,
    location: sp.location,
    jurisdiction: withJurisdiction(sp.jurisdiction, sp.location),
    dpaUrl: sp.url,
  };
}

/** Sanctions screening (`SanctionsScreeningPort.meta.subProcessor`, E3.10); local lists → `null`. */
export function fromSanctionsSubProcessor(
  sp: SanctionsSubProcessor | null,
): SubProcessorMeta | null {
  if (sp === null) return null;
  return {
    name: sp.name,
    purpose: sp.purpose,
    dataProcessed: SANCTIONS_DATA,
    location: sp.location,
    jurisdiction: withJurisdiction(sp.jurisdiction, sp.location),
    dpaUrl: sp.url,
  };
}

/** Any of the shapes, tagged by where it came from. */
export type SubProcessorSource =
  | { readonly kind: "esign"; readonly value: ESignVendorMeta["subProcessor"] }
  | { readonly kind: "integration"; readonly value: IntegrationProviderMeta["subProcessor"] }
  | { readonly kind: "accreditation"; readonly value: AccreditationVendorMeta["subProcessor"] }
  | { readonly kind: "billing"; readonly value: BillingSubProcessor | null }
  | { readonly kind: "sanctions"; readonly value: SanctionsSubProcessor | null }
  | { readonly kind: "meta"; readonly value: SubProcessorMeta | null };

export function normaliseSubProcessor(source: SubProcessorSource): SubProcessorMeta | null {
  switch (source.kind) {
    case "esign":
      return fromESignSubProcessor(source.value);
    case "integration":
      return fromIntegrationSubProcessor(source.value);
    case "accreditation":
      return fromAccreditationSubProcessor(source.value);
    case "billing":
      return fromBillingSubProcessor(source.value);
    case "sanctions":
      return fromSanctionsSubProcessor(source.value);
    case "meta":
      return source.value;
  }
}

// --- flags -----------------------------------------------------------------------------------------

/**
 * Whether a vendor in `jurisdiction` is inside the declared region, compared by jurisdiction.
 * `null` whenever either side is unknown: no region, a region without a jurisdiction, `other`
 * (two "other"s are not the same place) or a vendor that `varies`.
 */
export function inDeclaredRegion(
  jurisdiction: VendorJurisdiction | null,
  region: ResidencyRegion | null,
): boolean | null {
  if (region === null || region.jurisdiction === null || region.jurisdiction === "other") {
    return null;
  }
  if (jurisdiction === null || jurisdiction === "varies" || jurisdiction === "other") return null;
  return jurisdiction === region.jurisdiction;
}

/** Adequacy findings this module is sure of (exporter region → importer jurisdictions). */
const ADEQUATE: Readonly<Partial<Record<Jurisdiction, readonly Jurisdiction[]>>> = {
  eu: ["uk", "ch"],
  uk: ["eu", "ch"],
  ch: ["eu", "uk"],
};

/**
 * The mechanism a transfer out of a European region normally relies on, where this module can
 * say so without guessing: an adequacy decision it knows of (EU↔UK↔CH), or — for a US vendor —
 * the standard clauses, with the DPF alternative left for the operator to confirm. Anything else
 * (`other`, `ca`, `au`, `varies`, a non-European region) is `undefined`: the DPA then says "Not
 * stated" rather than implying there is none.
 */
export function standardTransferMechanism(
  vendor: VendorJurisdiction,
  region: ResidencyRegion | null,
): string | undefined {
  if (region === null || region.jurisdiction === null) return undefined;
  if (vendor === region.jurisdiction) return undefined;
  if (vendor !== "varies" && ADEQUATE[region.jurisdiction]?.includes(vendor) === true) {
    return "Adequacy decision";
  }
  if (vendor !== "us") return undefined;
  switch (region.jurisdiction) {
    case "eu":
      return "EU SCCs (or the EU-US Data Privacy Framework — operator to confirm)";
    case "uk":
      return "EU SCCs with the UK Addendum or the UK IDTA (or the UK Extension to the DPF — operator to confirm)";
    case "ch":
      return "EU SCCs with the Swiss adaptations (or the Swiss-US DPF — operator to confirm)";
    default:
      return undefined;
  }
}

export function toResidencySubProcessor(
  meta: SubProcessorMeta,
  scope: SubProcessorScope,
  region: ResidencyRegion | null,
): ResidencySubProcessor {
  return {
    name: meta.name,
    purpose: meta.purpose,
    dataProcessed: meta.dataProcessed,
    location: meta.location,
    jurisdiction: meta.jurisdiction,
    transferMechanism:
      meta.transferMechanism ?? standardTransferMechanism(meta.jurisdiction, region) ?? null,
    dpaUrl: meta.dpaUrl ?? null,
    certifications: [...(meta.certifications ?? [])],
    scope,
    outsideRegion: (() => {
      const inside = inDeclaredRegion(meta.jurisdiction, region);
      return inside === null ? null : !inside;
    })(),
  };
}

// --- deployment scope ------------------------------------------------------------------------

/** The operator-configured adapters that may send tenant data to a third party. */
export interface DeploymentSubProcessorFacts {
  /** The mailer's; `null` = operator's own relay; `undefined` = unknown (a test double). */
  readonly email?: SubProcessorMeta | null | undefined;
  /** S3's; `null` = operator-run or local disk. */
  readonly objectStorage?: SubProcessorMeta | null | undefined;
  readonly billing?: BillingSubProcessor | null | undefined;
  readonly sanctions?: SanctionsSubProcessor | null | undefined;
  /** Cloudflare for SaaS (custom domains). */
  readonly customDomains?: SubProcessorMeta | null | undefined;
  /** A hosted (not operator-run) OTLP collector: it receives traces and metrics. */
  readonly telemetry?: SubProcessorMeta | null | undefined;
  /** A remote (not operator-run) clamd: it receives every uploaded file's bytes. */
  readonly virusScan?: SubProcessorMeta | null | undefined;
  /**
   * E3.12: a THIRD-PARTY AI model provider (`aiSubProcessorOf`); `null` = none configured or
   * self-hosted (operator-run: no sub-processor).
   */
  readonly ai?: SubProcessorMeta | null | undefined;
}

/**
 * The deployment-scope sub-processors, in a stable order (email, storage, custom domains,
 * virus scanning, telemetry, billing, sanctions, AI model), one row per distinct (name, purpose).
 */
export function collectDeploymentSubProcessors(
  facts: DeploymentSubProcessorFacts,
): SubProcessorMeta[] {
  const all = [
    facts.email ?? null,
    facts.objectStorage ?? null,
    facts.customDomains ?? null,
    facts.virusScan ?? null,
    facts.telemetry ?? null,
    fromBillingSubProcessor(facts.billing ?? null),
    fromSanctionsSubProcessor(facts.sanctions ?? null),
    facts.ai ?? null,
  ];
  const seen = new Set<string>();
  const out: SubProcessorMeta[] = [];
  for (const meta of all) {
    if (meta === null) continue;
    const key = `${meta.name}\u0000${meta.purpose}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(meta);
  }
  return out;
}

// --- AI model provider (E3.12) --------------------------------------------------------------------

/** What the residency facts need from the configured model provider (`ModelPort.info`). */
export type AiProviderFacts = Pick<
  ModelProviderInfo,
  | "label"
  | "hosting"
  | "location"
  | "jurisdiction"
  | "retention"
  | "subProcessor"
  | "trainsOnInputs"
>;

const AI_DEPLOYMENT_PURPOSE = "AI assist (workspaces that turn it on)";
/**
 * The workspace-scope row's purpose. Deliberately different from the deployment row's, so the
 * workspace list (deduplicated against the deployment list by name + purpose) still shows that
 * THIS workspace sends its content to the provider.
 */
export const AI_WORKSPACE_PURPOSE =
  "AI assist, turned on by this workspace (drafts and suggested answers its staff review)";
const AI_DATA =
  "Prompts built from workspace content: update text, KPI values, data-room passages, investor questions";

/**
 * The provider as a deployment sub-processor: THIRD-PARTY hosting only (a self-hosted model is
 * operator-run, like an operator's own SMTP relay, and is no sub-processor). Uses the adapter's
 * own metadata; a third-party provider without it (a test double) still gets a row — data leaves
 * the deployment, so the list must never say "None".
 */
export function aiSubProcessorOf(info: AiProviderFacts | null): SubProcessorMeta | null {
  if (info === null || info.hosting !== "third_party") return null;
  if (info.subProcessor !== undefined && info.subProcessor !== null) return info.subProcessor;
  return {
    name: info.label,
    purpose: AI_DEPLOYMENT_PURPOSE,
    dataProcessed: AI_DATA,
    location: info.location ?? "Not identified by the software",
    jurisdiction:
      info.jurisdiction ?? (info.location === null ? "varies" : inferJurisdiction(info.location)),
  };
}

/** The workspace-scope row: the deployment row with this workspace's purpose. */
export function aiWorkspaceSubProcessorOf(info: AiProviderFacts | null): SubProcessorMeta | null {
  const meta = aiSubProcessorOf(info);
  return meta === null ? null : { ...meta, purpose: AI_WORKSPACE_PURPOSE };
}

/**
 * The `ai` component: absent when no provider is configured; self-hosted = the cell's (in the
 * region by the operator's declaration, the clamd rule); third party = where its info says, so
 * `inRegion` compares its jurisdiction with the region's (`varies`/unknown → `null`).
 */
export function aiComponentOf(info: AiProviderFacts | null): ComponentFacts["ai"] {
  if (info === null) return undefined;
  if (info.hosting === "self_hosted") return { cell: true };
  return {
    location: info.location ?? info.subProcessor?.location ?? null,
    jurisdiction: info.jurisdiction ?? info.subProcessor?.jurisdiction ?? null,
  };
}

/** Which AI assist features a workspace has effectively on (the notice names only those). */
export interface AiAssistFeatures {
  readonly updateDraft: boolean;
  readonly qaAnswer: boolean;
}

/**
 * The `{{aiAssist}}` merge field's facts: `null` = the workspace does not use AI assist (or the
 * operator configured no model), else which features and where the model runs.
 * `trainsOnInputs: null` = the host has not stated whether the provider trains on inputs (a
 * hosted OpenAI-compatible API: its own terms govern).
 */
export type AiAssistFacts =
  | {
      readonly hosting: "self_hosted";
      readonly features: AiAssistFeatures;
      readonly resultRetentionHours: number;
    }
  | {
      readonly hosting: "third_party";
      readonly features: AiAssistFeatures;
      readonly resultRetentionHours: number;
      readonly provider: string;
      readonly location: string | null;
      readonly retention: string;
      readonly trainsOnInputs: false | null;
    }
  | null;

export function aiAssistFactsOf(
  info: AiProviderFacts | null,
  features: AiAssistFeatures,
  resultRetentionHours: number,
): AiAssistFacts {
  if (info === null || (!features.updateDraft && !features.qaAnswer)) return null;
  if (info.hosting === "self_hosted") {
    return { hosting: "self_hosted", features, resultRetentionHours };
  }
  return {
    hosting: "third_party",
    features,
    resultRetentionHours,
    provider: info.subProcessor?.name ?? info.label,
    // The operator's own statement only: an adapter's placeholder ("Not stated by the host") is
    // not a place and must not be printed as one.
    location: info.location,
    retention: info.retention,
    trainsOnInputs: info.trainsOnInputs === false ? false : null,
  };
}

// --- components --------------------------------------------------------------------------------

export interface ComponentFacts {
  readonly region: ResidencyRegion | null;
  /** `fs` or an operator-run S3 endpoint: the cell's own; a vendor: where it says. */
  readonly objectStorage: { readonly subProcessor: SubProcessorMeta | null };
  /** BACKUP_LOCATION. */
  readonly backupLocation: string | null;
  /** The mailer's sub-processor; `null`/`undefined` = the operator's own relay (not locatable). */
  readonly email: SubProcessorMeta | null | undefined;
  /** Present only when OTLP export is configured. */
  readonly telemetry?:
    | { readonly location: string | null; readonly jurisdiction: VendorJurisdiction | null }
    | undefined;
  /** Present only when something actually sends errors to a DSN. */
  readonly errorReporting?:
    | { readonly location: string | null; readonly jurisdiction: VendorJurisdiction | null }
    | undefined;
  /**
   * Present only when a virus scanner receives uploaded files (AV_DRIVER=clamd). `cell: true` =
   * an operator-run scanner next to the app, in the region by the operator's declaration.
   */
  readonly virusScan?:
    | { readonly cell: true }
    | {
        readonly cell?: false | undefined;
        readonly location: string | null;
        readonly jurisdiction: VendorJurisdiction | null;
      }
    | undefined;
  /**
   * E3.12: present only when an AI model provider is configured (`aiComponentOf`). `cell: true` =
   * self-hosted (operator-run), in the region by the operator's declaration, like a clamd next
   * to the app; a third party is wherever its provider info says.
   */
  readonly ai?:
    | { readonly cell: true }
    | {
        readonly cell?: false | undefined;
        readonly location: string | null;
        readonly jurisdiction: VendorJurisdiction | null;
      }
    | undefined;
}

/** The region as a place: its label, else its code; `null` when none is declared. */
export function regionText(region: ResidencyRegion | null): string | null {
  if (region === null) return null;
  return region.label.length > 0 ? region.label : region.code;
}

/**
 * The component table. Database, jobs, search and analytics live in the cell's own Postgres, so
 * they are in the region by construction (when one is declared); object storage is too unless a
 * third party holds it; backups are wherever the operator says; email, telemetry and error
 * reporting go wherever their provider is.
 */
export function residencyComponents(facts: ComponentFacts): ResidencyComponent[] {
  const { region } = facts;
  const cell = (component: ResidencyComponentName): ResidencyComponent => ({
    component,
    location: regionText(region),
    jurisdiction: region?.jurisdiction ?? null,
    inRegion: region === null ? null : true,
  });
  const vendor = (
    component: ResidencyComponentName,
    location: string | null,
    jurisdiction: VendorJurisdiction | null,
  ): ResidencyComponent => ({
    component,
    location,
    jurisdiction,
    inRegion: inDeclaredRegion(jurisdiction, region),
  });
  const storage = facts.objectStorage.subProcessor;
  const out: ResidencyComponent[] = [
    cell("database"),
    cell("jobs"),
    cell("search"),
    cell("analytics"),
    storage === null
      ? cell("objectStorage")
      : vendor("objectStorage", storage.location, storage.jurisdiction),
    vendor("backups", facts.backupLocation, null),
    facts.email === null || facts.email === undefined
      ? vendor("email", null, null)
      : vendor("email", facts.email.location, facts.email.jurisdiction),
  ];
  if (facts.telemetry !== undefined) {
    out.push(vendor("telemetry", facts.telemetry.location, facts.telemetry.jurisdiction));
  }
  if (facts.errorReporting !== undefined) {
    out.push(
      vendor("errorReporting", facts.errorReporting.location, facts.errorReporting.jurisdiction),
    );
  }
  const scan = facts.virusScan;
  if (scan !== undefined) {
    out.push(
      scan.cell === true
        ? cell("virusScan")
        : vendor("virusScan", scan.location, scan.jurisdiction),
    );
  }
  const ai = facts.ai;
  if (ai !== undefined) {
    out.push(ai.cell === true ? cell("ai") : vendor("ai", ai.location, ai.jurisdiction));
  }
  return out;
}

/**
 * Rows for the templates' `{{subProcessors}}` table (`SubProcessorRow` shape). A vendor outside
 * the declared region says so in its location cell, so the DPA reader sees it next to the
 * transfer mechanism.
 */
export function subProcessorRowsOf(list: readonly ResidencySubProcessor[]): {
  readonly provider: string;
  readonly purpose: string;
  readonly dataProcessed: string;
  readonly location: string;
  readonly transferMechanism?: string | undefined;
}[] {
  return list.map((s) => ({
    provider: s.name,
    purpose: s.purpose,
    dataProcessed: s.dataProcessed,
    location: s.outsideRegion === true ? `${s.location} (outside the declared region)` : s.location,
    ...(s.transferMechanism !== null
      ? { transferMechanism: s.transferMechanism }
      : s.outsideRegion === false
        ? { transferMechanism: "Not applicable (same jurisdiction)" }
        : {}),
  }));
}
