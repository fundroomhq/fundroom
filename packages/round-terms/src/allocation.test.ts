import { describe, expect, it } from "vitest";
import { allocation, COMMITMENT_STATUSES, type CommitmentStatus } from "./allocation.js";

const at = (amount: string, status: CommitmentStatus) => ({ amount, status });

describe("allocation", () => {
  it("names the five statuses the column holds", () => {
    expect(COMMITMENT_STATUSES).toEqual(["soft", "verbal", "signed", "wired", "withdrawn"]);
  });

  it("buckets a round by status", () => {
    const result = allocation(
      [at("100000", "soft"), at("50000", "verbal"), at("25000", "signed"), at("25000", "wired")],
      "500000",
    );
    expect(result).toMatchObject({
      target: "500000.00",
      soft: "100000.00",
      verbal: "50000.00",
      signed: "25000.00",
      wired: "25000.00",
      committed: "100000.00",
      total: "200000.00",
      remaining: "300000.00",
    });
  });

  it("counts verbal, signed and wired as committed, and soft separately", () => {
    const result = allocation([at("10", "soft"), at("10", "verbal"), at("10", "wired")], "100");
    expect(result.committed).toBe("20.00");
    expect(result.total).toBe("30.00");
  });

  it("excludes withdrawn commitments from every bucket", () => {
    const withdrawn = allocation([at("100000", "soft"), at("999999", "withdrawn")], "500000");
    expect(withdrawn.total).toBe("100000.00");
    expect(withdrawn.committed).toBe("0.00");
    expect(withdrawn.remaining).toBe("400000.00");
    expect(Object.values(withdrawn)).not.toContain("999999.00");
  });

  it("adds up an empty round to zero rather than to nothing", () => {
    const empty = allocation([], "500000");
    expect(empty.total).toBe("0.00");
    expect(empty.remaining).toBe("500000.00");
    expect(empty.percent).toEqual({ soft: "0.00", committed: "0.00", wired: "0.00" });
  });

  it("floors `remaining` at zero when the round is oversubscribed", () => {
    const over = allocation([at("600000", "signed")], "500000");
    expect(over.remaining).toBe("0.00");
  });

  it("keeps `total` exact when the round is oversubscribed", () => {
    const over = allocation([at("600000", "signed"), at("50000", "soft")], "500000");
    expect(over.total).toBe("650000.00");
    expect(over.committed).toBe("600000.00");
  });

  it("caps the display percentages at 100 so a progress bar cannot overflow", () => {
    const over = allocation([at("600000", "signed"), at("700000", "soft")], "500000");
    expect(over.percent.committed).toBe("100.00");
    expect(over.percent.soft).toBe("100.00");
  });

  it("works the percentages out against the target, to two decimals", () => {
    const result = allocation(
      [at("100000", "soft"), at("50000", "verbal"), at("25000", "wired")],
      "500000",
    );
    expect(result.percent).toEqual({ soft: "20.00", committed: "15.00", wired: "5.00" });
  });

  it("rounds a repeating percentage rather than truncating it", () => {
    const result = allocation([at("100000", "soft")], "300000");
    expect(result.percent.soft).toBe("33.33");
  });

  it("answers zero percentages for a target of zero instead of dividing by it", () => {
    const result = allocation([at("100000", "soft")], "0");
    expect(result.percent).toEqual({ soft: "0.00", committed: "0.00", wired: "0.00" });
    expect(result.total).toBe("100000.00");
    expect(result.remaining).toBe("0.00");
  });

  it("keeps the six decimal places the column stores", () => {
    const result = allocation([at("0.005", "soft"), at("0.005", "soft")], "1");
    expect(result.soft).toBe("0.01");
  });

  it("ignores an amount that is not a decimal string instead of throwing", () => {
    const result = allocation([at("100000", "soft"), at("1e5", "soft")], "500000");
    expect(result.soft).toBe("100000.00");
  });

  it("treats an unreadable target as zero", () => {
    const result = allocation([at("100000", "soft")], "not a number");
    expect(result.target).toBe("0.00");
    expect(result.remaining).toBe("0.00");
  });

  it("adds many commitments without losing a cent", () => {
    const many = Array.from({ length: 300 }, () => at("333.33", "soft" as CommitmentStatus));
    expect(allocation(many, "100000").soft).toBe("99999.00");
  });
});
