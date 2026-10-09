import { z } from "@hono/zod-openapi";
import { PendingAcceptanceSchema } from "./compliance.js";
import { PlanFeatureSchema, WorkspaceStatusStateSchema } from "./platform.js";
import { EmailSchema, SlugSchema, TimestampSchema, trimmedText, UuidSchema } from "./schemas.js";
import { ViewAsStateSchema } from "./view-as.js";

/*
 * Kernel route schemas (health, capability doc, modules bootstrap, auth, sessions).
 * Handlers live in apps/server; the schemas live here so the SDK, the web app and the
 * contract tests share one definition.
 */

// --- health ---------------------------------------------------------------------------------

export const HealthSchema = z
  .object({
    status: z.enum(["ok", "draining"]),
    version: z.string().openapi({ example: "0.1.0" }),
    uptimeSeconds: z.number().int().nonnegative(),
  })
  .openapi("Health");

export const ReadinessCheckSchema = z
  .object({
    name: z.enum(["database", "migrations", "storage", "mail", "queue"]),
    status: z.enum(["ok", "fail", "skipped"]),
    /** Log-safe detail; never a connection string. */
    detail: z.string().optional(),
    checkedAt: TimestampSchema,
    latencyMs: z.number().int().nonnegative().optional(),
  })
  .openapi("ReadinessCheck");

export const ReadinessSchema = z
  .object({
    status: z.enum(["ready", "not_ready", "draining"]),
    version: z.string(),
    checks: z.array(ReadinessCheckSchema),
  })
  .openapi("Readiness");

// --- capability doc (design/07 §4.1) ---------------------------------------------------------

export const CapabilityDocSchema = z
  .object({
    apiVersion: z.literal("v1"),
    serverVersion: z.string().openapi({ example: "0.1.0" }),
    /** Lowest `@fundroom/embed` version the server will talk to. */
    minEmbedSdk: z.string().openapi({ example: "0.1.0" }),
    apiBase: z.string().openapi({ example: "/api/v1" }),
    tenancy: z.enum(["single", "multi"]),
    /** Module ids compiled into this server (enablement is per workspace). */
    features: z.array(z.string()).openapi({ example: ["access", "content", "data-room"] }),
    auth: z.object({
      methods: z.array(z.enum(["email_otp", "magic_link", "passkey", "password", "oidc"])),
      passkeyRpId: z.string().openapi({ example: "investors.example.com" }),
    }),
  })
  .openapi("CapabilityDoc");

// --- modules bootstrap (§5.3) --------------------------------------------------------------

export const NavItemSchema = z
  .object({
    id: z.string(),
    label: z.string(),
    to: z.string(),
    order: z.number().int(),
    icon: z.string().optional(),
  })
  .openapi("NavItem");

export const ModuleDescriptorSchema = z
  .object({
    id: z.string().openapi({ example: "data-room" }),
    version: z.string().openapi({ example: "1.0.0" }),
    enabled: z.boolean(),
    /** Hidden for this workspace's offering status (ADR-0019); `enabled` is still reported. */
    hidden: z.boolean(),
    /**
     * A-3 (ADR-0063): on but outside the workspace's plan, so read-only for staff (writes answer
     * 402 `plan_limit`); investors are unaffected. False whenever nothing is enforced.
     */
    readOnly: z.boolean(),
    flags: z.record(z.string(), z.boolean()),
    slots: z.record(z.string(), z.array(z.unknown())),
  })
  .openapi("ModuleDescriptor");

