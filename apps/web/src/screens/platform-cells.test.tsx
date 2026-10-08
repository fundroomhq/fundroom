import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import {
  cell,
  MOVE_ID,
  move,
  platformApi,
  platformConfig,
  platformWorkspace,
  platformWorkspaceDetail,
  WS_ID,
} from "../test/fixtures-platform.js";
import { apiError } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * E3.11 in the operator console: the Cells page (local and remote cells), the workspace page's
 * cell select (local cells only — a remote one is a move), and the "Move to another cell" card:
 * the identity-loss warning, the typed-slug confirmation, progress by state, cancel, and one
 * sentence per failure.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const HEARTBEAT = new Date(Date.now() - 3 * 60_000).toISOString();

const LOCAL = cell();
const LOCAL_2 = cell({ id: "eu-2", workspaces: 0 });
const REMOTE = cell({
  id: "us-1",
  region: "us-east",
  regionLabel: "United States (Virginia)",
  jurisdiction: "us",
  publicOrigin: "https://us.fundroom.test",
  local: false,
  heartbeatAt: HEARTBEAT,
  workspaces: null,
  createdAt: null,
});
const REMOTE_DRAINING = cell({
  id: "ca-1",
  region: "ca-central",
  regionLabel: "Canada",
  jurisdiction: "ca",
  publicOrigin: "https://ca.fundroom.test",
  status: "draining",
  local: false,
  heartbeatAt: HEARTBEAT,
  workspaces: null,
  createdAt: null,
});
const CELLS = { cells: [LOCAL, LOCAL_2, REMOTE, REMOTE_DRAINING] };

async function openWorkspace() {
  const r = await renderApp(`/platform/workspaces/${WS_ID}`, platformConfig());
  await screen.findByRole("heading", { name: "Acme Ventures", level: 1 }, { timeout: 5000 });
  return r;
}

function moveCard(): HTMLElement {
  const title = screen.getByText("Move to another cell", { selector: "[data-slot=card-title]" });
  return title.closest("[data-slot=card]") as HTMLElement;
}

describe("cells page", () => {
  it("lists local and remote cells with region, jurisdiction, origin, heartbeat and counts", async () => {
    platformApi({ "GET /api/v1/platform/cells": () => [200, CELLS] });
    const r = await renderApp("/platform/cells", platformConfig());
    expect(
      await screen.findByRole("heading", { name: "Cells", level: 1 }, { timeout: 5000 }),
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Operator console" });
    expect(within(nav).getByRole("link", { name: "Cells" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    const table = await screen.findByRole("table", {}, { timeout: 5000 });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);
    const local = rows[0] as HTMLElement;
    expect(local).toHaveTextContent("default");
    expect(local).toHaveTextContent("This install");
    expect(local).toHaveTextContent("This database");
    expect(local).toHaveTextContent("Not declared");
    expect(local).toHaveTextContent("2");
    const remote = rows[2] as HTMLElement;
    expect(remote).toHaveTextContent("United States (Virginia)");
    expect(remote).toHaveTextContent("United States");
    expect(remote).toHaveTextContent("https://us.fundroom.test");
    expect(remote).toHaveTextContent("Another deployment");
    expect(remote).toHaveTextContent("3 minutes ago");
    // A remote cell's workspace count is not this install's to know.
    expect(within(remote).getAllByRole("cell").at(-1)).toHaveTextContent("—");
    expect(rows[3]).toHaveTextContent("Draining");
    await expectNoA11yViolations(r.container);
  }, 20_000);
});

describe("workspace cell select", () => {
  it("offers only cells in this database; a remote PATCH refusal points at the move", async () => {
    const { calls } = platformApi({
      "GET /api/v1/platform/cells": () => [200, CELLS],
      "PATCH /api/v1/platform/workspaces/{id}": () =>
        apiError(409, "move_unavailable", { details: { reason: "use_move" } }),
    });
    await openWorkspace();
    const select = await screen.findByRole("combobox", { name: "Cell" });
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.getAttribute("value")),
      ).toEqual(["default", "eu-2"]),
    );
    expect(
      screen.getByText(/Only cells in this database are listed: changing between them is instant/u),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.selectOptions(select, "eu-2");
    await user.click(screen.getByRole("button", { name: "Change cell" }));
    expect(
      await screen.findByText(
        "That cell is in another database. Use “Move to another cell” instead.",
      ),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ cellId: "eu-2" });
  }, 20_000);
});

