import { ScimError, scimInvalidSyntax, scimInvalidValue, scimMutability } from "./errors.js";
import { matchesElement } from "./evaluate.js";
import { type AttrPath, parseAttrName, parsePath } from "./filter.js";
import {
  coerceBoolean,
  dedupe,
  ENTERPRISE_USER_SCHEMA,
  emailValue,
  GROUP_SCHEMA,
  type GroupState,
  getCI,
  isRecord,
  LIMITS,
  memberIds,
  optionalString,
  pickEmail,
  requiredString,
  USER_SCHEMA,
  type UserState,
} from "./resources.js";

/*
 * The SCIM PATCH engine (RFC 7644 §3.5.2). Pure: `applyUserPatch` / `applyGroupPatch` fold the
 * operations over the current state and return the new one (or throw `ScimError`); the service
 * persists the difference in one transaction, so a failing operation rolls back all of them.
 *
 * Quirks accepted on purpose (research §3.3):
 *  - `op` in any case (`"Replace"`, `"Add"`, `"Remove"` — Entra's default);
 *  - `active` as `"True"` / `"False"` strings (Entra without `aadOptscim062020`);
 *  - path-less `add`/`replace` whose value object has dotted (`"name.givenName"`) or
 *    URN-prefixed (`"urn:…:User:displayName"`, `"urn:…:enterprise:2.0:User:employeeNumber"`) keys,
 *    or nested schema containers; `id` inside it (Okta's group rename) is ignored;
 *  - Okta's `{"op":"replace","value":{"active":false}}`;
 *  - value-filter paths `emails[type eq "work"].value` (creating the work email if missing);
 *  - members: `add` a list; Entra's legacy `remove` with a value list; compliant
 *    `remove` `members[value eq "…"]`; Okta's `replace` with the full list;
 *  - unknown attributes are ignored rather than refused (Entra retries every 4xx).
 */

export type PatchOpName = "add" | "replace" | "remove";

export interface PatchOperation {
  readonly op: PatchOpName;
  readonly path?: string | undefined;
  readonly value?: unknown;
}

const MAX_OPERATIONS = 1000;

/** Validates a PatchOp request body and normalises each op name. */
export function parsePatchRequest(body: unknown): PatchOperation[] {
  if (!isRecord(body)) throw scimInvalidSyntax("the body must be a JSON object");
  const ops = getCI(body, "Operations");
  if (!Array.isArray(ops)) throw scimInvalidSyntax("Operations must be an array");
  if (ops.length > MAX_OPERATIONS) throw scimInvalidSyntax("too many operations");
  return ops.map((raw, i) => {
    if (!isRecord(raw)) throw scimInvalidSyntax(`operation ${i} must be an object`);
    const opRaw = getCI(raw, "op");
    const op = typeof opRaw === "string" ? opRaw.trim().toLowerCase() : "";
    if (op !== "add" && op !== "replace" && op !== "remove") {
      throw scimInvalidSyntax(`operation ${i} has an unknown op '${String(opRaw)}'`);
    }
    const path = getCI(raw, "path");
    if (path !== undefined && path !== null && typeof path !== "string") {
      throw scimInvalidSyntax(`operation ${i} path must be a string`);
    }
    const value = getCI(raw, "value");
    const hasPath = typeof path === "string" && path.trim().length > 0;
    if (op === "remove" && !hasPath) {
      throw new ScimError(400, "a remove operation needs a path", "noTarget");
    }
    if (op !== "remove" && value === undefined) {
      throw scimInvalidValue(`operation ${i} needs a value`);
    }
    return {
      op,
      ...(hasPath ? { path: path as string } : {}),
      ...(value === undefined ? {} : { value }),
    };
  });
}

// --- schema handling -----------------------------------------------------------------------------

type Target = "core" | "ignore";

function targetOf(path: AttrPath, core: string): Target {
  if (path.schema === undefined || path.schema === core.toLowerCase()) return "core";
  return "ignore"; // the enterprise extension or anything else: accepted, not stored
}

