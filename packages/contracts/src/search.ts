import { z } from "@hono/zod-openapi";
import { TimestampSchema, UuidSchema } from "./schemas.js";

/*
 * Workspace search contracts (E2.8): `GET /search`. Handler: `apps/server/src/routes/search.ts`;
 * the index and query engine: `@fundroom/search`.
 */

const KIND_RE = /^[a-z][a-z0-9_-]{0,63}$/u;

export const SearchQuery = z.object({
  q: z.string().min(1).max(200).openapi({
    description:
      "Words to find, separated by spaces; each is read the way the index reads text, so `john.doe@acme.com`, `report_final.pdf` or `Q3-2025` match as typed. The last word matches as a prefix. 400 `search_query_invalid` when nothing searchable is left.",
    example: "pitch deck",
  }),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).max(500).default(0),
  kinds: z
    .string()
    .max(512)
    .refine((v) => v.split(",").every((k) => KIND_RE.test(k.trim())), {
      message: "comma-separated kinds",
    })
    .optional()
    .openapi({
      description: "Comma-separated result kinds to keep (`document,page,post`); all when omitted",
      example: "document,post",
    }),
});

export const SearchSnippetSegmentSchema = z
  .object({
    text: z.string(),
    highlight: z.boolean().openapi({ description: "True for the parts that matched the query" }),
  })
  .openapi("SearchSnippetSegment");

export const SearchHitSchema = z
  .object({
    module: z.string().openapi({ example: "data-room" }),
    kind: z.string().openapi({ example: "document" }),
    refId: UuidSchema,
    title: z.string(),
    snippet: z.array(SearchSnippetSegmentSchema).openapi({
      description:
        "Plain-text segments of the matching body (never HTML); empty when the hit is gated or only its title matched",
    }),
    href: z.string().openapi({
      description: "SPA path the hit opens",
      example: "/data-room/documents/0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a",
    }),
    updatedAt: TimestampSchema,
    gated: z.boolean().openapi({
      description:
        "The caller may see that this exists but must clear a gate (NDA, accreditation) to open it; no body text is returned",
    }),
  })
  .openapi("SearchHit");

export const SearchResultsSchema = z
  .object({
    query: z.string(),
    hits: z.array(SearchHitSchema),
    hasMore: z.boolean(),
  })
  .openapi("SearchResults");