export const ModulesBootstrapSchema = z
  .object({
    workspace: z
      .object({
        id: UuidSchema,
        slug: SlugSchema,
        name: z.string(),
        offeringStatus: z.enum(["none", "informational", "506b", "506c", "non_us"]),
        defaultLocale: z.string().openapi({
          description:
            "The workspace's default UI/email language; a user's own choice (`Session.user.locale`) wins",
          example: "en",
        }),
      })
      .nullable(),
    /**
     * Whether the `en-XA` pseudo-locale may be offered in the language switch (E2.8,
     * `I18N_PSEUDO_LOCALE`); development builds offer it regardless.
     */
    pseudoLocale: z.boolean(),
    modules: z.array(ModuleDescriptorSchema),
    /** Capabilities of the caller in this workspace; empty when signed out or not a member. */
    permissions: z.array(z.string()),
    membership: z
      .object({
        id: UuidSchema,
        kind: z.enum(["staff", "external"]),
        role: z.string(),
      })
      .nullable(),
    /**
     * Legal documents this caller must accept before the portal serves them anything else
     * (E1.6, §13.1). Carried here, bodies and all, so the SPA can put the interstitial up
     * without a second round trip — it is paid exactly once, by a member who is blocked from
     * everything else until they answer. Always empty for staff and for anonymous callers.
     */
    pendingAcceptances: z.array(PendingAcceptanceSchema),
    /**
     * Set while a staff session is viewing this workspace as an investor (E2.7): `membership`,
     * `permissions` and everything else above are then the investor's, and the SPA shows the
     * banner with "Exit view". Null otherwise.
     */
    viewAs: z.union([ViewAsStateSchema, z.null()]),
    /**
     * Whether this workspace takes public access requests (E3.1, `access.requests.enabled`), so
     * the sign-in page can offer "Request access". False without a workspace.
     */
    requestAccessEnabled: z.boolean(),
    /**
     * Whether the caller can see at least one enabled booking link (E3.6), so the portal can show
     * the "Book time" card without a second round trip. False when signed out or not a member.
     */
    bookingLinksAvailable: z.boolean(),
    /**
     * E3.8: the caller is a staff member here, but this workspace requires single sign-on and
     * their session did not come from its SSO connection — `membership` is null and every member
     * route answers 403 `sso_required` until they sign in through the IdP. False otherwise.
     */
    ssoRequired: z.boolean(),
    /**
     * E3.8 break-glass: with `ssoRequired`, the member is an owner, who is admitted after a
     * step-up to auth level 2 (TOTP or passkey) without SSO. False otherwise.
     */
    ssoBreakGlass: z.boolean(),
    /**
     * E3.10: set while the workspace is not `active` (suspended, or held for review) — the admin
     * shell shows the banner, an investor the "portal unavailable" screen. Null when active or
     * without a workspace.
     */
    workspaceStatus: z.union([WorkspaceStatusStateSchema, z.null()]),
    /**
     * A-3 (ADR-0063): what the workspace's plan lets staff turn on — `null` = all (no restriction,
     * no plan, or CONTROL_PLANE=off). Present only for a staff principal, so the plan is never
     * disclosed to investors or anonymous callers.
     */
    entitlements: z
      .object({
        modules: z.union([z.array(z.string()), z.null()]),
        features: z.union([z.array(PlanFeatureSchema), z.null()]),
      })
      .optional(),
  })
  .openapi("ModulesBootstrap");

// --- auth ------------------------------------------------------------------------------------

const rememberDevice = z
  .boolean()
  .default(false)
  .openapi({ description: "Trust this device for 30 days" });

export const OtpStartBody = z.object({ email: EmailSchema });
export const OtpStartResponse = z
  .object({
    status: z.literal("sent"),
    emailHint: z.string().openapi({ example: "a***@example.com" }),
    ttlMinutes: z.number().int(),
  })
  .openapi("OtpStart");

export const OtpVerifyBody = z.object({
  email: EmailSchema,
  code: z.string().min(4).max(12).openapi({ example: "123456" }),
  rememberDevice,
});

export const MagicLinkStartBody = z.object({ email: EmailSchema });
export const MagicLinkStartResponse = OtpStartResponse.openapi("MagicLinkStart");
export const MagicLinkPeekQuery = z.object({ token: z.string().min(16).max(256) });
export const MagicLinkPeekResponse = z
  .object({
    valid: z.boolean(),
    emailHint: z.string().optional(),
    requestedFrom: z.string().optional(),
  })
  .openapi("MagicLinkPeek");
