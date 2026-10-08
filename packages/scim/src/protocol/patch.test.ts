import { describe, expect, it } from "vitest";
import { ScimError } from "./errors.js";
import { applyGroupPatch, applyUserPatch, parsePatchRequest } from "./patch.js";
import {
  type GroupState,
  PATCH_OP_SCHEMA,
  USER_SCHEMA as USER,
  type UserState,
} from "./resources.js";

const base: UserState = {
  userName: "jane@acme.test",
  externalId: "ext-1",
  displayName: "Jane Doe",
  givenName: "Jane",
  familyName: "Doe",
  email: "jane@acme.test",
  active: true,
};

function patch(...Operations: unknown[]): unknown {
  return { schemas: [PATCH_OP_SCHEMA], Operations };
}

function user(...ops: unknown[]): UserState {
  return applyUserPatch(base, parsePatchRequest(patch(...ops)));
}

function group(state: GroupState, ...ops: unknown[]): GroupState {
  return applyGroupPatch(state, parsePatchRequest(patch(...ops)));
}

function failure(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ScimError) return `${e.status}:${e.scimType ?? ""}`;
    throw e;
  }
  return "no error";
}

describe("parsePatchRequest", () => {
  it("normalises op case (Entra's Replace/Add/Remove)", () => {
    const ops = parsePatchRequest(
      patch(
        { op: "Replace", path: "active", value: "False" },
        { op: "ADD", path: "displayName", value: "x" },
        { op: "Remove", path: "externalId" },
      ),
    );
    expect(ops.map((o) => o.op)).toEqual(["replace", "add", "remove"]);
  });

  it("accepts case-insensitive Operations/op/path/value keys", () => {
    expect(
      parsePatchRequest({ operations: [{ OP: "replace", Path: "active", Value: false }] }),
    ).toEqual([{ op: "replace", path: "active", value: false }]);
  });

  it("refuses bad bodies", () => {
    expect(failure(() => parsePatchRequest([]))).toBe("400:invalidSyntax");
    expect(failure(() => parsePatchRequest({}))).toBe("400:invalidSyntax");
    expect(failure(() => parsePatchRequest(patch({ op: "move", path: "a" })))).toBe(
      "400:invalidSyntax",
    );
    expect(failure(() => parsePatchRequest(patch("x")))).toBe("400:invalidSyntax");
    expect(failure(() => parsePatchRequest(patch({ op: "remove" })))).toBe("400:noTarget");
    expect(failure(() => parsePatchRequest(patch({ op: "replace", path: "active" })))).toBe(
      "400:invalidValue",
    );
    expect(failure(() => parsePatchRequest(patch({ op: "replace", path: 3, value: 1 })))).toBe(
      "400:invalidSyntax",
    );
  });
});

