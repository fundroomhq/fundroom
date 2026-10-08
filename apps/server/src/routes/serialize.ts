import type {
  DeviceSummary,
  LoginResult,
  MembershipSummary,
  SessionSummary,
} from "@fundroom/identity";
import type { AuthenticatedSession } from "@fundroom/ports";

export function sessionBody(s: AuthenticatedSession) {
  return {
    sessionId: s.sessionId,
    userId: s.userId,
    population: s.population,
    context: s.context,
    authLevel: s.authLevel,
    authTime: s.authTime.toISOString(),
    createdAt: s.createdAt.toISOString(),
    idleExpiresAt: s.idleExpiresAt.toISOString(),
    absoluteExpiresAt: s.absoluteExpiresAt.toISOString(),
    user: {
      displayName: s.user.displayName,
      mfaEnrolled: s.user.mfaEnrolled,
      locale: s.user.locale ?? null,
    },
    // E3.8: the SSO binding, so the SPA can hide account-changing actions for such a session.
    sso:
      s.sso === undefined
        ? null
        : { workspaceId: s.sso.workspaceId, connectionId: s.sso.connectionId },
    // E3.10: the central-auth binding, for the same reason (the SPA points at the canonical host).
    boundWorkspaceId: s.boundWorkspaceId ?? null,
  };
}

export function membershipBody(m: MembershipSummary | undefined) {
  return m ? { id: m.id, kind: m.kind, role: m.role, status: m.status } : null;
}

export function loginBody(r: LoginResult) {
  return {
    session: sessionBody(r.session),
    isNewDevice: r.isNewDevice,
    isNewUser: r.isNewUser,
    membership: membershipBody(r.membership),
  };
}

export function sessionSummaryBody(s: SessionSummary) {
  return {
    id: s.id,
    deviceId: s.deviceId ?? null,
    deviceName: s.deviceName,
    device: s.device,
    ip: s.ip ?? null,
    createdAt: s.createdAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    authLevel: s.authLevel,
    context: s.context,
    current: s.current,
  };
}

export function deviceBody(d: DeviceSummary) {
  return {
    id: d.id,
    name: d.name,
    device: d.device,
    firstSeenAt: d.firstSeenAt.toISOString(),
    lastSeenAt: d.lastSeenAt.toISOString(),
    trusted: d.trusted,
  };
}
