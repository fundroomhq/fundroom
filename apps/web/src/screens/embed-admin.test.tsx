import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import {
  apiError,
  EMBED_INTEGRITY,
  EMBED_ORIGIN,
  EMBED_PREVIEW_PATTERNS,
  embedHandoffKey,
  embedSettings,
  type Handler,
  installMockApi,
} from "../test/mock-api.js";
import { pathOf, renderApp } from "../test/render.js";

/*
 * `/admin/embed` (E2.2, ADR-0040). What the screen has to get right is not the form — it is the
 * three sentences the API cannot say: which rule refused an origin, what the preview toggle
 * allows *while it is on*, and what accepting a host's word about a visitor's identity trades.
 * The `frame-ancestors` line is on screen for the same reason: it is derived on every read, so
 * showing it is the only way an admin can tell what the browser is actually being sent.
 */
afterEach(() => vi.unstubAllGlobals());

vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f02";

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

const staffBootstrap = (permissions = ["embed.read", "embed.manage"], role = "owner") =>
  bootstrap({ modules: [], permissions, membership: { id: OWNER_ID, kind: "staff", role } });

function handlers(
  over: Record<string, Handler> = {},
  permissions?: string[],
  role?: string,
): ReturnType<typeof installMockApi> {
  return installMockApi({
    "GET /api/v1/me": () => [200, staffMe()],
    "GET /api/v1/modules": () => [200, staffBootstrap(permissions, role)],
    "GET /api/v1/embed/settings": () => [200, embedSettings()],
    ...over,
  });
}

async function openEmbed(): Promise<Awaited<ReturnType<typeof renderApp>>> {
  const r = await renderApp("/admin/embed");
  expect(
    await screen.findByRole("heading", { name: "Embed", level: 1 }, { timeout: 5000 }),
  ).toBeInTheDocument();
  return r;
}

/** jsdom has no clipboard at all, so `CopyButton` needs one before it can be clicked. */
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  return writeText;
}

