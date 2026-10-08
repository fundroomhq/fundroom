import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { OWNER } from "../fixtures/stack.js";
import {
  apiOk,
  BASE_URL,
  passAcceptanceGate,
  requestCode,
  signInWithCode,
  stepUpOwner,
} from "../support/session.js";

/*
 * Zero CSP violations in a real browser (E2.10). jsdom enforces no CSP at all, so the only
 * place a third-party `<style>` injected without our nonce shows up is here: the page renders
 * fine and the console says "Refused to apply inline style". E2.2 and E2.4 both recorded "two
 * violations per page load" without anything failing on them; this spec is what fails now.
 *
 * Every page load gets an init script that records each `securitypolicyviolation` event. The
 * enforced policy (`Content-Security-Policy`) must produce none, on every profile the SPA is
 * served under: `app` (sign-in, the investor portal), `admin` (a Dialog with two Selects, a
 * toast, the rich-text editor) and `embed` (`/embed/<slug>` visited top-level, which the embed
 * gate allows — a person opening the "open in a new tab" link). Since E3.2 that enforced policy
 * also carries Trusted Types (`CSP_TRUSTED_TYPES=enforce`, the default), so a first-party
 * `innerHTML` or an unlisted policy name is refused by the browser and shows up here as an
 * enforced violation. Anything report-only (an operator's `CSP_TRUSTED_TYPES=report`) is
 * collected too and must also be empty.
 *
 * Runs after `00-setup` (the owner, their TOTP secret and the invited investor come from
 * there). Tagged `@csp`: `playwright test --project=chromium --grep "@setup|@csp"`.
 */
const INVESTOR = "ada@example.com";

interface Violation {
  readonly page: string;
  readonly directive: string;
  readonly disposition: string;
  readonly blockedURI: string;
  readonly sourceFile: string;
  readonly line: number;
  readonly sample: string;
}

declare global {
  interface Window {
    __cspViolations?: Omit<Violation, "page">[];
  }
}

/** Installed before any page script runs, on every navigation in the context. */
async function watch(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      window.__cspViolations?.push({
        directive: e.effectiveDirective,
        disposition: e.disposition,
        blockedURI: e.blockedURI,
        sourceFile: e.sourceFile,
        line: e.lineNumber,
        sample: e.sample,
      });
    });
  });
}

const seen: Violation[] = [];
const consoleErrors: string[] = [];

/** Drain what the current document recorded (call before navigating away). */
async function drain(page: Page, label: string): Promise<void> {
  // Violation events are dispatched as a task after the refusal; give them a turn.
  await page.waitForTimeout(250);
  const list = await page.evaluate(() => window.__cspViolations?.splice(0) ?? []);
  for (const v of list) seen.push({ page: label, ...v });
}

function listen(page: Page): void {
  page.on("console", (msg) => {
    const text = msg.text();
    if (/Content Security Policy|Trusted Type/iu.test(text)) consoleErrors.push(text);
  });
}

async function settled(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0, { timeout: 15_000 });
}

