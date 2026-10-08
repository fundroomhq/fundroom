import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page, Request } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { Api } from "../fixtures/hosts.js";
import {
  API_PREFIX,
  BASE_URL,
  cookieNames,
  ECHO_PATH,
  HOST_COOKIE,
  MOUNTED_SESSION_COOKIE,
  MOUNTS,
  type Mount,
  mountOrigin,
  mountUrl,
  PORTAL_COOKIE,
  PORTAL_HOST,
  PORTAL_ORIGIN,
  parseEcho,
  urlsIn,
} from "../fixtures/pathmount.js";
import { codeFrom, freshTotpCode, OWNER, SETUP_TOKEN, waitForMail } from "../fixtures/stack.js";
import { passAcceptanceGate, requestCode } from "../support/session.js";

/*
 * The portal served under a path of somebody else's website, end to end (E3.9, ADR-0057),
 * against the real image and five real reverse proxies, each running the recipe the docs
 * publish (e2e/pathmount/<host>/, mounted verbatim by deploy/compose/compose.pathmount.yaml):
 *
 *   nginx.test/investors   nginx          preserve  /investors → /investors
 *   caddy.test/portal      Caddy          replace   /portal    → /investors
 *   worker.test/investors  workerd        preserve  (Cloudflare Worker module)
 *   next.test/investors    Next.js        preserve  (rewrites + proxy.js)
 *   wp.test/investors      WordPress      preserve  (the plugin's proxy mode)
 *
 * The app runs with BASE_PATH=/investors, BASE_URL=https://portal.test/investors and every mount
 * in PATH_MOUNTS. One `test.describe` per host, so a red line names the recipe that broke. Each
 * host gets its own investor and browser profile and walks the same path: the host's own page
 * (which sets a Path=/ cookie), both root forms of the mount, an email-code sign-in *through the
 * mount*, a lazy route (its chunk must load from the mount, not from `/assets` on the host), a
 * reload of that deep link, the session cookie's name and Path, what the recipe forwards to the
 * portal, and a sign-out POST (CSRF has to accept the mount's origin). The owner's half — a
 * step-up and an invitation sent through a mount — runs once, on the replace-shape Caddy mount,
 * where a request-derived link would be most visibly wrong.
 *
 * What the integration suite (`apps/server/src/path-mount.integration.test.ts`) covers and this
 * file does not repeat: the header matching rules, forged prefixes, Vary, OIDC/SAML URLs.
 */

/** Certificates come from the edge's internal CA (`e2e/pathmount/README.md`). */
test.use({
  ignoreHTTPSErrors: true,
  // A portal that fails to render under a mount (assets 404 on the host) shows a blank page; a
  // bounded action timeout turns that into a failure at the step, not a test-timeout at the end.
  actionTimeout: 20_000,
});

const api = new Api(process.env["E2E_BASE_URL"] ?? "http://localhost:3000");

function investorFor(mount: Mount): { email: string; name: string } {
  return { email: `${mount.name}-investor@example.com`, name: `Investor ${mount.name}` };
}

/* -------------------------------------------------------------------------------------- */
/* State across a worker restart                                                           */
/* -------------------------------------------------------------------------------------- */

/*
 * Playwright restarts the worker after a failed test and runs `beforeAll` again. The setup is a
 * first-run install and cannot be repeated, so what it learns (the owner's TOTP secret) goes to a
 * gitignored file and a restarted worker picks it up instead of failing on "already set up" —
 * which is what keeps a failure in one host's describe from taking the others down with it.
 */
interface PathmountState {
  readonly totpSecret: string;
  lastCode: string;
}
const STATE_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", ".state", "pathmount.json");
let state: PathmountState;

function saveState(): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

