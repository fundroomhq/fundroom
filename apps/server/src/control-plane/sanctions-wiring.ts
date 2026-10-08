import { lookup as dnsLookup } from "node:dns/promises";
import { join } from "node:path";
import { enqueueBillingCancel } from "@fundroom/billing";
import type { Tx } from "@fundroom/db";
import { createOutboundHttp, type OutboundHttp } from "@fundroom/outbound-http";
import type { ControlPlaneHooks, SanctionsScreeningPort } from "@fundroom/ports";
import {
  createSanctionsJobs,
  createSanctionsService,
  type SanctionsService,
} from "@fundroom/sanctions";
import {
  createOfacScreening,
  DEFAULT_OFAC_MAX_FILE_BYTES,
  defaultOfacRedirectAllowed,
  OFAC_USER_AGENT,
} from "@fundroom/sanctions-ofac";
import { createOpenSanctionsScreening } from "@fundroom/sanctions-opensanctions";
import type { ControlPlaneWiringDeps, WiringKernel } from "./types.js";

/*
 * Sanctions screening (E3.10; owner: agent S) → `container.sanctions`, read by
 * `routes/platform-sanctions.ts`. Builds the `sanctions-ofac` / `sanctions-opensanctions` adapter
 * for SANCTIONS_DRIVER (with its own guarded outbound client) and the `@fundroom/sanctions`
 * service. `enabled`: CONTROL_PLANE=on and SANCTIONS_DRIVER is not `none`.
 *
 * With CONTROL_PLANE=on and no driver the service still exists (port `null`): the operator can
 * read and decide screenings recorded before the driver was turned off, and nothing is screened
 * or held. With CONTROL_PLANE=off there is no service at all.
 *
 * Outbound clients, one per driver, never the general-purpose one:
 *  - `ofac`: the list download. SLS 302-redirects every export to a pre-signed S3 URL, so this
 *    client follows at most ONE redirect, and its resolver only answers for the configured
 *    SANCTIONS_OFAC_URL host and `*.amazonaws.com` (any other redirect target fails as
 *    `dns_failed`, even one exempt from the private-address check); https only in prod (port
 *    443). 2 min and 64 MiB per file. Tests serve from IP literals named in
 *    OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS (ignored in prod).
 *
 *    The guard follows the redirect itself, and vets it first through `redirectAllowed`: the
 *    adapter's rule (the first hop only, https, `*.amazonaws.com`; test hosts by name) — so an
 *    https redirect to an IP literal or any other host fails before it is looked up. The
 *    resolver allowlist stays as a second fence.
 *  - `opensanctions`: one match call — 15 s, 2 MiB, no redirects. yente "does not support
 *    authentication" and belongs on a private network, so the configured host (operator config,
 *    like DATABASE_URL) is exempt from the private-address check; nothing else is.
 */
export interface SanctionsKernel extends WiringKernel {
  readonly enabled: boolean;
  readonly driver: "none" | "ofac" | "opensanctions";
  readonly hooks: ControlPlaneHooks;
  /** The adapter; `null` when disabled. */
  readonly port: SanctionsScreeningPort | null;
  /** `null` with CONTROL_PLANE=off. */
  readonly service: SanctionsService | null;
}