export const MagicLinkConfirmBody = z.object({
  token: z.string().min(16).max(256),
  rememberDevice,
});

export const MembershipSummarySchema = z
  .object({
    id: UuidSchema,
    kind: z.enum(["staff", "external"]),
    role: z.string(),
    status: z.string(),
  })
  .openapi("MembershipSummary");

export const SessionSchema = z
  .object({
    sessionId: UuidSchema,
    userId: UuidSchema,
    population: z.enum(["external", "staff", "operator"]),
    context: z.enum(["first_party", "partitioned", "bearer"]),
    authLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    authTime: TimestampSchema,
    createdAt: TimestampSchema,
    idleExpiresAt: TimestampSchema,
    absoluteExpiresAt: TimestampSchema,
    user: z.object({
      displayName: z.string(),
      mfaEnrolled: z.boolean(),
      locale: z.string().nullable().openapi({
        description:
          "The user's chosen UI/email language, e.g. `en`; null when they have not chosen (the workspace default applies)",
        example: "en",
      }),
    }),
    /**
     * E3.8: set when this session was established through a workspace's SSO connection. It then
     * serves that workspace only and cannot change the global account (403
     * `sso_session_restricted` on factors, password, other sessions/devices, own settings).
     */
    sso: z
      .object({ workspaceId: UuidSchema, connectionId: UuidSchema })
      .nullable()
      .openapi({ description: "The SSO connection that minted this session; null otherwise" }),
    /**
     * E3.10: set when a central-auth handoff minted this session on a workspace host. It then
     * serves that workspace only and cannot change the global account (403
     * `bound_session_restricted`); account changes happen on the canonical host.
     */
    boundWorkspaceId: UuidSchema.nullable().optional().openapi({
      description:
        "The workspace a central-auth handoff bound this session to; null (or absent) otherwise",
    }),
  })
  .openapi("Session");

export const LoginResponse = z
  .object({
    session: SessionSchema,
    isNewDevice: z.boolean(),
    isNewUser: z.boolean(),
    membership: z.union([MembershipSummarySchema, z.null()]),
  })
  .openapi("Login");

export const PasskeyRegistrationBegin = z
  .object({ challengeId: UuidSchema, options: z.record(z.string(), z.unknown()) })
  .openapi("PasskeyRegistrationBegin");
export const PasskeyRegistrationFinishBody = z.object({
  challengeId: UuidSchema,
  response: z.record(z.string(), z.unknown()),
  label: z.string().max(80).optional(),
});
export const PasskeySummarySchema = z
  .object({
    id: UuidSchema,
    label: z.string(),
    createdAt: TimestampSchema,
    lastUsedAt: TimestampSchema.nullable(),
    backedUp: z.boolean(),
    transports: z.array(z.string()),
  })
  .openapi("Passkey");
/**
 * `POST /auth/passkeys/register/finish` (E-UP-18): the new passkey plus the session's auth level
 * after the call — 2 when the authenticator verified the user (the session was stepped up and its
 * cookie rotated), else the session's unchanged level.
 */
export const PasskeyRegisteredSchema = PasskeySummarySchema.extend({
  authLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]),
}).openapi("PasskeyRegistered");
export const PasskeyAuthenticationBegin = z
  .object({ challengeId: UuidSchema, options: z.record(z.string(), z.unknown()) })
  .openapi("PasskeyAuthenticationBegin");
export const PasskeyAuthenticationFinishBody = z.object({
  challengeId: UuidSchema,
  response: z.record(z.string(), z.unknown()),
  rememberDevice,
});
export const PasskeyRenameBody = z.object({ label: z.string().min(1).max(80) });

export const TotpEnrolmentSchema = z
  .object({
    credentialId: UuidSchema,
    secretBase32: z.string(),
    otpauthUri: z.string(),
  })
  .openapi("TotpEnrolment");
