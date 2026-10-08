import { z } from "zod";
import { EmbedSettingsSchema } from "../embed/embed-origins.js";

/*
 * `core.workspace.settings` (jsonb, `settings_schema_version` 1). Every reader parses through
 * this schema so an older row (missing keys) and a hand-edited one (unknown keys) both come
 * out as a complete, typed object. Keys are grouped by the epic that owns them; E1.1 owns
 * `access`.
 */
export const WORKSPACE_SETTINGS_SCHEMA_VERSION = 1;

/**
 * A bare, lowercase DNS name (an email address's domain): labels of 1–63 letters, digits and
 * hyphens, at least two labels, a 2+ character TLD. Input is trimmed and lowercased first.
 */
export const EMAIL_DOMAIN_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/u;

/**
 * E3.1 `access.requests`: the public "request access" form (off by default). PATCH
 * /access/settings replaces this block as a whole.
 */
export const AccessRequestSettingsSchema = z
  .object({
    /** Show the public form and the login page's "Request access" link. */
    enabled: z.boolean().default(false),
    /**
     * Verified requests whose email domain is exactly one of these are approved at once (never
     * under 506(b): `permits(status).requestAutoApprove`).
     */
    autoApproveDomains: z
      .array(z.string().trim().toLowerCase().regex(EMAIL_DOMAIN_PATTERN))
      .max(50)
      .default([]),
    /** Groups suggested to the approver (and used by auto-approval). */
    defaultGroupIds: z.array(z.string().uuid()).max(20).default([]),
    /** Days a verified request waits in the queue before the sweeper expires it. */
    pendingExpiryDays: z.number().int().min(1).max(365).default(30),
  })
  .prefault({});

export const AccessSettingsSchema = z
  .object({
    /** Owners and admins always need an MFA-grade session (§6.2); this extends it to every staff role. */
    requireMfaForStaff: z.boolean().default(false),
    /** External members (investors, delegates) must hold an MFA-grade session. */
    requireMfaForExternal: z.boolean().default(false),
    /** Default validity of an invitation. */
    inviteExpiryDays: z.number().int().min(1).max(90).default(7),
    /**
     * Investors may add their own delegates (design/05 §5, E3.2). Admins can always add one from
     * the People screen, whatever this says.
     */
    allowDelegates: z.boolean().default(false),
    /** Most delegates one principal may have, live and pending invitations together (E3.2). */
    maxDelegatesPerPrincipal: z.number().int().min(1).max(20).default(3),
    /** E3.1: the public "request access" form and its approval queue. */
    requests: AccessRequestSettingsSchema,
  })
  .prefault({});

/** E1.2 owns `content`. */
export const ContentSettingsSchema = z
  .object({
    /**
     * Whether a section of a content page may be `public` (visible signed-out). Off by default:
     * the general-solicitation guard lives in the data model (design/06 §8, ADR-0019).
     */
    allowPublicSections: z.boolean().default(false),
  })
  .prefault({});

/**
 * E3.3 `dataRoom.qa`: data-room Q&A (design/03 B5). Off by default ("Off by default: … Q&A"):
 * while off, investor-facing Q&A routes answer 404 (except `GET /data-room/qa/status`); staff
 * routes work regardless so an inbox can be prepared or imported before it is switched on.
 */
export const DataRoomQaSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Four-eyes: a submitted answer needs an approver other than its author before release. */
    requireApproval: z.boolean().default(false),
    /** Hours from the question being asked to its due time. */
    slaHours: z.number().int().min(1).max(720).default(72),
    /** Hours before `due_at` the due-soon reminder fires; 0 = no due-soon reminder. */
    reminderLeadHours: z.number().int().min(0).max(168).default(24),
    /** The release visibility the staff screen proposes. */
    defaultVisibility: z.enum(["asker", "target"]).default("asker"),
    /** Investors may ask about a folder, not only a document. */
    allowFolderQuestions: z.boolean().default(true),
    /** Most unanswered (open / assigned / awaiting approval) questions one investor may have. */
    maxOpenPerAsker: z.number().int().min(1).max(500).default(25),
  })
  .prefault({});

