import {
  type AuthzService,
  type RelationshipEngineHandle,
  type RelationshipEngineMetrics,
  withRelationshipEngine,
} from "@fundroom/authz";
import { createOpenFgaEngine } from "@fundroom/authz-openfga";
import type { AppConfig } from "@fundroom/config";
import type { Database } from "@fundroom/db";
import { createOutboundHttp, type OutboundHttp } from "@fundroom/outbound-http";
import type { JobQueuePort, RelationshipEnginePort } from "@fundroom/ports";
import { metrics } from "@opentelemetry/api";
import type { Log } from "./logger.js";

/*
 * The external relationship engine (E3.13, ADR-0061 §3) around the Postgres authz service.
 * AUTHZ_ENGINE=postgres (the default): the service is returned untouched, byte-for-byte E3.12.
 * AUTHZ_ENGINE=openfga: `@fundroom/authz-openfga` over its own guarded outbound client — the
 * operator configures the one host it may reach (allowed even when private: an operator-run
 * OpenFGA next to the app), no redirects, a response ceiling, a per-request deadline.
 */

/** Response ceiling per OpenFGA call: an authorization model is ≤ 256 KiB, tuple pages are small. */
export const AUTHZ_ENGINE_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export interface AuthzEngineWiring {
  readonly authz: AuthzService;
  /** Null when no external engine is configured. */
  readonly engine: RelationshipEngineHandle | null;
  close(): Promise<void>;
}

let counters:
  | {
      mismatch: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
      errors: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
      dropped: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
      skipped: ReturnType<ReturnType<typeof metrics.getMeter>["createCounter"]>;
    }
  | undefined;

/** `fundroom_authz_*` counters on the process meter (Prometheus at /metrics, OTLP when set). */
export function authzEngineMetrics(): RelationshipEngineMetrics {
  const c = () => {
    if (counters === undefined) {
      const meter = metrics.getMeter("fundroom.authz");
      counters = {
        mismatch: meter.createCounter("fundroom.authz.shadow_mismatch", {
          description:
            "Shadow mode: capabilities on which the external engine and Postgres disagreed (direction pg_only = the engine would deny what Postgres allows)",
        }),
        errors: meter.createCounter("fundroom.authz.engine_errors", {
          description:
            "External authz engine calls that failed (in enforce mode a failed check is a deny)",
        }),
        dropped: meter.createCounter("fundroom.authz.shadow_dropped", {
          description: "Shadow comparisons skipped because the bounded comparison pool was full",
        }),
        skipped: meter.createCounter("fundroom.authz.shadow_skipped", {
          description:
            "Shadow comparisons not attempted (too_deep: the folder chain exceeds the engine's limit)",
        }),
      };
    }
    return counters;
  };
  return {
    shadowMismatch: (l) =>
      c().mismatch.add(1, { capability: l.capability, direction: l.direction }),
    engineError: (l) =>
      c().errors.add(1, {
        operation: l.operation,
        code: /^[a-z_]{1,32}$/u.test(l.code) ? l.code : "other",
      }),
    shadowDropped: () => c().dropped.add(1),
    shadowSkipped: (reason) =>
      c().skipped.add(1, { reason: /^[a-z_]{1,32}$/u.test(reason) ? reason : "other" }),
  };
}

export function createAuthzEngineWiring(deps: {
  readonly raw: AppConfig["raw"];
  readonly db: Database;
  readonly pg: AuthzService;
  /** Read lazily: the queue is built after the authz service in the container. */
  readonly queue: () => Pick<JobQueuePort, "send" | "sendInTransaction">;
  readonly log: Log;
  readonly now: () => Date;
  /** The module registry's resource kinds (declared in every engine model, FIX3 RR2-1). */
  readonly resourceKinds?: (() => Iterable<string>) | undefined;
  /** Test seam: an engine to use instead of the configured adapter. */
  readonly engine?: RelationshipEnginePort | undefined;
}): AuthzEngineWiring {
  const { raw } = deps;
  if (raw.AUTHZ_ENGINE !== "openfga") {
    return { authz: deps.pg, engine: null, close: async () => {} };
  }
  let outbound: OutboundHttp | undefined;
  let engine = deps.engine;
  if (engine === undefined) {
    const url = raw.AUTHZ_OPENFGA_URL;
    if (url === undefined) throw new Error("AUTHZ_ENGINE=openfga needs AUTHZ_OPENFGA_URL");
    outbound = createOutboundHttp({
      allowPrivate: false,
      // The operator-configured engine host only (a service name or private address is normal).
      allowedPrivateHosts: [new URL(url).hostname],
      userAgent: "fundroom-authz-engine/1",
      // A backstop over the adapter's own per-request deadline.
      timeoutMs: raw.AUTHZ_OPENFGA_TIMEOUT_MS + 1_000,
      maxResponseBytes: AUTHZ_ENGINE_MAX_RESPONSE_BYTES,
      maxConcurrentLookups: 8,
      maxRedirects: 0,
      log: deps.log,
    });
    engine = createOpenFgaEngine({
      url,
      apiToken: raw.AUTHZ_OPENFGA_API_TOKEN,
      http: outbound.fetch,
      timeoutMs: raw.AUTHZ_OPENFGA_TIMEOUT_MS,
      log: {
        info: (obj, msg) => deps.log(msg ?? "authz.openfga", obj),
        warn: (obj, msg) => deps.log(msg ?? "authz.openfga", { ...obj, level: "warn" }),
      },
    });
  }
  // Syncs are serialised per workspace by the lease row on core.authz_engine_state (FIX2 C9).
  const authz = withRelationshipEngine(deps.pg, engine, {
    mode: raw.AUTHZ_OPENFGA_MODE,
    sample: raw.AUTHZ_OPENFGA_SHADOW_SAMPLE,
    db: deps.db,
    resourceKinds: deps.resourceKinds,
    queue: {
      send: (...a) => deps.queue().send(...a),
      sendInTransaction: (...a) => deps.queue().sendInTransaction(...a),
    },
    log: deps.log,
    metrics: authzEngineMetrics(),
    now: deps.now,
    callTimeoutMs: raw.AUTHZ_OPENFGA_TIMEOUT_MS + 500,
  });
  deps.log("authz.engine_configured", {
    driver: engine.driver,
    mode: raw.AUTHZ_OPENFGA_MODE,
    sample: raw.AUTHZ_OPENFGA_SHADOW_SAMPLE,
  });
  return {
    authz,
    engine: authz.engine,
    close: async () => {
      await outbound?.close();
    },
  };
}
