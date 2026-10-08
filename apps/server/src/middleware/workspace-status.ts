import { ApiError, errorResponse } from "@fundroom/contracts";
import type { Membership } from "@fundroom/db";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../env.js";
import { markAuthzDenial } from "./security-events.js";

/*
 * The workspace status guard (E3.10, ADR-0058). Runs after tenant resolution and membership
 * resolution, before any route. `active` → pass. A `pending_review` (held for its sanctions
 * screen) or `suspended` workspace serves only:
 *
 *   - its pages (the app / admin / embed documents and assets): the SPA boots, reads
 *     `WebConfig.workspaceStatus` and shows the banner, the billing page or "portal unavailable";
 *   - `/api/v1/auth/*` (sign in, step up, sign out) and `/api/v1/me[/…]` (the caller's own global
 *     account: sessions, devices, locale, leaving a view-as);
 *   - `GET /api/v1/modules` (the bootstrap, carrying `workspaceStatus`), `GET /api/v1/openapi.json`,
 *     `GET /api/v1/branding/logo` and `GET /api/v1/i18n/*` (what the sign-in page needs);
 *   - `/api/v1/billing*` and `/api/v1/usage` for a staff member holding `billing.read` or
 *     `billing.manage` — so an owner can pay their way out of a billing suspension;
 *   - `GET /api/v1/residency` for a staff member while the reason is `relocation` (E3.11): the
 *     page that tells staff where the workspace is moving must be readable during the move.
 *     Only for that reason — an operator or sanctions hold outranks it and keeps the 423. The
 *     route's own `compliance.read` check still applies.
 *
 * Everything else under `/api` answers 423 `workspace_unavailable` to a staff member and a plain
 * 404 `not_found` to everybody else (investors, anonymous callers, API keys): an investor learns
 * nothing about the company's billing or screening. Ops-tree routes (vendor callbacks, webhooks)
 * never reach this middleware — their owners drop a non-active workspace's callbacks themselves
 * (answer 200, change nothing).
 *
 * The guard reads the status from the row tenant resolution already loaded (no query), so in
 * multi mode a suspension is live on the very next request. It applies whatever CONTROL_PLANE
 * says: only the control plane ever moves a workspace off `active`, and a workspace suspended
 * before the plane was switched off stays suspended until an operator lifts it.
 */
export interface WorkspaceStatusGuardOptions {
  /** RBAC for the billing exception (`billing.read` / `billing.manage`), read per request. */
  readonly hasPermission: (
    membership: Pick<Membership, "kind" | "role" | "status">,
    permission: string,
  ) => boolean;
}

const ALWAYS: readonly RegExp[] = [/^\/api\/v1\/auth(?:\/|$)/u, /^\/api\/v1\/me(?:\/|$)/u];
const READS: readonly RegExp[] = [
  /^\/api\/v1\/modules\/?$/u,
  /^\/api\/v1\/openapi\.json$/u,
  /^\/api\/v1\/branding\/logo\/?$/u,
  /^\/api\/v1\/i18n(?:\/|$)/u,
];
const BILLING: RegExp = /^\/api\/v1\/(?:billing|usage)(?:\/|$)/u;
/** Readable by staff while the workspace is held for a move between cells (E3.11). */
const RELOCATION_READS: readonly RegExp[] = [/^\/api\/v1\/residency\/?$/u];
const READ_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * What the bootstrap and the page config say about a non-active workspace (null when active).
 * Staff learn the status and the reason; everybody else (investors, anonymous) only that the
 * portal is unavailable — a hold reads as a suspension and no reason is given.
 */
export function workspaceStatusView(
  workspace:
    | {
        readonly status?: "active" | "pending_review" | "suspended" | undefined;
        readonly suspendedReason?:
          | "operator"
          | "billing"
          | "sanctions"
          | "relocation"
          | null
          | undefined;
      }
    | undefined,
  viewerIsStaff: boolean,
): {
  readonly status: "pending_review" | "suspended";
  readonly reason: "operator" | "billing" | "sanctions" | "relocation" | null;
} | null {
  if (workspace?.status === undefined || workspace.status === "active") return null;
  if (!viewerIsStaff) return { status: "suspended", reason: null };
  return { status: workspace.status, reason: workspace.suspendedReason ?? null };
}

/** Whether a request to a non-active workspace may proceed (pure; exported for the tests). */
export function statusAllows(input: {
  readonly tree: string | undefined;
  readonly path: string;
  readonly method: string;
  readonly billingHolder: boolean;
  /** E3.11: a staff caller of a workspace whose (top-ranked) reason is `relocation`. */
  readonly staffDuringRelocation?: boolean | undefined;
}): boolean {
  if (input.tree !== "api") return true;
  if (ALWAYS.some((re) => re.test(input.path))) return true;
  if (READ_METHODS.has(input.method) && READS.some((re) => re.test(input.path))) return true;
  if (
    input.staffDuringRelocation === true &&
    READ_METHODS.has(input.method) &&
    RELOCATION_READS.some((re) => re.test(input.path))
  ) {
    return true;
  }
  return input.billingHolder && BILLING.test(input.path);
}

export function workspaceStatusGuard(
  options: WorkspaceStatusGuardOptions,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const workspace = c.get("workspace");
    if (workspace === undefined || workspace.status === "active") return next();
    const classification = c.get("classification");
    const membership = c.get("membership");
    const staff =
      membership !== undefined && membership.kind === "staff" && c.get("viewAs") === undefined;
    const billingHolder =
      staff &&
      (options.hasPermission(membership, "billing.read") ||
        options.hasPermission(membership, "billing.manage"));
    if (
      statusAllows({
        tree: classification?.tree,
        path: classification?.path ?? c.req.path,
        method: c.req.method,
        billingHolder,
        staffDuringRelocation: staff && workspace.suspendedReason === "relocation",
      })
    ) {
      return next();
    }
    if (staff) {
      return errorResponse(
        c,
        new ApiError("workspace_unavailable", "this workspace is unavailable", {
          workspaceStatus: workspace.status,
          reason: workspace.suspendedReason,
        }),
      );
    }
    return errorResponse(c, markAuthzDenial(new ApiError("not_found", "no such path")));
  };
}
