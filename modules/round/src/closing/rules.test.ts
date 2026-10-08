import { describe, expect, it } from "vitest";
import { SIGNATURE_REQUEST_STATUSES } from "../model.js";
import {
  buildPrefill,
  closingChecklist,
  closingSummary,
  formatAmount,
  isFinalSignatureStatus,
  isKernelEnvelopeLive,
  isOpenSignatureStatus,
  isVoidableSignatureRequest,
  mirrorStatus,
  nextMirrorStatus,
  signatureRequestRefusal,
  signedTransition,
  vaultFolderFor,
} from "./rules.js";

const ok = {
  roundStatus: "open",
  commitmentStatus: "soft",
  connection: { supportsTemplates: true },
  templateRef: "tpl_1",
} as const;

describe("send-for-signature preconditions", () => {
  it("a soft or verbal commitment in an open or closed round, with a template vendor and ref, may be sent", () => {
    expect(signatureRequestRefusal(ok)).toBeUndefined();
    expect(signatureRequestRefusal({ ...ok, commitmentStatus: "verbal" })).toBeUndefined();
    // Closing after the round closed is the common case.
    expect(signatureRequestRefusal({ ...ok, roundStatus: "closed" })).toBeUndefined();
  });

  it("names the first thing to fix, in order: round, commitment, connection, template", () => {
    expect(
      signatureRequestRefusal({
        roundStatus: "planning",
        commitmentStatus: "wired",
        connection: undefined,
        templateRef: null,
      }),
    ).toEqual({ code: "round_not_open", status: "planning" });
    for (const status of ["signed", "wired", "withdrawn"] as const) {
      expect(signatureRequestRefusal({ ...ok, commitmentStatus: status })).toEqual({
        code: "commitment_not_signable",
        status,
      });
    }
    expect(signatureRequestRefusal({ ...ok, connection: undefined, templateRef: null })).toEqual({
      code: "esign_not_configured",
    });
    expect(
      signatureRequestRefusal({
        ...ok,
        connection: { supportsTemplates: false },
        templateRef: null,
      }),
    ).toEqual({ code: "esign_template_unsupported" });
    expect(signatureRequestRefusal({ ...ok, templateRef: null })).toEqual({
      code: "subscription_template_missing",
    });
    expect(signatureRequestRefusal({ ...ok, templateRef: "  " })).toEqual({
      code: "subscription_template_missing",
    });
  });
});

