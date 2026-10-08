import type { AccreditationKernel } from "@fundroom/accreditation";
import { effectiveAiFeatures } from "@fundroom/ai";
import {
  AI_WORKSPACE_PURPOSE,
  type AiAssistFacts,
  type AiAssistFeatures,
  aiAssistFactsOf,
  aiComponentOf,
  aiSubProcessorOf,
  aiWorkspaceSubProcessorOf,
  collectDeploymentSubProcessors,
  type DataLocation,
  fromAccreditationSubProcessor,
  fromESignSubProcessor,
  fromIntegrationSubProcessor,
  type ResidencyComponent,
  type ResidencyRegion,
  type ResidencySubProcessor,
  regionText,
  residencyComponents,
  type SubProcessorRow,
  subProcessorRowsOf,
  toResidencySubProcessor,
} from "@fundroom/compliance";
import type { RawEnv } from "@fundroom/config";
import { type Database, findWorkspaceById, systemContext, type TenantContext } from "@fundroom/db";
import { type AiSettings, parseWorkspaceSettings } from "@fundroom/domain";
import { CLOUDFLARE_SAAS_SUB_PROCESSOR } from "@fundroom/domain-cloudflare-saas";
import { POSTMARK_SUB_PROCESSOR } from "@fundroom/email-postmark";
import { RESEND_SUB_PROCESSOR } from "@fundroom/email-resend";
import { sesSubProcessor } from "@fundroom/email-ses";
import { smtpSubProcessor } from "@fundroom/email-smtp";
import type { ESignKernel } from "@fundroom/esign";
import type { IntegrationsKernel } from "@fundroom/integrations";
import {
  type BillingPort,
  isOperatorRunEndpoint,
  type Jurisdiction,
  type ModelProviderInfo,
  type SanctionsScreeningPort,
  type SubProcessorMeta,
} from "@fundroom/ports";
import { s3SubProcessor } from "@fundroom/storage-s3";

/*
 * The deployment's declared residency facts (E3.11, ADR-0059), read from config once. Every value
 * is OPERATOR-DECLARED: the product cannot verify where a database or bucket physically is.
 * `container.residency` / `ApiDeps.residency`; consumed by the residency route (D), the region
 * boot check (B) and the moves engine (C).
 *
 * `deployment` holds what the configured adapters say about third parties (D): derived from the
 * same config the container builds the adapters from, with the adapters' own exported metadata,
 * so the residency page and the adapter can never disagree. Nothing here is a secret: no
 * credential, no bucket name, no endpoint URL — only a vendor's name and a region.
 */

export interface DeclaredRegion {
  /** DATA_REGION. */
  readonly code: string;
  /** DATA_REGION_LABEL ('' when unset). */
  readonly label: string;
  /** DATA_REGION_JURISDICTION (null when unset). */
  readonly jurisdiction: Jurisdiction | null;
}

/** Where a configured observability sink is; `null` fields = not known. */
export interface SinkLocation {
  readonly location: string | null;
  readonly jurisdiction: Jurisdiction | "varies" | null;
  /** A third party receiving the data (null/absent = operator-run or unknown sink only). */
  readonly subProcessor?: SubProcessorMeta | null | undefined;
}

export interface DeploymentFacts {
  /**
   * The mailer's sub-processor; `null` = an operator-run SMTP relay or the dev log mailer. A
   * public SMTP host is an unidentified relay (`varies`), never "the operator's own".
   */
  readonly email: SubProcessorMeta | null;
  /** `null` = local disk or an operator-run S3 endpoint. */
  readonly objectStorage: SubProcessorMeta | null;
  /** Cloudflare for SaaS when CUSTOM_DOMAIN_DRIVER=cloudflare-saas, else `null`. */
  readonly customDomains: SubProcessorMeta | null;
  /** Present only when OTEL_EXPORTER_OTLP_ENDPOINT is set. */
  readonly telemetry?: SinkLocation | undefined;
  /**
   * Present only when AV_DRIVER=clamd: every uploaded file's bytes go to CLAMD_HOST. `cell` =
   * operator-run next to the app (in the region by the operator's declaration).
   */
  readonly virusScan?:
    | { readonly cell: true }
    | (SinkLocation & { readonly cell?: false })
    | undefined;
}

