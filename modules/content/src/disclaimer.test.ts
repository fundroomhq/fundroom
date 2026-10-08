import type { ModuleServices, ResolvedDisclaimer } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { createDisclaimerHydrator, disclaimerPayload, slugOf } from "./disclaimer.js";

const tenant = {
  workspaceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a",
  actorKind: "system" as const,
};
const ctx = { tenant, viewer: { kind: "external" as const, groupIds: [] }, facts: {} };

const resolved: ResolvedDisclaimer = {
  documentId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b01",
  slug: "offering-disclaimer",
  title: "Offering disclaimer",
  versionNo: 3,
  body: "This is **not** an offer.",
  bodySha256: "a".repeat(64),
  effectiveAt: new Date("2026-01-02T03:04:05.000Z"),
};

/** A stand-in for the composition root: only `db.withTenant` and `legal` are ever touched. */
function services(resolve: (slug?: string) => ResolvedDisclaimer | undefined) {
  const asked: (string | undefined)[] = [];
  const stub = {
    db: { withTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}) },
    legal: {
      resolveDisclaimer: (_tx: unknown, _ctx: unknown, slug?: string) => {
        asked.push(slug);
        return Promise.resolve(resolve(slug));
      },
      stampFor: () => Promise.resolve(undefined),
    },
  };
  return { services: stub as unknown as ModuleServices, asked };
}

describe("disclaimer hydration", () => {
  it("reads the slug a block asks for and ignores one that is not a slug", () => {
    expect(slugOf({ slug: "offering-disclaimer" })).toBe("offering-disclaimer");
    // `null` is the workspace default; so is anything the registry would not have accepted.
    expect(slugOf({ slug: null })).toBeUndefined();
    expect(slugOf({})).toBeUndefined();
    expect(slugOf({ slug: "Not A Slug" })).toBeUndefined();
  });

  it("carries the text and the identity of the version it is", () => {
    expect(disclaimerPayload(resolved)).toEqual({
      slug: "offering-disclaimer",
      title: "Offering disclaimer",
      versionNo: 3,
      body: "This is **not** an offer.",
      effectiveAt: "2026-01-02T03:04:05.000Z",
    });
    // The hash and the document id are evidence the server keeps; a reader has no use for them.
    expect(disclaimerPayload(resolved)).not.toHaveProperty("bodySha256");
  });

  it("asks for the workspace default when the block names no slug", async () => {
    const { services: s, asked } = services(() => resolved);
    const hydrated = await createDisclaimerHydrator(s).hydrate({ slug: null }, ctx);
    expect(asked).toEqual([undefined]);
    expect(hydrated).toMatchObject({ versionNo: 3 });
  });

  it("hydrates to nothing when the workspace has no such disclaimer", async () => {
    const { services: s } = services(() => undefined);
    // Not a throw: `hydration_failed` would tell the reader something is broken when in fact
    // the workspace has simply never written the text.
    await expect(createDisclaimerHydrator(s).hydrate({ slug: "missing" }, ctx)).resolves.toEqual(
      {},
    );
  });
});
