import type { FundRoomSchemas } from "@fundroom/sdk";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectNoA11yViolations } from "../test/a11y.js";
import { bootstrap, me, membership, session } from "../test/fixtures.js";
import { installMockApi, json } from "../test/mock-api.js";
import { renderApp } from "../test/render.js";

afterEach(() => vi.unstubAllGlobals());

const ROOT = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01";
const LEGAL = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02";
const CORP = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e03";
const DOC = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e04";
const VER = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e05";
const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c01";
const UPLOAD_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e06";
const NOW = "2026-09-12T10:00:00.000Z";

const granted: FundRoomSchemas["AccessDecision"] = {
  allowed: true,
  capabilities: ["view", "download", "edit"],
  pendingGates: [],
  reason: "granted",
};

function folder(
  id: string,
  parentId: string,
  name: string,
  index: string,
  path: string,
  sortOrder: number,
): FundRoomSchemas["DataRoomTreeFolder"] {
  return {
    id,
    parentId,
    name,
    path,
    index,
    sortOrder,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    purgeAfter: null,
    access: granted,
    passthrough: false,
  };
}

function document(
  over: Partial<FundRoomSchemas["DataRoomDocument"]> = {},
): FundRoomSchemas["DataRoomDocument"] {
  return {
    id: DOC,
    folderId: ROOT,
    title: "Pitch deck",
    index: "3",
    sortOrder: 1,
    protection: { download: false, watermark: true, print: false, forensic: false },
    legalHold: false,
    currentVersionId: VER,
    contentType: "application/pdf",
    sizeBytes: 123_456,
    pageCount: 12,
    renderStatus: "ready",
    scanStatus: "clean",
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    purgeAfter: null,
    ...over,
  };
}

function tree(): FundRoomSchemas["DataRoomTree"] {
  return {
    rootId: ROOT,
    folders: [
      folder(CORP, ROOT, "Corporate", "1", "r.corp", 1),
      folder(LEGAL, ROOT, "Legal", "2", "r.legal", 2),
    ],
    documents: [{ ...document(), access: granted }],
  };
}

function version(): FundRoomSchemas["DataRoomVersion"] {
  return {
    id: VER,
    versionNo: 1,
    fileName: "deck.pdf",
    contentType: "application/pdf",
    sizeBytes: 123_456,
    pageCount: 12,
    renderStatus: "ready",
    renderDetail: null,
    changeNote: null,
    uploadedBy: OWNER_ID,
    createdAt: NOW,
    isCurrent: true,
  };
}

function detail(
  over: Partial<FundRoomSchemas["DataRoomDocumentDetail"]> = {},
): FundRoomSchemas["DataRoomDocumentDetail"] {
  return {
    document: document(),
    folder: { id: ROOT, name: "Data room", path: "r" },
    currentVersion: version(),
    scan: { status: "clean", engine: "clamd", detail: null, scannedAt: NOW },
    versions: [version()],
    access: granted,
    availability: { viewable: true, download: "original", reason: "ready" },
    legalHold: null,
    ...over,
  };
}

const staffBootstrap = (over: Partial<FundRoomSchemas["ModulesBootstrap"]> = {}) =>
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
          "admin.nav": [
            { id: "dr", label: "Data room", to: "/admin/data-room", order: 30, icon: "folder" },
          ],
        },
      },
    ],
    permissions: [
      "data-room.read",
      "data-room.manage",
      "data-room.download",
      "data-room.legal_hold",
      "data-room.settings",
    ],
    membership: { id: OWNER_ID, kind: "staff", role: "owner" },
    ...over,
  });

const staffMe = () =>
  me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role: "owner" }),
  });

