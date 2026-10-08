import type { FundRoomSchemas } from "@fundroom/sdk";
import type { WebConfig } from "../lib/config.js";
import { testConfig } from "./fixtures.js";
import { type Handler, installMockApi } from "./mock-api.js";

/*
 * Operator-console fixtures (E3.10). The console lives on the canonical host of a multi-tenant
 * install, so the page config has no workspace; and it never calls `/me` or `/modules` — the
 * operator session is its own thing (`/platform/me`).
 */
const NOW = "2026-09-27T10:00:00.000Z";

export const WS_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6001";
export const WS2_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6002";
export const SCREENING_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6101";
export const OPERATOR_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6201";

export function platformConfig(over: Partial<WebConfig> = {}): WebConfig {
  return testConfig({
    tenancy: "multi",
    workspace: null,
    canonicalOrigin: "https://fundroom.test",
    ...over,
  });
}

export function platformMe(
  over: Partial<FundRoomSchemas["PlatformMe"]> = {},
): FundRoomSchemas["PlatformMe"] {
  return {
    userId: OPERATOR_ID,
    email: "ops@fundroom.test",
    displayName: "Olga Operator",
    cellId: "default",
    billingDriver: "none",
    session: {
      createdAt: NOW,
      idleExpiresAt: "2026-09-27T11:00:00.000Z",
      absoluteExpiresAt: "2026-09-27T22:00:00.000Z",
    },
    ...over,
  };
}

export function usageDay(
  over: Partial<FundRoomSchemas["UsageDay"]> = {},
): FundRoomSchemas["UsageDay"] {
  return {
    day: "2026-09-26",
    storageBytes: 5 * 1024 ** 3,
    docsViewed: 42,
    emailsSent: 7,
    staffSeats: 3,
    investorSeats: 18,
    customDomains: 1,
    computedAt: NOW,
    ...over,
  };
}

export function platformWorkspace(
  over: Partial<FundRoomSchemas["PlatformWorkspace"]> = {},
): FundRoomSchemas["PlatformWorkspace"] {
  return {
    id: WS_ID,
    slug: "acme",
    name: "Acme Ventures",
    legalName: "Acme Ventures GmbH",
    country: "DE",
    status: "active",
    suspendedReason: null,
    holds: [],
    cellId: "default",
    planId: "starter",
    subscription: {
      status: "active",
      provider: "stripe",
      currentPeriodEnd: "2026-10-27T00:00:00.000Z",
    },
    usage: usageDay(),
    customDomains: 1,
    createdAt: "2026-09-01T10:00:00.000Z",
    deletedAt: null,
    ...over,
  };
}

export function platformWorkspaceDetail(
  over: Partial<FundRoomSchemas["PlatformWorkspaceDetail"]> = {},
): FundRoomSchemas["PlatformWorkspaceDetail"] {
  return {
    ...platformWorkspace(),
    sanctions: { outcome: "clear", decision: null, createdAt: "2026-09-01T10:05:00.000Z" },
    owners: [{ email: "founder@acme.test" }],
    ...over,
  };
}

export function plan(over: Partial<FundRoomSchemas["Plan"]> = {}): FundRoomSchemas["Plan"] {
  return {
    id: "starter",
    name: "Starter",
    limits: { staffSeats: 5, storageBytes: 10 * 1024 ** 3 },
    billingPriceRef: "price_123",
    billingMeteredPriceRefs: [],
    trialDays: 14,
    public: true,
    archivedAt: null,
    workspaces: 3,
    version: 2,
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: NOW,
    ...over,
  };
}

/** A-3: what `GET /platform/plans` says a plan's lists may name on this build. */
export function entitlementCatalog(): FundRoomSchemas["PlanEntitlementCatalog"] {
  return {
    modules: ["analytics", "captable", "crm", "data-room", "metrics", "notify", "round", "updates"],
    features: [
      "qa",
      "api_keys",
      "webhooks",
      "integrations",
      "esign",
      "accreditation",
      "sso",
      "scim",
      "forensic",
      "anchoring",
      "ai",
      "access_reviews",
    ],
  };
}

export function cell(over: Partial<FundRoomSchemas["Cell"]> = {}): FundRoomSchemas["Cell"] {
  return {
    id: "default",
    region: "eu-central",
    regionLabel: "",
    jurisdiction: null,
    publicOrigin: "",
    status: "active",
    local: true,
    heartbeatAt: null,
    workspaces: 2,
    createdAt: "2026-09-01T10:00:00.000Z",
    ...over,
  };
}