export const TotpCodeBody = z.object({ code: z.string().min(6).max(12) });
export const RecoveryCodesSchema = z
  .object({ recoveryCodes: z.array(z.string()) })
  .openapi("RecoveryCodes");
export const RecoveryCodeBody = z.object({ code: z.string().min(8).max(32) });
export const RecoveryRemainingSchema = z
  .object({ remaining: z.number().int() })
  .openapi("RecoveryRemaining");
export const TotpStatusSchema = z
  .object({ enrolled: z.boolean(), pending: z.boolean(), recoveryCodesLeft: z.number().int() })
  .openapi("TotpStatus");

export const PasswordLoginBody = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(256),
  rememberDevice,
});
/**
 * `currentPassword` is required when the account already has a password (F-20, ASVS 6.2.3): a
 * fresh proof from another factor is not enough to replace it. Ignored when none is set yet.
 */
export const PasswordSetBody = z.object({
  password: z.string().min(1).max(256),
  currentPassword: z.string().min(1).max(256).optional(),
});
export const PasswordReverifyBody = z.object({ password: z.string().min(1).max(256) });
/** `DELETE /auth/password` (E2.10 R1-01): the current password, unless the session is level 2. */
export const PasswordRemoveBody = z.object({
  currentPassword: z.string().min(1).max(256).optional(),
});
export const PasswordStatusSchema = z
  .object({ enabled: z.boolean(), set: z.boolean() })
  .openapi("PasswordStatus");

export const OidcBeginQuery = z.object({
  provider: z.string().regex(/^[a-z][a-z0-9-]*$/u),
  returnTo: z
    .string()
    .max(2048)
    .optional()
    .openapi({ description: "Same-origin path to return to" }),
});
export const OidcBeginResponse = z.object({ url: z.url() }).openapi("OidcBegin");
export const OidcProvidersSchema = z
  .object({ providers: z.array(z.object({ id: z.string() })) })
  .openapi("OidcProviders");

export const SessionSummarySchema = z
  .object({
    id: UuidSchema,
    deviceId: UuidSchema.nullable(),
    deviceName: z.string(),
    device: z.string(),
    ip: z.string().nullable(),
    createdAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
    authLevel: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    context: z.enum(["first_party", "partitioned", "bearer"]),
    current: z.boolean(),
  })
  .openapi("SessionSummary");
export const SessionListSchema = z
  .object({ sessions: z.array(SessionSummarySchema) })
  .openapi("SessionList");

export const DeviceSummarySchema = z
  .object({
    id: UuidSchema,
    name: z.string(),
    device: z.string(),
    firstSeenAt: TimestampSchema,
    lastSeenAt: TimestampSchema,
    trusted: z.boolean(),
  })
  .openapi("DeviceSummary");
export const DeviceListSchema = z
  .object({ devices: z.array(DeviceSummarySchema) })
  .openapi("DeviceList");
export const DeviceRenameBody = z.object({ name: z.string().min(1).max(80) });
export const RevokeByTokenBody = z.object({ token: z.string().min(16).max(256) });
export const RevokedCountSchema = z.object({ revoked: z.number().int() }).openapi("RevokedCount");

export const MeSchema = z
  .object({
    session: SessionSchema,
    membership: z.union([MembershipSummarySchema, z.null()]),
    workspaces: z.array(
      z.object({
        workspaceId: UuidSchema,
        membershipId: UuidSchema,
        kind: z.enum(["staff", "external"]),
        role: z.string(),
        status: z.string(),
      }),
    ),
    /** The view-as-investor state applied to this request (E2.7); null when none. */
    viewAs: z.union([ViewAsStateSchema, z.null()]),
  })
  .openapi("Me");

export const InviteLandingSchema = z
  .object({
    valid: z.boolean(),
    emailHint: z.string().optional(),
    kind: z.enum(["staff", "external"]).optional(),
    expiresAt: TimestampSchema.optional(),
  })
  .openapi("InviteLanding");

