import { describe, expect, it } from "vitest";
import { markdownToHtml } from "./html.js";
import { markdownToText, parseMarkdown, tokenizeInline } from "./parse.js";
import { markdownToProseMirror, proseMirrorToMarkdown } from "./prosemirror.js";

const SAMPLE = [
  "# Recap",
  "",
  "We shipped **v2** to *everyone* and `cut` costs. See [the deck](https://acme.test/deck).",
  "",
  "- first",
  "- second with [bad](javascript:evil)",
  "",
  "1. one",
  "2. two",
].join("\n");

describe("parseMarkdown", () => {
  it("reads headings, paragraphs and both list kinds", () => {
    expect(parseMarkdown(SAMPLE).map((n) => n.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "list",
    ]);
  });

  it("tokenises inline marks in order and flags unsafe links", () => {
    const tokens = tokenizeInline("a **b** *c* _d_ `e` [f](https://x.y) [g](javascript:1) \\*h\\*");
    expect(tokens).toEqual([
      { kind: "text", text: "a " },
      { kind: "strong", text: "b" },
      { kind: "text", text: " " },
      { kind: "em", text: "c" },
      { kind: "text", text: " " },
      { kind: "em", text: "d" },
      { kind: "text", text: " " },
      { kind: "code", text: "e" },
      { kind: "text", text: " " },
      { kind: "link", text: "f", href: "https://x.y", safe: true },
      { kind: "text", text: " " },
      { kind: "link", text: "g", href: "javascript:1", safe: false },
      { kind: "text", text: " *h*" },
    ]);
  });

  it("renders plain text with safe links spelled out", () => {
    expect(markdownToText(SAMPLE)).toBe(
      [
        "Recap",
        "",
        "We shipped v2 to everyone and cut costs. See the deck (https://acme.test/deck).",
        "",
        "- first",
        "- second with bad",
        "",
        "1. one",
        "2. two",
      ].join("\n"),
    );
  });
});

describe("markdownToHtml", () => {
  it("escapes every character of user text and only links https/mailto", () => {
    const html = markdownToHtml(
      '<script>alert(1)</script> **<b>** [x](javascript:evil) [ok](https://a.b/?q="1")',
      { p: "margin:0" },
    );
    expect(html).toBe(
      '<p style="margin:0">&lt;script&gt;alert(1)&lt;/script&gt; <strong>&lt;b&gt;</strong> x <a href="https://a.b/?q=&quot;1&quot;">ok</a></p>',
    );
  });

  it("shifts headings down one level and renders lists", () => {
    expect(markdownToHtml("# T\n\n- a\n- b\n\n1. c")).toBe(
      "<h2>T</h2>\n<ul><li>a</li><li>b</li></ul>\n<ol><li>c</li></ol>",
    );
  });
});

describe("ProseMirror round trip", () => {
  it("converts the subset to a document and back unchanged", () => {
    const doc = markdownToProseMirror(SAMPLE);
    expect(doc.content?.[0]).toEqual({
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "Recap" }],
    });
    expect(proseMirrorToMarkdown(doc)).toBe(
      SAMPLE.replace("[bad](javascript:evil)", "bad").replace(
        "- second with bad",
        "- second with bad",
      ),
    );
  });

  it("escapes characters that would otherwise become marks", () => {
    const md = proseMirrorToMarkdown({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "price *is* 5_000 [x] " },
            { type: "text", text: "bold", marks: [{ type: "bold" }] },
            { type: "text", text: " ", marks: [] },
            {
              type: "text",
              text: "link",
              marks: [{ type: "link", attrs: { href: "https://acme.test/a" } }],
            },
            { type: "hardBreak" },
            { type: "text", text: "code`x`", marks: [{ type: "code" }] },
          ],
        },
        { type: "paragraph", content: [{ type: "text", text: "- not a list" }] },
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "q" }] }],
        },
        { type: "paragraph" },
      ],
    });
    expect(md).toBe(
      "price \\*is\\* 5\\_000 \\[x\\] **bold** [link](https://acme.test/a) `code'x'`\n\n\\- not a list\n\nq",
    );
    expect(tokenizeInline(md.split("\n")[0] ?? "")).toContainEqual({
      kind: "text",
      text: "price *is* 5_000 [x] ",
    });
    expect(parseMarkdown(md).map((n) => n.kind)).toEqual(["paragraph", "paragraph", "paragraph"]);
  });

  it("drops unsafe link hrefs on the way out", () => {
    expect(
      proseMirrorToMarkdown({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "x",
                marks: [{ type: "link", attrs: { href: "javascript:1" } }],
              },
            ],
          },
        ],
      }),
    ).toBe("x");
  });
});