export interface ResidencyKernel {
  /** null = the operator declared no region (DATA_REGION unset). */
  readonly region: DeclaredRegion | null;
  /** BACKUP_LOCATION (null when unset). */
  readonly backupLocation: string | null;
  /** Third parties the operator's configuration sends tenant data to (E3.11, D). */
  readonly deployment: DeploymentFacts;
  /**
   * E3.12: the configured AI model provider's info (`container.aiModel.info`), `null` when none
   * is configured. A getter, not a value: the model port is built after these facts, and a
   * test's `aiModel` seam must show here exactly as the kernel uses it.
   */
  readonly aiProvider: () => ModelProviderInfo | null;
  /** AI_RESULT_RETENTION_HOURS: how long drafts and suggestions are kept (the notice says so). */
  readonly aiResultRetentionHours: number;
}

type ResidencyEnv = Pick<
  RawEnv,
  | "DATA_REGION"
  | "DATA_REGION_LABEL"
  | "DATA_REGION_JURISDICTION"
  | "BACKUP_LOCATION"
  | "MAILER_DRIVER"
  | "AWS_REGION"
  | "STORAGE_DRIVER"
  | "S3_REGION"
  | "S3_ENDPOINT"
  | "CUSTOM_DOMAIN_DRIVER"
  | "OTEL_EXPORTER_OTLP_ENDPOINT"
  | "SMTP_URL"
  | "AV_DRIVER"
  | "CLAMD_HOST"
  | "AI_RESULT_RETENTION_HOURS"
>;

function hostOf(url: string): string | undefined {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.length === 0 ? undefined : host;
  } catch {
    return undefined;
  }
}

const TELEMETRY_PURPOSE = "Tracing and metrics of the running service (OpenTelemetry export)";
const TELEMETRY_DATA =
  "Request and database timings, route templates, status codes and internal ids; no request bodies, URLs are redacted to their origin";

/**
 * Where the OTLP collector is. An operator-run one is a component only; a hosted one is also a
 * sub-processor row (RR2-4): traces leave the deployment, so the DPA must not say "None".
 */
function telemetryLocation(url: string): SinkLocation {
  const host = hostOf(url);
  if (host !== undefined && isOperatorRunEndpoint(host)) {
    return { location: "Operator-run collector", jurisdiction: null, subProcessor: null };
  }
  const known =
    host === "api.eu1.honeycomb.io"
      ? { location: "European Union (Honeycomb)", jurisdiction: "eu" as const }
      : host === "api.honeycomb.io"
        ? { location: "United States (Honeycomb)", jurisdiction: "us" as const }
        : undefined;
  return {
    location: known?.location ?? null,
    jurisdiction: known?.jurisdiction ?? null,
    subProcessor: {
      name:
        known === undefined
          ? "Telemetry collector (OTLP, not identified)"
          : "Honeycomb (Hound Technology, Inc.)",
      purpose: TELEMETRY_PURPOSE,
      dataProcessed: TELEMETRY_DATA,
      location: known?.location ?? "Not identified by the software",
      jurisdiction: known?.jurisdiction ?? "varies",
    },
  };
}

/** A clamd that is not next to the app: every uploaded file leaves the deployment. */
const REMOTE_CLAMD_SUB_PROCESSOR: SubProcessorMeta = {
  name: "Virus scanning service (clamd, not identified)",
  purpose: "Malware scanning of uploaded files",
  dataProcessed: "The full content of every file uploaded to the workspace",
  location: "Not identified by the software",
  jurisdiction: "varies",
};

function emailOf(raw: ResidencyEnv): SubProcessorMeta | null {
  switch (raw.MAILER_DRIVER) {
    case "postmark":
      return POSTMARK_SUB_PROCESSOR;
    case "resend":
      return RESEND_SUB_PROCESSOR;
    case "ses":
      return raw.AWS_REGION === undefined ? null : sesSubProcessor(raw.AWS_REGION);
    default:
      // No SMTP_URL = the dev/test log mailer: nothing leaves the process.
      return raw.SMTP_URL === undefined ? null : smtpSubProcessor(raw.SMTP_URL);
  }
}

/*
 * No `errorReporting`: ERROR_REPORTING_DSN is accepted by config but nothing sends to it yet, and
 * the residency page must not claim a transfer the product never makes (R3-6). Add it here the
 * day an error reporter is wired.
 */
