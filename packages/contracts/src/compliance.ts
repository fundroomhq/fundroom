import { z } from "@hono/zod-openapi";
import { page, paginationQuery, TimestampSchema, trimmedText, UuidSchema } from "./schemas.js";

/*
 * Offering mode and the legal kernel (E1.6, ADR-0037, EXECUTION_PLAN §11, design/04 §1.6/§2/§4).
 *
 * Handlers live in `apps/server/src/routes/compliance.ts` — these are kernel routes behind a
 * `required` manifest, not a module package, because the offering status is a workspace column,
 * the relationship facts are membership columns and an acceptance is a `core.attestation` row.
 * The services are `@fundroom/compliance`.
 *
 * The enum values are spelled out here rather than imported from `@fundroom/db`: this package
 * has no `@fundroom/*` dependencies on purpose, so the generated SDK is buildable from the contract
 * alone. The database enums are the authority; a drift shows up as a compile error in the route.
 */

export const OfferingStatusSchema = z
  .enum(["none", "informational", "506b", "506c", "non_us"])
  .openapi({ description: "Rule the workspace is relying on", example: "506b" });

export const LegalDocumentKindSchema = z.enum([
  "privacy_notice",
  "nda",
  "terms",
  "disclaimer",
  "accreditation",
  "cookie_notice",
  "accessibility_statement",
]);

/** Who the document is put in front of. Narrower than the template library's five audiences. */
export const LegalAudienceSchema = z.enum(["external", "staff", "all"]);

export const ConsentPurposeSchema = z.enum(["analytics_engagement", "email_tracking"]);
export const ConsentSourceSchema = z.enum(["gate", "settings", "gpc", "host_cmp", "admin"]);

export const RelationshipSourceSchema = z.enum([
  "founder_invite",
  "intro",
  "prior_investor",
  "event",
  "other",
]);

// --- offering mode ----------------------------------------------------------------------------

export const OfferingPermitsSchema = z
  .object({
    status: OfferingStatusSchema,
    /** May the round / terms module be enabled at all? */
    roundAndTerms: z.boolean(),
    /** May a section be published to unauthenticated readers? */
    publicSections: z.boolean(),
    /** May share links be issued? (Always identity-bound; this is about issuing them at all.) */
    shareLinks: z.boolean(),
    /** Must an investor be verified as accredited before an indication of interest is taken? */
    accreditationRequired: z.boolean(),
    /** May a verified access request be auto-approved by email domain (E3.1)? Never under 506(b). */
    requestAutoApprove: z.boolean(),
    /** One sentence an admin can read without a lawyer. */
    explanation: z.string(),
  })
  .openapi("OfferingPermits");

export const OfferingPeriodSchema = z
  .object({
    id: UuidSchema,
    status: OfferingStatusSchema,
    startedAt: TimestampSchema,
    /** `null` on the open period — the status in force right now. */
    endedAt: TimestampSchema.nullable(),
    /** Membership that made the change; `null` for the period opened when recording began. */
    changedBy: UuidSchema.nullable(),
    reason: z.string().nullable(),
  })
  .openapi("OfferingPeriod");

export const OfferingStateSchema = z
  .object({
    status: OfferingStatusSchema,
    /** The open period. A workspace that pre-dates E1.6 gets one opened on first read. */
    current: OfferingPeriodSchema,
    /** Every period, newest first: which status was in force when a document was disclosed. */
    history: z.array(OfferingPeriodSchema),
    /** What the current status permits. */
    permits: OfferingPermitsSchema,
    /** The §11 table for every status, so the admin screen can explain the choice it offers. */
    table: z.array(OfferingPermitsSchema),
    /** True once the workspace relies on 506(c): the status can no longer be changed. */
    irrevocable: z.boolean(),
  })
  .openapi("OfferingState");

export const OfferingPatchBody = z.object({
  status: OfferingStatusSchema,
  reason: z.string().trim().max(500).optional(),
  /**
   * Echo the status back here to confirm an irrevocable move. Without it the switch to 506(c)
   * answers 409 `conflict` and writes nothing.
   */
  confirm: OfferingStatusSchema.optional(),
});

