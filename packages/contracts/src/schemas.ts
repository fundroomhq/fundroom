import { z } from "@hono/zod-openapi";

/** Shared field vocabulary. Modules reuse these so the generated client sees one type per concept. */

export const UuidSchema = z.uuid().openapi({
  example: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a",
  description: "UUID (v7 for rows this server created)",
});

export const EmailSchema = z.email().max(320).openapi({ example: "ada@example.com" });

/** Workspace slug: DNS label (`core.workspace.slug` CHECK). */
/**
 * Path segments reserved under `/embed/`, and therefore unavailable as workspace slugs (E2.2,
 * ADR-0040 decision 9). `${basePath}/embed/v1/embed.js` serves the loader, so a workspace slugged
 * `v1` would have an embed URL the classifier cannot route — the collision is decided in favour of
 * the loader, because one workspace's name is negotiable and the published snippet URL is not.
 * Refusing the slug at creation is the honest half of that: a workspace that could be created and
 * then could never be embedded is worse than a name the founder has to change once.
 */
export const RESERVED_SLUG_RE = /^(?:v\d+|\d+\.\d+\.\d+)$/u;

export const SlugSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u, "lower-case DNS label")
  .refine((v) => !RESERVED_SLUG_RE.test(v), {
    message: "version-shaped slugs are reserved for the embed loader",
  })
  .openapi({ example: "acme" });

export const TimestampSchema = z.iso.datetime({ offset: true }).openapi({
  example: "2026-09-11T10:15:30.000Z",
  description: "RFC 3339 timestamp, UTC",
});

export const OkSchema = z.object({ ok: z.literal(true) }).openapi("Ok");

export const RequestIdHeaderSchema = z.object({
  "x-request-id": z
    .string()
    .max(128)
    .optional()
    .openapi({ description: "Client-supplied request id; echoed back when it is well-formed" }),
});

export function paginationQuery(maxLimit = 100) {
  return z.object({
    cursor: z
      .string()
      .max(512)
      .optional()
      .openapi({ description: "Opaque cursor from a previous page" }),
    limit: z.coerce.number().int().min(1).max(maxLimit).default(Math.min(50, maxLimit)),
  });
}

export function page<T extends z.ZodType>(item: T, name?: string) {
  const schema = z.object({
    items: z.array(item),
    nextCursor: z.string().nullable().openapi({ description: "`null` on the last page" }),
  });
  return name === undefined ? schema : schema.openapi(name);
}

export function isoDate(d: Date): string {
  return d.toISOString();
}