describe("embed admin", () => {
  it("shows the empty allow-list, the header it produces and both snippets", async () => {
    handlers();
    const r = await openEmbed();
    expect(
      await screen.findByText(/No site can frame this portal yet/u, {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    // The unconfigured workspace resolves to `'self'`, not `'none'` (ADR-0040 decision 3).
    expect(screen.getByText("Content-Security-Policy: frame-ancestors 'self'")).toBeInTheDocument();

    // The loader snippet names the loader URL and the workspace, read back off `embedUrl`.
    const loader = screen.getByText(new RegExp(`${EMBED_ORIGIN}/embed/v1/embed\\.js`, "u"));
    expect(loader).toHaveTextContent('workspace: "acme"');
    expect(loader).toHaveTextContent(`baseUrl: "${EMBED_ORIGIN}"`);
    // SRI belongs to the pinned URL, never to the rolling one.
    const pinned = screen.getByText(new RegExp(EMBED_INTEGRITY, "u"));
    expect(pinned).toHaveTextContent(`${EMBED_ORIGIN}/embed/0.1.0/embed.js`);
    expect(loader).not.toHaveTextContent(EMBED_INTEGRITY);
    // The raw-iframe snippet keeps the referrer: it is the only initiator signal there is.
    expect(screen.getByText(/referrerpolicy="strict-origin-when-cross-origin"/u)).toHaveTextContent(
      `src="${EMBED_ORIGIN}/embed/acme"`,
    );
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    const writeText = stubClipboard();
    await user.click(screen.getAllByRole("button", { name: "Copy" })[0] as HTMLElement);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls[0]?.[0])).toContain("SeedHost.init");
  }, 20_000);

  it("adds an exact origin and refuses a wildcard by name", async () => {
    let current = embedSettings();
    const { calls } = handlers({
      "GET /api/v1/embed/settings": () => [200, current],
      "PUT /api/v1/embed/settings": ({ body }) => {
        const patch = body as { origins?: string[] };
        current = embedSettings({ origins: patch.origins ?? [] });
        return [200, current];
      },
    });
    const r = await openEmbed();
    const user = userEvent.setup();
    const field = await screen.findByLabelText("Origin", {}, { timeout: 5000 });

    // Refused before the network: the wildcard gets its own sentence, not "invalid origin".
    await user.type(field, "https://*.acme.com");
    await user.click(screen.getByRole("button", { name: "Add origin" }));
    expect(await screen.findByText(/Wildcards are not accepted/u)).toBeVisible();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    await expectNoA11yViolations(r.container);

    // A page URL is refused rather than trimmed down to its origin.
    await user.clear(field);
    await user.type(field, "https://acme.com/investors");
    await user.click(screen.getByRole("button", { name: "Add origin" }));
    expect(await screen.findByText(/That is a page address/u)).toBeVisible();

    await user.clear(field);
    await user.type(field, "http://acme.com");
    await user.click(screen.getByRole("button", { name: "Add origin" }));
    expect(await screen.findByText(/Only https:\/\/ is accepted/u)).toBeVisible();

    await user.clear(field);
    await user.type(field, "https://acme.com");
    await user.click(screen.getByRole("button", { name: "Add origin" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        origins: ["https://acme.com"],
      }),
    );
    // The derived header line moves with the list, because the response carries both.
    expect(
      await screen.findByText("Content-Security-Policy: frame-ancestors 'self' https://acme.com"),
    ).toBeInTheDocument();
  }, 30_000);

  it("names every builder pattern from the response while the toggle is on", async () => {
    handlers({
      "GET /api/v1/embed/settings": () => [
        200,
        embedSettings({ origins: ["https://acme.com"], allowPreviewOrigins: true }),
      ],
    });
    const r = await openEmbed();
    // The warning says what it costs — any site on those domains, not only this customer's.
    expect(
      await screen.findByText(
        /any of them can put your portal in a page of their own/u,
        {},
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    // Rendered from `previewOriginPatterns`, so a curated list that grows shows up here.
    for (const pattern of EMBED_PREVIEW_PATTERNS) {
      expect(screen.getByText(pattern)).toBeInTheDocument();
    }
    expect(screen.getByRole("switch", { name: "Allow builder preview domains" })).toBeChecked();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("registers a handoff key and refuses one that is not an Ed25519 public key", async () => {
    let current = embedSettings({ origins: ["https://acme.com"], trustHostIdentity: true });
    const { calls } = handlers({
      "GET /api/v1/embed/settings": () => [200, current],
      "PUT /api/v1/embed/settings": ({ body }) => {
        const patch = body as { handoffKeys?: { id: string; publicKey: string; label: string }[] };
        current = embedSettings({
          origins: ["https://acme.com"],
          trustHostIdentity: true,
          handoffKeys: (patch.handoffKeys ?? []).map((k) =>
            embedHandoffKey({ id: k.id, publicKey: k.publicKey, label: k.label }),
          ),
        });
        return [200, current];
      },
    });
    const r = await openEmbed();
    // The trade, spelled out rather than implied by the word "trusted".
    expect(
      await screen.findByText(
        /sign in here as any investor you have already invited/u,
        {},
        {
          timeout: 5000,
        },
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/No key registered/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Key ID"), "acme-wp-1");
    await user.type(screen.getByLabelText("Public key"), "not-a-key");
    await user.click(screen.getByRole("button", { name: "Add key" }));
    expect(await screen.findByText(/not an Ed25519 public key/u)).toBeVisible();
    expect(calls.some((c) => c.method === "PUT")).toBe(false);

    await user.clear(screen.getByLabelText("Public key"));
    await user.type(screen.getByLabelText("Public key"), "A".repeat(43));
    await user.type(screen.getByLabelText("Label"), "acme.com WordPress");
    await user.click(screen.getByRole("button", { name: "Add key" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
        handoffKeys: [{ id: "acme-wp-1", publicKey: "A".repeat(43), label: "acme.com WordPress" }],
      }),
    );
    const table = await screen.findByRole("table");
    expect(table).toHaveTextContent("acme-wp-1");
    // The key id is in the button's accessible name too, so four "Remove key" buttons would
    // still be four different controls (WCAG 2.2 AA 2.4.6).
    expect(within(table).getByRole("button", { name: "Remove key acme-wp-1" })).toBeInTheDocument();
  }, 30_000);

  it("sends a stale admin to step-up rather than telling them they are forbidden", async () => {
    handlers({
      "PUT /api/v1/embed/settings": () => apiError(403, "step_up_required", { reason: "fresh" }),
    });
    const r = await openEmbed();
    const user = userEvent.setup();
    await user.type(
      await screen.findByLabelText("Origin", {}, { timeout: 5000 }),
      "https://acme.com",
    );
    await user.click(screen.getByRole("button", { name: "Add origin" }));
    await waitFor(() => expect(pathOf(r.router)).toContain("/auth/step-up"));
    expect(pathOf(r.router)).toContain("reason=fresh");
  }, 20_000);

  it("offers a member with only embed.read nothing to change", async () => {
    handlers({}, ["embed.read"], "member");
    const r = await openEmbed();
    expect(await screen.findByLabelText("Origin", {}, { timeout: 5000 })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add origin" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add key" })).toBeNull();
    expect(screen.getByRole("switch", { name: "Allow builder preview domains" })).toBeDisabled();
    // Read-only, not hidden: the snippets and the header line are still there to read.
    expect(screen.getByText("Content-Security-Policy: frame-ancestors 'self'")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);
});
