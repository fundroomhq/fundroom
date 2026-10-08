import { AxeBuilder } from "@axe-core/playwright";
import type { BrowserContext, FrameLocator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  Api,
  EMBED_URL,
  type EmbedSettingsView,
  HOST_A,
  HOST_B,
  hostUrl,
  INSECURE_HOST,
  ORIGIN_A,
  ORIGIN_B,
  ORIGIN_C,
  PORTAL_ORIGIN,
  SLUG,
} from "../fixtures/hosts.js";
import { codeFrom, freshTotpCode, OWNER, SETUP_TOKEN, waitForMail } from "../fixtures/stack.js";

/*
 * The portal inside somebody else's website, end to end (EXECUTION_PLAN §9.3, E2.2, design/08
 * §1c/§6/§7/§8, ADR-0008/0009/0040) against the real image, a real edge, and real hostnames.
 *
 * Runs against `deploy/compose/compose.hosts.yaml` layered on the CI stack, which is a separate
 * stack from the one `00-setup` drives: `BASE_URL` has to be `https://portal.test` for the portal
 * to have an origin a host page can be *cross-site* to. So this file creates its own owner over
 * the API rather than through the wizard, and invites the investor who does the signing in.
 *
 * What the unit and integration suites already cover and this file therefore does not repeat:
 * the loader's own logic under jsdom (`packages/embed`), the bridge contract
 * (`apps/web/src/embed/bridge.test.ts`), the origin check and the header derivation
 * (`apps/server/src/embed.integration.test.ts`). What only a browser on a second site can show
 * is the part the whole epic turns on:
 *
 *   1. A sign-in *inside the frame* survives, because the cookie it sets is
 *      `Secure; SameSite=None; Partitioned` and the API it was set by lives under
 *      `/embed/<slug>/api/v1`. This is the headline.
 *   2. That session does not exist on a second host site. Partitioning is a promise to the
 *      visitor, and the only way to check it is two different sites in one browser profile.
 *   3. A site that is not on the allow-list is refused *by the browser*, from the header, before
 *      any of our code runs.
 *   4. The host page — even one running a hostile script — obtains nothing.
 *
 * Cookie partitioning is keyed on the *site*, not the port, so `localhost:3000` against
 * `localhost:8081` would have proved none of it: two ports are the same site and are not
 * third-party to each other. Hence real hostnames, and hence TLS, because a
 * `Secure; Partitioned` cookie is only stored in a secure context and off loopback that means
 * https. The certificates are Caddy's internal ones and the browser is told to accept them; the
 * README explains why that weakens nothing this file asserts.
 */

/** Certificates come from Caddy's internal CA; `e2e/hosts/README.md` §"Why not a trusted root". */
test.use({ ignoreHTTPSErrors: true });

const api = new Api();

/** The investor who signs in inside the frame. Not the owner: an owner needs a level-2 session
 *  in this workspace (§6.2), so every portal call would answer `step_up_required` and the test
 *  would be about the second factor rather than about the embed. An investor in a frame is also
 *  the thing the feature is for. */
const INVESTOR = { email: "ada@example.com", name: "Ada Investor" } as const;

/** `DEFAULT_MIN_HEIGHT` in `packages/embed`: the skeleton's height, and the floor the loader
 *  never goes below. Re-stated here rather than imported — `e2e` has no workspace dependencies,
 *  so a change on either side shows up as a failing assertion instead of silently agreeing. */
const MIN_HEIGHT = 320;

/** A second investor, for the one test that has to sign in without disturbing the first. */
const SECOND_INVESTOR = { email: "bella@example.com", name: "Bella Investor" } as const;

/** The enrolled TOTP secret and the last code the server accepted (replays are refused). */
let totpSecret = "";
let lastCode = "";

/** One browser profile for the whole file: a session established on `host-a.test` in the first
 *  test has to still be there when a later test opens a different page on the same site, and has
 *  to be *absent* on `host-b.test`. A per-test context would prove neither. */
let context: BrowserContext;
let page: Page;

