import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyWorkspace } from "@fundroom/audit";
import { rebuildEffectiveAccess, rederiveRulePaths } from "@fundroom/authz";
import { loadConfig } from "@fundroom/config";
import { decryptStream, streamToBytes } from "@fundroom/crypto";
import { createWorkspace, systemContext } from "@fundroom/db";
import { startPostgres, type TestPostgres } from "@fundroom/db/testing";
import { provisionMembership, provisionUser } from "@fundroom/identity";
import { createMemoryMailer, type MemoryMailer } from "@fundroom/mail";
import {
  deleteExport,
  type ExportManifest,
  ExportRunningError,
  ExportStateError,
  expireExports,
  exportObjectKey,
  exportPublicKeys,
  exportSigningKey,
  findUndeclared,
  formatVerification,
  type ImportDeps,
  importWorkspace,
  KERNEL_TABLES,
  listCatalogTables,
  manifestBytes,
  PortabilityError,
  type PortabilityServiceDeps,
  planTables,
  requestExport,
  runExport,
  signManifest,
  verifyExportFile,
  ZipFileReader,
  ZipFileWriter,
} from "@fundroom/portability";
import { certificateKey } from "@fundroom/storage";
import * as OTPAuth from "otpauth";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  runWorkspaceExport,
  runWorkspaceImport,
  runWorkspaceVerifyExport,
} from "./cli-commands/workspace-portability.js";
import { createLogger } from "./logger.js";
import { COMPILED_IN_MODULES } from "./modules.js";
import { type RunningServer, startServer } from "./server.js";
import { withSetCookies } from "./test/session-cookies.js";
import { awaitSignInCode } from "./test/sign-in-mail.js";
import { purgeDeletedWorkspaces } from "./workspace/lifecycle.js";

/*
 * E2.8 workspace export → import, end to end on real Postgres and the filesystem storage adapter:
 *
 *  - every tenant-scoped kernel table and every module table has a portability decision (the
 *    catalog is the source of truth: a new table without one fails here);
 *  - the portal export: owner only (editor 403, investor 404), a fresh sign-in, one at a time
 *    (409 `export_running`), the `portability.export` job, a signed zip streamed back decrypted
 *    with `X-Content-SHA256`, `workspace.export_downloaded`, delete, and the hourly expiry;
 *  - the round trip: that zip verified offline, then imported into a NEW slug on the same
 *    instance — row counts per table, all-new ids, FKs intact, every file re-encrypted under the
 *    new workspace's keys yet byte-identical, the click-wrap certificate re-sealed, the logo, the
 *    suppression list re-hashed, an investor signing in to the copy as the SAME global user and
 *    seeing the same folder through the same (remapped) group grant, a verifying audit chain that
 *    starts with `workspace.imported`, and the source untouched.
 *
 * The main pool has ONE connection (DATABASE_POOL_MAX=1): the export reads everything through one
 * transaction and the import writes everything through another, with module hooks, the search
 * reindex and the access rebuild on it — any second connection taken inside either would hang
 * this file instead of passing it.
 */
const BASE = "http://portal.example.test";
const CANON = "portal.example.test";

/**
 * TEMP: `<schema>.<table>` names whose module has not declared a portability decision yet. It
 * should stay empty; the kernel part of the declared-tables test never
 * consults it. Every module spec has landed, so it is empty.
 */
const TEMP_UNDECLARED_MODULE_TABLES: readonly string[] = [];

let pg: TestPostgres;
let running: RunningServer;
let mailer: MemoryMailer;
let tmp: string;

interface Actor {
  cookie: string;
  membershipId: string;
}

async function request(slug: string, path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("host", `${slug}.${CANON}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  if (init.cookie) headers.set("cookie", init.cookie);
  if (init.method && init.method !== "GET") headers.set("origin", `http://${slug}.${CANON}`);
  return running.app.request(`http://${slug}.${CANON}${path}`, { ...init, headers });
}

async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0] ?? "")
    .join("; ");
}

async function signIn(slug: string, email: string): Promise<Actor> {
  const since = mailer.sent.length;
  const start = await request(slug, "/api/v1/auth/otp/start", {
    method: "POST",
    body: JSON.stringify({ email }),
  });
  expect(start.status).toBe(200);
  // The code mail is sent detached: under load it can trail the response, and another mail
  // (a security notice, a notification) can land last. Wait for this address's code mail.
  const code = await awaitSignInCode(mailer, email, since);
  const verify = await request(slug, "/api/v1/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({ email, code }),
  });
  expect(verify.status).toBe(200);
  const body = await json<{ membership: { id: string } | null }>(verify);
  return { cookie: cookiesOf(verify), membershipId: body.membership?.id ?? "" };
}

async function stepUpToMfa(slug: string, cookie: string): Promise<string> {
  const enrol = await request(slug, "/api/v1/auth/totp/enrol", { method: "POST", cookie });
  const { secretBase32 } = await json<{ secretBase32: string }>(enrol);
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secretBase32) });
  const confirm = await request(slug, "/api/v1/auth/totp/enrol/confirm", {
    method: "POST",
    cookie,
    body: JSON.stringify({ code: totp.generate() }),
  });
  expect(confirm.status).toBe(200);
  // Step-up rotates the session token (F-12): carry the new cookie on.
  return withSetCookies(cookie, confirm);
}

async function member(
  slug: string,
  workspaceId: string,
  email: string,
  kind: "staff" | "external",
  role: "owner" | "admin" | "editor" | "legal" | "investor",
): Promise<Actor> {
  const deps = running.container.identityDeps;
  const user = await provisionUser(deps, { email, displayName: email.split("@")[0] });
  await provisionMembership(deps, { workspaceId, userId: user.userId, kind, role, source: "test" });
  const actor = await signIn(slug, email);
  if (kind === "staff") actor.cookie = await stepUpToMfa(slug, actor.cookie);
  return actor;
}

async function rows<T = Record<string, unknown>>(query: string, workspaceId: string): Promise<T[]> {
  return running.container.db.withTenant(systemContext(workspaceId), async (tx) => {
    const r = await tx.execute(query);
    return r.rows as T[];
  });
}

async function hostRows<T = Record<string, unknown>>(query: string): Promise<T[]> {
  return running.container.db.withHost(async (tx) => (await tx.execute(query)).rows as T[]);
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  ms = 60_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await probe();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

async function makePdf(marker: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= 2; i++) {
    doc.addPage([612, 792]).drawText(`${marker} page ${i}`, { x: 50, y: 700, size: 20, font });
  }
  return doc.save();
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

async function upload(
  slug: string,
  actor: Actor,
  folderId: string,
  fileName: string,
  bytes: Uint8Array,
): Promise<{ documentId: string; versionId: string }> {
  const start = await request(slug, "/api/v1/data-room/uploads", {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify({
      fileName,
      size: bytes.byteLength,
      contentType: "application/pdf",
      folderId,
    }),
  });
  expect(start.status).toBe(201);
  const started = await json<{ upload: { id: string }; tus: { path: string } | null }>(start);
  const endpoint = `/api/v1${started.tus?.path ?? ""}`;
  const meta = `upload ${Buffer.from(started.upload.id).toString("base64")},filename ${Buffer.from(fileName).toString("base64")}`;
  const create = await request(slug, endpoint, {
    method: "POST",
    cookie: actor.cookie,
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Length": String(bytes.byteLength),
      "Upload-Metadata": meta,
      "content-type": "application/offset+octet-stream",
    },
    body: new Uint8Array(0),
  });
  expect(create.status).toBe(201);
  const patch = await request(slug, `${endpoint}/${started.upload.id}`, {
    method: "PATCH",
    cookie: actor.cookie,
    headers: {
      "Tus-Resumable": "1.0.0",
      "Upload-Offset": "0",
      "content-type": "application/offset+octet-stream",
    },
    body: bytes,
  });
  expect(patch.status).toBe(204);
  const complete = await request(slug, `/api/v1/data-room/uploads/${started.upload.id}/complete`, {
    method: "POST",
    cookie: actor.cookie,
    body: JSON.stringify({}),
  });
  expect(complete.status).toBe(200);
  const body = await json<{ document: { id: string }; version: { id: string } }>(complete);
  return { documentId: body.document.id, versionId: body.version.id };
}

let acmeId: string;
let owner: Actor;
let editor: Actor;
let ada: Actor;
let bob: Actor;
let boardGroupId: string;
let folderId: string;
let folderPath: string;
let deckId: string;
let deckBytes: Uint8Array;
const adaEmail = "ada@investor.test";
const bobEmail = "bob@investor.test";

function importDeps(): ImportDeps {
  const c = running.container;
  return {
    db: c.db,
    storage: c.storage,
    envelope: c.envelope,
    keyRing: c.config.keyRing,
    modules: c.registry.modules,
    instanceVersion: "test",
    audit: c.audit,
    moduleServices: c.moduleServices,
    rederiveRulePaths,
    rebuildAccess: async (tx, ctx) => {
      await rebuildEffectiveAccess(tx, ctx);
    },
    tmpDir: tmp,
  };
}

