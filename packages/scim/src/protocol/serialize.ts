import { scimInvalidValue } from "./errors.js";
import {
  GROUP_SCHEMA,
  type GroupState,
  type JsonRecord,
  LIST_RESPONSE_SCHEMA,
  USER_SCHEMA,
  type UserState,
} from "./resources.js";

/*
 * Resource serialisers (RFC 7643 §3, RFC 7644 §3.4.2). Pure. Unassigned attributes are omitted
 * (not `null`); `meta` carries resourceType, created, lastModified, location and a weak version
 * derived from `updated_at`. ListResponse numbers are integers (Okta insists).
 */

export interface StoredMeta {
  readonly id: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface GroupMemberRef {
  readonly id: string;
  readonly display: string | null;
}

/** `{BASE_URL}/scim/v2` without a trailing slash. */
export type ScimBase = string;

function meta(base: ScimBase, kind: "User" | "Group", m: StoredMeta): JsonRecord {
  return {
    resourceType: kind,
    created: m.createdAt.toISOString(),
    lastModified: m.updatedAt.toISOString(),
    location: `${base}/${kind}s/${m.id}`,
    version: `W/"${m.updatedAt.getTime().toString(36)}"`,
  };
}

export function userResource(base: ScimBase, u: UserState & StoredMeta): JsonRecord {
  const name: JsonRecord = {};
  if (u.givenName !== null) name["givenName"] = u.givenName;
  if (u.familyName !== null) name["familyName"] = u.familyName;
  const formatted = [u.givenName, u.familyName].filter((s) => s !== null).join(" ");
  if (formatted.length > 0) name["formatted"] = formatted;
  return {
    schemas: [USER_SCHEMA],
    id: u.id,
    ...(u.externalId === null ? {} : { externalId: u.externalId }),
    userName: u.userName,
    ...(Object.keys(name).length === 0 ? {} : { name }),
    ...(u.displayName === null ? {} : { displayName: u.displayName }),
    ...(u.email === null ? {} : { emails: [{ value: u.email, type: "work", primary: true }] }),
    active: u.active,
    meta: meta(base, "User", u),
  };
}

export function groupResource(
  base: ScimBase,
  g: Omit<GroupState, "members"> & StoredMeta,
  members: readonly GroupMemberRef[] | undefined,
): JsonRecord {
  return {
    schemas: [GROUP_SCHEMA],
    id: g.id,
    displayName: g.displayName,
    ...(g.externalId === null ? {} : { externalId: g.externalId }),
    ...(members === undefined
      ? {}
      : {
          members: members.map((m) => ({
            value: m.id,
            ...(m.display === null ? {} : { display: m.display }),
            $ref: `${base}/Users/${m.id}`,
          })),
        }),
    meta: meta(base, "Group", g),
  };
}

export function listResponse(
  resources: readonly JsonRecord[],
  totalResults: number,
  startIndex: number,
): JsonRecord {
  return {
    schemas: [LIST_RESPONSE_SCHEMA],
    totalResults,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

// --- pagination ----------------------------------------------------------------------------------

export const DEFAULT_PAGE_SIZE = 100;
export const MAX_PAGE_SIZE = 200;

export interface Page {
  /** 1-based, as sent back in the ListResponse. */
  readonly startIndex: number;
  readonly count: number;
}

function intParam(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (!/^-?\d+$/u.test(raw.trim())) throw scimInvalidValue(`${name} must be an integer`);
  return Number.parseInt(raw.trim(), 10);
}

/** RFC 7644 §3.4.2.4: startIndex < 1 → 1; count < 0 → 0; count capped at MAX_PAGE_SIZE. */
export function parsePage(startIndex: string | undefined, count: string | undefined): Page {
  const s = intParam(startIndex, "startIndex");
  const c = intParam(count, "count");
  return {
    startIndex: s === undefined || s < 1 ? 1 : Math.min(s, 2 ** 31 - 1),
    count: c === undefined ? DEFAULT_PAGE_SIZE : Math.max(0, Math.min(c, MAX_PAGE_SIZE)),
  };
}

// --- attribute projection ------------------------------------------------------------------------

export interface Projection {
  readonly attributes?: readonly string[] | undefined;
  readonly excludedAttributes?: readonly string[] | undefined;
}

/** Comma-separated attribute list → names (empty → undefined). */
export function parseAttributeList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return names.length === 0 ? undefined : names;
}

const ALWAYS = new Set(["id", "schemas"]);

/** Strips a URN prefix, lower-cases, splits `name.givenName`. */
function nameParts(raw: string): [string, string | undefined] {
  let rest = raw;
  if (raw.toLowerCase().startsWith("urn:")) rest = raw.slice(raw.lastIndexOf(":") + 1);
  const [a, b] = rest.toLowerCase().split(".", 2);
  return [a ?? "", b];
}

function findKey(obj: JsonRecord, lower: string): string | undefined {
  return Object.keys(obj).find((k) => k.toLowerCase() === lower);
}

/**
 * `attributes` (keep only these, plus `id`/`schemas`) or `excludedAttributes` (drop these,
 * never `id`/`schemas`). Sub-attribute names (`name.givenName`) narrow a complex attribute.
 */
export function project(resource: JsonRecord, p: Projection): JsonRecord {
  if (p.attributes !== undefined) {
    const out: JsonRecord = {};
    for (const k of Object.keys(resource)) if (ALWAYS.has(k)) out[k] = resource[k];
    for (const raw of p.attributes) {
      const [attr, sub] = nameParts(raw);
      const key = findKey(resource, attr);
      if (key === undefined) continue;
      const v = resource[key];
      if (sub === undefined || typeof v !== "object" || v === null || Array.isArray(v)) {
        out[key] = v;
        continue;
      }
      const subKey = findKey(v as JsonRecord, sub);
      if (subKey === undefined) continue;
      const prev = (out[key] as JsonRecord | undefined) ?? {};
      out[key] = { ...prev, [subKey]: (v as JsonRecord)[subKey] };
    }
    return out;
  }
  if (p.excludedAttributes !== undefined) {
    const out: JsonRecord = { ...resource };
    for (const raw of p.excludedAttributes) {
      const [attr, sub] = nameParts(raw);
      const key = findKey(out, attr);
      if (key === undefined || ALWAYS.has(key)) continue;
      const v = out[key];
      if (sub === undefined) {
        delete out[key];
      } else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
        const copy = { ...(v as JsonRecord) };
        const subKey = findKey(copy, sub);
        if (subKey !== undefined) delete copy[subKey];
        out[key] = copy;
      }
    }
    return out;
  }
  return resource;
}

/** Whether a projection leaves `members` out (lets the service skip loading them). */
export function wantsMembers(p: Projection): boolean {
  if (p.attributes !== undefined) {
    return p.attributes.some((a) => nameParts(a)[0] === "members");
  }
  if (p.excludedAttributes !== undefined) {
    return !p.excludedAttributes.some(
      (a) => nameParts(a)[0] === "members" && nameParts(a)[1] === undefined,
    );
  }
  return true;
}
