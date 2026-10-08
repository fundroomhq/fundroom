import { core } from "@fundroom/db";
import { and, eq, or, type SQL, sql } from "drizzle-orm";
import { scimInvalidFilter } from "../protocol/errors.js";
import { matchesElement } from "../protocol/evaluate.js";
import type { AttrPath, FilterNode, FilterValue } from "../protocol/filter.js";
import { GROUP_SCHEMA, USER_SCHEMA } from "../protocol/resources.js";

const { scimUser, scimGroup } = core;

/*
 * Compiles the evaluable subset of a parsed SCIM filter to SQL. What Entra and Okta send, and a
 * little more: `eq` on the stored attributes, joined by `and` / `or` (parentheses). Everything
 * else parses but is refused here as 400 `invalidFilter` (research §3.1).
 *
 * Users: id, userName (case-insensitive, citext), externalId (case-exact), displayName
 * (case-insensitive), emails / emails.value / emails[type eq "work"].value (citext), active.
 * Groups: id, displayName (case-insensitive), externalId, members[value eq "…"] / members.value.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const NEVER = sql`false`;

function unsupported(path: AttrPath, what = "is not filterable"): never {
  throw scimInvalidFilter(`${path.attr}${path.sub === undefined ? "" : `.${path.sub}`} ${what}`);
}

function stringValue(path: AttrPath, v: FilterValue): string {
  if (typeof v !== "string") unsupported(path, "must be compared with a string");
  return v;
}

function schemaOk(path: AttrPath, urn: string): void {
  if (path.schema !== undefined && path.schema !== urn.toLowerCase()) unsupported(path);
}

function combine(
  node: FilterNode,
  leaf: (n: Extract<FilterNode, { kind: "compare" | "has" }>) => SQL,
): SQL {
  switch (node.kind) {
    case "and":
      return and(combine(node.left, leaf), combine(node.right, leaf)) ?? NEVER;
    case "or":
      return or(combine(node.left, leaf), combine(node.right, leaf)) ?? NEVER;
    case "compare":
    case "has":
      return leaf(node);
    case "not":
      throw scimInvalidFilter("'not' is not supported");
    case "present":
      throw scimInvalidFilter("'pr' is not supported");
  }
}

function eqOnly(node: Extract<FilterNode, { kind: "compare" | "has" }>): FilterValue {
  if (node.kind !== "compare" || node.op !== "eq") {
    throw scimInvalidFilter(`only 'eq' is supported on ${node.path.attr}`);
  }
  return node.value;
}

const WORK_EMAIL = { type: "work", primary: true };

export function compileUserFilter(node: FilterNode): SQL {
  return combine(node, (leaf) => {
    const path = leaf.path;
    schemaOk(path, USER_SCHEMA);
    const value = eqOnly(leaf);
    switch (path.attrKey) {
      case "id": {
        if (path.sub !== undefined || path.filter !== undefined) unsupported(path);
        const id = stringValue(path, value);
        return UUID_RE.test(id) ? eq(scimUser.id, id.toLowerCase()) : NEVER;
      }
      case "username":
        if (path.sub !== undefined || path.filter !== undefined) unsupported(path);
        return eq(scimUser.userName, stringValue(path, value));
      case "externalid":
        if (path.sub !== undefined || path.filter !== undefined) unsupported(path);
        return eq(scimUser.externalId, stringValue(path, value));
      case "displayname":
        if (path.sub !== undefined || path.filter !== undefined) unsupported(path);
        return sql`lower(${scimUser.displayName}) = lower(${stringValue(path, value)})`;
      case "active": {
        if (path.sub !== undefined || path.filter !== undefined) unsupported(path);
        const b =
          typeof value === "boolean"
            ? value
            : typeof value === "string" && ["true", "false"].includes(value.toLowerCase())
              ? value.toLowerCase() === "true"
              : unsupported(path, "must be compared with a boolean");
        return eq(scimUser.active, b);
      }
      case "emails": {
        if (path.sub !== undefined && path.subKey !== "value") unsupported(path);
        // We hold one email, the work/primary one: a value filter that does not address it
        // matches nothing.
        if (path.filter !== undefined && !matchesElement(path.filter, WORK_EMAIL)) return NEVER;
        return eq(scimUser.email, stringValue(path, value));
      }
      default:
        return unsupported(path);
    }
  });
}

function memberExists(userId: string): SQL {
  if (!UUID_RE.test(userId)) return NEVER;
  // Qualified by hand: inside a sub-select drizzle renders columns unqualified.
  return sql`EXISTS (SELECT 1 FROM core.scim_group_member sgm WHERE sgm.group_id = "scim_group"."id" AND sgm.scim_user_id = ${userId.toLowerCase()}::uuid)`;
}

/** `members[value eq "x"]` (possibly `and`-ed with more `value eq`): the ids it names. */
function memberValueFilter(path: AttrPath, f: FilterNode): SQL {
  switch (f.kind) {
    case "and":
      return and(memberValueFilter(path, f.left), memberValueFilter(path, f.right)) ?? NEVER;
    case "or":
      return or(memberValueFilter(path, f.left), memberValueFilter(path, f.right)) ?? NEVER;
    case "compare":
      if (f.op !== "eq" || f.path.attrKey !== "value" || f.path.sub !== undefined) {
        return unsupported(path, 'supports only [value eq "…"]');
      }
      return memberExists(stringValue(f.path, f.value));
    default:
      return unsupported(path, 'supports only [value eq "…"]');
  }
}

export function compileGroupFilter(node: FilterNode): SQL {
  return combine(node, (leaf) => {
    const path = leaf.path;
    schemaOk(path, GROUP_SCHEMA);
    if (path.attrKey === "members") {
      if (leaf.kind === "has" && path.filter !== undefined && path.sub === undefined) {
        return memberValueFilter(path, path.filter);
      }
      const value = eqOnly(leaf);
      if (path.filter !== undefined || (path.sub !== undefined && path.subKey !== "value")) {
        unsupported(path);
      }
      return memberExists(stringValue(path, value));
    }
    const value = eqOnly(leaf);
    if (path.sub !== undefined || path.filter !== undefined) unsupported(path);
    switch (path.attrKey) {
      case "id": {
        const id = stringValue(path, value);
        return UUID_RE.test(id) ? eq(scimGroup.id, id.toLowerCase()) : NEVER;
      }
      case "displayname":
        return sql`lower(${scimGroup.displayName}) = lower(${stringValue(path, value)})`;
      case "externalid":
        return eq(scimGroup.externalId, stringValue(path, value));
      default:
        return unsupported(path);
    }
  });
}
