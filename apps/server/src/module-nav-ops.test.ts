import { describe, expect, it } from "vitest";
import { COMPILED_IN_MODULES } from "./modules.js";
import { type ClassifyOptions, classifyRequest, type RouteTree } from "./tenancy.js";

/*
 * E-UP-18 D3: a page a module puts in a nav is an SPA page on every host. The server answers its
 * ops paths (`/metrics`, `/healthz`, …) before the tenant chain on every host, so a nav entry
 * that names one works by in-app navigation and breaks on a reload, a bookmark or a sign-in's
 * full page load — the investor KPIs page lived at `/metrics` until this test. Asked of the
 * classifier itself rather than a copy of its lists, so a new ops path is covered on arrival.
 */

const multi: ClassifyOptions = { mode: "multi", canonicalHost: "portal.example.com", basePath: "" };
const single: ClassifyOptions = { mode: "single", canonicalHost: "localhost:3000", basePath: "" };
const mounted: ClassifyOptions = { ...multi, basePath: "/investors" };

/**
 * The route tree `path` lands in on each kind of host (canonical, tenant, custom/unknown, the
 * `/w/<slug>` path tenancy, a base path).
 */
function treesOf(path: string): RouteTree[] {
  const requests: [string, string, ClassifyOptions][] = [
    ["portal.example.com", path, multi],
    ["acme.portal.example.com", path, multi],
    ["portal.example.com", `/w/acme${path === "/" ? "" : path}`, multi],
    ["investors.acme.com", path, multi],
    ["localhost:3000", path, single],
    ["portal.example.com", `/investors${path === "/" ? "" : path}`, mounted],
    ["acme.portal.example.com", `/investors${path === "/" ? "" : path}`, mounted],
  ];
  return requests.map(([host, p, opts]) => {
    const cl = classifyRequest({ host, path: p }, opts);
    if (cl === undefined) throw new Error(`unclassified: ${host}${p}`);
    return cl.tree;
  });
}

/** Every `to` in every module's slots (nav entries, settings entries), path only. */
function navPaths(): { module: string; slot: string; to: string }[] {
  return COMPILED_IN_MODULES.flatMap((mod) =>
    Object.entries(mod.slots ?? {}).flatMap(([slot, entries]) =>
      (entries as unknown[]).flatMap((entry) => {
        const to = (entry as { to?: unknown } | null)?.to;
        return typeof to === "string"
          ? [{ module: mod.id, slot, to: to.split(/[?#]/u, 1)[0] ?? to }]
          : [];
      }),
    ),
  );
}

describe("module nav entries vs the ops tree (E-UP-18 D3)", () => {
  it("is not vacuous: the ops paths are classified as ops on every host", () => {
    for (const path of ["/metrics", "/healthz", "/readyz"]) {
      expect(new Set(treesOf(path)), path).toEqual(new Set(["ops"]));
    }
    expect(navPaths().some((p) => p.slot === "investor.nav")).toBe(true);
  });

  it("names no ops path: every entry is an SPA page on every host", () => {
    const paths = navPaths();
    for (const { module, slot, to } of paths) {
      /*
       * Hono is not strict about a trailing slash — `/metrics/` is the ops endpoint as well — so
       * an entry is asked without one, and may not carry one (the classifier matches exactly).
       */
      expect(to === "/" || !to.endsWith("/"), `${module} ${slot} ${to}: trailing slash`).toBe(true);
      const trees = treesOf(to.replace(/(?<=.)\/+$/u, ""));
      expect(trees, `${module} ${slot} ${to}`).not.toContain("ops");
      for (const tree of trees) expect(["app", "admin"], `${module} ${slot} ${to}`).toContain(tree);
    }
  });

  it("puts the investor KPIs page at /kpis", () => {
    expect(navPaths().find((p) => p.module === "metrics" && p.slot === "investor.nav")?.to).toBe(
      "/kpis",
    );
  });
});
