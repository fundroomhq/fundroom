/*
 * Investor page paths that are not the module's id (E-UP-18 D3). The portal's catch-all renders
 * `/<segment>/<rest>` as the page of the module that segment names — its id, unless it is
 * renamed here. The metrics module's reader page is `/kpis`: `/metrics` is the server's ops
 * endpoint (Prometheus) on every host, so a reload or a bookmark of it never reaches the SPA.
 *
 * Kept out of `registry.ts` on purpose: screen tests mock the registry with their own loaders,
 * and the paths must not change with what a test happens to load.
 */
const RENAMED: Readonly<Record<string, string>> = { kpis: "metrics" };

/** Module id → its investor path segment, where the two differ. */
const SEGMENT_OF: ReadonlyMap<string, string> = new Map(
  Object.entries(RENAMED).map(([segment, id]) => [id, segment]),
);

/** The module a top-level investor path segment names. */
export function investorModuleFor(segment: string): string {
  return RENAMED[segment] ?? segment;
}

/**
 * The splat an old investor path moved to (`metrics/x` → `kpis/x`), for the in-app redirect
 * from stale links and history; `undefined` when it has not moved.
 */
export function movedInvestorSplat(splat: string): string | undefined {
  const [first = "", ...rest] = splat.split("/");
  const segment = SEGMENT_OF.get(first);
  return segment === undefined ? undefined : [segment, ...rest].join("/");
}

/**
 * A router-relative href with a moved investor path brought up to date (`/metrics?x=1` →
 * `/kpis?x=1`); anything else unchanged. For a sign-in's return path, which must never be the
 * old one: that is a server path now, and a sign-in would go home instead.
 */
export function currentInvestorHref(href: string): string {
  const cut = href.search(/[?#]/u);
  const path = cut === -1 ? href : href.slice(0, cut);
  const moved = path.startsWith("/") ? movedInvestorSplat(path.slice(1)) : undefined;
  return moved === undefined ? href : `/${moved}${cut === -1 ? "" : href.slice(cut)}`;
}