export const OfferingChangeResultSchema = z
  .object({
    from: OfferingStatusSchema,
    to: OfferingStatusSchema,
    current: OfferingPeriodSchema,
    permits: OfferingPermitsSchema,
    irrevocable: z.boolean(),
  })
  .openapi("OfferingChangeResult");

// --- the shipped template library --------------------------------------------------------------

export const LegalTemplateSchema = z
  .object({
    id: z.string().openapi({ example: "privacy-notice" }),
    /** Bumped only for a substantive change; a bump re-prompts everyone who accepted an earlier one. */
    version: z.number().int().positive(),
    title: z.string(),
    /** Where the template surfaces (`investor`, `tenant-admin`, `host`, `public`, `repo`). */
    audience: z.enum(["investor", "tenant-admin", "host", "public", "repo"]),
    /** Lowercase codes, or `["global"]` for "not jurisdiction-specific". */
    jurisdiction: z.array(z.string()),
    requiresAcceptance: z.boolean(),
    mergeFields: z.array(z.string()),
    /** Hex sha256 of the shipped body, so a tenant can tell an upstream bump from their own edit. */
    bodySha256: z.string(),
  })
  .openapi("LegalTemplate");

export const LegalTemplateListSchema = z
  .object({ templates: z.array(LegalTemplateSchema) })
  .openapi("LegalTemplateList");

export const LegalTemplateDetailSchema = z
  .object({
    template: LegalTemplateSchema,
    /** The Markdown with `{{merge.field}}` placeholders left in, exactly as shipped. */
    body: z.string(),
    /** The same body rendered against this workspace's facts: what `from: <id>` would publish. */
    preview: z.string(),
  })
  .openapi("LegalTemplateDetail");

export const TemplateIdParam = z.object({
  templateId: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/u)
    .openapi({ example: "privacy-notice" }),
});

// --- tenant legal documents ---------------------------------------------------------------------

/**
 * How a member accepts a legal document (E3.5, ADR-0053): `clickwrap` ("I agree", recorded by
 * `POST /compliance/acceptances`) or `esign` (a signed envelope at the workspace's e-sign vendor,
 * started by `POST /esign/nda/start`; click-wrap is then refused with 409 `esign_required`).
 */
export const LegalCeremonySchema = z.enum(["clickwrap", "esign"]).openapi({
  description:
    "`clickwrap`: accepted by clicking 'I agree'. `esign`: accepted only by signing an envelope at the workspace's e-sign vendor (click-wrap is refused with 409 `esign_required`). Setting `esign` needs an active e-sign connection (409 `esign_not_configured`).",
  example: "clickwrap",
});

export const LegalDocumentSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9-]{0,62}$/u)
  .openapi({ example: "privacy-notice" });

export const LegalDocumentSchema = z
  .object({
    id: UuidSchema,
    slug: LegalDocumentSlugSchema,
    title: z.string(),
    kind: LegalDocumentKindSchema,
    audience: LegalAudienceSchema,
    /** Members covered by `audience` must accept the current version before anything else. */
    requiresAcceptance: z.boolean(),
    ceremony: LegalCeremonySchema,
    templateId: z.string().nullable(),
    templateVersion: z.number().int().nullable(),
    currentVersionNo: z.number().int().nullable(),
    /** `<slug>:v<n>` for the current version; `null` before the first publish. */
    stamp: z.string().nullable(),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
  })
  .openapi("LegalDocument");

export const LegalDocumentVersionSchema = z
  .object({
    id: UuidSchema,
    versionNo: z.number().int().positive(),
    /** The Markdown exactly as it was published, and exactly as an acceptance names it. */
    body: z.string(),
    /** Hex sha256 of `body`: the click-wrap evidence (design/04 §4). */
    bodySha256: z.string(),
    source: z.enum(["template", "custom"]),
    templateId: z.string().nullable(),
    templateVersion: z.number().int().nullable(),
    summary: z.string().nullable(),
    effectiveAt: TimestampSchema,
    publishedAt: TimestampSchema,
    createdBy: UuidSchema.nullable(),
  })
  .openapi("LegalDocumentVersion");

export const LegalDocumentListSchema = z
  .object({ documents: z.array(LegalDocumentSchema) })
  .openapi("LegalDocumentList");

