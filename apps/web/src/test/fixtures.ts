import type { FundRoomSchemas } from "@fundroom/sdk";
import type { WebConfig } from "../lib/config.js";

export const WS_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6a";
export const USER_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6b";
export const SESSION_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6c";
export const MEMBERSHIP_ID = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b6d";

export function testConfig(over: Partial<WebConfig> = {}): WebConfig {
  return {
    v: 1,
    instanceName: "FundRoom",
    serverVersion: "0.1.0-test",
    tenancy: "single",
    basePath: "",
    routerBase: "",
    apiBase: "http://localhost",
    tree: "app",
    workspace: { slug: "acme", name: "Acme" },
    canonicalOrigin: "https://investors.acme.test",
    embedOrigins: [],
    auth: { methods: ["email_otp", "passkey"], passkeyRpId: "localhost" },
    setupRequired: false,
    branding: null,
    ...over,
  };
}

export function session(
  over: Partial<FundRoomSchemas["Session"]> = {},
): FundRoomSchemas["Session"] {
  const now = "2026-09-11T10:00:00.000Z";
  return {
    sessionId: SESSION_ID,
    userId: USER_ID,
    population: "external",
    context: "first_party",
    authLevel: 1,
    authTime: now,
    createdAt: now,
    idleExpiresAt: "2026-09-12T10:00:00.000Z",
    absoluteExpiresAt: "2026-10-11T10:00:00.000Z",
    user: { displayName: "Ada Lovelace", mfaEnrolled: false, locale: null },
    sso: null,
    ...over,
  };
}

export function membership(
  over: Partial<FundRoomSchemas["MembershipSummary"]> = {},
): FundRoomSchemas["MembershipSummary"] {
  return { id: MEMBERSHIP_ID, kind: "external", role: "investor", status: "active", ...over };
}

export function me(over: Partial<FundRoomSchemas["Me"]> = {}): FundRoomSchemas["Me"] {
  const mem = membership();
  return {
    session: session(),
    membership: mem,
    workspaces: [
      {
        workspaceId: WS_ID,
        membershipId: mem.id,
        kind: mem.kind,
        role: mem.role,
        status: mem.status,
      },
    ],
    viewAs: null,
    ...over,
  };
}

export function bootstrap(
  over: Partial<FundRoomSchemas["ModulesBootstrap"]> = {},
): FundRoomSchemas["ModulesBootstrap"] {
  return {
    workspace: {
      id: WS_ID,
      slug: "acme",
      name: "Acme",
      offeringStatus: "none",
      defaultLocale: "en",
    },
    // Nothing outstanding: the acceptance interstitial (E1.6) is not what these tests are about.
    pendingAcceptances: [],
    viewAs: null,
    pseudoLocale: false,
    requestAccessEnabled: false,
    bookingLinksAvailable: false,
    ssoRequired: false,
    ssoBreakGlass: false,
    workspaceStatus: null,
    modules: [
      {
        id: "updates",
        version: "1.0.0",
        enabled: true,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: {
          "investor.nav": [{ id: "updates", label: "Updates", to: "/updates", order: 10 }],
          "admin.nav": [{ id: "updates-admin", label: "Updates", to: "/admin/updates", order: 10 }],
        },
      },
      {
        id: "data-room",
        version: "1.0.0",
        enabled: false,
        hidden: false,
        readOnly: false,
        flags: {},
        slots: { "investor.nav": [{ id: "dr", label: "Data room", to: "/data-room", order: 20 }] },
      },
    ],
    permissions: ["updates.read"],
    membership: { id: MEMBERSHIP_ID, kind: "external", role: "investor" },
    ...over,
  };
}

export function login(over: Partial<FundRoomSchemas["Login"]> = {}): FundRoomSchemas["Login"] {
  return {
    session: session(),
    isNewDevice: false,
    isNewUser: false,
    membership: membership(),
    ...over,
  };
}
