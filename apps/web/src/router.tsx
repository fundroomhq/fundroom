import { createRouter as createTanStackRouter, type RouterHistory } from "@tanstack/react-router";
import type { RouterContext } from "./lib/router-context.js";
import { routeTree } from "./routeTree.gen.js";

export type { RouterContext } from "./lib/router-context.js";

export function createRouter(context: RouterContext, history?: RouterHistory) {
  return createTanStackRouter({
    routeTree,
    context,
    ...(context.config.routerBase ? { basepath: context.config.routerBase } : {}),
    ...(history ? { history } : {}),
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    scrollRestoration: true,
    defaultStructuralSharing: true,
  });
}

export type AppRouter = ReturnType<typeof createRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}
