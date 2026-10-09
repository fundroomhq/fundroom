import { z } from "@hono/zod-openapi";
import { RelationshipSourceSchema, RelationshipWarningSchema } from "./compliance.js";
import { EmailSchema, page, TimestampSchema, trimmedText, UuidSchema } from "./schemas.js";

/*
 * Access management contracts (E1.1): people, invitations, CSV imports, groups, grants,
 * policies, "who has access" / explain, workspace access settings. Handlers live in
 * `apps/server/src/routes/access.ts`; the evaluator in `@fundroom/authz`.
 */

/**
 * One `ip_allowlist` entry (E2.10): an IPv4/IPv6 address or `<address>/<prefix>` with a prefix of
 * 0–32 (v4) or 0–128 (v6), no whitespace, no zone id. The evaluator (`@fundroom/authz`
 * `ipAllowed`) ignores a malformed entry fail-closed; this refuses it at the API so an admin is
 * told, instead of saving a rule that silently matches nothing.
 */
const IP_OR_CIDR = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()]);
export const CidrEntrySchema = z
  .string()
  .max(64)
  .refine((v) => IP_OR_CIDR.safeParse(v).success, {
    message: "must be an IP address or CIDR block such as 203.0.113.0/24 or 2001:db8::/32",
  })
  .openapi({
    description: "IPv4/IPv6 address or CIDR block (`203.0.113.0/24`, `2001:db8::/32`).",
    example: "203.0.113.0/24",
  });

export const MembershipKindSchema = z.enum(["staff", "external"]);
export const MembershipRoleSchema = z.enum([
  "owner",
  "admin",
  "editor",
  "viewer",
  "finance",
  "legal",
  "investor",
  "delegate",
]);
export const StaffRoleSchema = z.enum(["owner", "admin", "editor", "viewer", "finance", "legal"]);
export const MembershipStatusSchema = z.enum([
  "invited",
  "active",
  "dormant",
  "suspended",
  "revoked",
]);
/**
 * What a delegate inherits from its principal (E3.2): everything, the data room only, or updates
 * only. A delegate never inherits role rights and never passes its principal's gates.
 */
export const DelegateScopeSchema = z.enum(["all", "data_room", "updates"]).openapi("DelegateScope");
export const CapabilitySchema = z.enum(["view", "download", "comment", "edit"]);
export const GrantEffectSchema = z.enum(["allow", "exclude"]);
export const GateKindSchema = z.enum(["nda", "accredited", "min_auth_level", "ip_allowlist"]);

export const ResourceKindSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/u)
  .openapi({ example: "folder", description: "Resource kind owned by a module" });
export const LtreePathSchema = z
  .string()
  .max(1024)
  .regex(/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/u)
  .openapi({ example: "root.a1b2c3.d4e5f6", description: "Materialised path (ltree) for folders" });

export const ResourceRefSchema = z
  .object({
    kind: ResourceKindSchema,
    id: UuidSchema,
    path: LtreePathSchema.optional(),
  })
  .openapi("ResourceRef");

export const SubjectRefSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("membership"), id: UuidSchema }),
    z.object({ kind: z.literal("group"), id: UuidSchema }),
    z.object({ kind: z.literal("link"), id: UuidSchema }),
    z.object({ kind: z.literal("role"), role: MembershipRoleSchema }),
  ])
  .openapi("SubjectRef");

/** A subject with its display fields filled in for the UI. */
export const SubjectSummarySchema = z
  .object({
    kind: z.enum(["membership", "group", "link", "role"]),
    id: UuidSchema.optional(),
    role: MembershipRoleSchema.optional(),
    /** Person, group or role name. */
    label: z.string(),
  })
  .openapi("SubjectSummary");

export const PendingGateSchema = z
  .object({
    kind: GateKindSchema,
    detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
    source: z.string().openapi({ example: "group:0192…" }),
  })
  .openapi("PendingGate");

// --- people --------------------------------------------------------------------------------

export const GroupRefSchema = z.object({ id: UuidSchema, name: z.string() }).openapi("GroupRef");

/**
 * How the relationship with an external member began (design/04 §1.6, R5). It lives on the
 * person rather than behind its own endpoint because it is a membership fact, and the People
 * screen would otherwise need a second round trip to show the warning it exists to show.
 */
