import type { ResolvedWorkspace, WorkspaceResolver } from "@fundroom/db";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { AppEnv } from "../env.js";
import type { Classification } from "../tenancy.js";
import { tenantResolution } from "./tenant.js";

/*
 * Tenant resolution on a verified custom domain (E2.1 §1.12, ADR-0039 decision 7).
 *
 * The variable under test is the *disagreement*: a request whose `Host` names one workspace and
 * whose path prefix names another. `classifyRequest` is sync and cannot know the host is a custom
 * domain, so it lets the path slug win; the middleware then learns the hostname's workspace. If it
 * simply overwrites the slug, the host quietly wins and `/embed/beta` on Acme's hostname renders
 * Acme behind a URL that says Beta. Single mode has always refused that contradiction, and so must
 * this.
 */
const CANON = "portal.example.com";
const CUSTOM = "investors.acme-ir.com";

function workspaceFor(slug: string): ResolvedWorkspace {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    offeringStatus: "none",
    settings: {},
    settingsSchemaVersion: 1,
    aclVersion: 1,
    defaultLocale: "en",
    ssoEnforced: false,
    ssoConnectionId: null,
    ssoConnectionVersion: null,
    cellId: "default",
    dataRegion: null,
    status: "active",
    suspendedReason: null,
    planId: null,
    primaryHost: slug === "acme" ? CUSTOM : null,
    planLimits: null,
  };
}

const resolver: WorkspaceResolver = {
  mode: "multi",
  resolve: (slug) =>
    Promise.resolve(slug === "acme" || slug === "beta" ? workspaceFor(slug) : undefined),
  invalidate: () => {},
};

/** Only `CUSTOM` is verified, and it belongs to Acme. */
const lookup = {
  workspaceFor: (hostname: string) =>
    Promise.resolve(hostname === CUSTOM ? { workspaceId: "id-acme", slug: "acme" } : undefined),
};

interface Seen {
  status: number;
  classification: Classification | undefined;
  workspaceSlug: string | undefined;
}

async function get(
  path: string,
  host: string,
  cell?: { readonly enabled: boolean; readonly cellId: string },
): Promise<Seen & { cellHeader: string | null; legacyCellHeader: string | null }> {
  const app = new Hono<AppEnv>();
  app.use(
    "*",
    tenantResolution({
      resolver,
      classify: { mode: "multi", canonicalHost: CANON, basePath: "" },
      trustProxy: false,
      lookup,
      cell,
    }),
  );
  let classification: Classification | undefined;
  let workspaceSlug: string | undefined;
  app.all("*", (c) => {
    classification = c.get("classification");
    workspaceSlug = c.get("workspace")?.slug;
    return c.text("ok");
  });
  const res = await app.request(`http://${host}${path}`, { headers: { host } });
  return {
    status: res.status,
    classification,
    workspaceSlug,
    cellHeader: res.headers.get("X-Fundroom-Cell"),
    legacyCellHeader: res.headers.get("X-Seedhost-Cell"),
  };
}

describe("tenantResolution on a verified custom domain", () => {
  it("resolves the hostname's workspace when the path names none", async () => {
    const seen = await get("/api/v1/domains", CUSTOM);
    expect(seen.status).toBe(200);
    expect(seen.classification).toMatchObject({ host: "custom", slug: "acme" });
    expect(seen.workspaceSlug).toBe("acme");
  });

  it("keeps working when a path slug names the same workspace", async () => {
    const w = await get("/w/acme/api/v1/domains", CUSTOM);
    expect(w.status).toBe(200);
    expect(w.classification).toMatchObject({
      host: "custom",
      slug: "acme",
      path: "/api/v1/domains",
    });
    expect(w.workspaceSlug).toBe("acme");

    const embed = await get("/embed/acme", CUSTOM);
    expect(embed.status).toBe(200);
    expect(embed.classification).toMatchObject({ host: "custom", slug: "acme", embed: true });
    expect(embed.workspaceSlug).toBe("acme");
  });

  it("refuses a `/w/<slug>` prefix that names a different workspace", async () => {
    // Serving Acme's data under Beta's URL is not a leak — the host wins, which is the more
    // restrictive direction — but it is a lie about which workspace is being viewed, and the
    // answer to a request that names two workspaces is the 404 single mode already gives.
    const seen = await get("/w/beta/api/v1/domains", CUSTOM);
    expect(seen.status).toBe(404);
    expect(seen.workspaceSlug).toBeUndefined();
  });

  it("refuses a `/embed/<slug>` prefix that names a different workspace", async () => {
    // The embed tree is where the silent override was outright broken: the SPA's router base is
    // built from the slug, so it would have said `/embed/acme` under a `/embed/beta` URL.
    const seen = await get("/embed/beta", CUSTOM);
    expect(seen.status).toBe(404);
    expect(seen.workspaceSlug).toBeUndefined();
  });

  it("leaves an unverified hostname as the 404 it always was", async () => {
    expect((await get("/", "someone-else.acme-ir.com")).status).toBe(404);
    expect((await get("/w/acme/api/v1/me", "someone-else.acme-ir.com")).status).toBe(404);
  });
});

/*
 * E3.10: `<slug>.<canonical>` behaves like a custom domain for a disagreeing path slug (the host
 * wins, the request is a 404), and with CONTROL_PLANE=on a workspace served by another cell is a
 * 421 `wrong_cell` naming the cell and nothing else.
 */
describe("tenantResolution on a tenant host (E3.10)", () => {
  it("refuses a path slug that names another workspace", async () => {
    for (const path of ["/w/beta/api/v1/me", "/embed/beta"]) {
      const seen = await get(path, `acme.${CANON}`);
      expect(seen.status, path).toBe(404);
      expect(seen.workspaceSlug, path).toBeUndefined();
    }
    expect((await get("/w/acme/api/v1/me", `acme.${CANON}`)).workspaceSlug).toBe("acme");
  });

  it("answers 421 wrong_cell with the cell header when the workspace lives elsewhere", async () => {
    const elsewhere = await get("/api/v1/me", `acme.${CANON}`, { enabled: true, cellId: "eu-2" });
    expect(elsewhere.status).toBe(421);
    expect(elsewhere.cellHeader).toBe("default");
    // A-2: the pre-rename spelling rides along for one minor release.
    expect(elsewhere.legacyCellHeader).toBe("default");
    expect(elsewhere.workspaceSlug).toBeUndefined();

    const here = await get("/api/v1/me", `acme.${CANON}`, { enabled: true, cellId: "default" });
    expect(here.status).toBe(200);
    expect(here.cellHeader).toBeNull();
    expect(here.legacyCellHeader).toBeNull();

    // Off (self-host): the cell is never compared.
    const off = await get("/api/v1/me", `acme.${CANON}`, { enabled: false, cellId: "eu-2" });
    expect(off.status).toBe(200);
    // The canonical host has no workspace and is unaffected.
    const canonical = await get("/api/v1/me", CANON, { enabled: true, cellId: "eu-2" });
    expect(canonical.status).toBe(200);
  });
});
