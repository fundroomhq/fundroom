# @fundroom/events

Transactional outbox, relay, event subscriptions, idempotency keys and job registration. Modules never import
each other; they publish catalogue events (`@fundroom/domain`) and subscribe to them here.

```ts
import { publish, createSubscriptionRegistry, createOutboxRelay, prepareEventQueues,
         registerEventWorkers, registerJobs, onceByKey } from "@fundroom/events";

// 1. In the business transaction (any context): the row commits with the change.
await db.withTenant(ctx, async (tx) => {
  await memberships.revoke(id);
  await publish(tx, ctx, "membership.revoked", { membershipIds: [id], byMembershipId, reason });
});

// 2. Subscriptions are declared by modules (`defineModule({ events: { handles } })`).
const subscriptions = createSubscriptionRegistry();
subscriptions.subscribe("membership.revoked", "data-room.purge-renditions", async (event, { tx, ctx }) => {
  // runs in a system context for event.workspaceId (host context for workspace-less events)
});

// 3. Every process: queues exist. api role: relay. worker role: dispatcher + jobs.
await prepareEventQueues(queue, subscriptions);
createOutboxRelay({ db, queue, subscriptions, pollIntervalMs: config.raw.OUTBOX_POLL_INTERVAL_MS }).start();
await registerEventWorkers({ db, queue, subscriptions });
await registerJobs({ queue, definitions: [...auditJobs, ...identityJobs, ...createEventMaintenanceJobs({ db })], worker: true });
```

- The relay claims rows `FOR UPDATE SKIP LOCKED` in a host transaction and enqueues one job
  per subscriber **in that transaction** (`queue.sendInTransaction`), then marks the row
  processed: exactly-once enqueue, at-least-once delivery. A poison row is retried on its
  own with backoff; `attempts` / `last_error` on the row are the breadcrumbs.
- Handlers are idempotent: `onceByKey(tx, ctx, "updates.send:<id>", fn)` claims a key in
  `core.idempotency_key` inside the effect's transaction; a redelivery skips.
- Jobs are `JobDefinition`s (`<module>.<verb>`, optional cron in UTC); `registerJobs` ensures
  queues everywhere and attaches handlers only where `worker: true`.
- Kernel maintenance: `outbox.sweep` (processed rows older than 7 days) and
  `idempotency.sweep` (expired keys), daily.