export const RelationshipSchema = z
  .object({
    /** Roughly when the relationship began. An approximate date you can stand behind beats none. */
    establishedAt: TimestampSchema.nullable(),
    source: z.union([RelationshipSourceSchema, z.null()]),
    note: z.string().nullable(),
    /** When this member was first served offering material. Written by the portal, not by hand. */
    firstExposureAt: TimestampSchema.nullable(),
    /**
     * The single worst problem with the evidence, under Rule 506(b) only. It warns and never
     * blocks: a warning that blocks becomes a warning admins route around, at which point the
     * facts stop being recorded at all.
     */
    warning: z.union([RelationshipWarningSchema, z.null()]),
  })
  .openapi("Relationship");

/** Who a delegate acts for, so a list can say "Jane Doe (for Acme Ventures — Bob Smith)". */
export const DelegatePrincipalSchema = z
  .object({
    membershipId: UuidSchema,
    displayName: z.string(),
    firm: z.string().nullable(),
  })
  .openapi("DelegatePrincipal");

export const PersonSchema = z
  .object({
    membershipId: UuidSchema,
    userId: UuidSchema,
    kind: MembershipKindSchema,
    role: MembershipRoleSchema,
    status: MembershipStatusSchema,
    displayName: z.string(),
    email: z.string().nullable(),
    groups: z.array(GroupRefSchema),
    profile: z.record(z.string(), z.unknown()),
    source: z.string(),
    principalMembershipId: UuidSchema.nullable(),
    /** E3.2: set for a delegate. */
    delegateScope: z.union([DelegateScopeSchema, z.null()]),
    /** E3.2: the delegate's principal, for display; null for everyone else. */
    principal: z.union([DelegatePrincipalSchema, z.null()]),
    expiresAt: TimestampSchema.nullable(),
    lastSeenAt: TimestampSchema.nullable(),
    activatedAt: TimestampSchema.nullable(),
    createdAt: TimestampSchema,
    relationship: RelationshipSchema,
  })
  .openapi("Person");

