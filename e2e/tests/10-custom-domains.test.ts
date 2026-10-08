import { expect, test } from "@playwright/test";
import {
  APP_URL,
  Api,
  CADDY_HTTPS_PORT,
  CHALLENGE_LABEL,
  CNAME_TARGET,
  CUSTOM_HOST,
  edgeCertificate,
  edgeGet,
  publishCname,
  publishTxt,
  type ServedConfig,
  servedConfig,
  until,
} from "../fixtures/acme.js";
import { freshTotpCode, OWNER, SETUP_TOKEN } from "../fixtures/stack.js";

/*
 * A workspace portal on the customer's own hostname, end to end (EXECUTION_PLAN §9.2, E2.1,
 * design/07 §2, ADR-0039, docs/runbooks/custom-domains.md) against the real image, a real
 * Caddy doing on-demand TLS, and a real ACME CA — a local Pebble, so the certificate is
 * genuinely issued over RFC 8555 rather than stubbed.
 *
 * Runs against `deploy/compose/compose.acme.yaml` layered on the CI stack, which is a separate
 * stack from the one `00-setup` drives: `TENANCY_MODE=multi` is what makes a Host header other
 * than the canonical one resolve a workspace at all, and `00-setup` asserts the install is
 * single-tenant. So this file creates its own owner — over the API rather than the wizard,
 * because the wizard is `00-setup`'s subject and re-driving it here would test it twice and
 * the domain flow once.
 *
 * What the integration suite already covers and this file therefore does not dwell on: the
 * derived records, every state transition, the claim indexes, the rejections
 * (`apps/server/src/domains.integration.test.ts`). What only a real stack can show is the last
 * two steps of §9.2, and they are the reason this exists:
 *
 *   1. `ask` refuses issuance for a hostname that has not verified, and allows it once DNS
 *      says what it was asked to say — the gate that stops a stray CNAME minting certificates.
 *   2. The portal then answers on that hostname over HTTPS, presenting a certificate that
 *      chains to *this stack's CA* and names the host, and resolves the right workspace —
 *      which is also the only thing that promotes the row to `active` (there is deliberately
 *      no `dns_ok → active` edge in the state machine; being served is the transition).
 *
 * The DNS both halves read is one zone in one place: `pebble-challtestsrv`, published to by
 * this test through its management API. Pebble resolves the hostname through it (`-dnsserver`)
 * to find the edge, and the app reads it through the DoH-JSON shim that `DOH_ENDPOINTS` names.
 * Nothing can verify here that the CA could not also see.
 */

/*
 * Browser options for the one browser test at the bottom of this file. `launchOptions` has to
 * be file-level — Playwright refuses it inside a `describe` because it forces a new worker —
 * and it costs the API-driven tests above nothing, because none of them opens a page.
 *
 * `--host-resolver-rules` makes Chromium resolve the hostname under test to the edge's
 * published port instead of consulting DNS, so the address bar reads
 * `https://investors.acme-e2e.example.com/` with no port and the request arrives carrying the
 * Host header the app has to classify. `ignoreHTTPSErrors` because Chromium cannot be taught
 * Pebble's root without an NSS store — the certificate is verified properly, against that
 * root and with the identity check pinned to the hostname, in the Node handshake below.
 */
test.use({
  ignoreHTTPSErrors: true,
  launchOptions: {
    args: [`--host-resolver-rules=MAP ${CUSTOM_HOST} 127.0.0.1:${CADDY_HTTPS_PORT}`],
  },
});

const api = new Api(APP_URL);

interface DnsInstruction {
  readonly type: "CNAME" | "TXT" | "A";
  readonly name: string;
  readonly value: string;
  readonly required: boolean;
}
interface CustomDomain {
  readonly id: string;
  readonly hostname: string;
  readonly status: "pending" | "dns_ok" | "active" | "failed";
  readonly records: readonly DnsInstruction[];
  readonly detail: string | null;
  readonly activatedAt: string | null;
  readonly dnsOkAt: string | null;
}

