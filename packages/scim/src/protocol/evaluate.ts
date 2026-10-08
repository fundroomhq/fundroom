import type { FilterNode, FilterValue } from "./filter.js";
import { getCI, type JsonRecord } from "./resources.js";

/*
 * Evaluates a value filter (`[type eq "work"]`, `[value eq "…"]`) against one element of a
 * multi-valued attribute, in memory. Pure. String comparison is case-insensitive (every
 * sub-attribute we evaluate — `type`, `value` holding an email or a lower-case uuid — is
 * `caseExact: false` or already canonical). Nested value paths are not meaningful inside an
 * element and never match.
 */
export function matchesElement(node: FilterNode, element: JsonRecord): boolean {
  switch (node.kind) {
    case "and":
      return matchesElement(node.left, element) && matchesElement(node.right, element);
    case "or":
      return matchesElement(node.left, element) || matchesElement(node.right, element);
    case "not":
      return !matchesElement(node.expr, element);
    case "has":
      return false;
    case "present": {
      const v = getCI(element, node.path.attr);
      return v !== undefined && v !== null && v !== "";
    }
    case "compare": {
      if (node.path.filter !== undefined || node.path.sub !== undefined) return false;
      return compare(getCI(element, node.path.attr), node.op, node.value);
    }
  }
}

function norm(v: unknown): unknown {
  if (typeof v === "string") {
    const l = v.toLowerCase();
    if (l === "true") return true;
    if (l === "false") return false;
    return l;
  }
  return v;
}

function compare(actual: unknown, op: string, expected: FilterValue): boolean {
  const a = norm(actual);
  const e = norm(expected);
  switch (op) {
    case "eq":
      return e === null ? a === undefined || a === null : a === e;
    case "ne":
      return e === null ? a !== undefined && a !== null : a !== e;
    case "co":
      return typeof a === "string" && typeof e === "string" && a.includes(e);
    case "sw":
      return typeof a === "string" && typeof e === "string" && a.startsWith(e);
    case "ew":
      return typeof a === "string" && typeof e === "string" && a.endsWith(e);
    case "gt":
    case "ge":
    case "lt":
    case "le": {
      if (typeof a !== typeof e || (typeof a !== "string" && typeof a !== "number")) return false;
      const x = a as string | number;
      const y = e as string | number;
      if (op === "gt") return x > y;
      if (op === "ge") return x >= y;
      if (op === "lt") return x < y;
      return x <= y;
    }
    default:
      return false;
  }
}
