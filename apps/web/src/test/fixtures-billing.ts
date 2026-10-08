import type { FundRoomSchemas } from "@fundroom/sdk";
import { bootstrap, me, membership, session } from "./fixtures.js";

/*
 * Billing, usage and workspace-status fixtures (E3.10): the tenant billing page, the admin-shell
 * banners and the investor "portal unavailable" screen.
 */
export const OWNER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5f11";

export function staffMe(role = "owner"): FundRoomSchemas["Me"] {
  return me({
    session: session({
      population: "staff",
      authLevel: 2,
      user: { displayName: "Grace Hopper", mfaEnrolled: true, locale: null },
    }),
    membership: membership({ id: OWNER_ID, kind: "staff", role }),
  });
}

export function staffBootstrap(
  over: {
    permissions?: string[];
    role?: string;
    workspaceStatus?: FundRoomSchemas["ModulesBootstrap"]["workspaceStatus"];
    /** More module descriptors after billing and branding (A-3: read-only modules). */
    modules?: FundRoomSchemas["ModuleDescriptor"][];
  } = {},
): FundRoomSchemas["ModulesBootstrap"] {
  return bootstrap({
    modules: [
      {
        id: "billing",
        version: "0.1.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "admin.settings": [
            { id: "billing", label: "Billing", to: "/admin/billing", order: 38, icon: "billing" },
          ],
        },
      },
      {
        id: "branding",
        version: "0.1.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "admin.settings": [
            { id: "branding", label: "Branding", to: "/admin/branding", order: 30 },
          ],
          "admin.nav": [{ id: "settings", label: "Settings", to: "/admin/settings", order: 90 }],
        },
      },
      ...(over.modules ?? []),
    ],
    permissions: over.permissions ?? ["billing.read", "billing.manage"],
    membership: { id: OWNER_ID, kind: "staff", role: over.role ?? "owner" },
    workspaceStatus: over.workspaceStatus ?? null,
  });
}

export function billingSubscription(
  over: Partial<FundRoomSchemas["BillingSubscription"]> = {},
): FundRoomSchemas["BillingSubscription"] {
  return {
    planId: "starter",
    planName: "Starter",
    status: "active",
    currentPeriodEnd: "2026-10-27T00:00:00.000Z",
    trialEnd: null,
    cancelAtPeriodEnd: false,
    graceUntil: null,
    ...over,
  };
}

export function billingPlan(
  over: Partial<FundRoomSchemas["BillingPlan"]> = {},
): FundRoomSchemas["BillingPlan"] {
  return {
    id: "starter",
    name: "Starter",
    limits: { staffSeats: 3, investorSeats: 50, storageBytes: 5 * 1024 ** 3, customDomains: 1 },
    trialDays: 14,
    ...over,
  };
}

export function billingOverview(
  over: Partial<FundRoomSchemas["BillingOverview"]> = {},
): FundRoomSchemas["BillingOverview"] {
  return {
    driver: "stripe",
    subscription: billingSubscription(),
    plans: [
      billingPlan(),
      billingPlan({
        id: "growth",
        name: "Growth",
        limits: { staffSeats: 10, investorSeats: 500 },
        trialDays: 0,
      }),
    ],
    canManage: true,
    ...over,
  };
}

export function usageDay(
  over: Partial<FundRoomSchemas["UsageDay"]> = {},
): FundRoomSchemas["UsageDay"] {
  return {
    day: "2026-09-27",
    storageBytes: 2 * 1024 ** 3,
    docsViewed: 12,
    emailsSent: 7,
    staffSeats: 2,
    investorSeats: 61,
    customDomains: 1,
    computedAt: "2026-09-27T00:15:00.000Z",
    ...over,
  };
}

export function workspaceUsage(
  over: Partial<FundRoomSchemas["WorkspaceUsage"]> = {},
): FundRoomSchemas["WorkspaceUsage"] {
  return {
    plan: { id: "starter", name: "Starter", limits: billingPlan().limits },
    today: usageDay(),
    last30: [
      usageDay({ day: "2026-08-31", emailsSent: 100 }),
      usageDay({ day: "2026-09-01", emailsSent: 5 }),
      usageDay({ day: "2026-09-26", emailsSent: 3 }),
      usageDay(),
    ],
    ...over,
  };
}
