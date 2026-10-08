import { httpInstrumentationMiddleware } from "@hono/otel";
import {
  type Attributes,
  type Histogram,
  metrics,
  type Tracer,
  trace,
  type UpDownCounter,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PrometheusExporter, PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { type IMetricReader, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { MiddlewareHandler } from "hono";

/*
 * OpenTelemetry (design/07 §5, §16). One SDK per process:
 *  - traces: OTLP/HTTP when OTEL_EXPORTER_OTLP_ENDPOINT is set (spans from `@hono/otel`
 *    middleware; pg/undici auto-instrumentation needs the ESM loader hook and lands with
 *    the E0.8 entrypoint);
 *  - metrics: always collected in-process and served as Prometheus text at `/metrics`;
 *    additionally pushed over OTLP when the endpoint is set.
 * Attribute cardinality is bounded on purpose: route template, method, status class,
 * workspace id (never emails, never document names).
 */
/** E3.11: the outbound span URL redaction `instrumentation.ts` installs (re-exported). */
import { redactingTracer } from "./telemetry-redact.js";

export {
  REDACTED_PATH,
  redactInboundAttributes,
  redactingTracer,
  redactOutboundUrl,
} from "./telemetry-redact.js";

/**
 * The inbound `@hono/otel` middleware, always through `redactingTracer` (E3.11 RR2-1): request
 * URLs carry share-link / invite tokens and OAuth codes, so a server span keeps only the origin;
 * its name and `http.route` are the route template. `tracer` is a test seam.
 */
export function inboundTracing(options: {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly tracer?: Tracer | undefined;
}): MiddlewareHandler {
  return httpInstrumentationMiddleware({
    serviceName: options.serviceName,
    serviceVersion: options.serviceVersion,
    tracer: redactingTracer(options.tracer ?? trace.getTracer("@hono/otel")),
  });
}

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly otlpEndpoint?: string | undefined;
  /** Push interval for OTLP metrics. Default 60 s. */
  readonly exportIntervalMs?: number | undefined;
}

export interface Telemetry {
  /** Prometheus exposition of every metric the process has recorded. */
  metricsText(): Promise<string>;
  shutdown(): Promise<void>;
  readonly tracingEnabled: boolean;
}

export function startTelemetry(options: TelemetryOptions): Telemetry {
  const prometheus = new PrometheusExporter({ preventServerStart: true });
  const readers: IMetricReader[] = [prometheus];
  const tracing = options.otlpEndpoint !== undefined;
  if (tracing) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: `${options.otlpEndpoint.replace(/\/$/u, "")}/v1/metrics`,
        }),
        exportIntervalMillis: options.exportIntervalMs ?? 60_000,
      }),
    );
  }
  const sdk = new NodeSDK({
    serviceName: options.serviceName,
    metricReaders: readers,
    ...(tracing
      ? {
          traceExporter: new OTLPTraceExporter({
            url: `${options.otlpEndpoint?.replace(/\/$/u, "")}/v1/traces`,
          }),
        }
      : {}),
    autoDetectResources: false,
  });
  sdk.start();
  const serializer = new PrometheusSerializer();
  return {
    tracingEnabled: tracing,
    async metricsText() {
      const { resourceMetrics, errors } = await prometheus.collect();
      if (errors.length > 0) {
        return `# collection errors: ${errors.length}\n${serializer.serialize(resourceMetrics)}`;
      }
      return serializer.serialize(resourceMetrics);
    },
    async shutdown() {
      await sdk.shutdown();
    },
  };
}

export interface HttpMetrics {
  readonly middleware: MiddlewareHandler;
}

/**
 * The one label every catch-all hit gets (E2.10 F-01): the SPA shell, a miss that no route
 * matched, a static file. The raw path is never a label value. It carried share-link and invite
 * tokens (`/s/<token>`, `/invite/<token>`) onto `/metrics`, and every distinct path was a new
 * histogram series, so a stream of random paths grew memory without bound.
 */
export const CATCH_ALL_ROUTE = "/*spa";

/**
 * Metric/log label for a request: the matched route *template* (`/api/v1/links/:token`), which
 * is a finite set fixed by the code, or `CATCH_ALL_ROUTE` for the wildcard routes that serve the
 * SPA (`/*`, `<BASE_PATH>/*`).
 */
export function routeLabel(routePath: string, basePath = ""): string {
  if (routePath === "*" || routePath === "/*" || routePath === `${basePath}/*`) {
    return CATCH_ALL_ROUTE;
  }
  return routePath;
}

export interface HttpMetricsOptions {
  /** BASE_PATH, so `<BASE_PATH>/*` is recognised as the catch-all. */
  readonly basePath?: string | undefined;
}

/** `http.server.request.duration` (seconds) + `http.server.active_requests`, per route template. */
export function createHttpMetrics(options: HttpMetricsOptions = {}): HttpMetrics {
  const basePath = options.basePath ?? "";
  const meter = metrics.getMeter("fundroom.http");
  const duration: Histogram = meter.createHistogram("http.server.request.duration", {
    unit: "s",
    description: "Request duration by route template, method and status",
    advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] },
  });
  const active: UpDownCounter = meter.createUpDownCounter("http.server.active_requests", {
    description: "In-flight requests",
  });
  return {
    middleware: async (c, next) => {
      const started = process.hrtime.bigint();
      active.add(1);
      try {
        await next();
      } finally {
        active.add(-1);
        const elapsed = Number(process.hrtime.bigint() - started) / 1e9;
        const attrs: Attributes = {
          "http.request.method": KNOWN_METHODS.has(c.req.method) ? c.req.method : "_OTHER",
          "http.route": routeLabel(c.req.routePath, basePath),
          "http.response.status_code": c.res.status,
        };
        duration.record(elapsed, attrs);
      }
    },
  };
}

/** The method label is bounded too: an arbitrary token is a valid HTTP method (OTel semconv `_OTHER`). */
const KNOWN_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "CONNECT",
  "TRACE",
]);
