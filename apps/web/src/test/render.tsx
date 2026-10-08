import type { QueryClient } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { type RenderResult, render } from "@testing-library/react";
import { App } from "../app.js";
import { configureApi, createQueryClient } from "../lib/api.js";
import type { WebConfig } from "../lib/config.js";
import { type AppRouter, createRouter } from "../router.js";
import { testConfig } from "./fixtures.js";

export interface Rendered extends RenderResult {
  router: AppRouter;
  queryClient: QueryClient;
}

/** Mounts the whole app at `path` with a memory history and a fresh query client. */
export async function renderApp(path: string, config: WebConfig = testConfig()): Promise<Rendered> {
  configureApi(config.apiBase);
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({
    queries: { ...queryClient.getDefaultOptions().queries, retry: false },
  });
  const router = createRouter(
    { config, queryClient },
    createMemoryHistory({ initialEntries: [path] }),
  );
  const result = render(<App config={config} queryClient={queryClient} router={router} />);
  await router.load();
  return Object.assign(result, { router, queryClient });
}

export function pathOf(router: AppRouter): string {
  return `${router.state.location.pathname}${router.state.location.searchStr}`;
}
