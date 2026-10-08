import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { describe, expect, it } from "vitest";
import { parseFixed, SCALE } from "./decimal.js";
import {
  evaluate,
  FORMULA_MAX_DEPTH,
  FORMULA_MAX_REFS,
  type Formula,
  FormulaSchema,
  referencedKeys,
  wouldCycle,
} from "./formula.js";

const ref = (key: string): Formula => ({ op: "ref", key });
const konst = (value: string): Formula => ({ op: "const", value });
const inputs = (entries: Record<string, string>): ReadonlyMap<string, bigint> =>
  new Map(Object.entries(entries).map(([k, v]) => [k, parseFixed(v) ?? 0n]));

/** `cash / net_burn`: the formula the whole division-by-zero rule exists for. */
const runway: Formula = { op: "div", args: [ref("cash"), ref("net_burn")] };

describe("FormulaSchema", () => {
  it("accepts the shapes an editor produces", () => {
    expect(FormulaSchema.safeParse(ref("arr")).success).toBe(true);
    expect(FormulaSchema.safeParse(konst("12.5")).success).toBe(true);
    expect(FormulaSchema.safeParse({ op: "neg", args: [ref("churn")] }).success).toBe(true);
    expect(FormulaSchema.safeParse(runway).success).toBe(true);
  });

  it("refuses an unknown op, a stray field and a bad key", () => {
    expect(FormulaSchema.safeParse({ op: "pow", args: [ref("a"), ref("b")] }).success).toBe(false);
    expect(FormulaSchema.safeParse({ op: "ref", key: "arr", extra: 1 }).success).toBe(false);
    expect(FormulaSchema.safeParse({ op: "ref", key: "Arr" }).success).toBe(false);
    expect(FormulaSchema.safeParse({ op: "ref", key: "9lives" }).success).toBe(false);
    expect(FormulaSchema.safeParse({ op: "add", args: [ref("a")] }).success).toBe(false);
  });

  it("refuses a constant that is not a decimal the column could hold", () => {
    expect(FormulaSchema.safeParse(konst("1e6")).success).toBe(false);
    expect(FormulaSchema.safeParse(konst("abc")).success).toBe(false);
    expect(FormulaSchema.safeParse(konst("100000000000000")).success).toBe(false);
    expect(FormulaSchema.safeParse(konst("-3.25")).success).toBe(true);
  });

  it("accepts a tree at the depth limit and refuses one past it", () => {
    const nest = (depth: number): Formula =>
      depth <= 1 ? ref("a") : { op: "neg", args: [nest(depth - 1)] };
    expect(FormulaSchema.safeParse(nest(FORMULA_MAX_DEPTH)).success).toBe(true);
    expect(FormulaSchema.safeParse(nest(FORMULA_MAX_DEPTH + 1)).success).toBe(false);
  });

  it("refuses a formula naming more metrics than the recompute fan-out allows", () => {
    // Balanced, so the depth cap does not fire first and mask the ref cap: 8 keys nest four
    // deep, 9 keys five, and both are inside FORMULA_MAX_DEPTH.
    const tree = (keys: readonly string[]): Formula => {
      const [head] = keys;
      if (head === undefined) return konst("0");
      if (keys.length === 1) return ref(head);
      const mid = Math.ceil(keys.length / 2);
      return { op: "add", args: [tree(keys.slice(0, mid)), tree(keys.slice(mid))] };
    };
    const keys = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
    expect(referencedKeys(tree(keys(FORMULA_MAX_REFS))).length).toBe(FORMULA_MAX_REFS);
    expect(FormulaSchema.safeParse(tree(keys(FORMULA_MAX_REFS))).success).toBe(true);
    expect(FormulaSchema.safeParse(tree(keys(FORMULA_MAX_REFS + 1))).success).toBe(false);
  });
});

describe("referencedKeys", () => {
  it("collects the distinct keys, in first-seen order", () => {
    expect(referencedKeys(runway)).toEqual(["cash", "net_burn"]);
    expect(referencedKeys({ op: "sub", args: [ref("a"), ref("a")] })).toEqual(["a"]);
    expect(referencedKeys(konst("1"))).toEqual([]);
  });
});

describe("evaluate", () => {
  it("does the arithmetic at the fixed-point scale", () => {
    expect(evaluate(runway, inputs({ cash: "1200000", net_burn: "100000" }))).toBe(12n * SCALE);
    expect(evaluate({ op: "add", args: [ref("a"), konst("0.5")] }, inputs({ a: "1.25" }))).toBe(
      parseFixed("1.75"),
    );
    expect(evaluate({ op: "neg", args: [ref("a")] }, inputs({ a: "3" }))).toBe(-3n * SCALE);
    expect(evaluate({ op: "mul", args: [ref("a"), ref("b")] }, inputs({ a: "1.5", b: "4" }))).toBe(
      parseFixed("6"),
    );
  });

  it("answers undefined — not zero — when an input is missing", () => {
    expect(evaluate(runway, inputs({ cash: "1200000" }))).toBeUndefined();
    expect(evaluate(runway, inputs({ net_burn: "100000" }))).toBeUndefined();
    expect(evaluate(runway, new Map())).toBeUndefined();
  });

  it("answers undefined for a division by zero, so the chart shows a gap", () => {
    // A month with no burn is not a month with zero runway; writing 0 would read as "out of
    // money" and writing Infinity would put a glyph where a number belongs.
    expect(evaluate(runway, inputs({ cash: "1200000", net_burn: "0" }))).toBeUndefined();
    expect(evaluate(runway, inputs({ cash: "0", net_burn: "0" }))).toBeUndefined();
  });

  it("propagates undefined out of a nested branch", () => {
    const nested: Formula = { op: "add", args: [konst("1"), runway] };
    expect(evaluate(nested, inputs({ cash: "5", net_burn: "0" }))).toBeUndefined();
    expect(evaluate(nested, inputs({ cash: "5" }))).toBeUndefined();
  });
});

