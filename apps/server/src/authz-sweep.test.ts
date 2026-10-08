import { loadAuthzMatrix, roleHasPermission } from "@fundroom/authz";
import { describe, expect, it } from "vitest";
import {
  ACTORS,
  HANDLER_NOT_FOUND_MESSAGES,
  HOST_LEVEL_OWNER_OR_ADMIN,
  KNOWN_FINDINGS,
  listOperations,
  listRawRoutes,
  type Outcome,
  planFor,
  RAW_ROUTES,
  SKIPPED_OPERATIONS,
} from "./test/authz-sweep-plan.js";

/*
 * The coverage guard of the behavioural authz sweep (F-30; the sweep itself is
 * `authz-sweep.integration.test.ts`). Runs without Docker so a new route that the sweep cannot
 * plan fails the ordinary unit run, not only the integration one.
 */
describe("authz sweep coverage", () => {
  const ops = listOperations();
  const keys = new Set(ops.map((op) => `${op.method} ${op.path}`));

  it("sees the module raw routes too (they bypass the OpenAPI middleware chain)", () => {
    expect(listRawRoutes().length).toBeGreaterThan(0);
    expect(ops.some((op) => op.source === "raw")).toBe(true);
  });

  it("every operation is either swept or explicitly skipped with a reason", () => {
    const unplanned = ops
      .map((op) => ({ op, plan: planFor(op) }))
      .filter(({ plan }) => plan.kind === "unplanned")
      .map(
        ({ op, plan }) => `${op.method} ${op.path}: ${plan.kind === "unplanned" && plan.reason}`,
      );
    expect(unplanned).toEqual([]);
    expect(ops.length).toBeGreaterThan(300);
  });

  it("every non-public operation has a denial cell, and anonymous is always denied", () => {
    for (const op of ops) {
      const plan = planFor(op);
      if (plan.kind !== "sweep") continue;
      // E3.10: the operator surface answers anonymous callers with the same plain 404 as every
      // other non-operator (no oracle that it exists); everything else is a 401.
      expect(plan.cells.get("anonymous"), `${op.method} ${op.path}`).toMatchObject({
        kind: "deny",
        status: op.requires === "platform-operator" ? 404 : 401,
      });
      expect(plan.cells.size).toBe(ACTORS.length);
    }
  });

  it("skip lists, host-level exceptions and known findings name real operations", () => {
    const stale = [
      ...[...SKIPPED_OPERATIONS.keys()].filter((k) => !keys.has(k)),
      ...[...HOST_LEVEL_OWNER_OR_ADMIN].filter((k) => !keys.has(k)),
      ...[...HANDLER_NOT_FOUND_MESSAGES.keys()].filter((k) => !keys.has(k)),
      ...[...RAW_ROUTES.keys()].filter((k) => !listRawRoutes().includes(k)),
      ...[...KNOWN_FINDINGS.keys()]
        .map((k) => k.slice(0, k.lastIndexOf(" ")))
        .filter((k) => !keys.has(k)),
    ];
    expect(stale).toEqual([]);
    for (const reason of SKIPPED_OPERATIONS.values()) expect(reason.length).toBeGreaterThan(10);
  });
});

/*
 * The golden table (E3.2 review L-3). The sweep derives every expected cell from
 * `authz-matrix.yaml` — the same file the runtime reads — so a wrong row in the yaml would be
 * swept as "correct". These cells are written out by hand from the design (design/05 §4.2,
 * ADR-0032 and the rationale comments on each permission) and deliberately NOT computed from the
 * yaml: changing who holds a security-critical permission must change this table in the same
 * review, on purpose.
 */
