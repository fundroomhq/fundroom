import type { CommitmentStatus } from "@fundroom/round-terms";
import { describe, expect, it } from "vitest";
import type { RoundRecord } from "../repos/round-repo.js";
import { allocationOf, investorProgress } from "./allocation.js";

/*
 * The allocation tracker. `allocation()` itself is tested in `@fundroom/round-terms`; what is
 * pinned here is the module's two decisions on top of it — that the currency travels with the
 * buckets, and what an *investor* is allowed to see of them.
 */

const round = (over: Partial<RoundRecord> = {}) =>
  ({ targetAmount: "1000000.00", currency: "USD", ...over }) as RoundRecord;

const c = (amount: string, status: CommitmentStatus) => ({ amount, status });

describe("allocationOf", () => {
  it("carries the round's currency, which the buckets themselves do not", () => {
    expect(allocationOf(round({ currency: "EUR" }), []).currency).toBe("EUR");
  });

  it("splits the five statuses and rolls the committed three together", () => {
    const a = allocationOf(round(), [
      c("100000", "soft"),
      c("200000", "verbal"),
      c("150000", "signed"),
      c("50000", "wired"),
    ]);
    expect(a.soft).toBe("100000.00");
    expect(a.verbal).toBe("200000.00");
    expect(a.signed).toBe("150000.00");
    expect(a.wired).toBe("50000.00");
    expect(a.committed).toBe("400000.00");
    expect(a.total).toBe("500000.00");
    expect(a.remaining).toBe("500000.00");
  });

  it("drops a withdrawal from every bucket", () => {
    // A withdrawal is the absence of a commitment; the row stays for the audit trail and stops
    // counting, or a round would look fuller than it is.
    const a = allocationOf(round(), [c("100000", "soft"), c("900000", "withdrawn")]);
    expect(a.total).toBe("100000.00");
    expect(a.remaining).toBe("900000.00");
  });

  it("never reports a negative remainder, and never caps the total", () => {
    // "minus $200,000 left" is not a figure; an oversubscribed round, on the other hand, has to
    // read as one.
    const a = allocationOf(round(), [c("1200000", "signed")]);
    expect(a.total).toBe("1200000.00");
    expect(a.remaining).toBe("0.00");
    expect(a.percent.committed).toBe("100.00");
  });
});

describe("investorProgress", () => {
  const full = allocationOf(round(), [
    c("100000", "soft"),
    c("200000", "verbal"),
    c("150000", "signed"),
    c("50000", "wired"),
  ]);

  it("shows three buckets, not five", () => {
    /*
     * The split between verbal and signed is an internal fact about paperwork: an investor
     * reading "verbal $200,000, signed $150,000" learns how far behind the company's counsel is,
     * which is not what a progress bar is for.
     */
    const p = investorProgress(full);
    expect(Object.keys(p).sort()).toEqual([
      "committed",
      "currency",
      "percent",
      "remaining",
      "soft",
      "target",
      "total",
      "wired",
    ]);
    expect("verbal" in p).toBe(false);
    expect("signed" in p).toBe(false);
  });

  it("keeps the two figures somebody deciding whether to join actually acts on", () => {
    const p = investorProgress(full);
    expect(p.remaining).toBe("500000.00");
    expect(p.percent).toEqual({ soft: "10.00", committed: "40.00", wired: "5.00" });
  });
});
