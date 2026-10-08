import { type KeyboardEvent, type RefObject, useCallback, useRef, useState } from "react";

/*
 * WAI-ARIA toolbar pattern (APG "Toolbar"): the toolbar is ONE tab stop; Left/Right move between
 * its controls (wrapping), Home/End jump to the first/last. Items are marked with
 * `data-roving-key`; unavailable items use `aria-disabled` (not `disabled`) so they stay
 * focusable and the focused control never vanishes from under the keyboard (APG recommends
 * keeping disabled toolbar items focusable). The handler only runs for keys raised INSIDE the
 * toolbar, so it cannot collide with the viewer stage's own arrow-key paging.
 */
export interface RovingToolbar {
  readonly ref: RefObject<HTMLDivElement | null>;
  /** 0 for the one item in the tab sequence, -1 for the rest. */
  tabIndexFor(key: string): 0 | -1;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
  /** Wire to the toolbar's `onFocus` (bubbles): whatever the user focused becomes the tab stop. */
  onFocus(e: { target: EventTarget }): void;
}

export function useRovingToolbar(keys: readonly string[]): RovingToolbar {
  const ref = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState<string | undefined>(keys[0]);
  const current = active !== undefined && keys.includes(active) ? active : keys[0];

  const tabIndexFor = useCallback((key: string) => (key === current ? 0 : -1), [current]);

  const onFocus = useCallback((e: { target: EventTarget }) => {
    const key = (e.target as HTMLElement).dataset?.["rovingKey"];
    if (key !== undefined) setActive(key);
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-roving-key]") ?? []);
    if (items.length === 0) return;
    const at = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (e.key) {
      case "ArrowRight":
        next = at < 0 ? 0 : (at + 1) % items.length;
        break;
      case "ArrowLeft":
        next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = items.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const el = items[next];
    if (!el) return;
    setActive(el.dataset["rovingKey"]);
    el.focus();
  }, []);

  return { ref, tabIndexFor, onKeyDown, onFocus };
}
