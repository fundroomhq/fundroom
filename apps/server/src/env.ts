import type { EdgeVariables, HeaderVariables, PathMount } from "@fundroom/http";
import type { AuthVariables } from "@fundroom/identity/http";
import type { ModuleVariables } from "@fundroom/module-kit";
import type { AuthenticatedSession } from "@fundroom/ports";
import type { Classification } from "./tenancy.js";

/** Variables available on every request once the kernel middleware chain has run. */
export interface AppVariables
  extends ModuleVariables,
    AuthVariables,
    HeaderVariables,
    EdgeVariables {
  classification?: Classification;
  /**
   * The request's public base path (E3.9, `path-mount.ts`): the matched `PATH_MOUNTS` prefix when
   * the request is mounted, else BASE_PATH. All presentation reads this, never BASE_PATH.
   */
  publicBase?: string;
  /** The request's public origin: the mount's when mounted, else the request's own. */
  publicOrigin?: string;
  /** The matched mount, only on a mounted request. */
  pathMount?: PathMount;
  /**
   * True when this request's public origin is not the passkey RP origin (BASE_URL's): a mount on
   * another origin, or the direct portal when BASE_URL is a mount. Passkeys are refused here.
   */
  offPasskeyOrigin?: boolean;
  /**
   * E3.10: set by `requirePlatformOperator()` (`middleware/platform.ts`) on an operator request —
   * the operator session and its user. Never set on a tenant request.
   */
  platformOperator?: {
    readonly userId: string;
    readonly sessionId: string;
    readonly session: AuthenticatedSession;
  };
  /**
   * A-3 (ADR-0063): set by the module mounts (`api.ts`, `app.ts`) on every request a module
   * serves — which module, whether the plan has made it read-only here, and the mount's route
   * prefix. The member and permission guards read it (`module-read-only.ts`). Never set on a kernel
   * route.
   */
  moduleMount?: ModuleMount;
}

/**
 * What a module mount records on the request (`AppVariables.moduleMount`). Declared here, not in
 * `module-read-only.ts`, so that file can import `AppEnv` without an import cycle.
 */
export interface ModuleMount {
  readonly id: string;
  /** On, optional and outside the plan: staff writes answer 402 (`moduleReadOnly`). */
  readonly readOnly: boolean;
  /**
   * The mount's registered route prefix, e.g. `/api/v1/data-room` or `/w/:slug/api/v1/data-room`:
   * the route path the guard sees minus this is the module-relative route (`/documents/:id`).
   */
  readonly routePrefix: string;
}

export type AppEnv = { Variables: AppVariables };
