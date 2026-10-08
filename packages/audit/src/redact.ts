import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "@fundroom/ports";

/*
 * Diffs are allowlisted per resource kind with per-field redaction (design/06 §5): a field
 * is either copied, hashed (`email` → `sha256:…16`), or absent. Secrets and tokens never
 * have a policy, so they can never appear. Only fields whose value changed are kept.
 */
export interface DiffPolicy {
  /** Fields copied as-is. */
  readonly copy: readonly string[];
  /** Fields replaced by a truncated hash so equality is provable but the value is not. */
  readonly hash?: readonly string[];
}

export interface AuditDiff extends JsonObject {
  readonly before: JsonObject;
  readonly after: JsonObject;
}

export function hashField(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)}`;
}

function toJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function same(a: JsonValue, b: JsonValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `{ before, after }` restricted to the policy, changed fields only. Returns undefined when
 * nothing allowlisted changed, so callers can skip the `diff` column entirely.
 */
export function diffOf(
  before: Readonly<Record<string, unknown>> | null | undefined,
  after: Readonly<Record<string, unknown>> | null | undefined,
  policy: DiffPolicy,
): AuditDiff | undefined {
  const b: JsonObject = {};
  const a: JsonObject = {};
  const visit = (field: string, hashed: boolean) => {
    const bv = before && field in before ? toJson(before[field]) : null;
    const av = after && field in after ? toJson(after[field]) : null;
    if (same(bv, av)) return;
    if (before && field in before) b[field] = hashed ? hashField(bv) : bv;
    if (after && field in after) a[field] = hashed ? hashField(av) : av;
  };
  for (const f of policy.copy) visit(f, false);
  for (const f of policy.hash ?? []) visit(f, true);
  if (Object.keys(b).length === 0 && Object.keys(a).length === 0) return undefined;
  return { before: b, after: a };
}
