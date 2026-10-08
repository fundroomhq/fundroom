import { formatFixed, parseFixed } from "@fundroom/decimal";
import type { RoundClosingPrefillSource, RoundClosingSettings } from "@fundroom/domain";
import type { Terms } from "@fundroom/round-terms";
import type { CommitmentStatus, RoundStatus, SignatureRequestStatus } from "../model.js";

/*
 * The closing workflow's pure rules (E3.5 §6, ADR-0053). No I/O: the service reads the rows and
 * asks these functions what to do, so every decision the routes and the event handlers make is
 * unit-tested here without a database.
 *
 *  - `signatureRequestRefusal`: may this commitment be sent for signature right now?
 *  - `mirrorStatus` / `nextMirrorStatus`: the round's copy of the kernel envelope status, and the
 *    monotonic transition an event is allowed to apply to it (events can be redelivered and can
 *    arrive out of order; a final mirror never moves again; `error` is recoverable).
 *  - `isKernelEnvelopeLive`: may the envelope behind a closed-looking mirror still be signed?
 *  - `signedTransition`: what a completed envelope does to the commitment (soft/verbal → signed;
 *    never regress wired, never resurrect withdrawn).
 *  - `closingStage` / `closingSummary`: the derived per-commitment checklist and its roll-up.
 *  - `buildPrefill` / `formatAmount`: the vendor template's field values.
 */

/** Open states of a signature request: at most one per commitment (the partial unique index). */
export const OPEN_SIGNATURE_STATUSES = ["pending", "sent", "delivered"] as const;
/**
 * States a mirror never leaves. `error` is NOT one of them (E3.5 fix C1): the kernel's `error` is
 * recoverable — a permanent pull failure keeps polling and heals on the next good answer, and a
 * permanent collect failure publishes `error` for an envelope that is really `completed` — so an
 * `error` mirror that carries an envelope id may still move to sent/delivered/completed/…. Only a
 * claim that failed before it reached the vendor (`error` with no envelope id) is final.
 */
export const FINAL_SIGNATURE_STATUSES = ["completed", "declined", "voided", "expired"] as const;

export function isOpenSignatureStatus(s: SignatureRequestStatus): boolean {
  return (OPEN_SIGNATURE_STATUSES as readonly string[]).includes(s);
}

/** A mirror that can never move again (see `FINAL_SIGNATURE_STATUSES`). */
export function isFinalSignatureStatus(
  s: SignatureRequestStatus,
  envelopeId: string | null,
): boolean {
  if (s === "error") return envelopeId === null;
  return (FINAL_SIGNATURE_STATUSES as readonly string[]).includes(s);
}

/**
 * Whether a void is meaningful: an open request, or an `error` mirror whose kernel envelope may
 * still be live at the vendor (the kernel voids an `error` envelope too).
 */
export function isVoidableSignatureRequest(
  s: SignatureRequestStatus,
  envelopeId: string | null,
): boolean {
  return isOpenSignatureStatus(s) || (s === "error" && envelopeId !== null);
}

/**
 * Whether the kernel envelope behind a non-open mirror may still be signed at the vendor — the
 * re-send guard (fix C1: a second agreement for a deal the investor may be signing is a
 * duplicate). Live: the kernel still has it open, it is `completed` (signed; the commitment
 * move is on its way), or it is in `error` after it reached the vendor (`sentAt` set — the
 * vendor holds a live envelope and the kernel keeps polling it). An `error` that never reached
 * the vendor (a refused create, an orphaned draft) is not live as far as we can know.
 */
export function isKernelEnvelopeLive(envelope: {
  readonly status: string;
  readonly sentAt: string | null;
}): boolean {
  switch (envelope.status) {
    case "draft":
    case "sent":
    case "delivered":
    case "completed":
      return true;
    case "error":
      return envelope.sentAt !== null;
    default:
      return false;
  }
}

/** A `pending` claim older than this is a crashed request and may be expired by the next send. */
export const PENDING_CLAIM_TTL_MS = 15 * 60_000;

/** Commitment statuses a subscription agreement may be sent for. */
export const SIGNABLE_COMMITMENT_STATUSES = ["soft", "verbal"] as const;

export type SignatureRefusal =
  | { readonly code: "round_not_open"; readonly status: RoundStatus }
  | { readonly code: "commitment_not_signable"; readonly status: CommitmentStatus }
  | { readonly code: "esign_not_configured" }
  | { readonly code: "esign_template_unsupported" }
  | { readonly code: "subscription_template_missing" };

/**
 * Why a commitment cannot be sent for signature, or `undefined` when it can. Checked in this
 * order so the answer names the first thing an admin must fix: the round, the commitment, the
 * vendor connection, then the template. (An open request and a missing signer address are
 * decided by the service: the first by the unique index, the second by the membership read.)
 */