export const LegalDocumentDetailSchema = z
  .object({
    document: LegalDocumentSchema,
    /** The published version being served; absent until the first publish. */
    current: z.union([LegalDocumentVersionSchema, z.null()]),
    versions: z.array(LegalDocumentVersionSchema),
  })
  .openapi("LegalDocumentDetail");

export const LegalDocumentVersionListSchema = z
  .object({ versions: z.array(LegalDocumentVersionSchema) })
  .openapi("LegalDocumentVersionList");

/**
 * Merge-field values for a template render. Every field is optional: a template must still read
 * correctly when a field renders empty, and the route fills the workspace's own facts in first.
 */
export const TemplateContextBody = z.object({
  company: z
    .object({
      name: z.string().max(200).optional(),
      legalName: z.string().max(200).optional(),
      jurisdiction: z.string().max(120).optional(),
      address: z.string().max(500).optional(),
      contactEmail: z.string().max(320).optional(),
      dpoEmail: z.string().max(320).optional(),
    })
    .optional(),
  portal: z
    .object({ url: z.string().max(2048).optional(), name: z.string().max(200).optional() })
    .optional(),
  /** An ISO calendar day (`2026-09-12`). */
  effectiveDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u)
    .optional(),
});

export const LegalDocumentCreateBody = z.object({
  slug: LegalDocumentSlugSchema,
  title: trimmedText({ min: 1, max: 200 }).optional(),
  kind: LegalDocumentKindSchema.optional(),
  audience: LegalAudienceSchema.optional(),
  requiresAcceptance: z.boolean().optional(),
  ceremony: LegalCeremonySchema.optional(),
  /** Seed and publish the first version from a shipped template (`GET /compliance/templates`). */
  from: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,62}$/u)
    .optional(),
  context: TemplateContextBody.optional(),
  /** A body of the tenant's own. Ignored when `from` is set; no first version without either. */
  body: z.string().max(400_000).optional(),
});

export const LegalDocumentPatchBody = z.object({
  title: trimmedText({ min: 1, max: 200 }).optional(),
  kind: LegalDocumentKindSchema.optional(),
  audience: LegalAudienceSchema.optional(),
  requiresAcceptance: z.boolean().optional(),
  ceremony: LegalCeremonySchema.optional(),
});

export const LegalVersionPublishBody = z.object({
  body: z.string().min(1).max(400_000),
  summary: z.string().trim().max(500).optional(),
  effectiveAt: TimestampSchema.optional(),
});

export const LegalPublishResultSchema = z
  .object({
    document: LegalDocumentSchema,
    version: LegalDocumentVersionSchema,
    /**
     * False when the body was byte-identical to the current version: nothing was written and
     * nobody has to accept anything again.
     */
    published: z.boolean(),
  })
  .openapi("LegalPublishResult");

// --- acceptances ---------------------------------------------------------------------------------

/** A document this member still owes, with the exact text they will be recorded as accepting. */
export const PendingAcceptanceSchema = z
  .object({
    documentId: UuidSchema,
    slug: LegalDocumentSlugSchema,
    title: z.string(),
    kind: LegalDocumentKindSchema,
    versionNo: z.number().int().positive(),
    /** `<slug>:v<n>` — the attestation kind the acceptance is recorded under. */
    stamp: z.string(),
    body: z.string(),
    bodySha256: z.string(),
    effectiveAt: TimestampSchema,
    /** Which UI to show: `esign` documents are signed via `POST /esign/nda/start`, not accepted. */
    ceremony: LegalCeremonySchema,
    /**
     * For an `esign` document while the workspace's e-sign vendor is connected: who the member will
     * sign with ("Sign with Documenso"). `null` for click-wrap documents, and for an `esign`
     * document whose connection has gone (the member cannot proceed until an admin reconnects).
     */
    esign: z.union([
      z.object({
        driver: z.enum(["documenso", "docuseal", "docusign", "dropbox-sign"]),
        displayName: z.string(),
      }),
      z.null(),
    ]),
    /**
     * What the document gates. `workspace`: the whole portal (a `requires_acceptance` document —
     * the interstitial and the share-link landing show these). `resource`: named by a live `nda`
     * access gate on a folder, document or link that the member has not satisfied; it blocks only
     * that resource, so the interstitial must ignore it and the unlock sheet shows it. Only
     * `GET /compliance/gates` lists `resource` documents; the bootstrap never does.
     */
    scope: z.enum(["workspace", "resource"]),
  })
  .openapi("PendingAcceptance");