test.beforeAll(async () => {
  const status = await api.ok<{ required: boolean }>("GET", `${API_PREFIX}/setup/status`);
  if (!status.required) {
    try {
      state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as PathmountState;
      return;
    } catch {
      throw new Error(
        "this file needs a fresh stack: pnpm --filter @fundroom/e2e stack:down:pathmount && stack:up:pathmount",
      );
    }
  }

  await api.ok("POST", `${API_PREFIX}/setup/owner`, {
    token: SETUP_TOKEN,
    email: OWNER.email,
    displayName: OWNER.name,
    workspaceName: OWNER.workspace,
    workspaceSlug: OWNER.slug,
  });
  const enrol = await api.ok<{ secretBase32: string }>("POST", `${API_PREFIX}/auth/totp/enrol`);
  const totpSecret = enrol.secretBase32.replace(/\s+/gu, "");
  const code = await freshTotpCode(totpSecret);
  await api.ok("POST", `${API_PREFIX}/auth/totp/enrol/confirm`, { code });
  state = { totpSecret, lastCode: code };
  saveState();

  // An offering, so investors have Updates (a lazy route) and an acceptance gate (a POST).
  await api.ok("PATCH", `${API_PREFIX}/compliance/offering`, { status: "506b" });

  const invited = await api.ok<{ created: unknown[]; failed: unknown[] }>(
    "POST",
    `${API_PREFIX}/access/invites`,
    {
      invites: MOUNTS.map((m) => ({
        email: investorFor(m).email,
        displayName: investorFor(m).name,
      })),
    },
  );
  expect(invited.failed).toEqual([]);
  expect(invited.created).toHaveLength(MOUNTS.length);
});

/* -------------------------------------------------------------------------------------- */
/* Helpers                                                                                 */
/* -------------------------------------------------------------------------------------- */

interface WebConfigMeta {
  readonly basePath: string;
  readonly routerBase: string;
  readonly apiBase: string;
  readonly canonicalOrigin: string;
}

async function webConfig(page: Page): Promise<WebConfigMeta> {
  const content = await page
    .locator('meta[name="seed-host:config"]')
    .getAttribute("content", { timeout: 10_000 });
  if (content === null) throw new Error("no seed-host:config meta on the page");
  return JSON.parse(content) as WebConfigMeta;
}

/** The document's `src`/`href`s that point at the SPA's assets, resolved. */
async function documentAssetUrls(page: Page): Promise<string[]> {
  return await page.evaluate(() =>
    Array.from(document.querySelectorAll("script[src], link[href]"))
      .map((el) => el.getAttribute("src") ?? el.getAttribute("href") ?? "")
      .filter((u) => u.includes("/assets/"))
      // Vite's preload helper adds absolute `<link rel=modulepreload>`s at runtime.
      .map((u) => new URL(u, document.baseURI).href),
  );
}

/**
 * The code screen, before typing into it. `requestCode` returns when `POST /auth/otp/start`
 * answers, and through the slower proxies (Next.js, WordPress) the form can still be the email
 * form for a moment afterwards — "the first textbox" would then be the email field, and the code
 * typed into it vanishes with the re-render.
 */
async function expectCodeScreen(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: /Enter your code/u })).toBeVisible();
}

/** Everything the page asked for, so a stray request to the portal's own origin or to an
 *  unprefixed `/assets` on the host is visible in the failure rather than as a blank screen. */
function recordTraffic(page: Page): { requests: string[]; failures: string[]; hsts: string[] } {
  const requests: string[] = [];
  const failures: string[] = [];
  /** Responses that carried `Strict-Transport-Security`: on a mount that is the host's to set. */
  const hsts: string[] = [];
  page.on("request", (r: Request) => requests.push(r.url()));
  page.on("requestfailed", (r) =>
    failures.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText}`),
  );
  page.on("response", (r) => {
    if (r.status() >= 400) failures.push(`${r.status()} ${r.request().method()} ${r.url()}`);
    const sts = r.headers()["strict-transport-security"];
    if (sts !== undefined && !r.url().includes(ECHO_PATH)) hsts.push(`${r.url()} — ${sts}`);
  });
  return { requests, failures, hsts };
}

/* -------------------------------------------------------------------------------------- */
/* Canonical links                                                                         */
/* -------------------------------------------------------------------------------------- */

test("invitation emails link to BASE_URL, not to a mount", async () => {
  for (const mount of MOUNTS) {
    const mail = await waitForMail(investorFor(mount).email, { subject: /invit/iu });
    const urls = urlsIn(mail.text);
    expect(urls.length, `no link in the invitation:\n${mail.text}`).toBeGreaterThan(0);
    for (const url of urls) {
      expect(url.startsWith(BASE_URL), `${url} in the invitation to ${mount.host}'s investor`).toBe(
        true,
      );
    }
  }
});

/* -------------------------------------------------------------------------------------- */
/* One describe per recipe                                                                  */
/* -------------------------------------------------------------------------------------- */

