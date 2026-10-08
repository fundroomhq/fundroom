import type { FundRoomSchemas } from "@fundroom/sdk";
import { vi } from "vitest";

/*
 * A tiny fetch router for screen tests: handlers keyed by `METHOD /api/v1/path` (path params
 * as `{id}`), each returning `[status, body]` or a Response. Every call is recorded.
 */
export type Handler = (ctx: {
  url: URL;
  body: unknown;
  params: Record<string, string>;
  request: Request;
}) => [number, unknown, Record<string, string>?] | Response | Promise<Response>;

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-request-id": "req-test-1", ...headers },
  });
}

export function apiError(status: number, code: string, extra: Record<string, unknown> = {}) {
  return json(status, { error: { code, message: code, requestId: "req-test-1", ...extra } });
}

function match(pattern: string, path: string): Record<string, string> | undefined {
  const p = pattern.split("/");
  const a = path.split("/");
  if (p.length !== a.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const seg = p[i] ?? "";
    const actual = a[i] ?? "";
    if (seg.startsWith("{") && seg.endsWith("}")) params[seg.slice(1, -1)] = actual;
    else if (seg !== actual) return undefined;
  }
  return params;
}

export function installMockApi(handlers: Record<string, Handler>) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    let body: unknown;
    const text = await request.text();
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    calls.push({ method: request.method, path: url.pathname, body });
    for (const [key, handler] of Object.entries(handlers)) {
      const [method, pattern] = key.split(" ", 2) as [string, string];
      if (method !== request.method) continue;
      const params = match(pattern, url.pathname);
      if (!params) continue;
      const out = await handler({ url, body, params, request });
      if (out instanceof Response) return out;
      const [status, payload, headers] = out;
      return json(status, payload, headers);
    }
    return apiError(404, "not_found");
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

/*
 * Fixtures for the engagement modules (E1.5). Kept next to the fetch router because both
 * the analytics and the notify screen tests — and the data-room dwell test — need them.
 */
export function analyticsSettings(
  over: Partial<FundRoomSchemas["AnalyticsSettings"]> = {},
): FundRoomSchemas["AnalyticsSettings"] {
  return {
    mode: "engagement",
    retentionMonths: 24,
    hotListWindowDays: 14,
    hotLeadThreshold: 60,
    ...over,
  };
}

/*
 * E2.6 analytics fixtures: the page heatmap (one entry per document version), the hot list
 * with its score breakdown, and one update's email engagement (human vs automated opens).
 */
export function analyticsHeatmap(
  over: Partial<FundRoomSchemas["AnalyticsHeatmap"]> = {},
): FundRoomSchemas["AnalyticsHeatmap"] {
  return {
    mode: "engagement",
    resourceKind: "document",
    resourceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d01",
    versions: [
      {
        versionId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d11",
        pages: [
          { pageNo: 1, totalMs: 120_000, views: 6, viewers: 3, avgMs: 20_000 },
          { pageNo: 2, totalMs: 30_000, views: 4, viewers: 2, avgMs: 7_500 },
          { pageNo: 3, totalMs: 300_000, views: 5, viewers: 3, avgMs: 60_000 },
        ],
      },
    ],
    ...over,
  };
}

export function analyticsHotListEntry(
  over: Partial<FundRoomSchemas["AnalyticsHotListEntry"]> = {},
): FundRoomSchemas["AnalyticsHotListEntry"] {
  return {
    membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01",
    displayName: "Ada Lovelace",
    role: "investor",
    score: 82,
    points: { views: 30, dwell: 25, downloads: 12, opens: 8, clicks: 7 },
    counts: {
      views: 9,
      dwellMs: 1_260_000,
      downloads: 2,
      humanOpens: 3,
      clicks: 2,
      automatedOpens: 4,
      automatedClicks: 1,
    },
    lastActivityAt: "2026-09-12T10:00:00.000Z",
    ...over,
  };
}

export function analyticsHotList(
  over: Partial<FundRoomSchemas["AnalyticsHotList"]> = {},
): FundRoomSchemas["AnalyticsHotList"] {
  return {
    mode: "engagement",
    days: 14,
    threshold: 60,
    generatedAt: "2026-09-12T10:00:00.000Z",
    entries: [analyticsHotListEntry()],
    ...over,
  };
}

export function analyticsEmailEngagement(
  over: Partial<FundRoomSchemas["AnalyticsEmailEngagement"]> = {},
): FundRoomSchemas["AnalyticsEmailEngagement"] {
  return {
    mode: "engagement",
    postId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01",
    opens: { human: 7, uniqueHuman: 5, automated: 11, uniqueAutomated: 6 },
    clicks: { human: 4, uniqueHuman: 3, automated: 2 },
    uniqueEngaged: 6,
    links: [
      {
        link: "https://acme.test/deck",
        clicks: 3,
        uniqueClickers: 2,
        automatedClicks: 1,
      },
      { link: null, clicks: 1, uniqueClickers: 1, automatedClicks: 1 },
    ],
    ...over,
  };
}

