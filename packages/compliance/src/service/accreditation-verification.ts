import type { TenantContext, Tx } from "@fundroom/db";
import { AttestationRepo } from "@fundroom/identity";
import type { AccreditationAnswersInput, LegalServices } from "@fundroom/module-kit";
import { type Actor, ComplianceError } from "../errors.js";
import {
  LegalDocumentRepo,
  LegalDocumentVersionRepo,
  noteFirstExposure,
} from "../repos/compliance-repo.js";
import { type AcceptanceService, createAcceptanceService } from "./acceptances.js";
import {
  ACCREDITATION_QUESTIONNAIRE_VERSION,
  type AccreditationAnswers,
  AccreditationAnswersSchema,
} from "./accreditation.js";
import type { ComplianceDeps } from "./types.js";

/*
 * The accreditation half of `LegalServices` (E2.5 decision D5).
 *
 * The rule this file exists to enforce is one line long: **a module never writes
 * `core.attestation`.** Accredited status is a kernel fact about a person — the policy-gate
 * evaluator settles `accredited` gates from it, the compliance register exports it, and it has to
 * expire on one clock whether it arrived from a questionnaire or from a staff member reading a
 * bank letter. A round module that wrote the row itself would own an evidence record whose
 * lifecycle belongs to compliance, and the second writer would be the one that got the twelve
 * months, the `data` shape or the ACL bump subtly wrong.
 *
 * So there are exactly two writers here and they are deliberately asymmetric:
 *
 *   `certifyAccreditation`       — the investor said so. Goes through `AcceptanceService.accept`,
 *                                  which is what produces the *two* rows E2.3 froze (the
 *                                  click-wrap record of agreeing to this text, and the dated,
 *                                  expiring `accredited` fact), the `legal.document_accepted`
 *                                  audit row, the certificate when an issuer is wired, the
 *                                  `legal.accepted` event and the `acl_version` bump. None of
 *                                  that is reimplemented here; a second copy of it would drift.
 *   `recordVerifiedAccreditation`— somebody checked. One `accredited` row, no click-wrap record,
 *                                  because nothing was agreed to: the evidence is a document an
 *                                  admin read, named by reference and never copied into `data`.
 *
 * `data.method` is what tells the two apart six years later (`self_certified` vs
 * `verified:<method>`), which is the first question an auditor asks of a 506(c) file.
 */

/** Documents of this kind carry the self-certification questionnaire (`kindForTemplate`). */
const ACCREDITATION_KIND = "accreditation";

/** The kind of the dated, expiring row the `accredited` gate reads (`evaluate.ts`). */
const ACCREDITED_KIND = "accredited";

/**
 * The accreditation vendors a provider actor may name (E3.7). Mirrors `ACCREDITATION_VENDOR_DRIVERS`
 * in `@fundroom/ports`, which this package does not depend on; the union type already says so at
 * compile time, and this is the runtime check for a caller that crossed the seam untyped. A row
 * naming a provider nobody can look up is an evidence record nobody can explain.
 */
const VENDOR_PROVIDERS: ReadonlySet<string> = new Set(["verifyinvestor", "parallel-markets"]);

export type AccreditationLegalServices = Pick<
  LegalServices,
  "accreditation" | "certifyAccreditation" | "noteExposure" | "recordVerifiedAccreditation"
>;

/**
 * The attestation reads and writes this service makes, as a two-method interface.
 *
 * It exists so the rules above — the `verified:` prefix, the refusal to record a verification
 * with no evidence, the "already accredited" re-read — can be tested without a database. They are
 * the rules a six-year evidence record depends on, and an integration test that needs Postgres to
 * assert them is a test that gets skipped.
 */
export interface AttestationStore {
  current(
    membershipId: string,
    kind: string,
    now: Date,
  ): Promise<{ readonly expiresAt: Date | null; readonly data: unknown } | undefined>;
  record(values: {
    readonly membershipId: string;
    readonly kind: string;
    readonly signedAt: Date;
    readonly expiresAt?: Date | undefined;
    readonly data: Readonly<Record<string, unknown>>;
    readonly evidenceRef?: string | undefined;
  }): Promise<{ readonly id: string }>;
}

/** Everything else this service reaches for, same reason. */
export interface AccreditationStore {
  attestations(ctx: TenantContext, tx: Tx): AttestationStore;
  /** The workspace's current *published* `accreditation` document, or nothing. */
  publishedAccreditationDocument(
    ctx: TenantContext,
    tx: Tx,
  ): Promise<{ readonly documentId: string; readonly versionNo: number } | undefined>;
  noteExposure(tx: Tx, ctx: TenantContext, membershipId: string, at: Date): Promise<void>;
}