/** `PUT /embed/settings` is a step-up action (design/02 §78), so every change costs a fresh
 *  proof. Codes are single-use inside their window, hence `freshTotpCode`'s `avoid`. */
async function stepUp(): Promise<void> {
  lastCode = await freshTotpCode(totpSecret, lastCode);
  await api.ok("POST", "/api/v1/auth/totp/verify", { code: lastCode });
}

async function setEmbedOrigins(origins: readonly string[]): Promise<EmbedSettingsView> {
  await stepUp();
  return await api.ok<EmbedSettingsView>("PUT", "/api/v1/embed/settings", { origins });
}

/** The loader's frame. The attribute is the loader's own marker, so this selector is the
 *  contract between the harness and `packages/embed`, not a guess about the markup. */
function portalFrame(target: Page | FrameLocator): FrameLocator {
  return target.frameLocator("[data-seed-host-portal] iframe");
}

/**
 * The investor is signed in and looking at the portal: the home heading and the workspace's own
 * navigation, which only renders once `/me` and the bootstrap have both answered for a member.
 *
 * The heading is matched as `/^Welcome/` rather than by name so that this stays a test about the
 * frame rather than about the greeting. (It used to be blank: the `displayName` from the
 * invitation never reached the account the first sign-in creates, so every invited investor was
 * greeted "Welcome," and nothing. Fixed in `packages/identity`'s login path, with its own
 * regression test there.)
 */
async function expectSignedIn(frame: FrameLocator): Promise<void> {
  await expect(frame.getByRole("heading", { name: /^Welcome/u })).toBeVisible();
  await expect(frame.getByRole("link", { name: "Home", exact: true })).toBeVisible();
}

interface Probe {
  readonly resizes: readonly number[];
  readonly navigations: readonly string[];
  readonly messages: readonly { readonly type: string; readonly payload: unknown }[];
  readonly belowTopAtMount: number | null;
  readonly cls: number;
  readonly ready: boolean;
}

/**
 * Fill the address and get a code sent, retrying the click if nothing goes out.
 *
 * The retry is not superstition. The sign-in form starts a conditional-UI WebAuthn request on
 * mount (`navigator.credentials.get({ mediation: "conditional" })`), which hangs off the browser's
 * own autofill surface on the email field — and roughly one run in three the first click on
 * "Email me a code" is swallowed by it: no submit, no `POST /auth/otp/start`, no mail, and no
 * error anywhere. Waiting for the request rather than for the mail is what makes the failure
 * legible; clicking again is what makes it rare. A real visitor clicks again too.
 */
async function requestCode(page: Page, frame: FrameLocator, email: string): Promise<void> {
  await frame.getByLabel(/Email address/u).fill(email);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const started = page
      .waitForResponse((response) => response.url().includes("/auth/otp/start"), {
        timeout: 5_000,
      })
      .catch(() => undefined);
    await frame.getByRole("button", { name: /Email me a code/u }).click();
    const response = await started;
    if (response !== undefined) {
      expect(response.status(), await response.text()).toBe(200);
      return;
    }
  }
  throw new Error("the sign-in form never sent POST /auth/otp/start");
}

async function probeOf(target: Page): Promise<Probe> {
  return await target.evaluate(() => (window as unknown as { __probe: Probe }).__probe);
}

