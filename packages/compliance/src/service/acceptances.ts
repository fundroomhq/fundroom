import {
  type Attestation,
  bumpAclVersionInTx,
  type LegalAudience,
  type LegalDocument as LegalDocumentRow,
  type MembershipKind,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { publish } from "@fundroom/events";
import { AttestationRepo } from "@fundroom/identity";
import { type Actor, ComplianceError } from "../errors.js";
import {
  AcceptanceRegisterRepo,
  LegalDocumentRepo,
  LegalDocumentVersionRepo,
  MAX_REGISTER_ROWS,
  ndaGateDocumentIds,
} from "../repos/compliance-repo.js";
import {
  type AccreditationAnswers,
  AccreditationAnswersSchema,
  accreditationAttestations,
} from "./accreditation.js";
import { issueCertificate } from "./certificates.js";
import { bodyDigest, stamp } from "./documents.js";
import {
  decodeRegisterCursor,
  encodeRegisterCursor,
  type RegisterEntry,
  type RegisterFilter,
  type RegisterKey,
  type RegisterPage,
} from "./register.js";
import type { ComplianceDeps } from "./types.js";

/*
 * Click-wrap acceptance (design/04 §4, ADR-0032, E1.6).
 *
 * Acceptances are not a table of their own: they are `core.attestation` rows with
 * `kind = '<slug>:v<n>'`. That is not a shortcut. The policy-gate evaluator already settles gates
 * from attestations, so an accepted NDA closes the existing `nda` gate with no new machinery, and
 * the People screen's attestation list shows legal acceptances beside every other one. The version
 * is in the kind rather than in the payload so a gate can name exactly the version it requires.
 *
 * What the row stores as evidence is deliberately minimal (ADR-0036): the document and version,
 * the sha256 of the body the member was actually shown, the timestamp, a browser *family* and a
 * keyed hash of the address. Never a raw IP, never a User-Agent string. An evidence row that
 * outlives the offering by six years is exactly the wrong place to keep identifiers we would not
 * keep anywhere else.
 */

export interface AcceptanceEvidence {
  /** A browser family (`chrome`, `firefox`, …) — derive it with `uaFamilyOf`, never pass the UA. */
  readonly uaFamily?: string | undefined;
  /** Keyed HMAC of the address — derive it with `ipHashOf`, never pass the address. */
  readonly ipHash?: Uint8Array | undefined;
  /**
   * Evidence held elsewhere. For a click-wrap acceptance the certificate issuer sets it (a
   * `cert:v1:…` reference); for an e-signed NDA (E3.5) it is the envelope, `esign:v1:<envelopeId>`.
   */
  readonly evidenceRef?: string | undefined;
  /**
   * How the member agreed. `clickwrap` (the default) is the E1.6/E2.3 ceremony and gets a
   * click-wrap certificate when an issuer is wired. `esign` (E3.5) is a completed vendor envelope:
   * the vendor's signed PDF and audit certificate are the evidence, so NO click-wrap certificate
   * is issued and `evidenceRef` (which must be `esign:v1:<uuid>`) is recorded as given — the
   * issuer must not overwrite it. The certificate document format is untouched (still v1,
   * `method: "clickwrap"` only).
   */
  readonly method?: "clickwrap" | "esign" | undefined;
}

/** `esign:v1:<envelopeId>` — the evidence reference of an e-signed acceptance. */
export const ESIGN_EVIDENCE_REF_RE =
  /^esign:v1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The evidence payload written into `attestation.data`. */
export interface AcceptanceData {
  readonly documentId: string;
  readonly slug: string;
  readonly versionNo: number;
  readonly bodySha256: string;
  readonly acceptedAt: string;
  readonly uaFamily?: string;
  readonly ipHash?: string;
  /** The name the signer typed, when the ceremony asked for one (`design/04` §4.3). */
  readonly typedName?: string;
  /** The share link the signer came in through, when they did (E2.3). */
  readonly viaLinkId?: string;
  /** Present only for an e-signed acceptance (E3.5); absent means click-wrap. */
  readonly method?: "esign";
}

export interface PendingAcceptance {
  readonly documentId: string;
  readonly slug: string;
  readonly title: string;
  readonly kind: string;
  /** E3.5: `esign` documents are accepted by signing a vendor envelope, not by click-wrap. */
  readonly ceremony: "clickwrap" | "esign";
  readonly versionNo: number;
  /** `<slug>:v<n>`: what the member will be recorded as having accepted. */
  readonly stamp: string;
  readonly body: string;
  readonly bodySha256: string;
  readonly effectiveAt: Date;
}

export interface AcceptInput {
  readonly membershipId: string;
  readonly documentId: string;
  /**
   * The version the member was shown. Rejected when it is not the current one.
   *
   * Note what is *not* here: a `bodySha256` from the client. The server records its own, read
   * from the stored version, because a hash the signer's browser computed is evidence of nothing
   * — the signer is the one party with an interest in what it says. What makes the bytes
   * trustworthy is that they travelled to the browser on the bootstrap from the same row this
   * acceptance names (contract C2).
   */
  readonly versionNo: number;
  readonly evidence?: AcceptanceEvidence | undefined;
  /** Identity evidence the ceremony collected: the signer's typed name (`design/04` §4.3). */
  readonly typedName?: string | undefined;
  /** The share link the signer came in through, when they did (E2.3). */
  readonly viaLinkId?: string | undefined;
  /**
   * Answers to the self-certification questionnaire. Read only when the document's kind is
   * `accreditation`; ignored, not rejected, on any other document, because a client that sends
   * them to the wrong document has a bug, not a fact worth storing.
   */
  readonly accreditation?: AccreditationAnswers | undefined;
  readonly actor?: Actor | undefined;
}

export interface AcceptResult {
  readonly attestation: Attestation;
  readonly stamp: string;
  /** False when this version was already accepted and the existing row was returned unchanged. */
  readonly recorded: boolean;
  /**
   * The second row an accreditation acceptance writes — the dated, expiring `accredited` fact the
   * gate reads (D5). Absent for every other document kind.
   */
  readonly accreditation?: Attestation | undefined;
  /** Hex sha256 of the canonical certificate, when an issuer is wired (D2). */
  readonly certificateSha256?: string | undefined;
}

/** Everything `pendingStamps` is allowed to look at, already fetched. */
export interface PendingInput {
  readonly documents: readonly {
    readonly id: string;
    readonly slug: string;
    readonly title: string;
    readonly kind: string;
    readonly audience: LegalAudience;
    /** Absent reads as `clickwrap` (callers before E3.5). */
    readonly ceremony?: "clickwrap" | "esign" | undefined;
    /** `undefined` when the document has never been published. */
    readonly current:
      | {
          readonly versionNo: number;
          readonly body: string;
          readonly bodySha256: string;
          readonly effectiveAt: Date;
        }
      | undefined;
  }[];
  readonly membershipKind: MembershipKind;
  /** Every attestation the membership holds, live or not — liveness is decided here. */
  readonly held: readonly {
    readonly kind: string;
    readonly expiresAt: Date | null;
    readonly revokedAt: Date | null;
  }[];
  readonly now: Date;
}

/**
 * Which documents still stand between this membership and the portal, as a pure function.
 *
 * The version lives in the stamp (`<slug>:v<n>`), and that is the whole mechanism behind
 * "re-acceptance on version change": a member holding `nda:v1` does not hold `nda:v2`, so the
 * moment an admin publishes v2 the document is pending for them again. Nothing rewrites policy
 * rows, nothing revokes the old acceptance — it stays on record as evidence of what was agreed
 * when (design/04 §4.7) — and this function does not special-case any of it.
 */
export function pendingStamps(input: PendingInput): readonly PendingAcceptance[] {
  const live = new Set(
    input.held
      .filter(
        (a) =>
          a.revokedAt === null &&
          (a.expiresAt === null || a.expiresAt.getTime() > input.now.getTime()),
      )
      .map((a) => a.kind),
  );
  const out: PendingAcceptance[] = [];
  for (const doc of input.documents) {
    if (!audienceCovers(doc.audience, input.membershipKind)) continue;
    // A document that has never been published gates nothing: there is no text to agree to.
    if (doc.current === undefined) continue;
    const kind = stamp(doc.slug, doc.current.versionNo);
    if (live.has(kind)) continue;
    out.push({
      documentId: doc.id,
      slug: doc.slug,
      title: doc.title,
      kind: doc.kind,
      ceremony: doc.ceremony ?? "clickwrap",
      versionNo: doc.current.versionNo,
      stamp: kind,
      body: doc.current.body,
      bodySha256: doc.current.bodySha256,
      effectiveAt: doc.current.effectiveAt,
    });
  }
  return out;
}

export interface AcceptanceService {
  pendingFor(
    ctx: TenantContext,
    tx: Tx,
    membership: { readonly id: string; readonly kind: MembershipKind },
  ): Promise<readonly PendingAcceptance[]>;
  /**
   * Documents the member must still accept because a live `nda` access-policy gate that applies
   * to them names it (a resource-scoped NDA, E2.3) — EXCLUDING the ones `pendingFor` already
   * lists. Live document, current version published, audience covers the member, stamp not held.
   * `GET /compliance/gates` lists these as `scope: "resource"` (E3.5 fix B3).
   */
  resourcePendingFor(
    ctx: TenantContext,
    tx: Tx,
    membership: { readonly id: string; readonly kind: MembershipKind },
  ): Promise<readonly PendingAcceptance[]>;
  /**
   * THE "is this document pending for this member" predicate (E3.5 fixes A7/B3): in `pendingFor`
   * or in `resourcePendingFor`. The e-sign NDA start refuses anything else.
   */
  isPendingFor(
    ctx: TenantContext,
    tx: Tx,
    membership: { readonly id: string; readonly kind: MembershipKind },
    documentId: string,
  ): Promise<boolean>;
  accept(ctx: TenantContext, tx: Tx, input: AcceptInput): Promise<AcceptResult>;
  /** The register for the compliance export (design/04 §7: evidence counsel will ask for). */
  register(ctx: TenantContext, tx: Tx, filter?: RegisterFilter): Promise<readonly RegisterEntry[]>;
  /**
   * One keyset page of the same register. The paging is the repository's (contract §5.5); this
   * only turns rows into entries and hands back the cursor for the next call.
   */
  registerPage(
    ctx: TenantContext,
    tx: Tx,
    input: {
      readonly filter?: RegisterFilter | undefined;
      readonly after?: string | undefined;
      readonly limit?: number | undefined;
    },
  ): Promise<RegisterPage>;
}

export const REGISTER_PAGE_DEFAULT = 100;
export const REGISTER_PAGE_MAX = 500;

/**
 * Whether a document's audience covers a membership kind. `all` covers everyone; `external` is the
 * investor-facing case; `staff` never gates an investor. A delegate is an `external` membership,
 * so it is covered by the same documents as the investor it acts for — which is right: a delegate
 * reads the same material and should agree to the same terms.
 */
export function audienceCovers(audience: LegalAudience, kind: MembershipKind): boolean {
  if (audience === "all") return true;
  return audience === "staff" ? kind === "staff" : kind === "external";
}

export function createAcceptanceService(deps: ComplianceDeps): AcceptanceService {
  const now = deps.now ?? (() => new Date());

  /** Turns repository rows into register entries, dropping kinds that are not `<slug>:v<n>`. */
  function toEntries(
    rows: readonly {
      readonly membershipId: string;
      readonly kind: string;
      readonly signedAt: Date;
      readonly evidenceRef: string | null;
      readonly data: unknown;
    }[],
    bySlug: ReadonlyMap<string, { readonly id: string }>,
    wantedSlugs: ReadonlySet<string>,
  ): RegisterEntry[] {
    const out: RegisterEntry[] = [];
    for (const row of rows) {
      const parsed = /^([a-z][a-z0-9-]{0,62}):v(\d+)$/u.exec(row.kind);
      const slug = parsed?.[1];
      const versionNo = parsed?.[2];
      if (slug === undefined || versionNo === undefined || !wantedSlugs.has(slug)) continue;
      const doc = bySlug.get(slug);
      if (doc === undefined) continue;
      const data = (row.data ?? {}) as Partial<AcceptanceData>;
      out.push({
        membershipId: row.membershipId,
        documentId: doc.id,
        slug,
        versionNo: Number(versionNo),
        stamp: row.kind,
        bodySha256: data.bodySha256 ?? null,
        acceptedAt: row.signedAt,
        evidenceRef: row.evidenceRef,
      });
    }
    return out;
  }

  /** The slugs a filter selects, and the documents behind them. */
  async function scopeOf(
    ctx: TenantContext,
    tx: Tx,
    filter: RegisterFilter,
  ): Promise<{ slugs: Set<string>; bySlug: Map<string, { id: string }> }> {
    const docs = await new LegalDocumentRepo(ctx, tx).list();
    const bySlug = new Map(docs.map((d) => [d.slug, { id: d.id }]));
    const slugs = new Set(
      docs
        .filter(
          (d) =>
            (filter.documentId === undefined || d.id === filter.documentId) &&
            (filter.slug === undefined || d.slug === filter.slug),
        )
        .map((d) => d.slug),
    );
    return { slugs, bySlug };
  }

  /** `pendingStamps` over the given documents (fetching versions and holdings). */
  async function pendingAmong(
    ctx: TenantContext,
    tx: Tx,
    membership: { readonly id: string; readonly kind: MembershipKind },
    docs: readonly LegalDocumentRow[],
  ): Promise<readonly PendingAcceptance[]> {
    if (docs.length === 0) return [];
    const versions = new LegalDocumentVersionRepo(ctx, tx);
    // One read of everything this membership holds, rather than one per document: the decision
    // below is pure, so it can be unit-tested, and `pendingFor` is on the bootstrap's hot path.
    const held = await new AttestationRepo(ctx, tx).listFor(membership.id);
    const documents: PendingInput["documents"][number][] = [];
    for (const doc of docs) {
      const current =
        doc.currentVersionId === null ? undefined : await versions.byId(doc.currentVersionId);
      documents.push({
        id: doc.id,
        slug: doc.slug,
        title: doc.title,
        kind: doc.kind,
        audience: doc.audience,
        ceremony: doc.ceremony,
        current:
          current === undefined
            ? undefined
            : {
                versionNo: current.versionNo,
                body: current.body,
                bodySha256: Buffer.from(current.bodySha256).toString("hex"),
                effectiveAt: current.effectiveAt,
              },
      });
    }
    return pendingStamps({
      documents,
      membershipKind: membership.kind,
      held,
      now: now(),
    });
  }

  async function resourcePendingFor(
    ctx: TenantContext,
    tx: Tx,
    membership: { readonly id: string; readonly kind: MembershipKind },
  ): Promise<readonly PendingAcceptance[]> {
    const ids = new Set(await ndaGateDocumentIds(tx, ctx, membership.id));
    if (ids.size === 0) return [];
    const docs = (await new LegalDocumentRepo(ctx, tx).list()).filter(
      // `requiresAcceptance` documents are `pendingFor`'s; listed there, never twice.
      (d) => ids.has(d.id) && !d.requiresAcceptance,
    );
    return pendingAmong(ctx, tx, membership, docs);
  }

  return {
    async pendingFor(ctx, tx, membership) {
      const docs = await new LegalDocumentRepo(ctx, tx).requiringAcceptance();
      return pendingAmong(ctx, tx, membership, docs);
    },

    resourcePendingFor,

    async isPendingFor(ctx, tx, membership, documentId) {
      const doc = await new LegalDocumentRepo(ctx, tx).byId(documentId);
      if (doc === undefined) return false;
      if (doc.requiresAcceptance) {
        return (await pendingAmong(ctx, tx, membership, [doc])).length > 0;
      }
      return (await resourcePendingFor(ctx, tx, membership)).some(
        (p) => p.documentId === documentId,
      );
    },

    async accept(ctx, tx, input) {
      const doc = await new LegalDocumentRepo(ctx, tx).byId(input.documentId);
      if (doc === undefined) throw new ComplianceError("not_found", "no such legal document");
      const versions = new LegalDocumentVersionRepo(ctx, tx);
      const version = await versions.byNo(doc.id, input.versionNo);
      if (version === undefined) {
        throw new ComplianceError("not_found", "no such version", {
          documentId: doc.id,
          versionNo: input.versionNo,
        });
      }
      // Accepting a superseded version would record agreement to text the member is no longer
      // being served, which is worse than no record at all.
      if (version.id !== doc.currentVersionId) {
        throw new ComplianceError("conflict", "that version is no longer the current one", {
          documentId: doc.id,
          versionNo: input.versionNo,
        });
      }

      const esign = input.evidence?.method === "esign";
      if (esign && !ESIGN_EVIDENCE_REF_RE.test(input.evidence?.evidenceRef ?? "")) {
        throw new ComplianceError(
          "validation_failed",
          "an e-signed acceptance needs an esign:v1:<envelopeId> evidence reference",
        );
      }
      // Backstop for the route's 409 `esign_required` (E3.5): a document whose ceremony is a
      // vendor e-signature cannot be accepted by click-wrap through any caller.
      if (!esign && doc.ceremony === "esign") {
        throw new ComplianceError("conflict", "this document must be signed electronically", {
          reason: "esign_required",
        });
      }
      const kind = stamp(doc.slug, version.versionNo);
      const attestations = new AttestationRepo(ctx, tx);
      const held = await attestations.current(input.membershipId, kind, now());
      // Idempotent: a double-click, a retry after a dropped response, or a reload of the gate
      // must not write a second row saying the same thing at a different time.
      if (held !== undefined) return { attestation: held, stamp: kind, recorded: false };

      // The attestation gate this acceptance settles is cached in `core.effective_access`. The
      // bump row-locks the workspace row, so it comes BEFORE the first audit entry: lock order is
      // entity rows → workspace row → audit chain (E3.3/E3.4). Settings writers take the workspace
      // row and then the chain; an acceptance that audited first and bumped after would invert
      // that and deadlock against them (E3.5 fix A2 — click-wrap and the e-sign collect alike).
      await bumpAclVersionInTx(tx, ctx.workspaceId);

      const acceptedAt = now();
      const typedName = input.typedName?.trim().slice(0, 200);
      const data: AcceptanceData = {
        documentId: doc.id,
        slug: doc.slug,
        versionNo: version.versionNo,
        // The server's own digest of the stored body, never a hash the client sent (C2).
        bodySha256: Buffer.from(version.bodySha256).toString("hex"),
        acceptedAt: acceptedAt.toISOString(),
        ...(input.evidence?.uaFamily === undefined ? {} : { uaFamily: input.evidence.uaFamily }),
        ...(input.evidence?.ipHash === undefined
          ? {}
          : { ipHash: Buffer.from(input.evidence.ipHash).toString("hex") }),
        ...(typedName === undefined || typedName === "" ? {} : { typedName }),
        ...(input.viaLinkId === undefined ? {} : { viaLinkId: input.viaLinkId }),
        ...(esign ? { method: "esign" as const } : {}),
      };

      // An accreditation acceptance writes TWO rows and they must not be collapsed (D5): the
      // click-wrap record of agreeing to this text, and the dated, expiring `accredited` fact the
      // gate reads. `accreditationAttestations` owns that split; see its comment for why.
      const isAccreditation = doc.kind === "accreditation";
      const answers = isAccreditation ? parseAnswers(input.accreditation) : undefined;
      const specs =
        answers === undefined
          ? undefined
          : accreditationAttestations({
              stamp: kind,
              signedAt: acceptedAt,
              answers,
              acceptance: { ...data },
            });

      let attestation = await attestations.record({
        membershipId: input.membershipId,
        kind,
        signedAt: acceptedAt,
        data: specs === undefined ? { ...data } : { ...specs[0].data },
        evidenceRef: input.evidence?.evidenceRef ?? null,
      });
      const accreditation =
        specs === undefined
          ? undefined
          : await attestations.record({
              membershipId: input.membershipId,
              kind: specs[1].kind,
              signedAt: specs[1].signedAt,
              expiresAt: specs[1].expiresAt,
              data: { ...specs[1].data },
              evidenceRef: null,
            });

      const acceptanceEvent = await deps.audit.record(tx, ctx, {
        action: "legal.document_accepted",
        resourceKind: "legal_document",
        resourceId: doc.id,
        subjectMembershipId: input.membershipId,
        actorMembershipId: input.actor?.membershipId ?? input.membershipId,
        ...(input.actor?.requestId === undefined ? {} : { requestId: input.actor.requestId }),
        meta: {
          slug: doc.slug,
          versionNo: version.versionNo,
          stamp: kind,
          bodySha256: data.bodySha256,
          ...(input.viaLinkId === undefined ? {} : { viaLinkId: input.viaLinkId }),
          ...(esign ? { method: "esign", evidenceRef: input.evidence?.evidenceRef ?? null } : {}),
          ...(accreditation === undefined
            ? {}
            : {
                accredited: true,
                accreditedUntil: accreditation.expiresAt?.toISOString() ?? null,
                categories: [...(answers?.categories ?? [])],
              }),
        },
      });

      // The certificate is built *after* the acceptance audit row, because it cites that row's
      // `seq` and `hash` — that is what binds it to the chain in both directions (D2). With no
      // issuer wired this does nothing at all and acceptance behaves exactly as it did before. An
      // e-signed acceptance gets none: the vendor's artifacts are its evidence, and its
      // `esign:v1:` reference must stand (E3.5).
      const certificate = esign
        ? undefined
        : await issueCertificate(deps.certificates, ctx, tx, {
            attestationId: attestation.id,
            membershipId: input.membershipId,
            documentId: doc.id,
            slug: doc.slug,
            title: doc.title,
            versionNo: version.versionNo,
            stamp: kind,
            bodySha256: data.bodySha256,
            acceptedAt,
            acceptanceSeq: acceptanceEvent.seq,
            acceptanceHash: acceptanceEvent.hash,
            ...(data.uaFamily === undefined ? {} : { uaFamily: data.uaFamily }),
            ...(data.ipHash === undefined ? {} : { ipHash: data.ipHash }),
            ...(data.typedName === undefined ? {} : { typedName: data.typedName }),
            ...(input.viaLinkId === undefined ? {} : { viaLinkId: input.viaLinkId }),
          });
      if (certificate !== undefined) {
        attestation =
          (await attestations.setEvidenceRef(attestation.id, certificate.reference)) ?? attestation;
      }

      await publish(tx, ctx, "legal.accepted", {
        documentId: doc.id,
        slug: doc.slug,
        versionNo: version.versionNo,
        membershipId: input.membershipId,
      });
      return {
        attestation,
        stamp: kind,
        recorded: true,
        ...(accreditation === undefined ? {} : { accreditation }),
        ...(certificate === undefined ? {} : { certificateSha256: certificate.sha256 }),
      };
    },

    async register(ctx, tx, filter = {}) {
      const { slugs, bySlug } = await scopeOf(ctx, tx, filter);
      const rows = await new AcceptanceRegisterRepo(ctx, tx).page({
        slugs: [...slugs],
        ...(filter.membershipId === undefined ? {} : { membershipId: filter.membershipId }),
        limit: MAX_REGISTER_ROWS,
      });
      return toEntries(rows, bySlug, slugs);
    },

    async registerPage(ctx, tx, input) {
      const filter = input.filter ?? {};
      const limit = Math.min(Math.max(input.limit ?? REGISTER_PAGE_DEFAULT, 1), REGISTER_PAGE_MAX);
      const after: RegisterKey | undefined =
        input.after === undefined ? undefined : decodeRegisterCursor(input.after);
      if (input.after !== undefined && after === undefined) {
        throw new ComplianceError("validation_failed", "malformed cursor");
      }
      const { slugs, bySlug } = await scopeOf(ctx, tx, filter);
      const rows = await new AcceptanceRegisterRepo(ctx, tx).page({
        slugs: [...slugs],
        ...(filter.membershipId === undefined ? {} : { membershipId: filter.membershipId }),
        ...(after === undefined ? {} : { after }),
        limit,
      });
      // The cursor comes from the last row READ, not the last entry kept: a page whose tail was
      // all unparseable kinds would otherwise restart from the wrong place and loop for ever.
      const last = rows.at(-1);
      return {
        entries: toEntries(rows, bySlug, slugs),
        nextCursor:
          rows.length < limit || last === undefined
            ? undefined
            : encodeRegisterCursor({
                signedAt: last.signedAt,
                membershipId: last.membershipId,
                kind: last.kind,
              }),
      };
    },
  };
}

/**
 * Validates the questionnaire answers, defaulting an absent body to "none of these apply" — a real
 * answer, and the one a 506(b) offering acts on. Malformed answers throw rather than being dropped:
 * silently recording an empty self-certification when the investor ticked four boxes would put the
 * wrong fact in an evidence row that outlives the offering by six years.
 */
function parseAnswers(raw: AccreditationAnswers | undefined): AccreditationAnswers {
  if (raw === undefined) return { categories: [] };
  const parsed = AccreditationAnswersSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ComplianceError("validation_failed", "malformed accreditation answers");
  }
  return parsed.data;
}

export type { RegisterEntry, RegisterFilter, RegisterKey, RegisterPage };
/** Re-exported so a caller can compute an expected `attestation.data` hash without the repo. */
export { bodyDigest };