/** The real repositories; overridden only by tests. */
export const POSTGRES_ACCREDITATION_STORE: AccreditationStore = {
  attestations: (ctx, tx) => new AttestationRepo(ctx, tx),
  publishedAccreditationDocument: currentAccreditationDocument,
  noteExposure: async (tx, ctx, membershipId, at) => {
    await noteFirstExposure(tx, ctx, membershipId, at);
  },
};

export interface AccreditationServiceOverrides {
  /** Defaults to `createAcceptanceService(deps)`; the one writer of the two-row rule. */
  readonly acceptances?: AcceptanceService | undefined;
  readonly store?: AccreditationStore | undefined;
}

/**
 * Builds the four methods. Takes the same `ComplianceDeps` as every other service in this package
 * so the composition root wires one object: `accept` needs the audit recorder, and the optional
 * certificate issuer rides along untouched (absent, an acceptance behaves exactly as it did
 * before E2.3 — attestation rows, audit row, ACL bump, null `evidence_ref`).
 */
export function createAccreditationVerificationService(
  deps: ComplianceDeps,
  overrides: AccreditationServiceOverrides = {},
): AccreditationLegalServices {
  const now = deps.now ?? (() => new Date());
  const acceptances = overrides.acceptances ?? createAcceptanceService(deps);
  const store = overrides.store ?? POSTGRES_ACCREDITATION_STORE;

  return {
    async accreditation(tx, ctx, membershipId) {
      const row = await store.attestations(ctx, tx).current(membershipId, ACCREDITED_KIND, now());
      // Not an error and not a throw: "is this person accredited" is asked by every
      // offering-aware screen and none of them can act on an exception.
      if (row === undefined) return { accredited: false };
      const data = (row.data ?? {}) as Record<string, unknown>;
      const method = typeof data["method"] === "string" ? data["method"] : undefined;
      // The click-wrap stamp the fact came from, when it came from one. A verified row has no
      // stamp, because nothing was agreed to — which is itself the answer to "how do you know?".
      const stamp = typeof data["slug"] === "string" ? stampOf(data) : undefined;
      return {
        accredited: true,
        ...(row.expiresAt === null ? {} : { expiresAt: row.expiresAt }),
        ...(method === undefined ? {} : { method }),
        ...(stamp === undefined ? {} : { stamp }),
      };
    },

    async certifyAccreditation(tx, ctx, input) {
      const answers = parseAnswers(input.answers);
      const published = await store.publishedAccreditationDocument(ctx, tx);
      if (published === undefined) {
        throw new ComplianceError(
          "accreditation_document_missing",
          "this workspace has not published an accreditation questionnaire to certify against",
          { kind: ACCREDITATION_KIND },
        );
      }
      const { documentId, versionNo } = published;
      const actor: Actor = {
        membershipId: input.actor.membershipId,
        ...(input.actor.requestId === undefined ? {} : { requestId: input.actor.requestId }),
        ...(input.actor.sessionId === undefined ? {} : { sessionId: input.actor.sessionId }),
      };
      const result = await acceptances.accept(ctx, tx, {
        membershipId: input.membershipId,
        documentId,
        versionNo,
        accreditation: answers,
        actor,
        ...(input.evidence === undefined ? {} : { evidence: { ...input.evidence } }),
      });
      /*
       * `recorded: false` means this exact version was already accepted and the existing row came
       * back unchanged — a double-click, a retry, a second interest submission in the same year.
       * The accreditation row is then absent from the result, so the standing one is read back
       * rather than reported as "not accredited": the member *is* accredited, by the row they
       * already hold, and a form that said otherwise would push them through the questionnaire
       * again to no effect.
       */
      const held =
        result.accreditation ??
        (await store.attestations(ctx, tx).current(input.membershipId, ACCREDITED_KIND, now()));
      return {
        stamp: result.stamp,
        accredited: held !== undefined,
        ...(held?.expiresAt == null ? {} : { expiresAt: held.expiresAt }),
        // "None of these apply" is a real answer and the one the 506(b) purchaser count acts on.
        nonAccredited: answers.categories.length === 0,
      };
    },

    async recordVerifiedAccreditation(tx, ctx, input) {
      const method = input.method.trim();
      if (method === "") {
        throw new ComplianceError(
          "validation_failed",
          "a verified accreditation must name the method it was verified by",
        );
      }
      const evidenceRef = input.evidenceRef.trim();
      if (evidenceRef === "") {
        // design/04 §1.6: verified without evidence is refused. A row asserting reasonable steps
        // with nothing behind it is worse than no row, because it reads as evidence.
        throw new ComplianceError(
          "validation_failed",
          "a verified accreditation must reference the evidence it was decided from",
        );
      }
      // E3.7: who decided — a staff member (named) or an accreditation vendor (the provider, and no
      // person). Checked here, not trusted from the type: `decidedBy` is the register's answer to
      // "who took the reasonable steps", and a provider actor's audit trail is the system's.
      const actor = input.actor as
        | { readonly membershipId?: unknown; readonly provider?: unknown }
        | undefined;
      let decided: { decidedBy: string } | { decidedBy: null; provider: string };
      if (actor !== undefined && "provider" in actor) {
        if (typeof actor.provider !== "string" || !VENDOR_PROVIDERS.has(actor.provider)) {
          throw new ComplianceError(
            "validation_failed",
            "a vendor-verified accreditation must name a known accreditation provider",
          );
        }
        decided = { decidedBy: null, provider: actor.provider };
      } else if (typeof actor?.membershipId === "string" && actor.membershipId.trim() !== "") {
        decided = { decidedBy: actor.membershipId };
      } else {
        throw new ComplianceError(
          "validation_failed",
          "a verified accreditation must name who decided it",
        );
      }
      const signedAt = now();
      const row = await store.attestations(ctx, tx).record({
        membershipId: input.membershipId,
        kind: ACCREDITED_KIND,
        signedAt,
        expiresAt: input.expiresAt,
        data: {
          // `verified:` prefix, not a bare method: the register's first question is whether the
          // issuer took steps of its own or took the investor's word.
          method: `verified:${method}`,
          evidenceRef,
          questionnaireVersion: input.questionnaireVersion ?? ACCREDITATION_QUESTIONNAIRE_VERSION,
          // E3.7: a vendor's decision names the provider and no person.
          ...decided,
          decidedAt: signedAt.toISOString(),
        },
        // The reference lives in `data` *and* here: `evidence_ref` is the column the acceptance
        // register exports, and `data` is what survives being read on its own.
        evidenceRef,
      });
      return { attestationId: row.id };
    },

    async noteExposure(tx, ctx, membershipId) {
      await store.noteExposure(tx, ctx, membershipId, now());
    },
  };
}

