import { describe, expect, it } from "vitest";
import {
  BLOCK_REGISTRY,
  BLOCK_TYPES,
  blockDescriptors,
  DocValidationError,
  LIMITS,
  providerOf,
  validateDoc,
} from "./blocks.js";
import { homeTemplate } from "./template.js";

const hero = (over: Record<string, unknown> = {}) => ({
  id: "hero",
  type: "hero",
  schemaVersion: 1,
  data: { heading: "Acme", ...over },
});

function issuesOf(doc: unknown): string[] {
  try {
    validateDoc(doc);
  } catch (error) {
    if (error instanceof DocValidationError) return error.issues.map((i) => `${i.path}:${i.code}`);
    throw error;
  }
  return [];
}

describe("block registry", () => {
  it("normalises a valid document (defaults filled, provider derived)", () => {
    const doc = validateDoc({
      sections: [
        {
          key: "intro",
          title: null,
          blocks: [
            hero(),
            {
              id: "video",
              type: "embed",
              schemaVersion: 1,
              data: { url: "https://www.youtube.com/watch?v=abc", title: null },
            },
          ],
        },
      ],
    });
    const [h, e] = doc.sections[0]?.blocks ?? [];
    expect(h?.data).toEqual({ heading: "Acme", subheading: null, imageUrl: null, cta: null });
    expect(e?.data).toMatchObject({ provider: "youtube" });
  });

  it("refuses unknown types, newer schema versions, bad data and duplicates", () => {
    expect(
      issuesOf({ sections: [{ key: "a", title: null, blocks: [{ ...hero(), type: "widget" }] }] }),
    ).toEqual(["doc.sections.0.blocks.0.type:unknown_type"]);
    expect(
      issuesOf({
        sections: [{ key: "a", title: null, blocks: [{ ...hero(), schemaVersion: 9 }] }],
      }),
    ).toEqual(["doc.sections.0.blocks.0.schemaVersion:unsupported_version"]);
    expect(
      issuesOf({ sections: [{ key: "a", title: null, blocks: [hero({ heading: "" })] }] }),
    ).toEqual(["doc.sections.0.blocks.0.data.heading:too_small"]);
    expect(
      issuesOf({
        sections: [
          { key: "a", title: null, blocks: [hero()] },
          { key: "a", title: null, blocks: [hero()] },
        ],
      }),
    ).toEqual(["doc.sections.1.key:duplicate", "doc.sections.1.blocks.0.id:duplicate"]);
    expect(issuesOf({ sections: [{ key: "Bad Key", title: null, blocks: [] }] })[0]).toMatch(
      /key/u,
    );
  });

  it("rejects javascript: and protocol-relative hrefs, keeps same-site paths", () => {
    const withCta = (href: string) =>
      issuesOf({
        sections: [{ key: "a", title: null, blocks: [hero({ cta: { label: "Go", href } })] }],
      });
    expect(withCta("javascript:alert(1)")).toHaveLength(1);
    expect(withCta("//evil.test/x")).toHaveLength(1);
    expect(withCta("/updates")).toEqual([]);
    expect(withCta("https://example.com/deck")).toEqual([]);
  });

  it("caps the document size", () => {
    const text = "x".repeat(LIMITS.richTextChars);
    const blocks = Array.from({ length: 30 }, (_, i) => ({
      id: `t${i}`,
      type: "rich_text",
      schemaVersion: 1,
      data: { format: "markdown", text },
    }));
    expect(issuesOf({ sections: [{ key: "a", title: null, blocks }] })).toEqual(["doc:too_big"]);
  });

  it("accepts a disclaimer slug or the workspace default, and rejects anything else", () => {
    const disclaimer = (data: unknown) => ({
      sections: [
        {
          key: "legal",
          title: null,
          blocks: [{ id: "d", type: "disclaimer", schemaVersion: 1, data }],
        },
      ],
    });
    // An omitted slug is the workspace default, and normalises to an explicit null.
    const doc = validateDoc(disclaimer({}));
    expect(doc.sections[0]?.blocks[0]?.data).toEqual({ slug: null });
    expect(
      validateDoc(disclaimer({ slug: "offering-disclaimer" })).sections[0]?.blocks[0]?.data,
    ).toEqual({ slug: "offering-disclaimer" });
    expect(issuesOf(disclaimer({ slug: "Offering" }))).toEqual([
      "doc.sections.0.blocks.0.data.slug:invalid_format",
    ]);
    expect(issuesOf(disclaimer({ slug: "1-late" }))).toHaveLength(1);
    expect(issuesOf(disclaimer({ slug: "a".repeat(64) }))).toHaveLength(1);
    // The text never lives in the block: it comes from the legal library at render time.
    expect(issuesOf(disclaimer({ slug: null, body: "We are not your adviser." }))).toHaveLength(1);
  });

  it("derives embed providers from the host only", () => {
    expect(providerOf("https://youtu.be/x")).toBe("youtube");
    expect(providerOf("https://player.vimeo.com/video/1")).toBe("vimeo");
    expect(providerOf("https://www.loom.com/share/1")).toBe("loom");
    expect(providerOf("https://notyoutube.com/youtube.com")).toBe("other");
    expect(providerOf("nope")).toBe("other");
  });

  it("accepts a round summary with no data at all, and nothing else", () => {
    /*
     * E2.5 §R: the block carries no round id. A page says "show the round" and the round module
     * decides which one, so an editor never has to move the block when a raise closes — and a
     * stored id from some future shape is a validation error rather than a field quietly
     * ignored.
     */
    const summary = (data: unknown) => ({
      sections: [
        {
          key: "round",
          title: null,
          blocks: [{ id: "r", type: "round_summary", schemaVersion: 1, data }],
        },
      ],
    });
    expect(validateDoc(summary({})).sections[0]?.blocks[0]?.data).toEqual({});
    expect(issuesOf(summary({ roundId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c03" }))).toHaveLength(1);
    expect(BLOCK_REGISTRY.round_summary.kind).toBe("reference");
  });

  it("describes every type and the template validates", () => {
    expect(blockDescriptors().map((b) => b.type)).toEqual([...BLOCK_TYPES]);
    expect(
      blockDescriptors()
        .filter((b) => b.kind === "reference")
        .map((b) => b.type),
    ).toEqual(["metric_grid", "document_list", "disclaimer", "round_summary"]);
    const t = homeTemplate("Acme");
    expect(validateDoc(t.doc).sections.map((s) => s.key)).toEqual(Object.keys(t.visibility));
  });
});
