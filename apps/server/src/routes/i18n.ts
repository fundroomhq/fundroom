import {
  ApiError,
  createRoute,
  errorResponses,
  i18n as i,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import { updateWorkspaceDefaultLocale } from "@fundroom/db";
import { PSEUDO_LOCALE } from "@fundroom/i18n";
import { setUserLocale } from "@fundroom/identity";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { refuseSsoBoundSession, requireSession } from "../middleware/auth.js";
import { requirePermission } from "../middleware/authz.js";
import type { ApiDeps } from "./deps.js";

/*
 * Language choice (E2.8): the user's own (`core.user.locale`, global like the user) and the
 * workspace default (`core.workspace.default_locale`) (authz-matrix.yaml "i18n (E2.8)").
 * Contracts: `@fundroom/contracts` `i18n.ts`; the locale list: `@fundroom/i18n`.
 *
 * The pseudo-locale `en-XA` is QA tooling: it is accepted only while the operator has turned on
 * `I18N_PSEUDO_LOCALE` (the SPA also offers it in a dev build, where it stays client-side), so a
 * production workspace can never end up emailing its investors in accented brackets.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 429, 500, 503);
const TAGS = ["account"];

function assertAllowed(deps: ApiDeps, locale: string | null): void {
  if (locale === PSEUDO_LOCALE && !deps.i18nPseudoLocale) {
    throw new ApiError("validation_failed", "the pseudo-locale is not enabled on this instance", {
      reason: "pseudo_locale_disabled",
    });
  }
}

function signedIn(c: Context<AppEnv>) {
  const session = c.get("session");
  if (!session) throw new ApiError("unauthenticated");
  return session;
}

export function registerI18nRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  api.openapi(
    createRoute({
      method: "put",
      path: "/me/locale",
      tags: TAGS,
      summary: "Choose the signed-in user's language (UI and email)",
      description:
        "Applies in every workspace the user belongs to; `null` clears the choice so the workspace default applies.",
      security: sessionSecurity,
      "x-requires": "session",
      // E3.8: a global user setting — not for a session one workspace's IdP minted.
      middleware: [requireSession(), refuseSsoBoundSession()] as const,
      request: { body: jsonBody(i.UserLocaleBody) },
      responses: { 200: jsonResponse(i.UserLocaleSchema, "Saved"), ...ERRORS },
    }),
    async (c) => {
      const session = signedIn(c);
      const { locale } = c.req.valid("json");
      assertAllowed(deps, locale);
      // `core.user` is global (ADR-0011): host context, like every other user-row write.
      await deps.db.withHost((tx) => setUserLocale(tx, session.userId, locale));
      return c.json({ locale }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/workspace/locale",
      tags: ["access"],
      summary: "Set the workspace's default language",
      description:
        "Used for members who have not chosen a language, and for email to them. Records `workspace.locale_changed`.",
      security: sessionSecurity,
      "x-requires": "access.settings",
      middleware: [requirePermission({ authz: () => deps.authz }, "access.settings")] as const,
      request: { body: jsonBody(i.WorkspaceLocaleBody) },
      responses: { 200: jsonResponse(i.WorkspaceLocaleSchema, "Saved"), ...ERRORS },
    }),
    async (c) => {
      const tenant = c.get("tenant");
      const workspace = c.get("workspace");
      if (!tenant || !workspace) throw new ApiError("unauthenticated");
      const { defaultLocale } = c.req.valid("json");
      assertAllowed(deps, defaultLocale);
      await deps.db.withTenant(tenant, async (tx) => {
        const { before, after } = await updateWorkspaceDefaultLocale(
          tx,
          workspace.id,
          defaultLocale,
        );
        if (before === after) return;
        await deps.audit.record(tx, tenant, {
          action: "workspace.locale_changed",
          resourceKind: "workspace",
          resourceId: workspace.id,
          requestId: requestIdOf(c),
          diff: { before: { defaultLocale: before }, after: { defaultLocale: after } },
        });
      });
      // The resolved workspace carries `defaultLocale`; the bootstrap and every email's
      // language read it through the resolver cache.
      deps.resolver.invalidate();
      return c.json({ defaultLocale }, 200);
    },
  );
}