describe("wouldCycle", () => {
  it("catches a direct self-reference", () => {
    expect(wouldCycle("a", { op: "add", args: [ref("a"), konst("1")] }, new Map())).toBe(true);
  });

  it("catches a transitive one", () => {
    // a = b, b = c, c = a
    const graph = new Map<string, Formula>([
      ["b", ref("c")],
      ["c", ref("a")],
    ]);
    expect(wouldCycle("a", ref("b"), graph)).toBe(true);
  });

  it("allows a diamond, which is not a cycle", () => {
    // d = b + c, b = a, c = a
    const graph = new Map<string, Formula>([
      ["b", ref("a")],
      ["c", ref("a")],
    ]);
    expect(wouldCycle("d", { op: "add", args: [ref("b"), ref("c")] }, graph)).toBe(false);
  });

  it("allows a formula over metrics that are not derived at all", () => {
    expect(wouldCycle("runway", runway, new Map())).toBe(false);
  });

  it("terminates on a graph that already contains a cycle", () => {
    // A corrupt row must not stop an admin saving a correct formula elsewhere.
    const graph = new Map<string, Formula>([
      ["x", ref("y")],
      ["y", ref("x")],
    ]);
    expect(wouldCycle("z", ref("x"), graph)).toBe(false);
  });
});

/*
 * The schema's *emitted shape*, and the parser's behaviour on hostile input.
 *
 * Both are here because the schema was once written to unroll `FORMULA_MAX_DEPTH` into its
 * structure, which is exponential in the depth: a 199 KB `MetricFormula` component and a
 * 200 KB `MetricDefinition` around it, 6.3 MB of a 6.9 MB `packages/sdk/openapi.json`. Nothing
 * failed — the tests were green, the contract was correct, and the only symptom was a
 * committed artifact nobody could diff. A size assertion is the only thing that catches that
 * class of regression, so there is one.
 */
describe("FormulaSchema shape", () => {
  /** The component as the contract pipeline really emits it, not as `z.toJSONSchema` would. */
  const component = () => {
    const api = new OpenAPIHono();
    api.openapi(
      createRoute({
        method: "get",
        path: "/f",
        responses: {
          200: {
            description: "ok",
            content: { "application/json": { schema: z.object({ f: FormulaSchema }) } },
          },
        },
      }),
      (c) => c.json({ f: ref("a") }),
    );
    const doc = api.getOpenAPI31Document({
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
    });
    return JSON.stringify(doc.components?.schemas?.["MetricFormula"] ?? null);
  };

  it("emits one small component that refers to itself, not an inlined tree", () => {
    const text = component();
    expect(text).toContain('"$ref":"#/components/schemas/MetricFormula"');
    // Recursion expressed as recursion is flat: ~830 bytes. Unrolling the depth into the shape
    // made this 199 099. The ceiling is deliberately far below that and far above the truth.
    expect(text.length).toBeLessThan(2000);
  });
});

describe("FormulaSchema depth guard", () => {
  const nest = (depth: number): Formula =>
    depth <= 1 ? ref("a") : { op: "neg", args: [nest(depth - 1)] };

  it("names the path of the branch that is too deep, not the whole tree", () => {
    // What lets a form highlight the offending node instead of saying "formula too complex".
    const result = FormulaSchema.safeParse(nest(FORMULA_MAX_DEPTH + 1));
    expect(result.success).toBe(false);
    const issues = result.success ? [] : result.error.issues;
    expect(issues).toHaveLength(1);
    // Six levels of `args[0]`: the leaf that sits one past the limit.
    expect(issues[0]?.path).toEqual([
      "args",
      0,
      "args",
      0,
      "args",
      0,
      "args",
      0,
      "args",
      0,
      "args",
      0,
    ]);
    expect(issues[0]?.message).toContain(String(FORMULA_MAX_DEPTH));
  });

  it("refuses a hostile payload without overflowing the stack", () => {
    /*
     * This is a property of the **parser**, not of the validator, which is why the depth is
     * checked in a `preprocess` rather than in a `superRefine` over the parsed value. Measured
     * against the recursive union with no guard in front of it: 2 000 levels (about 42 KB of
     * request body) threw `RangeError: Maximum call stack size exceeded` — a 500 — and 500
     * levels produced 494 issues as the union failed at every level on the way down.
     */
    const hostile = (depth: number) => {
      let node: unknown = ref("a");
      for (let i = 1; i < depth; i++) node = { op: "neg", args: [node] };
      return node;
    };
    for (const depth of [500, 2_000, 50_000]) {
      const result = FormulaSchema.safeParse(hostile(depth));
      expect(result.success).toBe(false);
      // One issue, at one path: the tree is refused before anything descends into it.
      expect(result.success ? [] : result.error.issues).toHaveLength(1);
    }
  });

  it("still accepts a tree at exactly the limit", () => {
    expect(FormulaSchema.safeParse(nest(FORMULA_MAX_DEPTH)).success).toBe(true);
    // And a full-width one, so the guard counts levels rather than nodes.
    const wide: Formula = {
      op: "div",
      args: [
        { op: "add", args: [ref("a"), ref("b")] },
        { op: "sub", args: [ref("c"), ref("d")] },
      ],
    };
    expect(FormulaSchema.safeParse(wide).success).toBe(true);
  });
});
