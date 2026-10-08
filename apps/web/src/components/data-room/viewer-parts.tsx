import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@fundroomhq/ui";
import { useQuery } from "@tanstack/react-query";
import type { RefObject } from "react";
import { dataRoomPageTextQuery } from "../../lib/data-room-queries.js";
import { m } from "../../paraglide/messages.js";

/*
 * The viewer's text layer (E2.8): the page's extracted text, visually hidden inside the page
 * figure so a screen reader reads the content of the page, not just "Page 3 of Pitch deck".
 * It is not a selectable overlay — sighted users still see only the watermarked image
 * (ADR-0015) — and `select-none` keeps it out of a select-all copy. A page whose text cannot be
 * fetched (gated, 403/404/409, route not available) or that has no text (a scan without OCR)
 * says so instead of staying silent.
 */
export function PageTextLayer({
  documentId,
  versionId,
  pageNo,
}: {
  documentId: string;
  versionId: string;
  pageNo: number;
}) {
  const text = useQuery(dataRoomPageTextQuery(documentId, versionId, pageNo));
  const paragraphs =
    text.data?.text
      .split(/\n\s*\n/u)
      .map((p) => p.replace(/\s+/gu, " ").trim())
      .filter((p) => p.length > 0) ?? [];
  return (
    <div
      className="sr-only select-none"
      data-text-layer={text.isPending ? "loading" : paragraphs.length > 0 ? "text" : "none"}
    >
      {text.isPending ? (
        <p>{m.dataroom_text_layer_loading()}</p>
      ) : paragraphs.length > 0 ? (
        paragraphs.map((p, i) => <p key={i}>{p}</p>)
      ) : (
        <p>{m.dataroom_text_layer_none()}</p>
      )}
    </div>
  );
}

const SHORTCUTS: readonly (readonly [keys: () => string, action: () => string])[] = [
  [m.dataroom_shortcut_keys_next, m.dataroom_next_page],
  [m.dataroom_shortcut_keys_prev, m.dataroom_prev_page],
  [m.dataroom_shortcut_keys_first, m.dataroom_shortcut_first],
  [m.dataroom_shortcut_keys_last, m.dataroom_shortcut_last],
  [m.dataroom_shortcut_keys_zoom_in, m.dataroom_zoom_in],
  [m.dataroom_shortcut_keys_zoom_out, m.dataroom_zoom_out],
  [m.dataroom_shortcut_keys_fit, m.dataroom_fit_width],
  [m.dataroom_shortcut_keys_toolbar, m.dataroom_shortcut_toolbar],
  [m.dataroom_shortcut_keys_help, m.dataroom_shortcut_help],
];

/**
 * The keyboard-shortcut help. Controlled (opened by the toolbar button or `?`), and on close
 * focus returns to whatever had it when the dialog opened — the stage when `?` was pressed
 * there, the help button when it was clicked.
 */
export function ShortcutsDialog({
  open,
  onOpenChange,
  returnFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        closeLabel={m.common_close()}
        onCloseAutoFocus={(e) => {
          const el = returnFocus.current;
          if (el?.isConnected) {
            e.preventDefault();
            el.focus({ preventScroll: true });
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>{m.dataroom_shortcuts_title()}</DialogTitle>
          <DialogDescription>{m.dataroom_shortcuts_body()}</DialogDescription>
        </DialogHeader>
        <table className="w-full text-sm">
          <thead className="sr-only">
            <tr>
              <th scope="col">{m.dataroom_shortcuts_col_keys()}</th>
              <th scope="col">{m.dataroom_shortcuts_col_action()}</th>
            </tr>
          </thead>
          <tbody>
            {SHORTCUTS.map(([keys, action]) => (
              <tr key={keys()} className="border-b last:border-b-0">
                <td className="py-1.5 pr-4 align-top">
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-xs">
                    {keys()}
                  </kbd>
                </td>
                <td className="py-1.5">{action()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}