export const PeopleQuery = z.object({
  kind: MembershipKindSchema.optional(),
  /** Comma-separated statuses; default `invited,active,dormant,suspended`. */
  status: z.string().max(80).optional(),
  groupId: UuidSchema.optional(),
  q: z.string().max(120).optional(),
  cursor: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const PeoplePageSchema = page(PersonSchema, "PeoplePage");

export const AttestationSummarySchema = z
  .object({
    kind: z.string().openapi({ example: "nda:v3" }),
    signedAt: TimestampSchema,
    expiresAt: TimestampSchema.nullable(),
  })
  .openapi("AttestationSummary");

export const GrantSchema = z
  .object({
    id: UuidSchema,
    subject: SubjectRefSchema,
    resource: ResourceRefSchema,
    capability: CapabilitySchema,
    effect: GrantEffectSchema,
    validFrom: TimestampSchema.nullable(),
    validUntil: TimestampSchema.nullable(),
    note: z.string().nullable(),
    createdBy: UuidSchema.nullable(),
    createdAt: TimestampSchema,
  })
  .openapi("Grant");

export const PersonDetailSchema = z
  .object({
    person: PersonSchema,
    delegates: z.array(PersonSchema),
    attestations: z.array(AttestationSummarySchema),
    /** Direct grants for this membership (group grants show under the group). */
    grants: z.array(GrantSchema),
  })
  .openapi("PersonDetail");

export const PersonPatchBody = z.object({
  role: StaffRoleSchema.optional(),
  profile: z.record(z.string(), z.unknown()).optional(),
  expiresAt: TimestampSchema.nullable().optional(),
  /**
   * Record how the relationship began (E1.6). Only the keys present are written, so the People
   * screen can save one field at a time; `firstExposureAt` is not settable — the portal writes it
   * when it first serves offering material, and a hand-edited exposure date is not evidence.
   */
  relationship: z
    .object({
      establishedAt: TimestampSchema.nullable().optional(),
      source: z.union([RelationshipSourceSchema, z.null()]).optional(),
      note: z.string().trim().max(2000).nullable().optional(),
    })
    .optional(),
});

export const RevokeBody = z.object({ reason: z.string().max(500).optional() });
export const RevokeResultSchema = z
  .object({
    membershipIds: z.array(UuidSchema),
    sessionsRevoked: z.number().int().nonnegative(),
    grantsRevoked: z.number().int().nonnegative(),
  })
  .openapi("RevokeResult");

export const SetGroupsBody = z.object({ groupIds: z.array(UuidSchema).max(100) });
export const SetGroupsResultSchema = z
  .object({ added: z.array(UuidSchema), removed: z.array(UuidSchema) })
  .openapi("SetGroupsResult");

// --- invitations ---------------------------------------------------------------------------

export const InviteGrantBodySchema = z
  .object({
    resource: ResourceRefSchema,
    capabilities: z.array(CapabilitySchema).min(1),
    validUntil: TimestampSchema.optional(),
  })
  .openapi("InviteGrant");

export const InviteSchema = z
  .object({
    id: UuidSchema,
    email: z.string(),
    kind: MembershipKindSchema,
    role: MembershipRoleSchema,
    groupIds: z.array(UuidSchema),
    status: z.enum(["pending", "accepted", "expired", "revoked"]),
    message: z.string().nullable(),
    expiresAt: TimestampSchema,
    createdAt: TimestampSchema,
    invitedBy: UuidSchema.nullable(),
    acceptedAt: TimestampSchema.nullable(),
    acceptedMembershipId: UuidSchema.nullable(),
    /** E3.2: a delegate invitation's principal and scope; null on every other invitation. */
    principalMembershipId: UuidSchema.nullable(),
    delegateScope: z.union([DelegateScopeSchema, z.null()]),
  })
  .openapi("Invite");

export const InviteListQuery = z.object({
  status: z.enum(["pending", "accepted", "expired", "revoked"]).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
export const InviteListSchema = z.object({ invites: z.array(InviteSchema) }).openapi("InviteList");

const inviteDefaults = {
  kind: MembershipKindSchema.default("external"),
  role: MembershipRoleSchema.default("investor"),
  groupIds: z.array(UuidSchema).max(50).default([]),
  grants: z.array(InviteGrantBodySchema).max(50).default([]),
  message: z.string().max(2000).optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
};

export const InviteCreateBody = z.object({
  invites: z
    .array(
      z.object({
        email: EmailSchema,
        displayName: z.string().trim().max(120).optional(),
        firm: z.string().trim().max(120).optional(),
      }),
    )
    .min(1)
    .max(100),
  ...inviteDefaults,
});

export const InviteCreateResultSchema = z
  .object({
    created: z.array(InviteSchema),
    /** Addresses that could not be invited and why (`conflict` = already a member). */
    failed: z.array(z.object({ email: z.string(), code: z.string() })),
  })
  .openapi("InviteCreateResult");

export const CsvBody = z.object({
  csv: z.string().min(1).max(2_000_000),
  ...inviteDefaults,
});

export const ImportRowSchema = z
  .object({
    line: z.number().int(),
    email: z.string(),
    displayName: z.string(),
    firm: z.string(),
    groups: z.array(z.string()),
    groupIds: z.array(UuidSchema),
    expiresAt: TimestampSchema.nullable(),
    note: z.string(),
    status: z.enum(["ok", "skipped", "error", "invited", "failed"]),
    reason: z.string().optional(),
    inviteId: UuidSchema.optional(),
  })
  .openapi("ImportRow");

export const CsvDryRunResultSchema = z
  .object({
    rows: z.array(ImportRowSchema),
    summary: z.object({
      ok: z.number().int(),
      skipped: z.number().int(),
      error: z.number().int(),
    }),
  })
  .openapi("CsvDryRunResult");

export const InviteImportSchema = z
  .object({
    id: UuidSchema,
    status: z.enum(["queued", "running", "done", "failed"]),
    total: z.number().int(),
    invited: z.number().int(),
    skipped: z.number().int(),
    failed: z.number().int(),
    rows: z.array(ImportRowSchema),
    createdAt: TimestampSchema,
    startedAt: TimestampSchema.nullable(),
    finishedAt: TimestampSchema.nullable(),
  })
  .openapi("InviteImport");

// --- groups ---------------------------------------------------------------------------------

export const GroupKindSchema = z.enum(["custom", "round", "board", "advisors"]);

export const GroupSchema = z
  .object({
    id: UuidSchema,
    name: z.string(),
    kind: GroupKindSchema,
    memberCount: z.number().int().nonnegative(),
    createdAt: TimestampSchema,
  })
  .openapi("Group");

export const GroupListSchema = z.object({ groups: z.array(GroupSchema) }).openapi("GroupList");
export const GroupDetailSchema = z
  .object({ group: GroupSchema, members: z.array(PersonSchema) })
  .openapi("GroupDetail");
export const GroupCreateBody = z.object({
  name: trimmedText({ min: 1, max: 80 }),
  kind: GroupKindSchema.default("custom"),
});
export const GroupPatchBody = z.object({
  name: trimmedText({ min: 1, max: 80 }).optional(),
  kind: GroupKindSchema.optional(),
});
export const GroupMembersBody = z.object({ membershipIds: z.array(UuidSchema).min(1).max(500) });
export const GroupDeleteResultSchema = z
  .object({ members: z.number().int(), grants: z.number().int() })
  .openapi("GroupDeleteResult");
export const AddedCountSchema = z.object({ added: z.number().int() }).openapi("AddedCount");

// --- grants + policies ----------------------------------------------------------------------

export const GrantsQuery = z.object({
  resourceKind: ResourceKindSchema,
  resourceId: UuidSchema,
  resourcePath: LtreePathSchema.optional(),
});
export const GrantListSchema = z.object({ grants: z.array(GrantSchema) }).openapi("GrantList");

export const GrantCreateBody = z.object({
  subject: SubjectRefSchema,
  resource: ResourceRefSchema,
  capabilities: z.array(CapabilitySchema).min(1),
  effect: GrantEffectSchema.default("allow"),
  validUntil: TimestampSchema.optional(),
  note: z.string().max(500).optional(),
});
export const GrantCreateResultSchema = z
  .object({ grants: z.array(GrantSchema) })
  .openapi("GrantCreateResult");

export const PolicyTargetSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("workspace") }),
    z.object({ kind: z.literal("group"), id: UuidSchema }),
    z.object({ kind: z.literal("membership"), id: UuidSchema }),
    /**
     * A share link (E2.3). `core.policy_target_kind` gained `'link'` in
     * `core/0008_share_links.sql`, and a gate targeted at a link is how "this share link requires
     * an NDA / accreditation" is expressed: the gate is evaluated for the principal, once they
     * exist, because `PrincipalRepo` emits a `link` subject for every live `share_link_visit`.
     * Without this arm `GET /access/policies` would *serialise* a link-targeted policy into a
     * shape its own response schema rejects.
     */
    z.object({ kind: z.literal("link"), id: UuidSchema }),
    z.object({ kind: z.literal("resource"), resource: ResourceRefSchema }),
  ])
  .openapi("PolicyTarget");

