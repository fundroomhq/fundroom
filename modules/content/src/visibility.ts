import type { BlockViewer } from "@fundroom/module-kit";
import { z } from "@hono/zod-openapi";

/*
 * Section visibility (design/06 §8, ADR-0033 §3). Rules live apart from the document and
 * are snapshotted at publish. Every new section is `authenticated` (any live member);
 * `public` is only honoured when the workspace setting `content.allowPublicSections` is on,
 * checked both when the rule is written and when a page is rendered.
 */
export const VISIBILITY_SCHEMA_VERSION = 1;

export const VisibilityRuleSchema = z
  .discriminatedUnion("mode", [
    z.object({ mode: z.literal("authenticated") }).strict(),
    z.object({ mode: z.literal("groups"), groupIds: z.array(z.uuid()).min(1).max(50) }).strict(),
    z.object({ mode: z.literal("staff_only") }).strict(),
    z.object({ mode: z.literal("public") }).strict(),
  ])
  .openapi("VisibilityRule");

export type VisibilityRule = z.output<typeof VisibilityRuleSchema>;

export const DEFAULT_RULE: VisibilityRule = Object.freeze({ mode: "authenticated" });

/** Section key → rule. Keys must match the document's section keys. */
export const VisibilityMapSchema = z
  .record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/u), VisibilityRuleSchema)
  .openapi("VisibilityMap");
export type VisibilityMap = z.output<typeof VisibilityMapSchema>;

/** Parses a stored map leniently: an unreadable rule falls back to the default (never to public). */
export function parseVisibilityMap(raw: unknown): VisibilityMap {
  const out: Record<string, VisibilityRule> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const r = VisibilityRuleSchema.safeParse(value);
    out[key] = r.success ? r.data : DEFAULT_RULE;
  }
  return out;
}

export function ruleFor(map: VisibilityMap, sectionKey: string): VisibilityRule {
  return map[sectionKey] ?? DEFAULT_RULE;
}

/**
 * Whether `viewer` may see a section under `rule`. Staff see every section (they edit the
 * page; the UI badges the audience); `preview` answers what a given audience sees.
 */
export function sectionVisible(
  rule: VisibilityRule,
  viewer: BlockViewer,
  options: { readonly allowPublic: boolean },
): boolean {
  if (viewer.kind === "staff") return true;
  switch (rule.mode) {
    case "public":
      return options.allowPublic ? true : viewer.kind !== "anonymous";
    case "authenticated":
      return viewer.kind !== "anonymous";
    case "groups":
      return viewer.kind === "external" && rule.groupIds.some((g) => viewer.groupIds.includes(g));
    case "staff_only":
      return false;
  }
}

/** The audiences the editor can preview as. */
export const PreviewAsSchema = z
  .string()
  .regex(/^(authenticated|public|staff|group:[0-9a-f-]{36})$/u)
  .openapi({ example: "group:0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c03" });

export function viewerForPreview(as: string): BlockViewer {
  if (as === "public") return { kind: "anonymous", groupIds: [] };
  if (as === "staff") return { kind: "staff", groupIds: [] };
  if (as.startsWith("group:")) return { kind: "external", groupIds: [as.slice("group:".length)] };
  return { kind: "external", groupIds: [] };
}