export const PendingAcceptanceListSchema = z
  .object({ pending: z.array(PendingAcceptanceSchema) })
  .openapi("PendingAcceptanceList");

/**
 * A category id as the service stores it: dotted lower-case segments (`us.income`, `uk.hnw`).
 *
 * Deliberately a *shape* rather than an enum of the shipped ids (E2.3 decision D5, design/04
 * §1.5). Rule 501(a)'s list has been amended twice in five years and the UK's thresholds moved in
 * 2024; a tenant whose counsel added a category to their own copy of the questionnaire must not
 * lose the answer to a closed union in a TypeScript file. `@fundroom/compliance` re-parses this
 * with the same rule and owns the shipped set.
 */
const AccreditationCategoryIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}$/u);

/**
 * What the signer said about their accredited status (E2.3 decision D5).
 *
 * Sent only with an `accreditation` document, and ignored rather than rejected on any other:
 * which document kind asks the question is the server's business, not the client's. `categories`
 * may be empty — "none of these apply" is a real answer, and one the 506(b) path acts on.
 */
export const AccreditationAnswersBody = z
  .object({
    categories: z.array(AccreditationCategoryIdSchema).max(40),
    /** Which regime's section of the form was completed. */
    section: z.enum(["us", "uk", "eu", "ca"]).optional(),
    /** The free-text sophistication statement 506(b) asks of a non-accredited purchaser. */
    note: z.string().max(4000).optional(),
    /** Version of the question set the answers were collected under. */
    questionnaireVersion: z.number().int().min(1).optional(),
  })
  // Strict on its own account: `jsonBody()` strictens only the top-level object, and
  // `@fundroom/compliance` re-parses these answers with a `.strict()` schema of its own, so an
  // unknown key here would be a 400 from the service rather than from the request validator.
  .strict()
  .openapi("AccreditationAnswers");

export const AcceptanceBody = z.object({
  documentId: UuidSchema,
  /** The version the member was shown. Rejected when it is no longer the current one. */
  versionNo: z.number().int().positive(),
  /**
   * The name the signer typed into the click-wrap card, if the card asked for one (design/04
   * §4.3 lists it as identity evidence). It reaches `CertificateDocument.signer.typedName` and
   * nothing else — it is never used to name the account, because what a signer types under a
   * legal text is evidence about that signature and not a profile edit.
   */
  typedName: z.string().max(200).optional(),
  /**
   * The accreditation questionnaire's answers. Required in practice for an `accreditation`
   * document, because without them the dated `accredited` attestation — the row the `accredited`
   * gate actually reads — is never written; harmless on any other document.
   *
   * There is deliberately **no** `viaLinkId` here. Which share link a signer came in through is a
   * fact the server already holds (`core.share_link_visit`), and a client-supplied one would be a
   * claim about provenance made by the one party with an interest in what it says — the same
   * reason correction C2 keeps `bodySha256` off the wire.
   */
  accreditation: AccreditationAnswersBody.optional(),
});

export const AcceptanceResultSchema = z
  .object({
    stamp: z.string(),
    acceptedAt: TimestampSchema,
    /** False when this version was already held: a retry or a double click, not a second row. */
    recorded: z.boolean(),
    /** What is still outstanding after this acceptance; empty means the gate is clear. */
    pending: z.array(PendingAcceptanceSchema),
  })
  .openapi("AcceptanceResult");

/** One row of the acceptance register: who accepted what, when, and over which bytes. */
export const AcceptanceEntrySchema = z
  .object({
    membershipId: UuidSchema,
    displayName: z.string(),
    email: z.string().nullable(),
    documentId: UuidSchema,
    slug: LegalDocumentSlugSchema,
    versionNo: z.number().int().positive(),
    stamp: z.string(),
    bodySha256: z.string().nullable(),
    acceptedAt: TimestampSchema,
    evidenceRef: z.string().nullable(),
  })
  .openapi("AcceptanceEntry");

export const AcceptanceRegisterQuery = z.object({
  documentId: UuidSchema.optional(),
  slug: LegalDocumentSlugSchema.optional(),
  membershipId: UuidSchema.optional(),
  ...paginationQuery(200).shape,
});

