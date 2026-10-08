import { z } from "@hono/zod-openapi";
import { BillingPlanSchema } from "./billing.js";
import { CountryCodeSchema, PlanIdSchema } from "./platform.js";
import { JurisdictionSchema } from "./residency.js";
import { EmailSchema, SlugSchema } from "./schemas.js";

/*
 * Self-service signup (E3.10, ADR-0058): `/api/v1/signup/*` on the canonical host (no workspace),
 * handlers in `apps/server/src/routes/signup.ts`. Only with SIGNUP_MODE=open (else 404
 * `not_found`). `start` answers the same `{ ok: true }` after a constant floor whatever the email
 * is; nothing here ever says whether an address already has an account.
 */

export const SignupSlugQuery = z.object({ slug: SlugSchema });

export const SignupSlugAvailabilitySchema = z
  .object({
    slug: SlugSchema,
    available: z.boolean().openapi({
      description: "Slugs are public hostnames, so availability is not a secret",
    }),
  })
  .openapi("SignupSlugAvailability");

/** `GET /api/v1/signup/regions` (E3.11): where a new workspace's data can live. */
export const SignupRegionSchema = z
  .object({
    region: z.string(),
    label: z.string(),
    jurisdiction: z.union([JurisdictionSchema, z.null()]),
    signupUrl: z.union([z.string(), z.null()]).openapi({
      description: "null: sign up on this origin; else the signup page of the cell serving it",
    }),
  })
  .openapi("SignupRegion");

export const SignupRegionListSchema = z
  .object({ items: z.array(SignupRegionSchema) })
  .openapi("SignupRegionList");

/**
 * `GET /api/v1/signup/plans` (A-5): the plans a new workspace may choose — public and unarchived,
 * in catalogue order. No prices: the product stores only the provider's price ids, so display
 * prices are the marketing site's.
 */
export const SignupPlanSchema = BillingPlanSchema.extend({
  paid: z.boolean().openapi({
    description:
      "The plan has a provider price and workspaces subscribe themselves (a subscription is needed once any trial ends)",
  }),
}).openapi("SignupPlan");

export const SignupPlansSchema = z
  .object({ plans: z.array(SignupPlanSchema) })
  .openapi("SignupPlans");

export const SignupStartBody = z.strictObject({
  email: EmailSchema,
  companyName: z.string().trim().min(1).max(100),
  legalName: z.string().trim().min(1).max(200),
  country: CountryCodeSchema,
  slug: SlugSchema,
  locale: z
    .string()
    .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u)
    .optional(),
  acceptTerms: z.literal(true).openapi({
    description: "The applicant accepted the managed host's terms (required; stored with the code)",
  }),
  termsVersion: z.number().int().min(1).max(10_000).openapi({
    description:
      "The terms version the applicant was shown; a stale one is 409 `conflict` (`reason: terms_version`, `current`)",
    example: 1,
  }),
});

export const SignupVerifyBody = z.strictObject({
  email: EmailSchema,
  code: z.string().min(4).max(12).openapi({ example: "123456" }),
  planId: PlanIdSchema.optional().openapi({
    description:
      "The plan the applicant chose; a plan that is not public and live falls back to the default",
  }),
});

export const SignupCompleteSchema = z
  .object({
    workspaceUrl: z.url().openapi({
      description:
        "Where the new owner goes next on the workspace's portal (`<slug>.<canonical>` or `/w/<slug>`): `/admin/billing?plan=<id>` when the plan needs a subscription now (public, paid, no trial), else `/setup`",
    }),
  })
  .openapi("SignupComplete");