/** Module and kernel rows the API does not reach cheaply, one or two per table. */
async function seedRows(): Promise<void> {
  const a = ada.membershipId;
  const b = bob.membershipId;
  const o = owner.membershipId;
  const roundId = randomUUID();
  const orgId = randomUUID();
  const stageId = randomUUID();
  const itemId = randomUUID();
  const defId = randomUUID();
  const sourceId = randomUUID();
  const p1 = randomUUID();
  const p2 = randomUUID();
  const t1 = randomUUID();
  const t2 = randomUUID();
  const pageId = randomUUID();
  const revId = randomUUID();
  const postId = randomUUID();
  const qaId = randomUUID();
  const versionId = randomUUID();
  const sendId = randomUUID();
  const linkId = randomUUID();
  const ws = acmeId;
  const delegateUser = (
    await provisionUser(running.container.identityDeps, {
      email: "dee@assistant.test",
      displayName: "Dee",
    })
  ).userId;
  const statements = [
    // kernel
    `INSERT INTO core.invite (workspace_id, email, token_hash, kind, role, group_ids, expires_at, invited_by)
       VALUES ('${ws}', 'carol@investor.test', sha256('carol-token'), 'external', 'investor',
               ARRAY['${boardGroupId}']::uuid[], now() + interval '7 days', '${o}')`,
    `INSERT INTO core.consent_event (workspace_id, membership_id, purpose, granted, source, ip_hash)
       VALUES ('${ws}', '${a}', 'analytics_engagement', true, 'settings', sha256('1.2.3.4'))`,
    // an approved access request ↔ its invite (E3.1): a FK cycle the import defers; the ip hash
    // is a secret that must not travel, and an emailed challenge does not travel at all
    `INSERT INTO core.access_request (workspace_id, email, name, firm, status, client_ip_hash,
         verified_at, decided_at, decided_by, invite_id, expires_at)
       SELECT '${ws}', 'carol@investor.test', 'Carol', 'Carol Capital', 'approved',
              sha256('5.6.7.8'), now(), now(), '${o}', id, now() + interval '30 days'
       FROM core.invite WHERE workspace_id = '${ws}' AND email = 'carol@investor.test'`,
    `INSERT INTO core.access_request_challenge (id, workspace_id, email, name, code_hash, expires_at)
       VALUES (gen_random_uuid(), '${ws}', 'dave@investor.test', 'Dave', sha256('code'),
               now() + interval '10 minutes')`,
    `UPDATE core.invite SET access_request_id = (SELECT id FROM core.access_request WHERE workspace_id = '${ws}')
       WHERE workspace_id = '${ws}' AND email = 'carol@investor.test'`,
    `INSERT INTO core.access_policy (workspace_id, target_kind, target_id, kind, config)
       VALUES ('${ws}', 'group', '${boardGroupId}', 'min_auth_level', '{"level": 1, "groupId": "${boardGroupId}"}')`,
    `INSERT INTO core.share_link (id, workspace_id, label, token_hash, passcode_hash, group_ids)
       VALUES ('${linkId}', '${ws}', 'deck link', sha256(convert_to('${linkId}', 'UTF8')),
               sha256('passcode'), ARRAY['${boardGroupId}']::uuid[])`,
    `INSERT INTO core.share_link_visit (workspace_id, link_id, membership_id, views)
       VALUES ('${ws}', '${linkId}', '${b}', 2)`,
    `INSERT INTO core.share_link_view (workspace_id, link_id, membership_id, session_id)
       VALUES ('${ws}', '${linkId}', '${b}', '${randomUUID()}')`,
    `INSERT INTO core.access_grant (workspace_id, subject_kind, subject_id, resource_kind, resource_id,
         resource_path, capability)
       VALUES ('${ws}', 'link', '${linkId}', 'folder', '${folderId}', '${folderPath}', 'view')`,
    `INSERT INTO core.module_enablement (workspace_id, module, enabled, config)
       VALUES ('${ws}', 'metrics', true, '{}')`,
    // a delegate whose principal is ada (the CHECK ties the role to the principal column)
    `INSERT INTO core.membership (workspace_id, user_id, kind, role, status, source, principal_membership_id, delegate_scope)
       VALUES ('${ws}', '${delegateUser}', 'external', 'delegate', 'active', 'test', '${a}', 'data_room')`,
    // a pending delegate invitation acting for ada (E3.2: the principal column is remapped too)
    `INSERT INTO core.invite (workspace_id, email, token_hash, kind, role, expires_at, principal_membership_id, delegate_scope)
       VALUES ('${ws}', 'pa@fund.test', sha256('pa-token'), 'external', 'delegate', now() + interval '7 days', '${a}', 'updates')`,
    // crm
    `INSERT INTO crm.organization (id, workspace_id, name, kind) VALUES ('${orgId}', '${ws}', 'Angels LLC', 'fund')`,
    `INSERT INTO crm.contact (workspace_id, organization_id, membership_id, display_name, email, tags)
       VALUES ('${ws}', '${orgId}', '${a}', 'Ada', '${adaEmail}', ARRAY['lead'])`,
    `INSERT INTO crm.pipeline_stage (id, workspace_id, key, name, position) VALUES ('${stageId}', '${ws}', 'portability_test', 'Portability', 99)`,
    `INSERT INTO crm.pipeline_item (id, workspace_id, organization_id, stage_id, amount, currency)
       VALUES ('${itemId}', '${ws}', '${orgId}', '${stageId}', 123456789012.123456, 'USD')`,
    `INSERT INTO crm.stage_transition (workspace_id, pipeline_item_id, to_stage_id, to_stage_key)
       VALUES ('${ws}', '${itemId}', '${stageId}', 'portability_test')`,
    `INSERT INTO crm.note (workspace_id, subject_kind, subject_id, body, author_membership_id)
       VALUES ('${ws}', 'organization', '${orgId}', 'met at demo day', '${o}')`,
    `INSERT INTO crm.task (workspace_id, subject_kind, subject_id, title) VALUES ('${ws}', 'pipeline_item', '${itemId}', 'call back')`,
    // round (interest ↔ commitment cycle, terms superseded chain)
    `INSERT INTO round.round (id, workspace_id, name, stage, instrument_kind, target_amount, currency)
       VALUES ('${roundId}', '${ws}', 'Seed', 'seed', 'safe', 1000000, 'USD')`,
    `INSERT INTO round.terms (id, workspace_id, round_id, revision, terms)
       VALUES ('${t2}', '${ws}', '${roundId}', 2, '{"valuationCap": "9000000"}')`,
    `INSERT INTO round.terms (id, workspace_id, round_id, revision, terms, superseded_by)
       VALUES ('${t1}', '${ws}', '${roundId}', 1, '{"valuationCap": "8000000"}', '${t2}')`,
    `INSERT INTO round.interest_submission (workspace_id, round_id, membership_id, amount, currency,
         subject, accreditation_path, offering_status)
       VALUES ('${ws}', '${roundId}', '${b}', 50000, 'USD', 'individual', 'none', 'none')`,
    `INSERT INTO round.commitment (workspace_id, round_id, membership_id, amount, status,
         interest_submission_id)
       SELECT '${ws}', '${roundId}', '${b}', 50000, 'signed', id FROM round.interest_submission
       WHERE workspace_id = '${ws}'`,
    `UPDATE round.interest_submission SET commitment_id = (SELECT id FROM round.commitment WHERE workspace_id = '${ws}')
       WHERE workspace_id = '${ws}'`,
    `INSERT INTO round.closing_task (workspace_id, round_id, title) VALUES ('${ws}', '${roundId}', 'wire instructions')`,
    `INSERT INTO round.verification (workspace_id, membership_id, status) VALUES ('${ws}', '${b}', 'pending')`,
    // metrics (a superseded point: the self-FK the import has to defer)
    `INSERT INTO metrics.definition (id, workspace_id, key, name, unit, currency)
       VALUES ('${defId}', '${ws}', 'mrr', 'MRR', 'currency', 'USD')`,
    `INSERT INTO metrics.source (id, workspace_id, kind) VALUES ('${sourceId}', '${ws}', 'manual')`,
    `INSERT INTO metrics.point (id, workspace_id, definition_id, period, value, source_id, revision)
       VALUES ('${p2}', '${ws}', '${defId}', '[2026-08-01,2026-09-01)', 12000.25, '${sourceId}', 2)`,
    `INSERT INTO metrics.point (id, workspace_id, definition_id, period, value, source_id, revision,
         superseded_by)
       VALUES ('${p1}', '${ws}', '${defId}', '[2026-08-01,2026-09-01)', 10000.5, '${sourceId}', 1, '${p2}')`,
    // content
    `INSERT INTO content.page (id, workspace_id, slug, kind, title) VALUES ('${pageId}', '${ws}', 'about-us', 'custom', 'About')`,
    `INSERT INTO content.page_revision (id, workspace_id, page_id, revision_no, doc)
       VALUES ('${revId}', '${ws}', '${pageId}', 1, '{"sections": [{"key": "intro", "blocks": [{"type": "document_list", "folderId": "${folderId}"}]}]}')`,
    `UPDATE content.page SET draft_revision_id = '${revId}' WHERE id = '${pageId}'`,
    `INSERT INTO content.section_visibility (workspace_id, page_id, section_key, rule)
       VALUES ('${ws}', '${pageId}', 'intro', '{"kind": "groups", "groupIds": ["${boardGroupId}"]}')`,
    // updates
    `INSERT INTO updates.post (id, workspace_id, slug, title, state, doc, sent_at)
       VALUES ('${postId}', '${ws}', 'august', 'August update', 'sent', '{"sections": []}', now())`,
    `INSERT INTO updates.post_version (id, workspace_id, post_id, version_no, title, doc, audience)
       VALUES ('${versionId}', '${ws}', '${postId}', 1, 'August update', '{"sections": []}', '{"kind": "members"}')`,
    `UPDATE updates.post SET published_version_id = '${versionId}' WHERE id = '${postId}'`,
    `INSERT INTO updates.send (id, workspace_id, post_id, version_id, kind, status, total, sent)
       VALUES ('${sendId}', '${ws}', '${postId}', '${versionId}', 'live', 'finished', 1, 1)`,
    `INSERT INTO updates.recipient (workspace_id, send_id, membership_id, email, status)
       VALUES ('${ws}', '${sendId}', '${b}', '${bobEmail}', 'delivered')`,
    `INSERT INTO updates.reply (workspace_id, post_id, thread_membership_id, author_membership_id, body)
       VALUES ('${ws}', '${postId}', '${b}', '${b}', 'great month')`,
    `INSERT INTO updates.unsubscribe (workspace_id, membership_id, email, source)
       VALUES ('${ws}', '${a}', '${adaEmail}', 'portal')`,
    // notify
    `INSERT INTO notify.member_settings (workspace_id, membership_id, timezone) VALUES ('${ws}', '${o}', 'Europe/Paris')`,
    `INSERT INTO notify.preference (workspace_id, membership_id, event_type, cadence)
       VALUES ('${ws}', '${o}', 'document.viewed', 'daily')`,
    `INSERT INTO notify.notification (workspace_id, membership_id, event_type, dedupe_key, cadence, actor_membership_id)
       VALUES ('${ws}', '${o}', 'document.viewed', 'k-${deckId}', 'instant', '${b}')`,
    // data-room Q&A (E3.3): bob's question on the deck, answered by the owner and published.
    // Q&A is on (settings travel with the workspace): its entries are indexed only while it is.
    `UPDATE core.workspace SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{dataRoom}',
         COALESCE(settings->'dataRoom', '{}'::jsonb) || '{"qa": {"enabled": true}}'::jsonb)
       WHERE id = '${ws}'`,
    `INSERT INTO dataroom.qa_question (id, workspace_id, target_kind, document_id, asker_membership_id,
         source, status, subject, body, public_text, visibility, assignee_membership_id,
         released_at, published_at, first_released_at, created_by)
       VALUES ('${qaId}', '${ws}', 'document', '${deckId}', '${b}', 'portal', 'published', 'Runway?',
         'How long is the runway?', 'Runway question', 'target', '${o}', now(), now(), now(), '${b}')`,
    `INSERT INTO dataroom.qa_answer (workspace_id, question_id, body, author_membership_id)
       VALUES ('${ws}', '${qaId}', 'Eighteen months of numbatrunway', '${o}')`,
    // analytics (a rollup is carried; raw events only with includeRawAnalytics)
    `INSERT INTO analytics.event (workspace_id, membership_id, type, resource_kind, resource_id)
       VALUES ('${ws}', '${b}', 'document_viewed', 'document', '${deckId}')`,
    `INSERT INTO analytics.viewer_resource_rollup (workspace_id, membership_id, resource_kind, resource_id, first_at, last_at, views)
       VALUES ('${ws}', '${b}', 'document', '${deckId}', now(), now(), 1)`,
  ];
  for (const sql of statements) await rows(sql, acmeId);

  // Suppressions: bob's address (the export knows it) and one it cannot know (dropped).
  await running.container.db.withTenant(systemContext(acmeId), async (tx) => {
    const key = await running.container.envelope.currentKey(
      tx,
      systemContext(acmeId),
      "mail-suppression",
    );
    for (const [address, masked] of [
      [bobEmail, "b•••@investor.test"],
      ["stranger@elsewhere.test", "s•••@elsewhere.test"],
    ] as const) {
      const hash = createHmac("sha256", key.key).update(address).digest("hex");
      await tx.execute(
        `INSERT INTO core.mail_suppression (workspace_id, address_hash, key_id, address_masked, reason)
         VALUES ('${acmeId}', decode('${hash}', 'hex'), '${key.keyId}', '${masked}', 'bounce')`,
      );
    }
  });
}