/** `<slug>:v<n>` rebuilt from the acceptance payload the two rows share. */
function stampOf(data: Record<string, unknown>): string | undefined {
  const slug = data["slug"];
  const versionNo = data["versionNo"];
  if (typeof slug !== "string" || typeof versionNo !== "number") return undefined;
  return `${slug}:v${versionNo}`;
}

/**
 * The workspace's published `accreditation` document, as the thing being certified against.
 *
 * "Published" is `current_version_id`: a document whose versions are all drafts has no text a
 * member could have been shown, so certifying against it would record agreement to nothing. More
 * than one such document is a tenant's own arrangement (counsel's edited copy beside the shipped
 * one); the first by slug wins, deterministically, rather than the newest — an admin adding a
 * second document must not silently move what every existing member is certifying against.
 */
async function currentAccreditationDocument(
  ctx: TenantContext,
  tx: Tx,
): Promise<{ documentId: string; versionNo: number } | undefined> {
  const documents = await new LegalDocumentRepo(ctx, tx).byKind(ACCREDITATION_KIND);
  const published = documents.find((d) => d.currentVersionId !== null);
  if (published?.currentVersionId == null) return undefined;
  const version = await new LegalDocumentVersionRepo(ctx, tx).byId(published.currentVersionId);
  if (version === undefined) return undefined;
  return { documentId: published.id, versionNo: version.versionNo };
}

/**
 * Validates the answers at the seam rather than trusting the structural type that crossed it.
 * `AccreditationAnswersSchema` is the list of record (`section` is an enum there, a bare string
 * in `AccreditationAnswersInput`), and malformed answers must throw rather than be dropped:
 * silently recording an empty self-certification when the investor ticked four boxes would put
 * the wrong fact in an evidence row that outlives the offering by six years.
 */
function parseAnswers(raw: AccreditationAnswersInput): AccreditationAnswers {
  const parsed = AccreditationAnswersSchema.safeParse({
    categories: [...raw.categories],
    ...(raw.section === undefined ? {} : { section: raw.section }),
    ...(raw.note === undefined ? {} : { note: raw.note }),
    ...(raw.questionnaireVersion === undefined
      ? {}
      : { questionnaireVersion: raw.questionnaireVersion }),
  });
  if (!parsed.success) {
    throw new ComplianceError("validation_failed", "malformed accreditation answers");
  }
  return parsed.data;
}