export const PolicyConfigSchema = z
  .object({
    /**
     * `nda`, legacy. A gate whose config carries only `{ version: "v3" }` still resolves to the
     * stamp `nda:v3`, exactly as it did before E2.3 (contract D4). New gates name a document.
     */
    version: z.string().max(40).optional(),
    /**
     * `nda` (E2.3, D4). The `core.legal_document` the gate names. The stamp the principal must
     * hold (`<slug>:v<n>`) is resolved from the document's *current* version by
     * `PolicyRepo.listLiveGates()` at read time — which is what makes re-acceptance on version
     * change automatic — so **`stamp` is deliberately not a field here**: it is never stored and
     * never accepted from the wire. An admin who could set it would be pinning a gate to a stamp
     * that has stopped tracking the document.
     */
    documentId: UuidSchema.optional(),
    /** `accredited` */
    maxAgeDays: z.number().int().min(1).max(3650).optional(),
    /** `min_auth_level` */
    level: z.union([z.literal(1), z.literal(2)]).optional(),
    /** `ip_allowlist` */
    cidrs: z.array(CidrEntrySchema).max(200).optional(),
  })
  .strict();

export const PolicySchema = z
  .object({
    id: UuidSchema,
    kind: GateKindSchema,
    target: PolicyTargetSchema,
    config: PolicyConfigSchema,
    createdAt: TimestampSchema,
    createdBy: UuidSchema.nullable(),
  })
  .openapi("Policy");
