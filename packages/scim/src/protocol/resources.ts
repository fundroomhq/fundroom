import { scimInvalidSyntax, scimInvalidValue } from "./errors.js";

/*
 * SCIM resource shapes (RFC 7643) as this install stores them. Pure.
 *
 * A User is held as a flat `UserState` (the per-workspace `core.scim_user` projection): one
 * email (the work/primary one), the two name parts, `active`. A Group is `GroupState` with
 * member ids (SCIM user ids of this workspace). Everything else an IdP sends (password,
 * phoneNumbers, the enterprise extension, roles, …) is accepted and ignored — Entra retries 4xx
 * forever, and ignoring unknown attributes is what both Entra and Okta expect.
 */

export const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
export const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const ENTERPRISE_USER_SCHEMA = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const LIST_RESPONSE_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const PATCH_OP_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:PatchOp";

export const LIMITS = {
  userName: 320,
  email: 320,
  externalId: 512,
  name: 256,
  groupDisplayName: 256,
  /** Members one request may name (a POST/PUT/PATCH value list). */
  members: 10_000,
} as const;

export interface UserState {
  readonly userName: string;
  readonly externalId: string | null;
  readonly displayName: string | null;
  readonly givenName: string | null;
  readonly familyName: string | null;
  readonly email: string | null;
  readonly active: boolean;
}

export interface GroupState {
  readonly displayName: string;
  readonly externalId: string | null;
  /** SCIM user ids, de-duplicated, in first-seen order. */
  readonly members: readonly string[];
}

export type JsonRecord = Record<string, unknown>;

export function isRecord(v: unknown): v is JsonRecord {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Case-insensitive own-property read (attribute names are case-insensitive, RFC 7643 §2.1). */
export function getCI(obj: JsonRecord, key: string): unknown {
  if (Object.hasOwn(obj, key)) return obj[key];
  const lower = key.toLowerCase();
  for (const k of Object.keys(obj)) if (k.toLowerCase() === lower) return obj[k];
  return undefined;
}

/**
 * `active` as a boolean. Entra's default (non-`aadOptscim062020`) PATCH sends `"True"` /
 * `"False"` strings; accept any casing.
 */
export function coerceBoolean(v: unknown, attr: string): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const l = v.trim().toLowerCase();
    if (l === "true") return true;
    if (l === "false") return false;
  }
  throw scimInvalidValue(`${attr} must be a boolean`);
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to refuse them.
export const CONTROL_RE = /[\u0000-\u001f\u007f]/u;

/** An optional string attribute: `null`/absent → null; a bounded string otherwise. */
export function optionalString(v: unknown, attr: string, max: number): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw scimInvalidValue(`${attr} must be a string`);
  // NUL (which Postgres refuses) and other control characters: 400, never a 500.
  if (CONTROL_RE.test(v)) throw scimInvalidValue(`${attr} contains control characters`);
  const s = v.trim();
  if (s.length === 0) return null;
  if (s.length > max) throw scimInvalidValue(`${attr} is longer than ${max} characters`);
  return s;
}

export function requiredString(v: unknown, attr: string, max: number): string {
  const s = optionalString(v, attr, max);
  if (s === null) throw scimInvalidValue(`${attr} is required`);
  return s;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function isEmailShaped(s: string): boolean {
  return s.length <= LIMITS.email && EMAIL_RE.test(s);
}

export function emailValue(v: unknown, attr = "emails.value"): string | null {
  const s = optionalString(v, attr, LIMITS.email);
  if (s === null) return null;
  if (!isEmailShaped(s)) throw scimInvalidValue(`${attr} is not an email address`);
  return s;
}

/**
 * The one email we keep from an `emails` array: the `primary` one, else `type: "work"`, else the
 * first. An empty array means none.
 */
export function pickEmail(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const list = Array.isArray(v) ? v : [v];
  const items = list.filter(isRecord);
  if (items.length !== list.length) throw scimInvalidValue("emails must be a list of objects");
  const primary = items.find((e) => {
    const p = getCI(e, "primary");
    return p === true || (typeof p === "string" && p.toLowerCase() === "true");
  });
  const work = items.find((e) => {
    const t = getCI(e, "type");
    return typeof t === "string" && t.toLowerCase() === "work";
  });
  const chosen = primary ?? work ?? items[0];
  return chosen === undefined ? null : emailValue(getCI(chosen, "value"));
}

/** The email the membership is linked on: `userName` when email-shaped, else the work email. */
export function identityEmail(state: Pick<UserState, "userName" | "email">): string | null {
  if (isEmailShaped(state.userName)) return state.userName.toLowerCase();
  return state.email === null ? null : state.email.toLowerCase();
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

/** A POST/PUT `/Users` body → the stored state. */
export function parseUserResource(body: unknown): UserState {
  if (!isRecord(body)) throw scimInvalidSyntax("the body must be a JSON object");
  const name = getCI(body, "name");
  if (name !== undefined && name !== null && !isRecord(name)) {
    throw scimInvalidValue("name must be an object");
  }
  const active = getCI(body, "active");
  return {
    userName: requiredString(getCI(body, "userName"), "userName", LIMITS.userName),
    externalId: optionalString(getCI(body, "externalId"), "externalId", LIMITS.externalId),
    displayName: optionalString(getCI(body, "displayName"), "displayName", LIMITS.name),
    givenName: isRecord(name)
      ? optionalString(getCI(name, "givenName"), "name.givenName", LIMITS.name)
      : null,
    familyName: isRecord(name)
      ? optionalString(getCI(name, "familyName"), "name.familyName", LIMITS.name)
      : null,
    email: pickEmail(getCI(body, "emails")),
    active: active === undefined || active === null ? true : coerceBoolean(active, "active"),
  };
}

/** `{ value: "<id>" }` (or a bare id string, which some clients send). */
export function memberId(v: unknown): string {
  if (typeof v === "string" && v.length > 0 && !CONTROL_RE.test(v)) return v;
  if (isRecord(v)) {
    const id = getCI(v, "value");
    if (typeof id === "string" && id.length > 0 && !CONTROL_RE.test(id)) return id;
  }
  throw scimInvalidValue("a member must be an object with a string value");
}

export function memberIds(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const list = Array.isArray(v) ? v : [v];
  if (list.length > LIMITS.members) throw scimInvalidValue("too many members in one request");
  return dedupe(list.map(memberId));
}

export function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.toLowerCase()))];
}

/** A POST/PUT `/Groups` body → the stored state. */
export function parseGroupResource(body: unknown): GroupState {
  if (!isRecord(body)) throw scimInvalidSyntax("the body must be a JSON object");
  return {
    displayName: requiredString(getCI(body, "displayName"), "displayName", LIMITS.groupDisplayName),
    externalId: optionalString(getCI(body, "externalId"), "externalId", LIMITS.externalId),
    members: memberIds(getCI(body, "members")),
  };
}
