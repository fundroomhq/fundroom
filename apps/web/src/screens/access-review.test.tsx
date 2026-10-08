import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  accessReviewRecord,
  accessReviewReport,
  accessReviewRow,
  apiError,
  type Handler,
  installMockApi,
  withPlanEntitlements,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * /admin/access-review (E2.7): summary counts, last/next review, the report table with flags
 * (including the accreditation gate/attestation disagreement), filtering by flag, the CSV
 * download, "Mark review complete" (a `fresh` route) and the truncation warning.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01";
const BOB_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e09";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

function report() {
  return accessReviewReport({
    members: [
      accessReviewRow(),
      accessReviewRow({
        membershipId: BOB_ID,
        name: "Bob Stale",
        email: "bob@investor.test",
        groups: [],
        lastActiveAt: null,
        activeSessions: 0,
        nda: null,
        accreditation: {
          signedAt: "2025-09-01T10:00:00.000Z",
          expiresAt: "2026-09-01T10:00:00.000Z",
          gateMaxAgeDays: 90,
          gateLapsesAt: "2025-11-30T10:00:00.000Z",
          diverges: true,
        },
        pendingGates: ["nda:v3"],
        flags: ["never_active", "accreditation_diverges", "pending_gates"],
      }),
    ],
    summary: {
      members: 2,
      flagged: 1,
      byFlag: { never_active: 1, accreditation_diverges: 1, pending_gates: 1 },
      truncated: false,
    },
    lastReview: accessReviewRecord(),
    nextReviewDueAt: "2026-08-30T10:00:00.000Z",
  });
}

function handlers(
  over: Record<string, Handler> = {},
  permissions = ["access.read", "access.manage"],
) {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [
      200,
      bootstrap({
        modules: [],
        permissions,
        membership: { id: OWNER_ID, kind: "staff", role: "owner" },
      }),
    ],
    "GET /api/v1/access/review": () => [200, report()],
    "GET /api/v1/access/reviews": () => [200, { items: [accessReviewRecord()] }],
    ...over,
  });
}

