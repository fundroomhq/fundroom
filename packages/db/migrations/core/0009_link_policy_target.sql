-- 0009_link_policy_target — teach core.access_policy's shape CHECK about the `link` target
-- (EXECUTION_PLAN §6.4 and §11, E2.3 at :909; design/04 §8 R11/R6; ADR-0004, ADR-0014, ADR-0041).
--
-- Hand-written (ADR-0004). The TypeScript view is src/schema/access.ts. Runs inside one
-- transaction and creates no table, so there is no fence to declare. drizzle-kit draws no
-- distinction between this file and 0008 — it drafted both as one migration, which is the
-- very thing that fails — so the shared snapshot is meta/0008_snapshot.json and there is no
-- 0009 journal entry. The runner reads *.sql and ignores meta/, so nothing depends on one.
--
-- This is a separate file from 0008 rather than its last statement because of a Postgres rule
-- with no way around it: ALTER TYPE ... ADD VALUE is permitted inside a transaction block, but
-- the value it adds cannot be *used* until that transaction commits. Recreating the CHECK below
-- uses it — planning `target_kind = 'link'` resolves the literal to
-- 'link'::core.policy_target_kind — so doing both in one file fails with "unsafe use of new
-- value of enum type" on PG 16 and PG 18 alike, with zero rows in the table. The alternative
-- was a `-- seedhost: no-transaction` file; a second ordinary, transactional migration is the
-- cheaper answer, because a failure here then rolls back on its own instead of leaving the
-- constraint dropped and never recreated.
--
-- The `link` arm mirrors the `group`/`membership` arm — a target id, no resource kind — because
-- a link-targeted gate names the link and nothing else. What it must NOT do is share that arm:
-- `target_kind IN ('group', 'membership', 'link')` would read as "these three are the same
-- thing", and they are not. A group or a membership gate follows a person; a link gate follows
-- the *door* they came through, and applies to a principal only while `share_link_visit` still
-- binds them to that link. Spelling it out as its own line keeps the next reader from widening
-- the wrong one.

ALTER TABLE core.access_policy DROP CONSTRAINT access_policy_target_shape;

ALTER TABLE core.access_policy ADD CONSTRAINT access_policy_target_shape CHECK (
  (target_kind = 'workspace' AND target_id IS NULL AND resource_kind IS NULL)
  OR (target_kind IN ('group', 'membership') AND target_id IS NOT NULL AND resource_kind IS NULL)
  OR (target_kind = 'link' AND target_id IS NOT NULL AND resource_kind IS NULL)
  OR (target_kind = 'resource' AND target_id IS NOT NULL AND resource_kind IS NOT NULL)
);

SELECT core.apply_tenant_fence();
