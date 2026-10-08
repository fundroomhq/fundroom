import type { SearchAcl, SearchEntryInput } from "@fundroom/module-kit";
import { cleanText, MAX_BODY_CHARS, MAX_TITLE_CHARS, truncateChars } from "./text.js";

/*
 * Validation and normalisation of what modules hand `services.search` (E2.8). A malformed entry
 * (bad kind, ref, part, href, ACL shape, date — the SHAPE the module builds) is a programming error
 * in the module, so it throws `SearchEntryError` naming the module, the ref and the field — at
 * write time, inside the module's own transaction, where the stack trace points at the caller —
 * rather than surfacing later as an opaque CHECK violation.
 *
 * What users typed never throws: the index write runs inside the user's own transaction (a
 * rename, a publish), and a title the route accepted must not turn into a 500 there. Text is
 * cleaned and cut to size; a title with nothing left after cleaning is stored as
 * `SEARCH_UNTITLED`.
 */

/**
 * Title stored for an entry whose title is empty once control characters and surrounding
 * whitespace are removed (e.g. a document renamed to a lone control character). A neutral mark,
 * not a word — the SPA may show a localised "Untitled" for a hit with exactly this title.
 */
export const SEARCH_UNTITLED = "\u2014";

export class SearchEntryError extends Error {
  override readonly name = "SearchEntryError";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Module ids are kebab-case (`MODULE_ID_RE` in module-kit). */
export const SEARCH_MODULE_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/u;
/** The same shape `GET /search?kinds=` accepts. */
export const SEARCH_KIND_RE = /^[a-z][a-z0-9_-]{0,63}$/u;
/** Resource kinds as authz knows them (`folder`, `document`, `post`). */
const RESOURCE_KIND_RE = /^[a-z][a-z0-9_-]{0,63}$/u;
/** An ltree path: dot-separated labels of letters, digits and underscores. */
const LTREE_RE = /^[A-Za-z0-9_]{1,256}(\.[A-Za-z0-9_]{1,256}){0,63}$/u;
const MAX_PART_CHARS = 128;
const MAX_HREF_CHARS = 2_048;
const MAX_GROUPS = 256;
// biome-ignore lint/suspicious/noControlCharactersInRegex: an href must not carry control characters
const HREF_BAD_RE = /[\u0000-\u001f\u007f\\\s]/u;

export function isUuid(v: string): boolean {
  return UUID_RE.test(v);
}

/** One row of `core.search_entry` as the repo writes it. */
export interface SearchRow {
  readonly module: string;
  readonly kind: string;
  readonly refId: string;
  readonly part: string;
  readonly title: string;
  readonly body: string;
  readonly href: string;
  readonly aclKind: SearchAcl["kind"];
  readonly aclGroups: readonly string[] | null;
  readonly aclResourceKind: string | null;
  readonly aclResourceId: string | null;
  readonly aclPath: string | null;
  readonly sourceUpdatedAt: Date;
}

export function assertModuleId(module: string): void {
  if (typeof module !== "string" || !SEARCH_MODULE_RE.test(module))
    throw new SearchEntryError(`search: module id ${JSON.stringify(module)} is not kebab-case`);
}

export function assertKind(module: string, kind: string): void {
  if (typeof kind !== "string" || !SEARCH_KIND_RE.test(kind))
    throw new SearchEntryError(
      `search(${module}): kind ${JSON.stringify(kind)} must match ${SEARCH_KIND_RE.source}`,
    );
}

export function assertRefId(module: string, refId: string): void {
  if (typeof refId !== "string" || !UUID_RE.test(refId))
    throw new SearchEntryError(`search(${module}): refId ${JSON.stringify(refId)} must be a uuid`);
}

export function normalizePart(module: string, part: string | undefined): string {
  const p = part ?? "";
  if (typeof p !== "string" || p.length > MAX_PART_CHARS || cleanText(p) !== p)
    throw new SearchEntryError(
      `search(${module}): part must be a string of at most ${MAX_PART_CHARS} characters without control characters`,
    );
  return p;
}

function aclOf(
  where: string,
  acl: SearchAcl,
): Pick<SearchRow, "aclKind" | "aclGroups" | "aclResourceKind" | "aclResourceId" | "aclPath"> {
  const none = { aclGroups: null, aclResourceKind: null, aclResourceId: null, aclPath: null };
  if (acl === null || typeof acl !== "object")
    throw new SearchEntryError(`${where}: acl is required`);
  switch (acl.kind) {
    case "members":
      return { aclKind: "members", ...none };
    case "staff":
      return { aclKind: "staff", ...none };
    case "groups": {
      const ids = acl.groupIds;
      if (!Array.isArray(ids) || ids.length === 0)
        throw new SearchEntryError(
          `${where}: acl kind "groups" needs at least one group id (use kind "staff" for nobody outside staff)`,
        );
      if (ids.length > MAX_GROUPS)
        throw new SearchEntryError(`${where}: acl names more than ${MAX_GROUPS} groups`);
      for (const id of ids)
        if (typeof id !== "string" || !UUID_RE.test(id))
          throw new SearchEntryError(`${where}: acl group id ${JSON.stringify(id)} is not a uuid`);
      return {
        ...none,
        aclKind: "groups",
        aclGroups: [...new Set(ids.map((i) => i.toLowerCase()))],
      };
    }
    case "resource": {
      if (typeof acl.resourceKind !== "string" || !RESOURCE_KIND_RE.test(acl.resourceKind))
        throw new SearchEntryError(
          `${where}: acl resourceKind ${JSON.stringify(acl.resourceKind)} is not a resource kind`,
        );
      if (typeof acl.resourceId !== "string" || !UUID_RE.test(acl.resourceId))
        throw new SearchEntryError(
          `${where}: acl resourceId ${JSON.stringify(acl.resourceId)} is not a uuid`,
        );
      if (acl.path !== undefined && (typeof acl.path !== "string" || !LTREE_RE.test(acl.path)))
        throw new SearchEntryError(
          `${where}: acl path ${JSON.stringify(acl.path)} is not an ltree path (labels of letters, digits, underscores)`,
        );
      return {
        aclKind: "resource",
        aclGroups: null,
        aclResourceKind: acl.resourceKind,
        aclResourceId: acl.resourceId.toLowerCase(),
        aclPath: acl.path ?? null,
      };
    }
    default:
      throw new SearchEntryError(
        `${where}: acl kind ${JSON.stringify((acl as { kind?: unknown }).kind)} is not members|groups|staff|resource`,
      );
  }
}

/**
 * Validates one entry and normalises it into a row: title/body control characters become
 * spaces, the title is cut to `MAX_TITLE_CHARS` (an empty one becomes `SEARCH_UNTITLED`) and the
 * body to `MAX_BODY_CHARS` (on a code-point boundary). Throws `SearchEntryError` on a malformed
 * entry (wrong types, ids, ACL shape, or an href unsafe to hand a browser) — never on its text.
 */
export function toSearchRow(module: string, entry: SearchEntryInput): SearchRow {
  assertModuleId(module);
  if (entry === null || typeof entry !== "object")
    throw new SearchEntryError(`search(${module}): entry must be an object`);
  assertKind(module, entry.kind);
  assertRefId(module, entry.refId);
  const where = `search(${module}) ${entry.kind}/${entry.refId}`;
  const part = normalizePart(module, entry.part);
  if (typeof entry.title !== "string")
    throw new SearchEntryError(`${where}: title must be a string`);
  const cleaned = truncateChars(cleanText(entry.title).trim(), MAX_TITLE_CHARS);
  const title = cleaned.length === 0 ? SEARCH_UNTITLED : cleaned;
  if (entry.body !== undefined && typeof entry.body !== "string")
    throw new SearchEntryError(`${where}: body must be a string`);
  const body = truncateChars(cleanText(entry.body ?? ""), MAX_BODY_CHARS);
  const href = entry.href;
  if (
    typeof href !== "string" ||
    !href.startsWith("/") ||
    href.startsWith("//") ||
    href.length > MAX_HREF_CHARS ||
    HREF_BAD_RE.test(href)
  )
    throw new SearchEntryError(
      `${where}: href ${JSON.stringify(href)} must be an SPA path starting with a single "/" (no scheme, host, backslash, whitespace or control characters; at most ${MAX_HREF_CHARS} characters)`,
    );
  if (!(entry.updatedAt instanceof Date) || Number.isNaN(entry.updatedAt.getTime()))
    throw new SearchEntryError(`${where}: updatedAt must be a valid Date`);
  return {
    module,
    kind: entry.kind,
    refId: entry.refId.toLowerCase(),
    part,
    title,
    body,
    href,
    ...aclOf(where, entry.acl),
    sourceUpdatedAt: entry.updatedAt,
  };
}

/** Key of the unique index `search_entry_ref_idx` within one workspace. */
export function rowKey(r: Pick<SearchRow, "module" | "kind" | "refId" | "part">): string {
  return `${r.module}\u0000${r.kind}\u0000${r.refId}\u0000${r.part}`;
}