/** E1.3 owns `dataRoom`. */
export const DataRoomSettingsSchema = z
  .object({
    /** Default `protection.watermark` for new documents. */
    watermarkByDefault: z.boolean().default(true),
    /** Default `protection.download` for new documents (investors may download a watermarked copy). */
    downloadByDefault: z.boolean().default(false),
    /** E3.13: default `protection.forensic` (invisible per-recipient mark) for new documents. */
    forensicByDefault: z.boolean().default(false),
    /** Serve blobs the scanner marked `skipped` (AV_DRIVER=noop). Off: they stay unservable until scanned. */
    allowUnscanned: z.boolean().default(false),
    /** Days a deleted document or folder stays in the recycle bin before the purge job removes it. */
    purgeAfterDays: z.number().int().min(1).max(365).default(30),
    /** Largest upload this workspace accepts (bytes); capped by `UPLOAD_MAX_BYTES`. */
    maxUploadBytes: z.number().int().min(1_048_576).nullable().default(null),
    /** E3.3: data-room Q&A. */
    qa: DataRoomQaSettingsSchema,
  })
  .prefault({});

/** E1.4 owns `updates`. */
export const UpdatesSettingsSchema = z
  .object({
    /** Display name on update emails; the workspace name when null. */
    fromName: z.string().trim().min(1).max(120).nullable().default(null),
    /** Local part of the sender address once a sending domain is verified (`updates@<domain>`). */
    fromLocalPart: z
      .string()
      .trim()
      .regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u)
      .default("updates"),
    /** Where replies to update emails go; the author's address when null. */
    replyTo: z.email().nullable().default(null),
    /** Sender identification in the footer (CAN-SPAM / PECR / CASL, design/04 §2). */
    postalAddress: z.string().trim().min(1).max(300).nullable().default(null),
    /** Free text under every update (confidentiality legend, disclaimer). */
    footerNote: z.string().trim().min(1).max(1000).nullable().default(null),
  })
  .prefault({});

/** E1.5 owns `analytics` (design/04 §2 analytics modes, design/06 §6 privacy). */
export const AnalyticsSettingsSchema = z
  .object({
    /**
     * `off`: nothing is written to `analytics.*` (audit is unaffected). `essential`: server-side
     * access facts only (views, downloads, update opens) — strictly-necessary logging.
     * `engagement`: adds page-dwell heartbeats from the viewer, and only for members whose
     * consent `legal.consentMode` requires (E1.6/R13).
     *
     * The default is `essential`: E1.5 shipped `engagement`, which is defensible for a US-first
     * launch and wrong for an EU tenant that has not been asked. A workspace that wants dwell
     * turns it on deliberately, and the consent mode then decides who it applies to.
     */
    mode: z.enum(["off", "essential", "engagement"]).default("essential"),
    /** Months of raw `analytics.event` partitions to keep; rollups are kept indefinitely. */
    retentionMonths: z.number().int().min(1).max(120).default(13),
    /**
     * The hot list's scoring window (E2.6): engagement older than this many days does not count
     * towards a member's score, however heavy it was.
     */
    hotListWindowDays: z.number().int().min(1).max(90).default(14),
    /**
     * Score (0–100) at which a member becomes a hot lead and staff who asked for
     * `analytics.hot_lead` alerts hear about it. `null` turns the alert off; the list still ranks.
     */
    hotLeadThreshold: z.number().int().min(1).max(100).nullable().default(60),
  })
  .prefault({});