test.describe
  .serial("content security policy @csp", () => {
    let staff: BrowserContext;
    let investor: BrowserContext;

    test.beforeAll(async ({ browser }) => {
      staff = await browser.newContext({ baseURL: BASE_URL });
      investor = await browser.newContext({ baseURL: BASE_URL });
      await watch(staff);
      await watch(investor);
    });

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires the fixtures argument destructured.
    test.afterAll(async ({}, testInfo) => {
      await staff?.close();
      await investor?.close();
      await testInfo.attach("csp-violations.json", {
        body: JSON.stringify({ violations: seen, console: consoleErrors }, null, 2),
        contentType: "application/json",
      });
      // Printed so a local run shows what the browser refused without opening the report.
      console.log(`CSP violations seen: ${JSON.stringify(seen, null, 2)}`);
    });

    test("sign-in and the one-time-code input (app profile, signed out)", async ({ browser }) => {
      const context = await browser.newContext({ baseURL: BASE_URL });
      await watch(context);
      const page = await context.newPage();
      listen(page);
      await page.goto("/login");
      await expect(page.getByLabel(/Email address/u)).toBeVisible();
      await drain(page, "/login");
      await requestCode(page, "nobody@example.com");
      await expect(page).toHaveURL(/\/login\/verify/u);
      const otp = page.getByRole("textbox").first();
      await expect(otp).toBeVisible();
      await otp.pressSequentially("123");
      await drain(page, "/login/verify");
      await context.close();
    });

    test("investor portal (app profile)", async () => {
      const page = await investor.newPage();
      listen(page);
      await signInWithCode(page, INVESTOR);
      await passAcceptanceGate(page);
      await drain(page, "investor sign-in");
      for (const path of ["/", "/data-room", "/updates", "/settings", "/settings/security"]) {
        await page.goto(path);
        await settled(page);
        await drain(page, path);
      }
    });

    test("admin: dialog, selects and a toast (admin profile)", async () => {
      const page = await staff.newPage();
      listen(page);
      await signInWithCode(page, OWNER.email);
      await stepUpOwner(page, "/admin/people");
      await settled(page);
      await drain(page, "admin sign-in");

      await page.getByRole("button", { name: "Invite people" }).click();
      const dialog = page.getByRole("dialog", { name: "Invite people" });
      await expect(dialog).toBeVisible();
      await dialog.getByLabel("Email addresses").fill(`csp-${Date.now()}@example.com`);
      // Both Radix Selects: each open mounts the Viewport's inline scrollbar-hiding <style>.
      for (const name of ["Type", "Role"]) {
        const trigger = dialog.getByRole("combobox", { name });
        await trigger.click();
        const option = page.getByRole("option").first();
        await expect(option).toBeVisible();
        await option.click();
      }
      await dialog.getByRole("button", { name: "Send invitations" }).click();
      await expect(page.locator("[data-sonner-toast]").first()).toBeVisible();
      await drain(page, "/admin/people invite dialog");
    });

    test("admin: rich-text editor (admin profile)", async () => {
      const page = await staff.newPage();
      listen(page);
      const draft = await apiOk<{ post: { id: string } }>(
        staff.request,
        "POST",
        "/api/v1/updates/posts",
        { title: "CSP draft" },
      );
      await page.goto(`/admin/updates/${draft.post.id}`);
      await settled(page);
      const editor = page.locator(".ProseMirror").first();
      await expect(editor).toBeVisible();
      await editor.click();
      await page.keyboard.type("Quarterly numbers are in.");
      // Copy and paste inside the editor: prosemirror-view's clipboard parser is the one
      // third-party Trusted Types policy we allow (`ProseMirrorClipboard`).
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.press("ControlOrMeta+C");
      await page.keyboard.press("End");
      await page.keyboard.press("ControlOrMeta+V");
      await drain(page, "/admin/updates/<draft> editor");
    });

    /*
     * E3.2 delegates, the two new screens under enforced Trusted Types: the investor's own
     * Settings → Delegates page (a form with native radios, a table, a confirm Dialog, toasts) and
     * the admin People detail card that drives the same component in admin mode. The owner turns
     * `access.allowDelegates` on first (the owner is stepped up by the admin tests above), so the
     * investor sees the add form rather than the "disabled" note. Each page's own document response
     * must carry the enforced Trusted Types directive.
     */
    async function addAndRemoveDelegate(
      page: Page,
      email: string,
      scope: string,
      label: string,
      confirmation: string,
    ): Promise<void> {
      const form = page.getByRole("form", { name: "Add a delegate" });
      await expect(form).toBeVisible();
      await form.getByLabel("Email address").fill(email);
      await form.getByRole("radio", { name: scope }).check();
      await form.getByRole("button", { name: "Invite delegate" }).click();
      await expect(page.getByText(confirmation)).toBeVisible();
      const row = page.getByRole("row").filter({ hasText: email });
      await expect(row).toBeVisible();
      await expect(row).toContainText(scope);
      await drain(page, `${label} add`);
      await row.getByRole("button", { name: /^Remove/u }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(page.getByText(/was removed$/u).first()).toBeVisible();
      await expect(page.getByRole("row").filter({ hasText: email })).toHaveCount(0);
      await drain(page, `${label} remove`);
    }

    function expectEnforcedTrustedTypes(headers: Record<string, string>, label: string): void {
      expect(headers["content-security-policy"] ?? "", label).toMatch(
        /require-trusted-types-for 'script'; trusted-types default ProseMirrorClipboard/u,
      );
      expect(headers["content-security-policy-report-only"], label).toBeUndefined();
    }

    test("delegates: investor Settings → Delegates page (app profile, E3.2)", async () => {
      await apiOk(staff.request, "PATCH", "/api/v1/access/settings", { allowDelegates: true });
      const page = await investor.newPage();
      listen(page);
      const nav = await page.goto("/settings/delegates");
      expectEnforcedTrustedTypes((await nav?.allHeaders()) ?? {}, "/settings/delegates");
      await settled(page);
      await expect(page.getByRole("link", { name: "Delegates" })).toBeVisible();
      await drain(page, "/settings/delegates");
      await addAndRemoveDelegate(
        page,
        `csp-delegate-self-${Date.now()}@example.com`,
        "Data room only",
        "/settings/delegates",
        // Self-service answers every address alike (ADR-0050), so the page cannot say "sent".
        "an invitation is on its way",
      );
      await page.close();
    });

    test("delegates: admin People detail card (admin profile, E3.2)", async () => {
      const people = await apiOk<{ items: { membershipId: string; email: string | null }[] }>(
        staff.request,
        "GET",
        `/api/v1/access/people?q=${encodeURIComponent(INVESTOR)}`,
      );
      const ada = people.items.find((p) => p.email === INVESTOR);
      expect(ada, "the investor from 00-setup is in People").toBeDefined();
      const page = await staff.newPage();
      listen(page);
      const path = `/admin/people/${ada?.membershipId}`;
      const nav = await page.goto(path);
      expectEnforcedTrustedTypes((await nav?.allHeaders()) ?? {}, path);
      await settled(page);
      await drain(page, "/admin/people/<investor>");
      await addAndRemoveDelegate(
        page,
        `csp-delegate-admin-${Date.now()}@example.com`,
        "Updates only",
        "/admin/people/<investor> delegates card",
        "Invitation sent to",
      );
      await page.close();
    });

    test("embed document (embed profile)", async () => {
      const page = await investor.newPage();
      listen(page);
      await page.goto(`/embed/${OWNER.slug}`);
      await page.waitForLoadState("networkidle");
      await drain(page, `/embed/${OWNER.slug}`);
    });

    /*
     * E2.10 P2-04: tenant resolution answers a path naming no workspace before any route runs,
     * and used to answer it before the security headers too — a bare 404 with no CSP, no
     * `nosniff`, no framing rule. Both forms 404 in single mode as well (the slug must be the sole
     * workspace's), so this default stack exercises them. The pages are also loaded in the browser
     * so their own markup is held to the zero-violation rule below.
     */
    for (const [path, profile] of [
      ["/embed/no-such-workspace", "embed"],
      ["/w/no-such-workspace/", "app"],
    ] as const) {
      test(`tenant 404 ${path} carries the ${profile} header profile`, async ({ request }) => {
        const res = await request.get(path, { headers: { accept: "text/html" } });
        expect(res.status()).toBe(404);
        const h = res.headers();
        expect(h["x-content-type-options"]).toBe("nosniff");
        expect(h["cross-origin-resource-policy"]).toBeTruthy();
        expect(h["cache-control"]).toBe("private, no-store");
        const csp = h["content-security-policy"] ?? "";
        expect(csp).toMatch(/default-src /u);
        expect(csp).toMatch(/object-src 'none'/u);
        expect(csp).toMatch(/base-uri /u);
        // No workspace resolved, so nobody may frame the refusal — not even an embed host.
        expect(csp).toMatch(/frame-ancestors 'none'/u);
        // E3.2: Trusted Types are enforced, not report-only.
        expect(csp).toMatch(
          /require-trusted-types-for 'script'; trusted-types default ProseMirrorClipboard/u,
        );
        expect(h["content-security-policy-report-only"]).toBeUndefined();
        if (profile === "embed") {
          expect(h["x-frame-options"]).toBeUndefined();
          expect(h["referrer-policy"]).toBe("no-referrer");
          expect(h["cross-origin-resource-policy"]).toBe("same-site");
          expect(h["cross-origin-opener-policy"]).toBeUndefined();
        } else {
          expect(h["x-frame-options"]).toBe("DENY");
          expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
          expect(h["cross-origin-resource-policy"]).toBe("same-origin");
          expect(h["cross-origin-opener-policy"]).toBe("same-origin");
        }

        const page = await investor.newPage();
        listen(page);
        const nav = await page.goto(path);
        expect(nav?.status()).toBe(404);
        await drain(page, `${path} (tenant 404)`);
        await page.close();
      });
    }

    test("Trusted Types are enforced on every document profile; API responses carry none (E3.2)", async ({
      request,
    }) => {
      for (const path of ["/login", "/admin", `/embed/${OWNER.slug}`]) {
        const res = await request.get(path, { headers: { accept: "text/html" } });
        const h = res.headers();
        expect(h["content-security-policy"] ?? "", path).toMatch(
          /require-trusted-types-for 'script'; trusted-types default ProseMirrorClipboard/u,
        );
        expect(h["content-security-policy-report-only"], path).toBeUndefined();
      }
      const api = await request.get("/api/v1/openapi.json");
      expect(api.headers()["content-security-policy"] ?? "").not.toMatch(/trusted-types/u);
    });

    test("source maps are neither referenced nor served (F-32)", async ({ request }) => {
      const html = await (await request.get("/login", { headers: { accept: "text/html" } })).text();
      const scripts = [...html.matchAll(/src="([^"]*\/assets\/[^"]+\.js)"/gu)].map((m) => m[1]);
      expect(scripts.length).toBeGreaterThan(0);
      for (const src of scripts as string[]) {
        const js = await request.get(src);
        expect(js.status(), src).toBe(200);
        expect(await js.text(), src).not.toMatch(/^\/\/# sourceMappingURL=/mu);
        const map = await request.get(`${src}.map`);
        expect(map.status(), `${src}.map`).toBe(404);
      }
    });

    test("no enforced CSP violations (Trusted Types included), no report-only ones", async () => {
      const enforced = seen.filter((v) => v.disposition === "enforce");
      const reportOnly = seen.filter((v) => v.disposition !== "enforce");
      expect(enforced, "enforced CSP violations (incl. Trusted Types)").toEqual([]);
      expect(reportOnly, "report-only violations").toEqual([]);
    });

    test("security.txt is served (RFC 9116)", async ({ request }) => {
      const res = await request.get("/.well-known/security.txt");
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toMatch(/^text\/plain; charset=utf-8/u);
      const body = await res.text();
      expect(body).toMatch(/^Contact: /mu);
      expect(body).toMatch(/^Expires: \d{4}-\d\d-\d\dT/mu);
      expect(body).toMatch(/^Canonical: http.*\/\.well-known\/security\.txt$/mu);
    });
  });