export const MOVE_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6401";

/** E3.11: a move of `acme` from the local cell to a remote one. */
export function move(over: Partial<FundRoomSchemas["Move"]> = {}): FundRoomSchemas["Move"] {
  return {
    id: MOVE_ID,
    workspaceId: WS_ID,
    slug: "acme",
    sourceCellId: "default",
    targetCellId: "us-1",
    sourceRegion: "eu-central",
    targetRegion: "us-east",
    state: "exporting",
    error: null,
    createdAt: "2026-09-27T09:30:00.000Z",
    updatedAt: NOW,
    ...over,
  };
}

export function screening(
  over: Partial<FundRoomSchemas["SanctionsScreeningDetail"]> = {},
): FundRoomSchemas["SanctionsScreeningDetail"] {
  return {
    id: SCREENING_ID,
    workspaceId: WS_ID,
    workspaceSlug: "acme",
    subjectName: "Acme Ventures GmbH",
    subjectCountry: "DE",
    provider: "ofac",
    listVersion: "ofac:0123456789ab:jw1",
    outcome: "potential_match",
    matchCount: 1,
    decision: null,
    decidedAt: null,
    createdAt: "2026-09-27T09:00:00.000Z",
    matches: [
      {
        listEntryId: "OFAC-12345",
        name: "ACME VENTURES LTD",
        score: 0.93,
        programs: ["SDGT"],
        source: "SDN",
      },
    ],
    decidedBy: null,
    decisionNote: null,
    ...over,
  };
}

export function auditEntry(
  over: Partial<FundRoomSchemas["PlatformAuditEntry"]> = {},
): FundRoomSchemas["PlatformAuditEntry"] {
  return {
    id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c6301",
    seq: 12,
    occurredAt: NOW,
    actorKind: "host",
    actorUserId: OPERATOR_ID,
    action: "workspace.suspend",
    resourceKind: "workspace",
    resourceId: WS_ID,
    outcome: "success",
    meta: { operator: true },
    ...over,
  };
}

/** The console with a live operator session and one of everything; `over` replaces handlers. */
export function platformApi(over: Record<string, Handler> = {}) {
  return installMockApi({
    "GET /api/v1/platform/me": () => [200, platformMe()],
    "GET /api/v1/platform/workspaces": () => [
      200,
      { items: [platformWorkspace()], nextCursor: null },
    ],
    "GET /api/v1/platform/workspaces/{id}": () => [200, platformWorkspaceDetail()],
    "GET /api/v1/platform/workspaces/{id}/usage": () => [
      200,
      {
        plan: { id: "starter", name: "Starter", limits: { staffSeats: 5 } },
        today: usageDay({ day: "2026-09-27" }),
        last30: [usageDay({ day: "2026-09-25", staffSeats: 2 }), usageDay()],
      },
    ],
    "GET /api/v1/platform/plans": () => [
      200,
      { plans: [plan()], entitlementCatalog: entitlementCatalog() },
    ],
    "GET /api/v1/platform/cells": () => [
      200,
      { cells: [cell(), cell({ id: "eu-2", region: "eu-west", workspaces: 0 })] },
    ],
    "GET /api/v1/platform/moves": () => [200, { items: [] }],
    "GET /api/v1/platform/sanctions": () => [
      200,
      { items: [(({ matches: _m, decidedBy: _b, decisionNote: _n, ...s }) => s)(screening())] },
    ],
    "GET /api/v1/platform/sanctions/{id}": () => [200, screening()],
    "GET /api/v1/platform/audit": () => [200, { items: [auditEntry()], nextCursor: null }],
    "GET /api/v1/platform/health": () => [
      200,
      {
        queues: [{ name: "sanctions.screen", queued: 4, active: 1 }],
        deadLetters: 2,
        adapters: [
          { name: "db", status: "ok", detail: null },
          { name: "sanctions", status: "fail", detail: "list download failed" },
        ],
        checkedAt: NOW,
      },
    ],
    "GET /api/v1/platform/operators": () => [
      200,
      {
        operators: [
          {
            userId: OPERATOR_ID,
            email: "ops@fundroom.test",
            createdAt: "2026-09-01T10:00:00.000Z",
            createdBy: "cli:root",
            revokedAt: null,
          },
        ],
      },
    ],
    ...over,
  });
}
