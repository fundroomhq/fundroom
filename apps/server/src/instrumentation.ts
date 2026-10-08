import { register } from "node:module";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import { redactOutboundUrl } from "./telemetry-redact.js";

/*
 * ESM preload for pg + undici auto-instrumentation (design/07 §5; deferred from E0.6).
 * Loaded with `node --import ./dist/instrumentation.js dist/cli.js serve` (the image's
 * default command): the OpenTelemetry ESM loader hook must be registered before `pg` and
 * `undici` are imported, which no in-process code can guarantee. It is a no-op unless
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is set, so the plain `fundroom` CLI pays nothing.
 */
if (process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]) {
  register("@opentelemetry/instrumentation/hook.mjs", import.meta.url);
  registerInstrumentations({
    instrumentations: [
      new PgInstrumentation({ enhancedDatabaseReporting: false }),
      // Outbound URLs carry secrets (presigned links, Slack webhook paths): origin only.
      new UndiciInstrumentation({ startSpanHook: redactOutboundUrl }),
    ],
  });
}