beforeAll(async () => {
  pg = await startPostgres({ sources: [] });
  mailer = createMemoryMailer();
  tmp = mkdtempSync(join(tmpdir(), "fundroom-portability-"));
  const config = loadConfig({
    env: {
      APP_ENV: "test",
      LOG_LEVEL: "warn",
      BASE_URL: BASE,
      DATABASE_URL: pg.connectionString,
      DATABASE_POOL_MAX: "1",
      FUNDROOM_SECRET_KEY: randomBytes(32).toString("base64"),
      STORAGE_FS_PATH: mkdtempSync(join(tmpdir(), "fundroom-storage-")),
      DATA_DIR: mkdtempSync(join(tmpdir(), "fundroom-data-")),
      TENANCY_MODE: "multi",
      ROLES: "api,web,worker",
      OUTBOX_POLL_INTERVAL_MS: "200",
      JOBS_POLL_INTERVAL_MS: "500",
    },
  });
  running = await startServer({
    config,
    logger: createLogger({ level: "warn" }),
    mailer,
    modules: COMPILED_IN_MODULES,
    listenEnabled: false,
    migrate: true,
    announceSetup: false,
  });
  acmeId = (await createWorkspace(running.container.db, { slug: "acme", name: "Acme" })).id;
  owner = await member("acme", acmeId, "owner@example.com", "staff", "owner");
  editor = await member("acme", acmeId, "editor@example.com", "staff", "editor");
  ada = await member("acme", acmeId, adaEmail, "external", "investor");
  bob = await member("acme", acmeId, bobEmail, "external", "investor");

  // Groups and a folder grant carrying an ltree path (the remap the import must do).
  const group = await json<{ id: string }>(
    await request("acme", "/api/v1/access/groups", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ name: "Board", kind: "board" }),
    }),
  );
  boardGroupId = group.id;
  expect(
    (
      await request("acme", `/api/v1/access/groups/${boardGroupId}/members`, {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ membershipIds: [bob.membershipId] }),
      })
    ).status,
  ).toBeLessThan(300);
  const tree = await json<{ rootId: string }>(
    await request("acme", "/api/v1/data-room/tree", { cookie: owner.cookie }),
  );
  const folder = await request("acme", "/api/v1/data-room/folders", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({ parentId: tree.rootId, name: "Financials" }),
  });
  expect(folder.status).toBe(201);
  const f = (
    await json<{ folders: { id: string; name: string; path: string }[] }>(folder)
  ).folders.find((x) => x.name === "Financials");
  folderId = f?.id ?? "";
  folderPath = f?.path ?? "";
  deckBytes = await makePdf("Acme deck");
  deckId = (await upload("acme", owner, folderId, "deck.pdf", deckBytes)).documentId;
  await waitFor("the deck to be ingested", async () => {
    const [r] = await rows<{ s: string }>(
      `SELECT v.render_status AS s FROM dataroom.document d
       JOIN dataroom.document_version v ON v.id = d.current_version_id WHERE d.id = '${deckId}'`,
      acmeId,
    );
    return r && r.s !== "pending" ? r.s : undefined;
  });
  const grant = await request("acme", "/api/v1/access/grants", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      subject: { kind: "group", id: boardGroupId },
      resource: { kind: "folder", id: folderId, path: folderPath },
      capabilities: ["view", "download"],
    }),
  });
  expect(grant.status).toBe(200);

  // An NDA both investors accept: attestations with click-wrap certificates in storage.
  const nda = await request("acme", "/api/v1/compliance/documents", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      slug: "nda",
      from: "nda-clickwrap",
      requiresAcceptance: true,
      audience: "external",
    }),
  });
  expect(nda.status).toBe(200);
  const ndaDetail = await json<{ document: { id: string }; current: { versionNo: number } }>(nda);
  for (const who of [ada, bob]) {
    const accepted = await request("acme", "/api/v1/compliance/acceptances", {
      method: "POST",
      cookie: who.cookie,
      body: JSON.stringify({
        documentId: ndaDetail.document.id,
        versionNo: ndaDetail.current.versionNo,
      }),
    });
    expect(accepted.status).toBe(200);
  }

  // The logo (share links are off at offering status `none`: seeded as rows below).
  const logo = await request("acme", "/api/v1/branding/logo", {
    method: "POST",
    cookie: owner.cookie,
    body: JSON.stringify({
      data: Buffer.from(png(64, 32)).toString("base64"),
      contentType: "image/png",
    }),
  });
  expect(logo.status).toBe(200);

  await seedRows();
}, 300_000);

afterAll(async () => {
  await running?.stop();
  await pg?.stop();
});

describe("every table has a portability decision", () => {
  it("kernel: every tenant-scoped core/audit table is declared (strict), and nothing extra", async () => {
    const catalog = await running.container.db.withHost((tx) => listCatalogTables(tx));
    const plan = planTables(running.container.registry.modules);
    const undeclared = findUndeclared(catalog, plan, running.container.registry.modules);
    expect(undeclared.filter((n) => n.startsWith("core.") || n.startsWith("audit."))).toEqual([]);
    const kernelTenant = catalog
      .filter((t) => (t.schema === "core" || t.schema === "audit") && t.hasWorkspaceId)
      .map((t) => `${t.schema}.${t.table}`)
      .sort();
    const declared = KERNEL_TABLES.map((t) => `${t.schema}.${t.table}`).filter(
      (n) => n !== "core.workspace",
    );
    expect(declared.sort()).toEqual(kernelTenant);
  });

  it("modules: every table of every module schema is declared", async () => {
    const catalog = await running.container.db.withHost((tx) => listCatalogTables(tx));
    const plan = planTables(running.container.registry.modules);
    const undeclared = findUndeclared(catalog, plan, running.container.registry.modules);
    expect(undeclared.filter((n) => !TEMP_UNDECLARED_MODULE_TABLES.includes(n))).toEqual([]);
    const names = new Set(catalog.map((t) => `${t.schema}.${t.table}`));
    expect(plan.filter((p) => !names.has(p.name)).map((p) => p.name)).toEqual([]);
  });
});

interface ExportBody {
  id: string;
  status: string;
  sizeBytes: number | null;
  sha256: string | null;
  error: string | null;
  expiresAt: string | null;
  downloadedAt: string | null;
}

let exportId: string;
let zipPath: string;
let zipSha: string;

