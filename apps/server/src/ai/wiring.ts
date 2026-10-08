import { type AiKernel, type AiLimits, createAiKernel } from "@fundroom/ai";
import { createAnthropicModel } from "@fundroom/ai-anthropic";
import { createOpenAiCompatibleModel } from "@fundroom/ai-openai-compatible";
import type { AuditRecorder } from "@fundroom/audit";
import {
  aiRequestReservation,
  effectiveAiBaseUrl,
  effectiveAiHosting,
  type RawEnv,
} from "@fundroom/config";
import type { Database, TenantContext } from "@fundroom/db";
import type {
  AiFeature,
  ModuleRegistry,
  ModuleServices,
  RegisteredAiTask,
} from "@fundroom/module-kit";
import { createOutboundHttp, type OutboundHttp } from "@fundroom/outbound-http";
import type { JobQueuePort, ModelPort, RateLimiterPort } from "@fundroom/ports";

/*
 * AI assist wiring (E3.12 contract §7; owner: agent A). Picks the model adapter for AI_PROVIDER,
 * on its own guarded outbound client, and builds the `@fundroom/ai` kernel.
 *
 * The client is built like sanctions' operator-named endpoint: the configured AI_BASE_URL host is
 * exempt from the private-address check (a self-hosted Ollama / vLLM / llama.cpp server lives on
 * the operator's private network — operator config, like DATABASE_URL), nothing else is; NO
 * redirects (a redirect is how a key-bearing request reaches a host nobody named); the
 * AI_TIMEOUT_MS deadline; 4 MiB per answer. Tests name their stub hosts in
 * OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS (ignored in prod).
 *
 * `ContainerOptions.aiModel` (a test seam) overrides the env: AI is then available with that
 * port's own `info`.
 */

export const AI_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;

type AiEnv = Pick<
  RawEnv,
  | "APP_ENV"
  | "OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS"
  | "AI_PROVIDER"
  | "AI_BASE_URL"
  | "AI_API_KEY"
  | "AI_MODEL"
  | "AI_HOSTING"
  | "AI_PROVIDER_LABEL"
  | "AI_PROVIDER_LOCATION"
  | "AI_PROVIDER_JURISDICTION"
  | "AI_JSON_MODE"
  | "AI_TOKEN_PARAM"
  | "AI_TIMEOUT_MS"
  | "AI_MAX_OUTPUT_TOKENS"
  | "AI_MAX_INPUT_CHARS"
  | "AI_CONCURRENCY"
  | "AI_MONTHLY_TOKEN_BUDGET"
  | "AI_REQUESTS_PER_USER_HOUR"
  | "AI_RESULT_RETENTION_HOURS"
>;

export interface AiModelWiring {
  /** null = AI unavailable (AI_PROVIDER=none and no test seam). */
  readonly model: ModelPort | null;
  close(): Promise<void>;
}

/** The operator's limits as the kernel takes them. */
export function aiLimitsOf(raw: AiEnv): AiLimits {
  return {
    timeoutMs: raw.AI_TIMEOUT_MS,
    maxOutputTokens: raw.AI_MAX_OUTPUT_TOKENS,
    maxInputChars: raw.AI_MAX_INPUT_CHARS,
    concurrency: raw.AI_CONCURRENCY,
    monthlyTokenBudget: raw.AI_MONTHLY_TOKEN_BUDGET,
    requestsPerUserHour: raw.AI_REQUESTS_PER_USER_HOUR,
    resultRetentionHours: raw.AI_RESULT_RETENTION_HOURS,
    // One formula for the config cross-rule and the kernel (RR1-M3).
    reservationTokens: aiRequestReservation(raw),
  };
}

/** The label tenants see for an openai-compatible server when the operator named none. */
export function defaultOpenAiCompatibleLabel(baseUrl: string): string {
  return `Self-hosted model at ${new URL(baseUrl).host}`;
}

