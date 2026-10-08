import { type Database, systemContext } from "@fundroom/db";
import { type EventTopic, parseEventPayload } from "@fundroom/domain";
import type { JobQueuePort, WorkOptions } from "@fundroom/ports";
import {
  type EventEnvelope,
  type EventJobData,
  eventQueueName,
  type SubscriptionRegistry,
} from "./subscriptions.js";

/*
 * Worker side of the outbox: one pg-boss worker per subscribed topic, routing each job to
 * the named subscriber inside a transaction for the event's workspace. Handler throws →
 * pg-boss retries with backoff → dead-letter queue.
 */
export interface EventDispatcherOptions {
  readonly db: Database;
  readonly queue: JobQueuePort;
  readonly subscriptions: SubscriptionRegistry;
  readonly work?: WorkOptions;
  readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
}

export async function registerEventWorkers(options: EventDispatcherOptions): Promise<void> {
  const { db, queue, subscriptions } = options;
  const log = options.log ?? (() => {});
  for (const topic of subscriptions.topics()) {
    await queue.work<EventJobData>(
      eventQueueName(topic),
      async (job) => {
        const sub = subscriptions.get(topic, job.data.subscriber);
        if (!sub) {
          throw new Error(`no subscriber ${job.data.subscriber} for ${topic} in this process`);
        }
        const envelope: EventEnvelope = {
          outboxId: job.data.outboxId,
          topic: topic as EventTopic,
          workspaceId: job.data.workspaceId,
          payload: parseEventPayload(topic, job.data.payload, job.data.schemaVersion),
          schemaVersion: job.data.schemaVersion,
          createdAt: new Date(job.data.createdAt),
        };
        const started = performance.now();
        if (envelope.workspaceId === null) {
          await db.withHost((tx, ctx) => sub.handler(envelope, { tx, ctx, job }));
        } else {
          const ctx = systemContext(envelope.workspaceId);
          await db.withTenant(ctx, (tx) => sub.handler(envelope, { tx, ctx, job }));
        }
        log("events.handled", {
          topic,
          subscriber: sub.id,
          outboxId: envelope.outboxId,
          durationMs: Math.round(performance.now() - started),
        });
      },
      options.work,
    );
  }
}