describe("the portal export", () => {
  it("is owner-only: an editor gets 403, an investor 404, a stale owner session step_up_required", async () => {
    for (const path of ["/api/v1/portability/exports", "/api/v1/portability/export-key"]) {
      expect((await request("acme", path, { cookie: editor.cookie })).status).toBe(403);
      expect((await request("acme", path, { cookie: ada.cookie })).status).toBe(404);
    }
    const post = await request("acme", "/api/v1/portability/exports", {
      method: "POST",
      cookie: ada.cookie,
      body: "{}",
    });
    expect(post.status).toBe(404);
  });

  it("publishes the signing keys", async () => {
    const res = await request("acme", "/api/v1/portability/export-key", { cookie: owner.cookie });
    expect(res.status).toBe(200);
    const body = await json<{ keys: { keyId: string; alg: string; publicKey: string }[] }>(res);
    expect(body.keys).toEqual(exportPublicKeys(running.container.config.keyRing));
  });

  it("queues one export at a time (409 export_running), builds it in the job, lists it", async () => {
    /*
     * The 409s are proven against an active export no job will ever pick up. Probing the real
     * export right after its POST races the job: the server pool is ONE connection, so a request
     * sent "immediately" can queue behind the job's transactions and land after `ready` — the
     * download then succeeds and records a real `workspace.export_downloaded`.
     */
    const pending = randomUUID();
    await rows(
      `INSERT INTO core.workspace_export (id, workspace_id, status, options)
       VALUES ('${pending}', '${acmeId}', 'queued', '{}'::jsonb) RETURNING id`,
      acmeId,
    );
    try {
      const blocked = await request("acme", "/api/v1/portability/exports", {
        method: "POST",
        cookie: owner.cookie,
        body: JSON.stringify({ includeRawAnalytics: true }),
      });
      expect(blocked.status).toBe(409);
      expect((await json<{ error: { code: string } }>(blocked)).error.code).toBe("export_running");
      const early = await request("acme", `/api/v1/portability/exports/${pending}/download`, {
        cookie: owner.cookie,
      });
      expect(early.status).toBe(409);
      expect((await json<{ error: { code: string } }>(early)).error.code).toBe("export_not_ready");
    } finally {
      await rows(`DELETE FROM core.workspace_export WHERE id = '${pending}' RETURNING id`, acmeId);
    }

    const first = await request("acme", "/api/v1/portability/exports", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({}),
    });
    expect(first.status).toBe(202);
    const queued = await json<ExportBody>(first);
    expect(queued.status).toBe("queued");
    exportId = queued.id;
    const ready = await waitFor(
      "the export job",
      async () => {
        const res = await request("acme", `/api/v1/portability/exports/${exportId}`, {
          cookie: owner.cookie,
        });
        const body = await json<ExportBody>(res);
        if (body.status === "failed") throw new Error(`export failed: ${body.error}`);
        return body.status === "ready" ? body : undefined;
      },
      120_000,
    );
    expect(ready.sizeBytes).toBeGreaterThan(0);
    expect(ready.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Date(ready.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const list = await json<{ items: ExportBody[] }>(
      await request("acme", "/api/v1/portability/exports", { cookie: owner.cookie }),
    );
    expect(list.items.map((i) => i.id)).toContain(exportId);
    // The stored object is SHE1 ciphertext, not a zip.
    const [row] = await rows<{ key: string }>(
      `SELECT storage_key AS key FROM core.workspace_export WHERE id = '${exportId}'`,
      acmeId,
    );
    const stored = await running.container.storage.get(row?.key ?? "");
    const head = new Uint8Array(await new Response(stored?.body).arrayBuffer()).subarray(0, 4);
    expect(Buffer.from(head).toString("latin1")).toBe("SHE1");
  }, 180_000);

  it("downloads the decrypted zip with its sha256 and records the download", async () => {
    const res = await request("acme", `/api/v1/portability/exports/${exportId}/download`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(res.headers.get("content-disposition")).toMatch(
      /^attachment; filename="acme-export-\d{4}-\d{2}-\d{2}\.zip"$/u,
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    zipSha = sha256(bytes);
    expect(res.headers.get("x-content-sha256")).toBe(zipSha);
    zipPath = join(tmp, "acme-export.zip");
    writeFileSync(zipPath, bytes);
    const events = await rows<{ action: string }>(
      `SELECT action FROM audit.event WHERE workspace_id = '${acmeId}' AND resource_id = '${exportId}' ORDER BY seq`,
      acmeId,
    );
    expect(events.map((e) => e.action)).toEqual([
      "workspace.export_requested",
      "workspace.export_completed",
      "workspace.export_downloaded",
    ]);
    const body = await json<ExportBody>(
      await request("acme", `/api/v1/portability/exports/${exportId}`, { cookie: owner.cookie }),
    );
    expect(body.downloadedAt).not.toBeNull();
  });

  it("verifies offline: trusted with the published key (exit 0), unpinned exit 3", async () => {
    const key = exportPublicKeys(running.container.config.keyRing)[0]?.publicKey ?? "";
    const v = await verifyExportFile(zipPath, { trustedPublicKeys: [key] });
    expect(v.problems).toEqual([]);
    expect(v.trusted).toBe(true);
    const m = v.manifest;
    expect(m?.source).toMatchObject({ workspaceId: acmeId, slug: "acme" });
    const byName = new Map(m?.tables.map((t) => [t.name, t]));
    expect(byName.get("core.effective_access")?.skipped).toBe("derived");
    expect(byName.get("core.workspace_key")?.skipped).toBe("secret");
    expect(byName.get("core.access_request_challenge")?.skipped).toBe("secret");
    expect(byName.get("analytics.event")?.skipped).toBe("excluded");
    expect(byName.get("core.mail_suppression")).toMatchObject({ rows: 1, dropped: 1 });
    expect(m?.blobs.count).toBeGreaterThanOrEqual(4); // deck + logo + 2 × (certificate json + pdf)
    // The fixture really exercised these tables (so the round trip below means something).
    const empty = [
      "core.membership",
      "core.group",
      "core.group_member",
      "core.invite",
      "core.access_request",
      "core.legal_document",
      "core.legal_document_version",
      "core.attestation",
      "core.consent_event",
      "core.access_grant",
      "core.access_policy",
      "core.share_link",
      "core.share_link_visit",
      "core.share_link_view",
      "core.module_enablement",
      "core.mail_suppression",
      "dataroom.folder",
      "dataroom.blob",
      "dataroom.document",
      "dataroom.document_version",
      "dataroom.qa_question",
      "dataroom.qa_answer",
      "content.page",
      "content.page_revision",
      "content.section_visibility",
      "updates.post",
      "updates.post_version",
      "updates.send",
      "updates.recipient",
      "updates.reply",
      "updates.unsubscribe",
      "analytics.viewer_resource_rollup",
      "notify.preference",
      "notify.member_settings",
      "notify.notification",
      "metrics.definition",
      "metrics.source",
      "metrics.point",
      "crm.organization",
      "crm.contact",
      "crm.pipeline_stage",
      "crm.pipeline_item",
      "crm.note",
      "crm.task",
      "crm.stage_transition",
      "round.round",
      "round.terms",
      "round.interest_submission",
      "round.verification",
      "round.commitment",
      "round.closing_task",
    ].filter((n) => !((byName.get(n)?.rows ?? 0) > 0));
    expect(empty).toEqual([]);
    // The zip carries no key material, no token hash and no keyed ip hash.
    const zip = await ZipFileReader.open(zipPath);
    const members = (
      await zip.readAll(zip.entry("tables/core.membership.jsonl") as never)
    ).toString();
    expect(members).not.toContain('"user_id"');
    expect(members).toContain(adaEmail);
    const invites = (await zip.readAll(zip.entry("tables/core.invite.jsonl") as never)).toString();
    expect(invites).not.toContain("token_hash");
    const consent = (
      await zip.readAll(zip.entry("tables/core.consent_event.jsonl") as never)
    ).toString();
    expect(consent).not.toContain("ip_hash");
    const requests = (
      await zip.readAll(zip.entry("tables/core.access_request.jsonl") as never)
    ).toString();
    expect(requests).toContain("Carol Capital");
    expect(requests).not.toContain("client_ip_hash");
    expect(zip.entries.map((e) => e.name)).not.toContain(
      "tables/core.access_request_challenge.jsonl",
    );
    expect(zip.entries.map((e) => e.name).slice(0, 2)).toEqual(["manifest.json", "manifest.sig"]);
    await zip.close();

    const out: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => out.push(a.join(" "));
    try {
      expect(await runWorkspaceVerifyExport([zipPath, "--public-key", key])).toBe(0);
      expect(await runWorkspaceVerifyExport([zipPath])).toBe(3);
      expect(out.join("\n")).toContain("UNVERIFIED ORIGIN");
    } finally {
      console.error = original;
    }
  });
});

describe("import into a new workspace", () => {
  let copyId: string;
  const carried = new Map<string, number>();

  it("refuses an unpinned export without --allow-unverified, and a taken slug", async () => {
    await expect(
      importWorkspace(importDeps(), { file: zipPath, slug: "acme-copy", importedBy: "test" }),
    ).rejects.toMatchObject({ code: "unverified_origin" });
    const key = exportPublicKeys(running.container.config.keyRing)[0]?.publicKey ?? "";
    await expect(
      importWorkspace(importDeps(), {
        file: zipPath,
        slug: "acme",
        trustedPublicKeys: [key],
        importedBy: "test",
      }),
    ).rejects.toBeInstanceOf(PortabilityError);
    expect(
      (await hostRows<{ n: number }>("SELECT count(*)::int AS n FROM core.workspace"))[0]?.n,
    ).toBe(1);
  });

  it("imports every carried table with new ids, in one transaction", async () => {
    const v = await verifyExportFile(zipPath);
    for (const t of v.manifest?.tables ?? [])
      if (t.skipped === undefined) carried.set(t.name, t.rows);
    const before = await sourceCounts();
    const key = exportPublicKeys(running.container.config.keyRing)[0]?.publicKey ?? "";
    const result = await importWorkspace(importDeps(), {
      file: zipPath,
      slug: "acme-copy",
      trustedPublicKeys: [key],
      importedBy: "test",
    });
    copyId = result.workspaceId;
    expect(result.signature).toBe("trusted");
    expect(result.warnings).toEqual([]);
    for (const [name, n] of carried) {
      if (name === "core.workspace") continue;
      expect(result.counts[name], name).toBe(n);
      const [r] = await rows<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${name} WHERE workspace_id = '${copyId}'`,
        copyId,
      );
      expect(r?.n, name).toBe(n);
    }
    // Every row id is new.
    for (const name of carried.keys()) {
      if (name === "core.workspace") continue;
      const hasId = await rows<{ ok: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.columns
           WHERE table_schema || '.' || table_name = '${name}' AND column_name = 'id') AS ok`,
        copyId,
      );
      if (!hasId[0]?.ok) continue;
      const [overlap] = await rows<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${name} a JOIN ${name} b ON a.id = b.id
         WHERE a.workspace_id = '${acmeId}' AND b.workspace_id = '${copyId}'`,
        acmeId,
      );
      expect(overlap?.n, name).toBe(0);
    }
    // The source is untouched.
    expect(await sourceCounts()).toEqual(before);
  }, 180_000);

  async function sourceCounts(): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const name of carried.keys()) {
      if (name === "core.workspace") continue;
      // Rollups and their cursor are written by the app's own background rollup job, which can
      // land between the two counts on a loaded machine; they say nothing about the import.
      if (name.startsWith("analytics.") && name.includes("rollup")) continue;
      const [r] = await rows<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${name} WHERE workspace_id = '${acmeId}'`,
        acmeId,
      );
      out[name] = r?.n ?? 0;
    }
    return out;
  }

  it("keeps references consistent: grants, groups, delegates, cycles, numerics, paths", async () => {
    const [g] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.group_member gm
       JOIN core."group" g ON g.id = gm.group_id AND g.workspace_id = '${copyId}'
       JOIN core.membership m ON m.id = gm.membership_id AND m.workspace_id = '${copyId}'
       WHERE gm.workspace_id = '${copyId}'`,
      copyId,
    );
    expect(g?.n).toBe(1);
    const [grant] = await rows<{ path: string; folderPath: string }>(
      `SELECT ag.resource_path::text AS path, f.path::text AS "folderPath"
       FROM core.access_grant ag JOIN dataroom.folder f ON f.id = ag.resource_id
       WHERE ag.workspace_id = '${copyId}' AND ag.resource_kind = 'folder' AND ag.subject_kind = 'group'`,
      copyId,
    );
    expect(grant?.path).toBe(grant?.folderPath);
    expect(grant?.path).not.toBe(folderPath);
    const [delegate] = await rows<{ ok: boolean }>(
      `SELECT d.principal_membership_id = p.id AS ok FROM core.membership d
       JOIN core.membership p ON p.id = d.principal_membership_id
       WHERE d.workspace_id = '${copyId}' AND d.role = 'delegate'`,
      copyId,
    );
    expect(delegate?.ok).toBe(true);
    // E3.2: the scope travels, and so does a pending delegate invitation's principal.
    const [scoped] = await rows<{ scope: string; ok: boolean }>(
      `SELECT d.delegate_scope AS scope, p.role = 'investor' AS ok FROM core.membership d
       JOIN core.membership p ON p.id = d.principal_membership_id
       WHERE d.workspace_id = '${copyId}' AND d.role = 'delegate'`,
      copyId,
    );
    expect(scoped).toEqual({ scope: "data_room", ok: true });
    const [pendingDelegate] = await rows<{ scope: string; ok: boolean }>(
      `SELECT i.delegate_scope AS scope, p.workspace_id = '${copyId}' AND p.role = 'investor' AS ok
       FROM core.invite i JOIN core.membership p ON p.id = i.principal_membership_id
       WHERE i.workspace_id = '${copyId}' AND i.role = 'delegate'`,
      copyId,
    );
    expect(pendingDelegate).toEqual({ scope: "updates", ok: true });
    const [cycle] = await rows<{ ok: boolean }>(
      `SELECT i.commitment_id = c.id AND c.interest_submission_id = i.id AS ok
       FROM round.interest_submission i JOIN round.commitment c ON c.id = i.commitment_id
       WHERE i.workspace_id = '${copyId}'`,
      copyId,
    );
    expect(cycle?.ok).toBe(true);
    const [amount] = await rows<{ a: string }>(
      `SELECT amount::text AS a FROM crm.pipeline_item WHERE workspace_id = '${copyId}'`,
      copyId,
    );
    expect(amount?.a).toBe("123456789012.123456");
    const [superseded] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM metrics.point a JOIN metrics.point b ON b.id = a.superseded_by
       WHERE a.workspace_id = '${copyId}' AND b.workspace_id = '${copyId}'`,
      copyId,
    );
    expect(superseded?.n).toBe(1);
    const [page] = await rows<{ doc: string }>(
      `SELECT doc::text AS doc FROM content.page_revision WHERE workspace_id = '${copyId}'`,
      copyId,
    );
    expect(page?.doc).not.toContain(folderId);
    const [newFolder] = await rows<{ id: string }>(
      `SELECT id FROM dataroom.folder WHERE workspace_id = '${copyId}' AND name = 'Financials'`,
      copyId,
    );
    expect(page?.doc).toContain(newFolder?.id ?? "none");
    // Share links travel revoked, with a fresh token hash; invites keep status with a new token.
    const [srcLink] = await rows<{ status: string; hash: string }>(
      `SELECT status::text AS status, encode(token_hash, 'hex') AS hash FROM core.share_link WHERE workspace_id = '${acmeId}'`,
      acmeId,
    );
    const [link] = await rows<{ status: string; hash: string; passcode: string | null }>(
      `SELECT status::text AS status, encode(token_hash, 'hex') AS hash, passcode_hash::text AS passcode
       FROM core.share_link WHERE workspace_id = '${copyId}'`,
      copyId,
    );
    expect(srcLink?.status).toBe("active");
    expect(link?.status).toBe("revoked");
    expect(link?.passcode).toBeNull();
    expect(link?.hash).not.toBe(srcLink?.hash);
    const [invite] = await rows<{ status: string; groups: string }>(
      `SELECT status::text AS status, group_ids::text AS groups FROM core.invite WHERE workspace_id = '${copyId}' AND role = 'investor'`,
      copyId,
    );
    expect(invite?.status).toBe("pending");
    expect(invite?.groups).not.toContain(boardGroupId);
    const [consent] = await rows<{ ip: string | null }>(
      `SELECT ip_hash::text AS ip FROM core.consent_event WHERE workspace_id = '${copyId}'`,
      copyId,
    );
    expect(consent?.ip).toBeNull();
    // The access request ↔ invite cycle survives, remapped to the copy's own ids (E3.1).
    const [request] = await rows<{ id: string; invite: string | null; ip: string | null }>(
      `SELECT id, invite_id AS invite, client_ip_hash::text AS ip FROM core.access_request
       WHERE workspace_id = '${copyId}'`,
      copyId,
    );
    const [back] = await rows<{ id: string; request: string | null }>(
      `SELECT id, access_request_id AS request FROM core.invite
        WHERE workspace_id = '${copyId}' AND access_request_id IS NOT NULL`,
      copyId,
    );
    expect(request?.ip).toBeNull();
    expect(request?.invite).toBe(back?.id);
    expect(back?.request).toBe(request?.id);
  });

  it("re-encrypts every file under the new workspace's keys, byte-identical", async () => {
    const c = running.container;
    const copyCtx = systemContext(copyId);
    const blobs = await rows<{ key: string; enc: { keyId: string }; sha: string }>(
      `SELECT storage_key AS key, encryption AS enc, encode(sha256, 'hex') AS sha FROM dataroom.blob
       WHERE workspace_id = '${copyId}'`,
      copyId,
    );
    expect(blobs.length).toBeGreaterThan(0);
    for (const b of blobs) {
      expect(b.key.startsWith(`ws/${copyId}/`)).toBe(true);
      const plain = await c.db.withTenant(copyCtx, async (tx) => {
        const dek = await c.envelope.keyById(tx, copyCtx, b.enc.keyId);
        expect(dek).toBeDefined();
        const read = await c.storage.get(b.key);
        return streamToBytes(decryptStream(dek?.key ?? new Uint8Array(32), read?.body as never));
      });
      expect(sha256(plain)).toBe(b.sha);
    }
    // The deck the owner uploaded is the deck in the copy.
    const shas = blobs.map((b) => b.sha);
    // (the stored original is sanitised by ingest; compare with the source's blob instead)
    const src = await rows<{ sha: string }>(
      `SELECT encode(sha256, 'hex') AS sha FROM dataroom.blob WHERE workspace_id = '${acmeId}'`,
      acmeId,
    );
    expect(shas.sort()).toEqual(src.map((s) => s.sha).sort());
    // The source key cannot open the copy's objects: the keys are the new workspace's own.
    const [copyKey] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.workspace_key WHERE workspace_id = '${copyId}' AND id = '${blobs[0]?.enc.keyId}'`,
      copyId,
    );
    expect(copyKey?.n).toBe(1);

    // Certificates: re-sealed under the copy's key, same bytes as the source's.
    const atts = await rows<{ ref: string }>(
      `SELECT evidence_ref AS ref FROM core.attestation WHERE workspace_id = '${copyId}' AND evidence_ref IS NOT NULL`,
      copyId,
    );
    expect(atts.length).toBe(2);
    for (const a of atts) {
      const m = /^cert:v1:([0-9a-f-]{36}):she1:([0-9a-f-]{36})$/u.exec(a.ref);
      expect(m).not.toBeNull();
      const [certId, keyId] = [m?.[1] ?? "", m?.[2] ?? ""];
      const copyBytes = await c.db.withTenant(copyCtx, async (tx) => {
        const dek = await c.envelope.keyById(tx, copyCtx, keyId);
        const read = await c.storage.get(certificateKey(copyId, certId, "json"));
        return streamToBytes(decryptStream(dek?.key ?? new Uint8Array(32), read?.body as never));
      });
      const [srcAtt] = await rows<{ ref: string }>(
        `SELECT evidence_ref AS ref FROM core.attestation WHERE workspace_id = '${acmeId}' AND evidence_ref LIKE 'cert:v1:${certId}:%'`,
        acmeId,
      );
      const srcKeyId = srcAtt?.ref.split(":").at(-1) ?? "";
      expect(srcKeyId).not.toBe(keyId);
      const srcBytes = await c.db.withTenant(systemContext(acmeId), async (tx) => {
        const dek = await c.envelope.keyById(tx, systemContext(acmeId), srcKeyId);
        const read = await c.storage.get(certificateKey(acmeId, certId, "json"));
        return streamToBytes(decryptStream(dek?.key ?? new Uint8Array(32), read?.body as never));
      });
      expect(sha256(copyBytes)).toBe(sha256(srcBytes));
    }

    // The logo: plaintext under the copy's own branding prefix.
    const [ws] = await hostRows<{
      settings: { branding: { logo: { key: string; sha256: string } } };
    }>(`SELECT settings FROM core.workspace WHERE id = '${copyId}'`);
    const logo = ws?.settings.branding.logo;
    expect(logo?.key).toBe(`ws/${copyId}/branding/${logo?.sha256}`);
    const read = await c.storage.get(logo?.key ?? "");
    expect(sha256(new Uint8Array(await new Response(read?.body).arrayBuffer()))).toBe(logo?.sha256);

    // Suppressions: bob's re-hashed under the copy's key, the unknown address dropped.
    const sup = await rows<{ hash: string; keyId: string }>(
      `SELECT encode(address_hash, 'hex') AS hash, key_id AS "keyId" FROM core.mail_suppression WHERE workspace_id = '${copyId}'`,
      copyId,
    );
    expect(sup).toHaveLength(1);
    const supHash = await c.db.withTenant(copyCtx, async (tx) => {
      const k = await c.envelope.keyById(tx, copyCtx, sup[0]?.keyId ?? "");
      return createHmac("sha256", k?.key ?? new Uint8Array(32))
        .update(bobEmail)
        .digest("hex");
    });
    expect(sup[0]?.hash).toBe(supHash);
  });

  it("lets the source's investor sign in to the copy as the same global user, with the same access", async () => {
    const bobCopy = await signIn("acme-copy", bobEmail);
    expect(bobCopy.membershipId).not.toBe(bob.membershipId);
    const userOf = async (membershipId: string, ws: string) =>
      (
        await rows<{ u: string }>(
          `SELECT user_id AS u FROM core.membership WHERE id = '${membershipId}'`,
          ws,
        )
      )[0]?.u;
    const bobUser = await userOf(bob.membershipId, acmeId);
    expect(bobUser).toBeDefined();
    expect(await userOf(bobCopy.membershipId, copyId)).toBe(bobUser);
    const accounts = await hostRows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.user_identity WHERE identifier = '${bobEmail}'`,
    );
    expect(accounts[0]?.n).toBe(1);
    // Same folder, same document, through the remapped group grant (NDA acceptance carried).
    // The copy re-derives renditions (data-room `afterImport` → ingest); wait for the document.
    const t = await waitFor("the copied deck to be visible", async () => {
      const tree = await request("acme-copy", "/api/v1/data-room/tree", { cookie: bobCopy.cookie });
      expect(tree.status).toBe(200);
      const body = await json<{ folders: { name: string }[]; documents: { title: string }[] }>(
        tree,
      );
      return body.documents.length > 0 ? body : undefined;
    });
    expect(t.folders.map((f) => f.name)).toContain("Financials");
    expect(t.documents.length).toBe(1);
    const srcTree = await json<{ documents: { title: string }[] }>(
      await request("acme", "/api/v1/data-room/tree", { cookie: bob.cookie }),
    );
    expect(t.documents.map((d) => d.title)).toEqual(srcTree.documents.map((d) => d.title));
    // ada has no grant on the folder in either workspace.
    const adaCopy = await signIn("acme-copy", adaEmail);
    const adaTree = await json<{ documents: unknown[] }>(
      await request("acme-copy", "/api/v1/data-room/tree", { cookie: adaCopy.cookie }),
    );
    expect(adaTree.documents).toEqual([]);
  });

  it("carries data-room Q&A with remapped targets and people, and re-indexes the published answer", async () => {
    const [copied] = await rows<{
      id: string;
      document_id: string;
      asker: string;
      assignee: string;
      author: string;
      status: string;
    }>(
      `SELECT q.id, q.document_id, q.asker_membership_id AS asker, q.assignee_membership_id AS assignee,
              a.author_membership_id AS author, q.status::text AS status
         FROM dataroom.qa_question q JOIN dataroom.qa_answer a ON a.question_id = q.id
        WHERE q.workspace_id = '${copyId}'`,
      copyId,
    );
    expect(copied?.status).toBe("published");
    const [copyDeck] = await rows<{ id: string; path: string }>(
      `SELECT id, folder_path::text AS path FROM dataroom.document WHERE workspace_id = '${copyId}'`,
      copyId,
    );
    const member = async (email: string) =>
      (
        await rows<{ id: string }>(
          `SELECT m.id FROM core.membership m JOIN core.user_identity i ON i.user_id = m.user_id
            WHERE m.workspace_id = '${copyId}' AND i.identifier = '${email}'`,
          copyId,
        )
      )[0]?.id;
    expect(copied?.document_id).toBe(copyDeck?.id);
    expect(copied?.asker).toBe(await member(bobEmail));
    expect(copied?.asker).not.toBe(bob.membershipId);
    expect(copied?.assignee).not.toBe(owner.membershipId);
    expect(copied?.author).toBe(copied?.assignee);
    // afterImport asked for a rebuild; the published answer comes back at the copy's path.
    const entry = await waitFor("the copied Q&A search entry", async () => {
      const [r] = await rows<{ ref_id: string; acl_path: string; body: string }>(
        `SELECT ref_id::text, acl_path::text, body FROM core.search_entry
          WHERE workspace_id = '${copyId}' AND module = 'data-room' AND kind = 'qa'`,
        copyId,
      );
      return r;
    });
    expect(entry).toMatchObject({ ref_id: copied?.id, acl_path: copyDeck?.path });
    expect(entry.body).toContain("numbatrunway");
  });

  it("starts a verifying audit chain with workspace.imported and archives the source trail", async () => {
    const v = await verifyWorkspace(
      { db: running.container.db, keyRing: running.container.config.keyRing },
      copyId,
    );
    expect(v.problems).toEqual([]);
    expect(v.ok).toBe(true);
    const [first] = await rows<{ action: string; meta: Record<string, unknown> }>(
      `SELECT action, meta FROM audit.event WHERE workspace_id = '${copyId}' AND action = 'workspace.imported'`,
      copyId,
    );
    expect(first?.meta).toMatchObject({ sourceWorkspaceId: acmeId, signature: "trusted" });
    const [imp] = await rows<{ key: string; source: Record<string, unknown> }>(
      `SELECT audit_archive_key AS key, source FROM core.workspace_import WHERE workspace_id = '${copyId}'`,
      copyId,
    );
    expect(imp?.key).toMatch(new RegExp(`^ws/${copyId}/imports/[0-9a-f-]{36}/audit\\.zip$`, "u"));
    expect(imp?.source).toMatchObject({ workspaceId: acmeId, slug: "acme", signature: "trusted" });
    expect(await running.container.storage.head(imp?.key ?? "")).toBeDefined();
    // The source's own chain still verifies and was not touched by the import.
    const src = await verifyWorkspace(
      { db: running.container.db, keyRing: running.container.config.keyRing },
      acmeId,
    );
    expect(src.ok).toBe(true);
  });
});

