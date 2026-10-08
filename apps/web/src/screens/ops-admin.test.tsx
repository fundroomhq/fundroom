import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../lib/ops-queries.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  apiError,
  deadLetter,
  domainHealth,
  type Handler,
  installMockApi,
  opsHealth,
  opsJobs,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/jobs` and `/admin/health` (E2.7). Queue stats and adapter checks only on a
 * single-tenant install (`scope: "instance"`); dead letters with retry (plain) and discard
 * (confirm + step-up); domains with certificate state and a warning inside 14 days.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f07";
const DLQ_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e11";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const updateStatus = (over: Partial<UpdateStatus> = {}): UpdateStatus => ({
  status: "current",
  currentVersion: "1.4.2",
  latestVersion: "1.4.2",
  checkedAt: "2026-09-23T10:00:00.000Z",
  releaseUrl: "https://github.com/fundroomhq/fundroom/releases/tag/v1.4.2",
  ...over,
});

function handlers(over: Record<string, Handler> = {}, permissions = ["ops.read", "ops.manage"]) {
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
    "GET /api/v1/ops/jobs": () => [200, opsJobs()],
    "GET /api/v1/ops/health": () => [200, opsHealth()],
    "GET /api/v1/ops/update": () => [200, updateStatus()],
    ...over,
  });
}

async function open(path: string, heading: string) {
  const r = await renderApp(path);
  expect(
    await screen.findByRole("heading", { name: heading, level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

describe("jobs admin", () => {
  it("shows queue stats and dead letters, and retries one", async () => {
    const { calls } = handlers({
      "POST /api/v1/ops/jobs/dead-letters/{id}/retry": () => new Response(null, { status: 204 }),
    });
    const r = await open("/admin/jobs", "Jobs");
    expect(await screen.findByText("Waiting")).toBeInTheDocument();
    expect(screen.getAllByText("event.acl.changed").length).toBe(2);
    expect(screen.getByText("acl.changed")).toBeInTheDocument();
    expect(screen.getByText("access.rebuild")).toBeInTheDocument();
    expect(screen.getByText("connection reset by peer")).toBeInTheDocument();
    expect(screen.getByText("1 failed")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Retry acl.changed" }));
    await waitFor(() =>
      expect(
        calls.find(
          (c) => c.method === "POST" && c.path === `/api/v1/ops/jobs/dead-letters/${DLQ_ID}/retry`,
        ),
      ).toBeDefined(),
    );
  }, 20_000);

  it("explains workspace scope and shows the empty state", async () => {
    handlers({
      "GET /api/v1/ops/jobs": () => [
        200,
        opsJobs({ scope: "workspace", queues: [], deadLetters: { count: 0, items: [] } }),
      ],
    });
    const r = await open("/admin/jobs", "Jobs");
    expect(
      await screen.findByText(/queues are monitored by the server operator/u),
    ).toBeInTheDocument();
    expect(screen.queryByText("Waiting")).toBeNull();
    expect(screen.getByText("No failed jobs")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("discards after confirming, and sends a stale admin to step-up", async () => {
    const { calls } = handlers({
      "DELETE /api/v1/ops/jobs/dead-letters/{id}": () =>
        apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await open("/admin/jobs", "Jobs");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Discard acl.changed" }));
    const dialog = await screen.findByRole("dialog", { name: "Discard acl.changed?" });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await user.click(within(dialog).getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("reason=fresh");
    expect(pathOf(r.router)).toContain("returnTo=%2Fadmin%2Fjobs");
    expect(
      calls.find(
        (c) => c.method === "DELETE" && c.path === `/api/v1/ops/jobs/dead-letters/${DLQ_ID}`,
      ),
    ).toBeDefined();
  }, 20_000);

  it("hides retry and discard without ops.manage; long errors fold", async () => {
    handlers(
      {
        "GET /api/v1/ops/jobs": () => [
          200,
          opsJobs({
            deadLetters: {
              count: 3,
              items: [deadLetter({ error: `boom\n${"stack line\n".repeat(20)}` })],
            },
          }),
        ],
      },
      ["ops.read"],
    );
    const r = await open("/admin/jobs", "Jobs");
    expect(await screen.findByText("boom")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Retry/u })).toBeNull();
    expect(screen.queryByRole("button", { name: /Discard/u })).toBeNull();
    expect(screen.getByText("Showing 1 of 3 failed jobs, most recent first.")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("refuses the screen without ops.read", async () => {
    const { calls } = handlers({}, []);
    await renderApp("/admin/jobs");
    expect(
      await screen.findByText(
        "Only workspace owners and admins can see jobs and health.",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path.startsWith("/api/v1/ops/"))).toBe(false);
  }, 20_000);
});

describe("health admin", () => {
  it("shows checks with status badges and domains with an expiry warning", async () => {
    const soon = new Date(Date.now() + 5 * 86_400_000 + 3_600_000).toISOString();
    const { calls } = handlers({
      "GET /api/v1/ops/health": () => [
        200,
        opsHealth({
          domains: [
            domainHealth(),
            domainHealth({ hostname: "ir.acme.test", certExpiresAt: soon }),
            domainHealth({
              hostname: "old.acme.test",
              status: "failed",
              certStatus: "invalid",
              certExpiresAt: null,
              certIssuer: null,
              certError: "hostname mismatch",
            }),
          ],
        }),
      ],
    });
    const r = await open("/admin/health", "Health");
    expect(await screen.findByText("db")).toBeInTheDocument();
    expect(screen.getByText("OK")).toBeInTheDocument();
    expect(screen.getByText("Degraded")).toBeInTheDocument();
    expect(screen.getByText("SMTP timeout")).toBeInTheDocument();
    expect(screen.getByText("Not configured")).toBeInTheDocument();
    expect(screen.getByText("3 ms")).toBeInTheDocument();
    expect(screen.getByText("investors.acme.test")).toBeInTheDocument();
    expect(screen.getByText("Expires in 5 days")).toBeInTheDocument();
    expect(screen.getAllByText(/Expires in/u)).toHaveLength(1);
    expect(screen.getByText("Invalid")).toBeInTheDocument();
    expect(screen.getByText("hostname mismatch")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const before = calls.filter((c) => c.path === "/api/v1/ops/health").length;
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(calls.filter((c) => c.path === "/api/v1/ops/health").length).toBe(before + 1),
    );
  }, 20_000);

  it("explains workspace scope in multi-tenant mode", async () => {
    handlers({
      "GET /api/v1/ops/health": () => [200, opsHealth({ scope: "workspace", checks: [] })],
    });
    const r = await open("/admin/health", "Health");
    expect(await screen.findByText("Checked by the server operator")).toBeInTheDocument();
    expect(screen.getByText("This workspace has no custom domains.")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Check" })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("health admin: update check (E2.9)", () => {
  it("up to date shows the running version", async () => {
    handlers();
    const r = await open("/admin/health", "Health");
    expect(await screen.findByText("Up to date", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("Running version 1.4.2")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Release notes/u })).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("a security update is a destructive alert with an underlined release-notes link", async () => {
    handlers({
      "GET /api/v1/ops/update": () => [
        200,
        updateStatus({
          status: "security_update",
          currentVersion: "1.4.0",
          securityReleases: ["1.4.1"],
        }),
      ],
    });
    const r = await open("/admin/health", "Health");
    const title = await screen.findByText("Security update available", {}, { timeout: 5000 });
    const alert = title.closest("[data-slot=alert]") as HTMLElement;
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert.className).toContain("text-destructive");
    expect(
      within(alert).getByText(
        "Version 1.4.0 is affected by problems fixed in 1.4.1. Update to version 1.4.2 as soon as you can.",
      ),
    ).toBeInTheDocument();
    const link = within(alert).getByRole("link", { name: /Release notes for version 1\.4\.2/u });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/fundroomhq/fundroom/releases/tag/v1.4.2",
    );
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link.className.split(/\s+/u)).toContain("underline");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("an ordinary update is a warning, not an alarm", async () => {
    handlers({
      "GET /api/v1/ops/update": () => [
        200,
        updateStatus({ status: "update_available", currentVersion: "1.4.1" }),
      ],
    });
    const r = await open("/admin/health", "Health");
    const title = await screen.findByText("Version 1.4.2 is available", {}, { timeout: 5000 });
    const alert = title.closest("[data-slot=alert]") as HTMLElement;
    expect(alert).toHaveAttribute("role", "status");
    expect(alert.className).toContain("text-warning");
    expect(screen.queryByText("Security update available")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("explains a development build, an opt-out and an unreachable index", async () => {
    handlers({
      "GET /api/v1/ops/update": () => [
        200,
        updateStatus({ status: "unknown", currentVersion: "0.0.0" }),
      ],
    });
    let r = await open("/admin/health", "Health");
    expect(
      await screen.findByText(
        /0\.0\.0 is a development or pre-release build/u,
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("The latest release is version 1.4.2.")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    r.unmount();

    handlers({
      "GET /api/v1/ops/update": () => [
        200,
        { status: "disabled", reason: "opted_out", currentVersion: "1.4.2" },
      ],
    });
    r = await open("/admin/health", "Health");
    expect(
      await screen.findByText(/Update checks are turned off/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    r.unmount();

    handlers({
      "GET /api/v1/ops/update": () => [
        200,
        { status: "error", currentVersion: "1.4.2", checkedAt: "2026-09-23T10:00:00.000Z" },
      ],
    });
    r = await open("/admin/health", "Health");
    expect(
      await screen.findByText(/release list could not be reached/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 30_000);

  it("is not shown on a multi-tenant host", async () => {
    handlers({
      "GET /api/v1/ops/health": () => [200, opsHealth({ scope: "workspace", checks: [] })],
      "GET /api/v1/ops/update": () => [
        200,
        { status: "disabled", reason: "multi_tenant", currentVersion: "1.4.2" },
      ],
    });
    const r = await open("/admin/health", "Health");
    expect(await screen.findByText("Checked by the server operator")).toBeInTheDocument();
    expect(screen.queryByText("Updates")).toBeNull();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