export function createAiModel(
  raw: AiEnv,
  deps: {
    readonly override?: ModelPort | undefined;
    readonly userAgent: string;
    readonly now: () => Date;
    readonly log: Log;
  },
): AiModelWiring {
  if (deps.override !== undefined) return { model: deps.override, async close() {} };
  if (raw.AI_PROVIDER === "none") return { model: null, async close() {} };
  const base = effectiveAiBaseUrl(raw);
  const model = raw.AI_MODEL;
  // Config refuses these combinations at startup; this is the backstop.
  if (base === undefined || model === undefined) {
    throw new Error(`AI_PROVIDER=${raw.AI_PROVIDER} needs AI_MODEL and AI_BASE_URL`);
  }
  const testHosts = raw.APP_ENV === "prod" ? [] : (raw.OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS ?? []);
  const outbound: OutboundHttp = createOutboundHttp({
    allowPrivate: false,
    allowedPrivateHosts: [new URL(base).hostname, ...testHosts],
    userAgent: deps.userAgent,
    timeoutMs: raw.AI_TIMEOUT_MS,
    maxResponseBytes: AI_MAX_RESPONSE_BYTES,
    maxConcurrentLookups: 4,
    maxRedirects: 0,
    log: deps.log,
  });
  // Structured events only: adapters never log prompt or response text.
  const adapterDeps = {
    fetch: outbound.fetch,
    now: deps.now,
    log: (e: Record<string, unknown>) => deps.log("ai.provider", e),
  };
  let port: ModelPort;
  if (raw.AI_PROVIDER === "anthropic") {
    const apiKey = raw.AI_API_KEY;
    if (apiKey === undefined) throw new Error("AI_PROVIDER=anthropic needs AI_API_KEY");
    port = createAnthropicModel(adapterDeps, {
      baseUrl: base,
      apiKey,
      model,
      timeoutMs: raw.AI_TIMEOUT_MS,
    });
  } else {
    port = createOpenAiCompatibleModel(adapterDeps, {
      baseUrl: base,
      apiKey: raw.AI_API_KEY ?? null,
      model,
      hosting: effectiveAiHosting(raw) ?? "third_party",
      label: raw.AI_PROVIDER_LABEL ?? defaultOpenAiCompatibleLabel(base),
      location: raw.AI_PROVIDER_LOCATION ?? null,
      jurisdiction: raw.AI_PROVIDER_JURISDICTION ?? null,
      jsonMode: raw.AI_JSON_MODE,
      tokenParam: raw.AI_TOKEN_PARAM,
      timeoutMs: raw.AI_TIMEOUT_MS,
    });
  }
  return {
    model: port,
    async close() {
      await outbound.close();
    },
  };
}

export interface AiWiringDeps {
  readonly raw: AiEnv;
  readonly model: ModelPort | null;
  readonly db: Database;
  readonly audit: AuditRecorder;
  readonly queue: Pick<JobQueuePort, "sendInTransaction">;
  readonly rateLimiter: RateLimiterPort;
  readonly registry: Pick<ModuleRegistry, "resolveAiTasks">;
  /** Lazy: `ModuleServices` is built after the kernel (it carries `ai`). */
  readonly moduleServices: () => ModuleServices;
  readonly isModuleEnabled: (ctx: TenantContext, module: string) => Promise<boolean>;
  readonly hasPermission: Parameters<typeof createAiKernel>[0]["hasPermission"];
  readonly invalidate: () => void;
  readonly now: () => Date;
  readonly log: Log;
}

export function createAiWiring(deps: AiWiringDeps): AiKernel {
  let tasks: ReadonlyMap<AiFeature, RegisteredAiTask> | undefined;
  return createAiKernel({
    db: deps.db,
    model: deps.model,
    limits: aiLimitsOf(deps.raw),
    rateLimiter: deps.rateLimiter,
    audit: deps.audit,
    queue: deps.queue,
    // Resolved on first use (manifests are fixed for the process), then memoised.
    tasks: () => {
      tasks ??= deps.registry.resolveAiTasks(deps.moduleServices());
      return tasks;
    },
    moduleEnabled: deps.isModuleEnabled,
    // Inside the start tx, on its connection (LegalServices.isErased takes the tx).
    isErased: (tx, ctx, membershipId) =>
      deps.moduleServices().legal.isErased(tx, ctx, membershipId),
    hasPermission: deps.hasPermission,
    invalidate: deps.invalidate,
    // A-3 (ADR-0063): the plan's AI entitlement, through the same port modules get (built after
    // the kernel, hence lazily).
    entitlements: () => deps.moduleServices().entitlements,
    now: deps.now,
    log: deps.log,
  });
}