export function analyticsNotice(
  over: Partial<FundRoomSchemas["AnalyticsNotice"]> = {},
): FundRoomSchemas["AnalyticsNotice"] {
  const mode = over.mode ?? "engagement";
  return {
    mode,
    tracks: ["document_views", "downloads", "update_views", "page_dwell", "hashed_ip"],
    consent: { mode: "notice_only", granted: null, gpc: false, shouldAsk: false },
    // The server folds mode + consent + GPC into this one flag and the viewer obeys only it
    // (E1.6/R13), so a fixture that overrides `mode` gets the matching default for free.
    dwell: mode === "engagement",
    emailTracking: { granted: null, active: mode === "engagement" },
    ...over,
  };
}

export function analyticsViewer(
  over: Partial<FundRoomSchemas["AnalyticsViewer"]> = {},
): FundRoomSchemas["AnalyticsViewer"] {
  const now = "2026-09-12T10:00:00.000Z";
  return {
    membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01",
    displayName: "Ada Lovelace",
    kind: "external",
    role: "investor",
    firstAt: now,
    lastAt: now,
    views: 4,
    downloads: 1,
    totalMs: 185_000,
    maxPageReached: 7,
    pagesSeen: [1, 2, 7],
    ...over,
  };
}

export function analyticsOverview(
  over: Partial<FundRoomSchemas["AnalyticsOverview"]> = {},
): FundRoomSchemas["AnalyticsOverview"] {
  const now = "2026-09-12T10:00:00.000Z";
  return {
    mode: "engagement",
    range: { from: "2026-08-13T10:00:00.000Z", to: now },
    totals: { views: 12, uniqueViewers: 3, downloads: 2, totalMs: 3_725_000 },
    topDocuments: [
      {
        resourceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d01",
        views: 9,
        uniqueViewers: 3,
        totalMs: 600_000,
        downloads: 2,
      },
    ],
    recent: [
      {
        id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c01",
        occurredAt: now,
        type: "page_viewed",
        membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01",
        membership: { displayName: "Ada Lovelace", kind: "external", role: "investor" },
        resourceKind: "document",
        resourceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d01",
        versionId: null,
        page: 3,
        durationMs: 42_000,
      },
    ],
    ...over,
  };
}

export function analyticsTimelineItem(
  over: Partial<FundRoomSchemas["AnalyticsTimelineItem"]> = {},
): FundRoomSchemas["AnalyticsTimelineItem"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c02",
    occurredAt: "2026-09-12T10:00:00.000Z",
    type: "document_viewed",
    resourceKind: "document",
    resourceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d01",
    versionId: null,
    pageNo: null,
    durationMs: null,
    props: {},
    ...over,
  };
}

export function notifyPreferences(
  over: Partial<FundRoomSchemas["NotifyPreferences"]> = {},
): FundRoomSchemas["NotifyPreferences"] {
  return {
    preferences: [
      { eventType: "document.viewed", cadence: "instant", isDefault: true },
      { eventType: "document.downloaded", cadence: "daily", isDefault: false },
      { eventType: "update.replied", cadence: "instant", isDefault: true },
      { eventType: "round.interest_submitted", cadence: "instant", isDefault: true },
      { eventType: "round.verification_requested", cadence: "instant", isDefault: true },
      { eventType: "round.commitment_created", cadence: "instant", isDefault: true },
      { eventType: "analytics.hot_lead", cadence: "instant", isDefault: true },
    ],
    settings: {
      emailEnabled: true,
      timezone: "UTC",
      digestHour: 8,
      weeklyDay: 1,
      quietHours: null,
    },
    ...over,
  };
}

export function notifyInboxItem(
  over: Partial<FundRoomSchemas["NotifyInboxItem"]> = {},
): FundRoomSchemas["NotifyInboxItem"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b01",
    eventType: "document.viewed",
    createdAt: "2026-09-12T10:00:00.000Z",
    sentAt: null,
    readAt: null,
    archivedAt: null,
    actor: {
      membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01",
      displayName: "Ada Lovelace",
      kind: "external",
      role: "investor",
    },
    subjectName: null,
    resourceKind: "document",
    resourceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d01",
    payload: {},
    ...over,
  };
}

export function notifyChannel(
  over: Partial<FundRoomSchemas["NotifyChannel"]> = {},
): FundRoomSchemas["NotifyChannel"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c01",
    kind: "slack",
    name: "#deals",
    urlHint: "abcd",
    slackChannelId: null,
    slackChannelName: null,
    eventTypes: ["analytics.hot_lead", "round.commitment_created"],
    enabled: true,
    disabledReason: null,
    failureCount: 0,
    lastSuccessAt: "2026-09-12T09:00:00.000Z",
    lastError: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-12T09:00:00.000Z",
    ...over,
  };
}

/* Mail delivery fixtures (E2.6): `GET /mail/status` and one suppression-list entry. */
export function mailStatus(
  over: Partial<FundRoomSchemas["MailStatus"]> = {},
): FundRoomSchemas["MailStatus"] {
  return {
    driver: "resend",
    capabilities: { perMessageTracking: false, webhooks: true },
    webhookUrl: "https://investors.acme.test/webhooks/email/resend",
    ...over,
  };
}