describe("cell change during a move", () => {
  it("says the cell cannot change while a move holds the workspace", async () => {
    platformApi({
      "GET /api/v1/platform/cells": () => [200, CELLS],
      "PATCH /api/v1/platform/workspaces/{id}": () =>
        apiError(409, "conflict", { details: { reason: "relocating" } }),
    });
    await openWorkspace();
    const select = await screen.findByRole("combobox", { name: "Cell" });
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    const user = userEvent.setup();
    await user.selectOptions(select, "eu-2");
    await user.click(screen.getByRole("button", { name: "Change cell" }));
    expect(
      await screen.findByText(/Its cell cannot be changed until the move is done or cancelled/u),
    ).toBeInTheDocument();
  }, 20_000);
});

describe("move to another cell", () => {
  it("warns about what is not carried and asks for the slug before moving", async () => {
    let moves: ReturnType<typeof move>[] = [];
    const { calls } = platformApi({
      "GET /api/v1/platform/cells": () => [200, CELLS],
      "GET /api/v1/platform/moves": ({ url }) => {
        expect(url.searchParams.get("workspaceId")).toBe(WS_ID);
        return [200, { items: moves }];
      },
      "POST /api/v1/platform/workspaces/{id}/move": () => {
        moves = [move({ state: "requested" })];
        return [202, moves[0]];
      },
    });
    const r = await openWorkspace();
    const target = await screen.findByRole("combobox", { name: /Target cell/u }, { timeout: 5000 });
    // Remote and active only: not the local cells, not the draining one.
    expect(
      within(target)
        .getAllByRole("option")
        .map((o) => o.getAttribute("value")),
    ).toEqual(["", "us-1"]);
    const card = moveCard();
    const warning = within(card).getByRole("note");
    expect(warning).toHaveTextContent("What a move does not carry");
    expect(warning).toHaveTextContent("Every member signs in again");
    expect(warning).toHaveTextContent("Passwords, MFA, passkeys and sessions are not carried");
    expect(warning).toHaveTextContent("API keys, webhooks and vendor connections");
    expect(warning).toHaveTextContent(/Custom domains come back as pending/u);
    expect(warning).toHaveTextContent(/SSO and SCIM/u);
    expect(warning).toHaveTextContent(/audit trail is archived/u);
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    const submit = within(card).getByRole("button", { name: "Move workspace" });
    await user.selectOptions(target, "us-1");
    expect(submit).toBeDisabled();
    const confirm = within(card).getByRole("textbox", { name: /Type acme to confirm/u });
    await user.type(confirm, "acm");
    expect(submit).toBeDisabled();
    await user.type(confirm, "e");
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(await within(card).findByRole("status", {}, { timeout: 5000 })).toHaveTextContent(
      "Status: Requested",
    );
    expect(calls.find((c) => c.path.endsWith("/move"))?.body).toEqual({
      targetCellId: "us-1",
      confirmSlug: "acme",
    });
    // The form gives way to the progress while the move runs.
    expect(within(card).queryByRole("button", { name: "Move workspace" })).toBeNull();
  }, 20_000);

  it("shows the progress by state and cancels a running move", async () => {
    let state: "exported" | "cancelled" = "exported";
    const { calls } = platformApi({
      "GET /api/v1/platform/workspaces/{id}": () => [
        200,
        platformWorkspaceDetail({
          status: "suspended",
          suspendedReason: "relocation",
          holds: ["relocation"],
        }),
      ],
      "GET /api/v1/platform/cells": () => [200, CELLS],
      "GET /api/v1/platform/moves": () => [200, { items: [move({ state })] }],
      "POST /api/v1/platform/moves/{id}/cancel": ({ params }) => {
        expect(params["id"]).toBe(MOVE_ID);
        state = "cancelled";
        return [200, move({ state })];
      },
    });
    const r = await openWorkspace();
    // The hold reads as a move, not as a sanctions review, and offers no "lift" button.
    expect(screen.getByText("Reason: moving")).toBeInTheDocument();
    expect(
      screen.getByText("On hold while it moves to another cell. The move lifts the hold itself."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Lift|Release|Unsuspend/u })).toBeNull();

    const progress = await screen.findByRole("list", { name: "Move progress" }, { timeout: 5000 });
    const current = within(progress)
      .getAllByRole("listitem")
      .find((li) => li.getAttribute("aria-current") === "step");
    expect(current).toHaveTextContent("Exported, waiting for the target");
    expect(within(progress).getAllByText("(done)")).toHaveLength(2);
    expect(moveCard()).toHaveTextContent(/Moving to us-1 \(United States \(Virginia\)\)/u);
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(within(moveCard()).getByRole("button", { name: "Cancel move" }));
    const dialog = await screen.findByRole("dialog");
    await expectNoA11yViolations(dialog);
    await user.click(within(dialog).getByRole("button", { name: "Cancel move" }));
    expect(
      await within(moveCard()).findByText(/The last move, to us-1 .* was cancelled/u),
    ).toBeInTheDocument();
    expect(calls.some((c) => c.path === `/api/v1/platform/moves/${MOVE_ID}/cancel`)).toBe(true);
  }, 20_000);

  it("offers no cancel once the target has switched over", async () => {
    platformApi({
      "GET /api/v1/platform/cells": () => [200, CELLS],
      "GET /api/v1/platform/moves": () => [200, { items: [move({ state: "switched" })] }],
    });
    await openWorkspace();
    expect(
      await screen.findByText(/The workspace now lives in us-1/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel move" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move workspace" })).toBeNull();
  }, 20_000);

  it("says why the last move failed, one sentence per code, and offers a new one", async () => {
    platformApi({
      "GET /api/v1/platform/cells": () => [200, CELLS],
      "GET /api/v1/platform/moves": () => [
        200,
        {
          items: [
            move({ state: "failed", error: { stage: "verify", code: "signature_invalid" } }),
            move({
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6402",
              state: "cancelled",
              createdAt: "2026-09-20T09:30:00.000Z",
            }),
          ],
        },
      ],
    });
    const r = await openWorkspace();
    const failed = await screen.findByText(
      "The last move to us-1 (United States (Virginia)) failed",
      {},
      { timeout: 5000 },
    );
    const alert = failed.closest("[data-slot=alert]") as HTMLElement;
    expect(alert).toHaveTextContent(
      "The export's signature did not verify against this cell's published key.",
    );
    expect(alert).toHaveTextContent(
      /the workspace stayed here and its relocation hold was lifted/u,
    );
    expect(within(moveCard()).getByRole("button", { name: "Move workspace" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("has its own sentence for an export that is not the move's", async () => {
    platformApi({
      "GET /api/v1/platform/cells": () => [200, CELLS],
      "GET /api/v1/platform/moves": () => [
        200,
        { items: [move({ state: "failed", error: { stage: "verify", code: "bundle_mismatch" } })] },
      ],
    });
    await openWorkspace();
    expect(
      await screen.findByText(/is not the one this move produced/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    vi.unstubAllGlobals();
    platformApi({
      "GET /api/v1/platform/cells": () => [200, CELLS],
      "GET /api/v1/platform/moves": () => [
        200,
        { items: [move({ state: "failed", error: { stage: "switch", code: "not_held" } })] },
      ],
    });
    await openWorkspace();
    expect(
      await screen.findByText(
        /relocation hold was released during the move/u,
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  }, 20_000);

  it("names an unknown failure code and stage rather than hiding it", async () => {
    platformApi({
      "GET /api/v1/platform/cells": () => [200, CELLS],
      "GET /api/v1/platform/moves": () => [
        200,
        { items: [move({ state: "failed", error: { stage: "import", code: "disk_full" } })] },
      ],
    });
    await openWorkspace();
    expect(
      await screen.findByText(
        "It failed at the “import” stage (disk_full).",
        {},
        { timeout: 5000 },
      ),
    ).toBeInTheDocument();
  }, 20_000);

  it("explains each refusal of a move in its own words", async () => {
    const refusals = [
      apiError(409, "move_busy"),
      apiError(409, "move_unavailable", { details: { reason: "target_stale" } }),
      apiError(400, "validation_failed", { details: { reason: "confirmation_mismatch" } }),
      apiError(409, "move_unavailable", { details: { reason: "no_directory" } }),
      apiError(503, "directory_unavailable"),
      apiError(409, "move_unavailable", { details: { reason: "storage" } }),
      apiError(409, "move_unavailable", { details: { reason: "source_remote" } }),
      apiError(409, "move_unavailable", { details: { reason: "not_in_directory" } }),
      apiError(409, "move_unavailable", { details: { reason: "sanctions_review" } }),
    ];
    const { calls } = platformApi({
      "GET /api/v1/platform/cells": () => [200, CELLS],
      "POST /api/v1/platform/workspaces/{id}/move": () => refusals.shift() as Response,
    });
    await openWorkspace();
    const user = userEvent.setup();
    await user.selectOptions(
      await screen.findByRole("combobox", { name: /Target cell/u }, { timeout: 5000 }),
      "us-1",
    );
    await user.type(screen.getByRole("textbox", { name: /Type acme to confirm/u }), "acme");
    const submit = screen.getByRole("button", { name: "Move workspace" });
    for (const sentence of [
      "A move of this workspace is already in progress.",
      /has not reported in for over 15 minutes/u,
      "The slug you typed does not match this workspace.",
      /Moves need a shared directory/u,
      /The shared directory cannot be reached right now/u,
      /Moves need object storage/u,
      /Start the move from the cell that holds it/u,
      /Run `fundroom directory sync` on this cell/u,
      /first sanctions screening is still pending/u,
    ]) {
      await user.click(submit);
      expect(await screen.findByText(sentence)).toBeInTheDocument();
    }
    expect(calls.filter((c) => c.path.endsWith("/move"))).toHaveLength(9);
  }, 20_000);

  it("says when a move can no longer be cancelled", async () => {
    platformApi({
      "GET /api/v1/platform/cells": () => [200, CELLS],
      "GET /api/v1/platform/moves": () => [200, { items: [move({ state: "importing" })] }],
      "POST /api/v1/platform/moves/{id}/cancel": () =>
        apiError(409, "conflict", { details: { reason: "not_cancellable" } }),
    });
    await openWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Cancel move" }, { timeout: 5000 }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel move" }));
    expect(await within(dialog).findByText(/can no longer be cancelled/u)).toBeInTheDocument();
  }, 20_000);

  it("says a move needs another cell when there is none, and never offers it for a deleted workspace", async () => {
    platformApi();
    await openWorkspace();
    expect(
      await screen.findByText(/No other cell can take this workspace/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move workspace" })).toBeNull();
    vi.unstubAllGlobals();

    platformApi({
      "GET /api/v1/platform/cells": () => [200, CELLS],
      "GET /api/v1/platform/workspaces/{id}": () => [
        200,
        platformWorkspaceDetail({ deletedAt: "2026-09-26T10:00:00.000Z" }),
      ],
    });
    await openWorkspace();
    expect(
      await screen.findByText("A deleted workspace cannot be moved.", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);
});

describe("workspaces list", () => {
  it("shows a moving workspace's relocation hold as a badge", async () => {
    platformApi({
      "GET /api/v1/platform/workspaces": () => [
        200,
        {
          items: [
            platformWorkspace({
              status: "suspended",
              suspendedReason: "relocation",
              holds: ["billing", "relocation"],
            }),
          ],
          nextCursor: null,
        },
      ],
    });
    const r = await renderApp("/platform", platformConfig());
    await screen.findByRole("heading", { name: "Workspaces", level: 1 }, { timeout: 5000 });
    const row = (await screen.findByRole("link", { name: "Acme Ventures" })).closest(
      "tr",
    ) as HTMLElement;
    const badges = within(row)
      .getAllByText(/^Reason: /u)
      .map((b) => b.textContent);
    // Ranked as the server ranks them: relocation above billing.
    expect(badges).toEqual(["Reason: moving", "Reason: billing"]);
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
