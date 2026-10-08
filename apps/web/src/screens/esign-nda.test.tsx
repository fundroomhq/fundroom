import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { topLevelNavigation } from "../components/compliance/esign-ceremony.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me } from "../test/fixtures.js";
import { apiError, type Handler, installMockApi, pendingAcceptance } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * The member's e-signature NDA (E3.5, ADR-0053), from the acceptance interstitial.
 *
 * What a redesign must not quietly break:
 *
 *  - **consent before signature.** The ESIGN disclosure is on screen, the box starts empty, and
 *    "Sign with <vendor>" is unavailable until the member ticks it; the start posts the consent
 *    and the disclosure version, never a pre-ticked value.
 *  - **the signature happens at top level.** Outside a frame the vendor's page replaces ours;
 *    inside a frame nothing is started in the frame at all — a popup on the portal origin is.
 *  - **the status unlocks, not the redirect.** Only `completed` from `GET /esign/nda/status`
 *    refreshes the bootstrap and opens the portal.
 */

// The status poll's backoff is seconds in production; the tests need it to be quick.
vi.mock("../lib/esign-member-queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/esign-member-queries.js")>()),
  ndaPollDelay: () => 40,
}));
vi.mock("../modules/registry.js", () => ({ investorModules: {}, adminModules: {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DOC_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01";
const ENVELOPE_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02";
const SIGNING_URL = "https://app.documenso.test/sign/abc123";

function esignDoc(
  over: Record<string, unknown> = {},
  vendor: { driver: string; displayName: string } | null = {
    driver: "documenso",
    displayName: "Documenso",
  },
): FundRoomSchemas["PendingAcceptance"] {
  return {
    ...pendingAcceptance({
      documentId: DOC_ID,
      slug: "mutual-nda",
      title: "Mutual NDA",
      kind: "nda",
      stamp: "mutual-nda:v1",
      body: "# Mutual NDA\n\nBoth sides keep the other's information confidential.",
    }),
    ceremony: "esign",
    esign: vendor,
    ...over,
  } as FundRoomSchemas["PendingAcceptance"];
}

function envelope(over: Record<string, unknown> = {}): FundRoomSchemas["ESignEnvelope"] {
  return {
    id: ENVELOPE_ID,
    purpose: "nda",
    subject: { module: "compliance", kind: "legal_document", id: DOC_ID },
    status: "sent",
    signerStatus: "pending",
    signerName: "Ada Lovelace",
    signerEmail: "ada@example.com",
    membershipId: null,
    title: "Mutual NDA",
    driver: "documenso",
    sentAt: "2026-09-25T10:00:00.000Z",
    completedAt: null,
    hasSigned: false,
    hasCertificate: false,
    vaultedDocumentId: null,
    errorCode: null,
    createdAt: "2026-09-25T10:00:00.000Z",
    ...over,
  } as FundRoomSchemas["ESignEnvelope"];
}

type NdaStatus = "none" | "open" | "completed" | "superseded" | "failed";

/**
 * A server with one pending e-sign NDA. `status` is read on every poll, so a test moves the
 * envelope along by assigning to it; `completed` also clears the pending list, the way the
 * collect job's acceptance does.
 */
function server(opts: {
  doc?: FundRoomSchemas["PendingAcceptance"];
  signingUrl?: string | null;
  start?: Handler;
  over?: Record<string, Handler>;
}) {
  const state = { status: "none" as NdaStatus };
  const doc = opts.doc ?? esignDoc();
  const pending = () => (state.status === "completed" ? [] : [doc]);
  const api = installMockApi({
    "GET /api/v1/me": () => [200, me()],
    "GET /api/v1/modules": () => [200, bootstrap({ pendingAcceptances: pending() })],
    "GET /api/v1/compliance/gates": () => [200, { pending: pending(), gates: [] }],
    "GET /api/v1/esign/nda/status": () => [
      200,
      { status: state.status, envelopeId: state.status === "none" ? null : ENVELOPE_ID },
    ],
    "POST /api/v1/esign/nda/start":
      opts.start ??
      (() => {
        state.status = "open";
        return [
          200,
          {
            envelope: envelope(),
            signingUrl: opts.signingUrl === undefined ? SIGNING_URL : opts.signingUrl,
          },
        ];
      }),
    ...opts.over,
  });
  return { ...api, state };
}

const signButton = () => screen.findByRole("button", { name: "Sign with Documenso" });
const consentBox = () =>
  screen.getByRole("checkbox", { name: "I agree to use electronic records and signatures." });

describe("e-signature NDA at the acceptance interstitial", () => {
  it("shows the disclosure, starts unticked, and needs consent before signing", async () => {
    const { calls } = server({});
    const navigate = vi.spyOn(topLevelNavigation, "assign").mockImplementation(() => {});
    const r = await renderApp("/");
    expect(await screen.findByRole("heading", { name: "Before you go in" })).toBeInTheDocument();
    expect(screen.getByText(/Both sides keep the other's information/u)).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Consent to use electronic records and signatures" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/same legal effect as a handwritten one/u)).toBeInTheDocument();
    // No click-wrap for an e-sign document: nothing to "agree and continue".
    expect(screen.queryByRole("button", { name: "Agree and continue" })).toBeNull();
    await expectNoA11yViolations(r.container);

    const box = consentBox();
    expect(box).not.toBeChecked();
    const sign = await signButton();
    expect(sign).toBeDisabled();

    const user = userEvent.setup();
    await user.click(box);
    await waitFor(() => expect(sign).toBeEnabled());
    await user.click(sign);

    await waitFor(() =>
      expect(
        calls.find((c) => c.method === "POST" && c.path === "/api/v1/esign/nda/start")?.body,
      ).toEqual({ documentId: DOC_ID, consentToElectronicRecords: true, disclosureVersion: 1 }),
    );
    // Top level, same tab: the vendor's page replaces the portal.
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(SIGNING_URL));
  }, 20_000);

  it("never navigates to a signing URL that is not a web address", async () => {
    server({ signingUrl: "javascript:alert(1)" });
    const navigate = vi.spyOn(topLevelNavigation, "assign").mockImplementation(() => {});
    await renderApp("/");
    const user = userEvent.setup();
    await signButton();
    await user.click(consentBox());
    await user.click(await signButton());
    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  }, 20_000);

  it("says to check email when the vendor has no signing link, then unlocks on completion", async () => {
    const s = server({
      doc: esignDoc({}, { driver: "dropbox-sign", displayName: "Dropbox Sign" }),
      signingUrl: null,
    });
    const navigate = vi.spyOn(topLevelNavigation, "assign").mockImplementation(() => {});
    const r = await renderApp("/");
    const user = userEvent.setup();
    await screen.findByRole("button", { name: "Sign with Dropbox Sign" });
    await user.click(consentBox());
    await user.click(screen.getByRole("button", { name: "Sign with Dropbox Sign" }));

    expect(await screen.findByText("Check your email")).toBeInTheDocument();
    expect(screen.getByText(/Dropbox Sign has emailed you a link/u)).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
    await expectNoA11yViolations(r.container);

    // The member signs in their inbox; the poll notices and the portal opens.
    s.state.status = "completed";
    expect(
      await screen.findByRole("navigation", { name: "Primary" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Before you go in" })).toBeNull();
  }, 20_000);

  it("keeps polling an open envelope after the vendor's redirect and unlocks when it completes", async () => {
    const s = server({});
    s.state.status = "open";
    await renderApp("/sign?documentId=0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01");
    expect(await screen.findByText("Your signature is in progress")).toBeInTheDocument();
    // Resuming is offered, and the consent box is not asked again for an open envelope.
    expect(
      screen.getByRole("button", { name: "Continue signing with Documenso" }),
    ).toBeInTheDocument();
    const polls = () => s.calls.filter((c) => c.path === "/api/v1/esign/nda/status").length;
    const before = polls();
    await waitFor(() => expect(polls()).toBeGreaterThan(before + 1));

    s.state.status = "completed";
    expect(
      await screen.findByRole("navigation", { name: "Primary" }, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);

  it("stops polling when the ceremony unmounts", async () => {
    const s = server({});
    s.state.status = "open";
    const r = await renderApp("/");
    expect(await screen.findByText("Your signature is in progress")).toBeInTheDocument();
    r.unmount();
    const polls = () => s.calls.filter((c) => c.path === "/api/v1/esign/nda/status").length;
    const after = polls();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(polls()).toBe(after);
  }, 20_000);

  it("explains a superseded signature and asks for the current version", async () => {
    const s = server({ doc: esignDoc({ versionNo: 2, stamp: "mutual-nda:v2" }) });
    s.state.status = "superseded";
    const r = await renderApp("/");
    expect(
      await screen.findByText("A newer version needs your signature", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.getByText(/covers an earlier version/u)).toBeInTheDocument();
    // The ceremony is offered again, from the top: consent unticked.
    expect(consentBox()).not.toBeChecked();
    expect(await signButton()).toBeDisabled();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it.each([
    [422, "esign_consent_required", "Your consent is needed first", /Tick the box/u],
    [
      409,
      "esign_not_configured",
      "Electronic signing is not available right now",
      /not connected at the moment/u,
    ],
    [502, "esign_provider_error", "The signing service did not respond", /Documenso could not/u],
    [
      409,
      "nda_version_superseded",
      "A newer version needs your signature",
      /covers an earlier version/u,
    ],
  ])(
    "explains a %i %s in words",
    async (status, code, title, body) => {
      server({ start: () => apiError(status, code) });
      const navigate = vi.spyOn(topLevelNavigation, "assign").mockImplementation(() => {});
      await renderApp("/");
      const user = userEvent.setup();
      await signButton();
      await user.click(consentBox());
      await user.click(await signButton());
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(title);
      expect(alert).toHaveTextContent(body);
      expect(navigate).not.toHaveBeenCalled();
    },
    20_000,
  );

  it.each([
    [
      409,
      "conflict",
      { reason: "envelope_creating" },
      "Your signing request is still being prepared",
      /perhaps in another tab/u,
    ],
    [
      429,
      "rate_limited",
      { reason: "nda_start_budget", retryAfterSeconds: 3600 },
      "Too many signing requests today",
      /Try again tomorrow/u,
    ],
    [
      422,
      "esign_nda_text_unsupported",
      { reason: "unsupported_characters", field: "body", characters: ["Ж"] },
      "This agreement cannot be signed electronically yet",
      /contact the workspace/u,
    ],
    [
      409,
      "conflict",
      { reason: "not_pending" },
      "Nothing to sign here any more",
      /no longer waiting for your signature/u,
    ],
  ])(
    "explains a %i %s (%o) from the start in words",
    async (status, code, extra, title, body) => {
      server({ start: () => apiError(status, code, extra) });
      const navigate = vi.spyOn(topLevelNavigation, "assign").mockImplementation(() => {});
      const r = await renderApp("/");
      const user = userEvent.setup();
      await signButton();
      await user.click(consentBox());
      await user.click(await signButton());
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(title);
      expect(alert).toHaveTextContent(body);
      expect(navigate).not.toHaveBeenCalled();
      await expectNoA11yViolations(r.container);
    },
    20_000,
  );

  it("picks up the envelope another tab is still creating", async () => {
    const s = server({
      start: () => {
        // The other tab's start lands meanwhile: the status turns open.
        s.state.status = "open";
        return apiError(409, "conflict", { reason: "envelope_creating" });
      },
    });
    vi.spyOn(topLevelNavigation, "assign").mockImplementation(() => {});
    await renderApp("/");
    const user = userEvent.setup();
    await signButton();
    await user.click(consentBox());
    await user.click(await signButton());
    expect(await screen.findByText("Your signature is in progress")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Continue signing with Documenso" }),
    ).toBeInTheDocument();
  }, 20_000);

  it("refreshes the gate when the document is no longer owed", async () => {
    let owed = true;
    const s = server({
      start: () => {
        owed = false;
        return apiError(409, "conflict", { reason: "not_pending" });
      },
      over: {
        "GET /api/v1/modules": () => [
          200,
          bootstrap({ pendingAcceptances: owed ? [esignDoc()] : [] }),
        ],
      },
    });
    await renderApp("/");
    const user = userEvent.setup();
    await signButton();
    await user.click(consentBox());
    await user.click(await signButton());
    expect(
      await screen.findByRole("navigation", { name: "Primary" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(s.calls.filter((c) => c.path === "/api/v1/modules").length).toBeGreaterThan(1);
  }, 20_000);

  it("asks again, and says why, when the signed copy could not be collected", async () => {
    const s = server({});
    s.state.status = "failed";
    const navigate = vi.spyOn(topLevelNavigation, "assign").mockImplementation(() => {});
    const r = await renderApp("/");
    expect(await screen.findByText("Please sign again", {}, { timeout: 5000 })).toBeVisible();
    expect(screen.getByText(/signed copy could not be collected/u)).toBeVisible();
    expect(consentBox()).not.toBeChecked();
    await expectNoA11yViolations(r.container);
    const user = userEvent.setup();
    await user.click(consentBox());
    await user.click(await signButton());
    // A fresh start is allowed and supersedes the failed one.
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(SIGNING_URL));
  }, 20_000);

  it.each([
    ["declined", "You declined to sign", /declined the last signing request on Documenso/u],
    ["voided", "Your last signing request was cancelled", /workspace cancelled/u],
    ["expired", "Your last signing request expired", /expired before it was signed/u],
    ["error", "Your last signing request did not go through", /Something went wrong/u],
  ])(
    "explains a previous %s envelope before asking again",
    async (status, title, body) => {
      const { calls } = server({
        over: {
          "GET /api/v1/esign/me/envelopes": () => [
            200,
            {
              items: [
                envelope({ status, signerStatus: status === "declined" ? "declined" : null }),
                // An older one for the same document does not outrank the newest.
                envelope({ id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e09", status: "completed" }),
              ],
              nextCursor: null,
            },
          ],
        },
      });
      const r = await renderApp("/");
      expect(await screen.findByText(title, {}, { timeout: 5000 })).toBeVisible();
      expect(screen.getByText(body)).toBeVisible();
      expect(consentBox()).not.toBeChecked();
      expect(
        calls.find((c) => c.path === "/api/v1/esign/me/envelopes" && c.method === "GET"),
      ).toBeDefined();
      await expectNoA11yViolations(r.container);
    },
    20_000,
  );

  it("says nothing about history when the last envelope is another document's", async () => {
    const { calls } = server({
      over: {
        "GET /api/v1/esign/me/envelopes": () => [
          200,
          {
            items: [
              envelope({
                status: "declined",
                subject: {
                  module: "compliance",
                  kind: "legal_document",
                  id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5eff",
                },
              }),
            ],
            nextCursor: null,
          },
        ],
      },
    });
    await renderApp("/");
    await signButton();
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/v1/esign/me/envelopes")).toBe(true),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("You declined to sign")).toBeNull();
  }, 20_000);

  it("says signing is unavailable when the workspace's vendor connection is gone", async () => {
    const { calls } = server({ doc: esignDoc({}, null) });
    const r = await renderApp("/");
    expect(
      await screen.findByText("Electronic signing is not available right now"),
    ).toBeInTheDocument();
    await userEvent.setup().click(consentBox());
    expect(
      screen.getByRole("button", { name: "Sign with our e-signature service" }),
    ).toBeDisabled();
    expect(calls.some((c) => c.path === "/api/v1/esign/nda/start")).toBe(false);
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("refreshes to the e-sign ceremony when a click-wrap is refused with esign_required", async () => {
    let doc = pendingAcceptance({
      documentId: DOC_ID,
      title: "Mutual NDA",
      kind: "nda",
      slug: "mutual-nda",
      stamp: "mutual-nda:v1",
    });
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap({ pendingAcceptances: [doc] })],
      "GET /api/v1/esign/nda/status": () => [200, { status: "none", envelopeId: null }],
      "POST /api/v1/compliance/acceptances": () => {
        doc = esignDoc();
        return apiError(409, "esign_required");
      },
    });
    await renderApp("/");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("checkbox", { name: "I have read and agree to Mutual NDA." }),
    );
    await user.click(screen.getByRole("button", { name: "Agree and continue" }));
    // The refreshed bootstrap carries the new ceremony: the click-wrap card gives way to it.
    expect(await signButton()).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Agree and continue" })).toBeNull();
  }, 20_000);
});

describe("e-signature NDA inside an embed frame", () => {
  function frame() {
    // `window.top !== window.self`: the portal is someone else's iframe.
    vi.stubGlobal("self", {});
  }

  it("opens a top-level popup on the portal origin and never starts the signature in the frame", async () => {
    frame();
    const s = server({});
    const popup = { closed: false, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
    const navigate = vi.spyOn(topLevelNavigation, "assign").mockImplementation(() => {});
    const r = await renderApp("/");

    const button = await screen.findByRole("button", {
      name: "Sign with Documenso in a new window",
    });
    // Consent is given where the signature starts — in the popup — so the frame asks for none.
    expect(screen.queryByRole("checkbox")).toBeNull();
    await expectNoA11yViolations(r.container);

    const user = userEvent.setup();
    await user.click(button);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toBe(`https://investors.acme.test/sign?documentId=${DOC_ID}`);
    expect(await screen.findByText("Continue in the new window")).toBeInTheDocument();
    expect(s.calls.some((c) => c.path === "/api/v1/esign/nda/start")).toBe(false);
    expect(navigate).not.toHaveBeenCalled();

    // The member signs in the popup; the frame's poll sees it and the portal opens here too.
    s.state.status = "completed";
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://investors.acme.test",
        data: { v: 1, type: "auth", payload: { state: "esign_completed" } },
      }),
    );
    expect(
      await screen.findByRole("navigation", { name: "Primary" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(popup.close).toHaveBeenCalled();
  }, 20_000);

  it("switches to the popup when the server refuses the start from a frame", async () => {
    server({ start: () => apiError(403, "forbidden", { reason: "embed_frame" }) });
    const open = vi.spyOn(window, "open").mockReturnValue({ closed: false } as unknown as Window);
    await renderApp("/");
    const user = userEvent.setup();
    await signButton();
    await user.click(consentBox());
    await user.click(await signButton());
    const button = await screen.findByRole("button", {
      name: "Sign with Documenso in a new window",
    });
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(button);
    expect(open.mock.calls[0]?.[0]).toBe(`https://investors.acme.test/sign?documentId=${DOC_ID}`);
  }, 20_000);

  it("offers a new tab when the popup is blocked", async () => {
    frame();
    server({});
    vi.spyOn(window, "open").mockReturnValue(null);
    await renderApp("/");
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: "Sign with Documenso in a new window" }),
    );
    expect(await screen.findByText("Your browser blocked the new window")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open in a new tab" })).toBeInTheDocument();
  }, 20_000);
});

describe("/sign", () => {
  it("says there is nothing to sign once the gate is open and the NDA is signed", async () => {
    const s = server({});
    s.state.status = "completed";
    const r = await renderApp(`/sign?documentId=${DOC_ID}`);
    expect(await screen.findByText("All signed", {}, { timeout: 5000 })).toBeInTheDocument();
    // A link inside body text keeps a persistent underline (real-browser axe link-in-text-block).
    expect(screen.getByRole("link", { name: "Go to the portal" })).toHaveClass("underline");
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows an empty state without a document", async () => {
    server({}).state.status = "completed";
    await renderApp("/sign");
    expect(
      await screen.findByText("Nothing waiting for your signature", {}, { timeout: 5000 }),
    ).toBeInTheDocument();
  }, 20_000);
});

describe("signed documents in settings", () => {
  it("lists the member's envelopes with a download for signed ones", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/esign/me/envelopes": () => [
        200,
        {
          items: [
            envelope({
              status: "completed",
              completedAt: "2026-09-25T11:00:00.000Z",
              hasSigned: true,
            }),
            envelope({ id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e03", title: "Side letter" }),
          ],
          nextCursor: null,
        },
      ],
    });
    const r = await renderApp("/settings");
    expect(await screen.findByText("Signed documents", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Download signed copy of Mutual NDA" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Download signed copy of Side letter" }),
    ).toBeNull();
    expect(screen.getByText("Awaiting signature")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);
  }, 20_000);

  it("shows nothing when the member has signed nothing", async () => {
    const { calls } = installMockApi({
      "GET /api/v1/me": () => [200, me()],
      "GET /api/v1/modules": () => [200, bootstrap()],
      "GET /api/v1/esign/me/envelopes": () => [200, { items: [], nextCursor: null }],
    });
    await renderApp("/settings");
    expect((await screen.findAllByText("Profile", {}, { timeout: 5000 })).length).toBeGreaterThan(
      0,
    );
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/v1/esign/me/envelopes")).toBe(true),
    );
    expect(screen.queryByText("Signed documents")).toBeNull();
  }, 20_000);
});