const OFAC_TIMEOUT_MS = 120_000;
const OPENSANCTIONS_TIMEOUT_MS = 15_000;
const OPENSANCTIONS_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function createSanctionsWiring(deps: ControlPlaneWiringDeps): SanctionsKernel {
  const raw = deps.config.raw;
  const driver = raw.SANCTIONS_DRIVER;
  const enabled = deps.controlPlaneEnabled && driver !== "none";
  if (!deps.controlPlaneEnabled) {
    return {
      enabled: false,
      driver,
      hooks: {},
      port: null,
      service: null,
      jobs: [],
      async close() {},
    };
  }
  const log = deps.log("sanctions");
  const testHosts = raw.APP_ENV === "prod" ? [] : (raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS ?? []);
  let outbound: OutboundHttp | undefined;
  let port: SanctionsScreeningPort | null = null;

  if (enabled && driver === "ofac") {
    const listHost = new URL(raw.SANCTIONS_OFAC_URL).hostname.toLowerCase();
    // Hostnames only (an IP literal is never looked up): tests serve from `127.0.0.1`.
    const resolvable = (host: string) => host === listHost || host.endsWith(".amazonaws.com");
    outbound = createOutboundHttp({
      allowPrivate: false,
      allowedPrivateHosts: testHosts,
      ...(raw.APP_ENV === "prod" ? { allowedPorts: [443] } : {}),
      userAgent: OFAC_USER_AGENT,
      timeoutMs: OFAC_TIMEOUT_MS,
      maxResponseBytes: DEFAULT_OFAC_MAX_FILE_BYTES,
      maxConcurrentLookups: 4,
      maxRedirects: 1,
      redirectAllowed: (target, hop) =>
        hop === 1 && (defaultOfacRedirectAllowed(target) || testHosts.includes(target.hostname)),
      lookup: async (host) => {
        if (!resolvable(host.toLowerCase())) {
          throw new Error(`sanctions: ${host} is not an OFAC download host`);
        }
        const results = await dnsLookup(host, { all: true, verbatim: true });
        return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
      },
      log,
    });
    port = createOfacScreening(
      {
        fetch: outbound.fetch,
        baseUrl: raw.SANCTIONS_OFAC_URL,
        apiKey: undefined,
        cacheDir: join(raw.DATA_DIR, "sanctions"),
        now: deps.now,
      },
      {
        redirectAllowed: (target) =>
          defaultOfacRedirectAllowed(target) || testHosts.includes(target.hostname),
        log,
      },
    );
  } else if (enabled && driver === "opensanctions") {
    const base = raw.SANCTIONS_OPENSANCTIONS_URL;
    if (base === undefined)
      throw new Error("SANCTIONS_DRIVER=opensanctions needs SANCTIONS_OPENSANCTIONS_URL");
    outbound = createOutboundHttp({
      allowPrivate: false,
      allowedPrivateHosts: [new URL(base).hostname, ...testHosts],
      userAgent: "fundroom-sanctions-screening/1",
      timeoutMs: OPENSANCTIONS_TIMEOUT_MS,
      maxResponseBytes: OPENSANCTIONS_MAX_RESPONSE_BYTES,
      maxConcurrentLookups: 4,
      maxRedirects: 0,
      log,
    });
    port = createOpenSanctionsScreening(
      {
        fetch: outbound.fetch,
        baseUrl: base,
        apiKey: raw.SANCTIONS_OPENSANCTIONS_API_KEY,
        cacheDir: join(raw.DATA_DIR, "sanctions"),
        now: deps.now,
      },
      // The key goes to the hosted API or a host named for it, nowhere else (config refuses the
      // rest at startup; the adapter applies the same rule).
      { apiKeyHosts: raw.SANCTIONS_OPENSANCTIONS_API_KEY_HOSTS },
    );
  }

  const service = createSanctionsService({
    db: deps.db,
    audit: deps.audit,
    queue: deps.queue,
    port,
    threshold: raw.SANCTIONS_MATCH_THRESHOLD,
    now: deps.now,
    invalidate: () => deps.resolver.invalidate(),
    log,
    // A confirmed match cancels the Stripe subscription (billing's outbox job; the manual
    // driver's operator records it by hand).
    ...(raw.BILLING_DRIVER === "stripe"
      ? {
          onConfirmed: (tx: Tx, workspaceId: string) =>
            enqueueBillingCancel(deps.queue, tx, workspaceId, "sanctions"),
        }
      : {}),
  });
  return {
    enabled,
    driver,
    hooks: service.hooks,
    port,
    service,
    jobs: enabled ? createSanctionsJobs(service) : [],
    async close() {
      await outbound?.close();
    },
  };
}
