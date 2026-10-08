import { sha256Hex } from "@fundroom/audit";
import { PrincipalRepo } from "@fundroom/authz";
import {
  type CertificateFactsResolver,
  type CertificateIssuer,
  createCertificateIssuer,
} from "@fundroom/clickwrap";
import {
  type Actor,
  applyLegalSettingsPatch,
  buildSubjectExport,
  type ComplianceErrorCode,
  collectKernelFiles,
  collectModuleFiles,
  consentAllows,
  consentModeWeakerThanRegion,
  createAcceptanceService,
  createConsentService,
  createDataRequestService,
  createDocumentService,
  createErasureService,
  createOfferingService,
  type DataRequestDetail,
  type ErasureRequestDetail,
  ipHashOf,
  isComplianceError,
  isIrrevocableFrom,
  LEGAL_IP_PURPOSE,
  listTemplates,
  permits,
  type RegisterEntry,
  regionConsentDefault,
  registerCsv,
  registerJson,
  renderTemplate,
  type TemplateContext,
  templateById,
  uaFamilyOf,
} from "@fundroom/compliance";
import {
  ApiError,
  type ApiErrorCode,
  compliance as cp,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
  z,
} from "@fundroom/contracts";
import {
  type Database,
  type LegalDocumentVersion,
  lockWorkspaceFacts,
  type Membership,
  type OfferingPeriod,
  systemContext,
  type TenantContext,
  type Tx,
  updateWorkspaceSettingsBlock,
} from "@fundroom/db";
import {
  type LegalSettings,
  parseWorkspaceSettings,
  WorkspaceSettingsSchema,
} from "@fundroom/domain";
import { assertESignConnected, ndaTextProblem } from "@fundroom/esign";
import { AttestationRepo, MembershipRepo } from "@fundroom/identity";
import type { ESignServices } from "@fundroom/module-kit";
import type { ESignDriver } from "@fundroom/ports";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { type AcceptanceGate, requireMember, requirePermission } from "../middleware/authz.js";
import { forgetGpcRefusal } from "../middleware/gpc.js";
import { residencyTemplateFieldsFor } from "../residency/kernel.js";
import { type ApiDeps, clientIp, workspaceUrl } from "./deps.js";

/*
 * Offering mode and the legal kernel (E1.6, ADR-0037, §11, §13.1, design/04).
 *
 * These are kernel routes behind a `required` manifest rather than a module package, for the
 * reason ADR-0037 gives: the offering status is a column on `core.workspace`, the relationship
 * facts are columns on `core.membership`, and an acceptance is a `core.attestation` row. A module
 * reaching into `core.*` would break the rule that makes modules safe to reason about.
 *
 * Two audiences share the file. The staff surfaces (offering mode, the document library, the
 * acceptance register, the workspace's legal settings) are behind `compliance.*` permissions and
 * run in the caller's own staff transaction. The member surfaces — what do I still owe, here is
 * my acceptance, here is my consent answer — run in a `system` transaction: the writes they cause
 * include an audit row, an outbox event and an `acl_version` bump, none of which an external
 * membership may make directly (`core.attestation`'s RLS, tightened in migration 0006, lets an
 * external member insert only its own rows). The member is still the subject of every row.
 *
 * Every route carries `x-requires`, checked against packages/authz/matrix/authz-matrix.yaml in CI.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
/** Document writes that can land on an `esign` ceremony (E3.5 fix B4: 422 when not signable). */
const DOCUMENT_WRITE_ERRORS = errorResponses(400, 401, 403, 404, 409, 422, 429, 500, 503);
const TAGS = ["compliance"];

type Vars = AppEnv["Variables"];
interface Signed {
  readonly session: NonNullable<Vars["session"]>;
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

function signed(c: Context<AppEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!session || !membership || !tenant || !workspace) throw new ApiError("unauthenticated");
  return { session, membership, tenant, workspace };
}

