/*
 * The link fallback (design/08 §7). Every failure mode in that table ends in the same place: a
 * plain link to the portal's own origin, where the session is first-party and nothing about the
 * host page matters. It is deliberately not a retry, not a spinner and not an error card — the
 * failures are configuration (CSP, `http:`, an ad blocker), so the useful thing is a working link
 * now and a console message telling the developer exactly what to change.
 */

export type FallbackReason =
  /** The host page is not a secure context: a `Secure; Partitioned` cookie cannot be set. */
  | "insecure-host"
  /** No `ready` within the timeout — host CSP, an ad blocker, or the frame never loaded. */
  | "timeout"
  /** The iframe fired `error`. */
  | "error";

/** Default link text. Short, and it says where the link goes. */
export const FALLBACK_LABEL = "Open investor portal";

/**
 * Replaces our root element's content with the link. Styles go through CSSOM property
 * assignments, never a `style` attribute or a stylesheet: a host page with a strict `style-src`
 * blocks the attribute form, and an unstyled fallback inside a 320px-tall skeleton looks broken.
 */
export function renderFallback(root: HTMLElement, href: string, label: string): HTMLAnchorElement {
  root.textContent = "";
  const doc = root.ownerDocument;
  const link = doc.createElement("a");
  link.href = href;
  link.textContent = label;
  link.target = "_blank";
  link.rel = "noopener";
  link.setAttribute("data-seed-host-fallback", "");
  link.style.display = "inline-block";
  link.style.padding = "0.75em 1.25em";
  link.style.border = "1px solid currentColor";
  link.style.borderRadius = "0.375em";
  link.style.textDecoration = "none";
  link.style.color = "inherit";
  link.style.font = "inherit";
  root.append(link);
  // The skeleton height existed to stop the host page from shifting while the frame loaded
  // (design/08 §7 "Slow host page"). Once we have given up, holding 320px of empty space is the
  // shift we were trying to avoid.
  root.style.minHeight = "";
  return link;
}

/**
 * The console explanation. Named directives, not "something went wrong": the two things a host
 * page needs are `frame-src` for the portal and, if it serves the loader from us, `script-src`.
 * `child-src` is named too because it is the fallback directive in older browsers.
 */
export function explain(reason: FallbackReason, origin: string, timeoutMs: number): string {
  const prefix = "[FundRoom]";
  if (reason === "insecure-host") {
    return (
      `${prefix} Refusing to embed on an insecure page. The portal signs you in with a ` +
      "`Secure; HttpOnly; SameSite=None; Partitioned` cookie, and a browser will not store a " +
      "Secure cookie for a frame inside a page served over http:, so every sign-in would fail " +
      `silently. Serve this page over https: (http://localhost is fine) or link to ${origin} ` +
      "instead. Showing a link for now."
    );
  }
  if (reason === "error") {
    return `${prefix} The portal frame failed to load from ${origin}. Showing a link instead.`;
  }
  return (
    `${prefix} The portal at ${origin} did not report ready within ${timeoutMs} ms. If this page ` +
    "sends a Content-Security-Policy it must allow the frame: `frame-src " +
    `${origin}` +
    "` (plus `child-src " +
    `${origin}` +
    "` for older browsers), and `script-src " +
    `${origin}` +
    "` if you load embed.js from the portal. An ad blocker or a network policy blocking the " +
    "portal origin looks identical from here. Showing a link instead."
  );
}