export function mailSuppression(
  over: Partial<FundRoomSchemas["MailSuppression"]> = {},
): FundRoomSchemas["MailSuppression"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a01",
    address: "j•••@northwind.test",
    reason: "bounce",
    messageRef: null,
    createdAt: "2026-09-10T08:30:00.000Z",
    ...over,
  };
}

/*
 * Compliance fixtures (E1.6): the offering state with its §11 permits table, the tenant legal
 * documents and the pending acceptance the bootstrap carries with its body included.
 */
const NOW_ISO = "2026-09-12T10:00:00.000Z";

export function offeringPermits(
  status: FundRoomSchemas["OfferingPermits"]["status"],
): FundRoomSchemas["OfferingPermits"] {
  const table: Record<string, Omit<FundRoomSchemas["OfferingPermits"], "status">> = {
    none: {
      roundAndTerms: false,
      publicSections: false,
      shareLinks: false,
      accreditationRequired: false,
      requestAutoApprove: true,
      explanation: "No offering is being made from this workspace.",
    },
    informational: {
      roundAndTerms: false,
      publicSections: true,
      shareLinks: true,
      accreditationRequired: false,
      requestAutoApprove: true,
      explanation: "Company information only: no round, no terms.",
    },
    "506b": {
      roundAndTerms: true,
      publicSections: false,
      shareLinks: false,
      accreditationRequired: false,
      requestAutoApprove: false,
      explanation: "Private offering to people you already knew. No general solicitation.",
    },
    "506c": {
      roundAndTerms: true,
      publicSections: true,
      shareLinks: true,
      accreditationRequired: true,
      requestAutoApprove: true,
      explanation: "General solicitation is permitted; every investor must be verified.",
    },
    non_us: {
      roundAndTerms: true,
      publicSections: true,
      shareLinks: true,
      accreditationRequired: false,
      requestAutoApprove: true,
      explanation: "Offered outside the United States.",
    },
  };
  return { status, ...(table[status] ?? table["none"]) } as FundRoomSchemas["OfferingPermits"];
}

export function offeringPeriod(
  over: Partial<FundRoomSchemas["OfferingPeriod"]> = {},
): FundRoomSchemas["OfferingPeriod"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a01",
    status: "506b",
    startedAt: NOW_ISO,
    endedAt: null,
    reason: null,
    changedBy: null,
    ...over,
  };
}

export function offeringState(
  over: Partial<FundRoomSchemas["OfferingState"]> = {},
): FundRoomSchemas["OfferingState"] {
  const status = over.status ?? "506b";
  return {
    status,
    current: offeringPeriod({ status }),
    history: [offeringPeriod({ status })],
    permits: offeringPermits(status),
    table: (["none", "informational", "506b", "506c", "non_us"] as const).map(offeringPermits),
    irrevocable: status === "506c",
    ...over,
  };
}

export function complianceSettings(
  over: Partial<FundRoomSchemas["ComplianceSettings"]> = {},
): FundRoomSchemas["ComplianceSettings"] {
  return {
    consentMode: "notice_only",
    privacyRegion: null,
    legalHold: false,
    enforceAcceptance: true,
    relationshipWarningDays: 30,
    defaultDisclaimerSlug: null,
    suggestedConsentMode: "opt_in",
    consentModeWeakerThanRegion: false,
    ...over,
  };
}

/** A DSAR erasure request (E2.6): one module still to report, due in 30 days. */
export function erasureRequest(
  over: Partial<FundRoomSchemas["ErasureRequest"]> = {},
): FundRoomSchemas["ErasureRequest"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a21",
    membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01",
    memberName: "Ada Lovelace",
    requestedBy: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6d",
    requestedAt: NOW_ISO,
    dueAt: "2026-10-12T10:00:00.000Z",
    overdue: false,
    status: "requested",
    expectedModules: ["analytics", "updates"],
    completedModules: ["analytics"],
    pendingModules: ["updates"],
    steps: [{ module: "analytics", completedAt: NOW_ISO, counts: { events: 12 }, expected: true }],
    completedAt: null,
    cancelledAt: null,
    cancelledBy: null,
    note: null,
    ...over,
  };
}

export function legalDocument(
  over: Partial<FundRoomSchemas["LegalDocument"]> = {},
): FundRoomSchemas["LegalDocument"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a02",
    slug: "privacy-notice",
    title: "Privacy notice",
    kind: "privacy_notice",
    audience: "external",
    requiresAcceptance: true,
    ceremony: "clickwrap",
    currentVersionNo: 1,
    stamp: "privacy-notice:v1",
    templateId: "privacy-notice",
    templateVersion: 1,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...over,
  };
}

export function legalVersion(
  over: Partial<FundRoomSchemas["LegalDocumentVersion"]> = {},
): FundRoomSchemas["LegalDocumentVersion"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a03",
    versionNo: 1,
    body: "# Privacy notice\n\nWe record which documents you open.",
    bodySha256: "a".repeat(64),
    summary: null,
    source: "template",
    templateId: "privacy-notice",
    templateVersion: 1,
    effectiveAt: NOW_ISO,
    publishedAt: NOW_ISO,
    createdBy: null,
    ...over,
  };
}

