# @fundroom/markdown

The Markdown subset that `rich_text` blocks store: `#`/`##`/`###` headings,
paragraphs, bullet and numbered lists, **bold**, *italic*, `code` and `[links](https://…)`
(https and mailto only). `\` escapes the next punctuation character. No dependencies, no I/O.

- `parseMarkdown` / `tokenizeInline` — the one parser the web renderer, the email renderer and
  the editor share, so a block means the same thing everywhere.
- `markdownToHtml` — escaped HTML with optional inline styles (email bodies).
- `markdownToText` — the plain-text part of an email, search text, previews.
- `markdownToProseMirror` / `proseMirrorToMarkdown` — the TipTap editor's view of a block.
