import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type AuthzMatrix,
  AuthzMatrixError,
  apiKeyScopes,
  loadAuthzMatrix,
  type MatrixRoute,
  parseAuthzMatrix,
  permissionsForRole,
  renderAuthzMatrix,
  requirementTag,
  roleHasPermission,
  routeRequirement,
} from "./matrix.js";

describe("authz matrix", () => {
  // Loaded per test, not at collection: a load error must fail tests, not just the file
  // (Stryker's vitest runner does not count a collection error as a killed mutant).
  let matrix: AuthzMatrix;
  beforeEach(() => {
    matrix = loadAuthzMatrix();
  });

  it("parses the compiled-in file", () => {
    expect(matrix.version).toBe(1);
    expect(matrix.staffRoles).toEqual(["owner", "admin", "editor", "viewer", "finance", "legal"]);
    expect(matrix.externalRoles).toEqual(["investor", "delegate"]);
    expect(matrix.permissions.get("access.manage")?.roles).toEqual(["owner", "admin"]);
    expect(matrix.routes.length).toBeGreaterThan(40);
  });

  it("gives the owner everything and external kinds nothing", () => {
    const catalogue = [...matrix.permissions.keys()];
    const owner = { kind: "staff" as const, role: "owner", status: "active" };
    expect(permissionsForRole(owner, catalogue)).toEqual([...catalogue].sort());
    expect(
      permissionsForRole({ kind: "external", role: "investor", status: "active" }, catalogue),
    ).toEqual([]);
    expect(
      permissionsForRole({ kind: "staff", role: "owner", status: "dormant" }, catalogue),
    ).toEqual([]);
  });

  it("legal reads but does not manage; unknown permissions are held by nobody", () => {
    const legal = { kind: "staff" as const, role: "legal", status: "active" };
    expect(permissionsForRole(legal, ["access.read", "access.manage", "mystery.perm"])).toEqual([
      "access.read",
    ]);
    expect(roleHasPermission("owner", "mystery.perm")).toBe(false);
    expect(roleHasPermission("admin", "access.transfer")).toBe(false);
    expect(roleHasPermission("owner", "access.transfer")).toBe(true);
  });

  it("looks up route requirements and renders their tag", () => {
    expect(routeRequirement("get", "/me")).toMatchObject({ requires: "session", stepUp: false });
    expect(routeRequirement("POST", "/access/grants")).toMatchObject({
      requires: "access.manage",
      stepUp: true,
    });
    expect(requirementTag({ requires: "access.manage", stepUp: true })).toBe("access.manage+fresh");
    expect(routeRequirement("GET", "/nope")).toBeUndefined();
  });

  it("rejects malformed matrices", () => {
    expect(() => parseAuthzMatrix("version: 2\nroles: {staff: [], external: []}")).toThrow(
      AuthzMatrixError,
    );
    expect(() =>
      parseAuthzMatrix(
        "version: 1\nroles: {staff: [owner], external: []}\npermissions:\n  a.b: {roles: [ghost]}",
      ),
    ).toThrow(/non-staff role/u);
    expect(() =>
      parseAuthzMatrix(
        "version: 1\nroles: {staff: [owner], external: []}\nroutes:\n  - {method: GET, path: /x, requires: nope}",
      ),
    ).toThrow(/unknown nope/u);
    expect(() =>
      parseAuthzMatrix(
        "version: 1\nroles: {staff: [owner], external: []}\nroutes:\n  - {method: GET, path: /x, requires: public}\n  - {method: get, path: /x, requires: public}",
      ),
    ).toThrow(/listed twice/u);
  });

  it("docs/authz-matrix.md is current (pnpm --filter @fundroom/authz matrix:docs)", () => {
    const rendered = renderAuthzMatrix(matrix);
    expect(rendered).toContain("| `access.manage` | ✓ | ✓ | – | – | – | – |");
    const onDisk = readFileSync(new URL("../../../docs/authz-matrix.md", import.meta.url), "utf8");
    expect(onDisk).toBe(rendered);
  });
});

