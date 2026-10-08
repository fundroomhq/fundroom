/*
 * The deliberately small Markdown subset rich-text blocks are stored as (ADR-0033): `#`
 * `##` `###` headings, paragraphs, bullet and numbered lists, and inline bold, italic, code
 * and links. Everything else is literal text. `\` escapes the next punctuation character so
 * the editor can round-trip a literal `*` or `[`. One parser serves the web renderer, the
 * email renderer and the editor, so the three never disagree on what a block means.
 */
export const SAFE_HREF_RE = /^(https?:\/\/|mailto:)/iu;

export type InlineToken =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "em"; readonly text: string }
  | { readonly kind: "link"; readonly text: string; readonly href: string; readonly safe: boolean };

export type MarkdownNode =
  | { readonly kind: "heading"; readonly level: 1 | 2 | 3; readonly text: string }
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] };

const INLINE_RE =
  /(\\[\\*_`[\]()#-])|(`[^`]+`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*)|(\*([^*]+)\*|_([^_]+)_)/gu;

/** Splits one line of inline text into tokens. Order: escapes, code, links, bold, italic. */
export function tokenizeInline(text: string): InlineToken[] {
  const out: InlineToken[] = [];
  let buffer = "";
  let last = 0;
  const flush = () => {
    if (buffer.length > 0) out.push({ kind: "text", text: buffer });
    buffer = "";
  };
  for (const match of text.matchAll(INLINE_RE)) {
    const idx = match.index ?? 0;
    if (idx > last) buffer += text.slice(last, idx);
    if (match[1] !== undefined) {
      buffer += match[1].slice(1);
    } else if (match[2] !== undefined) {
      flush();
      out.push({ kind: "code", text: match[2].slice(1, -1) });
    } else if (match[3] !== undefined) {
      flush();
      const href = match[5] ?? "";
      out.push({ kind: "link", text: match[4] ?? "", href, safe: SAFE_HREF_RE.test(href) });
    } else if (match[6] !== undefined) {
      flush();
      out.push({ kind: "strong", text: match[7] ?? "" });
    } else {
      flush();
      out.push({ kind: "em", text: match[9] ?? match[10] ?? "" });
    }
    last = idx + match[0].length;
  }
  if (last < text.length) buffer += text.slice(last);
  flush();
  return out;
}

export function parseMarkdown(source: string): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | undefined;
  const flush = () => {
    if (paragraph.length > 0) {
      nodes.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
    if (list !== undefined) {
      nodes.push({ kind: "list", ordered: list.ordered, items: list.items });
      list = undefined;
    }
  };
  for (const raw of source.split(/\r?\n/u)) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flush();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/u.exec(line);
    if (heading) {
      flush();
      nodes.push({
        kind: "heading",
        level: heading[1]?.length as 1 | 2 | 3,
        text: heading[2] ?? "",
      });
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/u.exec(line);
    if (bullet || numbered) {
      const ordered = numbered !== null;
      if (paragraph.length > 0 || (list !== undefined && list.ordered !== ordered)) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? numbered)?.[1] ?? "");
      continue;
    }
    if (list !== undefined) flush();
    paragraph.push(line.trim());
  }
  flush();
  return nodes;
}

/** The text of a source with every inline mark removed (search indexes, previews, email text). */
export function markdownToText(source: string): string {
  const lines: string[] = [];
  for (const node of parseMarkdown(source)) {
    switch (node.kind) {
      case "heading":
        lines.push(plain(node.text), "");
        break;
      case "paragraph":
        lines.push(plain(node.text), "");
        break;
      case "list":
        node.items.forEach((item, i) => {
          lines.push(`${node.ordered ? `${i + 1}.` : "-"} ${plain(item)}`);
        });
        lines.push("");
        break;
    }
  }
  return lines.join("\n").trim();
}

function plain(text: string): string {
  return tokenizeInline(text)
    .map((t) => (t.kind === "link" && t.safe ? `${t.text} (${t.href})` : t.text))
    .join("");
}
