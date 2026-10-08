import { systemContext, type TenantContext, type Tx } from "@fundroom/db";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleServices } from "@fundroom/module-kit";
import { type Actor, UpdatesError } from "../errors.js";
import { UnsubscribeRepo } from "../repos/updates-repo.js";
import type { UnsubscribeSource } from "../schema/updates.js";
import {
  signUnsubscribeToken,
  UNSUBSCRIBE_PURPOSE,
  UNSUBSCRIBE_TTL_DAYS,
  verifyUnsubscribeToken,
} from "../tokens.js";

/*
 * Unsubscribe compliance (design/04 §2: a working opt-out on relationship mail; security
 * mail is exempt and untouched here). An unsubscribed member keeps portal access and the
 * web archive; only the update emails stop. Three doors: the footer link (a signed token,
 * no sign-in needed), RFC 8058 one-click POST from the mail client, and the portal toggle.
 */
export function createSubscriptionService(services: ModuleServices) {
  const { db, crypto } = services;

  async function emailOf(tx: Tx, ctx: TenantContext, membershipId: string): Promise<string | null> {
    const names = await new MembershipRepo(ctx, tx).namesFor([membershipId]);
    return names.get(membershipId)?.email ?? null;
  }

  return {
    async isSubscribed(ctx: TenantContext, membershipId: string): Promise<boolean> {
      const row = await db.withTenant(ctx, (tx) =>
        new UnsubscribeRepo(ctx, tx).byMembership(membershipId),
      );
      return row === undefined;
    },

    /** The member's own switch (portal), or staff acting on a member's behalf. */
    async set(
      ctx: TenantContext,
      membershipId: string,
      subscribed: boolean,
      source: UnsubscribeSource,
      actor: Actor | null,
    ): Promise<boolean> {
      return db.withTenant(ctx, async (tx) => {
        const repo = new UnsubscribeRepo(ctx, tx);
        if (subscribed) {
          const removed = await repo.remove(membershipId);
          if (removed) {
            await services.audit.record(tx, ctx, {
              action: "update.resubscribed",
              resourceKind: "membership",
              resourceId: membershipId,
              subjectMembershipId: membershipId,
              ...(actor
                ? { actorMembershipId: actor.membershipId, requestId: actor.requestId }
                : {}),
              meta: { source },
            });
          }
          return true;
        }
        const email = await emailOf(tx, ctx, membershipId);
        if (email === null) throw new UpdatesError("not_found", "no such member");
        const added = await repo.add(membershipId, email, source);
        if (added) {
          await services.audit.record(tx, ctx, {
            action: "update.unsubscribed",
            resourceKind: "membership",
            resourceId: membershipId,
            subjectMembershipId: membershipId,
            ...(actor ? { actorMembershipId: actor.membershipId, requestId: actor.requestId } : {}),
            meta: { source },
          });
        }
        return false;
      });
    },

    /** A signed footer / List-Unsubscribe token for one member of the workspace. */
    async token(tx: Tx, ctx: TenantContext, membershipId: string): Promise<string> {
      const key = await crypto.currentKey(tx, ctx, UNSUBSCRIBE_PURPOSE);
      const exp = Math.floor(services.now().getTime() / 1000) + UNSUBSCRIBE_TTL_DAYS * 86_400;
      return signUnsubscribeToken(key.key, {
        v: 1,
        ws: ctx.workspaceId,
        m: membershipId,
        k: key.keyId,
        e: exp,
      });
    },

    /**
     * Redeems a token on the workspace of the request. Runs as system: the caller is not
     * signed in. Returns the (masked-later) email so the page can confirm what happened.
     */
    async unsubscribeByToken(
      workspaceId: string,
      token: string,
      source: "link" | "one_click",
    ): Promise<{ email: string; alreadyUnsubscribed: boolean }> {
      const ctx = systemContext(workspaceId);
      return db.withTenant(ctx, async (tx) => {
        const payload = verifyPayload(token);
        if (payload === undefined || payload.ws !== workspaceId)
          throw new UpdatesError("forbidden", "invalid or expired unsubscribe link");
        const key = await crypto.keyById(tx, ctx, payload.k);
        if (key === undefined || key.purpose !== UNSUBSCRIBE_PURPOSE)
          throw new UpdatesError("forbidden", "invalid or expired unsubscribe link");
        if (verifyUnsubscribeToken(key.key, token, services.now()) === undefined) {
          throw new UpdatesError("forbidden", "invalid or expired unsubscribe link");
        }
        const email = await emailOf(tx, ctx, payload.m);
        if (email === null)
          throw new UpdatesError("forbidden", "invalid or expired unsubscribe link");
        const added = await new UnsubscribeRepo(ctx, tx).add(payload.m, email, source);
        if (added) {
          await services.audit.record(tx, ctx, {
            action: "update.unsubscribed",
            resourceKind: "membership",
            resourceId: payload.m,
            subjectMembershipId: payload.m,
            meta: { source },
          });
        }
        return { email, alreadyUnsubscribed: !added };
      });
    },
  };
}

function verifyPayload(token: string) {
  // Structural decode only; the signature is checked once the key is known.
  const [body] = token.split(".");
  if (!body) return undefined;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      p["v"] !== 1 ||
      typeof p["ws"] !== "string" ||
      typeof p["m"] !== "string" ||
      typeof p["k"] !== "string"
    )
      return undefined;
    return { ws: p["ws"], m: p["m"], k: p["k"] };
  } catch {
    return undefined;
  }
}

export type SubscriptionService = ReturnType<typeof createSubscriptionService>;
