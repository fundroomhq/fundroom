import { Alert, AlertDescription, AlertTitle, EmptyState, LoadingState } from "@fundroomhq/ui";
import { Lock, PackageX } from "lucide-react";
import { type ComponentType, lazy, Suspense, useMemo } from "react";
import { useBootstrap, visibleModules } from "../lib/queries.js";
import type { ModuleLoader, ModulePageProps } from "../modules/registry.js";
import { m } from "../paraglide/messages.js";
import { PlanChangeHint } from "./billing/plan-feature-notice.js";
import { NotFoundScreen, RouteErrorScreen } from "./status-screens.js";

const cache = new Map<string, ComponentType<ModulePageProps>>();

function lazyModule(key: string, loader: ModuleLoader): ComponentType<ModulePageProps> {
  let component = cache.get(key);
  if (component === undefined) {
    component = lazy(loader);
    cache.set(key, component);
  }
  return component;
}

/**
 * Resolves `/<module>/<rest>` against the bootstrap (enabled + visible) and the client
 * registry. Unknown → not found (no oracle for disabled modules); enabled without a bundle →
 * "not in this build". `moduleFor` maps a path segment to the module id where the two differ
 * (the investor `/kpis` is the metrics module's page, E-UP-18 D3).
 */
export function ModulePage({
  splat,
  surface,
  registry,
  moduleFor = (segment) => segment,
}: {
  splat: string;
  surface: ModulePageProps["surface"];
  registry: Readonly<Record<string, ModuleLoader>>;
  moduleFor?: (segment: string) => string;
}) {
  const bootstrap = useBootstrap();
  const [segment = "", ...rest] = splat.split("/").filter(Boolean);
  const moduleId = moduleFor(segment);
  const loader = registry[moduleId];
  // Keyed by surface too: a module ships one component per surface under the same id.
  const Component = useMemo(
    () => (loader !== undefined ? lazyModule(`${surface}:${moduleId}`, loader) : undefined),
    [loader, moduleId, surface],
  );

  if (bootstrap.isPending) return <LoadingState label={m.common_loading()} />;
  if (bootstrap.isError) return <RouteErrorScreen error={bootstrap.error} />;
  const descriptor = visibleModules(bootstrap.data).find((mod) => mod.id === moduleId);
  if (descriptor === undefined) return <NotFoundScreen />;
  // A-3: on but outside the plan — staff can read and switch it off; investors see no change.
  const banner = surface === "admin" && descriptor.readOnly ? <ReadOnlyModuleBanner /> : null;
  if (Component === undefined) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<PackageX aria-hidden="true" />}
          title={m.module_unavailable_title()}
          description={m.module_unavailable_body({ id: moduleId })}
        />
      </div>
    );
  }
  // A fragment with the banner's slot always present: a plan change mid-visit adds or removes
  // the banner without remounting the module page under it.
  return (
    <>
      {banner}
      <Suspense fallback={<LoadingState label={m.common_loading()} />}>
        <Component moduleId={moduleId} splat={rest.join("/")} surface={surface} />
      </Suspense>
    </>
  );
}

/**
 * Above every admin page of a read-only module: why saving is refused (402 `plan_limit`), that
 * investors are unaffected, and who can change the plan (and, for owner and finance, the link).
 */
function ReadOnlyModuleBanner() {
  return (
    <Alert variant="warning" className="mb-6">
      <Lock aria-hidden="true" />
      <AlertTitle>{m.modules_read_only_plan()}</AlertTitle>
      <AlertDescription>
        <p>{m.module_read_only_body()}</p>
        <PlanChangeHint />
      </AlertDescription>
    </Alert>
  );
}
