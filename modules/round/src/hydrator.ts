import { systemContext } from "@fundroom/db";
import { delegationAdmitsModule } from "@fundroom/domain";
import type { BlockHydrationContext, ModuleServices } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import type { Terms } from "@fundroom/round-terms";
import { RoundRepo, TermsRepo } from "./repos/round-repo.js";
import { investorProgress, readAllocation } from "./service/allocation.js";

/*
 * The `round_summary` content block (§R, design/06 §406 reserves the type).
 *
 * A content page stores **ids only** — here, not even that: the block's data is `{}` and it
 * means "whatever round this workspace is showing". The owning module is asked for the
 * viewer-safe payload at render time, after section visibility has been applied.
 *
 * The rule that decides almost everything here is EXECUTION_PLAN §47: *no offering content is
 * reachable anonymously*. A `round_summary` is the terms of a live raise; putting it on a page
 * somebody can read without signing in would be a general solicitation the workspace did not
 * choose to make, and under 506(b) that is not a UI mistake, it is the thing that breaks the
 * exemption. So an anonymous viewer gets `{}` — not a redacted payload, not a "sign in to see
 * this" marker, nothing — and the refusal is logged where an operator can find the page.
 *
 * **On refusing the block in a `public` section.** §R asks for that explicitly, and
 * `BlockHydrationContext` does not carry the section's visibility rule: it has `tenant`,
 * `viewer`, `facts`, `medium` and `asOf`, and `renderSections` applies visibility *before*
 * calling a hydrator, so by the time we are asked the section is already known to be one this
 * viewer may see. The **anonymous viewer is therefore the proxy**, and it is an exact one for
 * the case that matters: a section is only reachable anonymously when its rule is `public` and
 * `content.allowPublicSections` is on (`sectionVisible`), so "the viewer is anonymous" and "this
 * is a public section being read by the public" are the same condition. What it does not catch
 * is a signed-in member reading a public section — which is a member reading offering content
 * they are entitled to read, and not the leak §47 is about. If `BlockHydrationContext` ever
 * grows the rule, the check here should read it directly; the log line below is what would make
 * that change visible.
 */

/** The viewer-safe payload. Frozen: the SPA renderer and the email renderer both read it. */
export interface RoundSummaryHydrated {
  readonly round: {
    readonly id: string;
    readonly name: string;
    readonly stage: string;
    readonly instrumentKind: string;
    readonly status: string;
    readonly currency: string;
    readonly targetAmount: string;
    readonly minimumInvestment: string | null;
  };
  readonly terms: Terms | null;
  readonly progress: ReturnType<typeof investorProgress> | null;
  readonly disclaimer: {
    readonly stamp: string;
    readonly title: string;
    readonly body: string;
  } | null;
}

export function createRoundSummaryHydrator(services: ModuleServices) {
  return {
    type: "round_summary" as const,
    async hydrate(_data: JsonObject, ctx: BlockHydrationContext): Promise<JsonObject> {
      if (ctx.viewer.kind === "anonymous") {
        services.log("round.summary_refused", {
          workspaceId: ctx.tenant.workspaceId,
          reason: "anonymous_viewer",
        });
        return {};
      }

      // F3: the round is `all`-scope content for a delegate.
      if (!delegationAdmitsModule(ctx.viewer.delegateScope, "round")) return {};

      const isStaff = ctx.viewer.kind === "staff";
      const assembled = await services.db.withTenant(ctx.tenant, async (tx) => {
        // RLS drops a `planning` round for an external reader; `currentForInvestor` never
        // returns one for anybody, so a staff preview sees the same block a member would.
        const round = await new RoundRepo(ctx.tenant, tx).currentForInvestor();
        if (round === undefined) return undefined;
        const terms = await new TermsRepo(ctx.tenant, tx).current(round.id, round.instrumentKind);
        const disclaimer = await services.legal.resolveDisclaimer(tx, ctx.tenant);
        return { round, terms, disclaimer };
      });
      if (assembled === undefined) return {};
      const { round, terms, disclaimer } = assembled;

      /*
       * `round.commitment` is staff-only in RLS — correctly, because what other investors put in
       * is not this reader's business — so the buckets are folded off-fence in a system context
       * and only the three aggregate figures cross back. `showProgress` is the tenant's decision
       * for investors; staff always see the figures, because the admin preview is where the
       * decision is checked.
       */
      const progress =
        isStaff || round.showProgress
          ? investorProgress(
              await services.db.withTenant(systemContext(ctx.tenant.workspaceId), (tx) =>
                readAllocation(systemContext(ctx.tenant.workspaceId), tx, round),
              ),
            )
          : null;

      const payload: RoundSummaryHydrated = {
        round: {
          id: round.id,
          name: round.name,
          stage: round.stage,
          instrumentKind: round.instrumentKind,
          status: round.status,
          currency: round.currency,
          targetAmount: round.targetAmount,
          minimumInvestment: round.minimumInvestment,
        },
        terms: terms?.terms ?? null,
        progress,
        disclaimer:
          disclaimer === undefined
            ? null
            : {
                stamp: `${disclaimer.slug}:v${disclaimer.versionNo}`,
                title: disclaimer.title,
                body: disclaimer.body,
              },
      };
      return payload as unknown as JsonObject;
    },
  };
}
