import type { JsonObject } from "./jobs.js";

/**
 * Audit sink (EXECUTION_PLAN §5.2 `AuditSinkPort`, design/02 §6). The system of record is
 * Postgres `audit.event`, written by `@fundroom/audit` in the business transaction. Sinks
 * are *additional* destinations (syslog, OTel, a SIEM) fed after commit through the outbox,
 * at least once; they receive the finalised row including its chain hash so the receiver can
 * verify continuity on its side.
 */
export type AuditActorKind = "staff" | "external" | "system" | "host";
export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditEventRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly seq: number;
  readonly occurredAt: Date;
  readonly actorKind: AuditActorKind;
  readonly actorMembershipId: string | null;
  readonly actorUserId: string | null;
  readonly onBehalfOfMembershipId: string | null;
  readonly action: string;
  readonly resourceKind: string;
  readonly resourceId: string | null;
  readonly subjectMembershipId: string | null;
  readonly outcome: AuditOutcome;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly requestId: string | null;
  readonly sessionId: string | null;
  readonly diff: JsonObject | null;
  readonly meta: JsonObject;
  /** Hex. */
  readonly prevHash: string | null;
  /** Hex SHA-256 of the canonical row. */
  readonly hash: string;
}

export interface AuditSinkPort {
  deliver(events: readonly AuditEventRecord[]): Promise<void>;
}
