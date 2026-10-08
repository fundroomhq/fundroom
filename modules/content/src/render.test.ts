import type { RegisteredHydrator } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import type { PageDoc } from "./blocks.js";
import { renderSections, visibleSectionKeys } from "./render.js";

const G1 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c01";
const DEF = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c09";
const doc: PageDoc = {
  sections: [
    {
      key: "open",
      title: null,
      blocks: [{ id: "h", type: "hero", schemaVersion: 1, data: { heading: "Hi" } }],
    },
    {
      key: "board",
      title: "Board",
      blocks: [
        {
          id: "m",
          type: "metric_grid",
          schemaVersion: 1,
          data: { definitionIds: [DEF], columns: 3 },
        },
        {
          id: "d",
          type: "document_list",
          schemaVersion: 1,
          data: { folderId: null, documentIds: [] },
        },
      ],
    },
    { key: "internal", title: null, blocks: [] },
  ],
};
const visibility = {
  board: { mode: "groups" as const, groupIds: [G1] },
  internal: { mode: "staff_only" as const },
};
const tenant = {
  workspaceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a",
  actorKind: "system" as const,
};

function options(
  viewer: { kind: "anonymous" | "external" | "staff"; groupIds: string[] },
  hydrators: RegisteredHydrator[] = [],
  enabled = ["metrics"],
) {
  return {
    doc,
    visibility,
    viewer,
    allowPublic: false,
    hydrators: new Map(hydrators.map((h) => [h.hydrator.type, h])),
    enabledModules: new Set(enabled),
    context: { tenant, viewer, facts: {} },
  };
}

describe("renderSections", () => {
  it("applies visibility before hydration and never hydrates hidden sections", async () => {
    const seen: string[] = [];
    const metrics: RegisteredHydrator = {
      module: "metrics",
      hydrator: {
        type: "metric_grid",
        hydrate: async (data) => {
          seen.push(String((data["definitionIds"] as string[])[0]));
          return { series: [{ id: DEF, value: 42 }] };
        },
      },
    };
    const out = await renderSections(options({ kind: "external", groupIds: [] }, [metrics]));
    expect(out.map((s) => s.key)).toEqual(["open"]);
    expect(seen).toEqual([]);

    const board = await renderSections(options({ kind: "external", groupIds: [G1] }, [metrics]));
    expect(board.map((s) => s.key)).toEqual(["open", "board"]);
    expect(seen).toEqual([DEF]);
    const grid = board[1]?.blocks[0];
    expect(grid?.data).toEqual({
      definitionIds: [DEF],
      columns: 3,
      hydrated: { series: [{ id: DEF, value: 42 }] },
    });
    expect(board[1]?.blocks[1]).toMatchObject({
      type: "document_list",
      unavailable: "module_unavailable",
    });
  });

  it("marks a hydrator whose module is disabled here, and one that throws", async () => {
    const boom: RegisteredHydrator = {
      module: "metrics",
      hydrator: {
        type: "metric_grid",
        hydrate: async () => {
          throw new Error("db down");
        },
      },
    };
    const staff = await renderSections(options({ kind: "staff", groupIds: [] }, [boom], []));
    expect(staff.map((s) => s.key)).toEqual(["open", "board", "internal"]);
    expect(staff[1]?.blocks[0]?.unavailable).toBe("module_unavailable");
    const failing = await renderSections(
      options({ kind: "staff", groupIds: [] }, [boom], ["metrics"]),
    );
    expect(failing[1]?.blocks[0]?.unavailable).toBe("hydration_failed");
    expect(failing[1]?.blocks[0]?.data).toEqual({ definitionIds: [DEF], columns: 3 });
  });

  it("lists visible keys per viewer", () => {
    expect(visibleSectionKeys(doc, visibility, { kind: "anonymous", groupIds: [] }, true)).toEqual(
      [],
    );
    expect(
      visibleSectionKeys(
        doc,
        { open: { mode: "public" } },
        { kind: "anonymous", groupIds: [] },
        true,
      ),
    ).toEqual(["open"]);
    expect(
      visibleSectionKeys(
        doc,
        { open: { mode: "public" } },
        { kind: "anonymous", groupIds: [] },
        false,
      ),
    ).toEqual([]);
  });
});
