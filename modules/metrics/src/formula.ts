import { z } from "@hono/zod-openapi";
import { add, div, mul, parseFixed, sub } from "./decimal.js";
import { METRIC_KEY_RE } from "./model.js";

/*
 * Derived metrics (E2.4 §6). Pure: no drizzle, no pg, no clock.
 *
 * A formula is a small expression tree over other definitions' keys, evaluated **per period**.
 * It is deliberately not an expression *string* with a parser: a string invites `eval`, a
 * hand-rolled tokeniser, or a dependency, and all three make the stored jsonb something a
 * reviewer has to execute in their head to audit. A tree validates structurally and
 * `referencedKeys` is a walk rather than a regex over user text.
 */

export const FORMULA_SCHEMA_VERSION = 1;

/**
 * Depth 6 covers the formulas anybody has asked for (`(a - b) / c`, `a / (b + c)`), and the
 * ceiling exists because the tree arrives as jsonb from a request: without it a nested payload
 * is an unbounded recursion in `evaluate` before it is a bad formula.
 *
 * It is counted in **nodes from the root**, root included: a bare `ref` is 1, `neg(ref)` is 2.
 */
export const FORMULA_MAX_DEPTH = 6;

/**
 * Distinct inputs one formula may name. The cap is the recompute cost, not the arithmetic: a
 * points write fans out to every derived definition whose inputs intersect it, so each extra
 * reference widens that fan-out for every write forever.
 */
export const FORMULA_MAX_REFS = 8;

export type Formula =
  | { readonly op: "ref"; readonly key: string }
  | { readonly op: "const"; readonly value: string }
  | { readonly op: "neg"; readonly args: readonly [Formula] }
  | { readonly op: "add" | "sub" | "mul" | "div"; readonly args: readonly [Formula, Formula] };

/** Constants travel as decimal **strings** for the reason in `decimal.ts`: 0.1 is not a float. */
const ConstSchema = z
  .object({ op: z.literal("const"), value: z.string().min(1).max(32) })
  .strict()
  .refine((c) => parseFixed(c.value) !== undefined, {
    message: "value must be a decimal number that fits numeric(20, 6)",
  });

const RefSchema = z.object({ op: z.literal("ref"), key: z.string().regex(METRIC_KEY_RE) }).strict();

const BINARY_OPS = ["add", "sub", "mul", "div"] as const;

/**
 * The first node deeper than `FORMULA_MAX_DEPTH`, as the path to it — or `undefined`.
 *
 * Two properties, and both are the reason this is not the obvious recursive one-liner.
 *
 * It is **iterative**, with an explicit stack: it runs on unvalidated request data, so a
 * recursive walk would be the very stack overflow it exists to prevent. And it returns a
 * *path* rather than a boolean, so the issue lands on the offending node and a form can point
 * at the branch that is too deep instead of saying "formula too complex" about the whole tree.
 *
 * It reads the raw value structurally (anything with an `args` array is an interior node) and
 * judges nothing else. A payload that is deep *and* malformed gets this issue and then fails
 * the union on its own merits; a payload that is merely malformed never reaches here.
 */
function tooDeepPath(root: unknown): (string | number)[] | undefined {
  const stack: { node: unknown; level: number; path: (string | number)[] }[] = [
    { node: root, level: 1, path: [] },
  ];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) continue;
    if (frame.level > FORMULA_MAX_DEPTH) return frame.path;
    if (frame.node === null || typeof frame.node !== "object") continue;
    const args = (frame.node as { args?: unknown }).args;
    if (!Array.isArray(args)) continue;
    // Right to left, so the leftmost branch is reported when several are too deep — the one a
    // reader's eye reaches first.
    for (let i = args.length - 1; i >= 0; i--) {
      stack.push({
        node: args[i],
        level: frame.level + 1,
        path: [...frame.path, "args", i],
      });
    }
  }
  return undefined;
}

