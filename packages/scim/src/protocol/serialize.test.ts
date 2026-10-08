import { describe, expect, it } from "vitest";
import { resourceTypes, schemaById, schemas, serviceProviderConfig } from "./discovery.js";
import { isScimError, SCIM_ERROR_SCHEMA, ScimError, scimErrorBody } from "./errors.js";
import {
  identityEmail,
  PATCH_OP_SCHEMA,
  parseGroupResource,
  parseUserResource,
  USER_SCHEMA,
} from "./resources.js";
import {
  groupResource,
  listResponse,
  parsePage,
  project,
  userResource,
  wantsMembers,
} from "./serialize.js";

const BASE = "https://seed.test/base/scim/v2";
const at = new Date("2026-09-27T10:00:00.000Z");
const later = new Date("2026-09-27T11:00:00.000Z");

const u = {
  id: "0192-u",
  createdAt: at,
  updatedAt: later,
  userName: "jane@acme.test",
  externalId: "e1",
  displayName: "Jane",
  givenName: "Jane",
  familyName: "Doe",
  email: "jane@acme.test",
  active: false,
};

describe("errors", () => {
  it("renders RFC 7644 §3.12 bodies with a string status", () => {
    expect(new ScimError(409, "taken", "uniqueness").toBody()).toEqual({
      schemas: [SCIM_ERROR_SCHEMA],
      status: "409",
      scimType: "uniqueness",
      detail: "taken",
    });
    expect(scimErrorBody(401)).toEqual({ schemas: [SCIM_ERROR_SCHEMA], status: "401" });
    expect(isScimError(new ScimError(404, "x"))).toBe(true);
    expect(isScimError(new Error("x"))).toBe(false);
  });
});

describe("serialisers", () => {
  it("renders a user with meta and omits unassigned attributes", () => {
    expect(userResource(BASE, u)).toEqual({
      schemas: [USER_SCHEMA],
      id: "0192-u",
      externalId: "e1",
      userName: "jane@acme.test",
      name: { givenName: "Jane", familyName: "Doe", formatted: "Jane Doe" },
      displayName: "Jane",
      emails: [{ value: "jane@acme.test", type: "work", primary: true }],
      active: false,
      meta: {
        resourceType: "User",
        created: at.toISOString(),
        lastModified: later.toISOString(),
        location: `${BASE}/Users/0192-u`,
        version: `W/"${later.getTime().toString(36)}"`,
      },
    });
    const bare = userResource(BASE, {
      ...u,
      externalId: null,
      displayName: null,
      givenName: null,
      familyName: null,
      email: null,
    });
    expect(Object.keys(bare).sort()).toEqual(["active", "id", "meta", "schemas", "userName"]);
  });

  it("renders a group with members or without", () => {
    const g = { id: "g1", createdAt: at, updatedAt: at, displayName: "Eng", externalId: null };
    expect(
      groupResource(BASE, g, [
        { id: "u1", display: "Jane" },
        { id: "u2", display: null },
      ]),
    ).toMatchObject({
      displayName: "Eng",
      members: [
        { value: "u1", display: "Jane", $ref: `${BASE}/Users/u1` },
        { value: "u2", $ref: `${BASE}/Users/u2` },
      ],
      meta: { resourceType: "Group", location: `${BASE}/Groups/g1` },
    });
    expect(groupResource(BASE, g, undefined)).not.toHaveProperty("members");
  });

  it("lists with integer counts", () => {
    expect(listResponse([{ a: 1 }], 7, 3)).toEqual({
      schemas: ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
      totalResults: 7,
      startIndex: 3,
      itemsPerPage: 1,
      Resources: [{ a: 1 }],
    });
    expect(listResponse([], 0, 1)).toMatchObject({ totalResults: 0, Resources: [] });
  });
});

describe("pagination", () => {
  it("clamps startIndex and count", () => {
    expect(parsePage(undefined, undefined)).toEqual({ startIndex: 1, count: 100 });
    expect(parsePage("0", "-5")).toEqual({ startIndex: 1, count: 0 });
    expect(parsePage("3", "1000")).toEqual({ startIndex: 3, count: 200 });
    expect(() => parsePage("x", undefined)).toThrow(ScimError);
  });
});

