// sql-hygiene-allow: fixtures below deliberately contain the forbidden patterns.
import assert from "node:assert/strict";
import { test } from "node:test";
// biome-ignore lint/correctness/useImportExtensions: the module is .mjs; the rule's ".js" fix does not resolve under node --test (CI runs this file directly).
import { findViolations } from "./check-sql-hygiene.mjs";

test("flags session-level SET at statement start", () => {
  assert.equal(findViolations("SET search_path = core;").length, 1);
  assert.equal(findViolations("SELECT 1; SET ROLE x;").length, 1);
  assert.equal(findViolations("await tx.execute(sql`SET app.workspace_id = 'x'`)").length, 1);
  assert.equal(findViolations('conn.query("SET SESSION lock_timeout = 1")').length, 1);
});

test("allows SET LOCAL, UPDATE ... SET, and set_config(..., true)", () => {
  assert.equal(findViolations("SET LOCAL ROLE seedhost_app").length, 0);
  assert.equal(findViolations("SET TRANSACTION READ ONLY").length, 0);
  assert.equal(findViolations("SET CONSTRAINTS ALL DEFERRED").length, 0);
  assert.equal(findViolations("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY").length, 1);
  assert.equal(findViolations("UPDATE t SET a = 1 WHERE b = 2;").length, 0);
  assert.equal(findViolations("insert(t).set({ a: 1 })").length, 0);
  assert.equal(findViolations("SELECT set_config('app.workspace_id', $1, true)").length, 0);
  assert.equal(findViolations("const settings = new Set()").length, 0);
});

test("flags set_config with is_local=false", () => {
  assert.equal(findViolations("SELECT set_config('app.workspace_id', 'x', false)").length, 1);
});