describe("data room admin", () => {
  it("lists folders then documents with index numbers and uploads through tus", async () => {
    const user = userEvent.setup();
    let completed = false;
    const mock = installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, staffBootstrap()],
      "GET /api/v1/data-room/tree": () => [200, tree()],
      "POST /api/v1/data-room/uploads": () => [
        201,
        {
          upload: {
            id: UPLOAD_ID,
            status: "pending",
            method: "tus",
            fileName: "memo.pdf",
            size: 9,
            contentType: "application/pdf",
            folderId: ROOT,
            documentId: null,
            versionId: null,
            error: null,
            expiresAt: NOW,
            createdAt: NOW,
          },
          method: "tus",
          multipart: null,
          tus: { path: "/data-room/uploads/tus" },
        },
      ],
      "POST /api/v1/data-room/uploads/tus": () =>
        new Response(null, {
          status: 201,
          headers: { Location: `/api/v1/data-room/uploads/tus/${UPLOAD_ID}` },
        }),
      "PATCH /api/v1/data-room/uploads/tus/{id}": ({ request }) => {
        expect(request.headers.get("upload-offset")).toBe("0");
        return new Response(null, { status: 204, headers: { "Upload-Offset": "9" } });
      },
      "POST /api/v1/data-room/uploads/{id}/complete": () => {
        completed = true;
        return json(200, {
          upload: { id: UPLOAD_ID, status: "completed" },
          document: document({ title: "memo" }),
          version: version(),
          deduplicated: false,
        });
      },
    });
    const r = await renderApp("/admin/data-room");
    expect(await screen.findByRole("link", { name: "Corporate" })).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0]!).getByText("1")).toBeInTheDocument();
    expect(within(rows[0]!).getByRole("link", { name: "Corporate" })).toBeInTheDocument();
    expect(within(rows[2]!).getByText("3")).toBeInTheDocument();
    expect(within(rows[2]!).getByRole("link", { name: "Pitch deck" })).toBeInTheDocument();
    expect(within(rows[2]!).getByText("Ready")).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    const input = screen.getByLabelText("Choose files to upload");
    const file = new File(["%PDF-1.7\n"], "memo.pdf", { type: "application/pdf" });
    await user.upload(input, file);
    await waitFor(() => expect(completed).toBe(true));
    const start = mock.calls.find((c) => c.path === "/api/v1/data-room/uploads");
    expect(start?.body).toMatchObject({ fileName: "memo.pdf", size: 9, folderId: ROOT });
    expect(await screen.findByText("Uploaded")).toBeInTheDocument();
  });

  it("moves items with up/down and creates folders", async () => {
    const user = userEvent.setup();
    const mock = installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, staffBootstrap()],
      "GET /api/v1/data-room/tree": () => [200, tree()],
      "PATCH /api/v1/data-room/folders/{id}": () => [200, tree()],
      "POST /api/v1/data-room/folders": () => [201, tree()],
    });
    await renderApp("/admin/data-room");
    await screen.findByRole("link", { name: "Corporate" });
    await user.click(screen.getByRole("button", { name: "Move Legal up" }));
    await waitFor(() =>
      expect(mock.calls.filter((c) => c.method === "PATCH").map((c) => c.body)).toEqual([
        { sortOrder: 1 },
        { sortOrder: 2 },
      ]),
    );
    await user.click(screen.getByRole("button", { name: "New folder" }));
    await user.type(screen.getByLabelText(/^Name/u), "Financials");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.path === "/api/v1/data-room/folders")?.body).toEqual({
        parentId: ROOT,
        name: "Financials",
      }),
    );
  });

  it("shows a document, toggles protection and sets a legal hold", async () => {
    const user = userEvent.setup();
    let current = detail();
    const mock = installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, staffBootstrap()],
      "GET /api/v1/data-room/tree": () => [200, tree()],
      "GET /api/v1/data-room/documents/{id}": () => [200, current],
      "PATCH /api/v1/data-room/documents/{id}": ({ body }) => {
        current = detail({
          document: document({
            protection: {
              ...current.document.protection,
              ...((body as { protection?: object }).protection ?? {}),
            },
          }),
        });
        return [200, current];
      },
      "PUT /api/v1/data-room/documents/{id}/legal-hold": () => {
        current = detail({
          document: document({ legalHold: true }),
          legalHold: { reason: "Litigation", setBy: OWNER_ID, setAt: NOW },
        });
        return [200, current];
      },
    });
    const r = await renderApp(`/admin/data-room/documents/${DOC}`);
    expect(await screen.findByText(/12 pages/u)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "First page of Pitch deck" })).toHaveAttribute(
      "src",
      `http://localhost/api/v1/data-room/documents/${DOC}/thumbnail`,
    );
    expect(screen.getByRole("link", { name: "Download original" })).toHaveAttribute(
      "href",
      `http://localhost/api/v1/data-room/documents/${DOC}/download?variant=original`,
    );
    expect(screen.getByRole("link", { name: "Open in viewer" })).toHaveAttribute(
      "href",
      `/data-room/documents/${DOC}`,
    );
    expect(screen.getByRole("cell", { name: "deck.pdf" })).toBeInTheDocument();
    await expectNoA11yViolations(r.container);

    await user.click(screen.getByRole("switch", { name: "Investors may download (watermarked)" }));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.method === "PATCH")?.body).toEqual({
        protection: { download: true },
      }),
    );

    await user.click(screen.getByRole("button", { name: "Set legal hold" }));
    await user.type(screen.getByLabelText(/^Reason/u), "Litigation");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(mock.calls.find((c) => c.method === "PUT")?.body).toEqual({
        hold: true,
        reason: "Litigation",
      }),
    );
    expect(await screen.findByText(/Under legal hold since/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear legal hold" })).toBeInTheDocument();
  });

  it("restores from the recycle bin and hides purge for held documents", async () => {
    const user = userEvent.setup();
    const mock = installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, staffBootstrap()],
      "GET /api/v1/data-room/tree": () => [200, tree()],
      "GET /api/v1/data-room/trash": () => [
        200,
        {
          folders: [
            {
              ...folder(LEGAL, ROOT, "Legal", "2", "r.legal", 2),
              deletedAt: NOW,
              purgeAfter: "2026-10-12T10:00:00.000Z",
            },
          ],
          documents: [
            document({ deletedAt: NOW, purgeAfter: "2026-10-12T10:00:00.000Z" }),
            document({
              id: VER,
              title: "Held memo",
              legalHold: true,
              deletedAt: NOW,
              purgeAfter: null,
            }),
          ],
        },
      ],
      "POST /api/v1/data-room/folders/{id}/restore": () => [200, tree()],
    });
    const r = await renderApp("/admin/data-room/trash");
    expect(await screen.findByRole("cell", { name: "Legal" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Held memo forever" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Pitch deck forever" })).toBeEnabled();
    await expectNoA11yViolations(r.container);
    await user.click(screen.getByRole("button", { name: "Restore Legal" }));
    await waitFor(() =>
      expect(mock.calls.some((c) => c.path === `/api/v1/data-room/folders/${LEGAL}/restore`)).toBe(
        true,
      ),
    );
  });

  it("is read-only for a viewer role", async () => {
    installMockApi({
      "GET /api/v1/me": () => [200, staffMe()],
      "GET /api/v1/modules": () => [200, staffBootstrap({ permissions: ["data-room.read"] })],
      "GET /api/v1/data-room/tree": () => [200, tree()],
    });
    await renderApp("/admin/data-room");
    await screen.findByRole("link", { name: "Corporate" });
    expect(screen.queryByRole("button", { name: "Upload files" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });
});