export const AcceptanceRegisterSchema = page(AcceptanceEntrySchema, "AcceptanceRegister");

/**
 * The export counsel is handed (design/04 §1.6 "exportable … for counsel", §7).
 *
 * The whole register in one file rather than a page of it: an evidence export that stopped at
 * the first hundred rows would be worse than none, because nobody reading it would know. The
 * server bounds it at `MAX_REGISTER_ROWS`; the same three filters narrow it.
 *
 * `csv` is RFC 4180 with CRLF line endings and a UTF-8 BOM (so Excel does not mangle a
 * non-ASCII slug), and every field that begins `=`, `+`, `-` or `@` is prefixed with an
 * apostrophe, because a tenant-controlled slug is otherwise a formula in three spreadsheet
 * programs. `json` is the same rows, same order, with the filter and a generation timestamp.
 *
 * The *signed* PDF/CSV bundle is deliberately not here: signing an export needs the audit
 * chain's own signature over it, which is E2.7's signed audit export, and it should be built on
 * top of these two rather than beside them.
 */
export const AcceptanceRegisterExportQuery = z.object({
  documentId: UuidSchema.optional(),
  slug: LegalDocumentSlugSchema.optional(),
  membershipId: UuidSchema.optional(),
  format: z.enum(["csv", "json"]).default("csv"),
});

/**
 * Which rendering of a click-wrap certificate to serve (E2.3, ADR-0041 D2).
 *
 * The **JSON is canonical** and the PDF is a rendering of it: pdf-lib stamps `ModDate` from the
 * wall clock and assigns object ids in insertion order, so a PDF's sha256 is not reproducible
 * and must never be the hashed object. `certificateSha256` on the audit chain is the digest of
 * the canonical JSON, and the PDF prints it.
 */
export const CertificateFormatQuery = z.object({
  /** `<slug>:v<n>`, exactly as the acceptance recorded it. */
  stamp: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*:v[1-9][0-9]*$/u, "<slug>:v<n>")
    .openapi({ example: "nda:v2" }),
  format: z.enum(["json", "pdf"]).default("pdf"),
});

export const MembershipIdParam = z.object({ membershipId: UuidSchema });

// --- consent --------------------------------------------------------------------------------------

export const ConsentPurposeStateSchema = z
  .object({
    purpose: ConsentPurposeSchema,
    /** The member's own stored answer: `true`, `false`, or `null` when never asked. */
    granted: z.boolean().nullable(),
    source: z.union([ConsentSourceSchema, z.null()]),
    recordedAt: TimestampSchema.nullable(),
    /**
     * The folded decision: the workspace's consent mode, the stored answer and this request's
     * Global Privacy Control signal. This is the authority — never re-derive it on the client.
     */
    allowed: z.boolean(),
  })
  .openapi("ConsentPurposeState");

export const ConsentStateSchema = z
  .object({
    consentMode: z.enum(["opt_in", "opt_out", "notice_only"]),
    /** Whether this request carried `Sec-GPC: 1`. GPC always means no, in every mode. */
    gpc: z.boolean(),
    purposes: z.array(ConsentPurposeStateSchema),
  })
  .openapi("ConsentState");

export const ConsentPutBody = z.object({
  purpose: ConsentPurposeSchema,
  granted: z.boolean(),
  /**
   * Where the member answered. A request carrying `Sec-GPC: 1` is recorded as `gpc` regardless.
   *
   * `host_cmp` is the embed case (E2.2): inside an iframe the portal shows no consent UI of its
   * own (plan §11), so the answer comes from the host site's consent manager over the bridge.
   * It was already a legal value of the *stored* enum and was missing only here, which meant a
   * host-CMP answer could be recorded only by claiming the member had chosen it in their own
   * settings — a false statement in a register whose entire purpose is to say who consented to
   * what, where. The server still folds GPC over the top of it, so this widens what the register
   * can describe, never what it will accept as a grant.
   */
  source: z.enum(["settings", "gate", "host_cmp"]).default("settings"),
});

// --- workspace legal settings -----------------------------------------------------------------------

export const ConsentModeSchema = z.enum(["opt_in", "opt_out", "notice_only"]);
export const PrivacyRegionSchema = z.enum(["eu", "uk", "us", "other"]);