describe("projection", () => {
  const r = userResource(BASE, u);
  it("attributes keeps id/schemas plus the named ones (case-insensitive, sub-attributes)", () => {
    expect(project(r, { attributes: ["USERNAME", "name.givenName"] })).toEqual({
      schemas: [USER_SCHEMA],
      id: "0192-u",
      userName: "jane@acme.test",
      name: { givenName: "Jane" },
    });
    expect(
      project(r, { attributes: ["urn:ietf:params:scim:schemas:core:2.0:User:userName"] }),
    ).toHaveProperty("userName");
  });

  it("excludedAttributes drops the named ones but never id", () => {
    const out = project(r, { excludedAttributes: ["emails", "id", "name.formatted"] });
    expect(out).not.toHaveProperty("emails");
    expect(out).toHaveProperty("id");
    expect(out["name"]).toEqual({ givenName: "Jane", familyName: "Doe" });
  });

  it("wantsMembers", () => {
    expect(wantsMembers({})).toBe(true);
    expect(wantsMembers({ excludedAttributes: ["members"] })).toBe(false);
    expect(wantsMembers({ attributes: ["displayName"] })).toBe(false);
    expect(wantsMembers({ attributes: ["members.value"] })).toBe(true);
  });
});

describe("resource parsing", () => {
  it("parses an Entra-style POST /Users", () => {
    expect(
      parseUserResource({
        schemas: [USER_SCHEMA, "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"],
        externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
        userName: "Test_User_ab6490ee@acme.test",
        active: true,
        displayName: "BJensen",
        emails: [{ primary: true, type: "work", value: "Test_User_fd0ea19b@acme.test" }],
        name: { formatted: "Ryan Leenay", familyName: "Leenay", givenName: "Ryan" },
        password: "ignored",
        roles: [],
      }),
    ).toEqual({
      userName: "Test_User_ab6490ee@acme.test",
      externalId: "0a21f0f2-8d2a-4f8e-bf98-7363c4aed4ef",
      displayName: "BJensen",
      givenName: "Ryan",
      familyName: "Leenay",
      email: "Test_User_fd0ea19b@acme.test",
      active: true,
    });
  });

  it("defaults active, coerces string booleans and requires userName", () => {
    expect(parseUserResource({ userName: "a@b.test" }).active).toBe(true);
    expect(parseUserResource({ userName: "a@b.test", active: "False" }).active).toBe(false);
    expect(() => parseUserResource({})).toThrow(/userName is required/u);
    expect(() => parseUserResource("x")).toThrow(ScimError);
    expect(() => parseUserResource({ userName: "a", name: "x" })).toThrow(ScimError);
  });

  it("identityEmail prefers an email-shaped userName", () => {
    expect(identityEmail({ userName: "Jane@Acme.test", email: "o@x.test" })).toBe("jane@acme.test");
    expect(identityEmail({ userName: "jdoe", email: "J@acme.test" })).toBe("j@acme.test");
    expect(identityEmail({ userName: "jdoe", email: null })).toBeNull();
  });

  it("parses a group", () => {
    expect(
      parseGroupResource({ displayName: "Eng", members: [{ value: "A" }, { value: "a" }] }),
    ).toEqual({ displayName: "Eng", externalId: null, members: ["a"] });
    expect(() => parseGroupResource({ members: [] })).toThrow(ScimError);
  });
});

describe("discovery", () => {
  it("advertises patch + filter, no bulk/sort/etag/changePassword", () => {
    expect(serviceProviderConfig(BASE)).toMatchObject({
      patch: { supported: true },
      bulk: { supported: false },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: "oauthbearertoken" }],
    });
  });

  it("lists resource types and schemas", () => {
    expect(resourceTypes(BASE).map((r) => r["endpoint"])).toEqual(["/Users", "/Groups"]);
    expect(schemas(BASE).map((s) => s["name"])).toEqual(["User", "Group", "EnterpriseUser"]);
    expect(schemaById(BASE, USER_SCHEMA.toLowerCase())).toBeDefined();
    expect(schemaById(BASE, PATCH_OP_SCHEMA)).toBeUndefined();
  });
});
