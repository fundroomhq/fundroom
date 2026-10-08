import { parseMarkdown, tokenizeInline } from "@fundroom/markdown";
import { Fragment, type ReactNode } from "react";

/*
 * The Markdown subset rendered straight to React elements (parser shared with the server's
 * email renderer and the editor through `@fundroom/markdown`). No HTML ever reaches the DOM
 * (no `dangerouslySetInnerHTML`), links must be http(s) or mailto, and every other construct
 * is shown as the text it is.
 */
export { parseMarkdown } from "@fundroom/markdown";

function inline(text: string, keyPrefix: string): ReactNode[] {
  return tokenizeInline(text).map((t, i) => {
    const key = `${keyPrefix}-${i}`;
    switch (t.kind) {
      case "code":
        return <code key={key}>{t.text}</code>;
      case "strong":
        return <strong key={key}>{t.text}</strong>;
      case "em":
        return <em key={key}>{t.text}</em>;
      case "link":
        return t.safe ? (
          <a key={key} href={t.href} rel="noopener noreferrer" target="_blank">
            {t.text}
          </a>
        ) : (
          <Fragment key={key}>{t.text}</Fragment>
        );
      default:
        return <Fragment key={key}>{t.text}</Fragment>;
    }
  });
}

export function Markdown({ source, className }: { source: string; className?: string }) {
  const nodes = parseMarkdown(source);
  return (
    <div className={className}>
      {nodes.map((node, i) => {
        const key = `n${i}`;
        switch (node.kind) {
          case "heading": {
            const Tag = node.level === 1 ? "h2" : node.level === 2 ? "h3" : "h4";
            return <Tag key={key}>{inline(node.text, key)}</Tag>;
          }
          case "paragraph":
            return <p key={key}>{inline(node.text, key)}</p>;
          case "list": {
            const Tag = node.ordered ? "ol" : "ul";
            return (
              <Tag key={key}>
                {node.items.map((item, j) => (
                  <li key={`${key}-${j}`}>{inline(item, `${key}-${j}`)}</li>
                ))}
              </Tag>
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
}
