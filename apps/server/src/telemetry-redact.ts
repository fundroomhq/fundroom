/*
 * Outbound span redaction (E3.11 R3-7). The undici instrumentation records `url.full`,
 * `url.path` and `url.query` for every outbound request by default, and several of ours carry
 * secrets IN the URL: presigned object-store URLs (signature in the query, workspace object key
 * in the path — a move bundle's is a bearer link to a full workspace export), Slack
 * incoming-webhook paths (the path IS the secret), vendor callback/API paths with account ids.
 * Spans go to whatever OTLP collector the operator configured, so an outbound span keeps only
 * the origin: method, scheme, host and port stay (enough to see which vendor is slow), path and
 * query never leave the process.
 *
 * Kept in its own module (no exporter imports) because `instrumentation.ts` preloads it before
 * anything else is imported.
 */
export const REDACTED_PATH = "/[redacted]";

/** `startSpanHook` for `UndiciInstrumentation`: its attributes override the defaults. */
export function redactOutboundUrl(request: {
  readonly origin: string;
  readonly path: string;
}): Record<string, string> {
  let origin: string;
  try {
    origin = new URL(request.origin).origin;
  } catch {
    origin = "";
  }
  return {
    "url.full": `${origin}${REDACTED_PATH}`,
    "url.path": REDACTED_PATH,
    "url.query": "",
  };
}

/*
 * Inbound span redaction (E3.11 RR2-1). `@hono/otel` puts `url.full: c.req.url` on every server
 * span at start — share-link and invite tokens live in paths (`/api/v1/links/<token>`,
 * `/s/<token>`, `/invite/<token>`), magic-link and OAuth `code`/`state` in queries. The span's
 * name and `http.route` are already the route TEMPLATE, so the full URL adds nothing an operator
 * needs. The mount passes a tracer wrapped here: every span it starts gets `url.full` reduced to
 * the origin (+ `/[redacted]`) before the span exists, so the raw URL is never recorded, not even
 * briefly; `url.path`, `url.query` and `http.target` are redacted the same way if present.
 */
const URL_KEYS = ["url.full", "url.path", "url.query", "http.target", "http.url"] as const;

/** A span-attributes record with every URL-bearing key reduced to origin + a redaction marker. */
export function redactInboundAttributes(
  attributes: Readonly<Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (attributes === undefined) return undefined;
  const out: Record<string, unknown> = { ...attributes };
  for (const key of URL_KEYS) {
    const value = out[key];
    if (value === undefined) continue;
    if (key === "url.full" || key === "http.url") {
      let origin = "";
      try {
        origin = new URL(String(value)).origin;
      } catch {
        origin = "";
      }
      out[key] = `${origin}${REDACTED_PATH}`;
    } else {
      out[key] = key === "url.query" ? "" : REDACTED_PATH;
    }
  }
  return out;
}

/** The subset of the OTel `Tracer` the wrapper needs (kept structural: no SDK import here). */
interface TracerLike {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, unknown> },
    ctx?: unknown,
  ): unknown;
  startActiveSpan(...args: unknown[]): unknown;
}

/**
 * Wraps a tracer so every span started through it (both `startSpan` and every
 * `startActiveSpan` overload) has its URL attributes redacted at creation.
 */
export function redactingTracer<T extends TracerLike>(tracer: T): T {
  const scrub = (options: unknown): unknown => {
    if (options === null || typeof options !== "object") return options;
    const o = options as { attributes?: Record<string, unknown> };
    return { ...o, attributes: redactInboundAttributes(o.attributes) };
  };
  return {
    startSpan: (name: string, options?: unknown, ctx?: unknown) =>
      tracer.startSpan(name, scrub(options) as never, ctx),
    startActiveSpan: (...args: unknown[]) => {
      // (name, fn) | (name, options, fn) | (name, options, context, fn)
      if (args.length >= 3 && typeof args[1] !== "function") args[1] = scrub(args[1]);
      return tracer.startActiveSpan(...args);
    },
  } as unknown as T;
}
