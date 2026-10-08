import {
  createRootRouteWithContext,
  Outlet,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import {
  NotFoundScreen,
  RouteErrorScreen,
  SetupRequiredScreen,
} from "../components/status-screens.js";
import { EmbedFrame } from "../embed/EmbedFrame.js";
import { useWebConfig } from "../lib/config-context.js";
import type { RouterContext } from "../lib/router-context.js";

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootComponent,
  errorComponent: RootError,
  notFoundComponent: NotFoundScreen,
});

function RootComponent() {
  const config = useWebConfig();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Before setup only the wizard renders (ADR-0018); every other URL points at it.
  if (config.setupRequired && !/^\/setup(?:\/|$)/u.test(pathname)) return <SetupRequiredScreen />;
  if (config.tree === "embed") {
    return (
      <EmbedFrame>
        <Outlet />
      </EmbedFrame>
    );
  }
  return <Outlet />;
}

function RootError({ error }: { error: unknown }) {
  const router = useRouter();
  return <RouteErrorScreen error={error} reset={() => void router.invalidate()} />;
}