export function pendingAcceptance(
  over: Partial<FundRoomSchemas["PendingAcceptance"]> = {},
): FundRoomSchemas["PendingAcceptance"] {
  return {
    documentId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a02",
    slug: "privacy-notice",
    title: "Privacy notice",
    kind: "privacy_notice",
    versionNo: 1,
    stamp: "privacy-notice:v1",
    body: "# Privacy notice\n\nWe record which documents you open, and for how long.",
    bodySha256: "a".repeat(64),
    effectiveAt: NOW_ISO,
    ceremony: "clickwrap",
    esign: null,
    scope: "workspace",
    ...over,
  };
}

/*
 * Branding fixtures (E1.7). `tokens` and `contrast` are read-only derivations server-side,
 * so the fixture carries whatever the test needs to see rather than deriving them here —
 * that is what lets a test ask for a failing contrast pair without hunting for a hue that
 * defeats the solver.
 */
export function brandLogo(
  over: Partial<FundRoomSchemas["BrandLogo"]> = {},
): FundRoomSchemas["BrandLogo"] {
  return {
    url: "/api/v1/branding/logo",
    contentType: "image/png",
    width: 256,
    height: 64,
    bytes: 4096,
    source: "upload",
    updatedAt: NOW_ISO,
    ...over,
  };
}

export function contrastFinding(
  over: Partial<FundRoomSchemas["ContrastFinding"]> = {},
): FundRoomSchemas["ContrastFinding"] {
  return {
    pair: "primary on background",
    mode: "light",
    ratio: 6.1,
    required: 4.5,
    passes: true,
    ...over,
  };
}

export function branding(
  over: Partial<FundRoomSchemas["Branding"]> = {},
): FundRoomSchemas["Branding"] {
  return {
    displayName: "Acme Ventures",
    tagline: "Building the boring parts",
    accentColor: "#1d4ed8",
    fontFamily: "system",
    radius: "soft",
    logo: null,
    supportEmail: "investors@acme.test",
    showPoweredBy: true,
    tokens: {
      light: { "--sh-color-primary": "#1d4ed8", "--sh-color-primary-fg": "#ffffff" },
      dark: { "--sh-color-primary": "#93b4fd", "--sh-color-primary-fg": "#0f172a" },
    },
    contrast: [contrastFinding(), contrastFinding({ mode: "dark", ratio: 7.4 })],
    effectiveName: "Acme Ventures",
    ...over,
  };
}

export function moduleEnablement(
  over: Partial<FundRoomSchemas["ModuleEnablement"]> = {},
): FundRoomSchemas["ModuleEnablement"] {
  return {
    id: "updates",
    enabled: true,
    locked: false,
    lockedReason: null,
    dependsOn: [],
    planAllows: true,
    readOnly: false,
    ...over,
  };
}

/** A module the plan leaves out and that is off: the switch is locked (A-3). */
export function planLockedModule(id: string): FundRoomSchemas["ModuleEnablement"] {
  return moduleEnablement({
    id,
    enabled: false,
    locked: true,
    lockedReason: "plan",
    planAllows: false,
  });
}

/** A module that is on but outside the plan: read-only for staff, can still be switched off. */
export function readOnlyModule(id: string): FundRoomSchemas["ModuleEnablement"] {
  return moduleEnablement({ id, enabled: true, planAllows: false, readOnly: true });
}

type PlanEntitlements = NonNullable<FundRoomSchemas["ModulesBootstrap"]["entitlements"]>;

/**
 * A-3: put the workspace on a plan for an already-installed mock API — every `GET /modules`
 * (the bootstrap) answers with `entitlements` added (`null` = all, as the server sends to
 * staff). Wraps the stubbed `fetch`, so the screen's own handlers and recorded calls stay as
 * they are; call it right after the screen's `handlers()`.
 */
export function withPlanEntitlements(entitlements: Partial<PlanEntitlements>): void {
  const inner = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    // Read the method and URL without touching a Request's body (the inner mock reads it).
    const method = input instanceof Request ? input.method : (init?.method ?? "GET");
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (method !== "GET" || url.pathname !== "/api/v1/modules" || !res.ok) return res;
    const body = (await res.json()) as FundRoomSchemas["ModulesBootstrap"];
    return json(200, { ...body, entitlements: { modules: null, features: null, ...entitlements } });
  });
}

/*
 * Custom-domain fixtures (E2.1). `records` is derived server-side on every read, so the fixture
 * derives it too rather than letting a test hand-write a record set that could not exist: the
 * CNAME target and the challenge token are the only inputs, and the pair is always both records.
 */
export const DOMAIN_CNAME_TARGET = "edge.fundroom.test";
const DOMAIN_TOKEN = "k7q2v9x4m3n8b5c1z6t0r7y2w4e9u3i8";

export function dnsInstructions(
  hostname: string,
  over: { token?: string; cnameTarget?: string } = {},
): FundRoomSchemas["DnsInstruction"][] {
  return [
    {
      type: "CNAME",
      name: hostname,
      value: over.cnameTarget ?? DOMAIN_CNAME_TARGET,
      required: true,
    },
    {
      type: "TXT",
      name: `_fundroom-challenge.${hostname}`,
      value: over.token ?? DOMAIN_TOKEN,
      required: true,
    },
  ];
}