export const PolicyListSchema = z.object({ policies: z.array(PolicySchema) }).openapi("PolicyList");
export const PolicyCreateBody = z.object({
  kind: GateKindSchema,
  target: PolicyTargetSchema,
  config: PolicyConfigSchema.default({}),
});

// --- who has access / explain ----------------------------------------------------------------

export const ResourceParams = z.object({ kind: ResourceKindSchema, id: UuidSchema });
export const ResourcePathQuery = z.object({ path: LtreePathSchema.optional() });

export const AccessViaSchema = z
  .object({
    subject: SubjectSummarySchema,
    grantId: UuidSchema,
    capability: CapabilitySchema,
    effect: GrantEffectSchema,
    resource: ResourceRefSchema,
    inherited: z.boolean(),
    decisive: z.boolean(),
    validUntil: TimestampSchema.nullable(),
  })
  .openapi("AccessVia");

export const AccessHolderSchema = z
  .object({
    membershipId: UuidSchema,
    displayName: z.string(),
    email: z.string().nullable(),
    kind: MembershipKindSchema,
    role: MembershipRoleSchema,
    capabilities: z.array(CapabilitySchema),
    pendingGates: z.array(PendingGateSchema),
    via: z.array(AccessViaSchema),
    expiresAt: TimestampSchema.nullable(),
  })
  .openapi("AccessHolder");

export const WhoHasAccessSchema = z
  .object({ resource: ResourceRefSchema, holders: z.array(AccessHolderSchema) })
  .openapi("WhoHasAccess");

export const ExplainQuery = z.object({
  membershipId: UuidSchema,
  path: LtreePathSchema.optional(),
});

export const AccessDecisionSchema = z
  .object({
    allowed: z.boolean(),
    capabilities: z.array(CapabilitySchema),
    pendingGates: z.array(PendingGateSchema),
    reason: z.enum(["granted", "no_grant", "gated", "not_member"]),
  })
  .openapi("AccessDecision");

export const AccessExplanationSchema = z
  .object({
    membershipId: UuidSchema,
    resource: ResourceRefSchema,
    decision: AccessDecisionSchema,
    rules: z.array(AccessViaSchema),
    aclVersion: z.number().int().nonnegative(),
  })
  .openapi("AccessExplanation");

// --- settings + my access -------------------------------------------------------------------

/**
 * A bare email domain (`acme.vc`) for `access.requests.autoApproveDomains`: lowercase labels,
 * at least two, no scheme/port/`@`. Mirrors `EMAIL_DOMAIN_PATTERN` in `@fundroom/domain`.
 */
export const EmailDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/u,
    "a bare domain such as example.com",
  )
  .openapi({ example: "acme.vc" });

/**
 * `access.requests` (E3.1): the public "request access" form. Replaced as a whole by
 * PATCH /access/settings; `defaultGroupIds` must name live groups of this workspace.
 */
export const AccessRequestSettingsSchema = z
  .object({
    enabled: z.boolean(),
    /** Exact match on the email's domain; never applied under Rule 506(b). */
    autoApproveDomains: z.array(EmailDomainSchema).max(50),
    /** Suggested groups for the approver, and the groups an auto-approval uses. */
    defaultGroupIds: z.array(UuidSchema).max(20),
    pendingExpiryDays: z.number().int().min(1).max(365),
  })
  .openapi("AccessRequestSettings");

export const AccessSettingsSchema = z
  .object({
    requireMfaForStaff: z.boolean(),
    requireMfaForExternal: z.boolean(),
    inviteExpiryDays: z.number().int().min(1).max(90),
    allowDelegates: z.boolean(),
    /** E3.2: live + pending delegates one principal may have. */
    maxDelegatesPerPrincipal: z.number().int().min(1).max(20),
    requests: AccessRequestSettingsSchema,
  })
  .openapi("AccessSettings");