function actorOf(c: Context<AppEnv>, s: Signed): Actor {
  return {
    membershipId: s.membership.id,
    userId: s.session.userId,
    requestId: requestIdOf(c),
    sessionId: s.session.sessionId,
  };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * A `ComplianceError` is already the right vocabulary — its codes were chosen to be a subset of
 * the API's. Two are exceptions and both are translated here rather than cast: an untranslated
 * code would be cast to `ApiErrorCode`, look up `undefined` in `API_ERROR_CODES` and answer with
 * no status at all. `confirmation_required` becomes the 409 that carries what the admin has to
 * confirm (the route reaches it first, so it never gets here); `accreditation_document_missing`
 * becomes `accreditation_unavailable`, E2.5's 409 for "the workspace has published no
 * questionnaire to certify against".
 */
const COMPLIANCE_API_CODE: Partial<Record<ComplianceErrorCode, ApiErrorCode>> = {
  confirmation_required: "conflict",
  accreditation_document_missing: "accreditation_unavailable",
  legal_hold: "conflict",
};

function rethrow(error: unknown): never {
  if (isComplianceError(error)) {
    // E3.5: click-wrap on an e-sign document is its own code, so the portal can switch ceremony.
    if (error.code === "conflict" && error.details["reason"] === "esign_required") {
      throw new ApiError("esign_required", "this document must be signed electronically", {
        reason: "esign_required",
      });
    }
    const code = COMPLIANCE_API_CODE[error.code] ?? (error.code as ApiErrorCode);
    // `legal_hold` is a 409 whose `reason` the settings screen branches on (E2.6 decision 5).
    const details =
      error.code === "legal_hold" ? { ...error.details, reason: "legal_hold" } : error.details;
    throw new ApiError(code, error.message, details);
  }
  throw error;
}

/** The legal settings as the API reports them: stored values plus the region suggestion (E2.6). */
function settingsBody(legal: LegalSettings) {
  return {
    consentMode: legal.consentMode,
    privacyRegion: legal.privacyRegion,
    legalHold: legal.legalHold,
    enforceAcceptance: legal.enforceAcceptance,
    relationshipWarningDays: legal.relationshipWarningDays,
    defaultDisclaimerSlug: legal.defaultDisclaimerSlug,
    suggestedConsentMode: regionConsentDefault(legal.privacyRegion),
    consentModeWeakerThanRegion: consentModeWeakerThanRegion(
      legal.consentMode,
      legal.privacyRegion,
    ),
  };
}

function erasureBody(
  d: ErasureRequestDetail,
  names: ReadonlyMap<string, { displayName: string }>,
  now: Date,
) {
  const r = d.request;
  const reported = new Set(d.steps.map((st) => st.module));
  return {
    id: r.id,
    membershipId: r.membershipId,
    memberName: names.get(r.membershipId)?.displayName ?? null,
    requestedBy: r.requestedBy ?? null,
    requestedAt: r.requestedAt.toISOString(),
    dueAt: r.dueAt.toISOString(),
    overdue: r.status === "requested" && r.dueAt.getTime() < now.getTime(),
    status: r.status,
    expectedModules: [...r.expectedModules],
    completedModules: r.expectedModules.filter((m) => reported.has(m)),
    pendingModules: r.expectedModules.filter((m) => !reported.has(m)),
    steps: d.steps.map((st) => ({
      module: st.module,
      completedAt: st.completedAt.toISOString(),
      counts: { ...(st.counts as Record<string, number>) },
      expected: r.expectedModules.includes(st.module),
    })),
    completedAt: iso(r.completedAt),
    cancelledAt: iso(r.cancelledAt),
    cancelledBy: r.cancelledBy ?? null,
    note: r.note ?? null,
  };
}

/** One data-subject request of any kind on the wire (E2.7). */
function dataRequestBody(
  d: DataRequestDetail,
  names: ReadonlyMap<string, { displayName: string }>,
  now: Date,
) {
  const r = d.request;
  const reported = new Set(d.steps.map((st) => st.module));
  return {
    id: r.id,
    kind: r.kind,
    membershipId: r.membershipId,
    // An erased member's name is '' (0012): report it as absent rather than as an empty name.
    subjectName: nonEmpty(names.get(r.membershipId)?.displayName),
    status: r.status,
    requestedBy: r.requestedBy ?? null,
    requestedAt: r.requestedAt.toISOString(),
    dueAt: r.dueAt.toISOString(),
    overdue: r.status === "requested" && r.dueAt.getTime() < now.getTime(),
    completedAt: iso(r.completedAt),
    cancelledAt: iso(r.cancelledAt),
    note: r.note ?? null,
    completionNote: r.completionNote ?? null,
    exportSha256: r.exportSha256 ?? null,
    expectedModules: [...r.expectedModules],
    pendingModules: r.expectedModules.filter((m) => !reported.has(m)),
    steps: d.steps.map((st) => ({
      module: st.module,
      completedAt: st.completedAt.toISOString(),
      counts: { ...(st.counts as Record<string, number>) },
    })),
    blockedReason: d.blockedReason ?? null,
  };
}

function periodBody(p: OfferingPeriod) {
  return {
    id: p.id,
    status: p.status,
    startedAt: p.startedAt.toISOString(),
    endedAt: iso(p.endedAt),
    changedBy: p.changedBy ?? null,
    reason: p.reason ?? null,
  };
}

function versionBody(v: LegalDocumentVersion) {
  return {
    id: v.id,
    versionNo: v.versionNo,
    body: v.body,
    bodySha256: Buffer.from(v.bodySha256).toString("hex"),
    source: v.source,
    templateId: v.templateId ?? null,
    templateVersion: v.templateVersion ?? null,
    summary: v.summary ?? null,
    effectiveAt: v.effectiveAt.toISOString(),
    publishedAt: v.publishedAt.toISOString(),
    createdBy: v.createdBy ?? null,
  };
}

function documentBody(d: {
  id: string;
  slug: string;
  title: string;
  kind: string;
  audience: string;
  requiresAcceptance: boolean;
  ceremony: "clickwrap" | "esign";
  templateId: string | null;
  templateVersion: number | null;
  currentVersionNo: number | null;
  stamp: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: d.id,
    slug: d.slug,
    title: d.title,
    kind: d.kind as "privacy_notice",
    audience: d.audience as "external",
    requiresAcceptance: d.requiresAcceptance,
    ceremony: d.ceremony,
    templateId: d.templateId,
    templateVersion: d.templateVersion,
    currentVersionNo: d.currentVersionNo,
    stamp: d.stamp,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

/** Who an `esign` document is signed with, when the workspace's vendor is connected. */
export type PendingESignVendor = { driver: ESignDriver; displayName: string } | null;

/**
 * The contract's `PendingAcceptance` (shared with the bootstrap in `kernel.ts`). `vendor` is the
 * workspace's active e-sign connection, if any; it is attached only to `esign` documents.
 * `scope` is `resource` only for the documents `GET /compliance/gates` adds from live `nda` access
 * gates (E3.5 fix B3); everything the portal-wide gate holds is `workspace`.
 */
export function pendingBody(
  p: {
    documentId: string;
    slug: string;
    title: string;
    kind: string;
    versionNo: number;
    stamp: string;
    body: string;
    bodySha256: string;
    effectiveAt: Date;
    ceremony: "clickwrap" | "esign";
  },
  vendor: PendingESignVendor,
  scope: "workspace" | "resource" = "workspace",
) {
  return {
    documentId: p.documentId,
    slug: p.slug,
    title: p.title,
    kind: p.kind as "privacy_notice",
    versionNo: p.versionNo,
    stamp: p.stamp,
    body: p.body,
    bodySha256: p.bodySha256,
    effectiveAt: p.effectiveAt.toISOString(),
    ceremony: p.ceremony,
    esign: p.ceremony === "esign" && vendor !== null ? { ...vendor } : null,
    scope,
  };
}

/**
 * The vendor to name on pending `esign` documents: read only when one is pending (the gate's
 * answer is on the bootstrap's hot path, and almost every workspace has none).
 */
export async function pendingESignVendor(
  esign: Pick<ESignServices, "connection">,
  db: Database,
  ctx: TenantContext,
  pending: readonly { readonly ceremony: "clickwrap" | "esign" }[],
): Promise<PendingESignVendor> {
  if (!pending.some((p) => p.ceremony === "esign")) return null;
  const summary = await db.withTenant(ctx, (tx) => esign.connection(tx, ctx));
  return summary === undefined || summary.status !== "active"
    ? null
    : { driver: summary.driver, displayName: summary.displayName };
}

/**
 * The four facts the frozen `CertificateDocument` needs and the acceptance path cannot carry
 * (contract C2). None of them are things `@fundroom/compliance` knows, and correctly so: the
 * host is a per-request tenancy fact, and the other three live on `core.workspace` /
 * `core.membership`, which `@fundroom/clickwrap` must not query (only `repos/` may touch
 * drizzle). They arrive through this resolver, supplied by the composition root — which is the
 * one place that legitimately knows all four.
 *
 * `host` is the workspace's **own** origin: its verified custom domain when it has one, else the
 * canonical subdomain (E2.1 decision 5). It is on the certificate because "which site was this?"
 * is the first question asked of a six-year-old signature, and a workspace id does not answer it.
 *
 * The signer's address is hashed and never stored (ADR-0036): `emailSha256` is what lets a
 * regulator confirm that a certificate belongs to an address they already hold, and nothing more.
 * A membership with no primary email identity **throws**, and that is the right failure: the
 * whole ceremony is email-verified, so a click-wrap record that could not name the address it was
 * bound to would be evidence of nothing. It rolls the acceptance back with it, which is
 * `issueCertificate`'s documented contract — an acceptance claiming a certificate reference
 * nobody stored is worse evidence than no certificate at all.
 */
function certificateFacts(deps: ApiDeps, s: Signed): CertificateFactsResolver {
  return async (ctx, tx, input) => {
    const who = (await new MembershipRepo(ctx, tx).namesFor([input.membershipId])).get(
      input.membershipId,
    );
    return {
      workspace: {
        id: s.workspace.id,
        name: s.workspace.name,
        host: workspaceUrl(deps.baseUrl, deps.tenancy, s.workspace, "/", deps.basePath).host,
      },
      signer: signerFacts(input.membershipId, who),
    };
  };
}

/**
 * The signer half of `certificateFacts`, pure and exported so the empty-name case has a test.
 *
 * The whole of it is one operator. `MembershipRepo.namesFor` **never answers `null`** for a name:
 * its `displayNameExpr` is `COALESCE(NULLIF(user.display_name, ''), profile->>'displayName', '')`,
 * so a signer nobody has ever named is the **empty string**. Written `?? null`, that empty string
 * survives; `assertValidCertificateDocument` then refuses it (correctly — a certificate naming its
 * signer as `""` is worse evidence than one that says it does not know), the issuer throws inside
 * the acceptance transaction, and the acceptance rolls back as a 500.
 *
 * Every share-link visitor is nameless by construction: `establishFromLink` creates the membership
 * with `profile: {}` against a user the ceremony only ever gave an address. So that 500 was every
 * first NDA for exactly the population this epic exists for, while an *invited* member — whose
 * inviter typed a name — was fine, which is why it survived every other test.
 * `CertificateDocument.signer.displayName` is `string | null` precisely so an unnamed signer is
 * expressible, so the two ways of having no name collapse into the one that is.
 */
export function signerFacts(
  membershipId: string,
  who: { readonly displayName?: string | null; readonly email?: string | null } | undefined,
): { readonly emailSha256: string; readonly displayName: string | null } {
  const email = who?.email;
  if (email === undefined || email === null || email.trim() === "") {
    // Rolls the acceptance back with it, which is `issueCertificate`'s documented contract: the
    // whole ceremony is email-verified, so a click-wrap record that could not name the address it
    // was bound to would be evidence of nothing.
    throw new ApiError("conflict", "this membership has no verified email address to sign with", {
      reason: "no_signer_address",
      membershipId,
    });
  }
  return {
    emailSha256: sha256Hex(email.trim().toLowerCase()),
    displayName: nonEmpty(who?.displayName),
  };
}

/**
 * The share link this signer came in through, if one is still live (E2.3 decision D5, §5.4).
 *
 * `CertificateDocument.acceptance.viaLinkId` answers "how did this person get into the room?",
 * which is the second question asked of a six-year-old signature and one a share-link deployment
 * has to be able to answer. It is derived here and never accepted from the client: the fact lives
 * on `core.share_link_visit`, and a provenance claim supplied by the signer's own browser would
 * be evidence of nothing.
 *
 * `PrincipalRepo` is the reader because it already owns the liveness rule (contract A6: the
 * binding not revoked, the link `active`, not revoked and unexpired) and `Principal.linkIds` is
 * documented newest binding first, which is the link that actually put this document in front of
 * them. Its cost is one `listActive()` for the workspace, which is why this is called on the
 * acceptance path — once per member per document — and nowhere hotter. A member who came in by
 * invitation holds no binding and gets `undefined`, which is the certificate's explicit `null`.
 */
async function liveLinkOf(
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
): Promise<string | undefined> {
  const principal = await new PrincipalRepo(ctx, tx).byId(membershipId);
  return principal?.linkIds[0];
}

/**
 * A trimmed string, or `null` when there is nothing to say.
 *
 * Every optional identity field on the certificate is `string | null`, and the two ways of having
 * no value — an absent row and a column holding `''` — must collapse into the same one. See the
 * comment in `certificateFacts` for what happens when they do not.
 */
function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** One register row on the wire. The display name is joined in per page, never stored on the row. */
function registerItem(
  e: RegisterEntry,
  who: { readonly displayName: string; readonly email: string | null } | undefined,
) {
  return {
    membershipId: e.membershipId,
    displayName: who?.displayName ?? "",
    email: who?.email ?? null,
    documentId: e.documentId,
    slug: e.slug,
    versionNo: e.versionNo,
    stamp: e.stamp,
    bodySha256: e.bodySha256,
    acceptedAt: e.acceptedAt.toISOString(),
    evidenceRef: e.evidenceRef,
  };
}

/**
 * Merge-field values for a template render. The workspace's own facts go in first and the caller
 * may override them, because the name on a legal document is a decision (the legal entity, not
 * the portal's display name) that only the tenant can make.
 */
async function templateContextOf(
  deps: ApiDeps,
  s: Signed,
  given: (typeof cp.TemplateContextBody)["_output"] | undefined,
): Promise<TemplateContext> {
  // Reads this workspace's vendor connections: callers run it OUTSIDE any transaction.
  const residency = await residencyTemplateFieldsFor(deps, s.tenant);
  return {
    company: {
      name: s.workspace.name,
      ...(given?.company ?? {}),
    },
    portal: {
      name: s.workspace.name,
      url: workspaceUrl(deps.baseUrl, deps.tenancy, s.workspace, "/", deps.basePath).href,
      ...(given?.portal ?? {}),
    },
    workspace: {
      offeringStatus: s.workspace.offeringStatus,
      ...(residency.dataRegion === undefined ? {} : { dataRegion: residency.dataRegion }),
    },
    // E3.11: operator-declared facts, never tenant-overridable (the body has no field for them).
    subProcessors: residency.subProcessors,
    workspaceSubProcessors: residency.workspaceSubProcessors,
    dataLocation: residency.dataLocation,
    // E3.12: AI assist as this workspace uses it (operator's provider + the workspace's switch).
    aiAssist: residency.aiAssist,
    ...(given?.effectiveDate === undefined ? {} : { effectiveDate: given.effectiveDate }),
  };
}

export function registerComplianceRoutes(
  api: OpenAPIHono<AppEnv>,
  deps: ApiDeps,
  gate: AcceptanceGate,
): void {
  const perm = (p: string, fresh = false) =>
    requirePermission({ authz: () => deps.authz }, p, { fresh });
  /**
   * Member routes here mount `requireMember()` with **no** gate: these are the four surfaces a
   * blocked member must still reach — what do I owe, here is my acceptance, and the consent
   * question that is deliberately unbundled from it (ADR-0037 decision 6). Everything else in the
   * API, kernel and modules alike, is gated.
   */
  const member = () => requireMember();

  const offering = () => createOfferingService({ db: deps.db, audit: deps.audit });

  // --- accessibility statement (E2.8) -----------------------------------------------------------
  /** When a UUIDv7 was minted (its 48-bit Unix-ms prefix); undefined for any other version. */
  const uuidv7Instant = (id: string): Date | undefined => {
    const hex = id.replaceAll("-", "");
    if (!/^[0-9a-f]{12}7[0-9a-f]{19}$/iu.test(hex)) return undefined;
    return new Date(Number.parseInt(hex.slice(0, 12), 16));
  };
  // Public like the branding theme: the statement must be readable without an account. The
  // workspace is resolved from the host (or the embed path) like every other public endpoint.
  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/accessibility-statement",
      tags: TAGS,
      summary: "The workspace's accessibility statement (public)",
      description:
        'The published `accessibility_statement` legal document when there is one (`source: "published"`), else the `accessibility-statement` template rendered with the workspace\'s facts (`source: "default"`, `version: null`).',
      "x-requires": "public",
      responses: {
        200: jsonResponse(cp.AccessibilityStatementSchema, "The statement"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const workspace = c.get("workspace");
      if (workspace === undefined) throw new ApiError("setup_required");
      const ctx = systemContext(workspace.id);
      const svc = documents();
      /*
       * The workspace's own published statement wins. Only a document of the dedicated kind
       * with a published version counts, and never a staff-only one: this answer goes to
       * anybody who can reach the host, so a draft kept for staff must not surface here.
       * When several qualify (a re-seed, a rename), the most recently changed one serves.
       */
      const published = await deps.db.withTenant(ctx, async (tx) => {
        const candidates = (await svc.list(ctx, tx))
          .filter(
            (d) =>
              d.kind === "accessibility_statement" &&
              d.currentVersionId !== null &&
              d.audience !== "staff",
          )
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        const doc = candidates[0];
        if (doc === undefined) return undefined;
        const version = await svc.version(ctx, tx, doc.id);
        return version === undefined ? undefined : { doc, version };
      });
      c.header("Cache-Control", "public, max-age=300, must-revalidate");
      if (published !== undefined) {
        return c.json(
          {
            source: "published" as const,
            title: published.doc.title,
            bodyMarkdown: published.version.body,
            effectiveDate: published.version.effectiveAt.toISOString().slice(0, 10),
            version: published.version.versionNo,
          },
          200,
        );
      }
      // Else the shipped template, rendered with what the workspace has told us about itself.
      const template = templateById("accessibility-statement");
      if (template === undefined) throw new ApiError("not_found", "no accessibility statement");
      const brand = parseWorkspaceSettings(workspace.settings).branding;
      const name = brand.displayName ?? workspace.name;
      /*
       * The effective date is the day this workspace was created: from then on the portal has
       * been covered by this default text (the shipped template with the workspace's own facts),
       * and until an owner publishes their own statement nothing else governs it. It must be
       * stable — "today" on every request claimed the statement had just changed, every day —
       * and templates carry no date of their own (only `version`, which the body shows next
       * to it, so a revised template in a later release is still visible as a new version).
       *
       * The creation instant is read from the workspace id, with no query: every workspace id
       * is a UUIDv7 (`core.uuidv7()` on insert, `uuidv7()` on import), whose first 48 bits are
       * the Unix milliseconds it was minted at. An id that is not v7 (none should exist) falls
       * back to today rather than inventing a date.
       */
      const effectiveDate = (uuidv7Instant(workspace.id) ?? new Date()).toISOString().slice(0, 10);
      return c.json(
        {
          source: "default" as const,
          title: template.title,
          bodyMarkdown: renderTemplate(template, {
            company: {
              name,
              legalName: name,
              ...(brand.supportEmail === null ? {} : { contactEmail: brand.supportEmail }),
            },
            portal: {
              name,
              url: workspaceUrl(deps.baseUrl, deps.tenancy, workspace, "/", deps.basePath).href,
            },
            workspace: { offeringStatus: workspace.offeringStatus },
            effectiveDate,
          }),
          effectiveDate,
          version: null,
        },
        200,
      );
    },
  );
  const documents = () => createDocumentService({ db: deps.db, audit: deps.audit });

  /**
   * E3.5 fix B4: a document whose ceremony is `esign` must be something the vendor can sign as
   * written. Checked on the document as it stands *after* a create, patch or publish, inside the
   * same transaction (a throw rolls the write back), so every route that can reach the state is
   * covered by one rule:
   *  - only an `nda` is signed at the vendor (422 `esign_ceremony_unsupported`) — the e-sign
   *    ceremony exists to close the NDA gate, and a privacy notice or terms "signed" through it
   *    would record the wrong kind of evidence;
   *  - its title and current text must render in the PDF unchanged (422
   *    `esign_nda_text_unsupported`): the NDA PDF uses a base-14 font, and a character it cannot
   *    draw would make the signed document differ from the legal text. Never sign altered text.
   */
  async function assertSignable(ctx: TenantContext, tx: Tx, documentId: string): Promise<void> {
    const doc = await documents().read(ctx, tx, documentId);
    if (doc.ceremony !== "esign") return;
    if (doc.kind !== "nda") {
      throw new ApiError(
        "esign_ceremony_unsupported",
        "only an NDA can be signed at the e-sign vendor",
        { reason: "not_nda_document", kind: doc.kind },
      );
    }
    const problem = ndaTextProblem({ title: doc.title, body: doc.current?.body ?? "" });
    if (problem !== undefined) {
      throw new ApiError(
        "esign_nda_text_unsupported",
        "the NDA contains characters the signing PDF cannot show unchanged",
        { reason: "unsupported_characters", field: problem.field, characters: problem.characters },
      );
    }
  }
  /*
   * The click-wrap certificate issuer (E2.3, ADR-0041 D1/D2), wired here rather than in the
   * container for one reason: `CertificateFacts.workspace.host` is a *per-request* tenancy fact.
   * It is the origin this request resolved on — the workspace's verified custom domain when it
   * has one, else the canonical subdomain — and six years later "which site was this?" is the
   * first question asked of a certificate, so it must be the host that was actually used, not a
   * host recomputed from a row at issue time.
   *
   * `@fundroom/compliance` declares `CertificateIssuer` structurally and never imports
   * `@fundroom/clickwrap`; this file is the composition root that puts the two together, which
   * is why there is no `ESignPort` yet (D1): click-wrap is synchronous and in-process, a vendor
   * envelope is asynchronous with webhooks, and a port shaped around the first would be the
   * wrong shape for the second.
   */
  const certificatesFor = (s: Signed): CertificateIssuer =>
    createCertificateIssuer({
      audit: deps.audit,
      crypto: deps.crypto,
      storage: deps.storage,
      facts: certificateFacts(deps, s),
      log: (event, fields) => deps.log(event, { ...fields }),
    });

  /**
   * The acceptance service. With a `Signed` it can issue certificates; without one it cannot, and
   * that is fine — the two callers that pass nothing (`pendingFor`, the register) never issue.
   * An absent issuer is not a degraded mode: `issueCertificate` no-ops, the attestation, the
   * audit row and the ACL bump happen exactly as they did before E2.3, and `evidence_ref` stays
   * null. Every pre-E2.3 compliance test depends on that.
   */
  const acceptances = (s?: Signed) =>
    createAcceptanceService({
      db: deps.db,
      audit: deps.audit,
      ...(s === undefined ? {} : { certificates: certificatesFor(s) }),
    });
  const consent = () => createConsentService({ db: deps.db, audit: deps.audit });

  // --- offering mode ---------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/offering",
      tags: TAGS,
      summary: "The offering status, its history, and what every status permits",
      description:
        "`current` is the open period and `history` is the append-only record behind it, which answers 'which status was in force when this document was disclosed'. `table` is §11's permissions matrix for every status, so the admin screen can explain the choice it is offering rather than restating it in the UI.",
      security: sessionSecurity,
      "x-requires": "compliance.read",
      middleware: [perm("compliance.read")] as const,
      responses: { 200: jsonResponse(cp.OfferingStateSchema, "Offering mode"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const svc = offering();
      const { state, history } = await deps.db.withTenant(s.tenant, async (tx) => ({
        state: await svc.current(s.tenant, tx),
        history: await svc.history(s.tenant, tx),
      }));
      return c.json(
        {
          status: state.status,
          current: periodBody(state.period),
          history: history.map(periodBody),
          permits: { ...state.permits },
          table: permits().map((p) => ({ ...p })),
          irrevocable: isIrrevocableFrom(state.status),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/compliance/offering",
      tags: TAGS,
      summary: "Change the offering status",
      description:
        "Closes the open period and opens the next one in one transaction with the audit row and the outbox event. Switching **to** 506(c) answers 409 `conflict` with `requiresConfirmation` until the caller echoes the status back in `confirm`: general solicitation cannot be un-rung. Switching **away from** 506(c) answers 409 `offering_irrevocable` and is never permitted — falling back is a new offering, not a setting.",
      security: sessionSecurity,
      "x-requires": "compliance.offering+fresh",
      middleware: [perm("compliance.offering", true)] as const,
      request: { body: jsonBody(cp.OfferingPatchBody) },
      responses: { 200: jsonResponse(cp.OfferingChangeResultSchema, "Changed"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      const svc = offering();
      let result: Awaited<ReturnType<typeof svc.change>>;
      try {
        result = await deps.db.withTenant(s.tenant, async (tx) => {
          return svc.change(s.tenant, tx, {
            to: body.status,
            ...(body.reason === undefined ? {} : { reason: body.reason }),
            actor: actorOf(c, s),
            confirmed: body.confirm === body.status,
          });
        });
      } catch (error) {
        rethrow(error);
      }
      if (result.requiresConfirmation || result.period === undefined) {
        throw new ApiError(
          "conflict",
          "switching to Rule 506(c) cannot be undone for this offering; confirm to proceed",
          {
            requiresConfirmation: true,
            from: result.from,
            to: result.to,
            confirm: result.to,
            permits: { ...result.permits },
          },
        );
      }
      // The resolved workspace carries `offering_status`, and module gating reads it on every
      // request: a stale cached workspace would keep serving the old rules.
      deps.resolver.invalidate();
      return c.json(
        {
          from: result.from,
          to: result.to,
          current: periodBody(result.period),
          permits: { ...result.permits },
          irrevocable: isIrrevocableFrom(result.to),
        },
        200,
      );
    },
  );

  // --- workspace legal settings ---------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/settings",
      tags: TAGS,
      summary:
        "Workspace legal settings: consent mode, acceptance enforcement, the default disclaimer",
      security: sessionSecurity,
      "x-requires": "compliance.read",
      middleware: [perm("compliance.read")] as const,
      responses: { 200: jsonResponse(cp.ComplianceSettingsSchema, "Settings"), ...ERRORS },
    }),
    async (c) =>
      c.json(settingsBody(parseWorkspaceSettings(signed(c).workspace.settings).legal), 200),
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/compliance/settings",
      tags: TAGS,
      summary: "Change the workspace's legal settings",
      description:
        "`consentMode` decides whether optional tracking needs an explicit yes (Global Privacy Control is honoured in every mode). `privacyRegion` names the regime the workspace's investors are under: changing it **without** a `consentMode` sets the mode to the region's suggestion (EU opt-in, UK opt-out, US notice, other opt-in); sending both keeps the admin's mode and reports `consentModeWeakerThanRegion` when it is less protective — the server never corrects a chosen mode. `legalHold` refuses erasure requests while on. `enforceAcceptance` is the acceptance gate itself — turning it off does not delete the acceptances already recorded. `relationshipWarningDays` tunes the Rule 506(b) heuristic, which warns and never blocks.",
      security: sessionSecurity,
      "x-requires": "compliance.manage+fresh",
      middleware: [perm("compliance.manage", true)] as const,
      request: { body: jsonBody(cp.ComplianceSettingsPatchBody) },
      responses: { 200: jsonResponse(cp.ComplianceSettingsSchema, "Settings"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const patch = c.req.valid("json");
      // The `legal` block alone, merged on the row-locked copy (A-3 R2 M1: never the request's
      // cached settings, never the whole document — a concurrent writer of another block keeps
      // its change). Row lock first, audit last (E3.5 LX).
      const next = await deps.db.withTenant(s.tenant, async (tx) => {
        const current = parseWorkspaceSettings(
          (await lockWorkspaceFacts(tx, s.workspace.id))?.settings,
        );
        // Decision 4: the region suggestion is applied here, at write time, and only when no mode
        // was sent with a changed region — never at read time, never over a mode the admin sent.
        const change = applyLegalSettingsPatch(current.legal, patch);
        const next = WorkspaceSettingsSchema.parse({ ...current, legal: change.next });
        await updateWorkspaceSettingsBlock(tx, s.workspace.id, "legal", next.legal);
        await deps.audit.record(tx, s.tenant, {
          action: "legal.settings_changed",
          resourceKind: "workspace",
          resourceId: s.workspace.id,
          requestId: requestIdOf(c),
          diff: { before: { ...current.legal }, after: { ...next.legal } },
          meta: {
            fields: Object.keys(patch),
            privacyRegion: next.legal.privacyRegion,
            consentModeSource: change.consentModeSource,
          },
        });
        return next;
      });
      deps.resolver.invalidate();
      // Turning enforcement on or off changes what the gate answers for every external member.
      gate.invalidate(s.workspace.id);
      return c.json(settingsBody(next.legal), 200);
    },
  );

  // --- DSAR erasure requests (E2.6 decision 5) ------------------------------------------------------
  const erasure = () =>
    createErasureService({ db: deps.db, audit: deps.audit, bookingSuppressionKeys: deps.crypto });

  /**
   * The modules an erasure request waits for: every compiled-in module whose manifest handles
   * `member.erasure_requested`, **whatever its enablement** (E2.6 decision 5 as amended). Rows a
   * module wrote while it was enabled survive it being switched off, and the outbox dispatcher
   * runs subscribers regardless of enablement, so a disabled module still erases and reports.
   */
  function expectedErasureModules(): string[] {
    return deps.registry.modules
      .filter((m) => m.events?.handles?.["member.erasure_requested"] !== undefined)
      .map((m) => m.id);
  }

  async function erasureNames(s: Signed, details: readonly ErasureRequestDetail[]) {
    const ids = [...new Set(details.map((d) => d.request.membershipId))];
    return deps.db.withTenant(s.tenant, (tx) => new MembershipRepo(s.tenant, tx).namesFor(ids));
  }

  api.openapi(
    createRoute({
      method: "post",
      path: "/compliance/erasure-requests",
      tags: TAGS,
      summary: "Record a member's erasure request (DSAR) and start the statutory clock",
      description:
        'Records the request with its statutory deadline (30 days, or 45 for a US workspace), freezes the list of modules it waits for (every compiled-in module that handles `member.erasure_requested`, enabled for this workspace or not: a disabled module\'s old rows are personal data too) and publishes that event in the same transaction; each module erases or pseudonymises its own rows and reports back. With no module to wait for, the request completes at once. Refused with 409 `conflict` and `reason: "legal_hold"` while the workspace is under legal hold, and with `reason: "erasure_open"` (plus `erasureRequestId`) when the member already has an open request. Consent history, attestations, audit rows and round commitments are retained on purpose (evidence and legal obligation). Once every module has reported, the kernel runs a final `core.identity` step in the same transaction: the membership profile is scrubbed and the membership revoked, invites carrying the address are pseudonymised, this workspace\'s sessions are revoked and — only when this was the person\'s last live membership anywhere — the global identity is pseudonymised. Refused with `reason: "last_owner"` for the workspace\'s last active owner.',
      security: sessionSecurity,
      "x-requires": "compliance.manage+fresh",
      middleware: [perm("compliance.manage", true)] as const,
      request: { body: jsonBody(cp.ErasureRequestCreateBody) },
      responses: { 201: jsonResponse(cp.ErasureRequestSchema, "Recorded"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      const expectedModules = expectedErasureModules();
      let detail: ErasureRequestDetail;
      try {
        detail = await deps.db.withTenant(s.tenant, async (tx) => {
          const target = await new MembershipRepo(s.tenant, tx).byId(body.membershipId);
          if (target === undefined) throw new ApiError("not_found", "no such member");
          return erasure().request(s.tenant, tx, {
            membershipId: body.membershipId,
            ...(body.note === undefined ? {} : { note: body.note }),
            expectedModules,
            actor: actorOf(c, s),
          });
        });
      } catch (error) {
        rethrow(error);
      }
      const names = await erasureNames(s, [detail]);
      return c.json(erasureBody(detail, names, new Date()), 201);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/erasure-requests",
      tags: TAGS,
      summary: "Erasure requests, newest first, with each module's progress",
      description:
        "`expectedModules` is what the request waits for, `completedModules`/`pendingModules` split it by whether the module has reported, and `overdue` is a still-open request past its statutory `dueAt`. `steps` carries each report's counts — numbers only, never the erased values.",
      security: sessionSecurity,
      "x-requires": "compliance.read",
      middleware: [perm("compliance.read")] as const,
      request: { query: cp.ErasureRequestListQuery },
      responses: { 200: jsonResponse(cp.ErasureRequestListSchema, "Requests"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const q = c.req.valid("query");
      let result: Awaited<ReturnType<ReturnType<typeof erasure>["list"]>>;
      try {
        result = await deps.db.withTenant(s.tenant, (tx) =>
          erasure().list(s.tenant, tx, {
            status: q.status,
            membershipId: q.membershipId,
            after: q.cursor,
            limit: q.limit,
          }),
        );
      } catch (error) {
        rethrow(error);
      }
      const names = await erasureNames(s, result.items);
      const now = new Date();
      return c.json(
        {
          items: result.items.map((d) => erasureBody(d, names, now)),
          nextCursor: result.nextCursor ?? null,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/erasure-requests/{id}",
      tags: TAGS,
      summary: "One erasure request and its steps",
      security: sessionSecurity,
      "x-requires": "compliance.read",
      middleware: [perm("compliance.read")] as const,
      request: { params: cp.ErasureRequestIdParam },
      responses: { 200: jsonResponse(cp.ErasureRequestSchema, "Request"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { id } = c.req.valid("param");
      const detail = await deps.db.withTenant(s.tenant, (tx) => erasure().get(s.tenant, tx, id));
      if (detail === undefined) throw new ApiError("not_found", "no such erasure request");
      const names = await erasureNames(s, [detail]);
      return c.json(erasureBody(detail, names, new Date()), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/compliance/erasure-requests/{id}/cancel",
      tags: TAGS,
      summary: "Cancel an open erasure request",
      description:
        "Stops tracking the request (for example, the person withdrew it): the clock stops, the register shows it cancelled, and later step reports are still recorded but no longer complete it. It does **not** recall the erasure. `member.erasure_requested` was published when the request was accepted, so every module that has received that event — including ones that have not reported yet — may still erase, and erased rows are not restored; the audit row lists the modules that had already reported. For the same reason a legal hold set *after* a request was accepted does not stop it: the hold must be in place before the request. 409 `conflict` when the request is already completed or cancelled.",
      security: sessionSecurity,
      "x-requires": "compliance.manage+fresh",
      middleware: [perm("compliance.manage", true)] as const,
      request: { params: cp.ErasureRequestIdParam },
      responses: { 200: jsonResponse(cp.ErasureRequestSchema, "Cancelled"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { id } = c.req.valid("param");
      let detail: ErasureRequestDetail;
      try {
        detail = await deps.db.withTenant(s.tenant, (tx) =>
          erasure().cancel(s.tenant, tx, id, actorOf(c, s)),
        );
      } catch (error) {
        rethrow(error);
      }
      const names = await erasureNames(s, [detail]);
      return c.json(erasureBody(detail, names, new Date()), 200);
    },
  );

  // --- DSAR: every kind of data-subject request, and the subject export (E2.7) ---------------------
  const dataRequests = () =>
    createDataRequestService({
      db: deps.db,
      audit: deps.audit,
      bookingSuppressionKeys: deps.crypto,
    });

  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/data-requests",
      tags: TAGS,
      summary: "Data-subject requests of every kind, newest first",
      description:
        "Erasure, access and rectification requests in one list (filter with `kind`, `status`, `membershipId`). Each carries its statutory `dueAt` and `overdue` flag; erasure requests also carry the modules they wait for and every step reported so far — including the kernel's own final `core.identity` step — with counts only, never the erased values. `subjectName` is `null` once the member's identity has been erased.",
      security: sessionSecurity,
      "x-requires": "compliance.read",
      middleware: [perm("compliance.read")] as const,
      request: { query: cp.DataRequestListQuery },
      responses: { 200: jsonResponse(cp.DataRequestListSchema, "Requests"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const q = c.req.valid("query");
      let result: Awaited<ReturnType<ReturnType<typeof dataRequests>["list"]>>;
      try {
        result = await deps.db.withTenant(s.tenant, (tx) =>
          dataRequests().list(s.tenant, tx, {
            kind: q.kind,
            status: q.status,
            membershipId: q.membershipId,
            after: q.cursor,
            limit: q.limit,
          }),
        );
      } catch (error) {
        rethrow(error);
      }
      const names = await erasureNames(s, result.items);
      const now = new Date();
      return c.json(
        {
          items: result.items.map((d) => dataRequestBody(d, names, now)),
          nextCursor: result.nextCursor ?? null,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/compliance/data-requests",
      tags: TAGS,
      summary: "Record a member's access or rectification request (DSAR)",
      description:
        'Starts the statutory clock (30 days, or 45 for a US workspace — the same rule as erasure). **Access**: answer it with `GET /compliance/subjects/{membershipId}/export`, then complete it with `POST /compliance/data-requests/{id}/complete` passing the export\'s `X-Content-SHA256` as `exportSha256` (or with a note alone — "sent by post"). **Rectification**: the correction itself is made on the People screen (the member\'s profile edit, which is audited there); this request is the clock and the record — complete it with a note saying what was corrected. Erasure keeps its own route (`POST /compliance/erasure-requests`). 409 `conflict` with `reason: "request_open"` (plus `kind` and `dataRequestId`) when the member already has an open request of the same kind; requests of different kinds coexist.',
      security: sessionSecurity,
      "x-requires": "compliance.manage+fresh",
      middleware: [perm("compliance.manage", true)] as const,
      request: { body: jsonBody(cp.DataRequestCreateBody) },
      responses: { 201: jsonResponse(cp.DataRequestSchema, "Recorded"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      let detail: DataRequestDetail;
      try {
        detail = await deps.db.withTenant(s.tenant, async (tx) => {
          const target = await new MembershipRepo(s.tenant, tx).byId(body.membershipId);
          if (target === undefined) throw new ApiError("not_found", "no such member");
          return dataRequests().create(s.tenant, tx, {
            kind: body.kind,
            membershipId: body.membershipId,
            ...(body.note === undefined ? {} : { note: body.note }),
            actor: actorOf(c, s),
          });
        });
      } catch (error) {
        rethrow(error);
      }
      const names = await erasureNames(s, [detail]);
      return c.json(dataRequestBody(detail, names, new Date()), 201);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/compliance/data-requests/{id}/complete",
      tags: TAGS,
      summary: "Mark a data request complete",
      description:
        'Closes an access or rectification request with an optional staff note (kept on the request, never on the audit chain). **Access**: pass `exportSha256`, the `X-Content-SHA256` of the subject export that was handed over; it must match a `compliance.dsar_exported` audit row for this member in this workspace (409 `conflict` with `reason: "export_unknown"` otherwise) and is stored on the request. For rectification, make the correction on the People screen first — this records that it was done. An **erasure** request completes itself once every module and the identity step have reported (409 `reason: "self_completing"` while a module is pending); the one exception is an erasure whose `blockedReason` is `last_owner` — every module has reported but the member became the workspace\'s only owner — which this finishes once ownership has moved (409 `reason: "last_owner"` while it has not). 409 `reason: "request_closed"` when the request is already completed or cancelled.',
      security: sessionSecurity,
      "x-requires": "compliance.manage+fresh",
      middleware: [perm("compliance.manage", true)] as const,
      request: { params: cp.DataRequestIdParam, body: jsonBody(cp.DataRequestCompleteBody) },
      responses: { 200: jsonResponse(cp.DataRequestSchema, "Completed"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      let detail: DataRequestDetail;
      try {
        detail = await deps.db.withTenant(s.tenant, (tx) =>
          dataRequests().complete(s.tenant, tx, id, {
            ...(body.note === undefined ? {} : { note: body.note }),
            ...(body.exportSha256 === undefined ? {} : { exportSha256: body.exportSha256 }),
            actor: actorOf(c, s),
          }),
        );
      } catch (error) {
        rethrow(error);
      }
      const names = await erasureNames(s, [detail]);
      return c.json(dataRequestBody(detail, names, new Date()), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/subjects/{membershipId}/export",
      tags: TAGS,
      summary: "Everything this workspace holds about one member, as a zip (subject access)",
      description:
        "The answer to an access request (GDPR art. 15/20). A zip of `manifest.json` (the sha256 of every other file), `README.txt`, `profile.json` (membership, groups, invites, sign-in identity), `attestations.json`, `consent.json`, `acceptances.json`, `sessions.json`, `share-links.json`, `mail.json`, `access.json` (direct grants), `requests.json` (their data requests), `esign.json` (their e-sign envelopes' metadata) with `esign/<envelopeId>-signed.pdf` for each signed copy collected, `audit.jsonl` (every audit event in which the member acted, was acted on or was acted for — each line with its chain `seq` and `hash`) and `modules/<id>.json` from every compiled-in module, enabled or not. Documents the member uploaded are listed as metadata only, never their bytes. The export changes nothing but its audit row (`compliance.dsar_exported`, with the zip's sha256, also sent as `X-Content-SHA256`): a download can be lost, so an open access request is completed by hand afterwards with `POST /compliance/data-requests/{id}/complete` and that `exportSha256`. Audit lines written by somebody else than the member have that person's user id, session, ip, user agent and typed free text removed (and say so in `redacted`); such lines no longer re-hash — the signed audit export is the verifiable artefact. `Cache-Control: private, no-store`.",
      security: sessionSecurity,
      "x-requires": "compliance.manage+fresh",
      middleware: [perm("compliance.manage", true)] as const,
      request: { params: cp.MembershipIdParam },
      responses: {
        200: {
          description: "The export",
          content: { "application/zip": { schema: z.string().openapi({ format: "binary" }) } },
        },
        ...ERRORS,
      },
    }),
    async (c) => {
      const s = signed(c);
      const { membershipId } = c.req.valid("param");
      const generatedAt = new Date(Math.floor(Date.now()));
      /*
       * Three phases, never nested, so the export holds one pool connection at a time: the
       * kernel's files in one system transaction, each module's exporter in its own (inside
       * `collectModuleFiles`), then the completion and the audit row in the caller's.
       */
      const sys = systemContext(s.tenant.workspaceId);
      const kernel = await deps.db.withTenant(sys, (tx) =>
        collectKernelFiles({ db: deps.db, audit: deps.audit }, sys, tx, membershipId, generatedAt),
      );
      if (kernel === undefined) throw new ApiError("not_found", "no such member");
      const moduleFiles = await collectModuleFiles(
        deps.db,
        s.tenant.workspaceId,
        membershipId,
        deps.registry.modules,
      );
      // E3.5: the member's signed e-sign copies (read outside any transaction; storage + keys).
      const binaryFiles = await deps.esign.subjectArtifacts(s.workspace.id, membershipId);
      const bundle = buildSubjectExport({
        workspace: { id: s.workspace.id, slug: s.workspace.slug, name: s.workspace.name },
        membershipId,
        generatedAt,
        files: { ...kernel.files, ...moduleFiles },
        binaryFiles,
        auditTruncated: kernel.auditTruncated,
      });
      try {
        await deps.db.withTenant(s.tenant, async (tx) => {
          // The export changes nothing but this row: the admin completes the access request by
          // hand with the sha256 they received (`POST /compliance/data-requests/{id}/complete`).
          const open = await dataRequests().openFor(s.tenant, tx, membershipId, "access");
          await deps.audit.record(tx, s.tenant, {
            action: "compliance.dsar_exported",
            resourceKind: "dsar_request",
            ...(open === undefined ? {} : { resourceId: open.id }),
            subjectMembershipId: membershipId,
            requestId: requestIdOf(c),
            meta: {
              requestId: open?.id ?? null,
              sha256: bundle.sha256,
              files: Object.keys(bundle.manifest.files),
            },
          });
        });
      } catch (error) {
        rethrow(error);
      }
      const stamp = generatedAt.toISOString().slice(0, 10);
      return c.body(bundle.bytes as unknown as ArrayBuffer, 200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="dsar-export-${s.workspace.slug}-${membershipId.slice(0, 8)}-${stamp}.zip"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Content-SHA256": bundle.sha256,
      }) as never;
    },
  );

  // --- the shipped template library ------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/templates",
      tags: TAGS,
      summary: "The shipped legal templates a document can be seeded from",
      description:
        "Metadata only — bodies are large and mostly identical, so they come one at a time from `/compliance/templates/{templateId}`. Nothing here is legal advice: every shipped body carries a counsel-review banner, and the tenant owns the words from the first publish onwards.",
      security: sessionSecurity,
      "x-requires": "compliance.read",
      middleware: [perm("compliance.read")] as const,
      responses: { 200: jsonResponse(cp.LegalTemplateListSchema, "Templates"), ...ERRORS },
    }),
    async (c) =>
      c.json(
        {
          templates: listTemplates().map((t) => ({
            id: t.id,
            version: t.version,
            title: t.title,
            audience: t.audience,
            jurisdiction: [...t.jurisdiction],
            requiresAcceptance: t.requiresAcceptance,
            mergeFields: [...t.mergeFields],
            bodySha256: t.bodySha256,
          })),
        },
        200,
      ),
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/templates/{templateId}",
      tags: TAGS,
      summary: "One template: the shipped Markdown and what it renders to here",
      description:
        "`body` keeps the `{{merge.field}}` placeholders so a tenant can diff against a later upstream version; `preview` is the same body rendered against this workspace's facts — exactly what `POST /compliance/documents` with `from` would publish.",
      security: sessionSecurity,
      "x-requires": "compliance.read",
      middleware: [perm("compliance.read")] as const,
      request: { params: cp.TemplateIdParam },
      responses: { 200: jsonResponse(cp.LegalTemplateDetailSchema, "Template"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const template = templateById(c.req.valid("param").templateId);
      if (template === undefined) throw new ApiError("not_found", "no such template");
      return c.json(
        {
          template: {
            id: template.id,
            version: template.version,
            title: template.title,
            audience: template.audience,
            jurisdiction: [...template.jurisdiction],
            requiresAcceptance: template.requiresAcceptance,
            mergeFields: [...template.mergeFields],
            bodySha256: template.bodySha256,
          },
          body: template.body,
          preview: renderTemplate(template, await templateContextOf(deps, s, undefined)),
        },
        200,
      );
    },
  );

  // --- tenant legal documents ---------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/documents",
      tags: TAGS,
      summary: "The workspace's legal documents",
      description:
        "One row per live document with its current version's stamp (`<slug>:v<n>`). A document with no published version gates nothing: there is no text to agree to.",
      security: sessionSecurity,
      "x-requires": "compliance.read",
      middleware: [perm("compliance.read")] as const,
      responses: { 200: jsonResponse(cp.LegalDocumentListSchema, "Documents"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const rows = await deps.db.withTenant(s.tenant, (tx) => documents().list(s.tenant, tx));
      return c.json({ documents: rows.map(documentBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/compliance/documents",
      tags: TAGS,
      summary: "Create a legal document, optionally seeded from a shipped template",
      description:
        "With `from` the first version is rendered from the template and published immediately — an empty legal document is not a useful intermediate state, and the tenant edits by publishing v2. With `body` the tenant's own text is published instead. With neither, the document exists with no version and gates nothing. `ceremony: esign` (sign at the e-sign vendor instead of click-wrap) needs an active e-sign connection (409 `esign_not_configured`), an `nda` kind (422 `esign_ceremony_unsupported`) and a title and text the signing PDF can show unchanged (422 `esign_nda_text_unsupported`, details name the field and the characters).",
      security: sessionSecurity,
      "x-requires": "compliance.manage",
      middleware: [perm("compliance.manage")] as const,
      request: { body: jsonBody(cp.LegalDocumentCreateBody) },
      responses: {
        200: jsonResponse(cp.LegalDocumentDetailSchema, "Created"),
        ...DOCUMENT_WRITE_ERRORS,
      },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      // Before the transaction: the context reads the workspace's vendor connections, which
      // inside it would take a second pool connection.
      const context =
        body.from === undefined ? undefined : await templateContextOf(deps, s, body.context);
      try {
        const detail = await deps.db.withTenant(s.tenant, async (tx) => {
          // Under the connection's advisory lock, so a concurrent disconnect either sees this
          // document (and refuses) or this sees no connection (and refuses).
          if (body.ceremony === "esign") await assertESignConnected(tx, s.tenant);
          const created = await documents().create(s.tenant, tx, {
            slug: body.slug,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.kind === undefined ? {} : { kind: body.kind }),
            ...(body.audience === undefined ? {} : { audience: body.audience }),
            ...(body.requiresAcceptance === undefined
              ? {}
              : { requiresAcceptance: body.requiresAcceptance }),
            ...(body.from === undefined
              ? {}
              : { from: body.from, ...(context === undefined ? {} : { context }) }),
            ...(body.body === undefined ? {} : { body: body.body }),
            ...(body.ceremony === undefined ? {} : { ceremony: body.ceremony }),
            actor: actorOf(c, s),
          });
          await assertSignable(s.tenant, tx, created.id);
          return created;
        });
        // A document created as `requiresAcceptance` with a first version gates everybody now.
        deps.authz.invalidate(s.workspace.id);
        gate.invalidate(s.workspace.id);
        return c.json(
          {
            document: documentBody(detail),
            current: detail.current === undefined ? null : versionBody(detail.current),
            versions: detail.versions.map(versionBody),
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/documents/{id}",
      tags: TAGS,
      summary: "One legal document with every published version",
      security: sessionSecurity,
      "x-requires": "compliance.read",
      middleware: [perm("compliance.read")] as const,
      request: { params: cp.DocumentIdParam },
      responses: { 200: jsonResponse(cp.LegalDocumentDetailSchema, "Document"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      try {
        const detail = await deps.db.withTenant(s.tenant, (tx) =>
          documents().read(s.tenant, tx, c.req.valid("param").id),
        );
        return c.json(
          {
            document: documentBody(detail),
            current: detail.current === undefined ? null : versionBody(detail.current),
            versions: detail.versions.map(versionBody),
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/compliance/documents/{id}",
      tags: TAGS,
      summary: "Change a document's title, kind, audience, ceremony or whether it gates access",
      description:
        "Metadata only: the published text is immutable, and changing it means publishing a new version. Turning `requiresAcceptance` on closes a gate for everybody who has not accepted, so the ACL is rebuilt either way. `ceremony: esign` needs an active e-sign connection (409 `esign_not_configured`); acceptances already recorded by click-wrap stay valid. A document whose ceremony is (or becomes) `esign` must stay an `nda` (422 `esign_ceremony_unsupported`) with a title the signing PDF can show unchanged (422 `esign_nda_text_unsupported`).",
      security: sessionSecurity,
      "x-requires": "compliance.manage",
      middleware: [perm("compliance.manage")] as const,
      request: { params: cp.DocumentIdParam, body: jsonBody(cp.LegalDocumentPatchBody) },
      responses: { 200: jsonResponse(cp.LegalDocumentSchema, "Updated"), ...DOCUMENT_WRITE_ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      try {
        const row = await deps.db.withTenant(s.tenant, async (tx) => {
          if (body.ceremony === "esign") await assertESignConnected(tx, s.tenant);
          const updated = await documents().update(s.tenant, tx, c.req.valid("param").id, {
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.kind === undefined ? {} : { kind: body.kind }),
            ...(body.audience === undefined ? {} : { audience: body.audience }),
            ...(body.requiresAcceptance === undefined
              ? {}
              : { requiresAcceptance: body.requiresAcceptance }),
            ...(body.ceremony === undefined ? {} : { ceremony: body.ceremony }),
            actor: actorOf(c, s),
          });
          await assertSignable(s.tenant, tx, updated.id);
          return updated;
        });
        deps.authz.invalidate(s.workspace.id);
        gate.invalidate(s.workspace.id);
        return c.json(documentBody(row), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/compliance/documents/{id}",
      tags: TAGS,
      summary: "Stop serving a legal document",
      description:
        "A soft delete. The published versions and the acceptances against them stay: an acceptance has to keep evidencing what somebody agreed to long after the tenant stopped serving the text (retention is six years after close).",
      security: sessionSecurity,
      "x-requires": "compliance.manage+fresh",
      middleware: [perm("compliance.manage", true)] as const,
      request: { params: cp.DocumentIdParam },
      responses: { 200: jsonResponse(OkSchema, "Removed"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      try {
        const removed = await deps.db.withTenant(s.tenant, (tx) =>
          documents().remove(s.tenant, tx, c.req.valid("param").id, actorOf(c, s)),
        );
        if (!removed) throw new ApiError("not_found", "no such legal document");
        deps.authz.invalidate(s.workspace.id);
        gate.invalidate(s.workspace.id);
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/documents/{id}/versions",
      tags: TAGS,
      summary: "Every published version of a document, newest first",
      description:
        "Versions are immutable by database trigger. Each carries the sha256 of the exact bytes that were shown, which is what an acceptance names.",
      security: sessionSecurity,
      "x-requires": "compliance.read",
      middleware: [perm("compliance.read")] as const,
      request: { params: cp.DocumentIdParam },
      responses: { 200: jsonResponse(cp.LegalDocumentVersionListSchema, "Versions"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      try {
        const detail = await deps.db.withTenant(s.tenant, (tx) =>
          documents().read(s.tenant, tx, c.req.valid("param").id),
        );
        return c.json({ versions: detail.versions.map(versionBody) }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/compliance/documents/{id}/versions",
      tags: TAGS,
      summary: "Publish a new version of a legal document",
      description:
        "Publishing a body byte-identical to the current version writes nothing and answers `published: false` with the existing version: a no-op version would invalidate every acceptance on record and make every member click 'I agree' again for a document that did not change. A real publish bumps `acl_version`, so the gates re-evaluate. On an e-signature (`ceremony: esign`) document the text must be something the signing PDF can show unchanged (422 `esign_nda_text_unsupported`, nothing published).",
      security: sessionSecurity,
      "x-requires": "compliance.manage+fresh",
      middleware: [perm("compliance.manage", true)] as const,
      request: { params: cp.DocumentIdParam, body: jsonBody(cp.LegalVersionPublishBody) },
      responses: {
        200: jsonResponse(cp.LegalPublishResultSchema, "Published"),
        ...DOCUMENT_WRITE_ERRORS,
      },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      try {
        const result = await deps.db.withTenant(s.tenant, async (tx) => {
          const published = await documents().publish(s.tenant, tx, c.req.valid("param").id, {
            body: body.body,
            ...(body.summary === undefined ? {} : { summary: body.summary }),
            ...(body.effectiveAt === undefined ? {} : { effectiveAt: new Date(body.effectiveAt) }),
            actor: actorOf(c, s),
          });
          await assertSignable(s.tenant, tx, published.document.id);
          return published;
        });
        if (result.published) {
          deps.authz.invalidate(s.workspace.id);
          gate.invalidate(s.workspace.id);
        }
        return c.json(
          {
            document: documentBody(result.document),
            version: versionBody(result.version),
            published: result.published,
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- the acceptance register -------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/acceptances",
      tags: TAGS,
      summary: "Who accepted what, and when",
      description:
        "The evidence counsel asks for, newest first. The cursor carries the timestamp, the membership and the stamp together: two people accepting the same version in the same microsecond is exactly what happens after a publish, and a timestamp-only cursor would silently drop all but one of them.",
      security: sessionSecurity,
      "x-requires": "compliance.read",
      middleware: [perm("compliance.read")] as const,
      request: { query: cp.AcceptanceRegisterQuery },
      responses: { 200: jsonResponse(cp.AcceptanceRegisterSchema, "Register"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const q = c.req.valid("query");
      /*
       * The keyset now lives in `AcceptanceRegisterRepo` (contract §5.5/D-3), where E1.6's
       * as-built asked for it. What was here was a full read of every acceptance followed by a
       * sort and a slice in memory — fine at the scale E1.6 shipped at, and wrong at the scale an
       * evidence export reaches. The wire cursor is byte-identical
       * (`base64url("<iso>|<membershipId>|<stamp>")`), so a client holding one across this deploy
       * keeps paging from where it was: a paginated evidence export that silently restarts is a
       * lawyer reading the same page twice and not knowing it.
       */
      try {
        const page = await deps.db.withTenant(s.tenant, (tx) =>
          acceptances().registerPage(s.tenant, tx, {
            filter: {
              ...(q.documentId === undefined ? {} : { documentId: q.documentId }),
              ...(q.slug === undefined ? {} : { slug: q.slug }),
              ...(q.membershipId === undefined ? {} : { membershipId: q.membershipId }),
            },
            ...(q.cursor === undefined ? {} : { after: q.cursor }),
            limit: q.limit,
          }),
        );
        const names = await deps.db.withTenant(s.tenant, (tx) =>
          new MembershipRepo(s.tenant, tx).namesFor(page.entries.map((e) => e.membershipId)),
        );
        return c.json(
          {
            items: page.entries.map((e) => registerItem(e, names.get(e.membershipId))),
            nextCursor: page.nextCursor ?? null,
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/acceptances/export",
      tags: TAGS,
      summary: "The whole acceptance register as a file, for counsel",
      description:
        "The **whole** register in one response rather than a page of it (bounded server-side), because an evidence export that stopped at the first hundred rows would be worse than none: nobody reading it would know. `csv` is RFC 4180 with CRLF endings and a UTF-8 BOM, and every field beginning `=`, `+`, `-` or `@` is prefixed with an apostrophe — a tenant-controlled slug is otherwise a formula in three spreadsheet programs. `json` is the same rows in the same order, with the filter and a generation timestamp. Both are `no-store`: this is evidence about named people and must not sit in a shared cache. The *signed* bundle needs the audit chain's own signature over the file and belongs with E2.7's signed audit export.",
      security: sessionSecurity,
      "x-requires": "compliance.read",
      middleware: [perm("compliance.read")] as const,
      request: { query: cp.AcceptanceRegisterExportQuery },
      responses: {
        200: {
          description: "The register",
          content: {
            "text/csv": { schema: z.string() },
            "application/json": { schema: z.string() },
          },
        },
        ...ERRORS,
      },
    }),
    async (c) => {
      const s = signed(c);
      const q = c.req.valid("query");
      const filter = {
        ...(q.documentId === undefined ? {} : { documentId: q.documentId }),
        ...(q.slug === undefined ? {} : { slug: q.slug }),
        ...(q.membershipId === undefined ? {} : { membershipId: q.membershipId }),
      };
      const entries = await deps.db.withTenant(s.tenant, (tx) =>
        acceptances().register(s.tenant, tx, filter),
      );
      const stamp = new Date().toISOString().slice(0, 10);
      const csv = q.format === "csv";
      return c.body(
        csv
          ? registerCsv(entries)
          : registerJson(entries, {
              workspaceId: s.workspace.id,
              generatedAt: new Date(),
              filter,
            }),
        200,
        {
          "Content-Type": csv ? "text/csv; charset=utf-8" : "application/json",
          "Content-Disposition": `attachment; filename="acceptance-register-${stamp}.${q.format}"`,
          "Cache-Control": "private, no-store",
          "X-Content-Type-Options": "nosniff",
        },
      ) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/acceptances/{membershipId}/certificate",
      tags: TAGS,
      summary: "The click-wrap certificate for one acceptance",
      description:
        "The signer may fetch their own; anyone else needs `compliance.read`, and a caller who is neither gets the same 404 an unknown acceptance gives, so this cannot be used to ask whether somebody signed something. **The JSON is canonical and the PDF is a rendering of it**: pdf-lib stamps `ModDate` from the wall clock and assigns object ids in insertion order, so a PDF's sha256 is not reproducible and is never the hashed object — `certificateSha256` on the audit chain is the digest of the canonical JSON, and the PDF prints it alongside both audit anchors. Served through the application and never as a presigned URL: a URL that grants access to evidence for an hour, to whoever holds it, is not an access control. `Cache-Control: private, no-store`.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { params: cp.MembershipIdParam, query: cp.CertificateFormatQuery },
      responses: {
        200: {
          description: "The certificate",
          content: {
            "application/json": { schema: z.string() },
            "application/pdf": { schema: z.string().openapi({ format: "binary" }) },
          },
        },
        ...ERRORS,
      },
    }),
    async (c) => {
      const s = signed(c);
      const { membershipId } = c.req.valid("param");
      const q = c.req.valid("query");
      /*
       * Two ways in and one answer out. The signer is authorised by being the signer; staff are
       * authorised by `compliance.read`. Everyone else gets `not_found` rather than `forbidden`,
       * because "you may not see Ada's NDA certificate" and "Ada has no NDA certificate" are the
       * same sentence as far as an outsider is concerned, and only one of them is safe to say.
       */
      const mine = s.membership.id === membershipId;
      if (!mine && !deps.authz.hasPermission(s.membership, "compliance.read")) {
        throw new ApiError("not_found", "no such certificate");
      }
      // System context: the attestation is read by id for a membership that may not be the
      // caller's, which the caller's own external context would (correctly) refuse.
      const ctx = systemContext(s.workspace.id);
      const bytes = await deps.db.withTenant(ctx, async (tx) => {
        const held = await new AttestationRepo(ctx, tx).listFor(membershipId);
        const row = held.find(
          (a) => a.kind === q.stamp && a.revokedAt === null && a.evidenceRef !== null,
        );
        const reference = row?.evidenceRef;
        if (reference === undefined || reference === null) return undefined;
        return certificatesFor(s).fetch(ctx, tx, reference, q.format);
      });
      if (bytes === undefined) throw new ApiError("not_found", "no such certificate");
      return c.body(bytes.bytes as unknown as ArrayBuffer, 200, {
        "Content-Type": bytes.contentType,
        "Content-Disposition": `attachment; filename="${bytes.filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      }) as never;
    },
  );

  // --- member surfaces: the gate, the acceptance, the consent answer ------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/gates",
      tags: TAGS,
      summary: "Legal documents I must accept before the portal serves me anything else",
      description:
        'The interstitial\'s own endpoint, reachable even while the caller is otherwise blocked. It returns the exact text that will be recorded against the acceptance, and its sha256, so the click-wrap evidence names the bytes that were on screen. Documents with `scope: "workspace"` gate the whole portal (the interstitial). Documents with `scope: "resource"` are named by a live `nda` access gate on a folder, document or share link that the caller has not satisfied: they block only that resource, are listed only here (never in the bootstrap), and are what the unlock sheet accepts or signs.',
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      responses: { 200: jsonResponse(cp.PendingAcceptanceListSchema, "Outstanding"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      // The member's own pending list, not the gate's: a workspace that has turned enforcement
      // off should still let somebody read and accept what is outstanding.
      const ctx = systemContext(s.workspace.id);
      const principal = { id: s.membership.id, kind: s.membership.kind };
      const { workspace, resource } = await deps.db.withTenant(ctx, async (tx) => ({
        workspace: await acceptances().pendingFor(ctx, tx, principal),
        // E3.5 fix B3: the documents named by live `nda` access gates this member has not
        // satisfied (a folder's NDA, a link's NDA). They gate one resource, not the portal, so
        // they are marked and the interstitial ignores them — but the unlock sheet needs their
        // bytes, and for an e-sign NDA `POST /esign/nda/start` accepts exactly this set.
        // Deliberately NOT in the bootstrap or `gate.check`: a folder NDA must never block the
        // rest of the portal.
        resource: await acceptances().resourcePendingFor(ctx, tx, principal),
      }));
      const vendor = await pendingESignVendor(deps.esign, deps.db, ctx, [
        ...workspace,
        ...resource,
      ]);
      return c.json(
        {
          pending: [
            ...workspace.map((p) => pendingBody(p, vendor)),
            ...resource.map((p) => pendingBody(p, vendor, "resource")),
          ],
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/compliance/acceptances",
      tags: TAGS,
      summary: "Accept a legal document",
      description:
        "Records a `core.attestation` of kind `<slug>:v<n>` with the sha256 of the body that was shown, a browser *family* and a keyed hash of the address — never a User-Agent string and never a raw IP. Idempotent: a retry or a double click returns the existing row with `recorded: false`. Accepting a superseded version is refused. A document whose ceremony is `esign` cannot be accepted here (409 `esign_required`): it is signed via `POST /esign/nda/start`.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { body: jsonBody(cp.AcceptanceBody) },
      responses: { 200: jsonResponse(cp.AcceptanceResultSchema, "Accepted"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      const ctx = systemContext(s.workspace.id);
      try {
        const { result, pending } = await deps.db.withTenant(ctx, async (tx) => {
          const key = await deps.crypto.currentKey(tx, ctx, LEGAL_IP_PURPOSE);
          const ipHash = ipHashOf(key.key, clientIp(c, deps.trustProxy));
          const viaLinkId = await liveLinkOf(ctx, tx, s.membership.id);
          const r = await acceptances(s).accept(ctx, tx, {
            membershipId: s.membership.id,
            documentId: body.documentId,
            versionNo: body.versionNo,
            ...(body.typedName === undefined ? {} : { typedName: body.typedName }),
            ...(body.accreditation === undefined ? {} : { accreditation: body.accreditation }),
            ...(viaLinkId === undefined ? {} : { viaLinkId }),
            evidence: {
              uaFamily: uaFamilyOf(c.req.header("user-agent")),
              ...(ipHash === null ? {} : { ipHash }),
            },
            actor: actorOf(c, s),
          });
          return {
            result: r,
            pending: await acceptances().pendingFor(ctx, tx, {
              id: s.membership.id,
              kind: s.membership.kind,
            }),
          };
        });
        // The acceptance bumped `acl_version` inside that transaction; these two drop the caches
        // that were built from the old one, so the member's very next request is unblocked.
        deps.authz.invalidate(s.workspace.id);
        gate.invalidate(s.workspace.id, s.membership.id);
        const vendor = await pendingESignVendor(deps.esign, deps.db, ctx, pending);
        return c.json(
          {
            stamp: result.stamp,
            acceptedAt: result.attestation.signedAt.toISOString(),
            recorded: result.recorded,
            pending: pending.map((p) => pendingBody(p, vendor)),
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/compliance/consent",
      tags: TAGS,
      summary: "My consent answers for the optional purposes",
      description:
        "`granted` is what I said (or `null` if nobody has asked); `allowed` is the decision, folding the workspace's consent mode, my answer and this request's Global Privacy Control signal. GPC always wins and always means no, in every mode — and it is durable: the first signed-in request carrying `Sec-GPC: 1` records a `gpc` refusal for both purposes, so opens and clicks that reach the server later with no browser attached are refused too. A later grant made from a browser without GPC is a newer answer and wins. Never re-derive `allowed` on the client — there is one place to get this wrong and it is not the browser.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      responses: { 200: jsonResponse(cp.ConsentStateSchema, "Consent"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const ctx = systemContext(s.workspace.id);
      const rows = await deps.db.withTenant(ctx, (tx) =>
        consent().effectiveFor(ctx, tx, s.membership.id),
      );
      return c.json(consentState(s, rows, gpcOf(c)), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/compliance/consent",
      tags: TAGS,
      summary: "Record my answer for one optional purpose",
      description:
        'Append-only: a withdrawal is a new row saying no, never a delete, so the history stays provable. The source is `settings` or `gate` as the caller says, except that a request carrying `Sec-GPC: 1` is recorded as `gpc` — the browser has objected, and that is the fact worth keeping. A **grant** sent with `Sec-GPC: 1` is refused with 409 `conflict` and `reason: "gpc"`: the same request is objecting, and GPC always wins; grant from a browser that does not send it.',
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      request: { body: jsonBody(cp.ConsentPutBody) },
      responses: { 200: jsonResponse(cp.ConsentStateSchema, "Consent"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      const gpc = gpcOf(c);
      if (gpc && body.granted) {
        throw new ApiError("conflict", "your browser is sending Global Privacy Control", {
          reason: "gpc",
        });
      }
      const ctx = systemContext(s.workspace.id);
      const rows = await deps.db.withTenant(ctx, async (tx) => {
        const key = await deps.crypto.currentKey(tx, ctx, LEGAL_IP_PURPOSE);
        const ipHash = ipHashOf(key.key, clientIp(c, deps.trustProxy));
        await consent().record(ctx, tx, {
          membershipId: s.membership.id,
          purpose: body.purpose,
          granted: body.granted,
          source: gpc ? "gpc" : body.source,
          uaFamily: uaFamilyOf(c.req.header("user-agent")),
          ...(ipHash === null ? {} : { ipHash }),
          actor: actorOf(c, s),
        });
        return consent().effectiveFor(ctx, tx, s.membership.id);
      });
      // A new answer is newer than the cached "already GPC-refused" fact (`middleware/gpc.ts`).
      forgetGpcRefusal(s.workspace.id, s.membership.id);
      return c.json(consentState(s, rows, gpc), 200);
    },
  );
}

/** Global Privacy Control (`Sec-GPC: 1`), read the same way `modules/analytics` reads it. */
function gpcOf(c: Context<AppEnv>): boolean {
  return c.req.header("sec-gpc") === "1";
}

/** Folds the stored rows and the request's signals into the answer the client obeys. */
function consentState(
  s: Signed,
  rows: readonly { purpose: string; granted: boolean; source: string; recordedAt: Date }[],
  gpc: boolean,
) {
  const mode = parseWorkspaceSettings(s.workspace.settings).legal.consentMode;
  return {
    consentMode: mode,
    gpc,
    purposes: cp.ConsentPurposeSchema.options.map((purpose) => {
      const row = rows.find((r) => r.purpose === purpose);
      const stored = row === undefined ? null : row.granted;
      return {
        purpose,
        granted: stored,
        source: row === undefined ? null : (row.source as "settings"),
        recordedAt: row === undefined ? null : row.recordedAt.toISOString(),
        allowed: consentAllows({ mode, stored, gpc }),
      };
    }),
  };
}
