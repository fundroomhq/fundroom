import { expect, type Page, test } from "@playwright/test";
import { codeFrom, freshTotpCode, OWNER, SETUP_TOKEN, waitForMail } from "../fixtures/stack.js";
import { expectNoAxeViolations } from "../support/axe.js";
import { saveStackState } from "../support/state.js";

/*
 * First run (EXECUTION_PLAN §9.4, ADR-0018, design/03 §5) in a real browser against the real
 * image: every URL shows "setup required" → the wizard needs the token → the owner is created
 * and signed in → the owner enrols a second factor → probes pass through Mailpit and the /data
 * volume → company basics, offering mode, modules, the data-room template, the first
 * invitations and a first update draft → admin opens. Real-browser axe (WCAG 2.2 AA) on every
 * wizard step.
 *
 * The security step is completed rather than skipped, and that is not a stylistic choice: an
 * owner always needs a level-2 session (§6.2), so every step after the probes is refused by the
 * server until it is done. Skipping it here would test the refusal notice and nothing else.
 */
/** The enrolled TOTP secret, shared by the wizard test and the sign-back-in test below — and,
 *  through `support/state.ts`, by the specs that run after this one (`30-a11y`). */
let totpSecret = "";
let lastCode = "";
/** Real-browser axe (WCAG 2.2 AA incl. colour contrast), shared with `30-a11y` (E2.8). */
async function axe(page: Page) {
  await expectNoAxeViolations(page);
}

/*
 * Tagged `@setup`: the a11y CI job runs `--grep "@setup|@a11y"`, because every later spec needs
 * the owner this file creates.
 */