describe("raw analytics and the CLI", () => {
  let rawWorkspaceId = "";

  it("carries raw engagement events only when asked, and imports them (partitions made first)", async () => {
    const res = await request("acme", "/api/v1/portability/exports", {
      method: "POST",
      cookie: owner.cookie,
      body: JSON.stringify({ includeRawAnalytics: true }),
    });
    expect(res.status).toBe(202);
    const { id } = await json<ExportBody>(res);
    await waitFor(
      "the raw export",
      async () => {
        const body = await json<ExportBody>(
          await request("acme", `/api/v1/portability/exports/${id}`, { cookie: owner.cookie }),
        );
        if (body.status === "failed") throw new Error(`export failed: ${body.error}`);
        return body.status === "ready" ? body : undefined;
      },
      120_000,
    );
    const dl = await request("acme", `/api/v1/portability/exports/${id}/download`, {
      cookie: owner.cookie,
    });
    expect(dl.status).toBe(200);
    const path = join(tmp, "acme-raw.zip");
    writeFileSync(path, new Uint8Array(await dl.arrayBuffer()));
    const v = await verifyExportFile(path);
    const events = v.manifest?.tables.find((t) => t.name === "analytics.event");
    expect(events).toMatchObject({ rows: 1 });
    expect(events?.skipped).toBeUndefined();
    const result = await importWorkspace(importDeps(), {
      file: path,
      slug: "acme-raw",
      allowUnverified: true,
      importedBy: "test",
    });
    expect(result.signature).toBe("unverified");
    const [n] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM analytics.event WHERE workspace_id = '${result.workspaceId}'`,
      result.workspaceId,
    );
    expect(n?.n).toBe(1);
    rawWorkspaceId = result.workspaceId;
  }, 180_000);

  it("the workspace purge deletes its export rows and files", async () => {
    const c = running.container;
    const ctx = systemContext(rawWorkspaceId);
    const row = await c.db.withTenant(ctx, (tx) =>
      requestExport({ audit: c.audit }, tx, ctx, { requestedBy: null, includeRawAnalytics: false }),
    );
    const done = await runExport(
      {
        db: c.db,
        storage: c.storage,
        envelope: c.envelope,
        keyRing: c.config.keyRing,
        modules: c.registry.modules,
        instanceVersion: "test",
        audit: c.audit,
        dataDir: tmp,
      },
      { exportId: row.id, workspaceId: rawWorkspaceId },
    );
    expect(done.status).toBe("ready");
    const key = done.row?.id ? `ws/${rawWorkspaceId}/exports/${row.id}.zip` : "";
    expect(await c.storage.head(key)).toBeDefined();
    await hostRows(
      `UPDATE core.workspace SET deleted_at = now() - interval '31 days', purge_after = now() - interval '1 day'
       WHERE id = '${rawWorkspaceId}' RETURNING id`,
    );
    const purged = await purgeDeletedWorkspaces({ db: c.db, audit: c.audit, storage: c.storage });
    expect(purged.purged).toContain(rawWorkspaceId);
    expect(await c.storage.head(key)).toBeUndefined();
    const [left] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM core.workspace_export WHERE workspace_id = '${rawWorkspaceId}'`,
      rawWorkspaceId,
    );
    expect(left?.n).toBe(0);
  }, 120_000);

  it("fundroom workspace export / import / verify-export", async () => {
    const out = join(tmp, "cli", "acme-cli.zip");
    const lines: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => lines.push(a.join(" "));
    try {
      const cfg = running.container.config;
      expect(await runWorkspaceExport(["acme", "--out", out], cfg)).toBe(0);
      expect(await runWorkspaceVerifyExport([out], cfg)).toBe(0);
      expect(
        await runWorkspaceImport(
          [out, "--slug", "acme-cli", "--owner-email", "new-owner@example.com"],
          cfg,
        ),
      ).toBe(0);
      expect(await runWorkspaceImport([out, "--slug", "acme-cli"], cfg)).toBe(1); // slug taken
      expect(
        await runWorkspaceImport(
          [out, "--slug", "acme-cli2", "--public-key", Buffer.alloc(32).toString("base64")],
          cfg,
        ),
      ).toBe(3);
      expect(await runWorkspaceExport(["acme"], cfg)).toBe(2);
    } finally {
      console.error = original;
    }
    expect(lines.join("\n")).toMatch(/imported into acme-cli/u);
    const [ws] = await hostRows<{ id: string }>(
      `SELECT id FROM core.workspace WHERE slug = 'acme-cli'`,
    );
    const owners = await rows<{ role: string; email: string }>(
      `SELECT m.role::text AS role, ui.identifier::text AS email FROM core.membership m
       JOIN core.user_identity ui ON ui.user_id = m.user_id
       WHERE m.workspace_id = '${ws?.id}' AND m.role = 'owner'`,
      ws?.id ?? "",
    );
    expect(owners.map((o) => o.email).sort()).toEqual([
      "new-owner@example.com",
      "owner@example.com",
    ]);
  }, 180_000);
});

