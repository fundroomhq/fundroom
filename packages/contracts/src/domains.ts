import { z } from "@hono/zod-openapi";
import { TimestampSchema, trimmedText, UuidSchema } from "./schemas.js";

/*
 * Custom portal domains (E2.1, EXECUTION_PLAN §9.2, design/07 §2.2–2.3, ADR-0039).
 *
 * Handlers live in `apps/server/src/routes/domains.ts` — kernel routes behind a `required`
 * `domains` manifest, the `access` / `compliance` / `branding` precedent, because the
 * hostname → workspace lookup runs in the tenant classifier before tenant context or module
 * enablement exists. A module owning that table would be the kernel reading module tables at
 * request time, and disabling the module would 404 a workspace's own portal. The services are
 * `@fundroom/custom-domains`.
 *
 * This is the *portal* domain. The *sending* (DKIM) domain is `modules/updates`' own contract:
 * a different state machine, a different record set, deliberately not unified.
 *
 * The enum values are spelled out rather than imported from `@fundroom/db` or
 * `@fundroom/custom-domains`: this package keeps no `@fundroom/*` dependencies so the generated
 * SDK builds from the contract alone. The database enum is the authority; a drift shows up as a
 * compile error in the route.
 *
 * `z.union([X, z.null()])` and never `X.nullable()` on a named schema: `.nullable()` on a
 * `.openapi("X")` schema marks the *component* nullable, and the SDK type becomes `X | null`
 * everywhere it is used.
 */

export const CustomDomainStatusSchema = z.enum(["pending", "dns_ok", "active", "failed"]).openapi({
  description:
    "`pending` awaiting DNS, `dns_ok` verified (a certificate may be issued), `active` serving, `failed` gave up after 72 h",
  example: "pending",
});

/** Why a hostname was refused; mirrors `CustomDomainRejection`. The UI has a sentence for each. */
export const CustomDomainRejectionSchema = z
  .enum([
    "empty",
    "not_a_hostname",
    "ip_literal",
    "wildcard",
    "too_long",
    "public_suffix",
    "reserved",
    "canonical_host",
    "canonical_subdomain",
  ])
  .openapi({
    description: "Reason `POST /domains` refused the hostname, in `error.reason`",
    example: "canonical_subdomain",
  });

/** One record the operator must publish. Derived on every read, never stored (decision 4). */
export const DnsInstructionSchema = z
  .object({
    type: z.enum(["CNAME", "TXT", "A"]),
    name: z.string().openapi({ example: "_fundroom-challenge.investors.acme.com" }),
    value: z.string().openapi({ example: "k7q2v9x4m3n8b5c1z6t0r7y2w4e9u3i8" }),
    /** An advisory row (the `manual` driver's CNAME) is `false`: verification does not gate on it. */
    required: z.boolean(),
  })
  .openapi("DnsInstruction");

/** One resolver's answer for one question, as the admin screen shows it. */
export const DnsAnswerSchema = z
  .object({
    name: z.string(),
    type: z.enum(["A", "AAAA", "CNAME", "TXT"]),
    /** Empty when the name exists but has no record of this type (NODATA). */
    values: z.array(z.string()),
    rcode: z.enum(["ok", "nxdomain", "servfail", "refused", "other"]),
    /** Which resolver answered — two must agree before a positive verdict (decision 7). */
    resolver: z.string(),
    /** The CNAME chain walked, outermost first. */
    chain: z.array(z.string()).optional(),
  })
  .openapi("DnsAnswer");

/**
 * The stored `last_answer` (schema version 1). `a` / `aaaa` appear only for an apex whose CNAME
 * did not match, where flattening is checked against the edge's addresses (design/07 §2.3(a)).
 */
export const DomainAnswerSchema = z
  .object({
    cname: z.union([DnsAnswerSchema, z.null()]).optional(),
    txt: z.union([DnsAnswerSchema, z.null()]).optional(),
    a: z.union([DnsAnswerSchema, z.null()]).optional(),
    aaaa: z.union([DnsAnswerSchema, z.null()]).optional(),
  })
  .openapi("DomainAnswer");

export const CustomDomainSchema = z
  .object({
    id: UuidSchema,
    /** Punycode, lower-case, no trailing dot: the one spelling that is ever stored or compared. */
    hostname: z.string().openapi({ example: "investors.acme.com" }),
    status: CustomDomainStatusSchema,
    records: z.array(DnsInstructionSchema),
    /** The last resolver answer (§9.2 "last resolver answer shown in UI"). */
    answer: z.union([DomainAnswerSchema, z.null()]),
    /** One operator-facing sentence naming what DNS actually said. */
    detail: z.union([z.string(), z.null()]),
    /** Consecutive failures; a verified domain is demoted only after the grace count. */
    consecutiveFailures: z.number().int().nonnegative(),
    firstAttemptAt: TimestampSchema,
    /** When a `pending` domain gives up: 72 h after `firstAttemptAt`. */
    deadlineAt: TimestampSchema,
    lastCheckedAt: z.union([TimestampSchema, z.null()]),
    dnsOkAt: z.union([TimestampSchema, z.null()]),
    activatedAt: z.union([TimestampSchema, z.null()]),
    createdAt: TimestampSchema,
    updatedAt: TimestampSchema,
    /**
     * E3.10 (`cloudflare-saas`): the provider's own state for the hostname (`pending`, `active`,
     * `failed`) and the extra ownership / certificate-validation records it asks for. Absent for
     * providers that issue nothing themselves (`caddy-ask`, `manual`).
     */
    providerState: z.enum(["pending", "active", "failed"]).optional(),
    providerRecords: z.array(DnsInstructionSchema).optional(),
  })
  .openapi("CustomDomain");

export const CustomDomainListSchema = z
  .object({
    domains: z.array(CustomDomainSchema),
    /**
     * Which provider is configured. `manual` means this install verifies ownership only and the
     * operator terminates TLS themselves, so the screen must not promise a certificate.
     * `cloudflare-saas` (E3.10): Cloudflare issues the certificate; `active` waits for it.
     */
    driver: z.enum(["caddy-ask", "manual", "cloudflare-saas"]),
    /** What a customer's CNAME must point at; empty when the operator has not configured one. */
    cnameTarget: z.string(),
  })
  .openapi("CustomDomainList");

/**
 * Adding a domain. Normalised and refused server-side (IDNA → punycode, label and total length,
 * public suffix, reserved names, and the canonical host itself): the returned `hostname` may
 * differ from what was sent, and is the only spelling the client should use afterwards.
 */
export const CustomDomainCreateBody = z
  .object({
    hostname: trimmedText({ min: 1, max: 253 }).openapi({ example: "investors.acme.com" }),
  })
  .strict();

/** The path parameter of the two per-domain routes, following `compliance`'s `DocumentIdParam`. */
export const CustomDomainIdParam = z.object({ id: UuidSchema });