for (const mount of MOUNTS) {
  /*
   * Plain `describe` on the outside so the stand-alone checks and the investor's journey do not
   * skip each other on a failure; `serial` inside, because each step of the journey needs the
   * session the previous one established.
   */
  test.describe(`${mount.name}: ${mount.host}${mount.prefix} (${mount.shape})`, () => {
    test("the host site's own page sets its Path=/ cookie", async ({ page, context }) => {
      const response = await page.goto(`${mountOrigin(mount)}/`);
      expect(response?.status(), mount.recipe).toBe(200);
      await expect(page).toHaveTitle(/^Acme/u);
      const cookies = await context.cookies(mountOrigin(mount));
      expect(cookies.map((c) => c.name)).toContain(HOST_COOKIE);
    });

    test("both root forms serve the portal under the mount", async ({ page }) => {
      for (const form of [mountUrl(mount), mountUrl(mount, "/")]) {
        const response = await page.goto(form);
        expect(response?.ok(), `${form} via ${mount.recipe}`).toBe(true);
        // The host owns its transport policy: a mounted response never carries the portal's HSTS.
        expect(response?.headers()["strict-transport-security"], form).toBeUndefined();
        // The document is presented under the *public* base, whatever the portal's own is.
        expect(page.url().startsWith(mountUrl(mount)), page.url()).toBe(true);
        const config = await webConfig(page);
        expect(config.basePath).toBe(mount.prefix);
        expect(config.routerBase.startsWith(mount.prefix)).toBe(true);
        expect(config.apiBase.startsWith(mount.prefix)).toBe(true);
        expect(config.canonicalOrigin.startsWith(mountOrigin(mount))).toBe(true);
        const assets = await documentAssetUrls(page);
        expect(assets.length).toBeGreaterThan(0);
        for (const url of assets)
          expect(url.startsWith(mountUrl(mount, "/assets/")), url).toBe(true);
      }
    });

    test.describe
      .serial("an investor through the mount", () => {
        const investor = investorFor(mount);
        let context: BrowserContext;
        let page: Page;
        let traffic: ReturnType<typeof recordTraffic>;
        /** Where the portal's traffic starts (after the host's own page and its scripts). */
        let portalFrom = 0;

        test.beforeAll(async ({ browser }) => {
          context = await browser.newContext({ ignoreHTTPSErrors: true });
          page = await context.newPage();
          traffic = recordTraffic(page);
          // The host's own page first, as a visitor would arrive: it sets the Path=/ cookie whose
          // forwarding the echo step checks.
          await page.goto(`${mountOrigin(mount)}/`);
        });

        test.afterAll(async () => {
          await context?.close();
        });

        test("an investor signs in through the mount and lands on the portal home there", async () => {
          test.setTimeout(120_000);
          portalFrom = traffic.requests.length;
          await page.goto(mountUrl(mount, "/login"));
          await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
          const before = new Date(Date.now() - 1000);
          await requestCode(page, investor.email);
          const mail = await waitForMail(investor.email, { subject: /code/iu, after: before });
          const verified = page.waitForResponse((r) => r.url().includes("/auth/otp/verify"), {
            timeout: 30_000,
          });
          await expectCodeScreen(page);
          await page.getByRole("textbox").first().fill(codeFrom(mail.text));
          const verifyResponse = await verified;
          expect(verifyResponse.status(), await verifyResponse.text()).toBe(200);
          expect(verifyResponse.url().startsWith(mountUrl(mount, "/"))).toBe(true);

          // The cookie as the server set it: `__Secure-` (a non-root Path rules out `__Host-`),
          // scoped to the mount's prefix — not to BASE_PATH, which the browser never sees here.
          const setCookies = (await verifyResponse.headersArray())
            .filter((h) => h.name.toLowerCase() === "set-cookie")
            .map((h) => h.value);
          const session = setCookies.find((c) => c.startsWith(`${MOUNTED_SESSION_COOKIE}=`));
          expect(
            session,
            `no ${MOUNTED_SESSION_COOKIE} in ${JSON.stringify(setCookies)}`,
          ).toBeDefined();
          expect(session).toMatch(new RegExp(`;\\s*Path=${mount.prefix}(;|$)`, "iu"));
          expect(session).toMatch(/;\s*Secure/iu);
          expect(session).toMatch(/;\s*HttpOnly/iu);
          expect(session).toMatch(/;\s*SameSite=Lax/iu);
          expect(session).not.toMatch(/Partitioned/iu);
          expect(setCookies.some((c) => c.startsWith("__Host-"))).toBe(false);

          await passAcceptanceGate(page);
          expect(page.url().startsWith(mountUrl(mount, "/"))).toBe(true);

          // The browser stored it on the host site's origin, and the portal's own origin has nothing.
          // Not `cookies(url)`: that filters by path too, and `https://host/` is not under the prefix.
          const jar = (await context.cookies()).filter((c) => c.domain === mount.host);
          const stored = jar.find((c) => c.name === MOUNTED_SESSION_COOKIE);
          expect(stored, JSON.stringify(jar)).toBeDefined();
          expect(stored?.domain).toBe(mount.host);
          expect(stored?.path).toBe(mount.prefix);
          expect(stored?.secure).toBe(true);
          expect(stored?.httpOnly).toBe(true);
          expect(stored?.sameSite).toBe("Lax");
          expect((await context.cookies()).filter((c) => c.domain === PORTAL_HOST)).toEqual([]);
        });

        test("a lazy route loads its chunks from the mount, and its deep link reloads", async () => {
          const before = traffic.requests.length;
          await page
            .getByRole("link", { name: /Updates/u })
            .first()
            .click();
          await expect(page).toHaveURL((url) => url.href.startsWith(mountUrl(mount, "/updates")));
          await expect(page.getByRole("heading", { level: 1, name: /Updates/u })).toBeVisible();

          // Every script the page ever loaded came from `<mount>/assets/`: the entry (rewritten by
          // the server) and every lazy chunk and preload (resolved by the chunk itself).
          // (Only `/assets/` URLs: the host's own page may still be loading its scripts — WordPress
          // fetches its emoji script after `load`.)
          const scripts = traffic.requests
            .slice(portalFrom)
            .filter((u) => /\/assets\/[^?]+\.m?js(\?|$)/u.test(u));
          expect(scripts.length).toBeGreaterThan(1);
          for (const url of scripts) {
            expect(url.startsWith(mountUrl(mount, "/assets/")), `${url} (${mount.recipe})`).toBe(
              true,
            );
          }
          expect(traffic.requests.slice(before).length).toBeGreaterThan(0);

          await page.reload();
          await expect(page.getByRole("heading", { level: 1, name: /Updates/u })).toBeVisible();
          await page.goto(mountUrl(mount, "/updates"));
          await expect(page.getByRole("heading", { level: 1, name: /Updates/u })).toBeVisible();

          // The browser never talked to the portal's own origin, and nothing 404'd on the host.
          expect(traffic.requests.filter((u) => u.startsWith(PORTAL_ORIGIN))).toEqual([]);
          expect(traffic.failures.filter((f) => f.includes("/assets/"))).toEqual([]);
          // Nothing the browser got through the mount — documents, API, assets — carried HSTS.
          expect(
            traffic.hsts,
            "mounted responses must not carry Strict-Transport-Security",
          ).toEqual([]);
        });

        test(`the recipe forwards ${mount.filtersHostCookies ? "only the portal's cookies" : "the host's cookies too (documented)"}`, async () => {
          const response = await page.goto(mountUrl(mount, ECHO_PATH));
          expect(response?.status()).toBe(200);
          const echo = parseEcho(await page.locator("body").innerText());
          expect(echo["x-forwarded-prefix"], "X-Forwarded-Prefix").toBe(mount.prefix);
          expect(echo["x-forwarded-host"], "X-Forwarded-Host").toBe(mount.host);
          expect(echo["x-forwarded-proto"], "X-Forwarded-Proto").toBe("https");
          expect(echo["path"]).toBe(`/investors${ECHO_PATH}`);

          const forwarded = cookieNames(echo["cookie"] ?? "");
          expect(forwarded).toContain(MOUNTED_SESSION_COOKIE);
          if (mount.filtersHostCookies) {
            // Only the portal's own cookies (the session, and the device cookie sign-in sets).
            for (const name of forwarded) {
              expect(name, "the host site's cookies must not reach the portal").toMatch(
                PORTAL_COOKIE,
              );
            }
            expect(forwarded).not.toContain(HOST_COOKIE);
          } else {
            // Not a virtue: the recipe cannot filter, and the docs tell the site owner so.
            expect(forwarded).toContain(HOST_COOKIE);
          }

          // The edge answers the echo *with* HSTS, standing in for a portal edge that adds it. The
          // filtering recipes drop it (the host owns its transport policy); the plain proxies pass
          // it through, which the docs tell the site owner to strip in their own config.
          const sts = response?.headers()["strict-transport-security"];
          if (mount.filtersHostCookies) expect(sts, "the recipe must strip HSTS").toBeUndefined();
          else expect(sts).toBeDefined();

          // The Worker recipe appends Cloudflare's CF-Connecting-IP to X-Forwarded-For.
          if (mount.name === "worker") {
            const client = echo["cf-connecting-ip"] ?? "";
            expect(client, "the edge stands in for Cloudflare and sets CF-Connecting-IP").not.toBe(
              "",
            );
            expect(echo["x-forwarded-for"]?.split(",")[0]?.trim()).toBe(client);
          }
        });

        test("signing out is a POST through the mount that CSRF accepts", async () => {
          await page.goto(mountUrl(mount, "/"));
          await expect(page.getByRole("heading", { name: /^Welcome/u })).toBeVisible();
          const logout = page.waitForResponse(
            (r) => r.url().endsWith("/auth/logout") && r.request().method() === "POST",
          );
          await page.getByRole("button", { name: "Account" }).click();
          await page.getByRole("menuitem", { name: /Sign out/u }).click();
          const response = await logout;
          expect(response.status(), await response.text()).toBe(200);
          expect(response.url().startsWith(mountUrl(mount, "/"))).toBe(true);
          await expect(page).toHaveURL(/\/login/u);
          expect(page.url().startsWith(mountUrl(mount, "/"))).toBe(true);
          const jar = (await context.cookies()).filter((c) => c.domain === mount.host);
          expect(jar.find((c) => c.name === MOUNTED_SESSION_COOKIE)).toBeUndefined();
        });
      });
  });
}

