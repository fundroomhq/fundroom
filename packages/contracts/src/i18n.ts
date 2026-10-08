import { z } from "@hono/zod-openapi";

/*
 * Locale contracts (E2.8): `PUT /me/locale`, `PUT /workspace/locale`. Handlers:
 * `apps/server/src/routes/i18n.ts`. The locale list mirrors `@fundroom/i18n` `LOCALES` (spelled
 * out: this package keeps no `@fundroom/*` dependencies so the SDK builds from the contract alone).
 */

export const LocaleSchema = z
  .enum(["en", "en-XA"])
  .openapi("Locale", { description: "`en-XA` is the generated pseudo-locale (QA only)" });

export const UserLocaleBody = z
  .object({
    locale: z.union([LocaleSchema, z.null()]).openapi({
      description: "null clears the choice (the workspace default applies)",
    }),
  })
  .openapi("UserLocaleRequest");

export const UserLocaleSchema = z
  .object({ locale: z.union([LocaleSchema, z.null()]) })
  .openapi("UserLocale");

export const WorkspaceLocaleBody = z
  .object({ defaultLocale: LocaleSchema })
  .openapi("WorkspaceLocaleRequest");

export const WorkspaceLocaleSchema = z
  .object({ defaultLocale: LocaleSchema })
  .openapi("WorkspaceLocale");