// --- first-run setup (E0.8, ADR-0018) ---------------------------------------------------------

export const SetupStatusSchema = z
  .object({
    /**
     * True until the first workspace and its owner exist. The only field every caller gets
     * (E2.10 ZAP-04): the rest is for a signed-in staff owner/admin, and the instance facts
     * below (`tenancy` … `tokenSource`) also for anyone while setup is still required.
     */
    required: z.boolean(),
    tenancy: z.enum(["single", "multi"]).optional(),
    instanceName: z.string().optional(),
    baseUrl: z.url().optional(),
    /** Which second factors the wizard can offer for the owner. */
    passwordEnabled: z.boolean().optional(),
    /** Staff owner/admin only. */
    drivers: z.object({ storage: z.string(), mail: z.string() }).optional(),
    /** Where the setup token came from; `env` means SETUP_TOKEN, else the logs (and DATA_DIR). */
    tokenSource: z.enum(["env", "file", "generated"]).optional(),
    /** Probe outcomes remembered by this process (`/readyz` primes on success). Staff owner/admin only. */
    probes: z
      .object({
        mail: z.enum(["pending", "passed"]),
        storage: z.enum(["pending", "passed"]),
      })
      .optional(),
    /**
     * Which wizard steps are already done (E1.7). **Kernel-owned facts only**: the owner and
     * the workspace, the two probes, whether a brand has been chosen and whether the offering
     * has been set. Data-room, invitation and update progress are deliberately absent — they
     * are module facts, and the kernel reading a module's tables is the boundary violation
     * ADR-0033 exists to prevent (E1.6 learned this the expensive way). A module step reports
     * its own completion from the client, which already has that module's data in hand.
     *
     * Everything is false before a workspace exists: the wizard is then asking for the very
     * first fact, and a progress bar that guessed would be guessing about nothing.
     * Staff owner/admin only; absent means "start at the token step".
     */
    progress: z
      .object({
        /** The first workspace and its owner exist (i.e. `required` is false). */
        owner: z.boolean(),
        mail: z.boolean(),
        storage: z.boolean(),
        /** An accent colour or a logo has been set. */
        branding: z.boolean(),
        /** The offering status has been visited or changed, so a period exists. */
        offering: z.boolean(),
      })
      .optional(),
  })
  .openapi("SetupStatus");

export const SetupTokenBody = z.object({ token: z.string().min(16).max(256) });

export const SetupOwnerBody = z.object({
  token: z.string().min(16).max(256),
  email: EmailSchema,
  displayName: trimmedText({ min: 1, max: 120 }),
  workspaceName: trimmedText({ min: 1, max: 120 }).openapi({ example: "Acme Inc." }),
  /** Defaults to a slug derived from the name. */
  workspaceSlug: SlugSchema.optional(),
});

export const WorkspaceSummarySchema = z
  .object({ id: UuidSchema, slug: SlugSchema, name: z.string() })
  .openapi("WorkspaceSummary");

// A fresh object rather than `LoginResponse.extend()`: registered component metadata must not
// leak onto a derived schema (see the E0.7 `MembershipSummary` note).
export const SetupOwnerResponse = z
  .object({
    session: SessionSchema,
    isNewDevice: z.boolean(),
    isNewUser: z.boolean(),
    membership: z.union([MembershipSummarySchema, z.null()]),
    workspace: WorkspaceSummarySchema,
  })
  .openapi("SetupOwner");

export const SetupMailProbeBody = z.object({
  /** Defaults to the signed-in owner's email. */
  to: EmailSchema.optional(),
});

export const SetupProbeResultSchema = z
  .object({
    ok: z.literal(true),
    driver: z.string(),
    latencyMs: z.number().int().nonnegative(),
    /** Mail: the provider message id. Storage: the probe key that was written and removed. */
    detail: z.string().optional(),
  })
  .openapi("SetupProbeResult");

export const IdParam = z.object({ id: UuidSchema });
export const TokenParam = z.object({ token: z.string().min(16).max(256) });