export function dnsAnswer(
  over: Partial<FundRoomSchemas["DnsAnswer"]> = {},
): FundRoomSchemas["DnsAnswer"] {
  return {
    name: "investors.acme.test",
    type: "CNAME",
    values: [DOMAIN_CNAME_TARGET],
    rcode: "ok",
    resolver: "1.1.1.1",
    ...over,
  };
}

export function customDomain(
  over: Partial<FundRoomSchemas["CustomDomain"]> = {},
): FundRoomSchemas["CustomDomain"] {
  const hostname = over.hostname ?? "investors.acme.test";
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5901",
    hostname,
    status: "pending",
    records: dnsInstructions(hostname),
    answer: null,
    detail: null,
    consecutiveFailures: 0,
    firstAttemptAt: NOW_ISO,
    // 72 h after the first attempt, as `VERIFY_DEADLINE_MS` computes it server-side.
    deadlineAt: "2026-09-15T10:00:00.000Z",
    lastCheckedAt: null,
    dnsOkAt: null,
    activatedAt: null,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...over,
  };
}

/** A domain whose last check found both records: what `dns_ok` actually looks like. */
export function verifiedDomain(
  over: Partial<FundRoomSchemas["CustomDomain"]> = {},
): FundRoomSchemas["CustomDomain"] {
  const hostname = over.hostname ?? "investors.acme.test";
  return customDomain({
    status: "dns_ok",
    answer: {
      cname: dnsAnswer({ name: hostname }),
      txt: dnsAnswer({
        name: `_fundroom-challenge.${hostname}`,
        type: "TXT",
        values: [DOMAIN_TOKEN],
      }),
    },
    detail: "both records resolve",
    lastCheckedAt: NOW_ISO,
    dnsOkAt: NOW_ISO,
    ...over,
  });
}

export function customDomainList(
  over: Partial<FundRoomSchemas["CustomDomainList"]> = {},
): FundRoomSchemas["CustomDomainList"] {
  return {
    domains: [customDomain()],
    driver: "caddy-ask",
    cnameTarget: DOMAIN_CNAME_TARGET,
    ...over,
  };
}

/*
 * Embed fixtures (E2.2). `frameAncestors`, the preview patterns and the three snippet URLs are
 * derived server-side on every read, so the fixture derives them too rather than letting a test
 * hand-write a combination that could not exist — `frameAncestors` always leads with `'self'`,
 * and the preview patterns are only in it while the toggle is on.
 */
export const EMBED_PREVIEW_PATTERNS = [
  "https://*.webflow.io",
  "https://*.framer.app",
  "https://*.framer.website",
  "https://*.wixsite.com",
  "https://*.wix.com",
  "https://*.squarespace.com",
];

export const EMBED_ORIGIN = "https://investors.acme.test";
export const EMBED_INTEGRITY = `sha384-${"k".repeat(64)}`;

export function embedHandoffKey(
  over: Partial<FundRoomSchemas["EmbedHandoffKey"]> = {},
): FundRoomSchemas["EmbedHandoffKey"] {
  return {
    id: "acme-wp-1",
    publicKey: "A".repeat(43),
    label: "acme.com WordPress",
    addedAt: "2026-09-12T10:00:00.000Z",
    ...over,
  };
}

export function embedSettings(
  over: Partial<FundRoomSchemas["EmbedSettings"]> = {},
): FundRoomSchemas["EmbedSettings"] {
  const origins = over.origins ?? [];
  const allowPreviewOrigins = over.allowPreviewOrigins ?? false;
  return {
    origins,
    allowPreviewOrigins,
    trustHostIdentity: false,
    handoffKeys: [],
    frameAncestors: ["'self'", ...origins, ...(allowPreviewOrigins ? EMBED_PREVIEW_PATTERNS : [])],
    previewOriginPatterns: EMBED_PREVIEW_PATTERNS,
    embedUrl: `${EMBED_ORIGIN}/embed/acme`,
    loaderUrl: `${EMBED_ORIGIN}/embed/v1/embed.js`,
    loaderIntegrity: EMBED_INTEGRITY,
    loaderPinnedUrl: `${EMBED_ORIGIN}/embed/0.1.0/embed.js`,
    ...over,
  };
}

/*
 * Share-link fixtures (E2.3). `visits` and the two counters are server-side facts about the
 * link rather than derivations, so the fixture carries them plainly; what it must never carry
 * is the token or either digest, because the response schema does not have them either.
 */
export function shareLink(
  over: Partial<FundRoomSchemas["ShareLink"]> = {},
): FundRoomSchemas["ShareLink"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5801",
    label: "Sent to Northwind at the Q3 meeting",
    status: "active",
    policy: { domains: ["northwind.test"], emails: [], forceWatermark: false },
    grants: [],
    groupIds: [],
    passcodeRequired: false,
    maxUses: null,
    uses: 2,
    maxViews: null,
    views: 7,
    expiresAt: null,
    createdBy: null,
    createdAt: NOW_ISO,
    revokedAt: null,
    visits: 2,
    ...over,
  };
}