/**
 * E2.4 owns `metrics` (design/06 §7, EXECUTION_PLAN §15 E2.4).
 *
 * Two defaults and nothing else, and the shortness is the design. Almost everything a KPI
 * module could make configurable belongs on the *definition* instead — unit, decimals,
 * aggregation, direction and audience are all per metric, because two metrics in one
 * workspace legitimately disagree about every one of them. What is left is what a workspace
 * genuinely shares: the currency its money metrics are in, and the period an admin is about to
 * type numbers into. Both exist only so the "new metric" form opens on the right answer.
 *
 * The module's own `settingsSchema` on the manifest is deliberately not used for this. That
 * field stores per-workspace config in `core.module_enablement.config`, is declared nowhere in
 * the product, and would put half of a workspace's settings in a second table with a second
 * cache and a second audit shape. A slice of `core.workspace.settings` is how every other
 * module does it (`analytics`, `updates`, `dataRoom`).
 */
export const MetricsSettingsSchema = z
  .object({
    /**
     * ISO 4217, uppercase. A default rather than a constraint: a definition stores its own
     * currency, so a workspace reporting in both USD and EUR is expressible — this only says
     * which one the form offers first. The column enforces the same shape
     * (`definition_currency_format`), and the code list is not validated here because
     * shipping a 180-entry enum in the domain package to catch a typo in a settings form is
     * the wrong trade.
     */
    defaultCurrency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/u)
      .default("USD"),
    /**
     * The period a new definition is created with. `custom` is absent on purpose: a custom
     * period is a pair of dates the caller supplies, so there is nothing for a default to say.
     * The literals are repeated rather than imported from `@fundroom/module-metrics` because
     * `packages/domain` depends on no other workspace package (dependency-cruiser
     * `domain-has-no-io`); the module's `PERIOD_KINDS` is the list of record.
     */
    defaultPeriodKind: z.enum(["month", "quarter", "year"]).default("month"),
  })
  .prefault({});

/**
 * Where a subscription-agreement template field gets its value (E3.5 §3): a fact of the
 * commitment, its investor, the round or the workspace, resolved when the envelope is created.
 */
export const ROUND_CLOSING_PREFILL_SOURCES = [
  "investor_name",
  "investor_email",
  "amount",
  "round_name",
  "company_name",
  "valuation_cap",
  "date",
] as const;
export type RoundClosingPrefillSource = (typeof ROUND_CLOSING_PREFILL_SOURCES)[number];

/**
 * `round.closing` (E3.5): the vendor-side subscription template (`null` = not set up, and
 * "send for signature" refuses), the template's signer role and the prefill map from vendor
 * field name to source.
 */
export const RoundClosingSettingsSchema = z
  .object({
    subscriptionTemplateRef: z.string().trim().min(1).max(200).nullable().default(null),
    /**
     * The role name the template gives the investor (E3.5 fix C3). DocuSign and multi-role
     * DocuSeal templates match the signer by it; "Signer" is what the kernel sent before this
     * setting existed, so a template built with that role keeps working unchanged.
     */
    templateRole: z.string().trim().min(1).max(100).default("Signer"),
    prefill: z
      .record(z.string().trim().min(1).max(100), z.enum(ROUND_CLOSING_PREFILL_SOURCES))
      .refine((m) => Object.keys(m).length <= 50, "at most 50 prefill fields")
      .default({}),
  })
  .prefault({});

/**
 * Accreditation re-verification (E3.7, ADR-0055). The round lifecycle job sends ONE reminder per
 * verified accreditation `reminderDays` before it expires and, when `autoStart` is on and the
 * workspace has a vendor connection, opens the renewal with the vendor at the same time.
 */
export const RoundReverificationSettingsSchema = z
  .object({
    reminderDays: z.number().int().min(1).max(60).default(14),
    autoStart: z.boolean().default(false),
  })
  .prefault({});

/**
 * Round settings (E2.5). Two fields, and what is *not* here is the point: the target, the
 * currency, the minimum and `showProgress` all live on `round.round`, because a workspace can
 * run a bridge in EUR after a seed in USD and a workspace-level answer would be wrong for one of
 * them. What is left is the pair a round cannot carry — the retention clock for accreditation
 * evidence, which is an operator policy applied by a nightly job across every round, and the
 * currency the "new round" form opens on, which is the same kind of answer as
 * `metrics.defaultCurrency` and is there for the same reason.
 */