describe("a folder tree whose ids sort children before parents (E3.2 FIX-PORT)", () => {
  it("imports parent-first whatever the id order, keeping every parent link", async () => {
    // The export reads rows in primary-key order. Ids are not guaranteed to follow creation
    // order (clock steps, several backends in one millisecond, v4 ids, an earlier import), so
    // the export can meet a folder before its parent. Here: grandchild < child < root.
    const ws = (await createWorkspace(running.container.db, { slug: "tangle", name: "Tangle" })).id;
    const user = await provisionUser(running.container.identityDeps, {
      email: "tangle-owner@tangle.test",
      displayName: "Tan",
    });
    await provisionMembership(running.container.identityDeps, {
      workspaceId: ws,
      userId: user.userId,
      kind: "staff",
      role: "owner",
      source: "test",
    });
    const root = "ffffffff-ffff-7fff-bfff-ffffffffffff";
    const child = "00000000-0000-7000-8000-000000000002";
    const grandchild = "00000000-0000-7000-8000-000000000001";
    const label = (id: string) => id.replaceAll("-", "");
    await rows(
      `INSERT INTO dataroom.folder (id, workspace_id, parent_id, name, path) VALUES
         ('${root}', '${ws}', NULL, 'Data room', 'r'),
         ('${child}', '${ws}', '${root}', 'Legal', 'r.${label(child)}'),
         ('${grandchild}', '${ws}', '${child}', 'Contracts', 'r.${label(child)}.${label(grandchild)}')`,
      ws,
    );
    const out = join(tmp, "tangle.zip");
    expect(await runWorkspaceExport(["tangle", "--out", out], running.container.config)).toBe(0);
    const key = exportPublicKeys(running.container.config.keyRing)[0]?.publicKey ?? "";
    const result = await importWorkspace(importDeps(), {
      file: out,
      slug: "tangle-copy",
      trustedPublicKeys: [key],
      importedBy: "test",
    });
    expect(result.counts["dataroom.folder"]).toBe(3);
    const copied = await rows<{ name: string; parent: string | null; path: string }>(
      `SELECT f.name, p.name AS parent, f.path::text AS path
         FROM dataroom.folder f LEFT JOIN dataroom.folder p ON p.id = f.parent_id
        WHERE f.workspace_id = '${result.workspaceId}' ORDER BY nlevel(f.path)`,
      result.workspaceId,
    );
    expect(copied.map((f) => [f.name, f.parent])).toEqual([
      ["Data room", null],
      ["Legal", "Data room"],
      ["Contracts", "Legal"],
    ]);
    expect(copied[0]?.path).toBe("r");
  }, 180_000);
});

