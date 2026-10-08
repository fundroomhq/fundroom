import { ThemeProvider, Toaster, TooltipProvider, UiLabelsProvider } from "@fundroomhq/ui";
import { type QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { BrandTheme } from "./lib/brand-theme.js";
import type { WebConfig } from "./lib/config.js";
import { WebConfigProvider } from "./lib/config-context.js";
import { syncLocale, useLocale } from "./lib/locale.js";
import { bootstrapQuery, meQuery } from "./lib/queries.js";
import { m } from "./paraglide/messages.js";
import type { AppRouter } from "./router.js";

/**
 * `@fundroomhq/ui` ships no words of its own (ADR-0030 §5): its few come from the catalogue here.
 * Exported for component tests that render outside `App`.
 */
export function AppUiLabels({ children }: { children: ReactNode }) {
  return (
    <UiLabelsProvider
      labels={{
        close: m.common_close(),
        loading: m.common_loading(),
        requestId: m.common_request_id_label(),
        retry: m.common_retry(),
        menu: m.nav_menu(),
        notifications: m.common_notifications(),
      }}
    >
      {children}
    </UiLabelsProvider>
  );
}

/**
 * Feeds the server's language facts into `lib/locale.ts` (E2.8): the user's own choice from
 * `/me` and the workspace default plus the pseudo-locale flag from the bootstrap.
 *
 * It reads the query CACHE rather than observing the queries. The guards and screens that need
 * `/me` and the bootstrap fetch them; this adds no request of its own. And it must not be an
 * observer at all: a `useQuery({ enabled: false })` on `meQuery` makes TanStack treat the query
 * as disabled whenever it is the only observer, and `refreshSession`'s
 * `invalidateQueries({ refetchType: "all" })` skips disabled queries — the sign-in → gated
 * route redirect would then read a stale `null` and bounce back to the login screen.
 */
function LocaleSync() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const read = () => {
      const me = queryClient.getQueryData(meQuery.queryKey);
      const bootstrap = queryClient.getQueryData(bootstrapQuery.queryKey);
      syncLocale({
        user: me === undefined ? undefined : (me?.session.user.locale ?? null),
        workspace: bootstrap?.workspace?.defaultLocale,
        pseudoLocale: bootstrap?.pseudoLocale,
      });
    };
    read();
    return queryClient.getQueryCache().subscribe((event) => {
      const key = event.query.queryKey[0];
      if (event.type === "updated" && (key === "me" || key === "bootstrap")) read();
    });
  }, [queryClient]);
  return null;
}

/** Providers shared by main.tsx and the screen tests. */
export function App({
  config,
  queryClient,
  router,
}: {
  config: WebConfig;
  queryClient: QueryClient;
  router: AppRouter;
}) {
  // A language change re-mounts everything below (the router and the query cache live outside
  // React, so the page and its data survive): every `m.*()` call then renders in the new locale.
  const locale = useLocale();
  return (
    <WebConfigProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <LocaleSync />
        <AppUiLabels key={locale}>
          <ThemeProvider storageKey="seed-host:theme">
            {/* Inside the provider: the brand has one palette per mode and only the resolved
                one may be applied (see `BrandTheme`). */}
            <BrandTheme />
            <TooltipProvider>
              <RouterProvider router={router} />
              <Toaster />
            </TooltipProvider>
          </ThemeProvider>
        </AppUiLabels>
      </QueryClientProvider>
    </WebConfigProvider>
  );
}