export function shareLinkVisit(
  over: Partial<FundRoomSchemas["ShareLinkVisit"]> = {},
): FundRoomSchemas["ShareLinkVisit"] {
  return {
    membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5802",
    displayName: "Ada Lovelace",
    email: "ada@northwind.test",
    firstSeenAt: NOW_ISO,
    lastSeenAt: NOW_ISO,
    views: 3,
    revokedAt: null,
    ...over,
  };
}

/*
 * KPI fixtures (E2.4). Two properties of the real responses are reproduced deliberately
 * because the screens depend on them:
 *
 *  - **values are decimal strings, never JSON numbers.** `numeric(20, 6)` does not survive a
 *    round trip through a double (contract §5), so a fixture that used `1250000` instead of
 *    `"1250000.000000"` would let a regression through.
 *  - **the grid is sparse.** A period with no figure has no cell at all — never a zero — and
 *    `metricGrid` below leaves the newest month empty on purpose so a test can prove the
 *    screen does not send a zero for it.
 */
export const METRIC_DEFINITION_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a01";
export const METRIC_DEFINITION_ID_2 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a02";

export function metricDefinition(
  over: Partial<FundRoomSchemas["MetricDefinition"]> = {},
): FundRoomSchemas["MetricDefinition"] {
  return {
    id: METRIC_DEFINITION_ID,
    key: "arr",
    name: "ARR",
    description: null,
    unit: "currency",
    currency: "USD",
    aggregation: "last",
    direction: "up_good",
    periodKind: "month",
    decimals: 0,
    formula: null,
    display: {},
    audience: { kind: "all" },
    sortOrder: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...over,
  };
}

export function metricPeriod(key: string, label: string): FundRoomSchemas["MetricPeriod"] {
  const [year = "2026", month = "01"] = key.split("-");
  const start = `${year}-${month}-01T00:00:00.000Z`;
  const next =
    Number(month) === 12
      ? `${Number(year) + 1}-01`
      : `${year}-${String(Number(month) + 1).padStart(2, "0")}`;
  return { key, label, start, end: `${next}-01T00:00:00.000Z` };
}

export const METRIC_PERIODS: FundRoomSchemas["MetricPeriod"][] = [
  metricPeriod("2026-07", "Jul 2026"),
  metricPeriod("2026-08", "Aug 2026"),
  metricPeriod("2026-09", "Sep 2026"),
];

export function metricGridCell(
  over: Partial<FundRoomSchemas["MetricGridCell"]> = {},
): FundRoomSchemas["MetricGridCell"] {
  return {
    definitionId: METRIC_DEFINITION_ID,
    periodKey: "2026-07",
    value: "1200000.000000",
    revision: 1,
    sourceKind: "manual",
    needsReview: false,
    note: null,
    asOf: NOW_ISO,
    ...over,
  };
}

export function metricGrid(
  over: Partial<FundRoomSchemas["MetricGrid"]> = {},
): FundRoomSchemas["MetricGrid"] {
  return {
    periodKind: "month",
    periods: METRIC_PERIODS,
    definitions: [metricDefinition()],
    // Sep is absent: a period with no figure has no cell, and the screen must not invent one.
    cells: [
      metricGridCell({ periodKey: "2026-07", value: "1200000.000000" }),
      metricGridCell({ periodKey: "2026-08", value: "1250000.000000", revision: 2 }),
    ],
    ...over,
  };
}

export function metricPoint(
  over: Partial<FundRoomSchemas["MetricPoint"]> = {},
): FundRoomSchemas["MetricPoint"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b01",
    definitionId: METRIC_DEFINITION_ID,
    periodKey: "2026-08",
    periodLabel: "Aug 2026",
    periodStart: "2026-08-01T00:00:00.000Z",
    periodEnd: "2026-09-01T00:00:00.000Z",
    value: "1250000.000000",
    asOf: NOW_ISO,
    revision: 2,
    sourceKind: "manual",
    needsReview: false,
    note: null,
    createdAt: NOW_ISO,
    // Who restated a figure is part of the revision history's answer, so the fixture always
    // carries one; a system-written revision (a sheets sync, a derived recompute) is `null`.
    createdBy: {
      membershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6d",
      displayName: "Ada Lovelace",
    },
    current: true,
    ...over,
  };
}

export function metricSeriesEntry(
  over: Partial<FundRoomSchemas["MetricSeriesEntry"]> = {},
): FundRoomSchemas["MetricSeriesEntry"] {
  return {
    definitionId: METRIC_DEFINITION_ID,
    key: "arr",
    name: "ARR",
    unit: "currency",
    currency: "USD",
    decimals: 0,
    direction: "up_good",
    aggregation: "last",
    // `null` is a gap, not a zero (§6): the middle period has no figure.
    values: ["1200000.000000", null, "1250000.000000"],
    ...over,
  };
}

export function metricSeries(
  over: Partial<FundRoomSchemas["MetricSeries"]> = {},
): FundRoomSchemas["MetricSeries"] {
  return {
    periodKind: "month",
    periods: METRIC_PERIODS,
    series: [metricSeriesEntry()],
    ...over,
  };
}