export function signatureRequestRefusal(input: {
  readonly roundStatus: RoundStatus;
  readonly commitmentStatus: CommitmentStatus;
  /** `undefined` = no connection; `status: "error"` still counts as connected (verify may heal it). */
  readonly connection: { readonly supportsTemplates: boolean } | undefined;
  readonly templateRef: string | null;
}): SignatureRefusal | undefined {
  // Closing happens after the round closes as often as before: `open` and `closed` both qualify.
  if (input.roundStatus === "planning") return { code: "round_not_open", status: "planning" };
  if (!(SIGNABLE_COMMITMENT_STATUSES as readonly string[]).includes(input.commitmentStatus))
    return { code: "commitment_not_signable", status: input.commitmentStatus };
  if (input.connection === undefined) return { code: "esign_not_configured" };
  if (!input.connection.supportsTemplates) return { code: "esign_template_unsupported" };
  if (input.templateRef === null || input.templateRef.trim() === "")
    return { code: "subscription_template_missing" };
  return undefined;
}

/** The kernel's envelope status as the round mirrors it: `draft` is still our `pending`. */
export function mirrorStatus(envelopeStatus: string): SignatureRequestStatus {
  switch (envelopeStatus) {
    case "sent":
    case "delivered":
    case "completed":
    case "declined":
    case "voided":
    case "expired":
    case "error":
      return envelopeStatus;
    default:
      return "pending";
  }
}

const RANK: Readonly<Record<Exclude<SignatureRequestStatus, "error">, number>> = {
  pending: 0,
  sent: 1,
  delivered: 2,
  completed: 3,
  declined: 3,
  voided: 3,
  expired: 3,
};

/**
 * The status the mirror moves to when an event says `incoming`, or `undefined` for no change.
 * Monotonic: forward only, and a final mirror never moves (the kernel's envelope has the same
 * trigger), so a redelivered `sent` after `completed` — or a late `delivered` — is a no-op.
 *
 * `error` sits beside the ladder, not on top of it (fix C1): any open mirror may enter it, and a
 * mirror in `error` that carries an envelope (`hasEnvelope`) may leave it for any status but
 * `pending` — in particular `completed` always wins over an `error` mirror. The caller verifies
 * every transition into or out of `error` against the kernel's current row
 * (`applyEnvelopeStatus`), so a stale redelivered `sent` cannot mask a real error and a stale
 * `error` cannot mask a recovery.
 */
export function nextMirrorStatus(
  current: SignatureRequestStatus,
  incoming: SignatureRequestStatus,
  opts: { readonly hasEnvelope: boolean },
): SignatureRequestStatus | undefined {
  if (current === incoming) return undefined;
  if (current === "error") {
    if (!opts.hasEnvelope || incoming === "pending") return undefined;
    return incoming;
  }
  if (isFinalSignatureStatus(current, null)) return undefined;
  if (incoming === "error") return "error";
  if (RANK[incoming] <= RANK[current]) return undefined;
  return incoming;
}

/**
 * What a completed signature does to its commitment. `status` moves only from soft/verbal (a
 * wired commitment signed late stays wired; a withdrawn one is not resurrected by paperwork);
 * `stampSignedAt` records the fact whenever it is not recorded yet, whatever the status.
 */
export function signedTransition(input: {
  readonly status: CommitmentStatus;
  readonly signedAt: Date | null;
}): { readonly status: CommitmentStatus | undefined; readonly stampSignedAt: boolean } {
  const moves = (SIGNABLE_COMMITMENT_STATUSES as readonly string[]).includes(input.status);
  return { status: moves ? "signed" : undefined, stampSignedAt: input.signedAt === null };
}

// --- the derived checklist ---------------------------------------------------------------------

export const CLOSING_STAGES = [
  "not_started",
  "documents_sent",
  "signed",
  "wired",
  "confirmed",
  "withdrawn",
] as const;
export type ClosingStage = (typeof CLOSING_STAGES)[number];

export interface ClosingChecklistInput {
  readonly status: CommitmentStatus;
  readonly signedAt: Date | null;
  readonly wiredAt: Date | null;
  readonly confirmedAt: Date | null;
  /** The newest signature request for the commitment, if any. */
  readonly latestRequest:
    | { readonly status: SignatureRequestStatus; readonly sentAt: Date }
    | undefined;
}

export interface ClosingChecklist {
  readonly documentsSent: boolean;
  readonly documentsSentAt: Date | null;
  readonly signed: boolean;
  readonly signedAt: Date | null;
  readonly wired: boolean;
  readonly wiredAt: Date | null;
  readonly confirmed: boolean;
  readonly confirmedAt: Date | null;
  readonly stage: ClosingStage;
}

/**
 * The four checklist flags, derived from facts already stored (never a stored checklist that
 * could disagree with them). A commitment moved to `signed` or `wired` by hand — paper signed
 * outside the product — counts as signed; "documents sent" means a request that reached the
 * vendor (`pending` and `error` did not).
 */
