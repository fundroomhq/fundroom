import { systemContext, type TenantContext } from "@fundroom/db";
import type {
  AiPrompt,
  AiRefusal,
  AiTaskDefinition,
  AiTaskInput,
  AiTaskOutcome,
  ModuleServices,
} from "@fundroom/module-kit";
import type { AccessHolder, PendingGate } from "@fundroom/ports";
import { z } from "zod";
import {
  type QaAiMatchMode,
  type QaAiScope,
  type QaAiSourceDocument,
  QaAiSourceRepo,
} from "../../repos/qa-ai-repo.js";
import { QaQuestionRepo, QaTargetRepo, type QaTargetRow } from "../../repos/qa-repo.js";
import type { QaQuestion } from "../../schema/qa.js";
import { documentRef, folderRef, loadVeil } from "../../service/access.js";
import { finishAnswer, QaAiOutputSchema } from "./citations.js";
import {
  buildPassages,
  passageBudget,
  QA_AI_JSON_SCHEMA,
  QA_AI_PASSAGE_MIN,
  QA_AI_SYSTEM_PROMPT,
  QA_AI_TOP_PAGES,
  type QaAiCandidate,
  type QaAiPassage,
  userPrompt,
} from "./prompt.js";

/*
 * The `qa_answer` AI task (E3.12, ADR-0060): a suggested answer to one investor question, drawn
 * ONLY from documents that investor — the ASKER, not the staff member who pressed the button —
 * may view now, and (for a folder question) only from documents everyone who can see the folder
 * can see too. The answer is a suggestion stored on the kernel's request row; staff apply it by
 * saving an answer (`PUT …/answer`), which makes them its author, so four-eyes approval applies.
 *
 * `prepare` (outside any transaction — `AuthzPort.check()` / `whoHasAccess()` never nest in one):
 *   1. the question, as system: unknown, closed (incl. erased) or with a binned target →
 *      `subject_gone`; no asker (a staff-entered or imported entry) → `no_asker`: there is no
 *      investor whose access could bound the sources.
 *   2. candidates: documents in scope (the target document, or live documents under the target
 *      folder) with a page MATCHING the question, best first (review R2-L1: the match comes first,
 *      so a crowd of documents the asker cannot see never hides the ones they can), paged.
 *   3. per candidate: the staff-only veil, then `authz.check(asker, document at its folder path,
 *      "view")` — only `granted` survives, until 200 survive (at most 1 000 checks). The asker is
 *      not in the room, so their request facts (auth level, IP) cannot be reconstructed: the check
 *      runs with none, and a session-bound gate (MFA level, IP allow-list) stays pending — the
 *      document is left out. Fail closed.
 *   4. FTS over the survivors' CURRENT versions (Postgres parser), best pages first.
 *   5. folder questions (review R2-H1): an answer released to the folder's audience must not
 *      quote a document with a narrower one. A page's document is used only if EVERY membership
 *      that can view the target folder (`whoHasAccess`, gated holders included) can view it too,
 *      with no gate or earlier expiry the folder does not have. Undecidable → left out.
 *   6. top 8 pages, windowed and within the input budget → passages `S1..Sn`. None → `no_sources`.
 * `finish`: strict citation verification against the passages sent (`citations.ts`).
 */

/** Documents that may pass the asker's check (the scope bound). */
export const QA_AI_SCOPE_MAX = 200;
/** Access checks spent on candidates before giving up. */
export const QA_AI_CHECKS_MAX = 1000;
/** Pages read to find 8 from documents with the folder's audience. */
const PAGES_SCANNED = 64;
/** Distinct documents whose audience is compared with the folder's. */
const AUDIENCE_CHECKS_MAX = 32;

export const QaAiParamsSchema = z.object({}).strict();

/** Handed from `prepare` to `finish` through `AiPrompt.state` (never stored). */
interface QaAiState {
  readonly passages: readonly QaAiPassage[];
  readonly searchedDocuments: number;
}

function isState(v: unknown): v is QaAiState {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Partial<QaAiState>;
  return Array.isArray(s.passages) && typeof s.searchedDocuments === "number";
}

const refused = (code: string): AiRefusal => ({ kind: "refused", code });

