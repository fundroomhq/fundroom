import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/*
 * Vitest setup file (unit + integration projects): every test file gets its own temp root.
 *
 * Tests create scratch directories with `mkdtempSync(join(tmpdir(), "fundroom-…"))` — storage
 * roots, DATA_DIR, export zips, migration and web-dist fixtures — and most of them never removed
 * them, so thousands piled up under $TMPDIR. `os.tmpdir()` reads TMPDIR on every call, so pointing
 * it at a per-file directory here puts all of them (and anything a spawned child writes) under one
 * root that is removed when the file finishes. Hooks run as a stack, so this `afterAll` runs after
 * the file's own (servers stopped, streams closed) and before the next file.
 */
const env = process.env; // TMPDIR is the OS's, not a build input turbo should hash.
const previous = env.TMPDIR;
const root = mkdtempSync(join(tmpdir(), "fundroom-test-"));
env.TMPDIR = root;

afterAll(() => {
  if (previous === undefined) delete env.TMPDIR;
  else env.TMPDIR = previous;
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});