const STAFF = ["owner", "admin", "editor", "viewer", "finance", "legal"] as const;
type Staff = (typeof STAFF)[number];
const GOLDEN_PERMISSIONS: Readonly<Record<string, readonly Staff[]>> = {
  // who is let in, and who runs the workspace
  "access.read": ["owner", "admin", "legal"],
  "access.manage": ["owner", "admin"],
  "access.manage_staff": ["owner", "admin"],
  "access.settings": ["owner", "admin"],
  "access.transfer": ["owner"],
  "access.delete_workspace": ["owner"],
  // the company's reliance on an exemption, and its legal texts
  "compliance.offering": ["owner", "admin"],
  "compliance.manage": ["owner", "admin", "legal"],
  // where the portal answers, who may frame it, who may be let in by link
  "branding.manage": ["owner", "admin"],
  "domains.manage": ["owner", "admin"],
  "embed.manage": ["owner", "admin"],
  "share-links.manage": ["owner", "admin"],
  // the trail and the whole-workspace copy
  "audit.read": ["owner", "admin", "legal"],
  "audit.export": ["owner", "legal"],
  "portability.export": ["owner"],
  "ops.manage": ["owner", "admin"],
  // original files and destructive content powers
  "data-room.manage": ["owner", "admin", "editor"],
  "data-room.download": ["owner", "admin", "editor", "finance", "legal"],
  "data-room.legal_hold": ["owner", "admin", "legal"],
  "data-room.settings": ["owner", "admin"],
  // tracing a leaked page names a recipient: an investigation (E3.13)
  "data-room.forensics": ["owner", "admin", "legal"],
  "updates.send": ["owner", "admin", "editor"],
  "round.publish": ["owner", "admin"],
  "analytics.settings": ["owner", "admin"],
  "notify.manage": ["owner", "admin"],
  // the e-sign vendor connection (credentials, callback secret) and the envelope register (E3.5)
  "esign.read": ["owner", "admin", "legal"],
  "esign.manage": ["owner", "admin"],
  // third-party connections: vendor tokens and keys (E3.6)
  "integrations.read": ["owner", "admin", "finance"],
  "integrations.manage": ["owner", "admin"],
  // who can sign in as staff (E3.8, FR1): an admin who could point the workspace at an IdP they
  // control could sign in as the owner, so only the owner changes SSO / SCIM
  "sso.read": ["owner", "admin"],
  "sso.manage": ["owner"],
  // paying for the workspace (E3.10): reading the plan and usage is for the people who pay or run
  // it; committing the company to a price is the owner's alone
  "billing.read": ["owner", "admin", "finance"],
  "billing.manage": ["owner"],
  // AI assist (E3.12): turning it on and acknowledging the model provider (documents may leave
  // the host) is owner/admin
  "ai.manage": ["owner", "admin"],
};

/** Security-critical routes: what they require and whether they need a fresh sign-in. */
const GOLDEN_ROUTES: readonly [method: string, path: string, requires: string, stepUp: boolean][] =
  [
    ["POST", "/access/ownership/transfer", "access.transfer", true],
    ["POST", "/access/sessions/revoke-all", "access.transfer", true],
    ["DELETE", "/workspace", "access.delete_workspace", true],
    ["POST", "/portability/exports", "portability.export", true],
    ["GET", "/portability/exports/{id}/download", "portability.export", true],
    ["POST", "/audit/exports", "audit.export", true],
    ["POST", "/domains", "domains.manage", true],
    ["PUT", "/embed/settings", "embed.manage", true],
    ["POST", "/links", "share-links.manage", true],
    ["POST", "/links/{id}/revoke", "share-links.manage", true],
    ["POST", "/access/people/{id}/sessions/revoke", "access.manage", true],
    ["PUT", "/esign/connection", "esign.manage", true],
    ["DELETE", "/esign/connection", "esign.manage", true],
    ["POST", "/esign/connection/rotate-callback-secret", "esign.manage", true],
    ["POST", "/esign/envelopes/{id}/void", "esign.manage", true],
    ["GET", "/esign/envelopes/{id}/signed.pdf", "esign.read", false],
    // vendor tokens and keys (E3.6): every credential-bearing write needs a fresh sign-in
    ["POST", "/integrations/{provider}/connect", "integrations.manage", true],
    ["POST", "/integrations/{provider}/oauth/begin", "integrations.manage", true],
    ["PUT", "/integrations/{provider}/account", "integrations.manage", true],
    ["POST", "/integrations/{provider}/rotate-webhook-secret", "integrations.manage", true],
    ["DELETE", "/integrations/{provider}", "integrations.manage", true],
    ["GET", "/integrations/bookings", "integrations.read", false],
    // staff SSO + SCIM (E3.8): every write that changes who gets in needs a fresh sign-in
    ["PUT", "/sso/connection", "sso.manage", true],
    ["PUT", "/sso/connection/state", "sso.manage", true],
    ["DELETE", "/sso/connection", "sso.manage", true],
    ["POST", "/sso/domains", "sso.manage", true],
    ["DELETE", "/sso/domains/{id}", "sso.manage", true],
    ["POST", "/sso/scim/tokens", "sso.manage", true],
    ["DELETE", "/sso/scim/tokens/{id}", "sso.manage", true],
    ["PUT", "/sso/scim/groups/{id}/role", "sso.manage", true],
    // billing (E3.10): checkout and the provider portal commit the company to a price
    ["POST", "/billing/checkout", "billing.manage", true],
    ["POST", "/billing/portal", "billing.manage", true],
    // AI assist (E3.12): the switch and the provider acknowledgement need a fresh sign-in
    ["PUT", "/ai/settings", "ai.manage", true],
    // evidence (E3.13): leak detection needs a fresh sign-in; an anchor proof is export material
    ["POST", "/data-room/documents/{id}/forensic/detect", "data-room.forensics", true],
    ["GET", "/audit/anchors/{checkpointId}/proof", "audit.export", false],
  ];

