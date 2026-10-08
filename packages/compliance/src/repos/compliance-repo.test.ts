import { core, type Tx } from "@fundroom/db";
import { drizzle } from "drizzle-orm/node-postgres";
import { describe, expect, it } from "vitest";
import type { RegisterKey } from "../service/register.js";
import { AcceptanceRegisterRepo } from "./compliance-repo.js";

/*
 * The register's keyset, asserted as SQL. `drizzle.mock()` builds statements without a connection,
 * so the shape of the predicate and the ORDER BY can be checked in the unit project — which is
 * where a paging bug wants catching, because the way it fails against a real database is silence:
 * a row that never appears on any page.
 */
const tx = drizzle.mock() as unknown as Tx;

const KEY: RegisterKey = {
  signedAt: new Date("2026-09-14T10:30:00.000Z"),
  membershipId: "01920000-0000-7000-8000-0000000000a1",
  kind: "nda:v2",
};

function keysetSql() {
  return tx
    .select({ kind: core.attestation.kind })
    .from(core.attestation)
    .where(AcceptanceRegisterRepo.keysetBefore(KEY))
    .orderBy(...AcceptanceRegisterRepo.keysetOrder())
    .toSQL();
}

describe("AcceptanceRegisterRepo keyset", () => {
  it("compares the three ordering columns as one row, so a tie on signed_at is still ordered", () => {
    // `(a, b, c) < (x, y, z)` is lexicographic in Postgres. A predicate on `signed_at` alone
    // either skips the second of two acceptances made in the same microsecond or returns the
    // first for ever — and two investors clicking through the same gate in the same microsecond
    // is exactly what a publish causes.
    const q = keysetSql();
    expect(q.sql).toMatch(
      /\(\s*"core"\."attestation"\."signed_at",\s*"core"\."attestation"\."membership_id",\s*"core"\."attestation"\."kind"\s*\)\s*<\s*\(/u,
    );
  });

  it("binds all three cursor columns as parameters", () => {
    const q = keysetSql();
    expect(q.params).toContain(KEY.membershipId);
    expect(q.params).toContain(KEY.kind);
    expect(q.params.some((p) => p instanceof Date && p.getTime() === KEY.signedAt.getTime())).toBe(
      true,
    );
  });

  it("orders by every column the cursor carries, descending, so the two agree", () => {
    const q = keysetSql();
    const order = q.sql.slice(q.sql.indexOf("order by"));
    expect(order).toContain('"core"."attestation"."signed_at" desc');
    expect(order).toContain('"core"."attestation"."membership_id" desc');
    expect(order).toContain('"core"."attestation"."kind" desc');
  });

  it("casts the membership id, because a uuid column cannot be compared to a bare text parameter", () => {
    expect(keysetSql().sql).toContain("::uuid");
  });
});