export function closingChecklist(input: ClosingChecklistInput): ClosingChecklist {
  const req = input.latestRequest;
  const reachedVendor = req !== undefined && req.status !== "pending" && req.status !== "error";
  const signed =
    input.signedAt !== null ||
    input.status === "signed" ||
    input.status === "wired" ||
    req?.status === "completed";
  const wired = input.status === "wired" || input.wiredAt !== null;
  const confirmed = input.confirmedAt !== null;
  const documentsSent = reachedVendor || signed;
  const stage: ClosingStage =
    input.status === "withdrawn"
      ? "withdrawn"
      : confirmed
        ? "confirmed"
        : wired
          ? "wired"
          : signed
            ? "signed"
            : documentsSent
              ? "documents_sent"
              : "not_started";
  return {
    documentsSent,
    documentsSentAt: reachedVendor ? req.sentAt : null,
    signed,
    signedAt: input.signedAt,
    wired,
    wiredAt: input.wiredAt,
    confirmed,
    confirmedAt: input.confirmedAt,
    stage,
  };
}

export interface ClosingSummaryBucket {
  readonly count: number;
  /** Decimal text, two places, in the round currency. */
  readonly amount: string;
}

export type ClosingSummary = Readonly<Record<ClosingStage, ClosingSummaryBucket>>;

/** Counts and amounts per stage. Amounts are summed as fixed-point integers, never floats. */
export function closingSummary(
  rows: readonly { readonly stage: ClosingStage; readonly amount: string }[],
): ClosingSummary {
  const acc = new Map<ClosingStage, { count: number; amount: bigint }>(
    CLOSING_STAGES.map((s) => [s, { count: 0, amount: 0n }]),
  );
  for (const r of rows) {
    const bucket = acc.get(r.stage);
    if (bucket === undefined) continue;
    bucket.count += 1;
    bucket.amount += parseFixed(r.amount) ?? 0n;
  }
  return Object.fromEntries(
    CLOSING_STAGES.map((s) => {
      const b = acc.get(s) ?? { count: 0, amount: 0n };
      return [s, { count: b.count, amount: formatFixed(b.amount, 2) }];
    }),
  ) as ClosingSummary;
}

// --- prefill ------------------------------------------------------------------------------------

/**
 * An amount as a subscription agreement prints it: `$250,000.00`, `€1,000.50`, `CHF 10,000.00`.
 * `Intl.NumberFormat` is given the decimal **string** (exact, never a double), and a currency the
 * runtime does not know falls back to `<CODE> 1,234.00` rather than throwing into a send.
 */
export function formatAmount(amount: string, currency: string): string {
  const fixed = parseFixed(amount);
  const text = fixed === undefined ? amount : formatFixed(fixed, 2);
  try {
    return (
      new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
        .format(text as unknown as number)
        // ICU separates a code-style symbol with a no-break space; a template field wants a space.
        .replace(/[\u00a0\u202f]/gu, " ")
    );
  } catch {
    const negative = text.startsWith("-");
    const abs = negative ? text.slice(1) : text;
    const [whole = "0", cents = "00"] = abs.split(".");
    const grouped = whole.replace(/\B(?=(?:\d{3})+(?!\d))/gu, ",");
    return `${negative ? "-" : ""}${currency} ${grouped}.${cents}`;
  }
}

export interface PrefillFacts {
  readonly investorName: string;
  readonly investorEmail: string;
  readonly amount: string;
  readonly currency: string;
  readonly roundName: string;
  readonly companyName: string;
  readonly terms: Terms | undefined;
  readonly now: Date;
}

/** The valuation cap (SAFE, note) or pre-money valuation (priced), formatted; "" when unset. */
export function valuationCapText(terms: Terms | undefined, currency: string): string {
  if (terms === undefined) return "";
  const v = terms.kind === "priced" ? terms.preMoneyValuation : terms.valuationCap;
  return v === undefined ? "" : formatAmount(v, currency);
}

export function prefillValue(source: RoundClosingPrefillSource, facts: PrefillFacts): string {
  switch (source) {
    case "investor_name":
      return facts.investorName;
    case "investor_email":
      return facts.investorEmail;
    case "amount":
      return formatAmount(facts.amount, facts.currency);
    case "round_name":
      return facts.roundName;
    case "company_name":
      return facts.companyName;
    case "valuation_cap":
      return valuationCapText(facts.terms, facts.currency);
    case "date":
      // A calendar date, UTC: what a signature page prints, and the same on every server.
      return facts.now.toISOString().slice(0, 10);
  }
}

/** The vendor template's prefill map: vendor field name → value, from the workspace mapping. */
export function buildPrefill(
  mapping: RoundClosingSettings["prefill"],
  facts: PrefillFacts,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [field, source] of Object.entries(mapping)) out[field] = prefillValue(source, facts);
  return out;
}

/** `Signed documents/<round name>`, with the path separator kept out of the round's name. */
export function vaultFolderFor(roundName: string): string {
  const clean =
    roundName
      .replace(/[/\\]+/gu, "-")
      .trim()
      .slice(0, 120) || "Round";
  return `Signed documents/${clean}`;
}
