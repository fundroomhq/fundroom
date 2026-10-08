import type { AuditRecorder } from "@fundroom/audit";
import type { Database, TenantContext, Tx } from "@fundroom/db";
import type { LegalSettings } from "@fundroom/domain";
import type { BookingSuppressionKeys } from "@fundroom/integrations";
import type { CertificateIssuer } from "./certificates.js";

/*
 * What the compliance services are given by the composition root.
 *
 * Every service method takes `(ctx, tx, …)` rather than opening its own transaction. That is the
 * whole point of this package: changing the offering status is one transaction that closes a
 * period, opens another, moves a column, writes an audit row and puts an event on the outbox, and
 * an acceptance is one transaction that writes an attestation and bumps `acl_version` so the gate
 * re-evaluates. A service that opened its own transaction could not be composed with the route's.
 */
export interface ComplianceDeps {
  /** Only for the few reads that legitimately run outside a caller's transaction. */
  readonly db: Database;
  readonly audit: AuditRecorder;
  /**
   * Click-wrap certificates (E2.3), wired by the composition root from `@fundroom/clickwrap`.
   *
   * Optional, and that is load-bearing: with no issuer an acceptance behaves exactly as it did
   * before E2.3 — attestation row, audit row, ACL bump, null `evidence_ref`. Declared
   * structurally (`./certificates.js`) so this package never imports `@fundroom/clickwrap` (D1).
   */
  readonly certificates?: CertificateIssuer | undefined;
  readonly now?: () => Date;
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}

/** Resolved `legal` settings for a workspace; the services read them from the workspace row. */
export type ResolvedLegalSettings = LegalSettings;

export type { TenantContext, Tx };

/**
 * What every service that can reach the identity-erasure step needs (E3.6 fix round 2): the
 * workspace keys it hashes an erased person's addresses with, so booking ingest drops their future
 * events (`@fundroom/integrations` suppressions). REQUIRED — a security property must not switch
 * off at a construction site that forgot it. The composition root passes `container.envelope`.
 */
export interface ErasureDeps extends ComplianceDeps {
  readonly bookingSuppressionKeys: BookingSuppressionKeys;
}
