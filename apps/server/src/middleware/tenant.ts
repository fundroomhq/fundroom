import { ApiError } from "@fundroom/contracts";
import type { WorkspaceResolver } from "@fundroom/db";
import { createDirectoryRouting, type DirectoryRouting } from "@fundroom/directory";
import { requestHost } from "@fundroom/http";
import type { DirectoryPort } from "@fundroom/ports";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { type ClassifyOptions, classifyRequest, slugHostLocation } from "../tenancy.js";
import { pageErrorResponse } from "./errors.js";

/*
 * Tenant resolution (§3.3 step 1). Classifies the request, then does at most one indexed
 * lookup. Unknown hosts (multi mode) and unknown slugs are 404 before any session or
 * membership work, and the response is the same whether the slug never existed or the
 * workspace was deleted.
 *
 * Host-level requests (canonical host without a slug in multi mode) run without a
 * workspace: login for the workspace switcher, setup, the capability doc. In single mode
 * every request resolves to the sole workspace; before setup has created it, `workspace`
 * stays unset and the API answers `setup_required` where a workspace is needed.
 */
export interface TenantMiddlewareOptions {
  readonly resolver: WorkspaceResolver;
  readonly classify: ClassifyOptions;
  readonly trustProxy: boolean;
  /**
   * The hostname → workspace lookup for verified custom domains (E2.1 §1.12). Omitted only by
   * tests that build the middleware on its own; an install without it simply 404s custom domains.
   */
  readonly lookup?:
    | { workspaceFor(hostname: string): Promise<{ workspaceId: string; slug: string } | undefined> }
    | undefined;
  /**
   * The cell guard (E3.10): with CONTROL_PLANE=on (`enabled`), a workspace placed on another cell
   * is answered 421 `wrong_cell` with `X-Fundroom-Cell: <its cell>` — before any session work, and
   * with no other detail — so an edge can retry on the right cell. Omitted = off.
   */
  readonly cell?: { readonly enabled: boolean; readonly cellId: string } | undefined;
  /**
   * The cell directory (E3.11 §7). Only a `shared` directory in multi mode with the cell guard on
   * is consulted, and only on a LOCAL miss (slug or host) or for a suspended local workspace (a
   * `relocation` hold whose entry a switched move rebound elsewhere): an entry in another cell is
   * answered 421 `wrong_cell` + `X-Fundroom-Cell`, anything else keeps today's answer. Lookups
   * are cached and budgeted (`createDirectoryRouting`); over budget or with the directory down
   * the answer is today's 404 — never a 429 or 503, and a local tenant never waits on it.
   */
  readonly directory?: DirectoryPort | undefined;
  /** Test seam: the routing cache itself (budget, TTL, clock). Built from `directory` otherwise. */
  readonly directoryRouting?: DirectoryRouting | undefined;
  /** Where routing failures are logged (`directory.lookup_failed`, budget exhaustion). */
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

/** The header a 421 `wrong_cell` names the workspace's cell in (E3.10). */
export const CELL_HEADER = "X-Fundroom-Cell";
/**
 * The pre-rename spelling (A-2, ADR-0062), sent alongside {@link CELL_HEADER} with the same value
 * for one minor release so an edge built against it keeps retrying; removed in the next minor.
 */
export const LEGACY_CELL_HEADER = "X-Seedhost-Cell";

/** Names the workspace's cell on a 421 `wrong_cell`, under both spellings. */
function setCellHeaders(c: { header(name: string, value: string): void }, cellId: string): void {
  c.header(CELL_HEADER, cellId);
  c.header(LEGACY_CELL_HEADER, cellId);
}

export function tenantResolution(options: TenantMiddlewareOptions): MiddlewareHandler<AppEnv> {
  const ownCell = options.cell?.enabled === true ? options.cell.cellId : undefined;
  const routing: DirectoryRouting | undefined =
    ownCell === undefined || options.resolver.mode !== "multi"
      ? undefined
      : (options.directoryRouting ??
        (options.directory?.mode === "shared"
          ? createDirectoryRouting({ directory: options.directory, log: options.log })
          : undefined));
  /** The cell another cell's entry names, or undefined (no entry, ours, reserved, deleted). */
  function elsewhere(route: { cellId: string; state: string } | null): string | undefined {
    if (route === null || ownCell === undefined) return undefined;
    if (route.state !== "active" && route.state !== "moving") return undefined;
    return route.cellId === ownCell ? undefined : route.cellId;
  }
  function misdirected(c: Parameters<MiddlewareHandler<AppEnv>>[0], cellId: string) {
    setCellHeaders(c, cellId);
    return pageErrorResponse(c, new ApiError("wrong_cell", "misdirected request"));
  }

  return async (c, next) => {
    const host = requestHost(c, options.trustProxy);
    const classified = classifyRequest({ host, path: c.req.path }, options.classify);
    if (classified === undefined) {
      return pageErrorResponse(c, new ApiError("not_found", "no such path"));
    }
    // E3.10 FR1: a `/w/<slug>` page on the canonical host of a control-plane install lives on the
    // workspace's own host. No lookup first: the answer is the same whether the slug exists.
    if (classified.redirect !== undefined) {
      return c.redirect(
        slugHostLocation(classified.redirect, c.req.url, options.classify.basePath),
        308,
      );
    }
    let classification = classified;
    c.set("classification", classification);
    c.set("embed", classification.embed);
    // BEFORE the lookup, deliberately (E2.1 §1.12): `/internal/tls/ask` has to work on a
    // hostname that is *not yet* verified — that is the entire point of on-demand TLS — and
    // health checks must never touch the database.
    if (classification.tree === "ops") return next();

    /*
     * A host the classifier could not place may still be a workspace's verified custom domain.
     * `classifyRequest` stays sync and pure, so the one indexed (and cached) lookup happens
     * here, where the middleware is already async. Only `unknown` hosts are looked up: the
     * canonical host and a `<slug>.<canonical>` host already route, and a custom domain that
     * shadowed one of those would be a tenant-resolution bypass (`checkHostname` refuses to
     * store one).
     *
     * In single mode the classifier calls every unrecognised host `canonical` — the operator
     * owns routing there and the sole workspace resolves either way — so this only ever fires
     * in multi mode.
     */
    if (classification.host === "unknown" && options.lookup !== undefined) {
      const hit = await options.lookup.workspaceFor(host);
      if (hit !== undefined) {
        /*
         * A `/w/<slug>` or `/embed/<slug>` prefix on a custom domain must name the workspace the
         * hostname already names. The classifier lets the path slug win (it cannot know the host
         * is a custom domain), and overwriting it here with the hostname's workspace would make
         * the two disagree silently: the host would win, `/embed/beta` would render Acme, and the
         * SPA's router base (`/embed/acme`) would contradict the URL the investor is looking at.
         * Single mode already refuses exactly this contradiction below, and for the same reason —
         * a request that names two workspaces names none.
         */
        if (classification.slug !== undefined && classification.slug !== hit.slug) {
          return pageErrorResponse(c, new ApiError("workspace_not_found", "unknown workspace"));
        }
        classification = { ...classification, host: "custom", slug: hit.slug };
      }
      c.set("classification", classification);
    }

    if (classification.host === "unknown") {
      // E3.11: a verified hostname of a workspace another cell serves.
      if (routing !== undefined) {
        const hit = await routing.host(host);
        if (hit !== null && hit.cellId !== ownCell) return misdirected(c, hit.cellId);
      }
      // Still the default answer for a host nobody has claimed, and the same answer whether the
      // hostname was never added or was added and never verified.
      return pageErrorResponse(c, new ApiError("not_found", "unknown host"));
    }

    const { resolver } = options;
    if (resolver.mode === "multi") {
      if (classification.slug !== undefined) {
        const ws = await resolver.resolve(classification.slug);
        if (ws === undefined) {
          // E3.11: a slug another cell serves (the directory's entry), else today's 404.
          if (routing !== undefined) {
            const other = elsewhere(await routing.slug(classification.slug));
            if (other !== undefined) return misdirected(c, other);
          }
          return pageErrorResponse(c, new ApiError("workspace_not_found", "unknown workspace"));
        }
        const cell = options.cell;
        if (cell?.enabled === true && ws.cellId !== cell.cellId) {
          setCellHeaders(c, ws.cellId);
          return pageErrorResponse(c, new ApiError("wrong_cell", "misdirected request"));
        }
        /*
         * E3.11: a move's source keeps its copy under a `relocation` hold after the switchover;
         * the directory entry now names the target cell. Only suspended workspaces ask (holds
         * are not on the resolved row; relocation always suspends), so an active local tenant
         * never touches the directory.
         */
        if (routing !== undefined && ws.status === "suspended") {
          const other = elsewhere(await routing.workspace(ws.id));
          if (other !== undefined) return misdirected(c, other);
        }
        c.set("workspace", ws);
      }
    } else {
      const ws = await resolver.resolve();
      if (
        classification.slug !== undefined &&
        (ws === undefined || ws.slug !== classification.slug)
      ) {
        return pageErrorResponse(c, new ApiError("workspace_not_found", "unknown workspace"));
      }
      if (ws !== undefined) c.set("workspace", ws);
    }
    await next();
  };
}

/** For handlers that need a workspace: 404 `setup_required` (single, pre-setup) or `workspace_not_found`. */
export function requireWorkspace(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get("workspace") === undefined) {
      throw new ApiError(
        "setup_required",
        "no workspace here: finish setup, or address a workspace by host or /w/<slug>",
      );
    }
    await next();
  };
}
