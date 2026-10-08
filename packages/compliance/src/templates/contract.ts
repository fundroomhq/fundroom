/*
 * The shipped-template contract (`templates/README.md`, design/04 §7, R18).
 *
 * These types are the TypeScript half of a contract whose other half lives in
 * `scripts/build-templates.mjs`: the script validates the Markdown against it at build time, this
 * file describes the result to the rest of the package. The two must move together — a new merge
 * field means editing the README, the script's `MERGE_FIELDS` and `TemplateContext` in one change.
 */

import type { AiAssistFacts, ResidencyComponent, ResidencyRegion } from "../residency.js";

/** Where a document surfaces. Wider than the database's `legal_audience`; `audienceToLegal` maps it. */
export const TEMPLATE_AUDIENCES = ["investor", "tenant-admin", "host", "public", "repo"] as const;
export type TemplateAudience = (typeof TEMPLATE_AUDIENCES)[number];

/** Metadata parsed from a template's YAML frontmatter. */
export interface TemplateMeta {
  /** Stable, kebab-case, unique. Acceptances and overrides are keyed against it, so it never changes. */
  readonly id: string;
  /** Bumped only for a substantive change; a bump re-prompts everyone who accepted an earlier one. */
  readonly version: number;
  readonly title: string;
  readonly audience: TemplateAudience;
  /** Lowercase codes, or `["global"]` for "not jurisdiction-specific". */
  readonly jurisdiction: readonly string[];
  readonly requiresAcceptance: boolean;
  /** Exactly the merge fields the body uses — the generator cross-checks both directions. */
  readonly mergeFields: readonly string[];
}

/** A template as compiled into `src/generated/templates.ts`: metadata plus the Markdown body. */
export interface ShippedTemplate extends TemplateMeta {
  /** The body with the frontmatter stripped, starting at the counsel-review banner. */
  readonly body: string;
  /** Hex sha256 of `body`, so the drift test can compare without diffing prose. */
  readonly bodySha256: string;
}

/** A row of the `{{subProcessors}}` table, one per configured adapter that touches personal data. */
export interface SubProcessorRow {
  readonly provider: string;
  readonly purpose: string;
  /** The categories it can see, in plain words. */
  readonly dataProcessed: string;
  readonly location: string;
  /** Adequacy, SCCs plus the UK addendum, or "not applicable". */
  readonly transferMechanism?: string | undefined;
}

/**
 * The `{{dataLocation}}` block (E3.11): the declared region and where each component of the
 * service keeps data. Operator-declared facts; `region: null` renders a plain "not declared"
 * statement rather than an empty sentence.
 */
export interface DataLocation {
  readonly region: ResidencyRegion | null;
  readonly components: readonly ResidencyComponent[];
}

/** A row of the `{{retention}}` table, one per record class the deployment actually keeps. */
export interface RetentionRow {
  readonly recordClass: string;
  readonly covers?: string | undefined;
  readonly retention: string;
  /** Why that period, in one clause. */
  readonly basis?: string | undefined;
}

/**
 * Everything a template may interpolate. Every scalar is optional on purpose: `company.dpoEmail`
 * and `host.operator` are frequently unset, and the README's first rule is that a template must
 * still read correctly when a field renders empty. `renderTemplate` never prints `undefined` or
 * a leftover `{{...}}`.
 */
export interface TemplateContext {
  readonly company?: {
    readonly name?: string | undefined;
    readonly legalName?: string | undefined;
    readonly jurisdiction?: string | undefined;
    readonly address?: string | undefined;
    readonly contactEmail?: string | undefined;
    readonly dpoEmail?: string | undefined;
  };
  readonly portal?: {
    readonly url?: string | undefined;
    readonly name?: string | undefined;
  };
  readonly workspace?: {
    /** The declared region's label, else its code; unset when the operator declared none. */
    readonly dataRegion?: string | undefined;
    /** `none | informational | 506b | 506c | non_us`. */
    readonly offeringStatus?: string | undefined;
  };
  readonly host?: {
    readonly operator?: string | undefined;
    readonly isManaged?: boolean | undefined;
  };
  /** The deployment's (the operator's) sub-processors: what the operator's DPA lists. */
  readonly subProcessors?: readonly SubProcessorRow[] | undefined;
  /**
   * E3.11: vendors THIS workspace connected itself (e-sign, integrations, accreditation, Slack
   * webhooks, Google Sheets). The tenant's own notices list them; the operator's DPA does not.
   */
  readonly workspaceSubProcessors?: readonly SubProcessorRow[] | undefined;
  readonly retention?: readonly RetentionRow[] | undefined;
  /** E3.11: absent renders the "not declared" statement, like `region: null`. */
  readonly dataLocation?: DataLocation | undefined;
  /**
   * E3.12: AI assist as THIS workspace uses it — `null` or absent = not turned on (or no model
   * configured), which renders a plain "not turned on" statement.
   */
  readonly aiAssist?: AiAssistFacts | undefined;
  /** An ISO date (`2026-09-12`) or a `Date`; a `Date` renders as its UTC calendar day. */
  readonly effectiveDate?: string | Date | undefined;
  readonly version?: number | undefined;
}

/** Raised when a template breaks the contract at runtime (a custom body, not a shipped one). */
export class TemplateError extends Error {
  override readonly name = "TemplateError";
  constructor(
    readonly code: "unknown_template" | "unknown_field",
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}