test.describe
  .serial("the portal embedded in someone else's website", () => {
    test.beforeAll(async ({ browser }) => {
      context = await browser.newContext({ ignoreHTTPSErrors: true });
      page = await context.newPage();

      const status = await api.ok<{ required: boolean; tenancy: string }>(
        "GET",
        "/api/v1/setup/status",
      );
      expect(
        status.required,
        "this file needs a fresh stack: pnpm --filter @fundroom/e2e stack:down:hosts && stack:up:hosts",
      ).toBe(true);

      await api.ok("POST", "/api/v1/setup/owner", {
        token: SETUP_TOKEN,
        email: OWNER.email,
        displayName: OWNER.name,
        workspaceName: OWNER.workspace,
        workspaceSlug: OWNER.slug,
      });
      expect(OWNER.slug, "the host pages hard-code the slug").toBe(SLUG);

      // The owner enrols a second factor because everything below needs a level-2, *fresh*
      // session: changing the framing allow-list is a step-up action, and so is the offering
      // status. Confirming enrolment is itself the step-up.
      const enrol = await api.ok<{ secretBase32: string }>("POST", "/api/v1/auth/totp/enrol");
      totpSecret = enrol.secretBase32.replace(/\s+/gu, "");
      lastCode = await freshTotpCode(totpSecret);
      await api.ok("POST", "/api/v1/auth/totp/enrol/confirm", { code: lastCode });

      // Updates are offering material and are hidden from investors while the workspace is
      // `informational` (ADR-0019), and the deep-link test navigates to `/updates`. 506(b) is
      // the status `00-setup` picks in the wizard for the same reason.
      await api.ok("PATCH", "/api/v1/compliance/offering", { status: "506b" });

      // The investor. `_auth/invite` says the invitation is consumed on first verified login, so
      // there is no link to follow: signing in inside the frame is what makes her a member.
      const invited = await api.ok<{ created: unknown[]; failed: unknown[] }>(
        "POST",
        "/api/v1/access/invites",
        {
          invites: [
            { email: INVESTOR.email, displayName: INVESTOR.name },
            { email: SECOND_INVESTOR.email, displayName: SECOND_INVESTOR.name },
          ],
        },
      );
      expect(invited.failed).toEqual([]);
      expect(invited.created).toHaveLength(2);

      // The allow-list every test below relies on. `host-b` is on it so that the partition test
      // is about the cookie and not about the header; the last test in the file takes it off
      // again and checks what the browser does then.
      const settings = await setEmbedOrigins([ORIGIN_A, ORIGIN_B, ORIGIN_C]);
      expect(settings.origins).toEqual([ORIGIN_A, ORIGIN_B, ORIGIN_C]);
      expect(settings.frameAncestors).toEqual(["'self'", ORIGIN_A, ORIGIN_B, ORIGIN_C]);
      expect(settings.embedUrl).toBe(EMBED_URL);
    });

    test.afterAll(async () => {
      await context?.close();
    });

    /* ------------------------------------------------------------------------------------ */
    /* 1. The headline: signing in inside the frame, on somebody else's site                 */
    /* ------------------------------------------------------------------------------------ */

    test("an investor signs in inside the frame on host-a.test and reaches gated content", async () => {
      /*
       * Two things are recorded off the wire rather than asserted from the page, because they are
       * the two decisions this epic changed and both are invisible in the rendering:
       *
       *   - every API call the framed SPA makes goes to `/embed/<slug>/api/v1`, not `/w/<slug>`,
       *     which is what makes the request classify as `embed` and get the partitioned cookie
       *     recipe;
       *   - the cookie that comes back carries `Secure; SameSite=None; Partitioned`.
       */
      const apiCalls: string[] = [];

      /** Requests the browser itself refused or dropped — the only trace a fetch that never
       *  reached the server leaves, and the first thing to read when a sign-in does not stick. */
      const failures: string[] = [];
      page.on("request", (request) => {
        const url = request.url();
        if (url.startsWith(PORTAL_ORIGIN) && url.includes("/api/v1/")) apiCalls.push(url);
      });
      page.on("requestfailed", (request) => {
        failures.push(`${request.method()} ${request.url()} — ${request.failure()?.errorText}`);
      });
      page.on("response", (response) => {
        if (response.status() >= 400 && response.url().includes("/api/v1/")) {
          failures.push(`${response.status()} ${response.request().method()} ${response.url()}`);
        }
      });

      await page.goto(hostUrl(HOST_A, "/plain.html"));
      const frame = portalFrame(page);

      await expect(frame.getByRole("heading", { name: "Sign in" })).toBeVisible();
      const before = new Date(Date.now() - 1000);
      await requestCode(page, frame, INVESTOR.email);

      const mail = await waitForMail(INVESTOR.email, { subject: /code/iu, after: before }).catch(
        (error: unknown) => {
          throw new Error(
            `${String(error)}\nAPI calls: ${JSON.stringify(apiCalls)}\nRefused/failed: ${JSON.stringify(failures)}`,
          );
        },
      );
      /*
       * Waited for explicitly, and not as a nicety: the next step navigates the host page, which
       * destroys the frame, and a `POST /auth/otp/verify` still in flight when that happens is
       * cancelled by the browser — a sign-in that half-succeeded and left no session. Waiting for
       * the response is the difference between a suite that passes and one that passes usually.
       */
      const verified = page.waitForResponse(
        (response) => response.url().includes("/auth/otp/verify"),
        { timeout: 30_000 },
      );
      await frame.getByRole("textbox").first().fill(codeFrom(mail.text));
      const verifyResponse = await verified;
      expect(verifyResponse.status(), await verifyResponse.text()).toBe(200);
      const setCookies = (await verifyResponse.headersArray())
        .filter((header) => header.name.toLowerCase() === "set-cookie")
        .map((header) => header.value);

      // The session exists from here: `POST /auth/otp/verify` answered 200 and set the cookie
      // asserted below, and the SPA navigates itself onto the portal. This used to need a
      // `page.goto` workaround, because the sign-in screen invalidated `/me` without refetching
      // it and the route guard then read the stale `null` — see the sibling test below.

      /*
       * The acceptance gate (ADR-0037 decision 5), inside the frame. A workspace with an
       * offering has a privacy notice, and no member reaches anything else until they have
       * agreed to it — so this *is* the gated-content path, not a detour around it, and a
       * checkbox and a button inside a cross-origin frame are worth seeing work.
       */
      await expect(frame.getByRole("heading", { name: "Before you go in" })).toBeVisible({
        timeout: 20_000,
      });
      await frame.getByRole("checkbox", { name: /I have read and agree/u }).click();
      await frame.getByRole("button", { name: "Agree and continue" }).click();

      // Gated content: the investor home, which is behind `_portal`'s `me !== null` guard and
      // behind the server's membership check on every call it makes.
      await expectSignedIn(frame);

      expect(apiCalls.length).toBeGreaterThan(0);
      const wrongPrefix = apiCalls.filter((u) => !u.startsWith(`${EMBED_URL}/api/v1/`));
      expect(wrongPrefix, "the framed SPA must call the API under its own embed prefix").toEqual(
        [],
      );

      const session = setCookies.find((c) => c.startsWith("__Host-sid="));
      expect(session, `no session cookie in ${JSON.stringify(setCookies)}`).toBeDefined();
      expect(session).toMatch(/;\s*Secure/iu);
      expect(session).toMatch(/;\s*HttpOnly/iu);
      expect(session).toMatch(/;\s*SameSite=None/iu);
      expect(session).toMatch(/;\s*Partitioned/iu);

      // And the host page holds nothing. `document.cookie` here is the customer's own site; the
      // portal's cookie is on another origin and is partitioned to this one, which means the
      // page it is partitioned *to* still cannot read it.
      const hostCookie = await page.evaluate(() => document.cookie);
      expect(hostCookie).not.toContain("sid");
    });

    /*
     * The regression, on its own, because it was a real defect and it was invisible everywhere
     * else. Signing in from a gated route bounced straight back to the sign-in screen holding a
     * valid session cookie: `invalidateQueries` marks `/me` stale but only refetches queries with
     * an active observer, and no sign-in screen observes it, so the route guard's
     * `ensureQueryData` resolved the `null` cached by the `/me` that 401'd before sign-in. It was
     * not embed-specific — a top-level visitor following a deep link into a gated route saw it
     * too — but the frame shows it *every* time, because a framed visitor always lands on `/`
     * first. `00-setup` misses it because it opens `/login` directly and so never caches a
     * `null`. Fixed by `refreshSession()` in `apps/web/src/lib/queries.ts`.
     *
     * Its own investor and its own browser profile, because a second sign-in on `host-a.test` in
     * the shared context would replace the session every later test depends on.
     */
    test("signing in inside the frame lands on the portal without reopening the page", async ({
      browser,
    }) => {
      const fresh = await browser.newContext({ ignoreHTTPSErrors: true });
      const solo = await fresh.newPage();
      try {
        await solo.goto(hostUrl(HOST_A, "/plain.html"));
        const frame = portalFrame(solo);
        await expect(frame.getByRole("heading", { name: "Sign in" })).toBeVisible();
        const before = new Date(Date.now() - 1000);
        await requestCode(solo, frame, SECOND_INVESTOR.email);
        const mail = await waitForMail(SECOND_INVESTOR.email, { subject: /code/iu, after: before });
        const verified = solo.waitForResponse(
          (response) => response.url().includes("/auth/otp/verify"),
          { timeout: 30_000 },
        );
        await frame.getByRole("textbox").first().fill(codeFrom(mail.text));
        expect((await verified).status()).toBe(200);

        /*
         * The *desired* behaviour, asserted positively so that it is what starts passing when the
         * defect is fixed: after a successful sign-in the frame shows the acceptance gate (this
         * workspace has a privacy notice) or the portal home. Today it shows the sign-in form
         * again. A negative assertion — "not the sign-in screen" — would be satisfied by the blink
         * while the router redirects, and would pass or fail by timing.
         */
        await expect(
          frame.getByRole("heading", { name: /^(Before you go in|Welcome)/u }),
        ).toBeVisible({ timeout: 15_000 });
      } finally {
        await fresh.close();
      }
    });

    /* ------------------------------------------------------------------------------------ */
    /* 2. Partition isolation                                                                */
    /* ------------------------------------------------------------------------------------ */

    test("the session on host-a.test does not carry to host-b.test", async () => {
      /*
       * The same browser, the same profile, the same portal origin, the same allow-list — and a
       * different top-level site, which is the only variable. The cookie set in the test above
       * has a partition key of `https://host-a.test`, so the frame here is anonymous.
       *
       * This is also the documented cost of the design (design/08 §1c: "one login per host site
       * × portal pair"), so a failure in either direction matters: no session would be a broken
       * embed, and a shared session would be a partitioning claim we cannot make.
       */
      await page.goto(hostUrl(HOST_B, "/plain.html"));
      const frame = portalFrame(page);
      await expect(frame.getByRole("heading", { name: "Sign in" })).toBeVisible();
      await expect(frame.getByRole("heading", { name: /^Welcome/u })).toHaveCount(0);

      // Back on host-a, still signed in: the frame is anonymous on the *other* site, not
      // everywhere, which is the difference between partitioning and cookies simply not working.
      await page.goto(hostUrl(HOST_A, "/plain.html"));
      await expectSignedIn(portalFrame(page));
    });

    /* ------------------------------------------------------------------------------------ */
    /* 3. The raw-iframe snippet                                                             */
    /* ------------------------------------------------------------------------------------ */

    test("the raw-iframe snippet works with no loader at all", async () => {
      await page.goto(hostUrl(HOST_A, "/iframe.html"));
      const frame = page.frameLocator('iframe[title="Investor relations portal"]');
      await expectSignedIn(frame);
    });

    /* ------------------------------------------------------------------------------------ */
    /* 4. The hostile page obtains nothing                                                   */
    /* ------------------------------------------------------------------------------------ */

    test("a hostile script on an allow-listed page obtains no cookie, no API response and no frame DOM", async () => {
      await page.goto(hostUrl(HOST_A, "/hostile.html"));
      const frame = portalFrame(page);
      // The strict CSP must not have broken the embed: this is the page that proves the loader
      // survives `script-src 'self'` and `style-src 'self'` with no `'unsafe-inline'`.
      await expectSignedIn(frame);

      interface HostileReport {
        readonly cookie: string | null;
        readonly frameDom: string | null;
        readonly frameDomError: string | null;
        readonly frameLocation: string | null;
        readonly frameLocationError: string | null;
        readonly apiStatus: number | null;
        readonly apiBody: string | null;
        readonly apiError: string | null;
        readonly documentStatus: number | null;
        readonly documentBody: string | null;
        readonly documentError: string | null;
        readonly received: readonly { readonly type?: string; readonly payload?: unknown }[];
        readonly stillFramed: boolean | null;
        readonly done: boolean;
      }
      await expect
        .poll(
          async () =>
            await page.evaluate(
              () => (window as unknown as { __hostile: HostileReport }).__hostile.done,
            ),
          { timeout: 30_000 },
        )
        .toBe(true);
      const report = await page.evaluate(
        () => (window as unknown as { __hostile: HostileReport }).__hostile,
      );

      // Nothing obtained.
      expect(report.cookie ?? "").not.toContain("sid");
      expect(report.frameDom, "the frame's DOM must not be readable").toBeNull();
      expect(report.frameDomError).toBeTruthy();
      expect(report.frameLocation, "the visitor's position must not be readable").toBeNull();
      expect(report.apiStatus, `credentialed API call answered: ${report.apiBody}`).toBeNull();
      expect(report.apiError).toBeTruthy();
      expect(
        report.documentStatus,
        `embed document was fetched: ${report.documentBody}`,
      ).toBeNull();
      expect(report.documentError).toBeTruthy();

      /*
       * What it *is* allowed to see: the bridge. An allow-listed host page can drive the portal
       * and is told when it navigates or resizes — that is the contract. So the assertion is not
       * "no messages" but "no content in them": ids, paths, heights and states only, never a
       * title, an email or a byte of a document (spec §3).
       */
      for (const message of report.received) {
        const json = JSON.stringify(message.payload ?? {});
        expect(json).not.toContain(INVESTOR.email);
        expect(json).not.toContain(INVESTOR.name);
      }

      // And the garbage it posted changed nothing: the frame is still there, still on the portal.
      expect(report.stillFramed).toBe(true);
      await expectSignedIn(frame);
    });

    /* ------------------------------------------------------------------------------------ */
    /* 5. Resize, and the host page's layout                                                 */
    /* ------------------------------------------------------------------------------------ */

    test("the frame grows to its content, does not scroll internally, and nothing above it moves", async () => {
      await page.goto(hostUrl(HOST_A, "/plain.html"));
      const frame = portalFrame(page);
      await expectSignedIn(frame);

      /*
       * Polled, because the child's `resize` is deferred to a `requestAnimationFrame` after its
       * `ResizeObserver` fires: the content can be on screen a frame or two before the height
       * that describes it has been posted.
       */
      await expect
        .poll(
          async () => {
            const current = await probeOf(page);
            return current.ready && current.resizes.length > 0;
          },
          { timeout: 15_000, message: "the child must report ready and a height" },
        )
        .toBe(true);
      const probe = await probeOf(page);

      /*
       * The frame settles to the height the child asked for, or to the 320 px floor if the
       * content is shorter than that. Polled rather than read once: the child debounces its
       * `resize` messages and the loader debounces applying them, so the last word on the height
       * arrives a few frames after the content does.
       */
      const measure = async (): Promise<{ height: number; asked: number }> => {
        const current = await probeOf(page);
        const box = await page.locator("[data-seed-host-portal] iframe").boundingBox();
        return {
          height: Math.round(box?.height ?? 0),
          asked: Math.max(current.resizes[current.resizes.length - 1] ?? 0, MIN_HEIGHT),
        };
      };
      await expect
        .poll(async () => Math.abs((await measure()).height - (await measure()).asked) <= 1, {
          timeout: 15_000,
          message: "the frame must settle to the height the child asked for",
        })
        .toBe(true);
      const settled = await measure();
      expect(settled.height).toBeGreaterThanOrEqual(MIN_HEIGHT);

      /*
       * No inner scrollbar. Asked *inside* the frame, which is the only place the question has an
       * answer: a frame shorter than its document is the thing everyone complains about, and it
       * is invisible from the host page.
       */
      const child = page.frames().find((f) => f.url().startsWith(EMBED_URL));
      expect(child, "the portal frame must be attached").toBeDefined();
      const inner = await child?.evaluate(() => ({
        scrollHeight: document.documentElement.scrollHeight,
        innerHeight: window.innerHeight,
      }));
      expect((inner?.innerHeight ?? 0) + 2).toBeGreaterThanOrEqual(inner?.scrollHeight ?? 0);

      /*
       * And the host page's own layout. The paragraph below the frame may move *down* as the
       * frame grows past the reserved 320 px — that is the frame filling the space it asked for,
       * and the alternative is an iframe that clips its content — but it must never move up, and
       * nothing above the frame may move at all.
       */
      expect(
        probe.belowTopAtMount,
        "the loader must reserve space before the frame loads",
      ).not.toBeNull();
      const belowNow = await page.locator("#below").boundingBox();
      expect(belowNow?.y ?? 0).toBeGreaterThanOrEqual(probe.belowTopAtMount ?? 0);
      const aboveBox = await page.locator("#above").boundingBox();
      expect(aboveBox?.y ?? 0).toBeLessThan(probe.belowTopAtMount ?? 0);
    });

    /* ------------------------------------------------------------------------------------ */
    /* 6. Deep links                                                                          */
    /* ------------------------------------------------------------------------------------ */

    test("?sh= restores a deep link and follows the visitor as they navigate inside the frame", async () => {
      /*
       * `deep-link.html`'s snippet asks for `/settings`; the URL asks for `/updates`. The URL has
       * to win: `path` is the default for someone arriving without a deep link, and `?sh=` is the
       * link this visitor actually followed.
       */
      await page.goto(hostUrl(HOST_A, "/deep-link.html?sh=/updates"));
      const frame = portalFrame(page);
      await expect(frame.getByRole("heading", { name: "Updates", exact: true })).toBeVisible();
      expect(new URL(page.url()).searchParams.get("sh")).toBe("/updates");

      // Now navigate inside the frame. The child posts `navigate`, the loader writes it into the
      // host page's URL with `replaceState` — so the host's back button is not filled with one
      // entry per click, and the address bar is still shareable.
      await frame.getByRole("link", { name: "Home", exact: true }).click();
      await expectSignedIn(frame);
      await expect.poll(() => new URL(page.url()).searchParams.get("sh")).toBe("/");

      // And the round trip: that URL, reloaded, lands where it says.
      await page.goto(`${hostUrl(HOST_A, "/deep-link.html")}?sh=/updates`);
      await expect(
        portalFrame(page).getByRole("heading", { name: "Updates", exact: true }),
      ).toBeVisible();
    });

    /* ------------------------------------------------------------------------------------ */
    /* 7. The double-iframe (builder) shape                                                  */
    /* ------------------------------------------------------------------------------------ */

    test("a double-iframed page renders when every ancestor is allow-listed", async () => {
      await page.goto(hostUrl(HOST_A, "/nested.html"));
      const inner = page.frameLocator("#builder-sandbox");
      await expectSignedIn(portalFrame(inner));

      // `frame-ancestors` is checked against the whole chain, so this only renders because both
      // `host-a.test` (the top) and `host-c.test` (the wrapper) are on the list.
      const chain = await page
        .frames()
        .find((f) => f.url().startsWith(EMBED_URL))
        ?.evaluate(() => Array.from(location.ancestorOrigins));
      expect(chain).toEqual([ORIGIN_C, ORIGIN_A]);
    });

    /* ------------------------------------------------------------------------------------ */
    /* 8. An insecure host page                                                              */
    /* ------------------------------------------------------------------------------------ */

    test("an http: page gets the link and never a frame", async () => {
      const insecure = await context.newPage();
      const warnings: string[] = [];
      insecure.on("console", (message) => warnings.push(message.text()));
      await insecure.goto(hostUrl(INSECURE_HOST, "/insecure.html"));

      const link = insecure.locator("[data-seed-host-fallback]");
      await expect(link).toBeVisible();
      await expect(link).toHaveText("Open investor portal");
      // The portal's own origin, where the session is first-party and none of this applies.
      expect(await link.getAttribute("href")).toBe(`${PORTAL_ORIGIN}/w/${SLUG}`);
      expect(await insecure.locator("[data-seed-host-portal] iframe").count()).toBe(0);
      // A refusal nobody can diagnose is a bug report; the console says what to change.
      expect(warnings.join("\n")).toMatch(/Refusing to embed on an insecure page/u);
      await insecure.close();
    });

    /* ------------------------------------------------------------------------------------ */
    /* 9. Accessibility, inside the frame                                                    */
    /* ------------------------------------------------------------------------------------ */

    test("axe finds no violations inside the frame", async () => {
      /*
       * Run against the *frame*, not the host page: the host page is this harness's own HTML and
       * proving it accessible proves nothing about the product. A real browser also sees the
       * colour contrast jsdom cannot compute, which is how E2.1 found a defect its jsdom suite
       * structurally could not.
       */
      await page.goto(hostUrl(HOST_A, "/plain.html"));
      await expectSignedIn(portalFrame(page));

      const results = await new AxeBuilder({ page })
        .include(["[data-seed-host-portal] iframe", "body"])
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();

      /*
       * Proof that it looked where it was told to, before believing the empty violation list.
       * A frame selector that matched nothing would produce exactly the same "zero violations",
       * and a silently-empty accessibility check is worse than no check at all: axe reports
       * results inside a frame with a target of `[frameSelector, elementSelector]`, so a node
       * with a two-part target is the frame's content and nothing else is.
       */
      const insideFrame = [...results.passes, ...results.incomplete].flatMap((rule) =>
        rule.nodes.filter((node) => Array.isArray(node.target) && node.target.length > 1),
      );
      expect(insideFrame.length, "axe did not reach inside the frame").toBeGreaterThan(0);

      expect(results.violations, JSON.stringify(results.violations, null, 2)).toEqual([]);
    });

    /* ------------------------------------------------------------------------------------ */
    /* 10. The allow-list, enforced by the browser                                            */
    /* ------------------------------------------------------------------------------------ */

    test("a site taken off the allow-list is refused by the browser, not by a page that says no", async () => {
      /*
       * Last in the file, because it narrows the allow-list to `host-a.test` alone and everything
       * above needs `host-b`. Narrowing rather than using a fourth hostname is also the more
       * useful version of the test: it shows that removing an origin takes effect on the next
       * request, which is the thing an admin does when a site is compromised.
       *
       * The assertion is not "the frame is empty" and not "our 403 page rendered" — it is that
       * the *browser* refused, from the header, before any of our code ran. So: the header the
       * portal sent, and the browser's own violation message.
       */
      const settings = await setEmbedOrigins([ORIGIN_A]);
      expect(settings.frameAncestors).toEqual(["'self'", ORIGIN_A]);

      const victim = await context.newPage();
      const violations: string[] = [];
      const headers: string[] = [];
      victim.on("console", (message) => {
        if (/frame-ancestors/iu.test(message.text())) violations.push(message.text());
      });
      victim.on("response", (response) => {
        if (!response.url().startsWith(EMBED_URL)) return;
        headers.push(response.headers()["content-security-policy"] ?? "");
      });

      await victim.goto(hostUrl(HOST_B, "/plain.html"));

      // The loader gives up after 5 s of no `ready` and renders the link, which is the documented
      // behaviour for "host CSP blocks our frame" (design/08 §7) — the visitor is never left
      // looking at an empty box.
      await expect(victim.locator("[data-seed-host-fallback]")).toBeVisible({ timeout: 20_000 });

      const csp = headers.join(" | ");
      expect(csp, "the embed document must carry frame-ancestors").toContain("frame-ancestors");
      expect(csp).toContain(ORIGIN_A);
      expect(csp).not.toContain(ORIGIN_B);
      expect(violations.join("\n"), "the browser must have refused the framing itself").toMatch(
        /frame-ancestors/iu,
      );

      await victim.close();
    });
  });
