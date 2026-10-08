import { z } from "zod";

/*
 * Zod 4 probes for `eval` (`new Function("")`, caught) to decide whether to JIT object parsers.
 * The throw is swallowed, but under our CSP (no 'unsafe-eval', Trusted Types enforced) the
 * browser still reports a `script-src` and a Trusted Types violation for it. `jitless` skips the
 * probe; the interpreter path is what runs under that policy anyway.
 *
 * Since zod 4.6 the probe runs when an object schema is *constructed*, not when it first parses,
 * and schemas are constructed at module evaluation — before any code in `main.tsx`'s body runs.
 * So this is a side-effect module, and it must stay the first import of `main.tsx`: ES modules
 * evaluate in import order, which puts this ahead of every module that declares a schema.
 */
z.config({ jitless: true });