/** The workspace-scoped API base. In multi mode the canonical host resolves no workspace, so
 *  every workspace call carries the slug in the path (the other spelling is the slug host). */
const W = `/w/${OWNER.slug}/api/v1`;

let domain: CustomDomain;
let token = "";
/** The enrolled TOTP secret and the last code the server accepted (replays are refused). */
let totpSecret = "";
let lastCode = "";

test.describe
  .serial("a workspace portal on a custom domain", () => {
    test("the stack is the multi-tenant one, un-set-up, with the ACME rig up", async () => {
      const status = await api.ok<{ required: boolean; tenancy: string }>(
        "GET",
        "/api/v1/setup/status",
      );
      expect(status.tenancy, "compose.acme.yaml must set TENANCY_MODE=multi").toBe("multi");
      expect(
        status.required,
        "this file needs a fresh stack: pnpm --filter @fundroom/e2e stack:down:acme && stack:up:acme",
      ).toBe(true);

      const ready = await fetch(`${APP_URL}/readyz`);
      expect(ready.status, await ready.text()).toBe(200);

      // The fake zone is reachable and writable — the half of the rig this test drives
      // directly, and worth failing on here rather than three tests later as "DNS said no".
      // `/readyz` deliberately does not cover it: the DoH resolver has a `healthCheck`, but
      // readiness does not call it, so that a resolver outage cannot take the portal red. That
      // the app can read this zone back through the shim is what the verification below proves.
      await publishTxt("_rig-check.acme-e2e.example.com", "ok");
    });

    test("an owner is created with a level-2, fresh session", async () => {
      await api.ok("POST", "/api/v1/setup/owner", {
        token: SETUP_TOKEN,
        email: OWNER.email,
        displayName: OWNER.name,
        workspaceName: OWNER.workspace,
        workspaceSlug: OWNER.slug,
      });

      // Adding a domain is a step-up action (design/02 §78), and an owner needs level 2 for
      // anything at all — so enrolling the second factor is not setup dressing here, it is the
      // thing that makes the next three tests possible. Confirming enrolment *is* the step-up.
      const enrol = await api.ok<{ secretBase32: string }>("POST", "/api/v1/auth/totp/enrol");
      totpSecret = enrol.secretBase32.replace(/\s+/gu, "");
      lastCode = await freshTotpCode(totpSecret);
      await api.ok("POST", "/api/v1/auth/totp/enrol/confirm", { code: lastCode });

      const list = await api.ok<{ domains: unknown[]; cnameTarget: string }>("GET", `${W}/domains`);
      expect(list.domains).toEqual([]);
      expect(list.cnameTarget).toBe(CNAME_TARGET);
    });

    test("a new domain is pending, names both records, and is refused a certificate", async () => {
      domain = await api.ok<CustomDomain>("POST", `${W}/domains`, { hostname: CUSTOM_HOST }, 201);
      expect(domain.hostname).toBe(CUSTOM_HOST);
      expect(domain.status).toBe("pending");

      const cname = domain.records.find((r) => r.type === "CNAME");
      const txt = domain.records.find((r) => r.type === "TXT");
      expect(cname?.value).toBe(CNAME_TARGET);
      expect(txt?.name).toBe(`${CHALLENGE_LABEL}.${CUSTOM_HOST}`);
      expect(txt?.value).toBeTruthy();
      token = txt?.value ?? "";

      /*
       * The gate. `ask` is what Caddy consults before it will request a certificate for a
       * hostname it has never seen, and a `pending` row must not open it — otherwise anyone who
       * can point a CNAME at this edge can make it place ACME orders on their behalf.
       *
       * Asked here directly on the app's port, because the edge refuses `/internal/*` from
       * outside on purpose (a public `ask` is a domain-enumeration oracle); that refusal is the
       * last assertion in this file.
       */
      const refused = await fetch(`${APP_URL}/internal/tls/ask?domain=${CUSTOM_HOST}`);
      expect(refused.status, "ask must not allow issuance for an unverified hostname").toBe(404);
    });

    test("publishing the two records verifies the domain and unlocks issuance", async () => {
      // Longer than the default 60 s: the `ask` poll below has to be able to outlast the
      // lookup cache's 60 s negative entry.
      test.setTimeout(150_000);
      await publishCname(CUSTOM_HOST, CNAME_TARGET);
      await publishTxt(`${CHALLENGE_LABEL}.${CUSTOM_HOST}`, token);

      // "Verify now": the same `check()` the five-minute sweep runs, so the button and the job
      // cannot disagree. A missing record is not an error — the row just stays `pending` and
      // `detail` says what DNS actually answered, which is what to read if this fails.
      const verified = await until<CustomDomain>(
        "the domain reaches dns_ok",
        async () => {
          const result = await api.ok<CustomDomain>("POST", `${W}/domains/${domain.id}/verify`);
          // Thrown, not returned as "not yet", so that `until`'s timeout message carries the
          // verifier's own sentence — "no TXT record at …" and "returned a different token" are
          // different problems with different owners, and a bare timeout names neither.
          if (result.status !== "dns_ok") {
            throw new Error(`still ${result.status}: ${result.detail}`);
          }
          return result;
        },
        // Four calls at most: the route allows ten a minute per workspace, and exhausting that
        // would replace the diagnosis above with a 429.
        { timeoutMs: 18_000, intervalMs: 5_000 },
      );
      expect(verified.dnsOkAt).not.toBeNull();
      expect(verified.detail).toContain(CNAME_TARGET);
      expect(verified.detail).toContain(CHALLENGE_LABEL);
      // Verifying can never reach `active` on its own: a certificate cannot exist before the
      // first handshake, so being served is the only promotion.
      expect(verified.status).toBe("dns_ok");
      expect(verified.activatedAt).toBeNull();

      /*
       * `ask` now allows issuance — for `dns_ok`, not only for `active`, which is the
       * asymmetry the whole flow turns on. The poll budget is a minute and a bit because the
       * hostname→workspace lookup caches negative answers for 60 s and the check above asked
       * about this hostname while it was still pending; the runbook makes the same promise to
       * operators ("every change can take up to a minute to be visible at the edge").
       */
      await until(
        "ask allows issuance",
        async () => {
          const res = await fetch(`${APP_URL}/internal/tls/ask?domain=${CUSTOM_HOST}`);
          return res.status === 200 ? true : undefined;
        },
        { timeoutMs: 75_000, intervalMs: 2_000 },
      );
    });

    test("the portal answers on the custom hostname over HTTPS with a CA-issued certificate", async () => {
      // Longer than the default 60 s: this test contains a full ACME order plus two cache
      // waits, and a timeout here should read as "the flow is broken", not "the clock ran out".
      test.setTimeout(240_000);
      /*
       * THE assertion. One TLS handshake to the edge with `investors.acme-e2e.example.com` as
       * the SNI, verified against Pebble's root and *only* Pebble's root, with the identity
       * check pinned to that hostname. It fails if Caddy fell back to its internal CA, if the
       * certificate names something else, or if no certificate could be obtained at all — and
       * Caddy runs the whole ACME order inside this handshake the first time, so a pass means
       * the order was placed, the challenge was served on port 80/443, Pebble validated it
       * against the same zone the app verified against, and the certificate came back.
       */
      const cert = await until(
        "the edge presents a certificate for the custom hostname",
        async () => {
          const seen = await edgeCertificate(CUSTOM_HOST, { timeoutMs: 90_000 });
          return seen.authorized ? seen : undefined;
        },
        { timeoutMs: 120_000, intervalMs: 3_000 },
      );
      expect(cert.authorized, cert.authorizationError).toBe(true);
      // The SAN, not the subject CN: Pebble issues with an empty subject DN, which is what a
      // modern CA does — the CN has been deprecated as an identity for a decade and the SAN
      // is the only field a TLS client is allowed to match on anyway.
      expect(cert.altNames).toContain(CUSTOM_HOST);
      // `authorized` above already says the chain ends at the root this Pebble generated when
      // it started. This names the issuer as well, because the failure it guards against —
      // Caddy quietly falling back to its own internal CA — would otherwise only be visible as
      // a verification error, and "issued by Caddy Local Authority" is the more useful message.
      expect(cert.issuer.toLowerCase()).toContain("pebble");

      /*
       * And it resolves the right workspace. The page the edge returns carries the server's own
       * bootstrap config, which names the workspace the Host header resolved to — so a wrong
       * hostname→workspace mapping, or none, is visible in the body rather than inferred.
       */
      const served = await edgeGet(CUSTOM_HOST, "/");
      expect(served.status).toBe(200);
      const config = servedConfig(served.body);
      expect(config.workspace?.slug).toBe(OWNER.slug);
      expect(config.workspace?.name).toBe(OWNER.workspace);
      expect(config.tenancy).toBe("multi");

      /*
       * Being served is the transition to `active` (E2.1 §9.2): the tenant middleware's
       * hostname lookup fires it, fire-and-forget, so it lands a moment after the response.
       */
      const active = await until<CustomDomain>(
        "the domain becomes active",
        async () => {
          const list = await api.ok<{ domains: CustomDomain[] }>("GET", `${W}/domains`);
          const row = list.domains.find((d) => d.hostname === CUSTOM_HOST);
          return row?.status === "active" ? row : undefined;
        },
        { timeoutMs: 30_000, intervalMs: 1_000 },
      );
      expect(active.activatedAt).not.toBeNull();

      /*
       * An `active` custom domain is the workspace's primary origin (E2.1 decision 5), which
       * is the point of the feature: every link the server mints — emailed ones included — now
       * points here rather than at the slug host. The next page load says so.
       */
      const again = await until(
        "the page names the custom domain as the workspace's own origin",
        async () => {
          const res = await edgeGet(CUSTOM_HOST, "/");
          const seen = servedConfig(res.body).canonicalOrigin;
          return new URL(seen).host === CUSTOM_HOST ? seen : undefined;
        },
        { timeoutMs: 60_000, intervalMs: 2_000 },
      );
      // Not `acme-inc.localhost:3100`, which is what this would say for a workspace with no
      // active domain — so this is `primaryHost` reaching every link the server mints.
      expect(new URL(again).host).toBe(CUSTOM_HOST);
    });

    test("the edge keeps `ask` off the public internet", async () => {
      // The same question that answered 200 on the app's own port, asked through the edge the
      // way a stranger would: refused, because `/internal/*` is the edge's control surface and
      // a public `ask` is a domain-enumeration oracle and a way to put database load on the
      // TLS handshake path. Both halves of the mitigation are required; this is the outer one.
      const res = await edgeGet(CUSTOM_HOST, `/internal/tls/ask?domain=${CUSTOM_HOST}`);
      expect(res.status).toBe(404);
    });
  });

/*
 * The same page in a real browser, over the certificate the CA issued above. Chromium cannot be
 * taught Pebble's root without an NSS store, so this context accepts the chain rather than
 * verifying it — the verification is the Node handshake above, and what this adds is the part
 * only a browser shows: that a document is really served on that hostname, over TLS, and that
 * the config the SPA boots from names the right workspace.
 */
test.describe
  .serial("the custom domain in a browser", () => {
    test("the portal loads on the custom hostname and boots for the right workspace", async ({
      page,
    }) => {
      await page.goto(`https://${CUSTOM_HOST}/`);
      await expect(page).toHaveURL(new RegExp(`^https://${CUSTOM_HOST}/`, "u"));
      await expect(page.locator("body")).not.toBeEmpty();

      // Read from the DOM, so the entities the server escaped are already undone.
      const raw = await page.locator('meta[name="seed-host:config"]').getAttribute("content");
      const config = JSON.parse(raw ?? "{}") as ServedConfig;
      expect(config.workspace?.slug).toBe(OWNER.slug);
      expect(new URL(config.canonicalOrigin).host).toBe(CUSTOM_HOST);
    });
  });
