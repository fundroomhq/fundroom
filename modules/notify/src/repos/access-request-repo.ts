import type { TenantContext, Tx } from "@fundroom/db";
import { sql } from "drizzle-orm";

/*
 * A read-only look at `core.access_request` (E3.1), for the alert about a new pending request.
 *
 * Raw SQL rather than the kernel's drizzle table or identity's repo, like the other modules'
 * `core.workspace` reads: notify needs two columns, and binding it to the access-request service
 * would make a kernel refactor a notify change. Runs inside the caller's transaction only — the
 * handler's outbox transaction or delivery's short one — never on a second pool connection. The
 * table's RLS admits `staff` and `system`, which is what both of those run as.
 */
export interface AccessRequestSummary {
  readonly id: string;
  readonly status: string;
  readonly name: string;
}

interface Rows<T> {
  readonly rows: T[];
}

export async function accessRequestSummaries(
  ctx: TenantContext,
  tx: Tx,
  ids: readonly string[],
): Promise<Map<string, AccessRequestSummary>> {
  const out = new Map<string, AccessRequestSummary>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return out;
  const idList = sql.join(
    unique.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const result = (await tx.execute(
    sql`SELECT id::text AS id, status::text AS status, name
        FROM core.access_request
        WHERE workspace_id = ${ctx.workspaceId}::uuid AND id IN (${idList})`,
  )) as unknown as Rows<AccessRequestSummary>;
  for (const r of result.rows) out.set(r.id, r);
  return out;
}

export async function accessRequestSummary(
  ctx: TenantContext,
  tx: Tx,
  id: string,
): Promise<AccessRequestSummary | undefined> {
  return (await accessRequestSummaries(ctx, tx, [id])).get(id);
}