export function deploymentFactsOf(raw: ResidencyEnv): DeploymentFacts {
  const clamd = raw.AV_DRIVER === "clamd" ? (raw.CLAMD_HOST ?? "").toLowerCase() : undefined;
  return {
    email: emailOf(raw),
    objectStorage:
      raw.STORAGE_DRIVER === "s3"
        ? s3SubProcessor({ region: raw.S3_REGION, endpoint: raw.S3_ENDPOINT })
        : null,
    customDomains:
      raw.CUSTOM_DOMAIN_DRIVER === "cloudflare-saas" ? CLOUDFLARE_SAAS_SUB_PROCESSOR : null,
    ...(raw.OTEL_EXPORTER_OTLP_ENDPOINT === undefined
      ? {}
      : { telemetry: telemetryLocation(raw.OTEL_EXPORTER_OTLP_ENDPOINT) }),
    ...(clamd === undefined
      ? {}
      : {
          virusScan:
            clamd.length > 0 && isOperatorRunEndpoint(clamd)
              ? { cell: true as const }
              : {
                  location: "Not identified by the software",
                  jurisdiction: "varies" as const,
                  subProcessor: REMOTE_CLAMD_SUB_PROCESSOR,
                },
        }),
  };
}

export function residencyFactsOf(
  raw: ResidencyEnv,
  aiProvider: () => ModelProviderInfo | null,
): ResidencyKernel {
  return {
    aiProvider,
    aiResultRetentionHours: raw.AI_RESULT_RETENTION_HOURS,
    region:
      raw.DATA_REGION === undefined
        ? null
        : {
            code: raw.DATA_REGION,
            label: raw.DATA_REGION_LABEL ?? "",
            jurisdiction: raw.DATA_REGION_JURISDICTION ?? null,
          },
    backupLocation: raw.BACKUP_LOCATION ?? null,
    deployment: deploymentFactsOf(raw),
  };
}

/** What the deployment-scope facts are computed from (`ApiDeps` satisfies it). */
export interface ResidencySources {
  readonly residency: ResidencyKernel;
  readonly billing: { readonly port: Pick<BillingPort, "meta"> | null };
  readonly sanctions: { readonly port: Pick<SanctionsScreeningPort, "meta"> | null };
}

export interface DeploymentResidency {
  readonly region: ResidencyRegion | null;
  readonly components: ResidencyComponent[];
  /** Deployment scope only (the operator's configuration). */
  readonly subProcessors: ResidencySubProcessor[];
}

/** The deployment's region, component table and operator-configured sub-processors. Pure, cheap. */
export function deploymentResidency(src: ResidencySources): DeploymentResidency {
  const { region, backupLocation, deployment } = src.residency;
  const components = residencyComponents({
    region,
    objectStorage: { subProcessor: deployment.objectStorage },
    backupLocation,
    email: deployment.email,
    telemetry: deployment.telemetry,
    virusScan: deployment.virusScan,
    ai: aiComponentOf(src.residency.aiProvider()),
  });
  const subProcessors = collectDeploymentSubProcessors({
    email: deployment.email,
    objectStorage: deployment.objectStorage,
    customDomains: deployment.customDomains,
    telemetry: deployment.telemetry?.subProcessor ?? null,
    virusScan:
      deployment.virusScan === undefined || deployment.virusScan.cell === true
        ? null
        : (deployment.virusScan.subProcessor ?? null),
    billing: src.billing.port?.meta.subProcessor ?? null,
    sanctions: src.sanctions.port?.meta.subProcessor ?? null,
    // A third-party AI provider is the operator's choice, offered to every workspace: the
    // operator's DPA lists it whether or not a given workspace has turned AI assist on.
    ai: aiSubProcessorOf(src.residency.aiProvider()),
  }).map((meta) => toResidencySubProcessor(meta, "deployment", region));
  return { region, components, subProcessors };
}

/**
 * The residency merge fields for a template render (`workspace.dataRegion`, `subProcessors`,
 * `dataLocation`): what every legal-template render in this deployment spreads into its context.
 * `dataRegion` is the declared label, else the code, else absent.
 */
export function residencyTemplateFields(src: ResidencySources): {
  readonly dataRegion?: string;
  readonly subProcessors: SubProcessorRow[];
  readonly dataLocation: DataLocation;
} {
  const facts = deploymentResidency(src);
  const place = regionText(facts.region);
  return {
    ...(place === null ? {} : { dataRegion: place }),
    subProcessors: subProcessorRowsOf(facts.subProcessors),
    dataLocation: { region: facts.region, components: facts.components },
  };
}