describe("applyUserPatch", () => {
  it('Entra default: Replace active "False" / "True" strings', () => {
    expect(user({ op: "Replace", path: "active", value: "False" }).active).toBe(false);
    expect(
      applyUserPatch(
        { ...base, active: false },
        parsePatchRequest(patch({ op: "Replace", path: "active", value: "True" })),
      ).active,
    ).toBe(true);
    expect(failure(() => user({ op: "replace", path: "active", value: "nope" }))).toBe(
      "400:invalidValue",
    );
  });

  it("Okta: path-less replace { active: false }", () => {
    expect(user({ op: "replace", value: { active: false } }).active).toBe(false);
  });

  it("Entra path-less multi-attribute with dotted and URN keys", () => {
    const next = user({
      op: "Replace",
      value: {
        displayName: "Janet Doe",
        "name.givenName": "Janet",
        "name.familyName": "Doe-Smith",
        "urn:ietf:params:scim:schemas:core:2.0:User:externalId": "ext-2",
        "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:employeeNumber": "42",
        active: "False",
      },
    });
    expect(next).toMatchObject({
      displayName: "Janet Doe",
      givenName: "Janet",
      familyName: "Doe-Smith",
      externalId: "ext-2",
      active: false,
    });
  });

  it("nested schema containers and nested complex values", () => {
    const next = user({
      op: "add",
      value: {
        "urn:ietf:params:scim:schemas:core:2.0:User": { name: { givenName: "J" } },
        "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": { department: "x" },
        name: { familyName: "D" },
      },
    });
    expect(next).toMatchObject({ givenName: "J", familyName: "D" });
  });

  it("replaces userName (the joining property) and name sub-attributes by path", () => {
    expect(user({ op: "replace", path: "userName", value: "janet@acme.test" }).userName).toBe(
      "janet@acme.test",
    );
    expect(user({ op: "replace", path: "name.familyName", value: "Roe" }).familyName).toBe("Roe");
    expect(user({ op: "remove", path: "name.givenName" }).givenName).toBeNull();
    expect(user({ op: "remove", path: "name" })).toMatchObject({
      givenName: null,
      familyName: null,
    });
    expect(failure(() => user({ op: "remove", path: "userName" }))).toBe("400:mutability");
    expect(failure(() => user({ op: "replace", path: "userName", value: "" }))).toBe(
      "400:invalidValue",
    );
  });

  it('emails[type eq "work"].value: replaces, and creates the work email when missing', () => {
    expect(
      user({ op: "Replace", path: 'emails[type eq "work"].value', value: "new@acme.test" }).email,
    ).toBe("new@acme.test");
    const noEmail = applyUserPatch(
      { ...base, email: null },
      parsePatchRequest(
        patch({ op: "Add", path: 'emails[type eq "work"].value', value: "w@acme.test" }),
      ),
    );
    expect(noEmail.email).toBe("w@acme.test");
    // A home email is not stored: ignored.
    expect(
      user({ op: "replace", path: 'emails[type eq "home"].value', value: "h@x.test" }).email,
    ).toBe("jane@acme.test");
    expect(user({ op: "remove", path: 'emails[type eq "work"]' }).email).toBeNull();
    expect(
      user({ op: "replace", path: 'emails[type eq "work"]', value: { value: "o@acme.test" } })
        .email,
    ).toBe("o@acme.test");
    expect(
      failure(() =>
        user({ op: "replace", path: 'emails[type eq "work"].value', value: "not-an-email" }),
      ),
    ).toBe("400:invalidValue");
  });

  it("emails as a list, emails.value, and remove with a value array", () => {
    expect(
      user({
        op: "replace",
        path: "emails",
        value: [
          { value: "home@x.test", type: "home" },
          { value: "p@acme.test", type: "work", primary: true },
        ],
      }).email,
    ).toBe("p@acme.test");
    expect(user({ op: "replace", path: "emails.value", value: "v@acme.test" }).email).toBe(
      "v@acme.test",
    );
    expect(
      user({ op: "remove", path: "emails", value: [{ value: "other@acme.test" }] }).email,
    ).toBe("jane@acme.test");
    expect(
      user({ op: "remove", path: "emails", value: [{ value: "JANE@acme.test" }] }).email,
    ).toBeNull();
    expect(user({ op: "remove", path: "emails" }).email).toBeNull();
  });

  it("ignores unknown and read-only attributes", () => {
    expect(
      user(
        { op: "Add", path: "nickName", value: "JD" },
        { op: "replace", path: "password", value: "hunter2" },
        { op: "replace", value: { id: "other", meta: {}, phoneNumbers: [] } },
        {
          op: "replace",
          path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
          value: "x",
        },
      ),
    ).toEqual(base);
  });

  it("applies operations in order", () => {
    expect(
      user(
        { op: "replace", path: "displayName", value: "A" },
        { op: "replace", path: "displayName", value: "B" },
        { op: "remove", path: "externalId" },
      ),
    ).toMatchObject({ displayName: "B", externalId: null });
  });

  it("refuses path-less ops without an object value and over-long values", () => {
    expect(failure(() => user({ op: "replace", value: "x" }))).toBe("400:invalidValue");
    expect(
      failure(() => user({ op: "replace", path: "displayName", value: "x".repeat(300) })),
    ).toBe("400:invalidValue");
    expect(failure(() => user({ op: "replace", path: "displayName", value: 5 }))).toBe(
      "400:invalidValue",
    );
  });
});

