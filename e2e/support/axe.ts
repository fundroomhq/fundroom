import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page, type TestInfo, test } from "@playwright/test";

/*
 * Real-browser axe (design/07 §5, E2.8): WCAG 2.0/2.1/2.2 A + AA. Unlike the jsdom run in
 * `apps/web/src/test/a11y.ts`, a real browser computes colours and layout, so `color-contrast`,
 * `link-in-text-block`, `target-size` and friends are live here — that is the point of running it.
 *
 * Any violation fails (not only serious/critical): a moderate finding on a key page is still a
 * WCAG failure. The full result is attached to the Playwright report either way, so a green run
 * still shows what was checked (`passes` count, incomplete items to review by hand).
 */
export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] as const;

export interface AxeOptions {
  /** Name for the report attachment (defaults to the page path). */
  readonly name?: string;
  /** Limit the scan to these selectors. */
  readonly include?: readonly string[];
  /** Leave these selectors out (third-party frames etc.). Say why at the call site. */
  readonly exclude?: readonly string[];
}

export async function expectNoAxeViolations(
  page: Page,
  options: AxeOptions = {},
  testInfo: TestInfo = test.info(),
): Promise<void> {
  /*
   * Let running CSS transitions/animations finish first. A button that just changed variant
   * (setup's mail step: ghost "Skip" → primary "Continue" under `transition-colors`) is otherwise
   * sampled mid-fade, and axe reports the interpolated colours as a contrast failure (1.77:1) that
   * no user ever sees at rest. Infinite animations (spinners) are left alone.
   */
  await page.evaluate(async () => {
    const finite = document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().endTime !== Number.POSITIVE_INFINITY);
    await Promise.race([
      Promise.allSettled(finite.map((a) => a.finished)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  });
  let builder = new AxeBuilder({ page }).withTags([...WCAG_TAGS]);
  for (const selector of options.include ?? []) builder = builder.include(selector);
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector);
  const results = await builder.analyze();
  const name = options.name ?? new URL(page.url()).pathname;
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.map((n) => ({ target: n.target, summary: n.failureSummary, html: n.html })),
  }));
  await testInfo.attach(`axe ${name}`, {
    body: JSON.stringify(
      {
        url: page.url(),
        violations: summary,
        passes: results.passes.length,
        incomplete: results.incomplete.map((i) => ({ id: i.id, nodes: i.nodes.length })),
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  const readable = summary
    .map(
      (v) =>
        `${v.id} [${v.impact}] ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(" ")}: ${n.summary ?? ""}`).join("\n")}`,
    )
    .join("\n\n");
  expect(summary, `axe on ${name}:\n${readable}`).toEqual([]);
}
