import axe, { type AxeResults, type RunOptions } from "axe-core";
import { expect } from "vitest";

/*
 * WCAG 2.2 AA check for component and screen tests (design/07 §5: zero serious/critical).
 * jsdom has no layout engine, so colour-contrast is disabled here; Storybook's a11y addon and
 * the Playwright axe run (E0.8/E2.9) cover it in a real browser.
 */
const DEFAULT_OPTIONS: RunOptions = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] },
  rules: { "color-contrast": { enabled: false } },
};

export async function runAxe(node: Element, options: RunOptions = {}): Promise<AxeResults> {
  return axe.run(node, { ...DEFAULT_OPTIONS, ...options });
}

/** `await expectNoA11yViolations(container)` — fails with a readable list of violations. */
export async function expectNoA11yViolations(node: Element, options?: RunOptions): Promise<void> {
  const results = await runAxe(node, options);
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  const message = results.violations
    .map(
      (v) =>
        `${v.id} [${v.impact}] ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(" ")}: ${n.failureSummary ?? ""}`).join("\n")}`,
    )
    .join("\n\n");
  expect(serious, message).toEqual([]);
  expect(results.violations, message).toEqual([]);
}
