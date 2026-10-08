/**
 * Authorization port (EXECUTION_PLAN §5.2 `AuthzPort`, §6.4, ADR-0014). The default adapter
 * is the in-Postgres evaluator in `@fundroom/authz` (grants + policy gates materialised into
 * `core.effective_access`); an OpenFGA / SpiceDB adapter can implement the same surface later.
 *
 * Two questions are answered here and nowhere else:
 *  - staff RBAC: which `<module>.<verb>` permissions a membership holds (`permissionsFor`);
 *  - resource access: whether a membership may `view|download|comment|edit` a resource, which
 *    gates still stand in the way, who else has access and why (`check`, `listAccessible`,
 *    `whoHasAccess`, `explain`).
 *
 * Types here are deliberately free of database types so the port can cross the adapter seam.
 */

export const CAPABILITIES = ["view", "download", "comment", "edit"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export const GRANT_SUBJECT_KINDS = ["membership", "group", "role", "link"] as const;
export type GrantSubjectKind = (typeof GRANT_SUBJECT_KINDS)[number];

export type GrantEffect = "allow" | "exclude";

/** Who a grant is for. Roles are staff roles; links arrive with E2.3. */
export type SubjectRef =
  | { readonly kind: "membership"; readonly id: string }
  | { readonly kind: "group"; readonly id: string }
  | { readonly kind: "link"; readonly id: string }
  | { readonly kind: "role"; readonly role: string };

/**
 * What a grant is on. `path` is the ltree materialised path for hierarchical resources
 * (folders: `root.a1b2.c3d4`); flat resources (a post, a metric set) leave it undefined.
 * The kernel never validates that a resource exists: the module that owns it does.
 */
export interface ResourceRef {
  readonly kind: string;
  readonly id: string;
  readonly path?: string | undefined;
}

export const GATE_KINDS = ["nda", "accredited", "min_auth_level", "ip_allowlist"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

/** A policy gate that still stands between the membership and the resource. */
export interface PendingGate {
  readonly kind: GateKind;
  /** `nda`: the version to sign; `min_auth_level`: the level; `accredited`: max age days. */
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
  /** Where the gate came from (`workspace`, `group:<id>`, `membership`, `resource`). */
  readonly source: string;
}

/** Facts about the request that session-bound gates need. */
export interface RequestFacts {
  readonly authLevel?: 0 | 1 | 2 | undefined;
  readonly ip?: string | undefined;
}

export interface AccessDecision {
  readonly allowed: boolean;
  /** Capabilities the membership holds on the resource, gates aside. */
  readonly capabilities: readonly Capability[];
  /** Empty when nothing stands in the way. */
  readonly pendingGates: readonly PendingGate[];
  /** `granted` (allowed), `no_grant`, `gated` (granted but a gate is pending), `not_member`. */
  readonly reason: "granted" | "no_grant" | "gated" | "not_member";
}

export interface AccessibleResource {
  readonly kind: string;
  readonly id: string;
  readonly path: string | undefined;
  readonly capabilities: readonly Capability[];
  readonly pendingGates: readonly PendingGate[];
  readonly expiresAt: Date | undefined;
}

/** One line of "who has access": a membership and every path that gives it access. */
export interface AccessHolder {
  readonly membershipId: string;
  readonly capabilities: readonly Capability[];
  readonly pendingGates: readonly PendingGate[];
  readonly via: readonly AccessVia[];
  readonly expiresAt: Date | undefined;
}

/** How access arrives: a direct grant, a group, a staff role, or a link. */
export interface AccessVia {
  readonly subject: SubjectRef;
  readonly grantId: string;
  readonly capability: Capability;
  readonly effect: GrantEffect;
  /** The resource the grant names; equals the asked resource for direct rules, an ancestor for inherited ones. */
  readonly resource: ResourceRef;
  readonly inherited: boolean;
  /** Whether this rule decided the capability (nearest wins) or was overridden. */
  readonly decisive: boolean;
  readonly validUntil: Date | undefined;
}

export interface AccessExplanation {
  readonly membershipId: string;
  readonly resource: ResourceRef;
  readonly decision: AccessDecision;
  /** Every rule that applied to this membership on this resource, most specific first. */
  readonly rules: readonly AccessVia[];
  /** The evaluated acl version of the workspace the answer came from. */
  readonly aclVersion: number;
}

export interface AuthzPrincipal {
  readonly workspaceId: string;
  readonly membershipId: string;
}

export interface AuthzPort {
  /** Staff RBAC: the `<module>.<verb>` permissions this role holds among `catalogue`. External kinds hold none. */
  permissionsFor(
    membership: {
      readonly kind: "staff" | "external";
      readonly role: string;
      readonly status: string;
    },
    catalogue: Iterable<string>,
  ): string[];
  /** May the membership exercise `capability` on the resource right now? Never throws for unknown resources. */
  check(
    principal: AuthzPrincipal,
    resource: ResourceRef,
    capability: Capability,
    facts?: RequestFacts,
  ): Promise<AccessDecision>;
  /** Every resource of `kind` the membership holds at least `view` on (list screens, RLS mirror). */
  listAccessible(
    principal: AuthzPrincipal,
    kind: string,
    facts?: RequestFacts,
  ): Promise<readonly AccessibleResource[]>;
  /** Everyone with access to a resource and why ("Who has access" sheet, compliance export). */
  whoHasAccess(workspaceId: string, resource: ResourceRef): Promise<readonly AccessHolder[]>;
  /** "Why can Bob see this?" for one membership. */
  explain(
    principal: AuthzPrincipal,
    resource: ResourceRef,
    facts?: RequestFacts,
  ): Promise<AccessExplanation>;
}