export const AccessSettingsPatchBody = z.object({
  requireMfaForStaff: z.boolean().optional(),
  requireMfaForExternal: z.boolean().optional(),
  inviteExpiryDays: z.number().int().min(1).max(90).optional(),
  allowDelegates: z.boolean().optional(),
  maxDelegatesPerPrincipal: z.number().int().min(1).max(20).optional(),
  /** Whole-object replacement (every field required). */
  requests: AccessRequestSettingsSchema.optional(),
});

// --- delegates (E3.2) -------------------------------------------------------------------------
// Investor self-service under /access/my/delegates, admin under /access/people/{id}/delegates.
// Handlers live in `apps/server/src/routes/delegates.ts`.

/**
 * One delegate of a principal: an accepted delegate membership (`kind: member`, `id` = membership
 * id) or a pending delegate invitation (`kind: invite`, `id` = invite id). Either id is what the
 * DELETE routes take.
 */
export const DelegateSchema = z
  .object({
    kind: z.enum(["member", "invite"]),
    id: UuidSchema,
    email: z.string().nullable(),
    displayName: z.string(),
    scope: DelegateScopeSchema,
    status: z.enum(["pending", "invited", "active", "dormant", "suspended"]),
    createdAt: TimestampSchema,
    /** Invitation expiry for `invite`; membership expiry (if any) for `member`. */
    expiresAt: TimestampSchema.nullable(),
    lastSeenAt: TimestampSchema.nullable(),
  })
  .openapi("Delegate");

export const DelegateListSchema = z
  .object({
    delegates: z.array(DelegateSchema),
    /** `access.maxDelegatesPerPrincipal`. */
    limit: z.number().int().min(1),
    /** Whether the principal may add delegates themselves (`access.allowDelegates`). */
    selfService: z.boolean(),
  })
  .openapi("DelegateList");

export const DelegateCreateBody = z.object({
  email: EmailSchema,
  displayName: trimmedText({ min: 1, max: 120 }).optional(),
  scope: DelegateScopeSchema,
  message: z.string().trim().max(2000).optional(),
});

/**
 * The investor's own add: no `message` — the invitation is the company's
 * branded email, so a principal does not get to write in it (sending one is a 400).
 */
export const MyDelegateCreateBody = DelegateCreateBody.omit({ message: true });

/**
 * The answer to every self-service add: the same for an address that got an
 * invitation and for one that did not (already a member or already invited), so the route is not
 * a membership oracle. The caller's own list shows what was actually issued.
 */
export const DelegateAddAcceptedSchema = z
  .object({ status: z.literal("sent") })
  .openapi("DelegateAddAccepted");

export const MyDelegateParams = z.object({ id: UuidSchema });
export const PersonDelegateParams = z.object({ id: UuidSchema, delegateId: UuidSchema });

export const MyAccessQuery = z.object({ kind: ResourceKindSchema.optional() });
export const AccessibleResourceSchema = z
  .object({
    kind: ResourceKindSchema,
    id: UuidSchema,
    path: LtreePathSchema.nullable(),
    capabilities: z.array(CapabilitySchema),
    pendingGates: z.array(PendingGateSchema),
    expiresAt: TimestampSchema.nullable(),
  })
  .openapi("AccessibleResource");
export const MyAccessSchema = z
  .object({
    permissions: z.array(z.string()),
    resources: z.array(AccessibleResourceSchema),
  })
  .openapi("MyAccess");

export const MembershipIdParam = z.object({ id: UuidSchema, membershipId: UuidSchema });

// --- access requests (E3.1) -----------------------------------------------------------------
// The public "request access" form and the admin approval queue. Not the GDPR "access request"
// (DSAR, `compliance`). Handlers live in `apps/server/src/routes/access-requests.ts`.

export const AccessRequestStatusSchema = z
  .enum(["pending", "approved", "denied", "expired"])
  .openapi("AccessRequestStatus");

/** POST /access-requests/start (public). */
export const AccessRequestStartBody = z.object({
  email: EmailSchema,
  name: trimmedText({ min: 1, max: 120 }),
  firm: z.string().trim().max(160).optional(),
  reason: z.string().trim().max(2000).optional(),
  /** Honeypot: humans never see it and leave it empty. Anything else is a silent decoy. */
  website: z.string().max(2000).optional(),
});