// --- workspace scope ---------------------------------------------------------------------------

/** What the workspace-scope vendors are read through (`ApiDeps` satisfies it). */
export interface WorkspaceVendorSources {
  readonly db: Database;
  readonly residency: Pick<ResidencyKernel, "aiProvider" | "aiResultRetentionHours">;
  readonly esign: Pick<ESignKernel, "connectionDetail" | "drivers">;
  readonly integrations: Pick<IntegrationsKernel, "list" | "providers">;
  readonly accreditation: Pick<AccreditationKernel, "connection" | "providers">;
}

/** Notify's Slack incoming-webhook channels (`notify.channel`, kind `slack`). */
export const SLACK_WEBHOOK_SUB_PROCESSOR: SubProcessorMeta = {
  name: "Slack Technologies, LLC (incoming webhooks)",
  purpose: "Posts the workspace's notification alerts to its Slack channels",
  dataProcessed:
    "Alert text: event titles and the names of the people and documents an alert is about",
  location: "United States (or the Slack workspace's data residency region)",
  jurisdiction: "varies",
  dpaUrl: "https://slack.com/terms-of-service/data-processing",
};

/** The metrics Google Sheets connector (`metrics.sheet_connection`). */
export const GOOGLE_SHEETS_SUB_PROCESSOR: SubProcessorMeta = {
  name: "Google LLC (Google Sheets API)",
  purpose: "Source of metric figures read from a spreadsheet the workspace shares with us",
  dataProcessed:
    "The service-account credentials the workspace supplies and the sheet range it chooses (read only)",
  location: "Not identified by the software (Google's infrastructure)",
  jurisdiction: "varies",
};

const ESIGN_FALLBACK: Omit<SubProcessorMeta, "name"> = {
  purpose: "Electronic signature of documents",
  dataProcessed: "Signer names and email addresses and the documents sent for signature",
  location: "Not identified by the software",
  jurisdiction: "varies",
};

/**
 * Module-owned egress (notify Slack webhooks, metrics Google Sheets): one short read-only
 * transaction as the workspace's system actor, by table name so the kernel imports no module
 * code. A module that is not compiled in has no table (`to_regclass` is null) and adds nothing.
 * Only ENABLED rows count: a disabled channel or sheet no longer sends.
 */
async function moduleEgressOf(db: Database, workspaceId: string): Promise<SubProcessorMeta[]> {
  return db.withTenant(systemContext(workspaceId), async (tx) => {
    const present = (
      await tx.execute(
        "SELECT to_regclass('notify.channel') IS NOT NULL AS notify, to_regclass('metrics.sheet_connection') IS NOT NULL AS metrics",
      )
    ).rows[0] as { notify: boolean; metrics: boolean } | undefined;
    const out: SubProcessorMeta[] = [];
    if (present?.notify === true) {
      const r = await tx.execute(
        "SELECT 1 FROM notify.channel WHERE kind = 'slack' AND enabled LIMIT 1",
      );
      if (r.rows.length > 0) out.push(SLACK_WEBHOOK_SUB_PROCESSOR);
    }
    if (present?.metrics === true) {
      const r = await tx.execute("SELECT 1 FROM metrics.sheet_connection WHERE enabled LIMIT 1");
      if (r.rows.length > 0) out.push(GOOGLE_SHEETS_SUB_PROCESSOR);
    }
    return out;
  });
}

/**
 * Whether AI assist is EFFECTIVELY on for any feature (contract §5, the kernel's own
 * `effectiveAiFeatures`): switched on, at least one feature on, and acknowledged for THIS
 * provider identity — a provider change turns it off until
 * someone acknowledges again, so the old acknowledgement does not list the new vendor.
 */
export function aiEffectivelyOn(settings: AiSettings, info: ModelProviderInfo): boolean {
  const on = effectiveAiFeatures(settings, info);
  return on.updateDraft || on.qaAnswer;
}

/**
 * The provider when THIS workspace has AI assist effectively on, else `null` (also when none is
 * configured — then nothing is read). One short read of the raw workspace row, not the resolver
 * cache: a switch just turned off must stop listing the vendor at once.
 */