export const RoundSettingsSchema = z
  .object({
    /**
     * How long an accreditation verification's uploaded evidence is kept after the decision
     * (design/04 §1.6; the purge job reads this). Ninety days by default: long enough that a
     * decision can be re-examined while the round is still open, short enough that a tax return
     * is not sitting in object storage for the six years the *decision* has to be kept. The
     * decision, its method and its evidence reference survive the purge; the file does not.
     */
    evidenceRetentionDays: z.number().int().min(1).max(3650).default(90),
    /** ISO 4217, uppercase. What the "new round" form offers first, never a constraint. */
    defaultCurrency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/u)
      .default("USD"),
    /** Closing workflow (E3.5, ADR-0053): the subscription agreement sent for e-signature. */
    closing: RoundClosingSettingsSchema,
    /** Accreditation re-verification (E3.7, ADR-0055). */
    reverification: RoundReverificationSettingsSchema,
  })
  .prefault({});

/** Bundled font stacks; values live in `@fundroom/branding` (this package stays string-only). */
export const BRAND_FONTS = ["system", "humanist", "geometric", "serif", "slab", "mono"] as const;
export const BRAND_RADII = ["sharp", "soft", "round"] as const;
/** Image types the logo pipeline accepts; SVG is excluded because it is a script carrier. */
export const BRAND_LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

/** Provenance of the stored logo object; `key` is an `ObjectStoragePort` key, not a filename. */
export const BrandLogoSchema = z.object({
  key: z.string().min(1).max(400),
  contentType: z.enum(BRAND_LOGO_TYPES),
  width: z.number().int().positive().max(8192),
  height: z.number().int().positive().max(8192),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  /** Where it came from, for the audit trail: an upload or a pull from the company website. */
  source: z.enum(["upload", "website"]).default("upload"),
  updatedAt: z.iso.datetime(),
});

/** E1.6 owns `legal` (design/04 §1.6 + §3.2, ADR-0019, ADR-0037). */
export const LegalSettingsSchema = z
  .object({
    /**
     * How consent for optional tracking is obtained (design/04 §3.2, R13). `opt_in` is the EU
     * rule and the safe default: engagement analytics record nothing for a member who has not
     * said yes. `opt_out` (UK-style) records until the member objects. `notice_only` (US) tells
     * them what happens and honours Global Privacy Control. GPC is honoured in every mode.
     */
    consentMode: z.enum(["opt_in", "opt_out", "notice_only"]).default("opt_in"),
    /**
     * Which privacy regime the workspace's investors are mostly under (E2.6 "consent tiers by
     * region"). Deliberately separate from `core.workspace.data_region`, which says where the
     * bytes live, not whose law applies to the people. Choosing a region *suggests* a consent
     * mode (`regionConsentDefault` in `@fundroom/compliance`: EU opt-in, UK opt-out, US notice)
     * and the compliance settings route applies the suggestion when no mode is sent with it; it
     * never silently rewrites a mode an admin chose. `null` = not said, and the strict default
     * (`opt_in`) stands.
     */
    privacyRegion: z.enum(["eu", "uk", "us", "other"]).nullable().default(null),
    /**
     * Legal hold (design/04 §3.2 erasure exception (a)). While on, DSAR erasure requests are
     * refused with `legal_hold` and analytics retention stops deleting raw events.
     */
    legalHold: z.boolean().default(false),
    /**
     * Members must accept the current version of every `requiresAcceptance` legal document
     * before the portal serves them anything else (§13.1). Turning this off does not delete
     * the acceptances already recorded.
     */
    enforceAcceptance: z.boolean().default(true),
    /**
     * Rule 506(b) wants evidence that the relationship pre-dates the offer (design/04 §1.6).
     * Granting access within this many days of the recorded relationship date, or with no
     * recorded source at all, raises a warning on the person — it never blocks (R5).
     */
    relationshipWarningDays: z.number().int().min(0).max(365).default(30),
    /** Slug of the legal document stamped onto updates and page revisions at publish; none when null. */
    defaultDisclaimerSlug: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9-]{0,62}$/u)
      .nullable()
      .default(null),
  })
  .prefault({});