type Loaded =
  | { readonly kind: "gone" }
  | { readonly kind: "no_asker" }
  | {
      readonly kind: "ok";
      readonly question: QaQuestion;
      readonly asker: string;
      readonly target: QaTargetRow;
    };

const gateKey = (g: PendingGate) => `${g.kind}|${g.source}|${JSON.stringify(g.detail)}`;

/** Who can view a resource: membership id → how (gates, expiry). */
function viewers(holders: readonly AccessHolder[]): Map<string, AccessHolder> {
  return new Map(
    holders.filter((h) => h.capabilities.includes("view")).map((h) => [h.membershipId, h]),
  );
}

/**
 * Whether a document's audience covers the target's: every viewer of the target views the
 * document, with no gate the target lacks and no earlier expiry.
 */
export function audienceCovers(
  target: ReadonlyMap<string, AccessHolder>,
  doc: ReadonlyMap<string, AccessHolder>,
): boolean {
  for (const [id, t] of target) {
    const d = doc.get(id);
    if (d === undefined) return false;
    const allowed = new Set(t.pendingGates.map(gateKey));
    if (d.pendingGates.some((g) => !allowed.has(gateKey(g)))) return false;
    if (d.expiresAt !== undefined && (t.expiresAt === undefined || d.expiresAt < t.expiresAt))
      return false;
  }
  return true;
}