describe("applyGroupPatch", () => {
  const g: GroupState = { displayName: "Eng", externalId: null, members: ["u1", "u2"] };

  it("adds members (de-duplicated)", () => {
    expect(
      group(g, { op: "Add", path: "members", value: [{ value: "u2" }, { value: "U3" }] }).members,
    ).toEqual(["u1", "u2", "u3"]);
  });

  it("Entra legacy: Remove members with a value array", () => {
    expect(group(g, { op: "Remove", path: "members", value: [{ value: "u1" }] }).members).toEqual([
      "u2",
    ]);
  });

  it('compliant: remove members[value eq "…"]', () => {
    expect(group(g, { op: "remove", path: 'members[value eq "u2"]' }).members).toEqual(["u1"]);
  });

  it("remove members without a value empties the group", () => {
    expect(group(g, { op: "remove", path: "members" }).members).toEqual([]);
  });

  it("Okta: replace members with the full set", () => {
    expect(
      group(g, { op: "replace", path: "members", value: [{ value: "u3" }, { value: "u1" }] })
        .members,
    ).toEqual(["u3", "u1"]);
  });

  it("Okta rename: path-less replace with id + displayName", () => {
    expect(
      group(g, { op: "replace", value: { id: "whatever", displayName: "Engineering" } }),
    ).toEqual({ ...g, displayName: "Engineering" });
  });

  it("path-less add of members and displayName by path", () => {
    expect(group(g, { op: "add", value: { members: [{ value: "u9" }] } }).members).toEqual([
      "u1",
      "u2",
      "u9",
    ]);
    expect(group(g, { op: "Replace", path: "displayName", value: "X" }).displayName).toBe("X");
    expect(group(g, { op: "replace", path: "externalId", value: "e" }).externalId).toBe("e");
  });

  it("refuses removing displayName and malformed members", () => {
    expect(failure(() => group(g, { op: "remove", path: "displayName" }))).toBe("400:mutability");
    expect(failure(() => group(g, { op: "add", path: "members", value: [{ nope: 1 }] }))).toBe(
      "400:invalidValue",
    );
  });
});

describe("hostile input (R2-L1)", () => {
  it("refuses NUL and other control characters as 400 invalidValue", () => {
    expect(failure(() => user({ op: "replace", path: "displayName", value: "a\u0000b" }))).toBe(
      "400:invalidValue",
    );
    expect(failure(() => user({ op: "replace", path: "userName", value: "a\u0007@b.test" }))).toBe(
      "400:invalidValue",
    );
    expect(failure(() => user({ op: "replace", value: { "name.givenName": "x\u001f" } }))).toBe(
      "400:invalidValue",
    );
    expect(
      failure(() =>
        applyGroupPatch(
          { displayName: "g", externalId: null, members: [] },
          parsePatchRequest(patch({ op: "add", path: "members", value: [{ value: "a\u0000" }] })),
        ),
      ),
    ).toBe("400:invalidValue");
  });

  it("refuses nested schema containers (bounded recursion, no stack overflow)", () => {
    let value: Record<string, unknown> = { displayName: "x" };
    for (let i = 0; i < 100_000; i++) value = { [USER]: value };
    expect(failure(() => user({ op: "replace", value }))).toBe("400:invalidValue");
    expect(failure(() => user({ op: "replace", value: { [USER]: { [USER]: {} } } }))).toBe(
      "400:invalidValue",
    );
    expect(user({ op: "replace", value: { [USER]: { displayName: "once" } } }).displayName).toBe(
      "once",
    );
  });
});
