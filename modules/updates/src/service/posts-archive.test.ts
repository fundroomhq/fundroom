import type { TenantContext } from "@fundroom/db";
import type { ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it, vi } from "vitest";

/*
 * Pool discipline for the web archive (E2.7 H3 sweep). `archiveRead` used to render the
 * published version — block hydrators and all — inside its read transaction, and the metrics,
 * round and data-room hydrators open their own `withTenant`: one pool connection held while
 * waiting for another. The fake database models a one-connection pool, and the fake renderer
 * behaves like a hydrator that reads the database.
 */

const H = vi.hoisted(() => ({
  db: undefined as unknown as {
    withTenant<T>(ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T>;
  },
  published: [] as string[],
}));

vi.mock("../repos/updates-repo.js", () => ({
  PostRepo: class {
    async bySlug() {
      return {
        id: "post-1",
        slug: "q3-update",
        state: "sent",
        publishedVersionId: "v-1",
        audience: { kind: "everyone" },
        sentAt: new Date(0),
      };
    }
    async live() {
      return undefined;
    }
  },
  VersionRepo: class {
    async byId() {
      return {
        id: "v-1",
        title: "Q3",
        versionNo: 1,
        doc: {},
        visibility: {},
        createdAt: new Date(0),
      };
    }
  },
  SendRepo: class {},
}));

vi.mock("../model.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../model.js")>()),
  audienceIncludes: () => true,
  parseAudience: (a: unknown) => a,
  parseSectionRules: () => ({}),
}));

vi.mock("@fundroom/module-content", () => ({
  DOC_SCHEMA_VERSION: 1,
  // A hydrator that reads the database, as metrics/round/data-room do.
  renderSections: async () => {
    await H.db.withTenant({}, async () => undefined);
    return [];
  },
}));

vi.mock("@fundroom/events", () => ({
  publish: async (_tx: unknown, _ctx: unknown, topic: string) => {
    H.published.push(topic);
  },
}));

const { createPostService } = await import("./posts.js");

function onePoolConnection() {
  let held = false;
  return {
    async withTenant<T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> {
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

describe("archive read on a one-connection pool", () => {
  it("renders (hydrates) with no transaction held, and still records update.viewed", async () => {
    H.db = onePoolConnection();
    const services = {
      db: H.db,
      now: () => new Date(0),
      registry: { blockHydrators: new Map() },
      log: () => {},
    } as unknown as ModuleServices;
    const ctx = { workspaceId: "ws-1", membershipId: "m-1" } as unknown as TenantContext;
    const page = await createPostService(services).archiveRead(ctx, "q3-update", {
      reader: { kind: "external", groupIds: [] },
      facts: {} as never,
      enabledModules: new Set(),
      actor: { membershipId: "m-1", requestId: "r-1" } as never,
    });
    expect(page).toMatchObject({ post: { id: "post-1", title: "Q3" }, viewer: "external" });
    expect(H.published).toEqual(["update.viewed"]);
  });
});