describe("the status mirror", () => {
  it("maps every kernel envelope status; draft is still our pending claim", () => {
    expect(mirrorStatus("draft")).toBe("pending");
    for (const s of ["sent", "delivered", "completed", "declined", "voided", "expired", "error"])
      expect(mirrorStatus(s)).toBe(s);
    expect(mirrorStatus("something-new")).toBe("pending");
  });

  const env = { hasEnvelope: true };

  it("moves forward only and never out of a final status (redelivery, reordering)", () => {
    expect(nextMirrorStatus("pending", "sent", env)).toBe("sent");
    expect(nextMirrorStatus("sent", "delivered", env)).toBe("delivered");
    expect(nextMirrorStatus("sent", "completed", env)).toBe("completed");
    expect(nextMirrorStatus("pending", "completed", env)).toBe("completed");
    expect(nextMirrorStatus("delivered", "declined", env)).toBe("declined");
    // Same status again: nothing to do.
    expect(nextMirrorStatus("sent", "sent", env)).toBeUndefined();
    // A late `sent` after `delivered`.
    expect(nextMirrorStatus("delivered", "sent", env)).toBeUndefined();
    // Final is final, whatever arrives — including a late `error`.
    for (const final of ["completed", "declined", "voided", "expired"] as const) {
      for (const incoming of SIGNATURE_REQUEST_STATUSES) {
        expect(nextMirrorStatus(final, incoming, env), `${final} ← ${incoming}`).toBeUndefined();
        expect(nextMirrorStatus(final, incoming, { hasEnvelope: false })).toBeUndefined();
      }
    }
  });

  it("kernel `error` is recoverable once an envelope exists; `completed` always wins (fix C1)", () => {
    // Any open mirror may enter `error`.
    for (const open of ["pending", "sent", "delivered"] as const)
      expect(nextMirrorStatus(open, "error", env)).toBe("error");
    // An `error` mirror with an envelope follows the kernel back out of it…
    for (const later of [
      "sent",
      "delivered",
      "completed",
      "declined",
      "voided",
      "expired",
    ] as const)
      expect(nextMirrorStatus("error", later, env), later).toBe(later);
    // …but never back to a claim, and never to itself.
    expect(nextMirrorStatus("error", "pending", env)).toBeUndefined();
    expect(nextMirrorStatus("error", "error", env)).toBeUndefined();
    // A claim released before it reached the vendor (no envelope) is final.
    for (const incoming of SIGNATURE_REQUEST_STATUSES)
      expect(nextMirrorStatus("error", incoming, { hasEnvelope: false })).toBeUndefined();
  });

  it("final, voidable and live are decided by the envelope as well as the status", () => {
    expect(isFinalSignatureStatus("error", null)).toBe(true);
    expect(isFinalSignatureStatus("error", "e1")).toBe(false);
    expect(isFinalSignatureStatus("completed", "e1")).toBe(true);
    expect(isFinalSignatureStatus("sent", "e1")).toBe(false);
    expect(isVoidableSignatureRequest("error", "e1")).toBe(true);
    expect(isVoidableSignatureRequest("error", null)).toBe(false);
    expect(isVoidableSignatureRequest("sent", "e1")).toBe(true);
    expect(isVoidableSignatureRequest("completed", "e1")).toBe(false);
    const at = "2026-09-26T00:00:00.000Z";
    for (const status of ["draft", "sent", "delivered", "completed"])
      expect(isKernelEnvelopeLive({ status, sentAt: at }), status).toBe(true);
    // An error that reached the vendor is still live there; one that never did is not.
    expect(isKernelEnvelopeLive({ status: "error", sentAt: at })).toBe(true);
    expect(isKernelEnvelopeLive({ status: "error", sentAt: null })).toBe(false);
    for (const status of ["declined", "voided", "expired"])
      expect(isKernelEnvelopeLive({ status, sentAt: at }), status).toBe(false);
  });

  it("open statuses are exactly what the partial unique index covers", () => {
    expect(SIGNATURE_REQUEST_STATUSES.filter(isOpenSignatureStatus)).toEqual([
      "pending",
      "sent",
      "delivered",
    ]);
  });
});

describe("what a completed signature does to the commitment", () => {
  it("soft and verbal move to signed; signed_at is stamped once", () => {
    expect(signedTransition({ status: "soft", signedAt: null })).toEqual({
      status: "signed",
      stampSignedAt: true,
    });
    expect(signedTransition({ status: "verbal", signedAt: null }).status).toBe("signed");
  });

  it("never regresses wired and never resurrects withdrawn", () => {
    expect(signedTransition({ status: "wired", signedAt: null })).toEqual({
      status: undefined,
      stampSignedAt: true,
    });
    expect(signedTransition({ status: "withdrawn", signedAt: null }).status).toBeUndefined();
    expect(
      signedTransition({ status: "signed", signedAt: new Date("2026-01-01T00:00:00Z") }),
    ).toEqual({ status: undefined, stampSignedAt: false });
  });
});

