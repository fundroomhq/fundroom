import { z } from "zod";
import {
  MAX_INDEX_BYTES,
  MAX_RELEASES,
  parseReleaseIndex,
  type Release,
  type ReleaseIndex,
} from "./release-index.js";
import { compareSemVer, isPrerelease, parseSemVer, type SemVer } from "./semver.js";

/*
 * Builds the next release index (B-11) from the GitHub releases and the index already published.
 * Pure: the publisher (`index-publisher.ts`) does the I/O. The same inputs give the same bytes.
 *
 * - **What is listed.** Every published (non-draft) GitHub release whose tag is `v<x.y.z[-pre]>`,
 *   prereleases included (a reader ignores them for a stable install). Other tags (`chart-v*`,
 *   `wp-v*`) are not FundRoom releases and are skipped. Newest first by SemVer precedence.
 * - **Fields.** `date` is the publish date (UTC), `url` the GitHub release page, `summary` is
 *   carried over from the published index (nothing writes a new one today). `latest` is the
 *   highest stable release, omitted while there is none.
 * - **`security`, deterministic and never hand-edited.** In order of precedence:
 *     1. `markSecurity` / `clearSecurity` (the "Release index" workflow's dispatch inputs);
 *     2. the flag already in the published index, for a release already listed;
 *     3. for a release entering the index, whether its notes carry a security changeset: an
 *        entry that starts with `**Security:**` (a changeset whose summary starts with it; CI
 *        requires such a changeset to name @fundroom/server, whose CHANGELOG is the notes).
 *        The notes are `notes`, the `## <version>` section of apps/server/CHANGELOG.md at the
 *        release's tag (attached by `scripts/release/release-index.mjs prepare`), never the
 *        GitHub release body: that body is cut to fit GitHub's size limit, and the cut drops
 *        trailing entries, which is where a patch-level security entry sits.
 *   So a flag set by dispatch survives every later publish, and a release's notes are read once.
 * - **Never shrinks by accident.** A version in the published index that GitHub no longer lists
 *   is refused unless `allowRemoval` (a deleted release is deliberate; a short API page is not).
 * - **Bounded.** Over MAX_RELEASES or MAX_INDEX_BYTES, the oldest prereleases are dropped first;
 *   if it still does not fit, the build fails rather than drop a stable release.
 * - **Validated.** The output is re-read with `parseReleaseIndex`, the reader's own parser; a
 *   build that does not pass it is a failure, never an upload.
 */

/**
 * The fields read from GitHub's "list releases" API (`gh api …/releases`), plus `notes`, which
 * `release-index.mjs prepare` adds: the release's CHANGELOG section at its tag, `null` when the
 * tag has none. Absent means the list was not prepared, and a new release is then refused.
 */
export interface GitHubRelease {
  readonly tag_name: string;
  readonly html_url: string;
  readonly published_at: string | null;
  readonly draft: boolean;
  readonly notes?: string | null | undefined;
}

const GitHubReleaseSchema = z.object({
  tag_name: z.string(),
  html_url: z.string(),
  published_at: z.string().nullable(),
  draft: z.boolean(),
  notes: z.string().nullable().optional(),
});

/**
 * The releases in a `gh api` response: one page (an array of releases) or the pages of
 * `gh api --paginate --slurp` (an array of arrays). Throws on anything else.
 */
export function parseGitHubReleases(json: unknown): GitHubRelease[] {
  if (!Array.isArray(json)) throw new Error("GitHub releases: expected a JSON array");
  const flat = json.every(Array.isArray) ? (json as unknown[][]).flat() : json;
  return flat.map((r, i) => {
    const parsed = GitHubReleaseSchema.safeParse(r);
    if (!parsed.success) {
      throw new Error(
        `GitHub releases: entry ${i} is not a release (${parsed.error.issues[0]?.message})`,
      );
    }
    return parsed.data;
  });
}

/** The marker a security changeset's summary starts with. */
export const SECURITY_MARKER = "**Security:**";

/*
 * A changelog entry whose summary starts with the marker, the same test as check-changesets.mjs's
 * `isSecurityChangeset` on the changeset itself. Only the prefixes the two changelog writers put
 * before a summary are skipped: @changesets/changelog-github's
 * `- [#PR](url) [`sha`](url) Thanks [@a](url), [@b](url)! - <summary>` (each part optional, the
 * ` - ` only after a prefix) and the default writer's `- <sha7>: <summary>`. Anything else before
 * the marker (`- Fix x - **Security:** …`) is text, not a security entry.
 */
const LINK = String.raw`\(\S+?\)`;
const PR = String.raw`\[#\d+\]${LINK}`;
const TICK = "`";
const COMMIT = String.raw`\[${TICK}[0-9a-f]{7,40}${TICK}\]${LINK}`;
const USER = String.raw`\[@[\w.-]+\]${LINK}`;
const THANKS = `Thanks ${USER}(?:, ${USER})*!`;
const GITHUB_PREFIX = `(?:${PR}|${COMMIT}|${THANKS})(?: (?:${COMMIT}|${THANKS}))* - `;
const SECURITY_ENTRY = new RegExp(
  String.raw`^- (?:${GITHUB_PREFIX}|[0-9a-f]{7,40}: )?\*\*Security:\*\*`,
  "mu",
);

/** Whether release notes contain a security changeset entry. */
export function hasSecurityEntry(notes: string | null | undefined): boolean {
  return notes !== null && notes !== undefined && SECURITY_ENTRY.test(notes);
}

/** `v1.2.3` / `1.2.3` → `1.2.3`; anything that is not a strict version → undefined. */
export function versionOfTag(tag: string): string | undefined {
  const v = tag.startsWith("v") ? tag.slice(1) : tag;
  return parseSemVer(v) === undefined ? undefined : v;
}

