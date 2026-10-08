import type { TenantContext } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it, vi } from "vitest";

/*
 * Pool discipline for replies (E2.7 H3). A reply used to read the author's name through a
 * second `db.withTenant` opened *inside* the reply transaction — with a one-connection pool
 * (or a burst of repliers on a full pool) that waits for itself forever. The fake database
 * here models a one-connection pool: opening a transaction while one is held fails loudly.
 */

vi.mock("../repos/updates-repo.js", () => ({
  PostRepo: class {
    async live() {
      return { id: "post-1" };
    }
  },
  ReplyRepo: class {
    async create(input: { authorMembershipId: string; body: string }) {
      return { id: "reply-1", ...input, createdAt: new Date(0) };
    }
    async forPost() {
      return [];
    }
  },
}));

vi.mock("@fundroom/events", () => ({ publish: async () => undefined }));

vi.mock("@fundroom/identity", () => ({
  MembershipRepo: class {
    async namesFor(ids: string[]) {
      return new Map(ids.map((id) => [id, { displayName: "Ada", kind: "external" }]));
    }
  },
}));

const { createReplyService } = await import("./replies.js");

function onePoolConnection() {
  let held = false;
  return {
    async withTenant<T>(_ctx: TenantContext, fn: (tx: unknown) => Promise<T>): Promise<T> {
      if (held) throw new Error("second pool connection requested while holding one (deadlock)");
      held = true;
      try {
        return await fn({});
      } finally {
        held = false;
      }
    },
  };
}

describe("reply service on a one-connection pool", () => {
  it("create() never opens a transaction while holding the reply transaction", async () => {
    const services = {
      db: onePoolConnection(),
      audit: { record: async () => undefined },
    } as unknown as ModuleServices;
    const ctx = { workspaceId: "ws-1", membershipId: "m-1" } as unknown as TenantContext;
    const reply = await createReplyService(services).create(ctx, "post-1", { body: "hello" }, {
      membershipId: "m-1",
      kind: "external",
      requestId: "req-1",
    } as never);
    expect(reply).toMatchObject({ id: "reply-1", authorName: "Ada", authorKind: "external" });
  });
});
