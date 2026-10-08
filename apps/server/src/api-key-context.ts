import { AsyncLocalStorage } from "node:async_hooks";
import type { AuditInput, AuditService } from "@fundroom/audit";

/*
 * `meta.apiKeyId` on every audit entry a key request writes (E3.4-A, ADR-0052).
 *
 * The audit service stores `AuditInput.apiKeyId` as `meta.apiKeyId`, but it does not read the
 * request, and the entries a key request produces are written from many places: kernel route
 * handlers, module services, the legal port, the authz service. Threading an `apiKeyId` argument
 * through every one of them would be a change to dozens of call sites and one forgotten call
 * site would be a silent gap in the trail.
 *
 * So the one guard that admits a key (`requirePermission(…, { apiKey: true })`) runs the rest of
 * the request inside `runAsApiKey(id, next)`, and the container hands every consumer an audit
 * service wrapped by `withApiKeyAudit`, which fills `apiKeyId` from that async context when the
 * caller did not pass one. Outside a key request (session requests, jobs, outbox subscribers on
 * the worker) the store is empty and the wrapper is a pass-through. A caller that passes
 * `apiKeyId` explicitly wins.
 */
const store = new AsyncLocalStorage<{ readonly apiKeyId: string }>();

/** Runs `fn` (the rest of the request) as the API key `apiKeyId`. */
export function runAsApiKey<T>(apiKeyId: string, fn: () => T): T {
  return store.run({ apiKeyId }, fn);
}

/** The API key the current request was admitted with, if any. */
export function currentApiKeyId(): string | undefined {
  return store.getStore()?.apiKeyId;
}

function withKey(input: AuditInput): AuditInput {
  if (input.apiKeyId !== undefined) return input;
  const apiKeyId = currentApiKeyId();
  return apiKeyId === undefined ? input : { ...input, apiKeyId };
}

/** `audit` with `apiKeyId` defaulted from the request's async context (see above). */
export function withApiKeyAudit(audit: AuditService): AuditService {
  return {
    record: (tx, ctx, input) => audit.record(tx, ctx, withKey(input)),
    recordDetached: (ctx, input) => audit.recordDetached(ctx, withKey(input)),
    ensurePartitions: (monthsAhead) => audit.ensurePartitions(monthsAhead),
  };
}