describe("parseAuthzMatrix", () => {
  const HEAD = "version: 1\nroles: {staff: [owner, admin], external: [investor]}\n";
  const err = (text: string) => {
    try {
      parseAuthzMatrix(text);
    } catch (e) {
      return e;
    }
    throw new Error("expected parseAuthzMatrix to throw");
  };
  const expectRejects = (text: string, message: string) => {
    const e = err(text);
    expect(e).toBeInstanceOf(AuthzMatrixError);
    expect((e as Error).message).toBe(message);
    expect((e as Error).name).toBe("AuthzMatrixError");
  };

  it("parses a minimal matrix exactly", () => {
    const m = parseAuthzMatrix(
      `${HEAD}permissions:\n  access.read: {roles: [owner, admin], description: Read things}\n  docs.edit-all: {roles: [owner]}\nroutes:\n  - {method: get, path: /a, requires: public}\n  - {method: POST, path: /a, requires: access.read, stepUp: true}\n  - {method: GET, path: /b, requires: session, stepUp: "yes"}\n  - {method: GET, path: /c, requires: member}\n  - {method: GET, path: /d, requires: owner-or-admin}\n`,
    );
    expect(m.version).toBe(1);
    expect(m.staffRoles).toEqual(["owner", "admin"]);
    expect(m.externalRoles).toEqual(["investor"]);
    expect([...m.permissions]).toEqual([
      ["access.read", { roles: ["owner", "admin"], description: "Read things" }],
      ["docs.edit-all", { roles: ["owner"], description: "" }],
    ]);
    expect(m.routes).toEqual([
      { method: "GET", path: "/a", requires: "public", stepUp: false, apiKey: false },
      { method: "POST", path: "/a", requires: "access.read", stepUp: true, apiKey: false },
      { method: "GET", path: "/b", requires: "session", stepUp: false, apiKey: false },
      { method: "GET", path: "/c", requires: "member", stepUp: false, apiKey: false },
      { method: "GET", path: "/d", requires: "owner-or-admin", stepUp: false, apiKey: false },
    ]);
  });

  it("allows empty permission and route sections", () => {
    const m = parseAuthzMatrix(HEAD);
    expect(m.permissions.size).toBe(0);
    expect(m.routes).toEqual([]);
  });

  it("rejects a document that is not a map, or of another version", () => {
    expectRejects("", "matrix is not a map");
    expectRejects("42", "matrix is not a map");
    expectRejects("version: 2\nroles: {staff: [], external: []}", "unsupported matrix version 2");
    expectRejects("roles: {staff: [], external: []}", "unsupported matrix version undefined");
    expectRejects('version: "1"\nroles: {staff: [], external: []}', "unsupported matrix version 1");
  });

  it("rejects missing or malformed role lists", () => {
    expectRejects("version: 1", "roles.staff must be a list");
    expectRejects("version: 1\nroles: {staff: [owner]}", "roles.external must be a list");
    expectRejects("version: 1\nroles: {staff: owner, external: []}", "roles.staff must be a list");
    expectRejects(
      "version: 1\nroles: {staff: [owner, ''], external: []}",
      "roles.staff[1] must be a string",
    );
    expectRejects(
      "version: 1\nroles: {staff: [owner], external: [3]}",
      "roles.external[0] must be a string",
    );
  });

  it("insists on <module>.<verb> permission names", () => {
    for (const bad of [
      "access",
      "Access.read",
      "access.Read",
      "1a.read",
      "a.1read",
      "a.b.c",
      "xa.b!",
      "-a.b",
      "a._b",
    ]) {
      expectRejects(
        `${HEAD}permissions:\n  "${bad}": {roles: [owner]}`,
        `permission ${bad} is not <module>.<verb>`,
      );
    }
    for (const ok of ["a.b", "ab-1.cd_e-2", "module9.verb"]) {
      expect(
        parseAuthzMatrix(`${HEAD}permissions:\n  "${ok}": {roles: [owner]}`).permissions.has(ok),
      ).toBe(true);
    }
  });

  it("rejects a permission without roles, or naming a role that is not staff", () => {
    expectRejects(`${HEAD}permissions:\n  a.b: ~`, "permissions.a.b.roles must be a list");
    expectRejects(
      `${HEAD}permissions:\n  a.b: {roles: owner}`,
      "permissions.a.b.roles must be a list",
    );
    expectRejects(
      `${HEAD}permissions:\n  a.b: {roles: [owner, investor]}`,
      "permission a.b names non-staff role investor",
    );
  });

  it("rejects incomplete routes and unknown requirements", () => {
    expectRejects(
      `${HEAD}routes:\n  - {path: /x, requires: public}`,
      "route.method must be a string",
    );
    expectRejects(
      `${HEAD}routes:\n  - {method: get, requires: public}`,
      "route.path must be a string",
    );
    expectRejects(
      `${HEAD}routes:\n  - {method: get, path: /x}`,
      "route GET /x.requires must be a string",
    );
    expectRejects(
      `${HEAD}routes:\n  - {method: get, path: /x, requires: access.read}`,
      "route GET /x requires unknown access.read",
    );
    expectRejects(
      `${HEAD}routes:\n  - {method: get, path: /x, requires: public}\n  - {method: GET, path: /x, requires: session}`,
      "route GET /x listed twice",
    );
  });
});