export function metricImportRow(
  over: Partial<FundRoomSchemas["MetricImportRow"]> = {},
): FundRoomSchemas["MetricImportRow"] {
  return {
    line: 2,
    periodKey: "2026-08",
    status: "ok",
    cells: [{ key: "arr", column: "arr", value: "1250000", status: "ok" }],
    ...over,
  };
}

export function metricDryRun(
  over: Partial<FundRoomSchemas["MetricCsvDryRunResult"]> = {},
): FundRoomSchemas["MetricCsvDryRunResult"] {
  return {
    rows: [metricImportRow()],
    summary: { ok: 1, skipped: 0, error: 0, values: 1 },
    columns: ["period", "arr"],
    ...over,
  };
}

export function metricImport(
  over: Partial<FundRoomSchemas["MetricImport"]> = {},
): FundRoomSchemas["MetricImport"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5c01",
    status: "done",
    total: 1,
    applied: 1,
    skipped: 0,
    failed: 0,
    rows: [metricImportRow({ status: "applied" })],
    createdAt: NOW_ISO,
    startedAt: NOW_ISO,
    finishedAt: NOW_ISO,
    lastError: null,
    ...over,
  };
}

export function metricSheetConnection(
  over: Partial<FundRoomSchemas["MetricSheetConnection"]> = {},
): FundRoomSchemas["MetricSheetConnection"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5d01",
    spreadsheetId: "1AbCdEfGhIjKlMnOpQrStUvWxYz",
    range: "Sheet1!A1:Z1000",
    mapping: {
      periodColumn: "period",
      periodKind: "month",
      columns: [{ column: "arr", key: "arr" }],
    },
    serviceAccountEmail: "kpis@acme-metrics.iam.gserviceaccount.com",
    status: "ok",
    enabled: true,
    lastSyncAt: NOW_ISO,
    lastError: null,
    consecutiveFailures: 0,
    createdAt: NOW_ISO,
    updatedAt: NOW_ISO,
    ...over,
  };
}

/**
 * One tile of §10's hydrated `metric_grid` payload.
 *
 * `periods` is aligned with `sparkline` index for index and oldest first (§12 C-F.1) — the
 * hydrator builds both from the same columns, so a fixture where they disagreed would let a
 * mislabelled axis through. Note that the middle column is a **gap**: Aug has no figure, so
 * `previous` is Jul's — the previous *point*, not the previous period — and the tile must
 * still label that column "Aug 2026" while rendering a dash in it.
 */
export function metricGridTile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: METRIC_DEFINITION_ID,
    key: "arr",
    name: "ARR",
    unit: "currency",
    currency: "USD",
    decimals: 0,
    direction: "up_good",
    latest: { periodKey: "2026-09", periodLabel: "Sep 2026", value: "1250000.000000" },
    previous: { periodKey: "2026-07", value: "1200000.000000" },
    sparkline: ["1200000.000000", null, "1250000.000000"],
    periods: METRIC_PERIODS.map((p) => ({ key: p.key, label: p.label })),
    ...over,
  };
}

/** §10's hydrated `metric_grid` payload, as the content block renderer receives it. */
export function metricGridHydrated(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { columns: 3, metrics: [metricGridTile()], ...over };
}

// --- E2.7 W1 ---
/*
 * Audit log, jobs/dead letters, health and access settings fixtures (E2.7 admin surfaces).
 */
export function auditEvent(
  over: Partial<FundRoomSchemas["AuditEvent"]> = {},
): FundRoomSchemas["AuditEvent"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01",
    seq: 42,
    occurredAt: "2026-09-11T10:00:00.000Z",
    actorKind: "staff",
    actorMembershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f07",
    actorName: "Grace Hopper",
    onBehalfOfMembershipId: null,
    action: "access.invited",
    resourceKind: "membership",
    resourceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02",
    subjectMembershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e02",
    subjectName: "Ada Lovelace",
    outcome: "success",
    ip: "203.0.113.0/24",
    userAgent: "Mozilla/5.0",
    requestId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e03",
    meta: { role: "investor", groups: 1 },
    diff: null,
    ...over,
  };
}

export function auditExportKeys(
  over: Partial<FundRoomSchemas["AuditExportKeys"]> = {},
): FundRoomSchemas["AuditExportKeys"] {
  return {
    alg: "Ed25519",
    keys: [
      { keyId: "v2", publicKey: "0vN6m1a6Xx2A0h8d7hZf6k0cQ2c9C6r3oS4r0VbqM9w=", current: true },
      { keyId: "v1", publicKey: "q1W2e3R4t5Y6u7I8o9P0a1S2d3F4g5H6j7K8l9Z0x1c=", current: false },
    ],
    ...over,
  };
}

export function deadLetter(
  over: Partial<FundRoomSchemas["DeadLetterItem"]> = {},
): FundRoomSchemas["DeadLetterItem"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e11",
    sourceQueue: "event.acl.changed",
    failedAt: "2026-09-11T10:00:00.000Z",
    retries: 5,
    error: "connection reset by peer",
    dataKeys: ["outboxId", "payload", "subscriber", "topic", "workspaceId"],
    topic: "acl.changed",
    eventId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e12",
    subscriber: "access.rebuild",
    ...over,
  };
}