export function createQaAnswerTask(services: ModuleServices): AiTaskDefinition {
  const { db } = services;

  /** Step 1, one short system read. */
  function load(workspaceId: string, questionId: string): Promise<Loaded> {
    const sys = systemContext(workspaceId);
    return db.withTenant(sys, async (tx): Promise<Loaded> => {
      const q = await new QaQuestionRepo(sys, tx).byId(questionId);
      if (q === undefined || q.status === "closed" || q.closedReason === "erased")
        return { kind: "gone" };
      if (q.askerMembershipId === null) return { kind: "no_asker" };
      const targetId = q.targetKind === "document" ? q.documentId : q.folderId;
      if (targetId === null) return { kind: "gone" };
      const target = await new QaTargetRepo(sys, tx).one(q.targetKind, targetId, true);
      if (target === undefined) return { kind: "gone" };
      return { kind: "ok", question: q, asker: q.askerMembershipId, target };
    });
  }

  /** Steps 2–3: matching documents the asker may view now (veil first, then `granted` only). */
  async function viewableMatches(
    workspaceId: string,
    asker: string,
    scope: QaAiScope,
    text: string,
    mode: QaAiMatchMode,
  ): Promise<QaAiSourceDocument[]> {
    const sys = systemContext(workspaceId);
    const veil = await loadVeil(services, workspaceId);
    const out: QaAiSourceDocument[] = [];
    for (let offset = 0; offset < QA_AI_CHECKS_MAX && out.length < QA_AI_SCOPE_MAX; ) {
      const limit = Math.min(QA_AI_SCOPE_MAX, QA_AI_CHECKS_MAX - offset);
      const batch = await db.withTenant(sys, (tx) =>
        new QaAiSourceRepo(sys, tx).matchingDocuments(scope, text, mode, { limit, offset }),
      );
      for (const d of batch) {
        if (out.length >= QA_AI_SCOPE_MAX) break;
        if (veil.covers(d.folderPath)) continue;
        const decision = await services.authz.check(
          { workspaceId, membershipId: asker },
          documentRef(d),
          "view",
          {},
        );
        if (decision.allowed && decision.reason === "granted") out.push(d);
      }
      if (batch.length < limit) break;
      offset += batch.length;
    }
    return out;
  }

  /** Step 5 for a folder question: only documents with (at least) the folder's audience. */
  async function audienceFilter(
    workspaceId: string,
    target: QaTargetRow,
  ): Promise<(d: QaAiSourceDocument) => Promise<boolean>> {
    if (target.kind !== "folder") return async () => true;
    const folderViewers = viewers(
      await services.authz.whoHasAccess(workspaceId, folderRef(target)),
    );
    const decided = new Map<string, boolean>();
    return async (d) => {
      const known = decided.get(d.id);
      if (known !== undefined) return known;
      if (decided.size >= AUDIENCE_CHECKS_MAX) return false;
      const ok = audienceCovers(
        folderViewers,
        viewers(await services.authz.whoHasAccess(workspaceId, documentRef(d))),
      );
      decided.set(d.id, ok);
      return ok;
    };
  }

  /** Steps 2–5 in one match mode: the eligible pages, best first, and how many documents passed. */
  async function select(
    workspaceId: string,
    asker: string,
    scope: QaAiScope,
    text: string,
    mode: QaAiMatchMode,
    wide: (d: QaAiSourceDocument) => Promise<boolean>,
  ): Promise<{ candidates: QaAiCandidate[]; searched: number }> {
    const docs = await viewableMatches(workspaceId, asker, scope, text, mode);
    if (docs.length === 0) return { candidates: [], searched: 0 };
    const sys = systemContext(workspaceId);
    const hits = await db.withTenant(sys, (tx) =>
      new QaAiSourceRepo(sys, tx).searchPages(
        docs.map((d) => d.versionId),
        text,
        mode,
        PAGES_SCANNED,
      ),
    );
    const docOf = new Map(docs.map((d) => [d.versionId, d]));
    const candidates: QaAiCandidate[] = [];
    for (const h of hits) {
      if (candidates.length >= QA_AI_TOP_PAGES) break;
      const d = docOf.get(h.versionId);
      if (d === undefined || !(await wide(d))) continue;
      candidates.push({
        documentId: d.id,
        versionId: d.versionId,
        pageNo: h.pageNo,
        documentTitle: d.title,
        pageText: h.text,
      });
    }
    return { candidates, searched: docs.length };
  }

  return {
    feature: "qa_answer",
    permission: "data-room.qa_answer",
    paramsSchema: QaAiParamsSchema,

    async prepare(_ctx: TenantContext, input: AiTaskInput): Promise<AiPrompt | AiRefusal> {
      if (input.subjectId === null) return refused("subject_gone");
      const loaded = await load(input.workspaceId, input.subjectId);
      if (loaded.kind === "gone") return refused("subject_gone");
      if (loaded.kind === "no_asker") return refused("no_asker");
      const { question, target } = loaded;
      const text = `${question.subject}\n${question.body}`;
      const scope: QaAiScope =
        target.kind === "document" ? { documentId: target.id } : { underPath: target.path };
      const wide = await audienceFilter(input.workspaceId, target);
      // Every term first; any term, weighted by rarity, only when every-term yields no page that
      // passes ALL filters (asker access and folder audience — fix round 3, RR3-L1).
      let picked = await select(
        input.workspaceId,
        loaded.asker,
        scope,
        text,
        { kind: "all" },
        wide,
      );
      if (picked.candidates.length === 0) {
        const sys = systemContext(input.workspaceId);
        const weights = await db.withTenant(sys, (tx) =>
          new QaAiSourceRepo(sys, tx).lexemeWeights(scope, text),
        );
        if (weights.length > 0)
          picked = await select(
            input.workspaceId,
            loaded.asker,
            scope,
            text,
            { kind: "any", weights },
            wide,
          );
      }
      const { candidates } = picked;
      if (candidates.length === 0) return refused("no_sources");
      const budget = passageBudget(input.maxInputChars, question.subject, question.body);
      if (budget < QA_AI_PASSAGE_MIN) return refused("input_too_large");
      const sys = systemContext(input.workspaceId);
      const lexemes = await db.withTenant(sys, (tx) => new QaAiSourceRepo(sys, tx).lexemes(text));
      const passages = buildPassages(candidates, lexemes, budget);
      if (passages.length === 0) return refused("no_sources");
      const state: QaAiState = { passages, searchedDocuments: picked.searched };
      return {
        kind: "prompt",
        system: QA_AI_SYSTEM_PROMPT,
        user: userPrompt(question.subject, question.body, passages),
        json: QA_AI_JSON_SCHEMA,
        state,
      };
    },

    async finish(_ctx, _input, prompt, output): Promise<AiTaskOutcome> {
      if (!isState(prompt.state)) return refused("internal");
      const parsed = QaAiOutputSchema.safeParse(output.json);
      if (!parsed.success) return refused("invalid_output");
      const result = finishAnswer(
        parsed.data,
        prompt.state.passages,
        prompt.state.searchedDocuments,
      );
      return { kind: "result", result };
    },
  };
}
