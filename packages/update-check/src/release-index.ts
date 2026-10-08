import { z } from "zod";
import { isPrerelease, MAX_VERSION_LENGTH, parseSemVer } from "./semver.js";

/*
 * The release index, v1 — a static file on a CDN (`https://releases.fundroom.com/index.json`):
 *
 *   { "schemaVersion": 1, "latest": "1.4.2",
 *     "releases": [{ "version": "1.4.2", "date": "2026-10-01", "url": "https://…",
 *                    "security": false, "summary": "…" }] }
 *
 * Validation is strict about everything we read and silent about everything we do not: unknown
 * fields are dropped, so a v1 reader keeps working when the file grows. Everything is bounded —
 * the byte size before `JSON.parse`, the number of releases, every string — because the file
 * comes off the network, and a CDN mistake (or a hostile mirror an operator points
 * `UPDATE_CHECK_URL` at) must cost an `error` status, never memory or a render of whatever HTML
 * it contains. Release URLs must be https: the admin page renders them as links.
 */

/** Largest index accepted, in bytes; the outbound instance enforces the same cap on the wire. */
export const MAX_INDEX_BYTES = 256 * 1024;
export const MAX_RELEASES = 500;
export const MAX_SUMMARY_LENGTH = 500;
export const MAX_URL_LENGTH = 2048;

const VersionSchema = z
  .string()
  .max(MAX_VERSION_LENGTH)
  .refine((v) => parseSemVer(v) !== undefined, "not a strict x.y.z[-pre] version");

const ReleaseSchema = z.object({
  version: VersionSchema,
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/u, "not a YYYY-MM-DD date")
    .refine((d) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)), "not a calendar date"),
  url: z.url({ protocol: /^https$/u }).max(MAX_URL_LENGTH),
  security: z.boolean(),
  summary: z.string().max(MAX_SUMMARY_LENGTH).optional(),
});

export const ReleaseIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    latest: VersionSchema,
    releases: z.array(ReleaseSchema).min(1).max(MAX_RELEASES),
  })
  .superRefine((index, ctx) => {
    const seen = new Set<string>();
    for (const r of index.releases) {
      if (seen.has(r.version)) {
        ctx.addIssue({ code: "custom", message: `release ${r.version} is listed twice` });
      }
      seen.add(r.version);
    }
    const latest = parseSemVer(index.latest);
    // `latest` is what a stable install is told to move to, so it must be a stable release.
    if (latest !== undefined && isPrerelease(latest)) {
      ctx.addIssue({ code: "custom", message: "latest must not be a prerelease" });
    }
    if (!seen.has(index.latest)) {
      ctx.addIssue({ code: "custom", message: "latest is not among the releases" });
    }
  });

export type ReleaseIndex = z.output<typeof ReleaseIndexSchema>;
export type Release = ReleaseIndex["releases"][number];

export type ParseIndexResult =
  | { readonly ok: true; readonly index: ReleaseIndex }
  | { readonly ok: false; readonly reason: string };

/** Parses the index body. Never throws: every failure is a reason string for the log. */
export function parseReleaseIndex(body: string): ParseIndexResult {
  if (Buffer.byteLength(body, "utf8") > MAX_INDEX_BYTES) {
    return { ok: false, reason: `index larger than ${MAX_INDEX_BYTES} bytes` };
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, reason: "index is not JSON" };
  }
  const parsed = ReleaseIndexSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? ` at ${first.path.join(".")}` : "";
    return { ok: false, reason: `index is malformed${where}: ${first?.message ?? "invalid"}` };
  }
  return { ok: true, index: parsed.data };
}
