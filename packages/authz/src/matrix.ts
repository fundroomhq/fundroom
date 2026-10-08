import { readFileSync } from "node:fs";
import { parse } from "yaml";

/*
 * The authorization matrix (`matrix/authz-matrix.yaml`): staff RBAC (permission → roles) and
 * per-route requirements. Loaded once; `permissionsForRole` is the RBAC layer of `AuthzPort`,
 * the route table backs the generated CI tests and `docs/authz-matrix.md`.
 */
export interface MatrixPermission {
  readonly roles: readonly string[];
  readonly description: string;
}

export interface MatrixRoute {
  readonly method: string;
  readonly path: string;
  readonly requires: string;
  readonly stepUp: boolean;
  /**
   * The route may be called with a workspace API key (E3.4, ADR-0052). Only on permission rows
   * without `stepUp`: a key never satisfies a freshness check, nor `session`, `member`,
   * `owner-or-admin` or `public`.
   */
  readonly apiKey: boolean;
}

export interface AuthzMatrix {
  readonly version: number;
  readonly staffRoles: readonly string[];
  readonly externalRoles: readonly string[];
  readonly permissions: ReadonlyMap<string, MatrixPermission>;
  readonly routes: readonly MatrixRoute[];
}

export const MATRIX_PATH = new URL("../matrix/authz-matrix.yaml", import.meta.url);

/**
 * `requires` values that are not permissions. `platform-operator` (E3.10, ADR-0058): the operator
 * cookie session of a live platform operator on the canonical host (`requirePlatformOperator()`
 * in apps/server); no workspace membership is involved, and everybody else gets 404.
 */
export const ROUTE_REQUIREMENTS = [
  "public",
  "session",
  "member",
  "owner-or-admin",
  "platform-operator",
] as const;
export type RouteRequirement = (typeof ROUTE_REQUIREMENTS)[number] | (string & {});

export class AuthzMatrixError extends Error {
  override readonly name = "AuthzMatrixError";
}

function str(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length === 0)
    throw new AuthzMatrixError(`${what} must be a string`);
  return v;
}

function strList(v: unknown, what: string): string[] {
  if (!Array.isArray(v)) throw new AuthzMatrixError(`${what} must be a list`);
  return v.map((x, i) => str(x, `${what}[${i}]`));
}

export function parseAuthzMatrix(text: string): AuthzMatrix {
  const raw = parse(text) as Record<string, unknown>;
  if (typeof raw !== "object" || raw === null) throw new AuthzMatrixError("matrix is not a map");
  const version = raw["version"];
  if (version !== 1) throw new AuthzMatrixError(`unsupported matrix version ${String(version)}`);
  const roles = raw["roles"] as Record<string, unknown>;
  const staffRoles = strList(roles?.["staff"], "roles.staff");
  // Stryker disable next-line OptionalChaining: a missing `roles` already threw on `roles.staff`
  const externalRoles = strList(roles?.["external"], "roles.external");
  const permissions = new Map<string, MatrixPermission>();
  for (const [name, def] of Object.entries((raw["permissions"] ?? {}) as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9-]*\.[a-z][a-z0-9_-]*$/u.test(name))
      throw new AuthzMatrixError(`permission ${name} is not <module>.<verb>`);
    const d = def as Record<string, unknown>;
    const roleList = strList(d?.["roles"], `permissions.${name}.roles`);
    for (const r of roleList) {
      if (!staffRoles.includes(r))
        throw new AuthzMatrixError(`permission ${name} names non-staff role ${r}`);
    }
    permissions.set(name, {
      roles: roleList,
      // Stryker disable next-line OptionalChaining: a null `d` already threw on its roles above
      description: typeof d?.["description"] === "string" ? d["description"] : "",
    });
  }
  const routes: MatrixRoute[] = [];
  const seen = new Set<string>();
  for (const entry of (raw["routes"] ?? []) as unknown[]) {
    const e = entry as Record<string, unknown>;
    const method = str(e["method"], "route.method").toUpperCase();
    const path = str(e["path"], "route.path");
    const requires = str(e["requires"], `route ${method} ${path}.requires`);
    if (
      !(ROUTE_REQUIREMENTS as readonly string[]).includes(requires) &&
      !permissions.has(requires)
    ) {
      throw new AuthzMatrixError(`route ${method} ${path} requires unknown ${requires}`);
    }
    const key = `${method} ${path}`;
    if (seen.has(key)) throw new AuthzMatrixError(`route ${key} listed twice`);
    seen.add(key);
    const stepUp = e["stepUp"] === true;
    const apiKey = e["apiKey"] === true;
    if (apiKey && stepUp) throw new AuthzMatrixError(`route ${key} cannot be apiKey with stepUp`);
    if (apiKey && !permissions.has(requires)) {
      throw new AuthzMatrixError(`route ${key} can only be apiKey when it requires a permission`);
    }
    routes.push({ method, path, requires, stepUp, apiKey });
  }
  return { version, staffRoles, externalRoles, permissions, routes };
}

