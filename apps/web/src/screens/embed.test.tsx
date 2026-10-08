import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIALOG_TOP_PROPERTY, dialogTopFor, EMBED_DENSITY } from "../embed/EmbedFrame.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, testConfig } from "../test/fixtures.js";
import { apiError, installMockApi } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.style.removeProperty("--sh-density-base");
  document.documentElement.style.removeProperty(DIALOG_TOP_PROPERTY);
});

/*
 * Enough of `/settings/security` to reach a dialog from inside the frame. It is the screen that
 * puts one in front of an investor today, which is what makes the offset a live defect rather
 * than a hypothetical one.
 */
function securityHandlers() {
  const now = "2026-09-11T09:00:00.000Z";
  return {
    "GET /api/v1/me": () => [200, me()] as [number, unknown],
    "GET /api/v1/modules": () => [200, bootstrap()] as [number, unknown],
    "GET /api/v1/me/sessions": () => [200, { sessions: [] }] as [number, unknown],
    "GET /api/v1/me/devices": () =>
      [
        200,
        {
          devices: [
            {
              id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b03",
              name: "This Mac",
              device: "Chrome on macOS",
              firstSeenAt: now,
              lastSeenAt: now,
              trusted: true,
            },
          ],
        },
      ] as [number, unknown],
    "GET /api/v1/auth/passkeys": () => [200, { passkeys: [] }] as [number, unknown],
    "GET /api/v1/auth/totp": () =>
      [200, { enrolled: false, pending: false, recoveryCodesLeft: 0 }] as [number, unknown],
    "GET /api/v1/auth/password": () => [200, { enabled: false, set: false }] as [number, unknown],
  };
}

/** The class that reads the offset; `packages/ui` owns the default in the same string. */
const DIALOG_TOP_CLASS = "top-[var(--sh-dialog-top,10vmin)]";

const embedConfig = testConfig({
  tree: "embed",
  routerBase: "",
  embedOrigins: ["https://acme.com"],
  canonicalOrigin: "https://investors.acme.test",
});

function fakeCookieJar(accept: boolean) {
  // Emulate a browser jar so the probe result is deterministic regardless of jsdom's policy.
  let store = "";
  const desc = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
  Object.defineProperty(document, "cookie", {
    configurable: true,
    get: () => store,
    set: (v: string) => {
      if (!accept) return;
      const [pair = ""] = v.split(";");
      store = /Max-Age=0/u.test(v) ? "" : pair;
    },
  });
  return () => {
    if (desc) Object.defineProperty(Document.prototype, "cookie", desc);
    Reflect.deleteProperty(document, "cookie");
  };
}

/** One inbound bridge message from the allowed host origin. */
function send(data: unknown): void {
  window.dispatchEvent(new MessageEvent("message", { origin: "https://acme.com", data }));
}

function consentBodies(calls: { method: string; path: string; body: unknown }[]): unknown[] {
  return calls.filter((c) => c.path.endsWith("/compliance/consent")).map((c) => c.body);
}

