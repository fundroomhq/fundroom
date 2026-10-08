import type { StaffJitRole } from "./types.js";

/*
 * Identity linking (ADR-0056 decision 6), as a pure function of facts the service has already
 * read. The identity key is connection-scoped (`<connectionId>|<subject>`), so an IdP can never
 * resolve to a user some *other* workspace's IdP linked. Email is trusted only through
 *   (b) a DNS-verified domain of THIS workspace, or
 *   (c) a membership THIS workspace already gave that address;
 * `email_verified` is never required (Entra does not send it) and never sufficient.
 *
 * Order:
 *   a. an existing `user_identity` for the key → that user;
 *   b. else an email in a verified domain → the user holding that email (linked), or a new user
 *      (JIT only);
 *   c. else an email equal to a user with a non-revoked membership here → that user (linked);
 *   d. else refuse `unknown_user`.
 * Then the membership: external → `staff_only`; suspended → `suspended`; staff (invited, active,
 * dormant) → sign in; none → JIT when enabled and the email is in a verified domain (and the user,
 * if one was found, is the one holding that email), else `not_provisioned`.
 */

export interface LinkMembershipFact {
  readonly kind: "staff" | "external";
  readonly status: "invited" | "active" | "dormant" | "suspended" | "revoked";
}

export interface LinkFacts {
  /** The user an existing identity row for `<connectionId>|<subject>` names (rule a). */
  readonly identityUserId: string | undefined;
  /** The asserted email, normalised (lower-case), when the IdP sent a usable one. */
  readonly email: string | undefined;
  /** Whether the email's domain is a verified `sso_domain` of this workspace (rule b). */
  readonly emailDomainVerified: boolean;
  /** The live global user holding `email` as an email identity, if any. */
  readonly emailUserId: string | undefined;
  /** The non-revoked membership (in this workspace) of `emailUserId`, if any. */
  readonly emailUserMembership: LinkMembershipFact | undefined;
  /** The non-revoked membership (in this workspace) of `identityUserId`, if any. */
  readonly identityUserMembership: LinkMembershipFact | undefined;
  readonly jit: { readonly enabled: boolean; readonly role: StaffJitRole };
}

export type SsoRefusal = "unknown_user" | "not_provisioned" | "suspended" | "staff_only";

export type LinkDecision =
  /** Sign `userId` in; `link` → write the identity row first. */
  | {
      readonly kind: "login";
      readonly userId: string;
      readonly link: boolean;
      readonly rule: "a" | "b" | "c";
    }
  /**
   * Provision a staff membership (`provisionStaff` finds or creates the user by `email`), then link
   * and sign in. `userId` is the existing holder of the email, when there is one.
   */
  | {
      readonly kind: "jit";
      readonly email: string;
      readonly userId: string | undefined;
      readonly role: StaffJitRole;
      readonly link: boolean;
    }
  | { readonly kind: "refuse"; readonly code: SsoRefusal; readonly rule: "a" | "b" | "c" | "d" };

function membershipVerdict(
  m: LinkMembershipFact | undefined,
): "ok" | "none" | "suspended" | "staff_only" {
  if (m === undefined || m.status === "revoked") return "none";
  if (m.kind !== "staff") return "staff_only";
  if (m.status === "suspended") return "suspended";
  return "ok";
}

export function decideSsoLogin(f: LinkFacts): LinkDecision {
  let userId: string | undefined;
  let link = false;
  let rule: "a" | "b" | "c";
  let membership: LinkMembershipFact | undefined;
  if (f.identityUserId !== undefined) {
    userId = f.identityUserId;
    rule = "a";
    membership = f.identityUserMembership;
  } else if (f.email !== undefined && f.emailDomainVerified) {
    userId = f.emailUserId;
    link = true;
    rule = "b";
    membership = f.emailUserMembership;
  } else if (
    f.email !== undefined &&
    f.emailUserId !== undefined &&
    f.emailUserMembership !== undefined &&
    f.emailUserMembership.status !== "revoked"
  ) {
    userId = f.emailUserId;
    link = true;
    rule = "c";
    membership = f.emailUserMembership;
  } else {
    return { kind: "refuse", code: "unknown_user", rule: "d" };
  }

  const verdict = membershipVerdict(membership);
  if (verdict === "staff_only") return { kind: "refuse", code: "staff_only", rule };
  if (verdict === "suspended") return { kind: "refuse", code: "suspended", rule };
  if (verdict === "ok" && userId !== undefined) return { kind: "login", userId, link, rule };

  // No membership here (or a brand-new person under rule b).
  const jitAllowed =
    f.jit.enabled &&
    f.email !== undefined &&
    f.emailDomainVerified &&
    // `provisionStaff` works by email: it must land on the same user this login resolved to.
    (userId === undefined || f.emailUserId === userId);
  if (!jitAllowed || f.email === undefined) {
    return { kind: "refuse", code: "not_provisioned", rule };
  }
  return { kind: "jit", email: f.email, userId, role: f.jit.role, link };
}
