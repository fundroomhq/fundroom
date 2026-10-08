/*
 * The page's CSP nonce, for the few third-party components that inject a `<style>` element at
 * runtime (Radix Select's viewport, input-otp). The document CSP is `style-src 'self'
 * 'nonce-…'` with no 'unsafe-inline' (packages/http security-headers.ts), so an injected style
 * without the nonce is refused — silently, apart from a console line and a CSP report.
 *
 * The server stamps the nonce on every tag Vite generates (`html.cspNonce`), including
 * `<meta property="csp-nonce">`. Browsers *hide* a nonce attribute once the document is
 * parsed (`getAttribute("nonce")` returns ""), so it is read from the `.nonce` IDL property,
 * which keeps the value; the attribute is only a fallback for environments without the
 * property (jsdom). Read once: the nonce is per document, never per render.
 */
let cached: string | null | undefined;

export function readCspNonce(doc: Document | undefined = globalThis.document): string | undefined {
  if (doc === undefined) return undefined;
  for (const selector of ['meta[property="csp-nonce"]', "script[nonce]"]) {
    const el = doc.querySelector<HTMLElement>(selector);
    if (el === null) continue;
    const value = el.nonce || el.getAttribute("nonce") || "";
    if (value !== "") return value;
  }
  return undefined;
}

/** The current document's nonce, or `undefined` when the page has none (tests, Storybook). */
export function getCspNonce(): string | undefined {
  if (cached === undefined) cached = readCspNonce() ?? null;
  return cached ?? undefined;
}

/** Tests only: forget the memoised value. */
export function resetCspNonceForTests(): void {
  cached = undefined;
}
