import { z } from "@hono/zod-openapi";
import { EmailSchema, TimestampSchema } from "./schemas.js";

/*
 * Branding (E1.7, EXECUTION_PLAN §12 "branding basics", design/03 F1, design/08 §4).
 *
 * Handlers live in `apps/server/src/routes/branding.ts` — kernel routes behind a `required`
 * manifest, the same shape E1.1 used for `access` and E1.6 for `compliance`, because every
 * fact here lives on `core.workspace` (the `branding` block of the `settings` jsonb) and a
 * module reaching into `core.*` would break the boundary that makes modules safe to reason
 * about.
 *
 * A workspace stores a very small brand. The `--sh-*` tokens the portal renders are DERIVED
 * from it by `@fundroom/branding` and returned here read-only: they are not settable, so a
 * workspace cannot post a token map that makes its own portal unreadable, and the design
 * system can gain a token without migrating stored brands.
 *
 * The enum values are spelled out rather than imported from `@fundroom/domain`: this package
 * keeps no `@fundroom/*` dependencies so the generated SDK builds from the contract alone.
 */

export const BrandFontSchema = z
  .enum(["system", "humanist", "geometric", "serif", "slab", "mono"])
  .openapi({ description: "Bundled font stack; no external or uploaded fonts", example: "system" });

export const BrandRadiusSchema = z.enum(["sharp", "soft", "round"]);

export const BrandLogoTypeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);

const HexColorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/u)
  .openapi({ description: "sRGB hex", example: "#1d4ed8" });

export const BrandLogoSchema = z
  .object({
    /** Served from our own origin; never the customer's marketing host. */
    url: z.string(),
    contentType: BrandLogoTypeSchema,
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    bytes: z.number().int().positive(),
    source: z.enum(["upload", "website"]),
    updatedAt: TimestampSchema,
  })
  .openapi("BrandLogo");

/** The `--sh-*` overrides for one palette; names are allow-listed by `@fundroomhq/ui/theme`. */
export const BrandTokensSchema = z
  .object({
    light: z.record(z.string(), z.string()),
    dark: z.record(z.string(), z.string()),
  })
  .openapi("BrandTokens");

export const ContrastFindingSchema = z
  .object({
    pair: z.string(),
    mode: z.enum(["light", "dark"]),
    ratio: z.number(),
    required: z.number(),
    passes: z.boolean(),
  })
  .openapi("ContrastFinding");

export const BrandingSchema = z
  .object({
    /** Falls back to `core.workspace.name` when the workspace has not overridden it. */
    displayName: z.union([z.string(), z.null()]),
    tagline: z.union([z.string(), z.null()]),
    accentColor: z.union([HexColorSchema, z.null()]),
    fontFamily: BrandFontSchema,
    radius: BrandRadiusSchema,
    logo: z.union([BrandLogoSchema, z.null()]),
    supportEmail: z.union([z.string(), z.null()]),
    showPoweredBy: z.boolean(),
    /** Read-only: derived from the fields above, returned so the SPA can theme immediately. */
    tokens: BrandTokensSchema,
    /** Read-only: what the admin form warns with when a hue cannot reach AA. */
    contrast: z.array(ContrastFindingSchema),
    /** The name actually rendered, i.e. `displayName` or the workspace name. */
    effectiveName: z.string(),
  })
  .openapi("Branding");

export const BrandingPatchBody = z
  .object({
    displayName: z.union([z.string().trim().max(80), z.null()]).optional(),
    tagline: z.union([z.string().trim().max(160), z.null()]).optional(),
    accentColor: z.union([HexColorSchema, z.null()]).optional(),
    fontFamily: BrandFontSchema.optional(),
    radius: BrandRadiusSchema.optional(),
    supportEmail: z.union([EmailSchema, z.null()]).optional(),
    showPoweredBy: z.boolean().optional(),
  })
  .strict();

/**
 * Logo bytes as base64. A JSON body keeps the route inside the ordinary validation and body
 * limit rather than needing a raw route: a logo is capped at 1 MiB, so even base64-expanded
 * it is far below the limit that the resumable document upload path exists to escape.
 */
export const LogoUploadBody = z
  .object({
    data: z.string().min(1).max(2_000_000),
    /** Advisory only — the stored type is decided by the bytes. */
    contentType: BrandLogoTypeSchema.optional(),
  })
  .strict();

/** Pulls the company's Open Graph image or favicon through the SSRF-guarded fetch. */
export const LogoFetchBody = z
  .object({
    url: z.url().max(2048),
  })
  .strict();

export const ThemeDocumentSchema = z.record(z.string(), z.unknown()).openapi("ThemeDocument", {
  description: "W3C Design Tokens document carrying only this workspace's overrides",
});

// --- module enablement ------------------------------------------------------------------------

/**
 * Turning a module on or off for the workspace (the wizard's modules checklist and the admin
 * modules page). `owner-or-admin` rather than a new permission: enablement is not a per-module
 * capability but a decision about the shape of the whole workspace.
 */
export const ModuleEnablementPatchBody = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

export const ModuleEnablementSchema = z
  .object({
    id: z.string(),
    enabled: z.boolean(),
    /**
     * True when the switch cannot move: the kernel requires the module or something depends on it
     * (it cannot be turned off), or it is off and the workspace's plan does not include it
     * (`plan`: it cannot be turned on).
     */
    locked: z.boolean(),
    lockedReason: z.union([z.enum(["required", "dependency", "plan"]), z.null()]),
    dependsOn: z.array(z.string()),
    /**
     * A-3 (ADR-0063): whether the workspace's plan includes the module. Always true for required
     * modules, without a plan and while CONTROL_PLANE=off.
     */
    planAllows: z.boolean(),
    /**
     * On but outside the plan (a downgrade): staff can read and switch it off, not write;
     * investors are unaffected. Such a module is `locked: false` (it can still be turned off).
     */
    readOnly: z.boolean(),
  })
  .openapi("ModuleEnablement");

export const ModuleEnablementListSchema = z
  .object({ modules: z.array(ModuleEnablementSchema) })
  .openapi("ModuleEnablementList");