/**
 * E1.7 owns `branding` (EXECUTION_PLAN §12 "branding basics", design/03 F1, design/08 §4).
 *
 * Deliberately a *small* set of inputs rather than a free-form theme document: the portal's
 * `--sh-*` tokens are DERIVED from these by `@fundroom/branding` so contrast is guaranteed
 * in both palettes. Letting a workspace post an arbitrary token map would let it set the
 * foreground to the background and make its own portal unreadable, and would strand every
 * stored theme the next time the default token set changes.
 */
export const BrandingSettingsSchema = z
  .object({
    /** Portal and email display name; null means `core.workspace.name`. */
    displayName: z.string().trim().max(80).nullable().default(null),
    /** One line under the name on the investor home and in the email header. */
    tagline: z.string().trim().max(160).nullable().default(null),
    /**
     * The single colour a workspace picks. Every other brand token is derived from it, each
     * palette separately, so a colour that is legible on white is lightened for the dark
     * palette instead of being reused there. null keeps the default blue.
     */
    accentColor: z
      .string()
      .trim()
      .regex(/^#[0-9a-fA-F]{6}$/u)
      .nullable()
      .default(null),
    /**
     * A choice from bundled stacks, never an uploaded or CDN font: the app CSP allows no
     * external font origin, and self-hosting a customer's licensed font needs an upload
     * pipeline and a licence story that E1.7 does not own.
     */
    fontFamily: z.enum(BRAND_FONTS).default("system"),
    radius: z.enum(BRAND_RADII).default("soft"),
    /**
     * Stored in object storage under `ws/<workspace>/branding/<sha256>` and served from our
     * own origin, never hot-linked: an `<img>` pointing at the customer's marketing site
     * would leak every portal and email open to that host, and would break when they redesign.
     */
    logo: BrandLogoSchema.nullable().default(null),
    /** Shown in the email footer and on the portal's help affordances. */
    supportEmail: z.email().nullable().default(null),
    /** Founders on a paid managed plan may turn the attribution line off; self-hosters may too. */
    showPoweredBy: z.boolean().default(true),
  })
  .prefault({});

/**
 * E2.6 owns `notify` (design/03 C2). Per-member choices (cadence, digest time, quiet hours) live
 * on `notify.member_settings`; this block holds only what a workspace shares.
 */
export const NotifySettingsSchema = z
  .object({
    /** Days an in-app notification is kept after it was created; older rows are deleted nightly. */
    retentionDays: z.number().int().min(7).max(3650).default(180),
  })
  .prefault({});

/**
 * E3.12 owns `ai` (AI assist, ADR-0060). Off by default, per-feature switches, an optional lower
 * monthly token budget (null = the operator's AI_MONTHLY_TOKEN_BUDGET), and the acknowledgement an
 * `ai.manage` holder gave for ONE provider identity (`aiProviderKey(info)` in `@fundroom/ai`):
 * when the operator changes the provider the key no longer matches and every feature is
 * effectively off until someone acknowledges again.
 */
export const AI_HOSTINGS = ["self_hosted", "third_party"] as const;
export const AiAcknowledgementSchema = z.object({
  providerKey: z.string().max(400),
  hosting: z.enum(AI_HOSTINGS),
  at: z.iso.datetime(),
  byMembershipId: z.uuid(),
});
export const AiSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    features: z
      .object({
        updateDraft: z.boolean().default(false),
        qaAnswer: z.boolean().default(false),
      })
      .prefault({}),
    /** A workspace cap below the operator's; never above it (the PUT route refuses that). */
    monthlyTokenBudget: z.number().int().min(1000).nullable().default(null),
    acknowledgement: AiAcknowledgementSchema.nullable().default(null),
  })
  .prefault({});

