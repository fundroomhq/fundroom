import { z } from "@hono/zod-openapi";
import { TimestampSchema, UuidSchema } from "./schemas.js";

/*
 * Jobs, dead letters and health (E2.7): `GET /ops/jobs`, dead-letter retry and discard, and
 * `GET /ops/health` — the plan's `/admin/health/deep`. Handlers live in
 * `apps/server/src/routes/ops-admin.ts`, kernel routes behind the required `ops` manifest.
 *
 * Two rules shape every schema here:
 *
 *  - **Scope follows tenancy.** Queue statistics and the adapter checks describe the whole
 *    instance, which on a multi-tenant install is every other customer's traffic too, so they
 *    are reported only when `TENANCY_MODE=single` (`scope: "instance"`). Dead letters and the
 *    workspace's own domains are reported in both modes, and only ever the workspace's own.
 *  - **A dead letter never carries its payload.** Job payloads hold emails, names, document
 *    titles; the page shows which keys were present, the event topic and id when it is an event
 *    job, and the error message cut to 2000 characters — enough to decide "retry or discard",
 *    not enough to become a second copy of personal data outside the modules that own it.
 */

export const OpsScopeSchema = z.enum(["instance", "workspace"]).openapi({
  description:
    "`instance` on a single-tenant install (queue stats and adapter checks included), `workspace` on a multi-tenant one",
  example: "workspace",
});

export const QueueStatsSchema = z
  .object({
    name: z.string().openapi({ example: "event.document.viewed" }),
    queued: z.number().int(),
    active: z.number().int(),
    failed: z.number().int(),
  })
  .openapi("QueueStats");

export const DeadLetterItemSchema = z
  .object({
    id: UuidSchema,
    sourceQueue: z.string().openapi({ example: "event.acl.changed" }),
    failedAt: TimestampSchema,
    retries: z.number().int(),
    error: z.string().max(2000).openapi({ description: "The last error message, truncated" }),
    dataKeys: z.array(z.string()).openapi({
      description: "Top-level payload keys, sorted. The payload itself is never returned.",
      example: ["outboxId", "payload", "subscriber", "topic", "workspaceId"],
    }),
    topic: z.string().optional().openapi({ example: "acl.changed" }),
    eventId: z.string().optional().openapi({ description: "Outbox id of an event job" }),
    subscriber: z.string().optional().openapi({ example: "access.rebuild" }),
  })
  .openapi("DeadLetterItem");

export const OpsJobsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50).openapi({ example: 50 }),
});

export const OpsJobsSchema = z
  .object({
    scope: OpsScopeSchema,
    queues: z.array(QueueStatsSchema),
    deadLetters: z.object({
      count: z.number().int(),
      items: z.array(DeadLetterItemSchema),
    }),
  })
  .openapi("OpsJobs");

export const DeadLetterIdParam = z.object({
  id: UuidSchema.openapi({ param: { name: "id", in: "path" } }),
});

export const HealthStatusSchema = z.enum(["ok", "degraded", "down", "skipped"]).openapi({
  description: "`degraded` = a non-critical dependency (mail, rendering, scanning, DNS) failed",
  example: "ok",
});

export const HealthCheckSchema = z
  .object({
    name: z.string().openapi({ example: "db" }),
    status: HealthStatusSchema,
    detail: z.union([z.string(), z.null()]),
    latencyMs: z.union([z.number().int(), z.null()]),
  })
  .openapi("HealthCheck");

export const CertStatusSchema = z
  .enum(["valid", "invalid", "expired", "unreachable", "not_checked"])
  .openapi({
    description:
      "`not_checked` for a domain that is not verified (nothing is contacted); `invalid` = the chain or hostname does not verify (see `certError`)",
    example: "valid",
  });

export const DomainHealthSchema = z
  .object({
    hostname: z.string().openapi({ example: "investors.acme.com" }),
    status: z.enum(["pending", "dns_ok", "active", "failed"]).openapi({
      description: "The custom domain's own status (see `CustomDomain.status`)",
    }),
    certStatus: CertStatusSchema,
    certExpiresAt: z.union([TimestampSchema, z.null()]),
    certIssuer: z.union([z.string(), z.null()]),
    certError: z.union([z.string(), z.null()]),
    checkedAt: z.union([TimestampSchema, z.null()]),
  })
  .openapi("DomainHealth");

export const OpsHealthSchema = z
  .object({
    scope: OpsScopeSchema,
    checks: z.array(HealthCheckSchema),
    domains: z.array(DomainHealthSchema),
  })
  .openapi("OpsHealth");

/*
 * Update check (E2.9, design/07 §4.4): `GET /ops/update`. The running version against the
 * release index (`UPDATE_CHECK_URL`), fetched lazily by the server and cached (12 h after a
 * success, 1 h after a failure). The version an install runs is an instance fact, so it is
 * answered only on a single-tenant install; a multi-tenant host says `disabled` /
 * `multi_tenant` without fetching anything. Never an instruction to update: the self-hoster owns
 * change control.
 */
export const UpdateStatusKindSchema = z
  .enum(["disabled", "unknown", "current", "update_available", "security_update", "error"])
  .openapi({
    description:
      "`unknown` = a development build (0.0.0) or prerelease, which has no place in the release line; `security_update` = at least one security release is newer than this build; `error` = the release index could not be fetched or did not validate",
    example: "current",
  });

export const UpdateStatusSchema = z
  .object({
    status: UpdateStatusKindSchema,
    reason: z.enum(["opted_out", "multi_tenant"]).optional().openapi({
      description:
        "Why the check is `disabled`: `UPDATE_CHECK=false`, or a multi-tenant host (the operator's concern)",
    }),
    currentVersion: z.string().openapi({ example: "1.4.0" }),
    latestVersion: z.string().optional().openapi({ example: "1.4.2" }),
    checkedAt: TimestampSchema.optional().openapi({
      description: "When the release index was fetched (or the fetch failed)",
    }),
    releaseUrl: z
      .url({ protocol: /^https$/u })
      .optional()
      .openapi({
        description: "Release notes of `latestVersion`",
        example: "https://github.com/fundroomhq/fundroom/releases/tag/v1.4.2",
      }),
    securityReleases: z
      .array(z.string())
      .optional()
      .openapi({
        description: "Security releases newer than `currentVersion`, newest first",
        example: ["1.4.1"],
      }),
  })
  .openapi("UpdateStatus");
