import { z } from "@hono/zod-openapi";
import { TimestampSchema, trimmedText, UuidSchema } from "./schemas.js";

/*
 * View-as-investor contracts (E2.7 package B2): `ViewAsState`, `POST /access/people/{id}/view-as`,
 * `GET`/`DELETE /me/view-as`.
 *
 * A staff session may look at the portal *as* one external member of the workspace for 30
 * minutes: every request in that workspace is then served with the investor's membership, read
 * only (a mutating request answers 403 `view_as_read_only`), and nothing the investor's own
 * visit would record (engagement, exposure stamps, view audits) is written.
 */

export const ViewAsStateSchema = z
  .object({
    workspaceId: UuidSchema,
    /** The external membership being viewed as. */
    membershipId: UuidSchema,
    /** The member's display name; null when it cannot be shown (erased). */
    name: z.union([z.string(), z.null()]),
    startedAt: TimestampSchema,
    /** The view ends on its own at this instant (started + 30 minutes). */
    until: TimestampSchema,
  })
  .openapi("ViewAsState");

export const ViewAsResponseSchema = z
  .object({ viewAs: z.union([ViewAsStateSchema, z.null()]) })
  .openapi("ViewAsResponse");

export const StartViewAsBody = z
  .object({
    /** Why staff are looking (kept in the audit trail). */
    reason: trimmedText({ min: 3, max: 500 }),
  })
  .openapi("StartViewAsBody");

export const StartViewAsResponseSchema = z
  .object({ viewAs: ViewAsStateSchema })
  .openapi("StartViewAsResponse");

export const PersonIdParam = z.object({ id: UuidSchema });

/** How long a view lasts. */
export const VIEW_AS_TTL_MS = 30 * 60_000;