export const AccessRequestChallengeSchema = z
  .object({
    /**
     * When a code mailed by this submission stops working. The same computation for every
     * well-formed submission (the instant it arrived + the code lifetime), so it reveals nothing.
     */
    expiresAt: TimestampSchema,
  })
  .openapi("AccessRequestChallenge");

/**
 * POST /access-requests/verify (public). Any unexpired code mailed to `email` for this workspace
 * is accepted (a resend is just another start; earlier codes keep working until they expire).
 */
export const AccessRequestVerifyBody = z.object({
  email: EmailSchema,
  code: z
    .string()
    .trim()
    .regex(/^[0-9]{6}$/u, "six digits"),
});

export const AccessRequestReceivedSchema = z
  .object({
    /** Always `received`: whether the request can be considered is never revealed. */
    status: z.literal("received"),
  })
  .openapi("AccessRequestReceived");

export const AccessRequestDeciderSchema = z
  .object({ membershipId: UuidSchema, displayName: z.string() })
  .openapi("AccessRequestDecider");

export const AccessRequestRelationshipSchema = z
  .object({
    source: RelationshipSourceSchema,
    establishedAt: TimestampSchema,
    note: z.string().nullable(),
  })
  .openapi("AccessRequestRelationship");

export const AccessRequestSchema = z
  .object({
    id: UuidSchema,
    email: z.string(),
    name: z.string(),
    firm: z.string().nullable(),
    reason: z.string().nullable(),
    status: AccessRequestStatusSchema,
    createdAt: TimestampSchema,
    verifiedAt: TimestampSchema.nullable(),
    expiresAt: TimestampSchema,
    suggestedGroupIds: z.array(UuidSchema),
    autoApproved: z.boolean(),
    decidedAt: TimestampSchema.nullable(),
    decidedBy: z.union([AccessRequestDeciderSchema, z.null()]),
    /** Staff-only; never mailed to the requester. */
    decisionNote: z.string().nullable(),
    relationship: z.union([AccessRequestRelationshipSchema, z.null()]),
    inviteId: UuidSchema.nullable(),
    membershipId: UuidSchema.nullable(),
  })
  .openapi("AccessRequest");

export const AccessRequestIdParams = z.object({ id: UuidSchema });

export const AccessRequestListQuery = z.object({
  status: AccessRequestStatusSchema.default("pending"),
  cursor: z
    .string()
    .max(512)
    .optional()
    .openapi({ description: "Opaque cursor from a previous page" }),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const AccessRequestPageSchema = page(AccessRequestSchema, "AccessRequestPage");

export const AccessRequestApproveBody = z.object({
  groupIds: z.array(UuidSchema).max(50).default([]),
  grants: z.array(InviteGrantBodySchema).max(50).default([]),
  expiresInDays: z.number().int().min(1).max(90).optional(),
  /** Invite message; defaults to "Your request to access {workspace} was approved." */
  message: z.string().max(2000).optional(),
  /** Internal decision note (staff-only). */
  note: z.string().trim().max(2000).optional(),
  /** Required under Rule 506(b) (`relationship_attestation_required`); optional otherwise. */
  relationship: z
    .object({
      source: RelationshipSourceSchema,
      establishedAt: TimestampSchema,
      note: z.string().trim().max(2000).optional(),
    })
    .optional(),
});

export const AccessRequestApproveResultSchema = z
  .object({
    request: AccessRequestSchema,
    invite: InviteSchema,
    /**
     * Whether the invitation email was handed to the mailer. `false` means the approval and the
     * invitation are committed but the mail failed — resend it from People → Invites.
     */
    mailSent: z.boolean(),
  })
  .openapi("AccessRequestApproveResult");

export const AccessRequestDenyBody = z.object({
  /** Internal decision note (staff-only; never in the requester's mail). */
  note: z.string().trim().max(2000).optional(),
  /** Send the neutral "not approved" mail. */
  notifyRequester: z.boolean().default(true),
});

export const AccessRequestDenyResultSchema = z
  .object({ request: AccessRequestSchema })
  .openapi("AccessRequestDenyResult");