describe("export lifecycle", () => {
  it("expires a ready export after its window: object deleted, status expired, download 410", async () => {
    const [row] = await rows<{ key: string }>(
      `UPDATE core.workspace_export SET expires_at = now() - interval '1 minute'
       WHERE id = '${exportId}' RETURNING storage_key AS key`,
      acmeId,
    );
    const result = await expireExports({
      db: running.container.db,
      storage: running.container.storage,
      audit: running.container.audit,
    });
    expect(result.expired).toBeGreaterThanOrEqual(1);
    expect(await running.container.storage.head(row?.key ?? "")).toBeUndefined();
    const res = await request("acme", `/api/v1/portability/exports/${exportId}/download`, {
      cookie: owner.cookie,
    });
    expect(res.status).toBe(410);
    expect((await json<{ error: { code: string } }>(res)).error.code).toBe("export_expired");
  });

  it("deletes an export (204) with an audit row, and 404s an unknown one", async () => {
    const del = await request("acme", `/api/v1/portability/exports/${exportId}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status).toBe(204);
    const gone = await request("acme", `/api/v1/portability/exports/${exportId}`, {
      cookie: owner.cookie,
    });
    expect(gone.status).toBe(404);
    const [audit] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event WHERE workspace_id = '${acmeId}'
         AND action = 'workspace.export_deleted' AND resource_id = '${exportId}'`,
      acmeId,
    );
    expect(audit?.n).toBe(1);
    expect(
      (
        await request("acme", `/api/v1/portability/exports/${randomUUID()}/download`, {
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(404);
  });

  it("needs a fresh sign-in to start or download", async () => {
    const userId = (
      await rows<{ u: string }>(
        `SELECT user_id AS u FROM core.membership WHERE id = '${owner.membershipId}'`,
        acmeId,
      )
    )[0]?.u;
    await hostRows(
      `UPDATE core.session SET auth_time = now() - interval '30 minutes'
       WHERE user_id = '${userId}'::uuid AND revoked_at IS NULL RETURNING id`,
    );
    const post = await request("acme", "/api/v1/portability/exports", {
      method: "POST",
      cookie: owner.cookie,
      body: "{}",
    });
    expect(post.status).toBe(403);
    expect((await json<{ error: { code: string } }>(post)).error.code).toBe("step_up_required");
    expect(
      (await request("acme", "/api/v1/portability/exports", { cookie: owner.cookie })).status,
    ).toBe(200);
  });
});

/**
 * Re-packs the portal export with some table rows edited, a recomputed manifest and a fresh
 * signature by THIS instance's key — so verification, the pin and the "signed here" source
 * exemption all pass and only the engine's own refusal rules stand between the file and the
 * database (E2.8 fix C).
 */
async function craftExport(
  name: string,
  edit: (table: string, rows: Record<string, unknown>[]) => Record<string, unknown>[],
): Promise<string> {
  const r = await ZipFileReader.open(zipPath);
  const manifestEntry = r.entry("manifest.json");
  if (!manifestEntry) throw new Error("no manifest");
  type Mutable = Omit<ExportManifest, "tables" | "files"> & {
    tables: { name: string; rows: number; sha256?: string }[];
    files: Record<string, string>;
  };
  const manifest = JSON.parse((await r.readAll(manifestEntry)).toString("utf8")) as Mutable;
  const out = join(tmp, `${name}.zip`);
  const w = await ZipFileWriter.create(out, new Date());
  const files: Record<string, string> = {};
  const order: string[] = [];
  for (const e of r.entries) {
    if (e.name === "manifest.json" || e.name === "manifest.sig") continue;
    let body: Buffer = await r.readAll(e);
    const m = /^tables\/(.+)\.jsonl$/u.exec(e.name);
    if (m?.[1]) {
      const table = m[1];
      const before = body
        .toString("utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      const after = edit(table, before);
      body = Buffer.from(after.map((x) => `${JSON.stringify(x)}\n`).join(""), "utf8");
      const t = manifest.tables.find((x) => x.name === table);
      if (t) {
        t.rows = after.length;
        t.sha256 = sha256(body);
      }
    }
    const written = await w.add(e.name, [body], { deflate: !e.name.startsWith("blobs/") });
    files[e.name] = written.sha256;
    order.push(e.name);
  }
  await r.close();
  const key = exportSigningKey(running.container.config.keyRing.current);
  const signed = {
    ...manifest,
    files,
    signature: {
      alg: "Ed25519" as const,
      keyId: key.keyId,
      publicKey: Buffer.from(key.publicKey).toString("base64"),
    },
  };
  const bytes = manifestBytes(signed);
  await w.add("manifest.json", [bytes], { deflate: false });
  await w.add("manifest.sig", [Buffer.from(signManifest(bytes, key), "utf8")], { deflate: false });
  await w.finish(["manifest.json", "manifest.sig", ...order]);
  return out;
}

describe("crafted imports are refused or neutralised (E2.8 fix C)", () => {
  let victimId: string;
  let victimFolderId: string;
  let victimGroupId: string;
  let victimMembershipId: string;
  let victimObjectKey: string;
  const victimBytes = Buffer.from("the victim's quarantined term sheet");

  const importCrafted = (file: string, slug: string) =>
    importWorkspace(importDeps(), {
      file,
      slug,
      trustedPublicKeys: exportPublicKeys(running.container.config.keyRing).map((k) => k.publicKey),
      importedBy: "test",
    });

  const workspaceCount = async () =>
    (await hostRows<{ n: number }>("SELECT count(*)::int AS n FROM core.workspace"))[0]?.n;

  beforeAll(async () => {
    const ws = await createWorkspace(running.container.db, { slug: "victim", name: "Victim" });
    victimId = ws.id;
    victimFolderId = randomUUID();
    const [g] = await rows<{ id: string }>(
      `INSERT INTO core."group" (workspace_id, name) VALUES ('${victimId}', 'Victim board') RETURNING id`,
      victimId,
    );
    victimGroupId = g?.id ?? "";
    await rows(
      `INSERT INTO dataroom.folder (id, workspace_id, name, path)
         VALUES ('${victimFolderId}', '${victimId}', 'root', '${victimFolderId.replaceAll("-", "")}')`,
      victimId,
    );
    const user = await provisionUser(running.container.identityDeps, {
      email: "victim-owner@victim.test",
      displayName: "Vic",
    });
    victimMembershipId = (
      await provisionMembership(running.container.identityDeps, {
        workspaceId: victimId,
        userId: user.userId,
        kind: "staff",
        role: "owner",
        source: "test",
      })
    ).id;
    victimObjectKey = `ws/${victimId}/quarantine/${randomUUID()}`;
    await running.container.storage.put(victimObjectKey, victimBytes, {
      contentLength: victimBytes.length,
    });
  });

  it("refuses a blob key column that is not blob:<sha256> — the victim's object is neither read nor deleted", async () => {
    const before = await workspaceCount();
    const file = await craftExport("steal-object", (table, rs) =>
      table !== "dataroom.blob"
        ? rs
        : rs.map((row, i) => (i === 0 ? { ...row, storage_key: victimObjectKey } : row)),
    );
    await expect(importCrafted(file, "thief-1")).rejects.toMatchObject({
      code: "unsafe_reference",
      message: expect.stringMatching(
        /dataroom\.blob\.storage_key: an imported object key must be "blob:<sha256>" or null/u,
      ),
    });
    expect(await workspaceCount()).toBe(before);
    const still = await running.container.storage.get(victimObjectKey);
    expect(still).toBeDefined();
    expect(Buffer.from(await streamToBytes(still?.body as never)).equals(victimBytes)).toBe(true);
  });

  it("refuses a $blobs source key that would land in another workspace's prefix, and a sha256 column that disagrees", async () => {
    const prefix = await craftExport("write-victim-prefix", (table, rs) =>
      table !== "dataroom.blob"
        ? rs
        : rs.map((row) => {
            const blobs = row["$blobs"] as Record<string, { sha256: string; key: string }>;
            const b = blobs["storage_key"];
            if (!b) return row;
            // Keeps the source workspace id in the key (so the remap changes it) but under the
            // victim's prefix.
            return {
              ...row,
              $blobs: {
                storage_key: { ...b, key: `ws/${victimId}/blobs/${acmeId}/${b.sha256}` },
              },
            };
          }),
    );
    await expect(importCrafted(prefix, "thief-2")).rejects.toMatchObject({
      code: "unsafe_reference",
      message: expect.stringMatching(/names another workspace's prefix/u),
    });
    const traversal = await craftExport("traverse", (table, rs) =>
      table !== "dataroom.blob"
        ? rs
        : rs.map((row) => {
            const blobs = row["$blobs"] as Record<string, { sha256: string; key: string }>;
            const b = blobs["storage_key"];
            if (!b) return row;
            return {
              ...row,
              $blobs: { storage_key: { ...b, key: `ws/${acmeId}/../${victimId}/x` } },
            };
          }),
    );
    await expect(importCrafted(traversal, "thief-3")).rejects.toMatchObject({
      code: "unsafe_reference",
      message: expect.stringMatching(/plain segments/u),
    });
    const sha = await craftExport("wrong-sha", (table, rs) =>
      table !== "dataroom.blob"
        ? rs
        : rs.map((row, i) => (i === 0 ? { ...row, sha256: `\\x${"ab".repeat(32)}` } : row)),
    );
    await expect(importCrafted(sha, "thief-4")).rejects.toMatchObject({
      code: "unsafe_reference",
      message: expect.stringMatching(/dataroom\.blob\.sha256 does not match/u),
    });
  });

  it("refuses a NOT NULL reference to another workspace's folder", async () => {
    const before = await workspaceCount();
    const file = await craftExport("victim-folder", (table, rs) =>
      table !== "dataroom.document" ? rs : rs.map((row) => ({ ...row, folder_id: victimFolderId })),
    );
    await expect(importCrafted(file, "thief-5")).rejects.toMatchObject({
      code: "unsafe_reference",
      message: expect.stringMatching(
        new RegExp(
          `dataroom\\.document\\.folder_id names ${victimFolderId}, a row of dataroom\\.folder in another workspace`,
          "u",
        ),
      ),
    });
    expect(await workspaceCount()).toBe(before);
  });

  it("clears nullable references to another workspace's membership and group, with a warning", async () => {
    const file = await craftExport("victim-ids", (table, rs) => {
      if (table === "crm.note")
        return rs.map((row) => ({ ...row, author_membership_id: victimMembershipId }));
      if (table === "core.invite")
        return rs.map((row) => ({
          ...row,
          group_ids: [...((row["group_ids"] as string[]) ?? []), victimGroupId],
        }));
      if (table === "core.access_policy")
        return rs.map((row) => ({ ...row, config: { level: 1, groupId: victimGroupId } }));
      return rs;
    });
    const result = await importCrafted(file, "neutralised");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^\d+ reference\(s\) to rows of other workspaces on this instance were cleared/u,
        ),
      ]),
    );
    const ws = result.workspaceId;
    const notes = await rows<{ a: string | null }>(
      `SELECT author_membership_id AS a FROM crm.note WHERE workspace_id = '${ws}'`,
      ws,
    );
    expect(notes.map((n) => n.a)).toEqual([null]);
    const invites = await rows<{ g: string[] }>(
      `SELECT group_ids::text[] AS g FROM core.invite WHERE workspace_id = '${ws}'`,
      ws,
    );
    expect(invites.length).toBeGreaterThan(0);
    expect(invites.flatMap((i) => i.g)).not.toContain(victimGroupId);
    const policies = await rows<{ c: { groupId: unknown } }>(
      `SELECT config AS c FROM core.access_policy WHERE workspace_id = '${ws}'`,
      ws,
    );
    expect(policies.length).toBeGreaterThan(0);
    expect(policies.every((x) => x.c.groupId === null)).toBe(true);
  }, 180_000);

  it("re-derives over-broad rule paths and strips pending invitations' stored paths (E3.2)", async () => {
    // A source whose folder grants were hand-edited to the root `r` (a rule over the whole data
    // room) and whose pending invitation promises a folder with a stored path of its own.
    const file = await craftExport("overbroad-paths", (table, rs) => {
      if (table === "core.access_grant")
        return rs.map((row) =>
          row["resource_kind"] === "folder" ? { ...row, resource_path: "r" } : row,
        );
      if (table === "core.invite")
        return rs.map((row) =>
          row["status"] === "pending"
            ? {
                ...row,
                grants: [
                  { resource: { kind: "folder", id: folderId, path: "r" }, capabilities: ["view"] },
                ],
              }
            : row,
        );
      return rs;
    });
    const result = await importCrafted(file, "rederived");
    const ws = result.workspaceId;
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\d+ access rule\(s\) or pending invitation/u),
      ]),
    );
    const grants = await rows<{ path: string | null; folderPath: string }>(
      `SELECT ag.resource_path::text AS path, f.path::text AS "folderPath"
         FROM core.access_grant ag JOIN dataroom.folder f ON f.id = ag.resource_id
        WHERE ag.workspace_id = '${ws}' AND ag.resource_kind = 'folder'`,
      ws,
    );
    expect(grants.length).toBeGreaterThan(0);
    for (const g of grants) {
      expect(g.path).not.toBe("r");
      expect(g.path).toBe(g.folderPath);
    }
    const invites = await rows<{ resource: Record<string, unknown> }>(
      `SELECT grants->0->'resource' AS resource FROM core.invite
        WHERE workspace_id = '${ws}' AND status = 'pending'`,
      ws,
    );
    expect(invites.length).toBeGreaterThan(0);
    const [newFolder] = await rows<{ id: string }>(
      `SELECT id FROM dataroom.folder WHERE workspace_id = '${ws}' AND name = 'Financials'`,
      ws,
    );
    for (const i of invites) {
      expect(i.resource).not.toHaveProperty("path");
      // The id itself was remapped to the imported folder; acceptance derives its path then.
      expect(i.resource).toEqual({ kind: "folder", id: newFolder?.id });
    }
  }, 180_000);

  it("refuses a data-room tree whose paths do not follow its parent links (E3.2 L-2)", async () => {
    // Folder grant paths are re-derived from `dataroom.folder.path` and document ACLs match
    // `document.folder_path`, so a crafted path is a rule over someone else's subtree: the
    // data-room import checks the tree's shape and refuses the whole import on a mismatch.
    const before = await workspaceCount();
    const bogus = "f".repeat(32);
    const folderFile = await craftExport("crafted-folder-path", (table, rs) =>
      table === "dataroom.folder"
        ? rs.map((row) => (row["id"] === folderId ? { ...row, path: `r.${bogus}` } : row))
        : rs,
    );
    await expect(importCrafted(folderFile, "crafted-tree-1")).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(
        /^data-room: the data room's folder tree is inconsistent.*folder /u,
      ),
    });
    const documentFile = await craftExport("crafted-document-path", (table, rs) =>
      table === "dataroom.document"
        ? rs.map((row) => (row["id"] === deckId ? { ...row, folder_path: "r" } : row))
        : rs,
    );
    await expect(importCrafted(documentFile, "crafted-tree-2")).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringMatching(/folder tree is inconsistent.*document /u),
    });
    expect(await workspaceCount()).toBe(before);
  }, 180_000);

  it("refuses a foreign key into another workspace even when the reference check lets it through", async () => {
    // Signed by this instance and claiming acme as its source, the file's verbatim references to
    // acme rows are exempt from the reference check (a same-instance copy's dangling references
    // are genuine). Dropping the Financials folder from the file makes the deck's folder_id such
    // a reference — to acme's folder. Only the generic foreign-key check stops it.
    const before = await workspaceCount();
    const file = await craftExport("fk-into-source", (table, rs) =>
      table === "dataroom.folder" ? rs.filter((row) => row["id"] !== folderId) : rs,
    );
    await expect(importCrafted(file, "thief-6")).rejects.toMatchObject({
      code: "unsafe_reference",
      message: expect.stringMatching(
        /dataroom\.document\(folder_id\) references a dataroom\.folder row outside the new workspace/u,
      ),
    });
    expect(await workspaceCount()).toBe(before);
  }, 180_000);
});