let cached: AuthzMatrix | undefined;

/** The compiled-in matrix, parsed once. */
export function loadAuthzMatrix(): AuthzMatrix {
  cached ??= parseAuthzMatrix(readFileSync(MATRIX_PATH, "utf8"));
  return cached;
}

/**
 * RBAC (ADR-0014 layer 2): the permissions of `catalogue` that a staff role holds. A
 * permission the matrix does not know is held by nobody (fail closed); the CI matrix test
 * flags it so the module author adds a row.
 */
export function permissionsForRole(
  membership: {
    readonly kind: "staff" | "external";
    readonly role: string;
    readonly status: string;
  },
  catalogue: Iterable<string>,
  matrix: AuthzMatrix = loadAuthzMatrix(),
): string[] {
  if (membership.kind !== "staff" || membership.status !== "active") return [];
  const out: string[] = [];
  for (const p of catalogue) {
    const def = matrix.permissions.get(p);
    if (def?.roles.includes(membership.role)) out.push(p);
  }
  return out.sort();
}

export function roleHasPermission(
  role: string,
  permission: string,
  matrix: AuthzMatrix = loadAuthzMatrix(),
): boolean {
  return matrix.permissions.get(permission)?.roles.includes(role) ?? false;
}

/** The route table entry for a method + OpenAPI path template. */
export function routeRequirement(
  method: string,
  path: string,
  matrix: AuthzMatrix = loadAuthzMatrix(),
): MatrixRoute | undefined {
  const m = method.toUpperCase();
  return matrix.routes.find((r) => r.method === m && r.path === path);
}

/**
 * The `x-requires` value a route should carry: `<requires>`, `<requires>+fresh` or
 * `<requires>+apikey` (the loader refuses `stepUp` together with `apiKey`).
 */
export function requirementTag(
  route: Pick<MatrixRoute, "requires" | "stepUp"> & { readonly apiKey?: boolean | undefined },
): string {
  if (route.stepUp) return `${route.requires}+fresh`;
  return route.apiKey === true ? `${route.requires}+apikey` : route.requires;
}

/**
 * `API_KEY_SCOPES`: the permissions that appear as `requires` on at least one `apiKey: true`
 * route, sorted. A key's scopes must be a subset (E3.4).
 */
export function apiKeyScopes(matrix: AuthzMatrix = loadAuthzMatrix()): string[] {
  const out = new Set<string>();
  for (const r of matrix.routes) if (r.apiKey) out.add(r.requires);
  return [...out].sort();
}

/** Markdown for `docs/authz-matrix.md`. */
export function renderAuthzMatrix(matrix: AuthzMatrix = loadAuthzMatrix()): string {
  const lines: string[] = [];
  lines.push("# Authorization matrix");
  lines.push("");
  lines.push(
    "Generated from `packages/authz/matrix/authz-matrix.yaml` by `pnpm --filter @fundroom/authz matrix:docs`; do not edit by hand. Staff roles hold permissions (RBAC); external members (investor, delegate) hold none and see only what grants and gates allow.",
  );
  lines.push("");
  lines.push("## Permissions by staff role");
  lines.push("");
  lines.push(`| Permission | ${matrix.staffRoles.join(" | ")} | Description |`);
  lines.push(`|---|${matrix.staffRoles.map(() => "---").join("|")}|---|`);
  for (const [name, def] of [...matrix.permissions.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const cells = matrix.staffRoles.map((r) => (def.roles.includes(r) ? "✓" : "–"));
    lines.push(`| \`${name}\` | ${cells.join(" | ")} | ${def.description} |`);
  }
  lines.push("");
  lines.push("## Routes");
  lines.push("");
  lines.push("| Method | Path | Requires | Step-up | API key |");
  lines.push("|---|---|---|---|---|");
  for (const r of matrix.routes) {
    lines.push(
      `| ${r.method} | \`${r.path}\` | ${r.requires} | ${r.stepUp ? "yes" : ""} | ${r.apiKey ? "yes" : ""} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
