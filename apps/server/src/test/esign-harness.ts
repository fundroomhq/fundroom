import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppConfig, loadConfig } from "@fundroom/config";
import { systemContext } from "@fundroom/db";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import type { MemoryMailer } from "@fundroom/mail";
import type { ActiveJob, JsonObject } from "@fundroom/ports";
import * as OTPAuth from "otpauth";
import { expect } from "vitest";
import type { RunningServer } from "../server.js";
import { withSetCookies } from "./session-cookies.js";
import { awaitSignInCode } from "./sign-in-mail.js";

/*
 * Test support for the E3.5 e-sign integration files (`esign*.integration.test.ts`). Not imported
 * by the server. A harness object bound to one running server: requests on a workspace host,
 * sign-in (waiting for the detached OTP mail), step-up, members, raw SQL as the system actor,
 * callbacks on the canonical host, and running a job handler in-process.
 */
export const BASE = "http://portal.example.test";
export const CANON = "portal.example.test";

export interface Actor {
  readonly membershipId: string;
  readonly cookie: string;
}

export interface ErrorBody {
  error: { code: string; reason?: string; message: string };
}

export interface EnvelopeBody {
  id: string;
  purpose: "nda" | "round_closing";
  subject: { module: string; kind: string; id: string };
  status: string;
  signerStatus: string | null;
  signerName: string;
  signerEmail: string;
  membershipId: string | null;
  title: string;
  driver: string;
  sentAt: string | null;
  completedAt: string | null;
  hasSigned: boolean;
  hasCertificate: boolean;
  vaultedDocumentId: string | null;
  errorCode: string | null;
  createdAt: string;
}

export interface ConnectionBody {
  id: string;
  driver: string;
  displayName: string;
  status: "active" | "error";
  callbackSecretKind: "ours" | "vendor";
  baseUrlHost: string | null;
  callbackUrl: string;
  credentialHints: Record<string, string>;
  lastVerifiedAt: string | null;
  lastError: string | null;
}

export function esignTestConfig(
  env: { databaseUrl: string; secretKey: string; storagePath: string },
  extra: Record<string, string> = {},
): AppConfig {
  return loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "error",
      BASE_URL: BASE,
      DATABASE_URL: env.databaseUrl,
      FUNDROOM_SECRET_KEY: env.secretKey,
      STORAGE_FS_PATH: env.storagePath,
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
      UPDATE_CHECK: "false",
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
      // The real-HTTP fake Documenso listens on 127.0.0.1 (self-hosted vendor on a LAN).
      ESIGN_ALLOW_PRIVATE_HOSTS: "127.0.0.1",
      ...extra,
    },
  });
}

export function freshSecrets(databaseUrl: string) {
  return {
    databaseUrl,
    secretKey: randomBytes(32).toString("base64"),
    storagePath: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
  };
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

export async function waitFor<T>(
  label: string,
  probe: () => Promise<T | undefined | false>,
  timeoutMs = 20_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await probe();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

export function harness(server: () => RunningServer, mailer: () => MemoryMailer) {
  async function request(
    slug: string,
    path: string,
    init: RequestInit & { cookie?: string | undefined; server?: RunningServer } = {},
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("host", `${slug}.${CANON}`);
    if (init.body !== undefined && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    if (init.cookie) headers.set("cookie", init.cookie);
    if (init.method && init.method !== "GET" && !headers.has("origin"))
      headers.set("origin", `http://${slug}.${CANON}`);
    return (init.server ?? server()).app.request(`http://${slug}.${CANON}${path}`, {
      ...init,
      headers,
    });
  }

  async function signIn(slug: string, email: string): Promise<string> {
    const since = mailer().sent.length;
    const start = await request(slug, "/api/v1/auth/otp/start", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    expect(start.status).toBe(200);
    const code = await awaitSignInCode(mailer(), email, since);
    const verify = await request(slug, "/api/v1/auth/otp/verify", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
    expect(verify.status).toBe(200);
    return verify.headers
      .getSetCookie()
      .map((c) => c.split(";")[0] ?? "")
      .join("; ");
  }

  async function stepUp(slug: string, cookie: string): Promise<string> {
    const enrol = await request(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
    expect(enrol.status).toBe(200);
    const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
    const confirm = await request(slug, "/api/v1/auth/totp/enrol/confirm", {
      method: "POST",
      cookie,
      body: JSON.stringify({ code: totp.generate() }),
    });
    expect(confirm.status).toBe(200);
    return withSetCookies(cookie, confirm);
  }

  /** A signed-in member: staff are stepped up to MFA (fresh), externals sign in with a code. */
  async function member(
    slug: string,
    workspaceId: string,
    email: string,
    kind: "staff" | "external",
    role: string,
  ): Promise<Actor> {
    const deps = server().container.identityDeps;
    const { userId } = await provisionUser(deps, { email, displayName: email.split("@")[0] });
    const m = await provisionMembership(deps, {
      workspaceId,
      userId,
      kind,
      role: role as never,
      source: "test",
    });
    const cookie = await signIn(slug, email);
    return {
      membershipId: m.id,
      cookie: kind === "staff" ? await stepUp(slug, cookie) : cookie,
    };
  }

  /** Rows read as the workspace's `system` actor (RLS applies; ids are interpolated uuids). */
  async function sql<T = Record<string, unknown>>(
    workspaceId: string,
    query: string,
  ): Promise<T[]> {
    const ctx = systemContext(workspaceId);
    return server().container.db.withTenant(ctx, async (tx) => {
      const r = await tx.execute(query);
      return r.rows as T[];
    });
  }

  /** A POST to the vendor callback URL on the canonical host (the ops tree). */
  async function callback(
    connectionId: string,
    req: { headers: Headers; body: Uint8Array },
    via?: RunningServer,
  ): Promise<Response> {
    const headers = new Headers(req.headers);
    headers.set("host", CANON);
    return (via ?? server()).app.request(`${BASE}/webhooks/esign/${connectionId}`, {
      method: "POST",
      headers,
      body: req.body as Uint8Array<ArrayBuffer>,
    });
  }

  /** Runs one job handler in-process (no queue), as the worker would. */
  async function runJob(name: string, data: JsonObject, via?: RunningServer): Promise<void> {
    const def = (via ?? server()).container.jobs.find((j) => j.name === name);
    if (def === undefined) throw new Error(`no job ${name}`);
    const job: ActiveJob<JsonObject> = {
      id: `test-${Math.random().toString(36).slice(2)}`,
      name,
      data,
      signal: new AbortController().signal,
    };
    await def.handler(job);
  }

  return { request, signIn, stepUp, member, sql, callback, runJob };
}

/** A memory-vendor callback signed with `secret` (the memory adapter's `x-memory-secret`). */
export function memoryCallback(
  secret: string,
  body: { providerRef?: string; externalId?: string; event: string },
): { headers: Headers; body: Uint8Array } {
  return {
    headers: new Headers({ "content-type": "application/json", "x-memory-secret": secret }),
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

/** `pg_stat_database.deadlocks` for the test database (snapshot cleared first). */
export async function deadlocks(pool: {
  query<R>(q: string): Promise<{ rows: R[] }>;
}): Promise<number> {
  await pool.query("SELECT pg_stat_clear_snapshot()");
  const [r] = (
    await pool.query<{ n: string }>(
      "SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()",
    )
  ).rows;
  return Number(r?.n ?? 0);
}