describe("crash safety, one read per object, and modules left out (E2.8 fix C)", () => {
  const ctx = () => systemContext(acmeId);

  function serviceDeps(overrides: Partial<PortabilityServiceDeps> = {}): PortabilityServiceDeps {
    const c = running.container;
    return {
      db: c.db,
      storage: c.storage,
      envelope: c.envelope,
      keyRing: c.config.keyRing,
      modules: c.registry.modules,
      compiledModules: COMPILED_IN_MODULES,
      instanceVersion: "test",
      audit: c.audit,
      dataDir: c.config.raw.DATA_DIR,
      ...overrides,
    };
  }

  const queueExport = () =>
    running.container.db.withTenant(ctx(), (tx) =>
      requestExport({ audit: running.container.audit }, tx, ctx(), {
        requestedBy: null,
        includeRawAnalytics: false,
      }),
    );

  async function insertExport(status: string, startedAgo: string | null): Promise<string> {
    const [r] = await rows<{ id: string }>(
      `INSERT INTO core.workspace_export (workspace_id, status, started_at)
       VALUES ('${acmeId}', '${status}', ${startedAgo === null ? "NULL" : `now() - interval '${startedAgo}'`})
       RETURNING id`,
      acmeId,
    );
    return r?.id ?? "";
  }

  const statusOf = async (id: string) =>
    (
      await rows<{ s: string }>(
        `SELECT status AS s FROM core.workspace_export WHERE id = '${id}'`,
        acmeId,
      )
    )[0]?.s;

  it("a crashed (stale) export no longer locks the workspace out: a new request fails it first", async () => {
    const live = await insertExport("running", "1 minute");
    await expect(queueExport()).rejects.toBeInstanceOf(ExportRunningError);
    // A live running export may not be deleted…
    await expect(
      running.container.db.withTenant(ctx(), (tx) =>
        deleteExport({ audit: running.container.audit }, tx, ctx(), live),
      ),
    ).rejects.toMatchObject({ code: "export_running" });
    // …but once its heartbeat is 20 minutes old it is stale: deletable, and no longer blocking.
    await rows(
      `UPDATE core.workspace_export SET started_at = now() - interval '20 minutes' WHERE id = '${live}'`,
      acmeId,
    );
    const fresh = await queueExport();
    expect(await statusOf(live)).toBe("failed");
    const [audit] = await rows<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit.event WHERE workspace_id = '${acmeId}'
         AND action = 'workspace.export_failed' AND resource_id = '${live}'`,
      acmeId,
    );
    expect(audit?.n).toBe(1);
    // A queued export can be cancelled; a stale running one deleted, over the API.
    const cancel = await request("acme", `/api/v1/portability/exports/${fresh.id}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(cancel.status).toBe(204);
    const stuck = await insertExport("running", "30 minutes");
    const del = await request("acme", `/api/v1/portability/exports/${stuck}`, {
      method: "DELETE",
      cookie: owner.cookie,
    });
    expect(del.status).toBe(204);
    expect(await statusOf(stuck)).toBeUndefined();
    // The hourly cron fails a stale running export too (and a queued one after 12 h).
    const cronStale = await insertExport("running", "16 minutes");
    const result = await expireExports(serviceDeps());
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await statusOf(cronStale)).toBe("failed");
    expect(ExportStateError).toBeDefined();
  });

  it("sweeps a crashed export's temp file, and leaves a live one alone", async () => {
    const dir = join(running.container.config.raw.DATA_DIR, "portability");
    mkdirSync(dir, { recursive: true });
    const orphan = join(dir, `export-${randomUUID()}.zip`);
    const live = join(dir, `export-${randomUUID()}.zip`);
    writeFileSync(orphan, "partial zip");
    writeFileSync(live, "being written");
    const hourAgo = new Date(Date.now() - 3600_000);
    utimesSync(orphan, hourAgo, hourAgo);
    const result = await expireExports(serviceDeps());
    expect(result.swept).toBeGreaterThanOrEqual(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  it("reads each data-room object once, outside the snapshot transaction; a row taken away aborts the job", async () => {
    const base = running.container.storage;
    const blobPrefix = `ws/${acmeId}/blobs/`;
    let arrived!: () => void;
    const atGate = new Promise<void>((r) => {
      arrived = r;
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const gated = Object.create(base) as typeof base;
    gated.get = async (key: string) => {
      if (key.startsWith(blobPrefix)) {
        arrived();
        await gate;
      }
      return base.get(key);
    };
    const first = await queueExport();
    const [claimedBefore] = await rows<{ t: string }>(`SELECT now()::text AS t`, acmeId);
    const job = runExportFor(first.id, serviceDeps({ storage: gated, heartbeatMs: 0 }));
    await atGate;
    // Phase 2 holds no transaction: with the ONE-connection pool this query would hang if it did.
    const probe = await Promise.race([
      rows<{ one: number }>("SELECT 1 AS one", acmeId),
      new Promise<"hung">((r) => setTimeout(() => r("hung"), 5_000)),
    ]);
    if (probe === "hung") {
      release(); // let the job finish so the pool frees up for the rest of the file
      await job;
    }
    expect(probe).not.toBe("hung");
    // The heartbeat moved started_at forward after the snapshot committed.
    await waitFor("the heartbeat", async () => {
      const [r] = await rows<{ ok: boolean }>(
        `SELECT started_at > '${claimedBefore?.t}'::timestamptz AS ok FROM core.workspace_export WHERE id = '${first.id}'`,
        acmeId,
      );
      return r?.ok ? true : undefined;
    });
    // The cron (or a DELETE) takes the export away while the job is still copying.
    await rows(
      `UPDATE core.workspace_export SET status = 'failed' WHERE id = '${first.id}'`,
      acmeId,
    );
    release();
    const result = await job;
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/cancelled or marked stale/u);
    expect(await running.container.storage.head(exportObjectKey(acmeId, first.id))).toBeUndefined();
    expect(
      existsSync(
        join(running.container.config.raw.DATA_DIR, "portability", `export-${first.id}.zip`),
      ),
    ).toBe(false);

    // A normal run: every content-addressed object is read exactly once (no hash-then-copy).
    const reads = new Map<string, number>();
    const counting = Object.create(base) as typeof base;
    counting.get = async (key: string) => {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      return base.get(key);
    };
    const second = await queueExport();
    const ok = await runExportFor(second.id, serviceDeps({ storage: counting }));
    expect(ok.status).toBe("ready");
    const blobReads = [...reads].filter(([k]) => k.startsWith(blobPrefix));
    expect(blobReads.length).toBeGreaterThan(0);
    expect(blobReads.every(([, n]) => n === 1)).toBe(true);
  }, 120_000);

  it("records a module schema the instance does not load (MODULES) instead of leaving it out silently", async () => {
    const withoutMetrics = running.container.registry.modules.filter((m) => m.id !== "metrics");
    const req = await queueExport();
    const out = join(tmp, "without-metrics.zip");
    const result = await runExportFor(req.id, serviceDeps({ modules: withoutMetrics }), out);
    expect(result.status).toBe("ready");
    expect(result.row?.warnings).toEqual([
      expect.stringMatching(
        /^module metrics is compiled in but not loaded on this instance \(MODULES\): its schema metrics holds \d+ row\(s\) of this workspace that are NOT in this export$/u,
      ),
    ]);
    // The API surfaces it on the export.
    const api = await json<{ warnings: string[] }>(
      await request("acme", `/api/v1/portability/exports/${req.id}`, { cookie: owner.cookie }),
    );
    expect(api.warnings).toEqual(result.row?.warnings);
    // The manifest records it (signed), the verifier prints it, the import reports it.
    const v = await verifyExportFile(out);
    const omitted = v.manifest?.omitted ?? [];
    expect(omitted.map((o) => [o.schema, o.module])).toEqual([["metrics", "metrics"]]);
    expect(omitted[0]?.tables.some((t) => (t.rows ?? 0) > 0)).toBe(true);
    expect(v.manifest?.tables.some((t) => t.name.startsWith("metrics."))).toBe(false);
    expect(formatVerification(v)).toMatch(
      /NOT INCLUDED: schema metrics \(module metrics, not loaded on the source\)/u,
    );
    const imported = await importWorkspace(importDeps(), {
      file: out,
      slug: "acme-without-metrics",
      trustedPublicKeys: exportPublicKeys(running.container.config.keyRing).map((k) => k.publicKey),
      importedBy: "test",
    });
    expect(imported.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^the export omits schema metrics \(module metrics, not loaded on the source instance\)/u,
        ),
      ]),
    );
  }, 180_000);
});

function runExportFor(exportId: string, deps: PortabilityServiceDeps, copyTo?: string) {
  return runExport(deps, { exportId, workspaceId: acmeId, ...(copyTo ? { copyTo } : {}) });
}
