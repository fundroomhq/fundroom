import { type InlineToken, parseMarkdown, tokenizeInline } from "./parse.js";

/*
 * Markdown subset → HTML for email (design/03 C1: rendered HTML email, not an attachment).
 * Every character of user text is escaped; only https/mailto links become anchors; there is
 * no way to smuggle markup through because the parser never emits raw source.
 */
export function escapeHtml(text: string): string {
  // All five HTML metacharacters, `&` first so no entity is escaped twice.
  // nosemgrep: javascript.audit.detect-replaceall-sanitization.detect-replaceall-sanitization
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export interface HtmlStyles {
  readonly h2?: string | undefined;
  readonly h3?: string | undefined;
  readonly h4?: string | undefined;
  readonly p?: string | undefined;
  readonly list?: string | undefined;
  readonly li?: string | undefined;
  readonly a?: string | undefined;
  readonly code?: string | undefined;
}

const attr = (style: string | undefined) => (style ? ` style="${escapeHtml(style)}"` : "");

export function inlineHtml(text: string, styles: HtmlStyles = {}): string {
  return tokenizeInline(text)
    .map((t) => tokenHtml(t, styles))
    .join("");
}

function tokenHtml(t: InlineToken, styles: HtmlStyles): string {
  switch (t.kind) {
    case "text":
      return escapeHtml(t.text);
    case "code":
      return `<code${attr(styles.code)}>${escapeHtml(t.text)}</code>`;
    case "strong":
      return `<strong>${escapeHtml(t.text)}</strong>`;
    case "em":
      return `<em>${escapeHtml(t.text)}</em>`;
    case "link":
      return t.safe
        ? `<a href="${escapeHtml(t.href)}"${attr(styles.a)}>${escapeHtml(t.text)}</a>`
        : escapeHtml(t.text);
    default:
      return "";
  }
}

/** Headings shift down one level (`#` → `<h2>`) so the enclosing document keeps its `<h1>`. */
export function markdownToHtml(source: string, styles: HtmlStyles = {}): string {
  const out: string[] = [];
  for (const node of parseMarkdown(source)) {
    switch (node.kind) {
      case "heading": {
        const tag = node.level === 1 ? "h2" : node.level === 2 ? "h3" : "h4";
        const style = node.level === 1 ? styles.h2 : node.level === 2 ? styles.h3 : styles.h4;
        out.push(`<${tag}${attr(style)}>${inlineHtml(node.text, styles)}</${tag}>`);
        break;
      }
      case "paragraph":
        out.push(`<p${attr(styles.p)}>${inlineHtml(node.text, styles)}</p>`);
        break;
      case "list": {
        const tag = node.ordered ? "ol" : "ul";
        const items = node.items
          .map((item) => `<li${attr(styles.li)}>${inlineHtml(item, styles)}</li>`)
          .join("");
        out.push(`<${tag}${attr(styles.list)}>${items}</${tag}>`);
        break;
      }
    }
  }
  return out.join("\n");
}
