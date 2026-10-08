import type { HostContext, TenantContext, Tx } from "@fundroom/db";
import { type EventPayload, type EventTopic, isEventTopic } from "@fundroom/domain";
import type { ActiveJob, JsonObject } from "@fundroom/ports";

/*
 * Who handles which event (`defineModule({ events: { handles } })`, §5.3). The relay fans
 * one job out per (event, subscriber) so a slow or failing subscriber never blocks the
 * others; the dispatcher routes each job to its subscriber's handler inside a transaction
 * for the event's workspace (`system` context) or the host context for host-level events.
 */
export interface EventEnvelope<T extends EventTopic = EventTopic> {
  readonly outboxId: number;
  readonly topic: T;
  readonly workspaceId: string | null;
  readonly payload: EventPayload<T>;
  readonly schemaVersion: number;
  readonly createdAt: Date;
}

export interface SubscriberContext {
  readonly tx: Tx;
  readonly ctx: TenantContext | HostContext;
  readonly job: ActiveJob;
}

export type EventHandler<T extends EventTopic = EventTopic> = (
  event: EventEnvelope<T>,
  context: SubscriberContext,
) => Promise<void>;

export interface Subscription<T extends EventTopic = EventTopic> {
  readonly topic: T;
  /** `<module>.<purpose>`, unique per topic; part of the job's idempotency key. */
  readonly id: string;
  readonly handler: EventHandler<T>;
}

export const SUBSCRIBER_ID_RE = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9_-]*)+$/u;

export interface SubscriptionRegistry {
  subscribe<T extends EventTopic>(topic: T, id: string, handler: EventHandler<T>): void;
  subscribersFor(topic: string): readonly Subscription[];
  get(topic: string, id: string): Subscription | undefined;
  /** Topics with at least one subscriber. */
  topics(): readonly EventTopic[];
}

export function createSubscriptionRegistry(): SubscriptionRegistry {
  const byTopic = new Map<EventTopic, Map<string, Subscription>>();
  return {
    subscribe(topic, id, handler) {
      if (!isEventTopic(topic)) throw new Error(`unknown event topic ${JSON.stringify(topic)}`);
      if (!SUBSCRIBER_ID_RE.test(id)) {
        throw new Error(`subscriber id ${JSON.stringify(id)} must match <module>.<purpose>`);
      }
      const subs = byTopic.get(topic) ?? new Map<string, Subscription>();
      if (subs.has(id)) throw new Error(`subscriber ${id} already registered for ${topic}`);
      subs.set(id, { topic, id, handler: handler as EventHandler });
      byTopic.set(topic, subs);
    },
    subscribersFor(topic) {
      const subs = byTopic.get(topic as EventTopic);
      return subs ? [...subs.values()] : [];
    },
    get(topic, id) {
      return byTopic.get(topic as EventTopic)?.get(id);
    },
    topics() {
      return [...byTopic.keys()];
    },
  };
}

/** Queue name for a topic's fan-out jobs: `event.<topic>` (dots keep the `<module>.<verb>` shape). */
export function eventQueueName(topic: string): string {
  return `event.${topic}`;
}

/** Job data for one (event, subscriber) pair (a plain JSON object for the queue). */
export interface EventJobData {
  outboxId: number;
  topic: string;
  workspaceId: string | null;
  payload: JsonObject;
  schemaVersion: number;
  createdAt: string;
  subscriber: string;
  [k: string]: JsonObject[string];
}

export function eventJobIdempotencyKey(outboxId: number, subscriber: string): string {
  return `outbox:${outboxId}:${subscriber}`;
}
