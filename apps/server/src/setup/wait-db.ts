import { createDatabase } from "@fundroom/db";

/*
 * Compose starts `db` and `app` together; `depends_on: service_healthy` covers the common
 * case, but PaaS templates and bare `docker run` do not have it. So `serve` and `migrate`
 * poll the database for `DATABASE_WAIT_TIMEOUT_MS` before the first migration, logging
 * once per attempt, instead of crashing into a restart loop.
 */
export interface WaitForDatabaseOptions {
  readonly connectionString: string;
  readonly timeoutMs: number;
  readonly intervalMs?: number | undefined;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
  readonly ping?: (() => Promise<boolean>) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly now?: (() => number) | undefined;
}

export async function waitForDatabase(options: WaitForDatabaseOptions): Promise<number> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const interval = options.intervalMs ?? 1000;
  const started = now();
  let attempts = 0;
  const ping =
    options.ping ??
    (async () => {
      const db = createDatabase({ connectionString: options.connectionString, poolMax: 1 });
      try {
        return await db.ping();
      } finally {
        await db.close();
      }
    });
  for (;;) {
    attempts += 1;
    let ok = false;
    let error: string | undefined;
    try {
      ok = await ping();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (ok) return attempts;
    const elapsed = now() - started;
    if (elapsed >= options.timeoutMs) {
      throw new Error(
        `database did not accept connections within ${options.timeoutMs} ms (${attempts} attempts${error ? `; last error: ${error.replace(/\/\/[^@\s]+@/gu, "//***@")}` : ""})`,
      );
    }
    options.log?.("database.waiting", {
      level: "warn",
      attempt: attempts,
      elapsedMs: elapsed,
      ...(error ? { error: error.replace(/\/\/[^@\s]+@/gu, "//***@") } : {}),
    });
    await sleep(Math.min(interval, options.timeoutMs - elapsed));
  }
}
