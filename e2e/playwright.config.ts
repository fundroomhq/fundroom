import { defineConfig, devices } from "@playwright/test";
import { firefoxLocalDomains, HTTP_PORT, HTTPS_PORT, hostResolverRules } from "./fixtures/hosts.js";
import { pathmountResolverRules } from "./fixtures/pathmount.js";

/*
 * Runs against a booted stack (`pnpm --filter @fundroom/e2e stack:up`, or CI's
 * `docker compose -f deploy/compose/compose.ci.yaml up -d --wait`). The suite is ordered:
 * the first-run wizard must complete before sign-in works, so files run serially in one
 * worker and `setup.test.ts` sorts first.
 */

/** The two specs that need their own stack, and the variables that opt into them. */
const ACME_SPEC = "**/10-custom-domains.test.ts";
const HOSTS_SPEC = "**/20-embed-hosts.test.ts";
const PATHMOUNT_SPEC = "**/50-path-mount.test.ts";

/**
 * What the default run leaves out.
 *
 * `10-custom-domains` needs a different stack, not an addition to this one: compose.acme.yaml
 * sets TENANCY_MODE=multi (nothing else resolves a Host header that is not the canonical host)
 * and adds a local ACME CA, while `00-setup` asserts the install is single-tenant. So it is out
 * of the default run and opted into by `pnpm --filter @fundroom/e2e test:acme`.
 *
 * `20-embed-hosts` is out for the same kind of reason: compose.hosts.yaml sets
 * `BASE_URL=https://portal.test` and puts an edge in front, because a host page has to be
 * genuinely cross-site to the portal for any of it to mean anything, and `00-setup` drives a
 * wizard on `http://localhost:3000`. `pnpm --filter @fundroom/e2e test:hosts` opts in.
 *
 * `50-path-mount` likewise: compose.pathmount.yaml runs the portal under `BASE_PATH=/investors`
 * behind an edge and five host proxies (E3.9). `pnpm --filter @fundroom/e2e test:pathmount`.
 */
const ignored = [
  ...(process.env["E2E_ACME"] === undefined ? [ACME_SPEC] : []),
  ...(process.env["E2E_HOSTS"] === undefined ? [HOSTS_SPEC] : []),
  ...(process.env["E2E_PATHMOUNT"] === undefined ? [PATHMOUNT_SPEC] : []),
];

/**
 * Chromium resolves the rig's hostnames itself; Firefox needs the same thing said in its own
 * dialect, and can only say it while the edge is on the default ports (`fixtures/hosts.ts`).
 * Registering the project conditionally rather than letting it fail is deliberate: a Firefox run
 * that silently tried to resolve `host-a.test` on the public internet would time out with a DNS
 * error and read as a product failure.
 *
 * The two projects are run one at a time (`test:hosts`, then `test:hosts:firefox`) with the stack
 * reset in between, not as one `playwright test` invocation: the spec drives a first-run install
 * — it creates the owner, invites the investors and sets the allow-list — so the second project
 * to start would find a stack that is already set up and refuse it.
 */
const hostsBrowsers = [
  {
    name: "hosts-chromium",
    testMatch: HOSTS_SPEC,
    use: {
      ...devices["Desktop Chrome"],
      launchOptions: { args: [`--host-resolver-rules=${hostResolverRules()}`] },
    },
  },
  ...(HTTPS_PORT === 443 && HTTP_PORT === 80
    ? [
        {
          name: "hosts-firefox",
          testMatch: HOSTS_SPEC,
          use: {
            ...devices["Desktop Firefox"],
            launchOptions: {
              firefoxUserPrefs: { "network.dns.localDomains": firefoxLocalDomains() },
            },
          },
        },
      ]
    : []),
  /*
   * WebKit is deliberately absent, and that absence is the honest answer rather than a gap.
   *
   * Two reasons, and the second is the one that matters. First, Playwright's WebKit has no
   * resolver override — no `--host-resolver-rules`, no `network.dns.localDomains` — so the rig's
   * hostnames could only be reached by editing `/etc/hosts`, which needs root and outlives the
   * run. Second, and regardless: Playwright's WebKit is not Safari. It does not reproduce ITP,
   * the Storage Access prompt, or Safari's own CHIPS behaviour, so a green WebKit run would
   * assert that *something* works and be read as "Safari works" — which is the one thing about
   * third-party cookies nobody should infer from a headless build.
   *
   * design/08 §8 asks for weekly real-Safari runs on a device cloud for exactly the scenarios in
   * this file; `e2e/hosts/README.md` §"The Safari gap" records what that run has to cover and
   * what to add here once it exists.
   */
];

/**
 * The path-mount rig (E3.9): Chromium only, with its own resolver rules for `portal.test` and the
 * five host sites. One engine is enough here — what is under test is five proxies and the app's
 * per-request presentation, not browser cookie policy (a `SameSite=Lax` first-party cookie on
 * the host's own origin behaves the same everywhere); 20-embed-hosts carries the cross-engine
 * cookie coverage.
 */
const pathmountBrowsers = [
  {
    name: "pathmount-chromium",
    testMatch: PATHMOUNT_SPEC,
    use: {
      ...devices["Desktop Chrome"],
      launchOptions: { args: [`--host-resolver-rules=${pathmountResolverRules()}`] },
    },
  },
];

/**
 * The ZAP browser crawl (`.github/workflows/zap.yml`):
 * Chromium through a ZAP daemon proxy, registered only when ZAP_PROXY names one — the spec is
 * meaningless without it, and the `chromium` project never runs it. baseURL is the app's origin
 * INSIDE its network namespace, where the proxy lives, not E2E_BASE_URL: that keeps the browser in
 * a secure context and every URL in ZAP's scope. Chromium bypasses the proxy for loopback unless
 * `<-loopback>` removes that implicit rule, and here loopback is the whole point.
 */
const ZAP_SPEC = "**/zap-crawl.test.ts";
const zapCrawl = process.env["ZAP_PROXY"]
  ? [
      {
        name: "zap-crawl",
        testMatch: ZAP_SPEC,
        use: {
          ...devices["Desktop Chrome"],
          baseURL: "http://localhost:3000",
          proxy: { server: process.env["ZAP_PROXY"] },
          launchOptions: { args: ["--proxy-bypass-list=<-loopback>"] },
        },
      },
    ]
  : [];

export default defineConfig({
  testDir: "./tests",
  testIgnore: ignored,
  outputDir: "./test-results",
  fullyParallel: false,
  workers: 1,
  retries: process.env["CI"] ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: process.env["E2E_BASE_URL"] ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    /*
     * Everything except the embed-host spec, which needs a browser launched with a resolver
     * override and would otherwise run here a second time with no way to reach `host-a.test`.
     *
     * The list repeats `ignored` rather than adding to it: a project's `testIgnore` *replaces*
     * the top-level one instead of merging with it, so naming only the embed spec here would
     * quietly put the ACME spec back into the default run.
     */
    {
      name: "chromium",
      testIgnore: [...ignored, HOSTS_SPEC, PATHMOUNT_SPEC, ZAP_SPEC],
      use: { ...devices["Desktop Chrome"] },
    },
    ...hostsBrowsers,
    ...pathmountBrowsers,
    ...zapCrawl,
  ],
});