export function opsJobs(
  over: Partial<FundRoomSchemas["OpsJobs"]> = {},
): FundRoomSchemas["OpsJobs"] {
  return {
    scope: "instance",
    queues: [{ name: "event.acl.changed", queued: 3, active: 1, failed: 2 }],
    deadLetters: { count: 1, items: [deadLetter()] },
    ...over,
  };
}

export function opsHealth(
  over: Partial<FundRoomSchemas["OpsHealth"]> = {},
): FundRoomSchemas["OpsHealth"] {
  return {
    scope: "instance",
    checks: [
      { name: "db", status: "ok", detail: null, latencyMs: 3 },
      { name: "mail", status: "degraded", detail: "SMTP timeout", latencyMs: 3000 },
      { name: "avscan", status: "skipped", detail: "not configured", latencyMs: null },
    ],
    domains: [],
    ...over,
  };
}

export function domainHealth(
  over: Partial<FundRoomSchemas["DomainHealth"]> = {},
): FundRoomSchemas["DomainHealth"] {
  return {
    hostname: "investors.acme.test",
    status: "active",
    certStatus: "valid",
    certExpiresAt: "2027-01-01T00:00:00.000Z",
    certIssuer: "Let's Encrypt R11",
    certError: null,
    checkedAt: "2026-09-11T10:00:00.000Z",
    ...over,
  };
}

export function accessSettings(
  over: Partial<FundRoomSchemas["AccessSettings"]> = {},
): FundRoomSchemas["AccessSettings"] {
  return {
    requireMfaForStaff: true,
    requireMfaForExternal: false,
    inviteExpiryDays: 14,
    allowDelegates: true,
    maxDelegatesPerPrincipal: 3,
    requests: {
      enabled: false,
      autoApproveDomains: [],
      defaultGroupIds: [],
      pendingExpiryDays: 30,
    },
    ...over,
  };
}

// --- E2.7 W2 ---
// Access review, member sessions, view-as and data-request fixtures.

export const W2_ADA_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5e01";

export function accessReviewRow(
  over: Partial<FundRoomSchemas["AccessReviewRow"]> = {},
): FundRoomSchemas["AccessReviewRow"] {
  return {
    membershipId: W2_ADA_ID,
    name: "Ada Lovelace",
    email: "ada@investor.test",
    kind: "external",
    role: "investor",
    status: "active",
    groups: ["Series A"],
    grantCount: 1,
    lastActiveAt: NOW_ISO,
    expiresAt: null,
    activeSessions: 1,
    nda: { kind: "nda:v1", signedAt: NOW_ISO },
    accreditation: null,
    pendingGates: [],
    flags: [],
    ...over,
  };
}

export function accessReviewRecord(
  over: Partial<FundRoomSchemas["AccessReviewRecord"]> = {},
): FundRoomSchemas["AccessReviewRecord"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a71",
    reviewerMembershipId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01",
    reviewerName: "Grace Hopper",
    completedAt: "2026-06-01T10:00:00.000Z",
    memberCount: 2,
    flaggedCount: 1,
    note: null,
    reportSha256: "c".repeat(64),
    ...over,
  };
}

export function accessReviewReport(
  over: Partial<FundRoomSchemas["AccessReviewReport"]> = {},
): FundRoomSchemas["AccessReviewReport"] {
  return {
    generatedAt: NOW_ISO,
    members: [accessReviewRow()],
    summary: { members: 1, flagged: 0, byFlag: {}, truncated: false },
    lastReview: null,
    // Never reviewed: the workspace's creation + 90 days (always set since E3.2).
    nextReviewDueAt: "2026-12-11T10:00:00.000Z",
    reportSha256: "d".repeat(64),
    ...over,
  };
}

export function memberSession(
  over: Partial<FundRoomSchemas["MemberSession"]> = {},
): FundRoomSchemas["MemberSession"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a81",
    deviceName: null,
    device: "Firefox on macOS",
    ip: "203.0.113.7",
    createdAt: NOW_ISO,
    lastSeenAt: NOW_ISO,
    authLevel: 1,
    idleExpiresAt: "2026-09-13T10:00:00.000Z",
    absoluteExpiresAt: "2026-10-12T10:00:00.000Z",
    ...over,
  };
}

export function viewAsState(
  over: Partial<FundRoomSchemas["ViewAsState"]> = {},
): FundRoomSchemas["ViewAsState"] {
  return {
    workspaceId: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a",
    membershipId: W2_ADA_ID,
    name: "Ada Lovelace",
    startedAt: NOW_ISO,
    until: "2026-09-12T10:30:00.000Z",
    ...over,
  };
}

export function dataRequest(
  over: Partial<FundRoomSchemas["DataRequest"]> = {},
): FundRoomSchemas["DataRequest"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5a91",
    kind: "access",
    membershipId: W2_ADA_ID,
    subjectName: "Ada Lovelace",
    status: "requested",
    requestedBy: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f01",
    requestedAt: NOW_ISO,
    dueAt: "2026-10-12T10:00:00.000Z",
    overdue: false,
    completedAt: null,
    cancelledAt: null,
    note: null,
    completionNote: null,
    exportSha256: null,
    expectedModules: [],
    pendingModules: [],
    steps: [],
    blockedReason: null,
    ...over,
  };
}