/**
 * The expression tree, as a **self-referential** schema.
 *
 * It used to be built by unrolling the depth limit into the shape — `formulaAtDepth(6)` — and
 * that was a real mistake, worth recording because it looked like the careful option. Each
 * binary node holds two copies of the subtree below it, so the *schema* is exponential in the
 * depth: the emitted `MetricFormula` component was 199 KB and `MetricDefinition`, which embeds
 * it, another 200 KB. Between them they were 6.3 MB of a 6.9 MB `packages/sdk/openapi.json` —
 * against 2 KB for the next largest schema in the whole API — which made every contract diff
 * unreadable, carried the same blowup into the SDK types every consumer compiles, and tripped
 * Biome's file-size ceiling. `z.lazy` emits one 828-byte component with a `$ref` back to
 * itself, which is what the shape actually is.
 *
 * The depth is therefore a **check**, not a shape — but it has to run *before* the recursive
 * descent, which is why it is a `preprocess` and not the `superRefine` that reads more
 * naturally. A `superRefine` walks an already-parsed value, and parsing is exactly what a
 * hostile payload attacks: measured here, a 2 000-deep tree threw `RangeError: Maximum call
 * stack size exceeded` out of zod (a 500, from ~42 KB of request body) and a 500-deep one
 * produced 494 issues as the union failed at every level. Guarding first turns both into one
 * issue, at one path, with no recursion at all. The unrolled shape used to get that bound for
 * free — losing it silently is the trap this comment exists to close.
 */
const FormulaNode = z.lazy(() =>
  z.union([
    RefSchema,
    ConstSchema,
    z.object({ op: z.literal("neg"), args: z.tuple([FormulaSchema]) }).strict(),
    z.object({ op: z.enum(BINARY_OPS), args: z.tuple([FormulaSchema, FormulaSchema]) }).strict(),
  ]),
);

export const FormulaSchema: z.ZodType<Formula> = z
  .preprocess((raw, ctx) => {
    const path = tooDeepPath(raw);
    if (path !== undefined) {
      ctx.addIssue({
        code: "custom",
        path,
        message: `a formula may nest at most ${FORMULA_MAX_DEPTH} levels deep`,
      });
    }
    return raw;
  }, FormulaNode)
  /*
   * The reference cap is a *semantic* rule about a tree that already parsed, so unlike the
   * depth it belongs after: it is counted with the real `referencedKeys` rather than by
   * guessing at raw input, and it cannot fire on a payload that was never a formula.
   */
  .refine((f) => referencedKeys(f as Formula).length <= FORMULA_MAX_REFS, {
    message: `a formula may reference at most ${FORMULA_MAX_REFS} metrics`,
  })
  .openapi("MetricFormula") as z.ZodType<Formula>;

/** The distinct definition keys a formula reads, in first-seen order. */
export function referencedKeys(f: Formula): readonly string[] {
  const seen = new Set<string>();
  const visit = (node: Formula): void => {
    if (node.op === "ref") {
      seen.add(node.key);
      return;
    }
    if (node.op === "const") return;
    for (const arg of node.args) visit(arg);
  };
  visit(f);
  return [...seen];
}

/**
 * Evaluates one period's worth of inputs.
 *
 * `undefined` when an input is missing or a division by zero happened — **not** zero, and not
 * `Infinity`. `runway = cash / net_burn` in a month with no burn has no answer; writing zero
 * would tell a founder they have run out of money, and writing `Infinity` would put a glyph in
 * an email where a number belongs. A derived period with no point is a gap in the chart, which
 * is what actually happened.
 */
export function evaluate(f: Formula, inputs: ReadonlyMap<string, bigint>): bigint | undefined {
  switch (f.op) {
    case "ref":
      return inputs.get(f.key);
    case "const":
      return parseFixed(f.value);
    case "neg": {
      const [only] = f.args;
      const v = evaluate(only, inputs);
      return v === undefined ? undefined : -v;
    }
    default: {
      const [leftNode, rightNode] = f.args;
      const left = evaluate(leftNode, inputs);
      if (left === undefined) return undefined;
      const right = evaluate(rightNode, inputs);
      if (right === undefined) return undefined;
      switch (f.op) {
        case "add":
          return add(left, right);
        case "sub":
          return sub(left, right);
        case "mul":
          return mul(left, right);
        default:
          return div(left, right);
      }
    }
  }
}

/**
 * Would making `key` compute `f` create a cycle, directly (`a = a + 1`) or through others
 * (`a = b`, `b = c`, `c = a`)? Called before a derived definition is saved, which is what lets
 * the recompute cascade cap itself at the graph depth instead of counting iterations.
 *
 * `graph` maps each *other* key to its formula; it need not contain `key`, and a cycle already
 * present in it terminates the walk rather than hanging it, because a corrupt row must not be
 * able to stop an admin from saving a correct formula.
 */
export function wouldCycle(key: string, f: Formula, graph: ReadonlyMap<string, Formula>): boolean {
  const seen = new Set<string>();
  const pending = [...referencedKeys(f)];
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) continue;
    if (next === key) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    const dependency = graph.get(next);
    if (dependency !== undefined) pending.push(...referencedKeys(dependency));
  }
  return false;
}
