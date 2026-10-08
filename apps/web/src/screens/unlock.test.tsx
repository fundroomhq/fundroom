import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { topLevelNavigation } from "../components/compliance/esign-ceremony.js";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, MEMBERSHIP_ID, me } from "../test/fixtures.js";
import { type Handler, installMockApi, pendingAcceptance } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

/*
 * The resource-scoped NDA (E2.3, contract S6.3) and the certificate download (§4).
 *
 * The sheet is the only one of the three click-wrap surfaces that must NOT take the portal
 * away: the member may legitimately see everything else, so what is asserted here is as much
 * about what stays on screen as about what the ceremony does.
 */
afterEach(() => vi.unstubAllGlobals());

/*
 * No `vi.mock("../modules/registry.js")` here, unlike the kernel-screen tests: the data room IS
 * a registered module page, and stubbing the registry would leave nothing to render.
 */

const ROOT = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e00";
const OPEN_DOC = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02";
const GATED_DOC = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e03";
const NDA_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a09";
const NOW = "2026-09-12T10:00:00.000Z";

const allowed: FundRoomSchemas["AccessDecision"] = {
  allowed: true,
  capabilities: ["view"],
  pendingGates: [],
  reason: "granted",
};

/** A2: the `nda` gate's detail now carries `documentId`, which is what the sheet needs. */
const gated = (detail: Record<string, string>): FundRoomSchemas["AccessDecision"] => ({
  allowed: false,
  capabilities: ["view"],
  pendingGates: [{ kind: "nda", detail, source: "resource" }],
  reason: "gated",
});

function doc(
  id: string,
  title: string,
  index: string,
  access: FundRoomSchemas["AccessDecision"],
): FundRoomSchemas["DataRoomTreeDocument"] {
  return {
    id,
    folderId: ROOT,
    title,
    index,
    sortOrder: 0,
    protection: { download: false, watermark: true, print: false, forensic: false },
    legalHold: false,
    currentVersionId: null,
    contentType: "application/pdf",
    sizeBytes: 1234,
    pageCount: 3,
    renderStatus: "ready",
    scanStatus: "clean",
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    purgeAfter: null,
    access,
  };
}

const tree = (detail: Record<string, string>): FundRoomSchemas["DataRoomTree"] => ({
  rootId: ROOT,
  folders: [],
  documents: [
    doc(OPEN_DOC, "Pitch deck", "1", allowed),
    doc(GATED_DOC, "Term sheet", "2", gated(detail)),
  ],
});

const enabledBootstrap = () =>
  bootstrap({
    modules: [
      {
        id: "data-room",
        version: "0.1.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "investor.nav": [{ id: "data-room", label: "Data room", to: "/data-room", order: 20 }],
        },
      },
    ],
  });

const nda = () =>
  pendingAcceptance({
    documentId: NDA_ID,
    slug: "mutual-nda",
    title: "Mutual NDA",
    kind: "nda",
    versionNo: 2,
    stamp: "mutual-nda:v2",
    body: "# Mutual NDA\n\nYou agree to keep this confidential.",
  });

function handlers(
  over: Record<string, Handler> = {},
  detail: Record<string, string> = { stamp: "mutual-nda:v2", version: "v2", documentId: NDA_ID },
): ReturnType<typeof installMockApi> {
  return installMockApi({
    "GET /api/v1/me": () => [200, me()],
    "GET /api/v1/modules": () => [200, enabledBootstrap()],
    "GET /api/v1/data-room/tree": () => [200, tree(detail)],
    "GET /api/v1/compliance/gates": () => [200, { pending: [nda()] }],
    ...over,
  });
}