export const ComplianceSettingsSchema = z
  .object({
    consentMode: ConsentModeSchema,
    /**
     * Which privacy regime the workspace's investors are mostly under (E2.6). `null` = not said,
     * and the strict default stands.
     */
    privacyRegion: PrivacyRegionSchema.nullable(),
    /** While on, erasure requests are refused (409, `reason: "legal_hold"`). */
    legalHold: z.boolean(),
    enforceAcceptance: z.boolean(),
    relationshipWarningDays: z.number().int().min(0).max(365),
    defaultDisclaimerSlug: z.string().nullable(),
    /** The mode the region points at: EU `opt_in`, UK `opt_out`, US `notice_only`, else `opt_in`. */
    suggestedConsentMode: ConsentModeSchema,
    /**
     * `consentMode` is less protective than `suggestedConsentMode` (opt_in > opt_out >
     * notice_only). A warning for the settings screen; the server never corrects the mode itself.
     */
    consentModeWeakerThanRegion: z.boolean(),
  })
  .openapi("ComplianceSettings");

export const ComplianceSettingsPatchBody = z.object({
  consentMode: ConsentModeSchema.optional().openapi({
    description:
      "Sent with `privacyRegion`, the admin's mode stands (and `consentModeWeakerThanRegion` says whether it is weaker than the region's suggestion). Omitted while `privacyRegion` changes, the mode becomes the region's suggestion.",
  }),
  privacyRegion: z.union([PrivacyRegionSchema, z.null()]).optional(),
  legalHold: z.boolean().optional(),
  enforceAcceptance: z.boolean().optional(),
  relationshipWarningDays: z.number().int().min(0).max(365).optional(),
  defaultDisclaimerSlug: z.union([LegalDocumentSlugSchema, z.null()]).optional(),
});

// --- DSAR erasure requests (E2.6 decision 5) ---------------------------------------------------------

export const ErasureStatusSchema = z.enum(["requested", "completed", "cancelled"]);

export const ErasureStepSchema = z
  .object({
    module: z.string(),
    completedAt: TimestampSchema,
    /** Rows removed or pseudonymised, by table — numbers only. */
    counts: z.record(z.string(), z.number().int().min(0)),
    /** Whether the module was among those the request waited for. */
    expected: z.boolean(),
  })
  .openapi("ErasureStep");

export const ErasureRequestSchema = z
  .object({
    id: UuidSchema,
    membershipId: UuidSchema,
    /** The member's display name while the membership still exists; `null` once it does not. */
    memberName: z.string().nullable(),
    requestedBy: UuidSchema.nullable(),
    requestedAt: TimestampSchema,
    /** Statutory deadline: +30 days (EU/UK/other/unset) or +45 days (US). */
    dueAt: TimestampSchema,
    /** Still `requested` past `dueAt`. */
    overdue: z.boolean(),
    status: ErasureStatusSchema,
    /** Modules the request waits for, frozen when it was made. */
    expectedModules: z.array(z.string()),
    /** Expected modules that have reported. */
    completedModules: z.array(z.string()),
    /** Expected modules that have not. */
    pendingModules: z.array(z.string()),
    steps: z.array(ErasureStepSchema),
    completedAt: TimestampSchema.nullable(),
    cancelledAt: TimestampSchema.nullable(),
    cancelledBy: UuidSchema.nullable(),
    note: z.string().nullable(),
  })
  .openapi("ErasureRequest");

export const ErasureRequestCreateBody = z.object({
  membershipId: UuidSchema,
  /** How the request arrived (email, letter …). Staff-only. */
  note: trimmedText({ min: 1, max: 1000 }).optional(),
});

export const ErasureRequestListQuery = z.object({
  status: ErasureStatusSchema.optional(),
  membershipId: UuidSchema.optional(),
  ...paginationQuery(100).shape,
});

export const ErasureRequestListSchema = page(ErasureRequestSchema, "ErasureRequestList");

export const ErasureRequestIdParam = z.object({ id: UuidSchema });

// --- DSAR: every kind of data-subject request (E2.7) ------------------------------------------------

export const DataRequestKindSchema = z.enum(["erasure", "access", "rectification"]);

