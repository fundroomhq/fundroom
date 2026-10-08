import type {
  BlockHydrationContext,
  ModuleServices,
  ResolvedDisclaimer,
} from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { DISCLAIMER_SLUG_RE } from "./blocks.js";

/*
 * Hydration for the `disclaimer` block (E1.6). Unlike `metric_grid` and `document_list`, the
 * data behind this block is not another module's: it is the kernel's legal library, reached
 * through `ModuleServices.legal`. So the content module registers this hydrator on its own
 * manifest and the block is available in every workspace, whatever else is switched on.
 */

/** The slug a block asks for, or `undefined` for "whatever the workspace calls its default". */
export function slugOf(data: JsonObject): string | undefined {
  const slug = data["slug"];
  return typeof slug === "string" && DISCLAIMER_SLUG_RE.test(slug) ? slug : undefined;
}

/**
 * What the client gets: the text as published plus the identity of the version it is. The
 * body is Markdown (the same subset `rich_text` uses) and `effectiveAt` is an ISO string
 * because a hydrated payload travels as JSON.
 */
export function disclaimerPayload(resolved: ResolvedDisclaimer): JsonObject {
  return {
    slug: resolved.slug,
    title: resolved.title,
    versionNo: resolved.versionNo,
    body: resolved.body,
    effectiveAt: resolved.effectiveAt.toISOString(),
  };
}

export function createDisclaimerHydrator(services: ModuleServices) {
  return {
    type: "disclaimer" as const,
    async hydrate(data: JsonObject, ctx: BlockHydrationContext): Promise<JsonObject> {
      const resolved = await services.db.withTenant(ctx.tenant, (tx) =>
        services.legal.resolveDisclaimer(tx, ctx.tenant, slugOf(data)),
      );
      /*
       * A workspace with no disclaimer is not a failure, so we do not throw: `unavailable`
       * would say "hydration_failed" and the renderer would apologise for a broken block. An
       * empty payload is the honest answer — there is simply no text to show — and the client
       * renders nothing for a disclaimer whose body it cannot read.
       */
      return resolved === undefined ? {} : disclaimerPayload(resolved);
    },
  };
}
