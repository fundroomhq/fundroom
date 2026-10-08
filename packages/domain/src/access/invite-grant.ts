import { z } from "zod";

/*
 * Grants carried by an invitation (`core.invite.grants`, `grants_schema_version` 1) and by
 * a CSV import's defaults. Applied when the invitee's membership is created (§13.1), so an
 * investor invited "with the Series A data room" sees it on first login.
 */
export const INVITE_GRANTS_SCHEMA_VERSION = 1;

export const InviteGrantSchema = z
  .object({
    resource: z
      .object({
        kind: z.string().regex(/^[a-z][a-z0-9_-]*$/u),
        id: z.uuid(),
        path: z
          .string()
          .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/u)
          .optional(),
      })
      .strict(),
    capabilities: z.array(z.enum(["view", "download", "comment", "edit"])).min(1),
    validUntil: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const InviteGrantsSchema = z.array(InviteGrantSchema).max(50);

export type InviteGrant = z.output<typeof InviteGrantSchema>;

export function parseInviteGrants(raw: unknown): InviteGrant[] {
  const r = InviteGrantsSchema.safeParse(raw ?? []);
  return r.success ? r.data : [];
}