describe("golden security-critical cells (hand-written, not derived from the yaml)", () => {
  const matrix = loadAuthzMatrix();

  it("role × permission: exactly the roles the design names, and never an external kind", () => {
    const wrong: string[] = [];
    for (const [permission, holders] of Object.entries(GOLDEN_PERMISSIONS)) {
      expect(matrix.permissions.has(permission), permission).toBe(true);
      for (const role of STAFF) {
        const want = holders.includes(role);
        if (roleHasPermission(role, permission, matrix) !== want)
          wrong.push(`${role} ${want ? "lacks" : "holds"} ${permission}`);
      }
      for (const external of ["investor", "delegate"])
        if (roleHasPermission(external, permission, matrix))
          wrong.push(`${external} holds ${permission}`);
    }
    expect(wrong).toEqual([]);
  });

  it("the operator surface (E3.10) answers every tenant actor with the same plain 404", () => {
    const ops = listOperations(matrix);
    for (const [method, path] of [
      ["POST", "/platform/workspaces/{id}/suspend"],
      ["POST", "/platform/sanctions/{id}/decision"],
      ["PATCH", "/platform/plans/{id}"],
    ] as const) {
      const op = ops.find((o) => o.method === method && o.path === path);
      expect(op, `${method} ${path}`).toMatchObject({ requires: "platform-operator" });
      const plan = planFor(op as NonNullable<typeof op>, matrix);
      expect(plan.kind).toBe("sweep");
      if (plan.kind !== "sweep") continue;
      for (const actor of ACTORS) {
        expect(plan.cells.get(actor), `${method} ${path} as ${actor}`).toEqual({
          kind: "deny",
          status: 404,
          code: "not_found",
        });
      }
    }
  });

  it("critical routes require what the design says, and the sweep plans those exact cells", () => {
    const ops = listOperations(matrix);
    const deny = (status: number, code: string, reason?: string) =>
      reason === undefined
        ? { kind: "deny", status, code }
        : { kind: "deny", status, code, reason };
    for (const [method, path, requires, stepUp] of GOLDEN_ROUTES) {
      const op = ops.find((o) => o.method === method && o.path === path);
      expect(op, `${method} ${path}`).toMatchObject({ requires, stepUp });
      const plan = planFor(op as NonNullable<typeof op>, matrix);
      expect(plan.kind).toBe("sweep");
      if (plan.kind !== "sweep") continue;
      const holders = GOLDEN_PERMISSIONS[requires] ?? [];
      const cell = (actor: string): Outcome | undefined => plan.cells.get(actor as never);
      for (const role of STAFF) {
        expect(cell(role), `${method} ${path} as ${role}`).toEqual(
          holders.includes(role) ? { kind: "allow" } : deny(403, "forbidden"),
        );
      }
      // Nobody without a live staff membership here ever reaches the permission check.
      for (const actor of [
        "investor",
        "otherOwner",
        "expiredAdmin",
        "revokedAdmin",
        "delegateAll",
        "delegateDataRoom",
        "orphanDelegate",
      ])
        expect(cell(actor), `${method} ${path} as ${actor}`).toEqual(deny(404, "not_found"));
      expect(cell("anonymous")).toEqual(deny(401, "unauthenticated"));
      expect(cell("staleOwner")).toEqual(
        stepUp ? deny(403, "step_up_required", "fresh") : { kind: "allow" },
      );
      expect(cell("ownerLevel1")).toEqual(deny(403, "step_up_required", "level"));
    }
  });
});