export interface BuildIndexOptions {
  /** The published index, or undefined when there is none (first publish, or a rebuild). */
  readonly current?: ReleaseIndex | undefined;
  readonly releases: readonly GitHubRelease[];
  /** Versions to flag as security releases (`1.2.3` or `v1.2.3`); must be listed. */
  readonly markSecurity?: readonly string[] | undefined;
  /** Versions whose security flag to clear; must be listed. */
  readonly clearSecurity?: readonly string[] | undefined;
  /** Let versions GitHub no longer lists drop out of the index. */
  readonly allowRemoval?: boolean | undefined;
}

export type BuildIndexResult =
  | {
      readonly ok: true;
      readonly index: ReleaseIndex;
      /** The bytes to upload: the index as indented JSON and a final newline. */
      readonly body: string;
      /** Versions new to the index. */
      readonly added: readonly string[];
      /** Versions in the published index that are not in this one (removed, or over the bounds). */
      readonly removed: readonly string[];
      /** Tags of published releases that are not FundRoom versions (`chart-v1.0.0`, …). */
      readonly skippedTags: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

const serialize = (index: ReleaseIndex): string => `${JSON.stringify(index, null, 2)}\n`;

function normalizeList(list: readonly string[] | undefined, what: string): Set<string> | string {
  const out = new Set<string>();
  for (const raw of list ?? []) {
    const v = versionOfTag(raw.trim());
    if (v === undefined) return `${what}: ${JSON.stringify(raw)} is not a version`;
    out.add(v);
  }
  return out;
}

export function buildReleaseIndex(options: BuildIndexOptions): BuildIndexResult {
  const fail = (reason: string): BuildIndexResult => ({ ok: false, reason });
  const mark = normalizeList(options.markSecurity, "security");
  if (typeof mark === "string") return fail(mark);
  const clear = normalizeList(options.clearSecurity, "not-security");
  if (typeof clear === "string") return fail(clear);
  for (const v of mark) {
    if (clear.has(v)) return fail(`${v} is both marked and cleared as a security release`);
  }

  const previous = new Map((options.current?.releases ?? []).map((r) => [r.version, r]));
  const listed: { release: Release; v: SemVer }[] = [];
  const skippedTags: string[] = [];
  const seen = new Set<string>();
  for (const gh of options.releases) {
    if (gh.draft || gh.published_at === null) continue;
    const version = gh.tag_name.startsWith("v") ? versionOfTag(gh.tag_name) : undefined;
    const v = version === undefined ? undefined : parseSemVer(version);
    if (version === undefined || v === undefined) {
      skippedTags.push(gh.tag_name);
      continue;
    }
    if (seen.has(version)) return fail(`GitHub lists ${gh.tag_name} twice`);
    seen.add(version);
    const published = new Date(gh.published_at);
    if (Number.isNaN(published.getTime())) {
      return fail(`${gh.tag_name}: published_at ${JSON.stringify(gh.published_at)} is not a date`);
    }
    const before = previous.get(version);
    if (before === undefined && gh.notes === undefined) {
      return fail(
        `${gh.tag_name} has no notes: the release list was not prepared (release-index.mjs prepare)`,
      );
    }
    const security = mark.has(version)
      ? true
      : clear.has(version)
        ? false
        : before !== undefined
          ? before.security
          : hasSecurityEntry(gh.notes);
    listed.push({
      v,
      release: {
        version,
        date: published.toISOString().slice(0, 10),
        url: gh.html_url,
        security,
        ...(before?.summary === undefined ? {} : { summary: before.summary }),
      },
    });
  }

  for (const v of [...mark, ...clear]) {
    if (!seen.has(v)) return fail(`${v} is not a published release, so it cannot be (un)marked`);
  }
  const gone = [...previous.keys()].filter((v) => !seen.has(v));
  if (gone.length > 0 && options.allowRemoval !== true) {
    return fail(
      `the published index lists ${gone.join(", ")}, which GitHub no longer lists as published; ` +
        "re-run with allow-removal if that release was deleted on purpose",
    );
  }
  if (listed.length === 0) return fail("GitHub lists no published v<x.y.z> release");

  listed.sort((a, b) => compareSemVer(b.v, a.v));
  const build = (): ReleaseIndex => {
    const stable = listed.find((r) => !isPrerelease(r.v));
    return {
      schemaVersion: 1,
      ...(stable === undefined ? {} : { latest: stable.release.version }),
      releases: listed.map((r) => r.release),
    };
  };
  let index = build();
  let body = serialize(index);
  while (listed.length > MAX_RELEASES || Buffer.byteLength(body, "utf8") > MAX_INDEX_BYTES) {
    // Oldest prerelease first: `listed` is newest first, so the last prerelease in it.
    const at = listed.findLastIndex((r) => isPrerelease(r.v));
    if (at === -1) {
      return fail(
        `the index does not fit (${listed.length} stable releases; at most ${MAX_RELEASES} releases and ${MAX_INDEX_BYTES} bytes)`,
      );
    }
    listed.splice(at, 1);
    index = build();
    body = serialize(index);
  }

  const parsed = parseReleaseIndex(body);
  if (!parsed.ok) return fail(`built index does not validate: ${parsed.reason}`);
  const kept = new Set(index.releases.map((r) => r.version));
  return {
    ok: true,
    index: parsed.index,
    body,
    added: index.releases.map((r) => r.version).filter((v) => !previous.has(v)),
    removed: [...previous.keys()].filter((v) => !kept.has(v)),
    skippedTags,
  };
}