/**
 * Expands a path-less value object into (path, value) pairs: dotted keys, URN-prefixed keys,
 * and whole schema containers (`{"urn:…:enterprise:2.0:User": {...}}`).
 */
function expandValueObject(
  value: unknown,
  core: string,
  nested = false,
): Array<[AttrPath, unknown]> {
  if (!isRecord(value)) throw scimInvalidValue("a path-less operation needs an object value");
  const out: Array<[AttrPath, unknown]> = [];
  for (const [key, v] of Object.entries(value)) {
    const lower = key.toLowerCase();
    if (lower === core.toLowerCase()) {
      // A schema container is legal once; a container inside a container is refused (and the
      // recursion is bounded: no stack overflow on a hostile body).
      if (nested) throw scimInvalidValue("a schema container cannot be nested");
      if (isRecord(v)) out.push(...expandValueObject(v, core, true));
      continue;
    }
    // The enterprise container and any other extension: parsed as `<urn>:User` below, whose
    // schema is not the core one, so `targetOf` ignores it.
    if (lower === ENTERPRISE_USER_SCHEMA.toLowerCase()) continue;
    let path: AttrPath;
    try {
      path = parseAttrName(key);
    } catch {
      continue; // an attribute name we cannot even parse: ignored like any unknown one
    }
    out.push([path, v]);
  }
  return out;
}

// --- users -----------------------------------------------------------------------------------------

type MutableUser = { -readonly [K in keyof UserState]: UserState[K] };

function workElement(u: MutableUser): Record<string, unknown> | undefined {
  return u.email === null ? undefined : { value: u.email, type: "work", primary: true };
}

function setUserAttr(u: MutableUser, op: PatchOpName, path: AttrPath, value: unknown): void {
  if (targetOf(path, USER_SCHEMA) === "ignore") return;
  const remove = op === "remove";
  switch (path.attrKey) {
    case "username":
      if (remove) throw scimMutability("userName is required");
      u.userName = requiredString(value, "userName", LIMITS.userName);
      return;
    case "externalid":
      u.externalId = remove ? null : optionalString(value, "externalId", LIMITS.externalId);
      return;
    case "displayname":
      u.displayName = remove ? null : optionalString(value, "displayName", LIMITS.name);
      return;
    case "active":
      if (remove) return;
      u.active = coerceBoolean(value, "active");
      return;
    case "name":
      setName(u, remove, path.subKey, value);
      return;
    case "emails":
      setEmails(u, op, path, value);
      return;
    default:
      return; // id, meta, schemas, password, phoneNumbers, …: ignored
  }
}

function setName(u: MutableUser, remove: boolean, sub: string | undefined, value: unknown): void {
  if (sub === undefined) {
    if (remove || value === null) {
      u.givenName = null;
      u.familyName = null;
      return;
    }
    if (!isRecord(value)) throw scimInvalidValue("name must be an object");
    const given = getCI(value, "givenName");
    const family = getCI(value, "familyName");
    if (given !== undefined) u.givenName = optionalString(given, "name.givenName", LIMITS.name);
    if (family !== undefined) u.familyName = optionalString(family, "name.familyName", LIMITS.name);
    return;
  }
  if (sub === "givenname") {
    u.givenName = remove ? null : optionalString(value, "name.givenName", LIMITS.name);
  } else if (sub === "familyname") {
    u.familyName = remove ? null : optionalString(value, "name.familyName", LIMITS.name);
  }
  // name.formatted and friends are derived / not stored.
}

