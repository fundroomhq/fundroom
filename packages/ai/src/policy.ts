import { createHash } from "node:crypto";
import type { AiSettings } from "@fundroom/domain";
import type { AiFeature } from "@fundroom/module-kit";
import type { ModelProviderInfo } from "@fundroom/ports";

/*
 * Pure rules of the AI kernel (E3.12 contract §5/§7): the provider identity an acknowledgement
 * binds to, the effective feature state, the budget, UTC months and model-output parsing.
 */

/** `settings.ai.acknowledgement.providerKey` is at most this long (domain + contracts + 0025). */
export const AI_PROVIDER_KEY_MAX = 400;

/**
 * The identity an acknowledgement binds to: the JSON array
 * `[id, hosting, label, model, location, jurisdiction]` (JSON so no two identities can collide
 * through a delimiter inside an operator string, RR1-L6). When the operator changes any of these —
 * including WHERE the provider runs (R1-M4) — every workspace's acknowledgement stops matching and
 * its AI features are effectively off until an `ai.manage` holder acknowledges again. A key longer
 * than 400 characters is replaced by `${id}|${hosting}|sha256:<hex of the full key>`.
 */
export function aiProviderKey(
  info: Pick<ModelProviderInfo, "id" | "hosting" | "label" | "model" | "location" | "jurisdiction">,
): string {
  const full = JSON.stringify([
    info.id,
    info.hosting,
    info.label,
    info.model,
    info.location,
    info.jurisdiction,
  ]);
  if (full.length <= AI_PROVIDER_KEY_MAX) return full;
  return `${info.id}|${info.hosting}|sha256:${createHash("sha256").update(full).digest("hex")}`;
}

// Unpaired UTF-16 surrogates, NUL and the two BMP noncharacters: Postgres jsonb refuses NUL and
// lone surrogates outright (R1-H2: the finish transaction threw and leaked the result into the
// job table); U+FFFE/U+FFFF are never valid text.
const INVALID_TEXT_RE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uFFFE\uFFFF]/gu;

/** Drops invalid code points from one string. */
export function sanitizeText(s: string): string {
  return s.replace(INVALID_TEXT_RE, "").replaceAll(String.fromCharCode(0), "");
}

/**
 * A task result made safe to store: every string (and key) without lone surrogates, NUL or
 * noncharacters; non-finite numbers → null; anything that is not JSON (undefined, functions) dropped.
 */
export function sanitizeJson(v: unknown): unknown {
  if (typeof v === "string") return sanitizeText(v);
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean" || v === null) return v;
  if (Array.isArray(v)) return v.map((x) => sanitizeJson(x) ?? null);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const clean = sanitizeJson(x);
      if (clean !== undefined) out[sanitizeText(k)] = clean;
    }
    return out;
  }
  return undefined;
}

export interface AiFeatureFlags {
  readonly updateDraft: boolean;
  readonly qaAnswer: boolean;
}

/** `update_draft` → `updateDraft`, `qa_answer` → `qaAnswer` (the settings block's keys). */
export function flagOf(feature: AiFeature): keyof AiFeatureFlags {
  return feature === "update_draft" ? "updateDraft" : "qaAnswer";
}

/** The workspace acknowledged exactly the provider identity in force now. */
export function acknowledged(settings: AiSettings, info: ModelProviderInfo | null): boolean {
  return info !== null && settings.acknowledgement?.providerKey === aiProviderKey(info);
}

/**
 * Effective feature F on = operator available ∧ `enabled` ∧ `features[F]` ∧ the acknowledgement
 * binds to the CURRENT provider identity.
 */
export function effectiveAiFeatures(
  settings: AiSettings,
  info: ModelProviderInfo | null,
): AiFeatureFlags {
  const on = info !== null && settings.enabled && acknowledged(settings, info);
  return {
    updateDraft: on && settings.features.updateDraft,
    qaAnswer: on && settings.features.qaAnswer,
  };
}

/** A workspace may lower the operator's monthly cap, never raise it. */
export function effectiveBudget(settings: AiSettings, operatorCap: number): number {
  const own = settings.monthlyTokenBudget;
  return own === null ? operatorCap : Math.min(own, operatorCap);
}

/** `YYYY-MM-01` of the UTC month containing `at` (the usage row key). */
export function usageMonth(at: Date): string {
  return `${at.toISOString().slice(0, 7)}-01`;
}

/** Milliseconds until the next UTC month starts (Retry-After of `ai_budget_exhausted`). */
export function msUntilNextMonth(at: Date): number {
  const next = Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return Math.max(1000, next - at.getTime());
}

/**
 * Model text → JSON: drops `<think>…</think>` blocks (reasoning models put them first) and a
 * surrounding ``` fence, then parses. `undefined` when it is not JSON (or not an object/array).
 */
export function parseModelJson(text: string):
  | { readonly ok: true; readonly json: unknown }
  | {
      readonly ok: false;
    } {
  let s = text.replace(/<think>[\s\S]*?<\/think>/gu, "");
  // An unterminated think block (output cut) leaves nothing usable before its end.
  s = s.replace(/<think>[\s\S]*$/u, "").trim();
  const fence = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/u.exec(s);
  if (fence !== null) s = (fence[1] ?? "").trim();
  if (!s.startsWith("{") && !s.startsWith("[")) {
    // Prose around a single object: take the outermost braces.
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first < 0 || last <= first) return { ok: false };
    s = s.slice(first, last + 1);
  }
  try {
    const json: unknown = JSON.parse(s);
    return typeof json === "object" && json !== null ? { ok: true, json } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** A process-wide counting semaphore (model calls in flight, `AI_CONCURRENCY`). */
export class Semaphore {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly size: number) {}

  get inUse(): number {
    return this.active;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted === true) throw signal.reason ?? new Error("aborted");
    if (this.active < this.size) {
      this.active += 1;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(wake);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(wake);
    });
    // The releaser handed its slot over: `active` is unchanged.
    return this.releaser();
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.waiting.shift();
      if (next !== undefined) next();
      else this.active -= 1;
    };
  }
}