async function openReview() {
  const r = await renderApp("/admin/access-review");
  expect(
    await screen.findByRole("heading", { name: "Access review", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

function withObjectUrls(): { clicked: HTMLAnchorElement[]; undo: () => void } {
  const clicked: HTMLAnchorElement[] = [];
  Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:1" });
  Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function mocked(
    this: HTMLAnchorElement,
  ) {
    clicked.push(this);
  });
  return {
    clicked,
    undo: () => {
      click.mockRestore();
      Reflect.deleteProperty(URL, "createObjectURL");
      Reflect.deleteProperty(URL, "revokeObjectURL");
    },
  };
}

describe("access review", () => {
  it("shows counts, last and next review, flags and the accreditation disagreement", async () => {
    handlers();
    const r = await openReview();
    const table = await screen.findByRole("table", { name: "Access report" });
    expect(screen.getByText("People with access").nextSibling).toHaveTextContent("2");
    expect(screen.getByText("Flagged").nextSibling).toHaveTextContent("1");
    expect(screen.getByText("by Grace Hopper")).toBeInTheDocument();
    // Due date in the past → overdue.
    expect(screen.getByText("Overdue")).toBeInTheDocument();

    const bob = within(table).getByRole("row", { name: /Bob Stale/u });
    expect(within(bob).getByText("Never active", { selector: "[data-slot=badge]" })).toBeVisible();
    expect(within(bob).getByText("Gates pending")).toBeInTheDocument();
    expect(within(bob).getByText(/The gate and the attestation disagree/u)).toBeInTheDocument();
    expect(within(bob).getByText("nda:v3")).toBeInTheDocument();
    expect(within(table).getByRole("link", { name: "Ada Lovelace" })).toHaveAttribute(
      "href",
      "/admin/people/0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01",
    );
    expect(await screen.findByRole("table", { name: "Past reviews" })).toBeInTheDocument();
    expect(screen.queryByText("Not everyone is listed")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("filters the table by flag", async () => {
    handlers();
    await openReview();
    const table = await screen.findByRole("table", { name: "Access report" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Show"), "flagged");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).queryByText("Ada Lovelace")).toBeNull();
    await user.selectOptions(screen.getByLabelText("Show"), "stale");
    expect(screen.getByText("Nobody matches this filter.")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Show"), "");
    expect(
      within(await screen.findByRole("table", { name: "Access report" })).getAllByRole("row"),
    ).toHaveLength(3);
  }, 20_000);

  it("warns when the report was truncated", async () => {
    handlers({
      "GET /api/v1/access/review": () => [
        200,
        accessReviewReport({
          summary: { members: 1, flagged: 0, byFlag: {}, truncated: true },
        }),
      ],
      "GET /api/v1/access/reviews": () => [200, { items: [] }],
    });
    const r = await openReview();
    expect(await screen.findByText("Not everyone is listed")).toBeInTheDocument();
    // Never reviewed: the server still sends a due date (workspace creation + 90 days); a future
    // one is shown as a date and is not overdue.
    expect(screen.getByText("Next review due").nextSibling).toHaveTextContent("Dec 11, 2026");
    expect(screen.queryByText("Overdue")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("downloads the CSV, and says so when it fails", async () => {
    const urls = withObjectUrls();
    let fail = false;
    handlers({
      "GET /api/v1/access/review": ({ url }) => {
        if (url.searchParams.get("format") !== "csv") return [200, report()];
        if (fail) return apiError(500, "internal_error");
        return new Response("name,email\r\n", {
          status: 200,
          headers: { "content-type": "text/csv; charset=utf-8" },
        });
      },
    });
    await openReview();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(urls.clicked).toHaveLength(1));
    expect(urls.clicked[0]?.download).toMatch(/^access-review-\d{4}-\d{2}-\d{2}\.csv$/u);
    fail = true;
    await user.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(await screen.findByText("Something went wrong")).toBeInTheDocument();
    expect(urls.clicked).toHaveLength(1);
    urls.undo();
  }, 20_000);

  it("marks the review complete with a note", async () => {
    const { calls } = handlers({
      "POST /api/v1/access/reviews": () => [201, accessReviewRecord({ note: "All fine" })],
    });
    await openReview();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Mark review complete" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("2 people (1 flagged)");
    await user.type(within(dialog).getByLabelText("Note"), "All fine");
    await user.click(within(dialog).getByRole("button", { name: "Mark review complete" }));
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === "/api/v1/access/reviews")?.body,
      ).toEqual({
        note: "All fine",
        // The reviewer attests to the report on screen.
        reportSha256: "d".repeat(64),
        generatedAt: report().generatedAt,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  }, 20_000);

  it("reloads a report that changed under the reviewer and asks again", async () => {
    let version = 1;
    const { calls } = handlers({
      "GET /api/v1/access/review": () => [
        200,
        { ...report(), reportSha256: String(version).repeat(64) },
      ],
      "POST /api/v1/access/reviews": ({ body }) =>
        (body as { reportSha256?: string }).reportSha256 === "2".repeat(64)
          ? [201, accessReviewRecord()]
          : apiError(409, "conflict", { reason: "report_changed" }),
    });
    const r = await openReview();
    await screen.findByRole("table", { name: "Access report" });
    version = 2;
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Mark review complete" }));
    let dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Mark review complete" }));
    expect(await screen.findByText("Access changed while you were reviewing")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === "GET" && c.path === "/api/v1/access/review").length,
      ).toBeGreaterThanOrEqual(2),
    );
    await expectNoA11yViolations(r.container);

    // The reloaded report's digest goes out the second time, and is accepted.
    await user.click(await screen.findByRole("button", { name: "Mark review complete" }));
    dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Mark review complete" }));
    await waitFor(() =>
      expect(screen.queryByText("Access changed while you were reviewing")).toBeNull(),
    );
    const posts = calls.filter((c) => c.method === "POST" && c.path === "/api/v1/access/reviews");
    expect(posts.map((p) => (p.body as { reportSha256: string }).reportSha256)).toEqual([
      "1".repeat(64),
      "2".repeat(64),
    ]);
  }, 20_000);

  it("downloads the stored report of a past review as evidence", async () => {
    const urls = withObjectUrls();
    const record = accessReviewRecord();
    const { calls } = handlers({
      [`GET /api/v1/access/reviews/${record.id}/report`]: () =>
        new Response('{"schemaVersion":1}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await openReview();
    const history = await screen.findByRole("table", { name: "Past reviews" });
    const user = userEvent.setup();
    await user.click(
      within(history).getByRole("button", { name: /Download the report reviewed on/u }),
    );
    await waitFor(() => expect(urls.clicked).toHaveLength(1));
    expect(urls.clicked[0]?.download).toBe(
      `access-review-2026-06-01-${record.id.slice(0, 8)}.json`,
    );
    expect(calls.some((c) => c.path === `/api/v1/access/reviews/${record.id}/report`)).toBe(true);
    urls.undo();
  }, 20_000);

  it("sends a stale session through step-up to complete the review", async () => {
    handlers({
      "POST /api/v1/access/reviews": () => apiError(401, "step_up_required", { reason: "fresh" }),
    });
    const r = await openReview();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Mark review complete" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Mark review complete" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
  }, 20_000);

  it("offers no completion without access.manage", async () => {
    handlers({}, ["access.read"]);
    await openReview();
    expect(await screen.findByRole("table", { name: "Access report" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark review complete" })).toBeNull();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeInTheDocument();
  }, 20_000);
});

// A-3 (ADR-0063): without `access_reviews` on the plan the report and past reviews stay readable.
describe("access review on a plan without access reviews", () => {
  it("keeps the report and the export, and greys out recording a review", async () => {
    handlers();
    withPlanEntitlements({ features: [] });
    const r = await openReview();
    expect(
      await screen.findByText(
        "Your plan doesn't include Access reviews. Your settings are kept, but it can't be used until the plan includes it.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Mark review complete" }, { timeout: 5000 }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download CSV" })).toBeEnabled();
    // The due date has passed, but no "Overdue" nag for a review nobody can record (R3 L12).
    expect(screen.queryByText("Overdue")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