export const WorkspaceSettingsSchema = z
  .object({
    access: AccessSettingsSchema,
    content: ContentSettingsSchema,
    dataRoom: DataRoomSettingsSchema,
    updates: UpdatesSettingsSchema,
    analytics: AnalyticsSettingsSchema,
    notify: NotifySettingsSchema,
    metrics: MetricsSettingsSchema,
    round: RoundSettingsSchema,
    legal: LegalSettingsSchema,
    branding: BrandingSettingsSchema,
    embed: EmbedSettingsSchema,
    ai: AiSettingsSchema,
  })
  .loose();

export type AccessSettings = z.output<typeof AccessSettingsSchema>;
export type AccessRequestSettings = z.output<typeof AccessRequestSettingsSchema>;
export type ContentSettings = z.output<typeof ContentSettingsSchema>;
export type DataRoomSettings = z.output<typeof DataRoomSettingsSchema>;
export type DataRoomQaSettings = z.output<typeof DataRoomQaSettingsSchema>;
export type UpdatesSettings = z.output<typeof UpdatesSettingsSchema>;
export type AnalyticsSettings = z.output<typeof AnalyticsSettingsSchema>;
export type NotifySettings = z.output<typeof NotifySettingsSchema>;
export type MetricsSettings = z.output<typeof MetricsSettingsSchema>;
export type RoundSettings = z.output<typeof RoundSettingsSchema>;
export type RoundClosingSettings = z.output<typeof RoundClosingSettingsSchema>;
export type RoundReverificationSettings = z.output<typeof RoundReverificationSettingsSchema>;
export type LegalSettings = z.output<typeof LegalSettingsSchema>;
export type BrandingSettings = z.output<typeof BrandingSettingsSchema>;
export type BrandLogo = z.output<typeof BrandLogoSchema>;
export type BrandFont = (typeof BRAND_FONTS)[number];
export type BrandRadius = (typeof BRAND_RADII)[number];
export type BrandLogoType = (typeof BRAND_LOGO_TYPES)[number];
export type AiSettings = z.output<typeof AiSettingsSchema>;
export type AiAcknowledgement = z.output<typeof AiAcknowledgementSchema>;
export type WorkspaceSettings = z.output<typeof WorkspaceSettingsSchema>;

/** Parses a stored settings object; unknown keys are kept, missing ones defaulted. */
export function parseWorkspaceSettings(raw: unknown): WorkspaceSettings {
  const r = WorkspaceSettingsSchema.safeParse(raw ?? {});
  if (r.success) return r.data;
  const base0 = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  // A malformed `ai` block alone falls back to its defaults (AI off) and touches nothing else.
  const retryAi = WorkspaceSettingsSchema.safeParse({ ...base0, ai: {} });
  if (retryAi.success) return retryAi.data;
  // A malformed `access` block falls back to defaults rather than locking everyone out.
  const base = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const retry = WorkspaceSettingsSchema.safeParse({ ...base, access: {} });
  if (retry.success) return retry.data;
  // A malformed `dataRoom.qa` block falls back to its defaults (Q&A off) without discarding the
  // rest of the data-room block (watermark and download defaults, retention).
  const rawDataRoom = base["dataRoom"];
  const dataRoom =
    typeof rawDataRoom === "object" && rawDataRoom !== null
      ? (rawDataRoom as Record<string, unknown>)
      : {};
  const retryQa = WorkspaceSettingsSchema.safeParse({
    ...base,
    access: {},
    dataRoom: { ...dataRoom, qa: {} },
  });
  if (retryQa.success) return retryQa.data;
  return WorkspaceSettingsSchema.parse({
    ...base,
    access: {},
    content: {},
    dataRoom: {},
    updates: {},
    analytics: {},
    notify: {},
    metrics: {},
    round: {},
    legal: {},
    branding: {},
    embed: {},
    ai: {},
  });
}
