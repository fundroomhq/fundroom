import { getCspNonce } from "@fundroomhq/ui";

/*
 * Keeping the SPA inside its own Content-Security-Policy (E2.10). The document policy is strict
 * — `script-src 'nonce-…' 'strict-dynamic'`, `style-src 'self' 'nonce-…'`, no 'unsafe-inline',
 * no 'unsafe-eval' — and it enforces Trusted Types (`require-trusted-types-for 'script';
 * trusted-types default ProseMirrorClipboard`, packages/http security-headers.ts; enforced since
 * E3.2, report-only only when an operator sets CSP_TRUSTED_TYPES=report).
 * Three things in our dependency tree step outside it at runtime; `installCspGuards()` runs
 * first thing in `main.tsx`, before anything renders, and deals with 1 and 3 (2 cannot wait
 * that long):
 *
 *  1. Radix Dialog's scroll lock (react-remove-scroll → react-style-singleton) injects a
 *     `<style>` whose nonce comes from `get-nonce`. Nothing ever called its `setNonce`, and the
 *     package is not ours to import, but `getNonce()` falls back to the global
 *     `__webpack_nonce__` — the documented webpack spelling, which it reads lazily when a
 *     dialog opens. Setting it here is the whole fix.
 *  2. Zod 4 probes for `eval` (`new Function("")`, caught) to decide whether to JIT its
 *     parsers, and the browser reports that as a `script-src` and a Trusted Types violation.
 *     The probe runs when a schema is constructed, at module evaluation, which is earlier than
 *     this function can run: `zod-jitless.ts`, the first import of `main.tsx`, turns it off.
 *  3. The Trusted Types `default` policy below: the one place a *string* may reach an HTML
 *     sink. It passes exactly the literals listed in `TRUSTED_HTML` and nothing else.
 *
 * Everything else that used to trip the policy is fixed at its source: Radix Select and
 * input-otp take the nonce as a prop (packages/ui), sonner's runtime CSS is stripped at build
 * time (vite.config.ts) and TipTap's is shipped as a file (rich-text-editor.css).
 */

/*
 * HTML strings a third-party component assigns to `innerHTML` itself, verbatim. Radix Select's
 * viewport renders `<style dangerouslySetInnerHTML>` to hide its scrollbar; React assigns that
 * with `innerHTML`, which Trusted Types treats as an HTML sink even on a `<style>`. Adding an
 * entry here is a security decision: it must be a constant in a dependency, never data.
 */
export const RADIX_SELECT_VIEWPORT_CSS =
  "[data-radix-select-viewport]{scrollbar-width:none;-ms-overflow-style:none;-webkit-overflow-scrolling:touch;}[data-radix-select-viewport]::-webkit-scrollbar{display:none}";

export const TRUSTED_HTML: ReadonlySet<string> = new Set([RADIX_SELECT_VIEWPORT_CSS]);

/** The policy name the CSP's `trusted-types` lists next to prosemirror-view's `ProseMirrorClipboard`. */
export const DEFAULT_POLICY = "default";

/**
 * The default policy's `createHTML`.
 *
 * The browser calls it for an implicit sink use (a string assigned to `innerHTML`) with the
 * sink's name as the third argument: a listed literal passes, anything else returns `null`,
 * which the browser refuses (a TypeError at the sink) and reports as a violation.
 *
 * An *explicit* `trustedTypes.defaultPolicy.createHTML(x)` has no sink argument, and it throws:
 * the default policy must not be a general-purpose "make this string trusted" function for
 * whoever finds it. prosemirror-view tries exactly that before falling back to its own named
 * `ProseMirrorClipboard` policy (in a try/catch), which is the policy we list for it.
 */
export function defaultPolicyCreateHTML(
  value: string,
  _type?: string,
  sink?: string,
): string | null {
  if (sink === undefined) {
    throw new TypeError("the default Trusted Types policy is not for explicit use");
  }
  return TRUSTED_HTML.has(value) ? value : null;
}

interface TrustedTypesLike {
  readonly defaultPolicy: unknown;
  createPolicy(name: string, rules: { createHTML: typeof defaultPolicyCreateHTML }): unknown;
}

/** Idempotent; safe where Trusted Types or a nonce do not exist (older browsers, jsdom). */
export function installCspGuards(win: Window & typeof globalThis = window): void {
  const nonce = getCspNonce();
  if (nonce !== undefined) {
    (win as unknown as { __webpack_nonce__?: string }).__webpack_nonce__ = nonce;
  }
  const tt = (win as unknown as { trustedTypes?: TrustedTypesLike }).trustedTypes;
  if (tt !== undefined && tt.defaultPolicy === null) {
    tt.createPolicy(DEFAULT_POLICY, { createHTML: defaultPolicyCreateHTML });
  }
}
