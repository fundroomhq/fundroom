import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useWebConfig } from "../lib/config-context.js";
import { refreshSession } from "../lib/queries.js";

/*
 * The top-level popup on the portal origin (ADR-0040 decision 11, design/08 §6).
 *
 * Some things must not happen inside someone else's page: accepting an NDA, e-signing, changing
 * an email, anything admin. The answer is not to make the iframe safe enough for them — it is to
 * leave the frame. `/auth/popup` has existed since E0.3 with COOP `same-origin-allow-popups`
 * scoped to exactly that path, and it already posts `{v:1,type:"auth"}` back to `window.opener`;
 * this is the opener's half, so the frame learns the popup finished instead of guessing.
 *
 * Two things are worth knowing before wiring a new caller:
 *
 *  - **The popup's session is not always the frame's session.** The framed document holds a
 *    `Partitioned` cookie keyed on the host site; a top-level window on the portal origin holds
 *    the ordinary first-party one. Where the host site and the portal share a registrable domain
 *    — `acme.com` framing `investors.acme.com`, which is what E2.1's custom domains are for —
 *    they are the same jar and what happens in the popup is visible to the frame. Where they do
 *    not, the popup is where the *action itself* completes, and the frame only learns that it
 *    did. Every caller therefore re-reads `me` rather than assuming anything changed.
 *  - **Only what exists today is wired.** E2.3 brings the e-sign and NDA flows that are the real
 *    reason this mechanism is here (design/08 §6 lists them); the one caller now is the step-up
 *    screen, which offers this as the route out of a frame where a passkey ceremony may not run
 *    at all. The list is not complete, and pretending otherwise in a comment would be worse than
 *    saying so.
 */

/** What became of the popup. `dismissed` means closed without finishing; nothing changed. */
export type PopupOutcome = "completed" | "dismissed" | "blocked";

export interface TopLevelPopupOptions {
  /** The workspace's own portal root, from the boot config. */
  readonly canonicalOrigin: string;
  /** Path under that origin, e.g. `/auth/popup`. */
  readonly path: string;
  readonly search?: Readonly<Record<string, string>> | undefined;
  /** Test seam; defaults to `window`. */
  readonly win?: Window | undefined;
}

const POPUP_FEATURES = "popup=yes,width=460,height=680,noopener=no,noreferrer=no";
/** `window.closed` has no event, so it is polled. Half a second is imperceptible and cheap. */
const CLOSE_POLL_MS = 500;

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** Is this an `auth` postback from our own popup, on the origin we opened? */
function isAuthPostback(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const msg = data as Record<string, unknown>;
  return msg["v"] === 1 && msg["type"] === "auth";
}

/**
 * Opens `${canonicalOrigin}${path}` at top level and resolves when it posts back or closes.
 *
 * The popup is deliberately *not* `noopener`: it has to be able to reach `window.opener` to say
 * it finished, and it is our own origin on both sides — the message is still checked against
 * that origin rather than trusted for arriving.
 */
export function openTopLevelPopup(options: TopLevelPopupOptions): Promise<PopupOutcome> {
  const win = options.win ?? (typeof window === "undefined" ? undefined : window);
  const base = options.canonicalOrigin.replace(/\/$/u, "");
  const expected = originOf(base);
  if (win === undefined || expected === undefined) return Promise.resolve("blocked");
  const query = new URLSearchParams(options.search ?? {}).toString();
  const url = `${base}${options.path}${query === "" ? "" : `?${query}`}`;
  const popup = win.open(url, "fundroom-auth", POPUP_FEATURES);
  if (popup === null) return Promise.resolve("blocked");

  return new Promise<PopupOutcome>((resolve) => {
    let timer = 0;
    const settle = (outcome: PopupOutcome) => {
      win.clearInterval(timer);
      win.removeEventListener("message", onMessage);
      resolve(outcome);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== expected || !isAuthPostback(event.data)) return;
      // The popup closes itself; closing it here too is harmless and covers a popup that did
      // not, so the opener never leaves a window the visitor has to find and dismiss.
      try {
        popup.close();
      } catch {
        // Cross-origin navigation inside the popup can make `close()` throw; not our problem.
      }
      settle("completed");
    };
    win.addEventListener("message", onMessage);
    timer = win.setInterval(() => {
      if (popup.closed) settle("dismissed");
    }, CLOSE_POLL_MS);
  });
}

/**
 * `const runAtTopLevel = useTopLevelPopup()` — opens the popup and re-reads `me` when it
 * reports back, because the session it produced may or may not be the one this frame holds.
 */
export function useTopLevelPopup(): (
  path: string,
  search?: Record<string, string>,
) => Promise<PopupOutcome> {
  const config = useWebConfig();
  const queryClient = useQueryClient();
  return useCallback(
    async (path: string, search?: Record<string, string>) => {
      const outcome = await openTopLevelPopup({
        canonicalOrigin: config.canonicalOrigin,
        path,
        ...(search === undefined ? {} : { search }),
      });
      if (outcome === "completed") {
        await refreshSession(queryClient);
      }
      return outcome;
    },
    [config.canonicalOrigin, queryClient],
  );
}
