import { delegationAdmitsModule } from "@fundroom/domain";
import { type PageDoc, validateDoc } from "@fundroom/module-content";
import { z } from "@hono/zod-openapi";

/*
 * Pure model of an investor update (E1.4): the audience (who receives the mail and may open
 * the archive), the per-section rules (the content module's visibility rules minus
 * `public`: an update is never a public page), slugs and the state machine.
 */
export const AUDIENCE_SCHEMA_VERSION = 1;
export const VISIBILITY_SCHEMA_VERSION = 1;

export const AudienceSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("all") }).strict(),
    z.object({ kind: z.literal("groups"), groupIds: z.array(z.uuid()).min(1).max(50) }).strict(),
  ])
  .openapi("UpdateAudience");
export type Audience = z.output<typeof AudienceSchema>;
export const DEFAULT_AUDIENCE: Audience = Object.freeze({ kind: "all" });

export const SectionRuleSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("authenticated") }).strict(),
    z.object({ mode: z.literal("groups"), groupIds: z.array(z.uuid()).min(1).max(50) }).strict(),
    z.object({ mode: z.literal("staff_only") }).strict(),
  ])
  .openapi("UpdateSectionRule");
export type SectionRule = z.output<typeof SectionRuleSchema>;
export const DEFAULT_RULE: SectionRule = Object.freeze({ mode: "authenticated" });

export const SectionRulesSchema = z
  .record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u), SectionRuleSchema)
  .openapi("UpdateSectionRules");
export type SectionRules = z.output<typeof SectionRulesSchema>;

export function parseAudience(raw: unknown): Audience {
  const r = AudienceSchema.safeParse(raw);
  return r.success ? r.data : DEFAULT_AUDIENCE;
}

export function parseSectionRules(raw: unknown): SectionRules {
  const out: Record<string, SectionRule> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const r = SectionRuleSchema.safeParse(value);
    out[key] = r.success ? r.data : DEFAULT_RULE;
  }
  return out;
}

export interface Reader {
  readonly kind: "staff" | "external";
  readonly groupIds: readonly string[];
  /**
   * A delegate's scope (E3.2), `null`/`undefined` for everybody else. An update addressed to every
   * member is "updates" content: a `data_room` delegate is not in its audience (the
   * TypeScript twin of `updates.audience_includes_current`, migration 0003).
   */
  readonly delegateScope?: "all" | "data_room" | "updates" | null | undefined;
}

export function audienceIncludes(audience: Audience, reader: Reader): boolean {
  if (reader.kind === "staff") return true;
  // A delegate reads nothing of a module its scope does not admit — not even through its own
  // groups (the search `groups` arm agrees).
  if (!delegationAdmitsModule(reader.delegateScope, "updates")) return false;
  if (audience.kind === "all") return true;
  return audience.groupIds.some((g) => reader.groupIds.includes(g));
}

/** Staff readers see everything (the editor badges the audience); the email is per reader. */
export function sectionVisible(rule: SectionRule, reader: Reader): boolean {
  if (reader.kind === "staff") return true;
  switch (rule.mode) {
    case "authenticated":
      return true;
    case "groups":
      return rule.groupIds.some((g) => reader.groupIds.includes(g));
    case "staff_only":
      return false;
  }
}

/** Drops rules of sections that no longer exist and defaults the new ones. */
export function normaliseRules(doc: PageDoc, rules: SectionRules): SectionRules {
  const out: Record<string, SectionRule> = {};
  for (const section of doc.sections) out[section.key] = rules[section.key] ?? DEFAULT_RULE;
  return out;
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/u;

export function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 60)
    .replace(/-+$/u, "");
  return base.length > 0 ? base : "update";
}

/**
 * An update uses the same block registry as a page, minus `hero`: an update is a letter, and a
 * full-bleed marketing header at the top of one reads as the wrong genre in a mail client.
 * `disclaimer` is deliberately *allowed* — a legal legend under an update is exactly what the
 * block is for, the version that went out is stamped on `post_version.disclaimer_version`, and
 * both email parts render it (render/email.ts).
 */
export function validatePostDoc(input: unknown): PageDoc {
  const doc = validateDoc(input);
  for (const section of doc.sections) {
    for (const block of section.blocks) {
      if (block.type === "hero") {
        throw new UpdatesModelError("validation_failed", "hero blocks are not allowed in updates", {
          path: `sections.${section.key}.blocks.${block.id}`,
        });
      }
    }
  }
  return doc;
}

export class UpdatesModelError extends Error {
  override readonly name = "UpdatesModelError";
  constructor(
    readonly code: "validation_failed",
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
  }
}

export type PostState = "draft" | "scheduled" | "sending" | "sent" | "archived";

/** Transitions a staff action may request; the send job owns `sending → sent`. */
export const TRANSITIONS: Readonly<Record<PostState, readonly PostState[]>> = {
  draft: ["scheduled", "sending", "archived"],
  scheduled: ["draft", "sending"],
  sending: ["sent"],
  sent: ["archived", "sending"],
  archived: ["draft", "sent"],
};

export function canTransition(from: PostState, to: PostState): boolean {
  return TRANSITIONS[from].includes(to);
}