/* -------------------------------------------------------------------------------------- */
/* The owner's half, once, on the replace-shape mount                                       */
/* -------------------------------------------------------------------------------------- */

test.describe
  .serial("owner through caddy.test/portal (replace shape): step-up and an invitation", () => {
    const mount = MOUNTS.find((m) => m.shape === "replace") as Mount;
    const invitee = "through-the-mount@example.com";

    test("a step-up and an admin write through the mount, and the email links to BASE_URL", async ({
      browser,
    }) => {
      test.setTimeout(150_000);
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      const page = await context.newPage();
      try {
        await page.goto(mountUrl(mount, "/login"));
        const before = new Date(Date.now() - 1000);
        await requestCode(page, OWNER.email);
        const mail = await waitForMail(OWNER.email, { subject: /code/iu, after: before });
        await expectCodeScreen(page);
        await page.getByRole("textbox").first().fill(codeFrom(mail.text));
        await expect(page.getByRole("heading", { level: 1, name: /^Welcome/u })).toBeVisible({
          timeout: 20_000,
        });

        // The second factor, through the mount's step-up screen (a POST CSRF has to accept).
        await page.goto(mountUrl(mount, "/auth/step-up?returnTo=%2Fadmin"));
        await page.getByRole("tab", { name: "Authenticator" }).click();
        state.lastCode = await freshTotpCode(state.totpSecret, state.lastCode);
        saveState();
        await page.getByRole("textbox").first().fill(state.lastCode);
        await expect(page).toHaveURL((url) => url.href.startsWith(mountUrl(mount, "/admin")));

        // An invitation sent from the mounted page: the request carries the mount's Origin and
        // X-Forwarded-Prefix, and the link in the mail must still be BASE_URL's.
        const { apiBase } = await webConfig(page);
        const status = await page.evaluate(
          async ({ url, email }) => {
            const res = await fetch(url, {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ invites: [{ email, displayName: "Through The Mount" }] }),
            });
            return res.status;
          },
          { url: `${mountOrigin(mount)}${apiBase}/api/v1/access/invites`, email: invitee },
        );
        expect(status).toBeLessThan(300);

        const invitation = await waitForMail(invitee, { subject: /invit/iu });
        const urls = urlsIn(invitation.text);
        expect(urls.length, invitation.text).toBeGreaterThan(0);
        for (const url of urls) {
          expect(url.startsWith(BASE_URL), url).toBe(true);
          expect(url.includes(mount.host), url).toBe(false);
        }
      } finally {
        await context.close();
      }
    });
  });