test.describe
  .serial("first run @setup", () => {
    test("readiness and capability doc are up before setup", async ({ request }) => {
      const ready = await request.get("/readyz");
      expect(ready.status(), await ready.text()).toBe(200);
      const doc = await request.get("/.well-known/fundroom.json");
      expect(await doc.json()).toMatchObject({ apiVersion: "v1", tenancy: "single" });
      const status = await request.get("/api/v1/setup/status");
      expect(await status.json()).toMatchObject({ required: true, tokenSource: "env" });
    });

    test("every page points at the wizard until an owner exists", async ({ page }) => {
      await page.goto("/admin");
      await expect(page.getByRole("heading", { name: "Setup required" })).toBeVisible();
      await axe(page);
      await page.getByRole("link", { name: "Open setup" }).click();
      await expect(page).toHaveURL(/\/setup$/u);
      await expect(page.getByRole("heading", { name: "Enter the setup token" })).toBeVisible();
    });

    test("the wizard creates the owner and runs the probes", async ({ page, baseURL }) => {
      await page.goto("/setup");
      await axe(page);

      await page.getByLabel("Setup token").fill("definitely-not-the-token-000");
      await page.getByRole("button", { name: "Continue" }).click();
      await expect(page.getByText("That token does not match")).toBeVisible();
      await page.getByLabel("Setup token").fill(SETUP_TOKEN);
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(page.getByRole("heading", { name: "Create the owner account" })).toBeVisible();
      await axe(page);
      await page.getByLabel("Your name").fill(OWNER.name);
      await page.getByLabel("Your email address").fill(OWNER.email);
      await page.getByLabel("Company or workspace name").fill(OWNER.workspace);
      await expect(page.getByText(`${OWNER.slug} on ${new URL(baseURL ?? "").host}`)).toBeVisible();
      await page.getByRole("button", { name: "Create account and workspace" }).click();

      await expect(page.getByRole("heading", { name: "Secure your account" })).toBeVisible();
      await axe(page);
      await page.getByRole("button", { name: "Set up" }).click();
      const secret = await page.locator("code").first().innerText();
      totpSecret = secret.replace(/\s+/gu, "");
      lastCode = await freshTotpCode(totpSecret);
      await page.getByRole("textbox").first().fill(lastCode);
      await page.getByRole("button", { name: "Confirm code" }).click();
      await expect(page.getByText("Authenticator app enabled")).toBeVisible();
      saveStackState({ totpSecret, lastCode });
      await axe(page);
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(page.getByRole("heading", { name: "Check outbound email" })).toBeVisible();
      const before = new Date(Date.now() - 1000);
      await page.getByRole("button", { name: "Send me a test email" }).click();
      await expect(page.getByText("Check passed")).toBeVisible();
      const mail = await waitForMail(OWNER.email, { subject: /test email/u, after: before });
      expect(mail.text).toContain("outbound mail works");
      await axe(page);
      await page.getByRole("button", { name: "Continue" }).click();

      await expect(page.getByRole("heading", { name: "Check document storage" })).toBeVisible();
      await page.getByRole("button", { name: "Run storage check" }).click();
      await expect(page.getByText("Check passed")).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();

      /*
       * Resumability (E1.7): a cold load with nothing in the URL asks `GET /setup/status` and
       * lands on the first step its `progress` says is unfinished — here the company basics,
       * because the owner, the probes and nothing else are done. The wizard survives a reload.
       */
      await page.goto("/setup");
      await expect(page).toHaveURL(/\/setup\?step=company$/u);

      /*
       * Company basics: the display name, the tagline and the accent — the three fields this
       * step saves with `PATCH /branding`. Neither logo path is driven here: the upload needs an
       * image fixture pushed through a hidden file input, and the website import needs a page
       * for the server to fetch, which this stack has no egress for and no service to serve.
       * Both are covered server-side against the real guard and the real storage in
       * apps/server/src/branding.integration.test.ts.
       */
      await expect(page.getByRole("heading", { name: "Company basics" })).toBeVisible();
      await page.getByLabel("Display name").fill("Acme Ventures");
      await page.getByLabel("Tagline").fill("Building the boring parts");
      await page.getByLabel("Accent colour", { exact: true }).fill("#1d4ed8");
      await axe(page);
      await page.getByRole("button", { name: "Save and continue" }).click();

      // Offering mode: four plain-English choices, and counsel named before the click.
      await expect(page.getByRole("heading", { name: "How are you raising?" })).toBeVisible();
      await expect(page.getByText("This is not legal advice")).toBeVisible();
      await axe(page);
      await page.getByRole("radio", { name: /Rule 506\(b\)/u }).click();
      await page.getByRole("button", { name: "Set offering mode" }).click();

      /*
       * Portal address (E2.1 §9.4): three answers — keep the address the install came with,
       * point a domain you own at it, or embed the portal in your own site — and the first is
       * the default. Taken here, because the step is deliberately optional and must not gate
       * the wizard or its resume (a founder on a subdomain never needs a custom domain, and a
       * step that resumed them here forever would be E1.7's `hasBrand` bug again).
       *
       * The other branch — add a domain, publish the records, be served on it over HTTPS with a
       * certificate a real ACME CA issued — is driven end to end against a local Pebble in
       * `10-custom-domains.test.ts`, which needs its own stack (see the README).
       */
      await expect(
        page.getByRole("heading", { name: /Where should investors find/u }),
      ).toBeVisible();
      await expect(
        page.getByRole("radio", { name: /Keep the address it came with/u }),
      ).toBeChecked();
      await axe(page);
      await page.getByRole("button", { name: "Continue" }).click();

      // Modules: defaults on, required ones locked.
      await expect(
        page.getByRole("heading", { name: "Choose what the portal does" }),
      ).toBeVisible();
      await expect(page.getByRole("switch", { name: "access" })).toBeDisabled();
      await axe(page);
      await page.getByRole("button", { name: "Continue" }).click();

      // Data room folder template.
      await expect(page.getByRole("heading", { name: "Start the data room" })).toBeVisible();
      await axe(page);
      await page.getByRole("button", { name: "Create these folders" }).click();
      await expect(page.getByText(/Created \d+ folders/u)).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();

      // Invitations: one good address, one that is already a member.
      await expect(
        page.getByRole("heading", { name: "Invite your first investors" }),
      ).toBeVisible();
      const invited = "ada@example.com";
      await page.getByLabel("Email addresses").fill(`${invited}\n${OWNER.email}`);
      await expect(page.getByText("2 ready to invite.")).toBeVisible();
      await axe(page);
      await page.getByRole("button", { name: "Send invitations" }).click();
      await expect(page.getByText("Invited 1 people.")).toBeVisible();
      await expect(page.getByText("already a member of this workspace")).toBeVisible();
      await page.getByRole("button", { name: "Continue" }).click();

      // First update: one draft, and the form goes away so a second click cannot make two.
      await expect(page.getByRole("heading", { name: "Draft your first update" })).toBeVisible();
      await page.getByLabel("Update title").fill("October update");
      await axe(page);
      await page.getByRole("button", { name: "Save draft" }).click();
      await expect(page.getByText(/October update/u)).toBeVisible();
      await expect(page.getByRole("button", { name: "Save draft" })).toHaveCount(0);
      await page.getByRole("button", { name: "Continue" }).click();

      // Done: the portal URL, which is still the canonical one because the address step above
      // kept it.
      await expect(page.getByRole("heading", { name: "You're all set" })).toBeVisible();
      await expect(page.getByText(new URL(baseURL ?? "").origin, { exact: false })).toBeVisible();
      await axe(page);
      await page.getByRole("link", { name: "Open admin" }).click();
      await expect(page).toHaveURL(/\/admin$/u);
      // The admin overview itself — the not-found screen is an <h1> too, and a URL proves nothing.
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
      await axe(page);
    });

    test("setup is closed afterwards and the owner can sign back in with a code", async ({
      page,
      request,
      baseURL,
    }) => {
      const status = await request.get("/api/v1/setup/status");
      expect(await status.json()).toMatchObject({ required: false });
      const again = await request.post("/api/v1/setup/token/verify", {
        data: { token: SETUP_TOKEN },
        headers: { origin: new URL(baseURL ?? "").origin },
      });
      expect(again.status()).toBe(409);

      await page.goto("/setup");
      await expect(page.getByText("Setup is complete")).toBeVisible();

      await page.goto("/login");
      const before = new Date(Date.now() - 1000);
      await page.getByLabel(/Email address/u).fill(OWNER.email);
      await page.getByRole("button", { name: /Email me a code/u }).click();
      const mail = await waitForMail(OWNER.email, { subject: /code/iu, after: before });
      const code = codeFrom(mail.text);
      const otp = page.getByRole("textbox").first();
      await otp.fill(code);
      await expect(page).not.toHaveURL(/\/login/u);
      /*
       * The portal itself, not just a URL (E3.2): the sign-in screen fetched the bootstrap while
       * signed out ("no membership"), and before `refreshSession` refetched it this in-app
       * sign-in landed on "You don't have access here" with a perfectly good session.
       */
      await expect(
        page.getByRole("heading", { level: 1, name: `Welcome, ${OWNER.name}` }),
      ).toBeVisible();
      await expect(page.getByText("You don't have access here")).toHaveCount(0);

      // An email code is a level-1 session and an owner needs level 2, so admin asks for the
      // second factor the wizard enrolled.
      await page.goto("/auth/step-up?returnTo=%2Fadmin");
      await axe(page);
      await page.getByRole("tab", { name: "Authenticator" }).click();
      lastCode = await freshTotpCode(totpSecret, lastCode);
      saveStackState({ totpSecret, lastCode });
      await page.getByRole("textbox").first().fill(lastCode);
      await expect(page).toHaveURL(/\/admin$/u);
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
      await expect(page.getByText("Page not found")).toHaveCount(0);
      await axe(page);
    });
  });
