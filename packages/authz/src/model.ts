import type {
  Capability,
  GateKind,
  GrantEffect,
  PendingGate,
  ResourceRef,
  SubjectRef,
} from "@fundroom/ports";

/*
 * The evaluator's vocabulary (ADR-0014, mechanics in ADR-0032). Everything here is plain
 * data: repositories load it from `core.access_grant` / `core.access_policy` / memberships,
 * `evaluate.ts` resolves it, `rebuild.ts` materialises the result.
 */

/** One live grant row as the evaluator sees it. */
export interface Rule {
  readonly grantId: string;
  readonly subject: SubjectRef;
  readonly resource: ResourceRef;
  readonly capability: Capability;
  readonly effect: GrantEffect;
  readonly validFrom: Date | undefined;
  readonly validUntil: Date | undefined;
  /**
   * Set by `rulesFor` on a rule a delegate borrows from its principal (E3.2). `resolveNode`
   * resolves borrowed rules apart from the delegate's own; an exclude on either side denies (F4).
   */
  readonly borrowed?: true | undefined;
}

/** A policy gate as attached to something. */
export interface Gate {
  readonly policyId: string;
  readonly kind: GateKind;
  readonly config: Readonly<Record<string, unknown>>;
  readonly target:
    | { readonly kind: "workspace" }
    | { readonly kind: "group"; readonly id: string }
    | { readonly kind: "membership"; readonly id: string }
    /** E2.3: the share link a visitor came through, not the visitor. */
    | { readonly kind: "link"; readonly id: string }
    | { readonly kind: "resource"; readonly resource: ResourceRef };
}

/** What we know about one membership when resolving its access. */
export interface Principal {
  readonly membershipId: string;
  readonly kind: "staff" | "external";
  readonly role: string;
  readonly groupIds: readonly string[];
  /**
   * Live share links this membership was admitted through (E2.3), newest first. Read from
   * `core.share_link_visit`, so revoking the link stops emitting the subject for everyone it
   * ever admitted — one write, no per-visitor grant to chase.
   */
  readonly linkIds: readonly string[];
  /** Live attestation kinds (`nda:v3`, `accredited`) with when they were signed. */
  readonly attestations: readonly PrincipalAttestation[];
  /**
   * When the membership lapses (`membership.expires_at`); undefined is open-ended. An expired
   * membership is not loaded at all, so this only bounds how long the rows built now stay true.
   */
  readonly expiresAt?: Date | undefined;
  /**
   * Set when this membership is a delegate whose principal is live (E3.2). A delegate whose
   * principal is not live is not loaded at all, and `expiresAt` above is already the earlier of the
   * delegate's and the principal's own expiry.
   */
  readonly delegation?: Delegation | undefined;
}

/** What a delegate borrows from its principal (design/05 §4.2), resolved by `rulesFor` / `gatesFor`. */
export interface Delegation {
  readonly principalMembershipId: string;
  /** The principal's live groups. */
  readonly principalGroupIds: readonly string[];
  readonly scope: DelegateScopeName;
}

export type DelegateScopeName = "all" | "data_room" | "updates";

/**
 * The resource kinds a narrow delegate scope admits (E3.2). `all` admits every kind. These are the
 * `resourceKinds` keys of the data-room and updates manifests; they are written here because the
 * rebuild runs without a module registry (the portability CLI rebuilds too), and
 * `apps/server/src/delegates.integration.test.ts` pins them to the manifests so they cannot drift.
 */
export const DELEGATE_SCOPE_KINDS: Readonly<
  Record<Exclude<DelegateScopeName, "all">, readonly string[]>
> = {
  data_room: ["folder", "document"],
  updates: ["post"],
};

/** The module id whose resources (and group audiences) a narrow scope admits. */
export const DELEGATE_SCOPE_MODULES: Readonly<Record<Exclude<DelegateScopeName, "all">, string>> = {
  data_room: "data-room",
  updates: "updates",
};

/** Whether a delegate with `scope` inherits its principal's allow rules on resources of `kind`. */
export function delegateScopeAdmitsKind(scope: DelegateScopeName, kind: string): boolean {
  if (scope === "all") return true;
  return DELEGATE_SCOPE_KINDS[scope]?.includes(kind) ?? false;
}

export interface PrincipalAttestation {
  readonly kind: string;
  readonly signedAt: Date;
  /** The attestation's own `expires_at`; undefined is open-ended. */
  readonly expiresAt?: Date | undefined;
}

/**
 * Whether a membership's own `expires_at` has passed at `now` (P1-01). `null`/`undefined` is
 * open-ended. The instant itself counts as expired, the same boundary the rebuild and the
 * effective-access rows use. An expired membership is not live anywhere: not for staff RBAC,
 * not for member-only routes, not for grants.
 */
export function membershipExpired(expiresAt: Date | null | undefined, now: Date): boolean {
  return expiresAt != null && expiresAt.getTime() <= now.getTime();
}

/** Subject specificity: a rule for the person beats a rule for their group beats a rule for a role. */
export const SUBJECT_SPECIFICITY: Readonly<Record<SubjectRef["kind"], number>> = {
  membership: 3,
  link: 2,
  group: 1,
  role: 0,
};

export function subjectKey(s: SubjectRef): string {
  return s.kind === "role" ? `role:${s.role}` : `${s.kind}:${s.id}`;
}

export function resourceKey(r: ResourceRef): string {
  return `${r.kind}:${r.id}`;
}

/** `ancestor` is the same node as `path` or above it (`a.b` ⊇ `a.b.c`). */
export function isAncestorOrSelf(ancestor: string, path: string): boolean {
  return ancestor === path || path.startsWith(`${ancestor}.`);
}

export function pathDepth(path: string | undefined): number {
  return path === undefined || path.length === 0 ? 0 : path.split(".").length;
}

/**
 * A staff-only container (E3.5, ADR-0053): a data-room folder whose subtree no external member
 * reaches through ANY grant — inherited from above, on the folder itself, or on anything inside it.
 * Signed e-signature documents are vaulted into one. `path` is the folder's own ltree path.
 */
export interface StaffOnlyNode {
  readonly kind: string;
  readonly id: string;
  readonly path: string;
}

/**
 * Whether `location` (a folder's own path, or the path a document sits at) is at or below one of
 * the staff-only nodes. `undefined` (a flat resource, or a document whose location is unknown) is
 * never veiled: it is not in the tree at all.
 */
export function veiledBy(
  location: string | undefined,
  staffOnly: readonly StaffOnlyNode[],
): boolean {
  if (location === undefined) return false;
  return staffOnly.some((s) => isAncestorOrSelf(s.path, location));
}

export const LTREE_PATH_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/u;

export function isPendingGate(value: unknown): value is PendingGate {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["kind"] === "string" && typeof v["source"] === "string";
}