describe("accept to unlock", () => {
  it("signs the gating document from the badge without taking the portal away", async () => {
    const { calls } = handlers({
      "POST /api/v1/compliance/acceptances": () => [
        200,
        { stamp: "mutual-nda:v2", acceptedAt: NOW, recorded: true, pending: [] },
      ],
    });
    const r = await renderApp("/data-room");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Data room" }, { timeout: 5000 });
    // The rest of the room is still there — this is not the all-or-nothing interstitial.
    expect(screen.getByRole("link", { name: /Pitch deck/u })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("button", { name: "Locked — sign to open Term sheet" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Unlock Term sheet" })).toBeInTheDocument();
    expect(within(dialog).getByText(/You agree to keep this confidential/u)).toBeVisible();
    const box = within(dialog).getByRole("checkbox", { name: /agree to Mutual NDA/u });
    expect(box).not.toBeChecked();
    expect(within(dialog).getByRole("button", { name: "Agree and unlock" })).toBeDisabled();
    await expectNoA11yViolations(dialog);

    await user.click(box);
    await user.click(within(dialog).getByRole("button", { name: "Agree and unlock" }));
    expect(await within(dialog).findByText("Unlocked")).toBeInTheDocument();
    // C2: `{documentId, versionNo}` and nothing that claims to be evidence of the bytes.
    const accept = calls.find((c) => c.path === "/api/v1/compliance/acceptances");
    expect(accept?.body).toEqual({ documentId: NDA_ID, versionNo: 2 });

    // The portal survived the ceremony: closing the sheet puts the member back where they were,
    // with everything they were already entitled to still on screen.
    // Two "Close" buttons: the dialog's own dismiss affordance and the sheet's.
    await user.click(within(dialog).getAllByRole("button", { name: "Close" })[1] as HTMLElement);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("link", { name: /Pitch deck/u })).toBeInTheDocument();
  }, 20_000);

  it("fetches the certificate as bytes and never as a bare link", async () => {
    // jsdom implements neither half of the object-URL pair, and `URL` must stay a constructor:
    // the fetch router builds `new URL(request.url)` on every call.
    const created: string[] = [];
    const revoked: string[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (blob: Blob) => {
        created.push(blob.type);
        return "blob:certificate";
      },
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: (url: string) => void revoked.push(url),
    });
    const clicked: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function mocked(
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    const { calls } = handlers({
      "POST /api/v1/compliance/acceptances": () => [
        200,
        { stamp: "mutual-nda:v2", acceptedAt: NOW, recorded: true, pending: [] },
      ],
      "GET /api/v1/compliance/acceptances/{membershipId}/certificate": () =>
        new Response("%PDF-1.7", {
          status: 200,
          headers: { "content-type": "application/pdf" },
        }),
    });
    await renderApp("/data-room");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Data room" }, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Locked — sign to open Term sheet" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: /agree to Mutual NDA/u }));
    await user.click(within(dialog).getByRole("button", { name: "Agree and unlock" }));
    await within(dialog).findByText("Unlocked");

    // Never a plain `<a download href>`: until the button is pressed there is no anchor at all.
    expect(within(dialog).queryByRole("link", { name: /Certificate/u })).toBeNull();
    await user.click(within(dialog).getByRole("button", { name: /Certificate/u }));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(clicked[0]?.download).toBe("certificate-mutual-nda-v2.pdf");
    expect(clicked[0]?.href).toBe("blob:certificate");
    expect(created).toEqual(["application/pdf"]);
    // The object URL is handed back so the blob can be collected.
    await waitFor(() => expect(revoked).toEqual(["blob:certificate"]));
    const fetched = calls.find((c) => c.path.endsWith("/certificate"));
    expect(fetched?.path).toBe(`/api/v1/compliance/acceptances/${MEMBERSHIP_ID}/certificate`);
    click.mockRestore();
    Reflect.deleteProperty(URL, "createObjectURL");
    Reflect.deleteProperty(URL, "revokeObjectURL");
  }, 20_000);

  it("says so honestly when the gating text is not available", async () => {
    // The gate names a document `GET /compliance/gates` does not return — today, every
    // resource-scoped NDA (see the defect note in `unlock-sheet.tsx`).
    const r = handlers({ "GET /api/v1/compliance/gates": () => [200, { pending: [] }] });
    expect(r).toBeDefined();
    await renderApp("/data-room");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Data room" }, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Locked — sign to open Term sheet" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("The text is not available here yet"),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Agree and unlock" })).toBeNull();
    await expectNoA11yViolations(dialog);
  }, 20_000);

  it("shows a non-NDA gate as an explanation, with no ceremony to perform", async () => {
    handlers({}, { maxAgeDays: "365" });
    await renderApp("/data-room");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Data room" }, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Locked — sign to open Term sheet" }));
    const dialog = await screen.findByRole("dialog");
    // A legacy `{version}` NDA gate names no document, so there is nothing to sign here.
    expect(within(dialog).queryByRole("button", { name: "Agree and unlock" })).toBeNull();
    await expectNoA11yViolations(dialog);
  }, 20_000);
});