async function aiProviderInUse(
  src: WorkspaceVendorSources,
  workspaceId: string,
): Promise<{ readonly info: ModelProviderInfo; readonly features: AiAssistFeatures } | null> {
  const info = src.residency.aiProvider();
  if (info === null) return null;
  const row = await findWorkspaceById(src.db, workspaceId);
  if (row === undefined) return null;
  const features = effectiveAiFeatures(parseWorkspaceSettings(row.settings).ai, info);
  return features.updateDraft || features.qaAnswer ? { info, features } : null;
}

/**
 * The vendors THIS workspace connected itself: e-sign, integrations and accreditation through
 * each kernel's own service, then module egress. A connection counts whatever its health (a
 * degraded one has still sent the vendor data). Reads run one after another — never more than
 * one pool connection — and must be called OUTSIDE any transaction.
 */
export async function workspaceVendorsOf(
  src: WorkspaceVendorSources,
  tenant: TenantContext,
): Promise<SubProcessorMeta[]> {
  const out: SubProcessorMeta[] = [];
  const esign = await src.esign.connectionDetail(tenant);
  if (esign !== undefined) {
    const driver = src.esign.drivers().find((d) => d.meta.driver === esign.driver);
    out.push(
      driver === undefined
        ? { name: esign.displayName, ...ESIGN_FALLBACK }
        : fromESignSubProcessor(driver.meta.subProcessor),
    );
  }
  const integrations = await src.integrations.list(tenant);
  if (integrations.length > 0) {
    const providers = src.integrations.providers();
    for (const connection of integrations) {
      const provider = providers.find((p) => p.provider === connection.provider);
      if (provider !== undefined) out.push(fromIntegrationSubProcessor(provider.subProcessor));
    }
  }
  const accreditation = await src.accreditation.connection(tenant);
  if (accreditation !== undefined) {
    const provider = src.accreditation
      .providers()
      .find((p) => p.meta.driver === accreditation.driver);
    if (provider !== undefined) out.push(fromAccreditationSubProcessor(provider.meta.subProcessor));
  }
  out.push(...(await moduleEgressOf(src.db, tenant.workspaceId)));
  // E3.12: a third-party AI provider, while this workspace has AI assist effectively on (a
  // self-hosted model is operator-run: no row).
  const ai = aiWorkspaceSubProcessorOf(
    (await aiProviderInUse(src, tenant.workspaceId))?.info ?? null,
  );
  if (ai !== null) out.push(ai);
  return out;
}

/** Workspace-scope rows, minus anything the deployment already lists (same name + purpose). */
export function workspaceScopeOf(
  deployment: DeploymentResidency,
  own: readonly SubProcessorMeta[],
): ResidencySubProcessor[] {
  const seen = new Set(deployment.subProcessors.map((s) => `${s.name}\u0000${s.purpose}`));
  const out: ResidencySubProcessor[] = [];
  for (const meta of own) {
    const key = `${meta.name}\u0000${meta.purpose}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(toResidencySubProcessor(meta, "workspace", deployment.region));
  }
  return out;
}

/**
 * `residencyTemplateFields` plus `workspaceSubProcessors` (the tenant's own notices list the
 * vendors it connected) and `aiAssist` (E3.12: `null` unless the workspace has AI assist
 * effectively on). Reads the workspace's connections: call OUTSIDE any transaction.
 */
export async function residencyTemplateFieldsFor(
  src: ResidencySources & WorkspaceVendorSources,
  tenant: TenantContext,
): Promise<
  ReturnType<typeof residencyTemplateFields> & {
    workspaceSubProcessors: SubProcessorRow[];
    aiAssist: AiAssistFacts;
  }
> {
  const deployment = deploymentResidency(src);
  // The notice lists the AI provider once, under the host's sub-processors (the host chose it),
  // and its AI assist paragraph points there: not again under "providers we connected ourselves".
  const own = workspaceScopeOf(deployment, await workspaceVendorsOf(src, tenant)).filter(
    (s) => s.purpose !== AI_WORKSPACE_PURPOSE,
  );
  const ai = await aiProviderInUse(src, tenant.workspaceId);
  return {
    ...residencyTemplateFields(src),
    workspaceSubProcessors: subProcessorRowsOf(own),
    aiAssist:
      ai === null
        ? null
        : aiAssistFactsOf(ai.info, ai.features, src.residency.aiResultRetentionHours),
  };
}
