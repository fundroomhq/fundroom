import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { OWNER } from "../fixtures/stack.js";
import { expectNoAxeViolations } from "../support/axe.js";
import { textPdf } from "../support/pdf.js";
import {
  apiOk,
  BASE_URL,
  passAcceptanceGate,
  requestCode,
  signInWithCode,
  stepUpOwner,
} from "../support/session.js";
import { loadStackState, saveStackState } from "../support/state.js";

/*
 * Real-browser axe on the key pages (E2.8, "axe CI on all key pages"): WCAG 2.2 AA including
 * colour contrast, which the jsdom screen tests cannot see. One test per page, so the report
 * reads as a per-page pass/fail list, and each attaches its axe result. Then the viewer's
 * keyboard map, driven with real key presses.
 *
 * Runs after `00-setup` (the owner, their TOTP secret, the invited investor `ada@example.com`
 * and the draft "October update" all come from there). The seed below adds what the pages
 * need: a two-page PDF in the data room that investors may view (uploaded over tus exactly as
 * the admin UI does), the October update sent, and a second draft to open in the editor.
 *
 * Tagged `@a11y`; the CI `a11y` job runs `--grep "@setup|@a11y"` on every pull request.
 */
const INVESTOR = "ada@example.com";
const PDF_PAGES = ["FundRoom accessibility fixture, page one", "Runway and milestones, page two"];

let staff: BrowserContext;
let staffPage: Page;
let investor: BrowserContext;
let investorPage: Page;
let documentId = "";
let draftId = "";
let sentSlug = "";

/** The page has rendered its content: an h1, the network is quiet, nothing says "Loading…". */
async function settled(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0, { timeout: 15_000 });
}

