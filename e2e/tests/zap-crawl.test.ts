import { type BrowserContext, expect, type Page, test } from "@playwright/test";

/*
 * Pass 6 of the ZAP DAST job (`.github/workflows/zap.yml`): a real Chromium
 * walks the admin and investor navigation THROUGH a ZAP daemon proxy, so ZAP's passive rules see
 * every document, asset and API response the SPA actually loads, with the real ids it fetches.
 * ZAP 2.17's own spiders (client spider, AJAX spider) stall after the first `GET /me`.
 *
 * Only in project `zap-crawl`, which the config registers only when ZAP_PROXY is set. Needs:
 *   ZAP_PROXY        the daemon's published port, e.g. http://127.0.0.1:8090 (compose service
 *                    `zap-proxy`, .zap/compose.zap.yaml). Also its API.
 *   ZAP_API_KEY      the daemon's API key: a random value generated per run and given to both
 *                    the daemon and this spec (`openssl rand -hex 32`). Sent as `X-ZAP-API-Key`.
 *   OWNER_COOKIE     `__Host-sid=…` from `e2e/security/session.mjs --populate` (owner, level 2)
 *   INVESTOR_COOKIE  the same for an active investor (level 1)
 *   ZAP_REPORT_DIR   where ZAP (inside its container) writes the reports; default /zap/wrk/reports,
 *                    which the overlay mounts from .zap/reports — `zap-gate.mjs` reads them there.
 *
 * The browser is pointed at http://localhost:3000, the origin INSIDE the app's network namespace
 * (the proxy resolves `localhost` there). That keeps the browser in a secure context and every URL
 * the app emits in scope. Chromium never proxies loopback unless told to: `<-loopback>` in the
 * project's `--proxy-bypass-list`. Nothing here clicks buttons: the crawl only follows links, so
 * it cannot sign out, delete or send anything (a "sign out" link is skipped by name and path).
 */

const ORIGIN = "http://localhost:3000";
const ZAP = (process.env["ZAP_PROXY"] ?? "http://127.0.0.1:8090").replace(/\/+$/u, "");
const ZAP_API_KEY = process.env["ZAP_API_KEY"] ?? "";
const REPORT_DIR = process.env["ZAP_REPORT_DIR"] ?? "/zap/wrk/reports";
/** Pages per role, and how many concrete URLs of one route shape (`/people/:id`) to visit. */
const MAX_PAGES = Number(process.env["ZAP_CRAWL_MAX_PAGES"] ?? 150);
const PER_SHAPE = 3;

/** Never followed: leaving the session, the API itself, downloads, embed documents, auth flows. */
const SKIP =
  /\/(?:auth|api|embed)\/|sign-?out|log-?out|\/logout|\.(?:csv|pdf|zip|json|xml|txt)(?:$|\?)|download|export/iu;
const SKIP_TEXT = /sign out|log out/iu;

