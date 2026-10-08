import { markdownToProseMirror, type PmNode, proseMirrorToMarkdown } from "@fundroom/markdown";
import { Button, cn, Textarea } from "@fundroomhq/ui";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Bold, Code, Heading2, Heading3, Italic, Link2, List, ListOrdered } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { m } from "../paraglide/messages.js";

/*
 * The rich-text editor (E1.4): TipTap/ProseMirror over the Markdown subset. The document
 * model stays Markdown (`@fundroom/markdown` converts both ways), so the same block renders
 * identically on the overview page, in the archive and in email. Only the subset's marks
 * are enabled; a "Markdown" toggle exposes the source for power users and screen readers.
 */
export interface RichTextEditorProps {
  readonly id: string;
  readonly value: string;
  readonly onChange: (markdown: string) => void;
  readonly readOnly?: boolean | undefined;
  readonly label: string;
  readonly className?: string | undefined;
}

const SAFE_HREF_RE = /^(https?:\/\/|mailto:)/iu;

export function RichTextEditor(props: RichTextEditorProps) {
  const [source, setSource] = useState(false);
  const toolbarId = useId();
  const lastEmitted = useRef(props.value);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
          blockquote: false,
          codeBlock: false,
          horizontalRule: false,
          strike: false,
          underline: false,
          link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
        }),
      ],
      content: markdownToProseMirror(props.value) as unknown as Record<string, unknown>,
      // TipTap's own style tag is written through `innerHTML` (a Trusted Types sink) and carries
      // no CSP nonce; the same CSS ships in the bundle instead (rich-text-editor.css, E2.10).
      injectCSS: false,
      editable: !props.readOnly,
      immediatelyRender: false,
      editorProps: {
        attributes: {
          id: props.id,
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": props.label,
          class:
            "prose prose-neutral dark:prose-invert min-h-32 max-w-none rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
        },
      },
      onUpdate: ({ editor: e }) => {
        const md = proseMirrorToMarkdown(e.getJSON() as unknown as PmNode);
        lastEmitted.current = md;
        props.onChange(md);
      },
    },
    [props.readOnly],
  );

  // External value changes (a server-normalised save, another block) reset the editor.
  useEffect(() => {
    if (editor === null || props.value === lastEmitted.current) return;
    lastEmitted.current = props.value;
    editor.commands.setContent(
      markdownToProseMirror(props.value) as unknown as Record<string, unknown>,
      { emitUpdate: false },
    );
  }, [editor, props.value]);

  const setLink = () => {
    if (editor === null) return;
    const previous = editor.getAttributes("link")["href"];
    const href = window.prompt(
      m.editor_link_prompt(),
      typeof previous === "string" ? previous : "https://",
    );
    if (href === null) return;
    if (href.trim() === "" || !SAFE_HREF_RE.test(href.trim())) {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: href.trim() }).run();
  };

  const tool = (label: string, active: boolean, onClick: () => void, Icon: typeof Bold) => (
    <Button
      type="button"
      variant={active ? "secondary" : "ghost"}
      size="sm"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={props.readOnly || editor === null}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon aria-hidden="true" />
    </Button>
  );

  return (
    <div className={cn("space-y-2", props.className)}>
      <div
        className="flex flex-wrap items-center gap-1"
        role="toolbar"
        aria-label={m.editor_toolbar()}
        id={toolbarId}
      >
        {!source && editor ? (
          <>
            {tool(
              m.editor_bold(),
              editor.isActive("bold"),
              () => editor.chain().focus().toggleBold().run(),
              Bold,
            )}
            {tool(
              m.editor_italic(),
              editor.isActive("italic"),
              () => editor.chain().focus().toggleItalic().run(),
              Italic,
            )}
            {tool(
              m.editor_code(),
              editor.isActive("code"),
              () => editor.chain().focus().toggleCode().run(),
              Code,
            )}
            {tool(
              m.editor_heading2(),
              editor.isActive("heading", { level: 2 }),
              () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
              Heading2,
            )}
            {tool(
              m.editor_heading3(),
              editor.isActive("heading", { level: 3 }),
              () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
              Heading3,
            )}
            {tool(
              m.editor_bullets(),
              editor.isActive("bulletList"),
              () => editor.chain().focus().toggleBulletList().run(),
              List,
            )}
            {tool(
              m.editor_numbered(),
              editor.isActive("orderedList"),
              () => editor.chain().focus().toggleOrderedList().run(),
              ListOrdered,
            )}
            {tool(m.editor_link(), editor.isActive("link"), setLink, Link2)}
          </>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto"
          aria-pressed={source}
          onClick={() => setSource((v) => !v)}
        >
          {source ? m.editor_rich_mode() : m.editor_markdown_mode()}
        </Button>
      </div>
      {source ? (
        <Textarea
          id={props.id}
          aria-label={props.label}
          value={props.value}
          rows={10}
          readOnly={props.readOnly}
          onChange={(e) => {
            lastEmitted.current = e.target.value;
            props.onChange(e.target.value);
            editor?.commands.setContent(
              markdownToProseMirror(e.target.value) as unknown as Record<string, unknown>,
              { emitUpdate: false },
            );
          }}
        />
      ) : (
        <EditorContent editor={editor} />
      )}
    </div>
  );
}
