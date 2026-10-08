import { parseMarkdown, tokenizeInline } from "./parse.js";

/*
 * ProseMirror JSON ⇄ the Markdown subset, for the TipTap editor (E1.4). The document model
 * stays Markdown (one storage format for the content page, updates and email); the editor
 * is a view over it. Only the nodes and marks the subset can express survive a round trip:
 * paragraphs, headings 1–3, bullet/ordered lists of single paragraphs, bold, italic, code
 * and links. Anything else degrades to its text.
 */
export interface PmMark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
}
export interface PmNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
  readonly content?: readonly PmNode[] | undefined;
  readonly marks?: readonly PmMark[] | undefined;
  readonly text?: string | undefined;
}

function textNode(text: string, marks: PmMark[] = []): PmNode {
  return marks.length > 0 ? { type: "text", text, marks } : { type: "text", text };
}

function inlineToPm(text: string): PmNode[] {
  const nodes: PmNode[] = [];
  for (const t of tokenizeInline(text)) {
    if (t.text.length === 0) continue;
    switch (t.kind) {
      case "text":
        nodes.push(textNode(t.text));
        break;
      case "code":
        nodes.push(textNode(t.text, [{ type: "code" }]));
        break;
      case "strong":
        nodes.push(textNode(t.text, [{ type: "bold" }]));
        break;
      case "em":
        nodes.push(textNode(t.text, [{ type: "italic" }]));
        break;
      case "link":
        nodes.push(
          t.safe ? textNode(t.text, [{ type: "link", attrs: { href: t.href } }]) : textNode(t.text),
        );
        break;
    }
  }
  return nodes;
}

function paragraph(text: string): PmNode {
  const content = inlineToPm(text);
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
}

export function markdownToProseMirror(source: string): PmNode {
  const content: PmNode[] = [];
  for (const node of parseMarkdown(source)) {
    switch (node.kind) {
      case "heading":
        content.push({
          type: "heading",
          attrs: { level: node.level },
          content: inlineToPm(node.text),
        });
        break;
      case "paragraph":
        content.push(paragraph(node.text));
        break;
      case "list":
        content.push({
          type: node.ordered ? "orderedList" : "bulletList",
          ...(node.ordered ? { attrs: { start: 1 } } : {}),
          content: node.items.map((item) => ({ type: "listItem", content: [paragraph(item)] })),
        });
        break;
    }
  }
  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

/** Escapes the characters the inline tokenizer would otherwise read as marks. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\*_`[\]]/gu, (ch) => `\\${ch}`);
}

function escapeLineStart(text: string): string {
  return /^(#{1,3}\s|[-*]\s|\d+[.)]\s)/u.test(text) ? `\\${text}` : text;
}

function markOf(node: PmNode, type: string): PmMark | undefined {
  return node.marks?.find((m) => m.type === type);
}

function inlineToMarkdown(nodes: readonly PmNode[] | undefined): string {
  let out = "";
  for (const node of nodes ?? []) {
    if (node.type === "hardBreak") {
      out += " ";
      continue;
    }
    if (node.type !== "text") {
      out += inlineToMarkdown(node.content);
      continue;
    }
    const text = node.text ?? "";
    if (text.length === 0) continue;
    if (markOf(node, "code")) {
      out += `\`${text.replaceAll("`", "'")}\``;
      continue;
    }
    let s = escapeMarkdown(text);
    if (markOf(node, "bold")) s = `**${s}**`;
    if (markOf(node, "italic")) s = `*${s}*`;
    const link = markOf(node, "link");
    const href = typeof link?.attrs?.["href"] === "string" ? link.attrs["href"] : undefined;
    if (href !== undefined && /^(https?:\/\/|mailto:)/iu.test(href) && !/[\s)]/u.test(href)) {
      s = `[${s}](${href})`;
    }
    out += s;
  }
  return out;
}

function blockText(node: PmNode): string {
  // A list item may hold several paragraphs; the subset keeps one line per item.
  if (node.type === "paragraph" || node.type === "heading") {
    return escapeLineStart(inlineToMarkdown(node.content).trim());
  }
  return (node.content ?? []).map(blockText).filter(Boolean).join(" ");
}

export function proseMirrorToMarkdown(doc: PmNode): string {
  const blocks: string[] = [];
  for (const node of doc.content ?? []) {
    switch (node.type) {
      case "heading": {
        const raw = Number(node.attrs?.["level"] ?? 2);
        const level = Math.min(3, Math.max(1, Number.isFinite(raw) ? raw : 2));
        const text = inlineToMarkdown(node.content).trim();
        if (text.length > 0) blocks.push(`${"#".repeat(level)} ${text}`);
        break;
      }
      case "bulletList":
      case "orderedList": {
        const items = (node.content ?? [])
          .map((item) => blockText(item).trim())
          .filter((t) => t.length > 0)
          .map((t, i) => (node.type === "orderedList" ? `${i + 1}. ${t}` : `- ${t}`));
        if (items.length > 0) blocks.push(items.join("\n"));
        break;
      }
      default: {
        const text = blockText(node).trim();
        if (text.length > 0) blocks.push(text);
      }
    }
  }
  return blocks.join("\n\n");
}
