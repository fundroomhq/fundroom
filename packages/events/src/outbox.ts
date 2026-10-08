import type { HostContext, TenantContext, Tx } from "@fundroom/db";
import {
  type DomainEvent,
  defineEvent,
  type EventPayload,
  type EventTopic,
} from "@fundroom/domain";
import { insertOutboxRow } from "./repos/outbox-repo.js";

/*
 * Transactional outbox writer (design/06 §1, design/07 §6.2). Call inside the transaction
 * that makes the domain change; the row commits or rolls back with it. The relay turns
 * rows into jobs after commit (`createOutboxRelay`).
 *
 * The workspace on the row comes from the context, never from the payload: a tenant
 * context can only file events for itself (RLS also enforces this), a host context files
 * host-level events (workspace_id NULL) such as `user.created`.
 */
export interface PublishOptions {
  /** Deliver no earlier than this (scheduled sends, digests). */
  readonly availableAt?: Date | undefined;
}

export async function publish<T extends EventTopic>(
  tx: Tx,
  ctx: TenantContext | HostContext,
  topic: T,
  payload: EventPayload<T>,
  options?: PublishOptions,
): Promise<number> {
  return publishEvent(tx, ctx, defineEvent(topic, payload), options);
}

export async function publishEvent(
  tx: Tx,
  ctx: TenantContext | HostContext,
  event: DomainEvent,
  options?: PublishOptions,
): Promise<number> {
  return insertOutboxRow(tx, {
    workspaceId: ctx.actorKind === "host" ? null : ctx.workspaceId,
    topic: event.topic,
    payload: event.payload,
    payloadSchemaVersion: event.schemaVersion,
    availableAt: options?.availableAt,
  });
}