async function zap<T = Record<string, unknown>>(
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${ZAP}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // Straight to the daemon, not through it: Node's fetch ignores the browser's proxy settings.
  // The key goes in a header, never the query string (ZAP logs and history record URLs).
  const res = await fetch(url, { headers: { "X-ZAP-API-Key": ZAP_API_KEY } });
  const text = await res.text();
  if (!res.ok) throw new Error(`ZAP ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

/** The part of a URL that names a route: ids (uuids, long hex/base62 tokens, numbers) as `:id`. */
function shape(url: URL): string {
  return url.pathname
    .split("/")
    .map((seg) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-/iu.test(seg) ||
      /^\d+$/u.test(seg) ||
      /^[A-Za-z0-9_-]{20,}$/u.test(seg)
        ? ":id"
        : seg,
    )
    .join("/");
}

/** `__Host-sid=value` → a host-only, Secure cookie for http://localhost (a secure context). */
async function signIn(context: BrowserContext, cookieHeader: string | undefined): Promise<void> {
  if (!cookieHeader) throw new Error("OWNER_COOKIE / INVESTOR_COOKIE not set: run session.mjs");
  const cookies = cookieHeader.split(/;\s*/u).map((pair) => {
    const i = pair.indexOf("=");
    return {
      name: pair.slice(0, i),
      value: pair.slice(i + 1),
      domain: "localhost",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax" as const,
    };
  });
  await context.addCookies(cookies);
}

/** A member's first visit may show the acceptance gate (ADR-0037); agree so the portal renders. */
async function passGateIfShown(page: Page): Promise<void> {
  const gate = page.getByRole("heading", { name: "Before you go in" });
  if (await gate.isVisible().catch(() => false)) {
    await page.getByRole("checkbox", { name: /I have read and agree/u }).click();
    await page.getByRole("button", { name: "Agree and continue" }).click();
    await expect(gate).toBeHidden({ timeout: 20_000 });
  }
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await expect(page.getByText("Loading…", { exact: true }))
    .toHaveCount(0, { timeout: 10_000 })
    .catch(() => undefined);
}

/** Breadth-first over same-origin links from `start`. Returns the paths visited. */
async function crawl(page: Page, start: string): Promise<string[]> {
  const queue = [new URL(start, ORIGIN)];
  const seen = new Set<string>(queue.map((u) => u.pathname + u.search));
  const shapes = new Map<string, number>();
  const visited: string[] = [];
  while (queue.length > 0 && visited.length < MAX_PAGES) {
    const url = queue.shift() as URL;
    const s = shape(url);
    if ((shapes.get(s) ?? 0) >= PER_SHAPE) continue;
    shapes.set(s, (shapes.get(s) ?? 0) + 1);
    const res = await page.goto(url.href, { waitUntil: "domcontentloaded" }).catch(() => null);
    if (res === null) continue;
    await passGateIfShown(page);
    await settle(page);
    if (/\/login(?:$|\?)/u.test(page.url())) {
      throw new Error(`the session ended while crawling (at ${url.pathname}): redirected to login`);
    }
    visited.push(url.pathname + url.search);
    const links = await page.$$eval("a[href]", (as) =>
      as.map((a) => ({ href: (a as HTMLAnchorElement).href, text: a.textContent ?? "" })),
    );
    for (const { href, text } of links) {
      let next: URL;
      try {
        next = new URL(href);
      } catch {
        continue;
      }
      if (next.origin !== ORIGIN || SKIP.test(next.pathname + next.search) || SKIP_TEXT.test(text))
        continue;
      next.hash = "";
      const key = next.pathname + next.search;
      if (seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return visited;
}

/** Passive scanning runs behind the proxy; the report is only complete once its queue is empty. */
async function passiveScanDrained(): Promise<void> {
  const deadline = Date.now() + 300_000;
  for (;;) {
    const { recordsToScan } = await zap<{ recordsToScan: string }>(
      "/JSON/pscan/view/recordsToScan/",
    );
    if (recordsToScan === "0") return;
    if (Date.now() > deadline) throw new Error(`passive scan still has ${recordsToScan} records`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function report(role: string, visited: string[]): Promise<void> {
  await passiveScanDrained();
  const { urls } = await zap<{ urls: string[] }>("/JSON/core/view/urls/", { baseurl: ORIGIN });
  const { numberOfMessages } = await zap<{ numberOfMessages: string }>(
    "/JSON/core/view/numberOfMessages/",
    { baseurl: ORIGIN },
  );
  await zap("/JSON/reports/action/generate/", {
    title: `fundroom ${role} crawl`,
    template: "traditional-json",
    sites: ORIGIN,
    reportDir: REPORT_DIR,
    reportFileName: `${role}-crawl.json`,
  });
  await zap("/JSON/reports/action/generate/", {
    title: `fundroom ${role} crawl`,
    template: "traditional-html",
    sites: ORIGIN,
    reportDir: REPORT_DIR,
    reportFileName: `${role}-crawl.html`,
  });
  const line = `${role}: ${visited.length} pages visited, ZAP saw ${urls.length} URLs in ${numberOfMessages} messages`;
  process.stdout.write(`[zap-crawl] ${line}\n  ${visited.join("\n  ")}\n`);
  test.info().annotations.push({ type: "zap-crawl", description: line });
  // Next role starts from an empty site tree, so each report and URL count is its own.
  await zap("/JSON/core/action/newSession/", { overwrite: "true" });
}

test.describe("ZAP crawl through the proxy", () => {
  test.describe.configure({ mode: "serial", timeout: 15 * 60_000 });

  test.beforeAll(async () => {
    if (ZAP_API_KEY.length < 32)
      throw new Error("ZAP_API_KEY not set: the zap-proxy daemon's per-run API key (32+ chars)");
    const { version } = await zap<{ version: string }>("/JSON/core/view/version/");
    process.stdout.write(`[zap-crawl] ZAP ${version} at ${ZAP}\n`);
    await zap("/JSON/core/action/newSession/", { overwrite: "true" });
  });

  for (const role of ["owner", "investor"] as const) {
    test(`${role}: walk the navigation, then report`, async ({ context, page }) => {
      await signIn(
        context,
        role === "owner" ? process.env["OWNER_COOKIE"] : process.env["INVESTOR_COOKIE"],
      );
      const visited = await crawl(page, role === "owner" ? "/admin" : "/");
      expect(visited.length, "the crawl reached more than its start page").toBeGreaterThan(1);
      const me = await context.request.get(`${ORIGIN}/api/v1/me`);
      expect(me.status(), "the session survived the crawl").toBe(200);
      await report(role, visited);
    });
  }
});
