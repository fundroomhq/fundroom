import type { TenantContext } from "@fundroom/db";
import type { PageDoc } from "@fundroom/module-content";
import type {
  AiPrompt,
  AiRefusal,
  AiTaskDefinition,
  AiTaskInput,
  ModuleServices,
} from "@fundroom/module-kit";
import { AiDraftBody } from "../contracts.js";
import { AudienceSchema, SectionRuleSchema } from "../model.js";
import { PostRepo, VersionRepo } from "../repos/updates-repo.js";
import { templateByKey } from "../templates.js";
import {
  buildUserPrompt,
  docText,
  kpiBudget,
  outlineOf,
  UPDATE_DRAFT_JSON_SCHEMA,
  UPDATE_DRAFT_SYSTEM_PROMPT,
} from "./prompt.js";
import { buildDraftResult, type DraftSources, MAX_KPI_IDS } from "./result.js";

/*
 * The `update_draft` AI task (E3.12 §10, ADR-0060). The kernel's `ai.run` job calls `prepare`
 * and `finish` outside any transaction, after re-checking that the feature is on and that the
 * requester still holds `updates.manage`.
 *
 * What `prepare` may read, and under which identity, is the security property of this file:
 * every read goes through `services.db.withTenant(ctx)` with the request's own tenant context
 * (and refuses outright if that context names another workspace than the request), so RLS and
 * the repositories' explicit workspace fence both bound it to the workspace that asked. It
 * reads only what every investor of the workspace could already read (R2-H2): the newest sent
 * update that went to everyone, minus its group-only and staff-only sections, and — through
 * metrics' `kpis` context provider, never by importing that module — the KPIs published to
 * every investor, and only while the metrics module is enabled for it. A draft's prose goes to
 * the new update's whole audience, so nothing narrower may be its material.
 */

export const UPDATE_DRAFT_PERMISSION = "updates.manage";
/** KPI context smaller than this is not worth asking for (it would be one metric at best). */
const MIN_KPI_CHARS = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Handed from `prepare` to `finish` in memory (`AiPrompt.state`); never stored. */
interface DraftState extends DraftSources {
  readonly marker: "update_draft";
}

function isDraftState(v: unknown): v is DraftState {
  return (
    typeof v === "object" && v !== null && (v as { marker?: unknown }).marker === "update_draft"
  );
}

async function kpiContext(
  services: ModuleServices,
  ctx: TenantContext,
  maxChars: number,
): Promise<{ text: string; definitionIds: string[] } | null> {
  if (maxChars < MIN_KPI_CHARS) return null;
  const registered = services.registry.aiContextProviders.get("kpis");
  if (registered === undefined) return null;
  const { enabled } = await services.enablement.get(services.db, ctx);
  if (!enabled.has(registered.module)) return null;
  let got: Awaited<ReturnType<typeof registered.provider.provide>>;
  try {
    got = await registered.provider.provide(ctx, { maxChars });
  } catch (error) {
    // A draft without KPI lines is still a draft; the model is told there is no KPI data.
    services.log("updates.ai_kpis_failed", {
      level: "warn",
      workspaceId: ctx.workspaceId,
      error: error instanceof Error ? error.name : "unknown",
    });
    return null;
  }
  if (got === null || got.text.trim().length === 0) return null;
  return {
    text: got.text.slice(0, maxChars),
    definitionIds: [...new Set(got.definitionIds)]
      .filter((id) => UUID_RE.test(id))
      .slice(0, MAX_KPI_IDS),
  };
}

/** Sent posts looked at for one that went to everyone. */
const LAST_UPDATE_CANDIDATES = 20;

/**
 * The sections of a sent version that every investor in the audience could read: a section
 * rule of `groups` or `staff_only` (or one that does not parse) keeps its text out of the
 * prompt. A missing rule is the default, `authenticated` (`normaliseRules`).
 */
export function everyoneSections(doc: PageDoc, visibility: unknown): PageDoc {
  const rules =
    typeof visibility === "object" && visibility !== null
      ? (visibility as Record<string, unknown>)
      : {};
  return {
    ...doc,
    sections: doc.sections.filter((section) => {
      const raw = rules[section.key];
      if (raw === undefined) return true;
      const rule = SectionRuleSchema.safeParse(raw);
      return rule.success && rule.data.mode === "authenticated";
    }),
  };
}

/**
 * R2-H2: the newest sent update whose published version went to **everyone** (`audience.kind
 * === "all"`, parsed strictly — a malformed audience is not "all"), reduced to its
 * everyone-visible sections. A board-only update is never the model's material: its prose
 * would reappear in a draft whose default audience is every investor.
 */
async function lastSentUpdate(
  services: ModuleServices,
  ctx: TenantContext,
): Promise<{ postId: string; title: string; sentAt: string; text: string } | null> {
  return services.db.withTenant(ctx, async (tx) => {
    const versions = new VersionRepo(ctx, tx);
    for (const p of await new PostRepo(ctx, tx).recentSent(LAST_UPDATE_CANDIDATES)) {
      if (p.publishedVersionId === null || p.sentAt === null) continue;
      const v = await versions.byId(p.publishedVersionId);
      if (v === undefined) continue;
      const audience = AudienceSchema.safeParse(v.audience);
      if (!audience.success || audience.data.kind !== "all") continue;
      const doc = v.doc as PageDoc;
      if (!Array.isArray(doc?.sections)) continue;
      return {
        postId: p.id,
        title: v.title,
        sentAt: p.sentAt.toISOString(),
        text: docText(v.title, everyoneSections(doc, v.visibility)),
      };
    }
    return null;
  });
}

export function createUpdateDraftTask(services: ModuleServices): AiTaskDefinition {
  return {
    feature: "update_draft",
    permission: UPDATE_DRAFT_PERMISSION,
    paramsSchema: AiDraftBody,

    async prepare(ctx: TenantContext, input: AiTaskInput): Promise<AiPrompt | AiRefusal> {
      // The request's own workspace or nothing: this is the only tenant the task may read.
      if (ctx.workspaceId !== input.workspaceId) return { kind: "refused", code: "forbidden" };
      const params = AiDraftBody.safeParse(input.params);
      if (!params.success) return { kind: "refused", code: "invalid_params" };
      const template = templateByKey(params.data.template);
      if (template === undefined) return { kind: "refused", code: "invalid_params" };
      const notes = params.data.notes;

      const kpis = await kpiContext(services, ctx, kpiBudget(input.maxInputChars, notes));
      const last = await lastSentUpdate(services, ctx);
      const { user, lastUpdateSent } = buildUserPrompt(
        {
          outline: outlineOf(template),
          notes,
          kpis: kpis?.text ?? null,
          lastUpdate: last?.text ?? null,
        },
        input.maxInputChars,
      );
      const state: DraftState = {
        marker: "update_draft",
        kpiDefinitionIds: kpis?.definitionIds ?? [],
        lastUpdate:
          last !== null && lastUpdateSent
            ? { postId: last.postId, title: last.title, sentAt: last.sentAt }
            : null,
      };
      return {
        kind: "prompt",
        system: UPDATE_DRAFT_SYSTEM_PROMPT,
        user,
        json: UPDATE_DRAFT_JSON_SCHEMA,
        state,
      };
    },

    async finish(_ctx, _input, prompt, output) {
      const state: DraftSources = isDraftState(prompt.state)
        ? prompt.state
        : { kpiDefinitionIds: [], lastUpdate: null };
      // The user prompt is exactly the material the model was given (notes, KPI lines, last
      // update, outline): links and figures in the draft are checked against it.
      return buildDraftResult(output.json, state, prompt.user);
    },
  };
}
