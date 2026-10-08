/*
 * Consent, host-page side (E2.2 spec §3 "Consent rule", design/08 §6 "Analytics consent").
 *
 * `granted = analytics && !gpc`. The host's CMP supplies `analytics`; Global Privacy Control is
 * read here, in the host page, because that is the only place it exists — the iframe is a
 * different browsing context and the server only ever sees `Sec-GPC` on requests it receives.
 *
 * GPC is a **negative-only** signal: it can turn measurement off, and nothing can turn it back
 * on. A host CMP that says `analytics: true` over a GPC signal is a host CMP that is wrong, and
 * the answer is to honour the person, not the integration. The server already folds the same rule
 * (`if (gpc) return false`), so the two cannot disagree about the same page view.
 */

/** What the host passes in `init({ consent })` and `portal.setConsent(...)`. */
export interface ConsentInput {
  readonly analytics: boolean;
}

/**
 * True when the browser is signalling GPC. `true` is what the specification defines; `"1"` is
 * accepted because it is what a couple of extensions inject, and a false positive here can only
 * ever withdraw consent, which is the safe direction to be wrong in.
 */
export function readGpc(nav: Navigator | undefined): boolean {
  if (nav === undefined) return false;
  const flag = (nav as { globalPrivacyControl?: unknown }).globalPrivacyControl;
  return flag === true || flag === "1";
}

/** The `consent` payload: the folded decision, plus the reason when GPC is what decided it. */
export function foldConsent(
  consent: ConsentInput,
  gpc: boolean,
): { analytics: boolean; gpc?: boolean } {
  const analytics = consent.analytics && !gpc;
  // `exactOptionalPropertyTypes`: absence means "no signal", so `gpc: false` is never sent.
  return gpc ? { analytics, gpc: true } : { analytics };
}
