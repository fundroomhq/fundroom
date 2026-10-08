import {
  ENTERPRISE_USER_SCHEMA,
  GROUP_SCHEMA,
  type JsonRecord,
  LIMITS,
  USER_SCHEMA,
} from "./resources.js";
import { listResponse, MAX_PAGE_SIZE } from "./serialize.js";

/*
 * Discovery documents (RFC 7643 §5–§7, RFC 7644 §4). Static apart from `meta.location`. Entra
 * reads `/Schemas` when an admin saves the provisioning config and wants a ListResponse there.
 */

export const SPC_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";
export const RESOURCE_TYPE_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ResourceType";
export const SCHEMA_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Schema";

export function serviceProviderConfig(base: string): JsonRecord {
  return {
    schemas: [SPC_SCHEMA],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_PAGE_SIZE },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: "oauthbearertoken",
        name: "OAuth Bearer Token",
        description: "A per-workspace SCIM token (frs_…) sent as Authorization: Bearer",
        primary: true,
      },
    ],
    meta: {
      resourceType: "ServiceProviderConfig",
      location: `${base}/ServiceProviderConfig`,
    },
  };
}

function resourceType(base: string, name: "User" | "Group"): JsonRecord {
  return {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: name,
    name,
    endpoint: `/${name}s`,
    description: name === "User" ? "Workspace staff member" : "Group mapped to a staff role",
    schema: name === "User" ? USER_SCHEMA : GROUP_SCHEMA,
    ...(name === "User"
      ? { schemaExtensions: [{ schema: ENTERPRISE_USER_SCHEMA, required: false }] }
      : {}),
    meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/${name}` },
  };
}

export function resourceTypes(base: string): JsonRecord[] {
  return [resourceType(base, "User"), resourceType(base, "Group")];
}

export function resourceTypeById(base: string, id: string): JsonRecord | undefined {
  return resourceTypes(base).find((r) => String(r["id"]).toLowerCase() === id.toLowerCase());
}

interface AttrOpts {
  readonly type?: "string" | "boolean" | "complex" | "reference";
  readonly multi?: boolean;
  readonly required?: boolean;
  readonly caseExact?: boolean;
  readonly mutability?: "readOnly" | "readWrite" | "immutable" | "writeOnly";
  readonly returned?: "always" | "never" | "default" | "request";
  readonly uniqueness?: "none" | "server" | "global";
  readonly sub?: readonly JsonRecord[];
  readonly referenceTypes?: readonly string[];
  readonly description?: string;
}

function attr(name: string, o: AttrOpts = {}): JsonRecord {
  return {
    name,
    type: o.type ?? "string",
    multiValued: o.multi ?? false,
    description: o.description ?? name,
    required: o.required ?? false,
    caseExact: o.caseExact ?? false,
    mutability: o.mutability ?? "readWrite",
    returned: o.returned ?? "default",
    uniqueness: o.uniqueness ?? "none",
    ...(o.sub === undefined ? {} : { subAttributes: o.sub }),
    ...(o.referenceTypes === undefined ? {} : { referenceTypes: o.referenceTypes }),
  };
}

function userSchema(base: string): JsonRecord {
  return {
    schemas: [SCHEMA_SCHEMA],
    id: USER_SCHEMA,
    name: "User",
    description: "User account",
    attributes: [
      attr("userName", {
        required: true,
        uniqueness: "server",
        description: `Unique per workspace; an email in a verified domain (≤ ${LIMITS.userName})`,
      }),
      attr("name", {
        type: "complex",
        sub: [attr("givenName"), attr("familyName"), attr("formatted", { mutability: "readOnly" })],
      }),
      attr("displayName"),
      attr("emails", {
        type: "complex",
        multi: true,
        sub: [attr("value"), attr("type"), attr("primary", { type: "boolean" })],
      }),
      attr("active", { type: "boolean" }),
      attr("externalId", { caseExact: true }),
    ],
    meta: { resourceType: "Schema", location: `${base}/Schemas/${USER_SCHEMA}` },
  };
}

function groupSchema(base: string): JsonRecord {
  return {
    schemas: [SCHEMA_SCHEMA],
    id: GROUP_SCHEMA,
    name: "Group",
    description: "Group (mapped to a staff role by a workspace admin)",
    attributes: [
      attr("displayName", { required: true, uniqueness: "server" }),
      attr("members", {
        type: "complex",
        multi: true,
        sub: [
          attr("value", { mutability: "immutable" }),
          attr("display", { mutability: "readOnly" }),
          attr("$ref", { type: "reference", mutability: "immutable", referenceTypes: ["User"] }),
        ],
      }),
      attr("externalId", { caseExact: true }),
    ],
    meta: { resourceType: "Schema", location: `${base}/Schemas/${GROUP_SCHEMA}` },
  };
}

function enterpriseSchema(base: string): JsonRecord {
  return {
    schemas: [SCHEMA_SCHEMA],
    id: ENTERPRISE_USER_SCHEMA,
    name: "EnterpriseUser",
    description: "Accepted and ignored",
    attributes: [attr("employeeNumber"), attr("department")],
    meta: { resourceType: "Schema", location: `${base}/Schemas/${ENTERPRISE_USER_SCHEMA}` },
  };
}

export function schemas(base: string): JsonRecord[] {
  return [userSchema(base), groupSchema(base), enterpriseSchema(base)];
}

export function schemaById(base: string, id: string): JsonRecord | undefined {
  return schemas(base).find((s) => String(s["id"]).toLowerCase() === id.toLowerCase());
}

export function discoveryList(resources: JsonRecord[]): JsonRecord {
  return listResponse(resources, resources.length, 1);
}