describe("the derived checklist", () => {
  const at = (d: string) => new Date(`2026-09-${d}T10:00:00Z`);
  const base = {
    status: "soft",
    signedAt: null,
    wiredAt: null,
    confirmedAt: null,
    latestRequest: undefined,
  } as const;

  it("walks not_started → documents_sent → signed → wired → confirmed", () => {
    expect(closingChecklist(base).stage).toBe("not_started");
    // A pending claim or a failed send is not "documents sent".
    expect(
      closingChecklist({ ...base, latestRequest: { status: "pending", sentAt: at("01") } }).stage,
    ).toBe("not_started");
    expect(
      closingChecklist({ ...base, latestRequest: { status: "error", sentAt: at("01") } }).stage,
    ).toBe("not_started");
    const sent = closingChecklist({ ...base, latestRequest: { status: "sent", sentAt: at("01") } });
    expect(sent).toMatchObject({ stage: "documents_sent", documentsSent: true });
    expect(sent.documentsSentAt).toEqual(at("01"));
    const signed = closingChecklist({
      ...base,
      status: "signed",
      signedAt: at("02"),
      latestRequest: { status: "completed", sentAt: at("01") },
    });
    expect(signed).toMatchObject({ stage: "signed", documentsSent: true, signed: true });
    const wired = closingChecklist({
      ...base,
      status: "wired",
      signedAt: at("02"),
      wiredAt: at("03"),
    });
    expect(wired).toMatchObject({ stage: "wired", signed: true, wired: true, confirmed: false });
    const confirmed = closingChecklist({
      ...base,
      status: "wired",
      wiredAt: at("03"),
      confirmedAt: at("04"),
    });
    expect(confirmed.stage).toBe("confirmed");
  });

  it("paper signed outside the product counts: a commitment moved to signed by hand is signed", () => {
    const c = closingChecklist({ ...base, status: "signed" });
    expect(c).toMatchObject({ signed: true, documentsSent: true, stage: "signed" });
    expect(c.documentsSentAt).toBeNull();
  });

  it("a withdrawn commitment is its own stage", () => {
    expect(
      closingChecklist({
        ...base,
        status: "withdrawn",
        latestRequest: { status: "voided", sentAt: at("01") },
      }).stage,
    ).toBe("withdrawn");
  });

  it("the summary counts and sums per stage in fixed point", () => {
    const summary = closingSummary([
      { stage: "signed", amount: "100000.10" },
      { stage: "signed", amount: "0.20" },
      { stage: "wired", amount: "5.00" },
    ]);
    expect(summary.signed).toEqual({ count: 2, amount: "100000.30" });
    expect(summary.wired).toEqual({ count: 1, amount: "5.00" });
    expect(summary.not_started).toEqual({ count: 0, amount: "0.00" });
    expect(Object.keys(summary)).toEqual([
      "not_started",
      "documents_sent",
      "signed",
      "wired",
      "confirmed",
      "withdrawn",
    ]);
  });
});

describe("prefill", () => {
  const facts = {
    investorName: "Ada Lovelace",
    investorEmail: "ada@example.test",
    amount: "250000.00",
    currency: "USD",
    roundName: "Seed",
    companyName: "Acme",
    terms: {
      kind: "safe",
      variant: "post_money",
      valuationCap: "10000000",
      mfn: false,
      proRata: false,
    },
    now: new Date("2026-09-25T23:30:00Z"),
  } as const;

  it("formats amounts in the round currency, exactly (a decimal string, never a double)", () => {
    expect(formatAmount("250000", "USD")).toBe("$250,000.00");
    expect(formatAmount("1000.5", "EUR")).toBe("€1,000.50");
    expect(formatAmount("12345678901234567.89", "USD")).toBe("$12,345,678,901,234,567.89");
    expect(formatAmount("10000", "CHF")).toBe("CHF 10,000.00");
  });

  it("maps each vendor field to its source; unknown facts are empty, not 'undefined'", () => {
    const prefill = buildPrefill(
      {
        "Investor Name": "investor_name",
        email: "investor_email",
        Amount: "amount",
        round: "round_name",
        company: "company_name",
        cap: "valuation_cap",
        Date: "date",
      },
      facts,
    );
    expect(prefill).toEqual({
      "Investor Name": "Ada Lovelace",
      email: "ada@example.test",
      Amount: "$250,000.00",
      round: "Seed",
      company: "Acme",
      cap: "$10,000,000.00",
      Date: "2026-09-25",
    });
    expect(buildPrefill({ cap: "valuation_cap" }, { ...facts, terms: undefined })).toEqual({
      cap: "",
    });
    const priced = buildPrefill(
      { cap: "valuation_cap" },
      {
        ...facts,
        currency: "EUR",
        terms: {
          kind: "priced",
          preMoneyValuation: "8000000",
          liquidationPreferenceMultiple: "1",
          participating: false,
          proRata: false,
        },
      },
    );
    expect(priced["cap"]).toBe("€8,000,000.00");
    expect(buildPrefill({}, facts)).toEqual({});
  });

  it("files the signed copy under the round's name, with no path separators smuggled in", () => {
    expect(vaultFolderFor("Seed")).toBe("Signed documents/Seed");
    expect(vaultFolderFor("Seed / Bridge\\2")).toBe("Signed documents/Seed - Bridge-2");
    expect(vaultFolderFor("   ")).toBe("Signed documents/Round");
  });
});
