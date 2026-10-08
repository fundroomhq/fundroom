/**
 * What every template needs to know about the sender (EXECUTION_PLAN §12 "branding basics").
 * Per-workspace values come from `workspace.settings` (E1.7); the composition root passes a
 * resolver to `createTemplatedMailer`. Everything here is rendered as text and escaped by
 * React; `logoUrl` must be an https URL the workspace controls.
 */
export interface EmailBrand {
  readonly productName: string;
  readonly workspaceName?: string | undefined;
  /** One line under the brand name in the header; `branding.tagline` (E1.7). */
  readonly tagline?: string | undefined;
  readonly logoUrl?: string | undefined;
  /** CSS colour for buttons and the header rule; default `#1d4ed8`. */
  readonly accentColor?: string | undefined;
  readonly supportEmail?: string | undefined;
  /** Postal line for the footer (CAN-SPAM for marketing-type sends; optional for auth). */
  readonly addressLine?: string | undefined;
  /**
   * `branding.showPoweredBy` (E1.7), default true. False removes the "powered by <product>"
   * attribution ONLY. The workspace line, the support address and the postal address stay:
   * they are what makes the mail identifiable and CAN-SPAM-compliant, and they are not the
   * customer's to switch off.
   */
  readonly showPoweredBy?: boolean | undefined;
}

export const DEFAULT_ACCENT = "#1d4ed8";

/** Matches `branding.tagline`'s own cap in the domain schema; a header line has to stay a line. */
export const TAGLINE_MAX_LENGTH = 160;

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u;
const HTTPS_RE = /^https:\/\/[^\s"'<>]+$/u;

/** Keeps untrusted brand values inside what an inline style / img src can safely carry. */
export function safeBrand(brand: EmailBrand): EmailBrand {
  const tagline = brand.tagline?.trim().slice(0, TAGLINE_MAX_LENGTH);
  return {
    ...brand,
    accentColor:
      brand.accentColor && COLOR_RE.test(brand.accentColor) ? brand.accentColor : DEFAULT_ACCENT,
    logoUrl: brand.logoUrl && HTTPS_RE.test(brand.logoUrl) ? brand.logoUrl : undefined,
    // Escaping is React's job, but an unbounded string in a header is still wrong: it would
    // wrap over the logo in every client and push the actual message below the fold.
    tagline: tagline ? tagline : undefined,
    showPoweredBy: brand.showPoweredBy !== false,
  };
}

/** `Acme (FundRoom)` or `FundRoom` — mirrors identity's plain-text title(). */
export function brandTitle(brand: EmailBrand): string {
  return brand.workspaceName ? `${brand.workspaceName} (${brand.productName})` : brand.productName;
}
