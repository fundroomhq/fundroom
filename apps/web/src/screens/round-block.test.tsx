import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BlockView } from "../components/content/page-renderer.js";
import type { RenderedBlock } from "../lib/queries.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { noteTerms, roundSummaryHydrated } from "../test/fixtures-round.js";

/*
 * The `round_summary` content block (E2.5 §R).
 *
 * The test that matters most is the one asserting **nothing**. A page section an anonymous
 * reader can see hydrates to `{}` — the hydrator refuses the block outright in a public
 * section under 506(b) — and `{}` must render as literally nothing. A placeholder saying
 * "sign in to see the round" would announce that there is a round to see, which is the
 * disclosure the refusal exists to prevent.
 */

/*
 * `RenderedBlock` is generated from the server's OpenAPI document, whose block union does not
 * know `round_summary` until WP-B's routes exist and the SDK is regenerated. The cast is the
 * one place that knowledge is missing, rather than an `any` at every call site.
 */
const block = (data: Record<string, unknown>, unavailable?: string): RenderedBlock =>
  ({
    id: "round-summary-1",
    type: "round_summary",
    schemaVersion: 1,
    data,
    ...(unavailable === undefined ? {} : { unavailable }),
  }) as unknown as RenderedBlock;

describe("round_summary content block", () => {
  it("renders the instrument, the bar and the disclaimer from the hydrated payload", async () => {
    const r = render(<BlockView block={block({ hydrated: roundSummaryHydrated() })} />);
    expect(await screen.findByText("Seed 2026", {}, { timeout: 5000 })).toBeInTheDocument();
    // The terms are named in words, not printed as a term sheet.
    expect(screen.getByText("Valuation cap")).toBeInTheDocument();
    expect(screen.getByText("$8,000,000")).toBeInTheDocument();
    expect(screen.getByText("SAFE, post-money")).toBeInTheDocument();
    // The bar is a picture with a sentence for a name, and every figure is also in text.
    const bar = screen.getByRole("img");
    expect(bar.getAttribute("aria-label")).toContain("$700,000 committed");
    expect(screen.getByText("Soft-circled")).toBeInTheDocument();
    expect(screen.getByText("$300,000")).toBeInTheDocument();
    // The versioned disclaimer travels with the terms; the version is part of the record.
    expect(screen.getByText("Offering disclaimer · version 2")).toBeInTheDocument();
    expect(screen.getByText(/offer to sell securities/u)).toBeInTheDocument();
    // No `style` attribute anywhere: the CSP forbids one and the meter is class-driven.
    expect(r.container.querySelectorAll("[style]")).toHaveLength(0);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("renders a note's own terms, interest and maturity included", async () => {
    const r = render(
      <BlockView
        block={block({
          hydrated: roundSummaryHydrated({
            round: {
              ...(roundSummaryHydrated()["round"] as Record<string, unknown>),
              instrumentKind: "note",
            },
            terms: noteTerms(),
          }),
        })}
      />,
    );
    expect(await screen.findByText("Interest rate", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("5%")).toBeInTheDocument();
    expect(screen.getByText("Maturity")).toBeInTheDocument();
    expect(screen.getByText("24 months")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("renders nothing at all for the empty payload an anonymous reader gets", async () => {
    const r = render(<BlockView block={block({ hydrated: {} })} />);
    expect(r.container.textContent).toBe("");
    expect(screen.queryByText(/sign in/iu)).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("renders nothing for a payload it cannot read rather than half a term sheet", async () => {
    const r = render(<BlockView block={block({ hydrated: { round: { name: "Seed 2026" } } })} />);
    expect(r.container.textContent).toBe("");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("says the module is off rather than guessing, when the block cannot be hydrated", async () => {
    const r = render(<BlockView block={block({}, "module_unavailable")} />);
    expect(screen.getByText(/once the round module is enabled/u)).toBeVisible();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