export const DataRequestStepSchema = z
  .object({
    /** A module id, or `core.identity` for the kernel's own final erasure step. */
    module: z.string(),
    completedAt: TimestampSchema,
    /** Rows removed or pseudonymised, by table — numbers only. */
    counts: z.record(z.string(), z.number().int().min(0)),
  })
  .openapi("DataRequestStep");

export const DataRequestSchema = z
  .object({
    id: UuidSchema,
    kind: DataRequestKindSchema,
    membershipId: UuidSchema,
    /** The member's display name while it exists; `null` once erased or gone. */
    subjectName: z.string().nullable(),
    status: ErasureStatusSchema,
    requestedBy: UuidSchema.nullable(),
    requestedAt: TimestampSchema,
    /** Statutory deadline: +30 days (EU/UK/other/unset) or +45 days (US). */
    dueAt: TimestampSchema,
    /** Still `requested` past `dueAt`. */
    overdue: z.boolean(),
    completedAt: TimestampSchema.nullable(),
    cancelledAt: TimestampSchema.nullable(),
    /** How the request arrived. Staff-only. */
    note: z.string().nullable(),
    /** Written by staff when completing an access or rectification request. */
    completionNote: z.string().nullable(),
    /** sha256 (hex) of the subject export that answered an access request. */
    exportSha256: z.string().nullable(),
    /** Erasure only: the modules the request waits for, frozen when it was made. */
    expectedModules: z.array(z.string()),
    /** Erasure only: expected modules that have not reported yet. */
    pendingModules: z.array(z.string()),
    steps: z.array(DataRequestStepSchema),
    /**
     * Erasure only: every module has reported, but the kernel's identity step cannot run, and
     * why. `last_owner`: the member is now the workspace's only active owner (a co-owner stepped
     * down after the request was made). The request stays open and nothing about the identity is
     * touched; transfer ownership, then `POST /compliance/data-requests/{id}/complete` finishes
     * it. `null` otherwise.
     */
    blockedReason: z.enum(["last_owner"]).nullable(),
  })
  .openapi("DataRequest");

export const DataRequestListQuery = z.object({
  kind: DataRequestKindSchema.optional(),
  status: ErasureStatusSchema.optional(),
  membershipId: UuidSchema.optional(),
  ...paginationQuery(100).shape,
});

export const DataRequestListSchema = page(DataRequestSchema, "DataRequestList");

export const DataRequestCreateBody = z.object({
  /** Erasure keeps its own route (`POST /compliance/erasure-requests`). */
  kind: z.enum(["access", "rectification"]),
  membershipId: UuidSchema,
  /** How the request arrived, what is to be corrected … Staff-only. */
  note: trimmedText({ min: 1, max: 1000 }).optional(),
});

export const DataRequestCompleteBody = z.object({
  note: trimmedText({ min: 1, max: 1000 }).optional(),
  /**
   * Access only: the sha256 (hex) of the subject export handed over — the export's
   * `X-Content-SHA256` header. Must match a `compliance.dsar_exported` audit row for this member
   * in this workspace (409 `export_unknown` otherwise); stored on the request.
   */
  exportSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/u)
    .optional(),
});

export const DataRequestIdParam = z.object({ id: UuidSchema });

// --- the pre-existing relationship (surfaced on the People screen, E1.1's routes) -------------------

export const RelationshipWarningSchema = z
  .object({
    code: z.enum(["no_source", "no_date", "access_too_soon", "exposure_before_relationship"]),
    /** Written for a founder, not a lawyer: what is thin, and what would fix it. */
    message: z.string(),
  })
  .openapi("RelationshipWarning");

export const DocumentIdParam = z.object({ id: UuidSchema });

/**
 * `GET /compliance/accessibility-statement` (E2.8, public): the workspace's published
 * `accessibility_statement` document, else the `accessibility-statement` template rendered with
 * the workspace's facts.
 */
export const AccessibilityStatementSchema = z
  .object({
    source: z.enum(["published", "default"]),
    title: z.string(),
    bodyMarkdown: z.string(),
    effectiveDate: z.iso.date().openapi({ example: "2026-09-23" }),
    version: z.number().int().min(1).nullable().openapi({
      description: "The published version number; null for the default text",
    }),
  })
  .openapi("AccessibilityStatement");
