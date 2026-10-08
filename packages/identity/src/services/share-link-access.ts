import type { TenantContext, Tx } from "@fundroom/db";
import type { InviteGrant } from "@fundroom/domain";

/*
 * The share-link seam (E2.3, contract §S2).
 *
 * `@fundroom/share-links` depends on this package for `randomToken`, `sha256`, `safeEqual` and
 * `hashCode`/`verifyCode` — security primitives that exist once. The dependency therefore runs
 * share-links → identity, and identity must NEVER import share-links: that would be a cycle, and
 * the one that mattered would be the wrong way round (the kernel's login path cannot be made to
 * depend on an epic's feature package).
 *
 * So identity declares the shape it needs, share-links implements it structurally, and
 * `apps/server/src/container.ts` wires the two together. Nothing here knows what a share link is
 * beyond two questions: may this address in? and what did the link promise it?
 */
export interface ShareLinkAccess {
  /**
   * Does this link's own policy (domain allowlist, named addresses, status, expiry, use count)
   * admit this address? This **is** the eligibility rule for a link visitor — see
   * `checkEligibility`. It answers a bare boolean on purpose: the caller is an anti-enumeration
   * surface and must not be able to tell "wrong domain" from "link expired" apart in its reply.
   */
  admits(ctx: TenantContext, tx: Tx, linkId: string, email: string): Promise<boolean>;
  /**
   * Binds a freshly created membership to the link (the `core.share_link_visit` row, the use
   * count) and hands back what the link promised, in exactly the shape an invitation does, so
   * `establishMembership` can apply both through one code path.
   */
  bind(
    ctx: TenantContext,
    tx: Tx,
    input: { readonly linkId: string; readonly membershipId: string },
  ): Promise<{ readonly groupIds: readonly string[]; readonly grants: readonly InviteGrant[] }>;
}