async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 90_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function seed(): Promise<void> {
  const req = staff.request;
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  // Step-up routes below ride on the owner's UI step-up in `beforeAll` (fresh for 10 minutes;
  // `staff.request` shares the context's cookies). No virus scanner in the CI stack: let the
  // room serve unscanned files.
  await apiOk(req, "PATCH", "/api/v1/data-room/settings", { allowUnscanned: true });

  const tree = await apiOk<{ rootId: string }>(req, "GET", "/api/v1/data-room/tree");
  const pdf = textPdf(PDF_PAGES);
  const start = await apiOk<{
    upload: { id: string; contentType: string };
    method: string;
    tus: { path: string } | null;
  }>(req, "POST", "/api/v1/data-room/uploads", {
    fileName: "a11y-fixture.pdf",
    size: pdf.length,
    contentType: "application/pdf",
    folderId: tree.rootId,
  });
  if (!start.tus)
    throw new Error(`expected a tus upload on the filesystem driver: ${start.method}`);
  const tus = `${BASE_URL}/api/v1${start.tus.path}`;
  const created = await req.fetch(tus, {
    method: "POST",
    headers: {
      origin: BASE_URL,
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(pdf.length),
      "Upload-Metadata": `upload ${b64(start.upload.id)},filename ${b64("a11y-fixture.pdf")},filetype ${b64("application/pdf")}`,
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const patched = await req.fetch(`${tus}/${start.upload.id}`, {
    method: "PATCH",
    headers: {
      origin: BASE_URL,
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": "0",
      "Content-Type": "application/offset+octet-stream",
    },
    data: pdf,
  });
  expect(patched.status(), await patched.text()).toBe(204);
  const done = await apiOk<{ document: { id: string } }>(
    req,
    "POST",
    `/api/v1/data-room/uploads/${start.upload.id}/complete`,
    {},
  );
  documentId = done.document.id;

  // Investors may view it: a role grant on the document. The server derives the rule's path from
  // the resource (none for a document) and refuses a client-supplied one (`resource_path_mismatch`).
  await apiOk(req, "POST", "/api/v1/access/grants", {
    subject: { kind: "role", role: "investor" },
    resource: { kind: "document", id: documentId },
    capabilities: ["view"],
  });

  // Ingest (scan skipped, render) until the viewer can show pages.
  await until("the fixture PDF to become viewable", async () => {
    const d = await apiOk<{
      availability: { viewable: boolean };
      currentVersion: { pageCount: number | null } | null;
    }>(req, "GET", `/api/v1/data-room/documents/${documentId}`);
    return d.availability.viewable && (d.currentVersion?.pageCount ?? 0) > 0 ? true : undefined;
  });

  // Send the October update (the wizard's draft) and open a second draft for the editor.
  const posts = await apiOk<{
    posts: { id: string; slug: string; title: string; state: string }[];
  }>(req, "GET", "/api/v1/updates/posts");
  const october = posts.posts.find((p) => p.title === "October update");
  if (!october) throw new Error(`no October update draft: ${JSON.stringify(posts)}`);
  if (october.state === "draft") {
    await apiOk(req, "POST", `/api/v1/updates/posts/${october.id}/send`, undefined, [202]);
  }
  const draft = await apiOk<{ post: { id: string } }>(req, "POST", "/api/v1/updates/posts", {
    title: "November update",
  });
  draftId = draft.post.id;
  sentSlug = await until("the sent update to reach the investor archive", async () => {
    const archive = await apiOk<{ posts: { slug: string; title: string }[] }>(
      investor.request,
      "GET",
      "/api/v1/updates/archive",
    );
    return archive.posts.find((p) => p.title === "October update")?.slug;
  });
}

/*
 * Not `serial`: one page failing axe must not skip the others — the report is a per-page list.
 * Playwright restarts the worker after a failure and re-runs `beforeAll`, so the seed and both
 * signed-in browser states are stored (support/state.ts) and reused rather than redone.
 */
test.describe("accessibility @a11y", () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    testInfo.setTimeout(240_000);
    const saved = loadStackState()?.a11y;
    if (saved) {
      staff = await browser.newContext({ baseURL: BASE_URL, storageState: saved.staff });
      investor = await browser.newContext({ baseURL: BASE_URL, storageState: saved.investor });
      staffPage = await staff.newPage();
      investorPage = await investor.newPage();
      ({ documentId, draftId, sentSlug } = saved);
      return;
    }
    staff = await browser.newContext({ baseURL: BASE_URL });
    staffPage = await staff.newPage();
    await signInWithCode(staffPage, OWNER.email);
    await stepUpOwner(staffPage, "/admin");

    investor = await browser.newContext({ baseURL: BASE_URL });
    investorPage = await investor.newPage();
    await signInWithCode(investorPage, INVESTOR);
    await passAcceptanceGate(investorPage);

    await seed();
    const state = loadStackState();
    if (state) {
      saveStackState({
        ...state,
        a11y: {
          documentId,
          draftId,
          sentSlug,
          staff: await staff.storageState(),
          investor: await investor.storageState(),
        },
      });
    }
  });

  test.afterAll(async () => {
    await staff?.close();
    await investor?.close();
  });

  // ---- signed out -------------------------------------------------------------------------
  test("axe: /login", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByLabel(/Email address/u)).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("axe: /login/verify", async ({ page }) => {
    await page.goto("/login");
    await requestCode(page, "nobody@example.com");
    await expect(page).toHaveURL(/\/login\/verify/u);
    await expect(page.getByRole("textbox").first()).toBeVisible();
    await expectNoAxeViolations(page);
  });

  test("axe: /accessibility (statement, signed out)", async ({ page }) => {
    await page.goto("/accessibility");
    await settled(page);
    await expectNoAxeViolations(page);
  });

  // ---- investor ---------------------------------------------------------------------------
  test("axe: investor home", async () => {
    await investorPage.goto("/");
    await settled(investorPage);
    await expectNoAxeViolations(investorPage, { name: "investor home" });
  });

  test("axe: data room list", async () => {
    await investorPage.goto("/data-room");
    await settled(investorPage);
    await expect(investorPage.getByRole("link", { name: /a11y-fixture/u })).toBeVisible();
    await expectNoAxeViolations(investorPage);
  });

  test("axe: document viewer", async () => {
    await investorPage.goto(`/data-room/documents/${documentId}`);
    await settled(investorPage);
    await expect(investorPage.getByRole("img", { name: /^Page 1 of/u })).toBeVisible();
    await expectNoAxeViolations(investorPage, { name: "viewer" });
  });

  test("axe: a sent update", async () => {
    await investorPage.goto(`/updates/${sentSlug}`);
    await settled(investorPage);
    await expect(investorPage.getByText("October update").first()).toBeVisible();
    await expectNoAxeViolations(investorPage);
  });

  test("axe: /settings", async () => {
    await investorPage.goto("/settings");
    await settled(investorPage);
    await expectNoAxeViolations(investorPage);
  });

  test("axe: /settings/security", async () => {
    await investorPage.goto("/settings/security");
    await settled(investorPage);
    await expectNoAxeViolations(investorPage);
  });

  test("axe: /search results", async () => {
    await investorPage.goto("/search?q=update");
    await settled(investorPage);
    await expectNoAxeViolations(investorPage, { name: "/search?q=update" });
  });

  // ---- staff ------------------------------------------------------------------------------
  test("axe: admin home", async () => {
    await staffPage.goto("/admin");
    await settled(staffPage);
    await expectNoAxeViolations(staffPage);
  });

  test("axe: admin people", async () => {
    await staffPage.goto("/admin/people");
    await settled(staffPage);
    await expectNoAxeViolations(staffPage);
  });

  test("axe: admin data room", async () => {
    await staffPage.goto("/admin/data-room");
    await settled(staffPage);
    await expectNoAxeViolations(staffPage);
  });

  test("axe: admin updates editor", async () => {
    await staffPage.goto(`/admin/updates/${draftId}`);
    await settled(staffPage);
    await expectNoAxeViolations(staffPage, { name: "/admin/updates/<draft>" });
  });

  test("axe: admin audit", async () => {
    await staffPage.goto("/admin/audit");
    await settled(staffPage);
    await expectNoAxeViolations(staffPage);
  });

  test("axe: admin workspace export", async () => {
    await staffPage.goto("/admin/settings/export");
    await settled(staffPage);
    await expectNoAxeViolations(staffPage);
  });

  // ---- the viewer, by keyboard only ---------------------------------------------------------
  test("viewer: keyboard only — stage paging, zoom, go-to, shortcut help", async () => {
    const page = investorPage;
    await page.goto(`/data-room/documents/${documentId}`);
    await settled(page);
    const stage = page.getByRole("region", { name: /Use the arrow keys/u });
    const counter = page.getByText(/^Page \d+ of 2$/u);
    await expect(counter).toHaveText("Page 1 of 2");

    // Tab reaches the stage (it is in the tab order, not only focusable by script).
    let reached = false;
    for (let i = 0; i < 60 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await stage.evaluate((el) => el === document.activeElement);
    }
    expect(reached, "Tab never reached the pages region").toBe(true);

    await page.keyboard.press("ArrowRight");
    await expect(counter).toHaveText("Page 2 of 2");
    await expect(page.getByRole("img", { name: /^Page 2 of/u })).toBeVisible();
    await page.keyboard.press("Home");
    await expect(counter).toHaveText("Page 1 of 2");

    const zoom = page.getByRole("status").filter({ hasText: /^Zoom:/u });
    await expect(zoom).toHaveText("Zoom: Fit width");
    await page.keyboard.press("+");
    await expect(zoom).toHaveText("Zoom: 150%");
    await page.keyboard.press("0");
    await expect(zoom).toHaveText("Zoom: Fit width");

    // `?` opens the shortcut list; Escape closes it and focus goes back to the stage.
    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    // Let the open animation (fade + zoom) finish: mid-fade, axe measures blended colours.
    await dialog.evaluate((el) =>
      Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)),
    );
    // Scoped to the dialog: Radix hides the page behind a modal with `aria-hidden` (not
    // `inert`), which axe reports as `aria-hidden-focus` on everything behind it.
    await expectNoAxeViolations(page, {
      name: "viewer shortcut dialog",
      include: ['[role="dialog"]'],
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    expect(await stage.evaluate((el) => el === document.activeElement)).toBe(true);

    // Go to a page by number: focus lands on that page's figure.
    const goto = page.getByRole("spinbutton", { name: "Go to page" });
    await goto.fill("7");
    await goto.press("Enter");
    await expect(page.getByText("Enter a page number from 1 to 2.")).toBeVisible();
    await expect(goto).toHaveAttribute("aria-invalid", "true");
    await goto.fill("2");
    await goto.press("Enter");
    await expect(counter).toHaveText("Page 2 of 2");
    expect(
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset["page"]),
    ).toBe("2");

    // The toolbar is one tab stop with arrow-key roving.
    const toolbar = page.getByRole("toolbar", { name: "Viewer controls" });
    await toolbar.getByRole("button", { name: "Previous page" }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(toolbar.getByRole("button", { name: "Next page" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(toolbar.getByRole("button", { name: "Keyboard shortcuts" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(toolbar.getByRole("button", { name: "Keyboard shortcuts" })).toBeFocused();
  });
});