function setEmails(u: MutableUser, op: PatchOpName, path: AttrPath, value: unknown): void {
  if (path.filter !== undefined) {
    const current = workElement(u);
    // The element the filter addresses: ours when it matches; none otherwise. A missing work
    // email is created by an add/replace aimed at `[type eq "work"]` (or `[primary eq true]`).
    const probe = current ?? { type: "work", primary: true };
    const addresses = matchesElement(path.filter, probe);
    if (!addresses) return;
    if (op === "remove") {
      if (current !== undefined && (path.subKey === undefined || path.subKey === "value")) {
        u.email = null;
      }
      return;
    }
    if (path.subKey === undefined) {
      if (!isRecord(value)) throw scimInvalidValue("an email must be an object");
      u.email = emailValue(getCI(value, "value"));
    } else if (path.subKey === "value") {
      u.email = emailValue(value);
    }
    return;
  }
  if (path.subKey !== undefined) {
    if (path.subKey !== "value") return;
    u.email = op === "remove" ? null : emailValue(value);
    return;
  }
  if (op === "remove") {
    if (value === undefined || value === null) {
      u.email = null;
      return;
    }
    // Remove with a value list: only the listed addresses.
    const list = Array.isArray(value) ? value : [value];
    const named = list
      .map((e) => (isRecord(e) ? getCI(e, "value") : e))
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.toLowerCase());
    if (u.email !== null && named.includes(u.email.toLowerCase())) u.email = null;
    return;
  }
  u.email = pickEmail(value);
}

export function applyUserPatch(state: UserState, ops: readonly PatchOperation[]): UserState {
  const u: MutableUser = { ...state };
  for (const op of ops) {
    if (op.path === undefined) {
      for (const [path, v] of expandValueObject(op.value, USER_SCHEMA)) {
        setUserAttr(u, op.op, path, v);
      }
      continue;
    }
    setUserAttr(u, op.op, parsePath(op.path), op.value);
  }
  return u;
}

// --- groups --------------------------------------------------------------------------------------

type MutableGroup = { displayName: string; externalId: string | null; members: string[] };

function setGroupAttr(g: MutableGroup, op: PatchOpName, path: AttrPath, value: unknown): void {
  if (targetOf(path, GROUP_SCHEMA) === "ignore") return;
  switch (path.attrKey) {
    case "displayname":
      if (op === "remove") throw scimMutability("displayName is required");
      g.displayName = requiredString(value, "displayName", LIMITS.groupDisplayName);
      return;
    case "externalid":
      g.externalId =
        op === "remove" ? null : optionalString(value, "externalId", LIMITS.externalId);
      return;
    case "members":
      setMembers(g, op, path, value);
      return;
    default:
      return; // id (Okta's rename sends it), meta, schemas, …: ignored
  }
}

function setMembers(g: MutableGroup, op: PatchOpName, path: AttrPath, value: unknown): void {
  if (path.subKey !== undefined && path.subKey !== "value") return;
  if (path.filter !== undefined) {
    const filter = path.filter;
    const matched = new Set(g.members.filter((id) => matchesElement(filter, { value: id })));
    if (op === "remove") {
      g.members = g.members.filter((id) => !matched.has(id));
      return;
    }
    if (op === "replace") g.members = g.members.filter((id) => !matched.has(id));
    const added =
      path.subKey === "value"
        ? dedupe([requiredString(value, "members.value", 512)])
        : memberIds(value);
    g.members = dedupe([...g.members, ...added]);
    return;
  }
  if (op === "remove") {
    if (value === undefined || value === null) {
      g.members = [];
      return;
    }
    const drop = new Set(memberIds(value));
    g.members = g.members.filter((id) => !drop.has(id));
    return;
  }
  const ids = memberIds(value);
  g.members = op === "replace" ? ids : dedupe([...g.members, ...ids]);
}

export function applyGroupPatch(state: GroupState, ops: readonly PatchOperation[]): GroupState {
  const g: MutableGroup = { ...state, members: [...state.members] };
  for (const op of ops) {
    if (op.path === undefined) {
      for (const [path, v] of expandValueObject(op.value, GROUP_SCHEMA)) {
        setGroupAttr(g, op.op, path, v);
      }
      continue;
    }
    setGroupAttr(g, op.op, parsePath(op.path), op.value);
  }
  if (g.members.length > LIMITS.members) throw scimInvalidValue("too many members");
  return g;
}