describe("embed frame", () => {
  it("applies compact density and posts ready to the allowed origin", async () => {
    const restore = fakeCookieJar(true);
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: "https://acme.com/investors",
    });
    const post = vi.fn();
    vi.stubGlobal("parent", { postMessage: post });
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
    });
    const r = await renderApp("/", embedConfig);
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue("--sh-density-base")).toBe(
        EMBED_DENSITY,
      ),
    );
    expect(await screen.findByRole("heading", { name: /Welcome/u })).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ v: 1, type: "ready" }),
      "https://acme.com",
    );
    for (const c of post.mock.calls) expect(c[1]).toBe("https://acme.com");
    await expectNoA11yViolations(r.container);
    restore();
  });

  it("offers to open in a new tab when cookies are blocked", async () => {
    const restore = fakeCookieJar(false);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    installMockApi({ "GET /api/v1/me": () => apiError(401, "unauthenticated") });
    const r = await renderApp("/updates", embedConfig);
    const user = userEvent.setup();
    expect(await screen.findByText(/Cookies are blocked/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: /Open in a new tab/u }));
    // Signed out, the portal layout has already redirected to the login page with `returnTo`,
    // so the new tab opens there and comes back to /updates after sign-in.
    expect(open).toHaveBeenCalledWith(
      "https://investors.acme.test/login?returnTo=%2Fupdates",
      "_blank",
      "noopener",
    );
    restore();
  });

  it("blocks admin inside an embed", async () => {
    const restore = fakeCookieJar(true);
    installMockApi({});
    const r = await renderApp("/admin", embedConfig);
    expect(await screen.findByText(/Admin isn't available inside an embed/u)).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
    restore();
  });

  it("posts open-external over the bridge and keeps window.open for a frame nobody hears", async () => {
    const restore = fakeCookieJar(false);
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const post = vi.fn();
    vi.stubGlobal("parent", { postMessage: post });
    Object.defineProperty(document, "referrer", {
      configurable: true,
      value: "https://acme.com/investors",
    });
    installMockApi({ "GET /api/v1/me": () => apiError(401, "unauthenticated") });
    await renderApp("/updates", embedConfig);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /Open in a new tab/u }));
    // The loader owns the top-level context; a `window.open` from a sandboxed frame is at the
    // mercy of the host page's popup policy, so the message goes first.
    expect(post).toHaveBeenCalledWith(
      {
        v: 1,
        type: "open-external",
        payload: { url: "https://investors.acme.test/login?returnTo=%2Fupdates" },
      },
      "https://acme.com",
    );
    expect(open).not.toHaveBeenCalled();
    restore();
  });

  /*
   * `source: "host_cmp"` is a value `ConsentPutBody` accepts, not only one the column can
   * store: the request union in `packages/contracts/src/compliance.ts` names it alongside
   * `settings` and `gate`. That matters to this test — a body the server would refuse as
   * invalid is swallowed by the frame's own `.catch`, so a mock that accepts anything would
   * have gone on passing while the real consent answer was never recorded.
   */
  it("writes the host CMP's answer, and never turns measurement on over GPC", async () => {
    const restore = fakeCookieJar(true);
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "PUT /api/v1/compliance/consent": () => [200, { ok: true }],
    });
    await renderApp("/", embedConfig);
    expect(await screen.findByRole("heading", { name: /Welcome/u })).toBeInTheDocument();

    send({ v: 1, type: "consent", payload: { analytics: true } });
    await waitFor(() =>
      expect(consentBodies(calls)).toContainEqual({
        purpose: "analytics_engagement",
        granted: true,
        source: "host_cmp",
      }),
    );

    // The rule: a CMP may turn measurement off over any signal and on over none of them.
    send({ v: 1, type: "consent", payload: { analytics: true, gpc: true } });
    await waitFor(() =>
      expect(consentBodies(calls)).toContainEqual({
        purpose: "analytics_engagement",
        granted: false,
        source: "host_cmp",
      }),
    );
    restore();
  });

  it("posts a handoff assertion to the body and stays signed out when it is refused", async () => {
    const restore = fakeCookieJar(true);
    const { calls } = installMockApi({
      "GET /api/v1/me": () => apiError(401, "unauthenticated"),
      "GET /api/v1/modules": () => [200, bootstrap()],
      "POST /api/v1/embed/handoff": () => apiError(401, "invalid_credential"),
    });
    await renderApp("/login", embedConfig);
    const assertion = `${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(86)}`;
    send({ v: 1, type: "handoff", payload: { assertion } });
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith("/embed/handoff"))?.body).toEqual({ assertion }),
    );
    // Never a URL and never storage: the POST body is the only place it goes (ADR-0009).
    for (const c of calls) expect(c.path).not.toContain(assertion.slice(0, 20));
    expect(window.location.search).not.toContain("assertion");
    // A refused assertion is the signed-out state we were already in, not an error screen.
    expect(await screen.findByRole("heading", { name: /Sign in/u })).toBeInTheDocument();
    restore();
  });

  it("signs out on an inbound logout", async () => {
    const restore = fakeCookieJar(true);
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "POST /api/v1/auth/logout": () => [200, { ok: true }],
    });
    await renderApp("/", embedConfig);
    expect(await screen.findByRole("heading", { name: /Welcome/u })).toBeInTheDocument();
    send({ v: 1, type: "logout", payload: {} });
    await waitFor(() => expect(calls.some((c) => c.path.endsWith("/auth/logout"))).toBe(true));
    restore();
  });

  it("ignores a message type this build has never heard of", async () => {
    const restore = fakeCookieJar(true);
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
    });
    const r = await renderApp("/", embedConfig);
    expect(await screen.findByRole("heading", { name: /Welcome/u })).toBeInTheDocument();
    const before = calls.length;
    // A loader newer than this build is the normal state of the world: the snippet lives in a
    // CMS page nobody will edit again (ADR-0040 decision 10).
    send({ v: 1, type: "esign", payload: { documentId: "abc" } });
    send({ v: 2, type: "logout", payload: {} });
    send({ v: 1, type: "consent", payload: { analytics: "yes" } });
    expect(calls.length).toBe(before);
    expect(r.container.textContent).toContain("Welcome");
    restore();
  });

  it("puts a dialog inside the region the host reported", async () => {
    const restore = fakeCookieJar(true);
    installMockApi(securityHandlers());
    const r = await renderApp("/settings/security", embedConfig);
    expect(await screen.findByText("This Mac")).toBeInTheDocument();

    // The reader is 2 500 px down a frame the loader has sized to its content, so the frame
    // itself never scrolled and nothing inside it could have worked this out.
    send({ v: 1, type: "viewport", payload: { top: 2500, height: 600 } });
    await waitFor(() =>
      expect(document.documentElement.style.getPropertyValue(DIALOG_TOP_PROPERTY)).toBe("2548px"),
    );

    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Forget" }));
    const dialog = await screen.findByRole("dialog");
    // The two halves meet: the frame publishes the offset, `packages/ui` reads it from there.
    expect(dialog.className).toContain(DIALOG_TOP_CLASS);
    // Scoped to the dialog while it is open, as `packages/ui`'s own dialog test is: Radix puts
    // `aria-hidden` on the rest of the tree, which jsdom's axe reads as a violation of the tree
    // it is deliberately hiding.
    await expectNoA11yViolations(dialog);
    restore();
  });

  it("leaves the dialog exactly where it was when no loader ever reports a region", async () => {
    const restore = fakeCookieJar(true);
    installMockApi(securityHandlers());
    const r = await renderApp("/settings/security", embedConfig);
    expect(await screen.findByText("This Mac")).toBeInTheDocument();
    // A raw-iframe embed has no loader, so `viewport` never arrives — and a message that is
    // not a measurement is ignored rather than clamped, which is the same outcome.
    send({ v: 1, type: "viewport", payload: { top: -1, height: 600 } });

    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Forget" }));
    const dialog = await screen.findByRole("dialog");
    expect(document.documentElement.style.getPropertyValue(DIALOG_TOP_PROPERTY)).toBe("");
    // Unset, so the `10vmin` in the same class is what applies — the default has to stay right.
    expect(dialog.className).toContain(DIALOG_TOP_CLASS);
    await expectNoA11yViolations(dialog);
    restore();
  });
});

describe("dialogTopFor", () => {
  it("lands inside the reported region, whatever its size", () => {
    // 8 % of 600 is 48, which is close to the 10vmin a top-level window would have given.
    expect(dialogTopFor({ top: 2500, height: 600 })).toBe(2548);
    // Capped, so a very tall visible region does not push the dialog halfway down it.
    expect(dialogTopFor({ top: 0, height: 4000 })).toBe(64);
    // A short region gets a proportionally short inset rather than being pushed off its own
    // bottom edge; the result is inside [top, top + height] in every case.
    for (const region of [
      { top: 0, height: 0 },
      { top: 0, height: 120 },
      { top: 12.5, height: 37.5 },
      { top: 9000, height: 300 },
    ]) {
      const y = dialogTopFor(region);
      expect(y).toBeGreaterThanOrEqual(Math.floor(region.top));
      expect(y).toBeLessThanOrEqual(Math.ceil(region.top + region.height));
    }
  });
});
