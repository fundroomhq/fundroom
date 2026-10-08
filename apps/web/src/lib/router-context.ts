import type { QueryClient } from "@tanstack/react-query";
import type { WebConfig } from "./config.js";

/** Router context shared by every route (`createRootRouteWithContext<RouterContext>()`). */
export interface RouterContext {
  config: WebConfig;
  queryClient: QueryClient;
}