describe("RBAC lookups against an explicit matrix", () => {
  let m: AuthzMatrix;
  beforeEach(() => {
    m = parseAuthzMatrix(
      "version: 1\nroles: {staff: [owner, admin], external: [investor]}\npermissions:\n  a.read: {roles: [owner, admin]}\n  a.manage: {roles: [owner]}\nroutes:\n  - {method: GET, path: /x, requires: a.read}\n",
    );
  });

  it("never hands a permission to an external membership, even one carrying a staff role name", () => {
    expect(
      permissionsForRole({ kind: "external", role: "owner", status: "active" }, ["a.read"], m),
    ).toEqual([]);
    expect(
      permissionsForRole({ kind: "staff", role: "owner", status: "suspended" }, ["a.read"], m),
    ).toEqual([]);
    expect(
      permissionsForRole(
        { kind: "staff", role: "admin", status: "active" },
        ["a.manage", "a.read"],
        m,
      ),
    ).toEqual(["a.read"]);
  });

  it("uses the matrix it is given", () => {
    expect(roleHasPermission("admin", "a.read", m)).toBe(true);
    expect(roleHasPermission("admin", "a.manage", m)).toBe(false);
    expect(routeRequirement("get", "/x", m)).toEqual({
      method: "GET",
      path: "/x",
      requires: "a.read",
      stepUp: false,
      apiKey: false,
    });
    expect(requirementTag({ requires: "a.read", stepUp: false })).toBe("a.read");
  });
});

describe("apiKey rows (E3.4)", () => {
  const HEAD =
    "version: 1\nroles: {staff: [owner, admin], external: [investor]}\npermissions:\n  a.read: {roles: [owner]}\n  b.write: {roles: [owner]}\n";

  it("parses apiKey, tags it +apikey and renders it", () => {
    const m = parseAuthzMatrix(
      `${HEAD}routes:\n  - {method: GET, path: /a, requires: a.read, apiKey: true}\n  - {method: POST, path: /b, requires: b.write}\n  - {method: PUT, path: /b, requires: b.write, apiKey: "yes"}\n`,
    );
    expect(m.routes).toEqual([
      { method: "GET", path: "/a", requires: "a.read", stepUp: false, apiKey: true },
      { method: "POST", path: "/b", requires: "b.write", stepUp: false, apiKey: false },
      { method: "PUT", path: "/b", requires: "b.write", stepUp: false, apiKey: false },
    ]);
    expect(requirementTag(m.routes[0] as MatrixRoute)).toBe("a.read+apikey");
    expect(requirementTag(m.routes[1] as MatrixRoute)).toBe("b.write");
    expect(requirementTag({ requires: "a.read", stepUp: true, apiKey: true })).toBe("a.read+fresh");
    expect(apiKeyScopes(m)).toEqual(["a.read"]);
    const rendered = renderAuthzMatrix(m);
    expect(rendered).toContain("| Method | Path | Requires | Step-up | API key |");
    expect(rendered).toContain("| GET | `/a` | a.read |  | yes |");
    expect(rendered).toContain("| POST | `/b` | b.write |  |  |");
  });

  it("rejects apiKey with stepUp", () => {
    expect(() =>
      parseAuthzMatrix(
        `${HEAD}routes:\n  - {method: POST, path: /a, requires: a.read, stepUp: true, apiKey: true}\n`,
      ),
    ).toThrow(new AuthzMatrixError("route POST /a cannot be apiKey with stepUp"));
  });

  it.each(["public", "session", "member", "owner-or-admin"])(
    "rejects apiKey on a %s row",
    (requires) => {
      expect(() =>
        parseAuthzMatrix(
          `${HEAD}routes:\n  - {method: GET, path: /a, requires: ${requires}, apiKey: true}\n`,
        ),
      ).toThrow(
        new AuthzMatrixError("route GET /a can only be apiKey when it requires a permission"),
      );
    },
  );

  it("the shipped matrix only marks permission rows without step-up", () => {
    const shipped = loadAuthzMatrix();
    for (const r of shipped.routes.filter((x) => x.apiKey)) {
      expect(r.stepUp).toBe(false);
      expect(shipped.permissions.has(r.requires)).toBe(true);
    }
    expect(apiKeyScopes(shipped)).toEqual(
      [...new Set(shipped.routes.filter((x) => x.apiKey).map((x) => x.requires))].sort(),
    );
  });
});