describe("sign to unlock (E3.5 e-signature NDA)", () => {
  it("runs the e-signature ceremony in the sheet and unlocks when the status completes", async () => {
    let status: "none" | "open" | "completed" = "open";
    const esignNda = {
      ...nda(),
      ceremony: "esign",
      esign: { driver: "docuseal", displayName: "DocuSeal" },
    } as FundRoomSchemas["PendingAcceptance"];
    handlers({
      "GET /api/v1/compliance/gates": () => [
        200,
        { pending: status === "completed" ? [] : [esignNda] },
      ],
      "GET /api/v1/esign/nda/status": () => [200, { status, envelopeId: null }],
    });
    await renderApp("/data-room");
    const user = userEvent.setup();
    await screen.findByRole("heading", { name: "Data room" }, { timeout: 5000 });
    await user.click(screen.getByRole("button", { name: "Locked — sign to open Term sheet" }));
    const dialog = await screen.findByRole("dialog");
    // An envelope is already open (the member came back from DocuSeal): no click-wrap box.
    expect(await within(dialog).findByText("Your signature is in progress")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Agree and unlock" })).toBeNull();
    // The modal hides the page behind it, so the dialog is what is checked.
    await expectNoA11yViolations(dialog);

    status = "completed";
    // The poll runs on the production backoff here, so allow for its first step.
    expect(await within(dialog).findByText("Unlocked", {}, { timeout: 8000 })).toBeInTheDocument();
  }, 20_000);

  it("signs a resource-scoped e-sign NDA from the sheet while the portal stays open (B3)", async () => {
    // The gate names a document that does not gate the whole portal: the bootstrap owes
    // nothing, and GET /compliance/gates lists it as `scope: "resource"`.
    const esignNda = {
      ...nda(),
      ceremony: "esign",
      esign: { driver: "documenso", displayName: "Documenso" },
      scope: "resource",
    } as FundRoomSchemas["PendingAcceptance"];
    const signingUrl = "https://sign.acme.test/s/abc";
    const navigate = vi.spyOn(topLevelNavigation, "assign").mockImplementation(() => {});
    const { calls } = handlers({
      "GET /api/v1/compliance/gates": () => [200, { pending: [esignNda] }],
      "GET /api/v1/esign/nda/status": () => [200, { status: "none", envelopeId: null }],
      "POST /api/v1/esign/nda/start": () => [
        200,
        {
          envelope: {
            id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e0a",
            purpose: "nda",
            subject: { module: "compliance", kind: "legal_document", id: NDA_ID },
            status: "sent",
            signerStatus: "pending",
            signerName: "Ada Lovelace",
            signerEmail: "ada@example.com",
            membershipId: MEMBERSHIP_ID,
            title: "Mutual NDA",
            driver: "documenso",
            sentAt: NOW,
            completedAt: null,
            hasSigned: false,
            hasCertificate: false,
            vaultedDocumentId: null,
            errorCode: null,
            createdAt: NOW,
          },
          signingUrl,
        },
      ],
    });
    try {
      await renderApp("/data-room");
      const user = userEvent.setup();
      await screen.findByRole("heading", { name: "Data room" }, { timeout: 5000 });
      // Not the interstitial: the rest of the room is on screen.
      expect(screen.getByRole("link", { name: /Pitch deck/u })).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Locked — sign to open Term sheet" }));
      const dialog = await screen.findByRole("dialog");
      expect(await within(dialog).findByText(/You agree to keep this confidential/u)).toBeVisible();
      expect(within(dialog).queryByText("The text is not available here yet")).toBeNull();
      const sign = await within(dialog).findByRole("button", { name: "Sign with Documenso" });
      expect(sign).toBeDisabled();
      await expectNoA11yViolations(dialog);
      await user.click(
        within(dialog).getByRole("checkbox", {
          name: "I agree to use electronic records and signatures.",
        }),
      );
      await user.click(sign);
      await waitFor(() => expect(navigate).toHaveBeenCalledWith(signingUrl));
      expect(calls.find((c) => c.path === "/api/v1/esign/nda/start")?.body).toEqual({
        documentId: NDA_ID,
        consentToElectronicRecords: true,
        disclosureVersion: 1,
      });
    } finally {
      navigate.mockRestore();
    }
  }, 20_000);

  it("never stands the interstitial in front of the portal for a resource-scoped document", async () => {
    handlers({
      "GET /api/v1/modules": () => [
        200,
        { ...enabledBootstrap(), pendingAcceptances: [{ ...nda(), scope: "resource" }] },
      ],
    });
    await renderApp("/data-room");
    expect(
      await screen.findByRole("heading", { name: "Data room" }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Before you go in" })).toBeNull();
  }, 20_000);
});
