import type { ResolvedWorkspace } from "@fundroom/db";
import { type CentralAuthService, createCentralAuthService } from "@fundroom/identity";
import { canonicalHostOf } from "../tenancy.js";
import type { ControlPlaneWiringDeps, WiringKernel } from "./types.js";

/*
 * Central auth origin (E3.10; owner: agent CA) → `container.centralAuth`, read by
 * `routes/central-auth.ts` and the page config (`WebConfig.centralAuth`). `enabled`:
 * CENTRAL_AUTH=on (any tenancy mode — but the workspace hosts it serves, `<slug>.<canonical>` and
 * verified custom domains, only exist in multi mode). The service lives in
 * `packages/identity/src/services/central-auth.ts`; this file only decides which origins are a
 * workspace's own and carries the install facts the routes need.
 */
export interface CentralAuthKernel extends WiringKernel {
  readonly enabled: boolean;
  /** Undefined while CENTRAL_AUTH=off: the routes then fall through to the SPA's 404. */
  service: CentralAuthService | undefined;
  /** BASE_URL: the auth origin, and the scheme every workspace origin shares. */
  readonly baseUrl: URL;
  readonly basePath: string;
  readonly tenancy: "single" | "multi";
  /** The proxy settings the route derives client IP / host trust from (`proxyTrustOf`). */
  readonly proxy: {
    readonly TRUST_PROXY: boolean;
    readonly TRUST_PROXY_HOPS: number;
    readonly CLIENT_IP_HEADER?: string | undefined;
    readonly CLOUDFLARE_TRUSTED_PROXY?: "off" | "on" | undefined;
  };
}

/**
 * A workspace's own origins (multi-tenant): its `<slug>.<canonical>` host and its ACTIVE primary
 * custom domain (`ResolvedWorkspace.primaryHost` is only ever an `active` row — a `pending` or
 * `dns_ok` domain routes requests but is never an origin a code may be handed to). Scheme and port
 * are BASE_URL's: this install serves no workspace host on any other (as `beganOn` in
 * `routes/sso-flow.ts`). Single mode has no workspace host distinct from the canonical one.
 */
export function workspaceOrigins(
  baseUrl: URL,
  tenancy: "single" | "multi",
  ws: Pick<ResolvedWorkspace, "slug" | "primaryHost">,
): string[] {
  if (tenancy !== "multi") return [];
  const canon = canonicalHostOf(baseUrl);
  const port = /:(\d+)$/u.exec(canon)?.[1];
  const origins = [`${baseUrl.protocol}//${ws.slug}.${canon}`];
  if (ws.primaryHost !== null) {
    origins.push(
      `${baseUrl.protocol}//${ws.primaryHost.toLowerCase()}${port === undefined ? "" : `:${port}`}`,
    );
  }
  return origins;
}

export function createCentralAuthWiring(deps: ControlPlaneWiringDeps): CentralAuthKernel {
  const raw = deps.config.raw;
  const enabled = raw.CENTRAL_AUTH === "on";
  const baseUrl = deps.config.baseUrl;
  const tenancy = raw.TENANCY_MODE;
  return {
    enabled,
    service: enabled
      ? createCentralAuthService(deps.identityDeps, deps.auth.sessions, {
          originsOf: (ws) => workspaceOrigins(baseUrl, tenancy, ws),
        })
      : undefined,
    baseUrl,
    basePath: deps.config.basePath,
    tenancy,
    proxy: raw,
    jobs: [],
    async close() {},
  };
}
