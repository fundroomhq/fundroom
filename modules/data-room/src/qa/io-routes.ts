import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import { csvRecord, headerIndex, parseCsvRecords } from "@fundroom/csv";
import { lockWorkspaceFacts, type TenantContext } from "@fundroom/db";
import { parseWorkspaceSettings } from "@fundroom/domain";
import { MembershipRepo } from "@fundroom/identity";
import type { ModuleEnv, ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { Actor } from "../errors.js";
import { QA_EXPORT_CAP, type QaExportRow, QaLifecycleRepo } from "../repos/qa-lifecycle-repo.js";
import {
  QA_EXPORT_COLUMNS,
  QA_IMPORT_COLUMNS,
  QaExportQuery,
  QaImportBody,
  type QaImportError,
  type QaImportResult,
  QaImportResultSchema,
} from "./contracts.js";
import {
  defaultPublicText,
  QA_IMPORT_MAX_BYTES,
  QA_IMPORT_MAX_ROWS,
  type QaTargetKind,
} from "./rules.js";
import { indexQuestions } from "./search.js";

/*
 * Q&A CSV export and import (E3.3 D6), `data-room.qa_manage` on a fresh session.
 *
 * Export: every question with its answer, as the closing record ("export log for closing",
 * design/03 B5). Every field goes through `@fundroom/csv` (formula-guarded: an investor's
 * question is text a stranger chose). Audited `qa.exported`.
 *
 * Export over `QA_EXPORT_CAP` rows writes the first `QA_EXPORT_CAP` (oldest first) and says so
 * in `X-Fundroom-Export-Truncated: true` (and, for one minor release, the pre-rename
 * `X-Seedhost-Export-Truncated: true`).
 *
 * Import: staff-authored Q&A (typically an FAQ carried over from a previous data room). Header
 * row required; columns `target_kind,target_id,subject,question,answer,category,publish`. The
 * export's own file imports as it is: its other columns (`QA_EXPORT_ONLY_COLUMNS`) are ignored,
 * and — only when the header is exactly the export's column set, i.e. the file is our export —
 * the apostrophe the export put before a leading `= + - @ TAB CR` is taken off again; any other
 * file's cells are kept verbatim. At
 * most 500 rows and 1 MiB of CSV (the route's body limit is raised so a 1 MiB CSV always fits
 * its JSON envelope — `QA_IMPORT_BODY_LIMIT_BYTES`). Validated in full first; any row error
 * writes nothing (all-or-nothing) and a dry run never writes. A row with an answer and
 * `publish=true` is published to everyone who can view the target — unless the workspace
 * requires four-eyes approval, when it lands in `awaiting_approval` instead. Imports have no
 * asker, so no SLA clock (`due_at` null). Imports notify nobody (no events); published ones are
 * indexed. An error's `line` is the physical line of the file on which the record starts (header
 * = line 1; blank lines and line breaks inside quoted fields count), as an editor shows it.
 */

const ERRORS = errorResponses(400, 401, 403, 404, 409, 413, 429, 500);
const TAGS = ["data-room"];
const PERM = "data-room.qa_manage";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Excel reads a UTF-8 CSV as UTF-8 only with a byte-order mark. */
const BOM = String.fromCharCode(0xfeff);
const iso = (d: Date | null) => (d === null ? "" : d.toISOString());

/** Response header set when the export stopped at `QA_EXPORT_CAP` rows. */
export const QA_EXPORT_TRUNCATED_HEADER = "X-Fundroom-Export-Truncated";
/**
 * The pre-rename spelling (A-2, ADR-0062), set alongside {@link QA_EXPORT_TRUNCATED_HEADER} for one
 * minor release so a cached older SPA bundle still warns; removed in the next minor.
 */
export const LEGACY_QA_EXPORT_TRUNCATED_HEADER = "X-Seedhost-Export-Truncated";

/**
 * The largest request body `POST /qa/import` accepts. Its CSV (≤ `QA_IMPORT_MAX_BYTES`) travels
 * as a JSON string, and JSON escaping grows it — `"`, `\`, LF, CR, TAB to 2 bytes, other control
 * characters to 6 (`\u00XX`) — so 6× the CSV plus room for the envelope always fits. The server
 * applies it instead of the API's 1 MiB default for this one route (apps/server app.ts).
 */
export const QA_IMPORT_BODY_LIMIT_BYTES = 6 * QA_IMPORT_MAX_BYTES + 64 * 1024;

/** Export columns the import ignores (so an export file re-imports as it is). */
export const QA_EXPORT_ONLY_COLUMNS = [
  "id",
  "created_at",
  "status",
  "source",
  "target_title",
  "asker_name",
  "asker_email",
  "public_text",
  "assignee_name",
  "due_at",
  "visibility",
  "released_at",
  "published_at",
  "closed_reason",
] as const;

/** The export's formula guard (`@fundroom/csv` `csvField`): an apostrophe before one of these. */
const GUARDED = /^'[=+\-@\t\r]/u;
const unguard = (cell: string): string => (GUARDED.test(cell) ? cell.slice(1) : cell);

/**
 * Whether a header is our export's: exactly the export's column set (any order). Only then is
 * the file ours and a leading `'` before `= + - @ TAB CR` our formula guard; in any other file
 * it is the author's text and is kept verbatim.
 */
function isExportHeader(columns: ReadonlyMap<string, number>): boolean {
  return (
    columns.size === QA_EXPORT_COLUMNS.length && QA_EXPORT_COLUMNS.every((c) => columns.has(c))
  );
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

export function qaExportCsv(
  rows: readonly QaExportRow[],
  names: ReadonlyMap<string, { displayName: string; email: string | null }>,
): string {
  let out = `${BOM}${csvRecord(QA_EXPORT_COLUMNS)}`;
  for (const r of rows) {
    const asker = r.askerMembershipId === null ? undefined : names.get(r.askerMembershipId);
    const assignee =
      r.assigneeMembershipId === null ? undefined : names.get(r.assigneeMembershipId);
    const record: Record<(typeof QA_EXPORT_COLUMNS)[number], string> = {
      id: r.id,
      created_at: r.createdAt.toISOString(),
      status: r.status,
      source: r.source,
      target_kind: r.targetKind,
      target_id: r.targetId,
      target_title: r.targetTitle,
      asker_name: asker?.displayName ?? "",
      asker_email: asker?.email ?? "",
      subject: r.subject,
      question: r.body,
      public_text: r.publicText ?? "",
      category: r.category ?? "",
      assignee_name: assignee?.displayName ?? "",
      due_at: iso(r.dueAt),
      answer: r.answer ?? "",
      visibility: r.visibility ?? "",
      released_at: iso(r.releasedAt),
      published_at: iso(r.publishedAt),
      closed_reason: r.closedReason ?? "",
    };
    out += csvRecord(QA_EXPORT_COLUMNS.map((c) => record[c]));
  }
  return out;
}

export async function exportQa(
  services: ModuleServices,
  ctx: TenantContext,
  actor: Actor,
): Promise<{ csv: string; rows: number; truncated: boolean }> {
  return services.db.withTenant(ctx, async (tx) => {
    const read = await new QaLifecycleRepo(ctx, tx).exportRows();
    const truncated = read.length > QA_EXPORT_CAP;
    const rows = truncated ? read.slice(0, QA_EXPORT_CAP) : read;
    const ids = new Set<string>();
    for (const r of rows) {
      if (r.askerMembershipId !== null) ids.add(r.askerMembershipId);
      if (r.assigneeMembershipId !== null) ids.add(r.assigneeMembershipId);
    }
    const names = await new MembershipRepo(ctx, tx).namesFor([...ids]);
    await services.audit.record(tx, ctx, {
      action: "qa.exported",
      resourceKind: "workspace",
      resourceId: ctx.workspaceId,
      actorMembershipId: actor.membershipId,
      requestId: actor.requestId,
      sessionId: actor.sessionId,
      meta: { rows: rows.length, truncated },
    });
    return { csv: qaExportCsv(rows, names), rows: rows.length, truncated };
  });
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

/** One validated import row (target resolved to an id, the root folder for an empty folder id). */
export interface QaImportRow {
  readonly line: number;
  readonly targetKind: QaTargetKind;
  /** null: the root folder. */
  readonly targetId: string | null;
  readonly subject: string;
  readonly question: string;
  readonly answer: string | null;
  readonly category: string | null;
  readonly publish: boolean;
}

/**
 * Parses and checks the CSV's shape and every field (no database). Returns the rows and the
 * per-line errors; the caller checks targets and writes only when both the shape and the
 * targets are clean.
 */
export function parseQaImport(csv: string): {
  rows: QaImportRow[];
  dataRows: number;
  errors: QaImportError[];
} {
  const errors: QaImportError[] = [];
  if (Buffer.byteLength(csv, "utf8") > QA_IMPORT_MAX_BYTES)
    return { rows: [], dataRows: 0, errors: [{ line: 1, message: "the file is over 1 MiB" }] };
  const records = parseCsvRecords(csv);
  const [header, ...data] = records;
  if (header === undefined)
    return { rows: [], dataRows: 0, errors: [{ line: 1, message: "the file is empty" }] };
  if (header.cells.some((c) => c.includes("\u0000")))
    return {
      rows: [],
      dataRows: data.length,
      errors: [{ line: header.line, message: "the header contains a NUL character" }],
    };
  const index = headerIndex(header.cells);
  if (!index.ok)
    return {
      rows: [],
      dataRows: data.length,
      errors: [{ line: header.line, message: `column "${index.duplicateColumn}" appears twice` }],
    };
  const known = new Set<string>([...QA_IMPORT_COLUMNS, ...QA_EXPORT_ONLY_COLUMNS]);
  const unknown = [...index.columns.keys()].filter((c) => !known.has(c));
  const missing = ["target_kind", "subject", "question"].filter((c) => !index.columns.has(c));
  if (unknown.length > 0 || missing.length > 0) {
    const parts = [
      ...(missing.length > 0 ? [`missing column(s): ${missing.join(", ")}`] : []),
      ...(unknown.length > 0 ? [`unknown column(s): ${unknown.join(", ")}`] : []),
    ];
    return {
      rows: [],
      dataRows: data.length,
      errors: [{ line: header.line, message: parts.join("; ") }],
    };
  }
  if (data.length === 0)
    return { rows: [], dataRows: 0, errors: [{ line: 1, message: "the file has no data rows" }] };
  if (data.length > QA_IMPORT_MAX_ROWS)
    return {
      rows: [],
      dataRows: data.length,
      errors: [{ line: 1, message: `at most ${QA_IMPORT_MAX_ROWS} rows per import` }],
    };
  const fromExport = isExportHeader(index.columns);
  const rows: QaImportRow[] = [];
  for (const { cells, line } of data) {
    const get = (c: string) => {
      const at = index.columns.get(c);
      if (at === undefined) return "";
      const cell = cells[at] ?? "";
      return (fromExport ? unguard(cell) : cell).trim();
    };
    const kind = get("target_kind").toLowerCase();
    const targetId = get("target_id");
    const subject = get("subject");
    const question = get("question");
    const answer = get("answer");
    const category = get("category");
    const publishRaw = get("publish").toLowerCase();
    const publish = publishRaw === "true";
    // The first problem on the line is reported. A NUL anywhere on the line (ignored columns
    // included) refuses it: Postgres text cannot hold one.
    const problem = cells.some((c) => c.includes("\u0000"))
      ? "the line contains a NUL character"
      : kind !== "document" && kind !== "folder"
        ? 'target_kind must be "document" or "folder"'
        : targetId === "" && kind === "document"
          ? "target_id is required for a document"
          : targetId !== "" && !UUID.test(targetId)
            ? "target_id is not a uuid"
            : subject.length < 1 || subject.length > 200
              ? "subject must be 1 to 200 characters"
              : question.length < 1 || question.length > 5000
                ? "question must be 1 to 5000 characters"
                : answer.length > 20_000
                  ? "answer must be at most 20000 characters"
                  : category.length > 60
                    ? "category must be at most 60 characters"
                    : !["", "true", "false"].includes(publishRaw)
                      ? 'publish must be "true" or "false"'
                      : publish && answer === ""
                        ? "publish=true needs an answer"
                        : undefined;
    if (problem !== undefined || (kind !== "document" && kind !== "folder")) {
      errors.push({ line, message: problem ?? "bad target_kind" });
      continue;
    }
    rows.push({
      line,
      targetKind: kind,
      targetId: targetId === "" ? null : targetId.toLowerCase(),
      subject,
      question,
      answer: answer === "" ? null : answer,
      category: category === "" ? null : category,
      publish,
    });
  }
  return { rows, dataRows: data.length, errors };
}

export async function importQa(
  services: ModuleServices,
  ctx: TenantContext,
  actor: Actor,
  input: { readonly csv: string; readonly dryRun: boolean },
): Promise<QaImportResult> {
  const parsed = parseQaImport(input.csv);
  const errors = [...parsed.errors];
  return services.db.withTenant(ctx, async (tx) => {
    const repo = new QaLifecycleRepo(ctx, tx);
    // Targets: must exist and not be in the recycle bin.
    const docIds = parsed.rows
      .filter((r) => r.targetKind === "document" && r.targetId !== null)
      .map((r) => r.targetId as string);
    const folderIds = parsed.rows
      .filter((r) => r.targetKind === "folder" && r.targetId !== null)
      .map((r) => r.targetId as string);
    const liveDocs = await repo.liveDocumentIds([...new Set(docIds)]);
    const liveFolders = await repo.liveFolderIds([...new Set(folderIds)]);
    const root = await repo.rootFolderId();
    const resolved: { row: QaImportRow; targetId: string }[] = [];
    for (const row of parsed.rows) {
      const id = row.targetId ?? (row.targetKind === "folder" ? root : undefined);
      const live = row.targetKind === "document" ? liveDocs : liveFolders;
      if (id === undefined || (row.targetId !== null && !live.has(id))) {
        errors.push({
          line: row.line,
          message: `no such ${row.targetKind} (or it is in the trash)`,
        });
        continue;
      }
      resolved.push({ row, targetId: id });
    }
    errors.sort((a, b) => a.line - b.line);
    const result = (created: number): QaImportResult => ({
      rows: parsed.dataRows,
      created,
      errors,
    });
    if (errors.length > 0 || input.dryRun) return result(0);

    // Read the approval rule and SLA under the workspace row lock, not from the cached
    // workspace: an import must not slip past four-eyes that was switched on a moment ago. FOR
    // NO KEY UPDATE, not SHARE: this transaction audits (global order: workspace row → chain).
    const facts = await lockWorkspaceFacts(tx, ctx.workspaceId);
    const qa = parseWorkspaceSettings(facts?.settings).dataRoom.qa;
    const now = services.now();
    const published: string[] = [];
    let awaiting = 0;
    for (const { row, targetId } of resolved) {
      const target =
        row.targetKind === "document"
          ? { documentId: targetId, folderId: null }
          : { documentId: null, folderId: targetId };
      const release = row.publish && row.answer !== null && !qa.requireApproval;
      const status = release
        ? "published"
        : row.publish && row.answer !== null
          ? "awaiting_approval"
          : "open";
      const id = await repo.insertImported(
        {
          targetKind: row.targetKind,
          ...target,
          askerMembershipId: null,
          source: "import",
          status,
          subject: row.subject,
          body: row.question,
          category: row.category,
          createdBy: actor.membershipId,
          ...(release
            ? {
                visibility: "target" as const,
                publicText: defaultPublicText(row.subject, row.question),
                releasedAt: now,
                publishedAt: now,
                firstReleasedAt: now,
              }
            : {}),
          // No asker, so no SLA clock: `due_at` stays null (the SLA is a promise to an asker).
        },
        row.answer === null
          ? undefined
          : {
              body: row.answer,
              authorMembershipId: actor.membershipId,
              submittedAt: status === "awaiting_approval" ? now : null,
            },
      );
      if (release) published.push(id);
      if (status === "awaiting_approval") awaiting += 1;
    }
    await indexQuestions(services, tx, ctx, published);
    await services.audit.record(tx, ctx, {
      action: "qa.imported",
      resourceKind: "workspace",
      resourceId: ctx.workspaceId,
      actorMembershipId: actor.membershipId,
      requestId: actor.requestId,
      sessionId: actor.sessionId,
      meta: { created: resolved.length, published: published.length, awaitingApproval: awaiting },
    });
    return result(resolved.length);
  });
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

function actorOf(c: Context<ModuleEnv>, services: ModuleServices): Actor & { ctx: TenantContext } {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  if (!session || !membership || !tenant) throw new ApiError("unauthenticated");
  return {
    ctx: tenant,
    membershipId: membership.id,
    requestId: requestIdOf(c),
    sessionId: session.sessionId,
    ip: services.clientIp(c),
  };
}

export function registerQaIoRoutes(api: ModuleRouter, services: ModuleServices): void {
  const guard = () => services.guards.requirePermission(PERM, { fresh: true });

  api.openapi(
    createRoute({
      method: "get",
      path: "/qa/export",
      tags: TAGS,
      summary: "Export every Q&A question and answer as CSV",
      description: `Columns \`${QA_EXPORT_COLUMNS.join(",")}\`. RFC 4180 with CRLF endings and a UTF-8 BOM; a field beginning \`=\`, \`+\`, \`-\`, \`@\`, TAB or CR is prefixed with an apostrophe (question text is written by investors). Includes asker names and emails, internal state and closed questions: the closing record. At most ${QA_EXPORT_CAP} rows (oldest first); a longer log is cut there and the response carries \`${QA_EXPORT_TRUNCATED_HEADER}: true\`. Audited (\`qa.exported\`) and \`no-store\`.`,
      security: sessionSecurity,
      "x-requires": `${PERM}+fresh`,
      middleware: [guard()] as const,
      request: { query: QaExportQuery },
      responses: {
        200: {
          description: "The Q&A log",
          headers: {
            [QA_EXPORT_TRUNCATED_HEADER]: {
              description: `\`true\` when the log had more than ${QA_EXPORT_CAP} rows and was cut`,
              schema: { type: "string", enum: ["true"] },
            },
            [LEGACY_QA_EXPORT_TRUNCATED_HEADER]: {
              description: `Deprecated spelling of \`${QA_EXPORT_TRUNCATED_HEADER}\`, sent with the same value; removed in the next minor release`,
              deprecated: true,
              schema: { type: "string", enum: ["true"] },
            },
          },
          content: { "text/csv": { schema: z.string() } },
        },
        ...ERRORS,
      },
    }),
    async (c) => {
      const { ctx, ...actor } = actorOf(c, services);
      const { csv, truncated } = await exportQa(services, ctx, actor);
      const day = services.now().toISOString().slice(0, 10);
      return c.body(csv, 200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="data-room-qa-${day}.csv"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        ...(truncated
          ? { [QA_EXPORT_TRUNCATED_HEADER]: "true", [LEGACY_QA_EXPORT_TRUNCATED_HEADER]: "true" }
          : {}),
      }) as never;
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/qa/import",
      tags: TAGS,
      summary: "Import Q&A from CSV",
      description: `Header row with columns \`${QA_IMPORT_COLUMNS.join(",")}\` (\`target_kind\`, \`subject\`, \`question\` required). An empty \`target_id\` with kind \`folder\` is the root folder. The export's other columns (\`${QA_EXPORT_ONLY_COLUMNS.join(",")}\`) are ignored and, when the header is exactly the export's columns, its formula-guard apostrophe removed, so an export re-imports as it is (any other file's cells are kept verbatim). At most ${QA_IMPORT_MAX_ROWS} rows and 1 MiB of CSV (UTF-8); the request body may be up to ${QA_IMPORT_BODY_LIMIT_BYTES} bytes (413 above). Error lines are physical lines of the file (header = 1). A NUL character refuses its line. All-or-nothing: any row error writes nothing; \`dryRun\` validates without writing. A row with an answer and \`publish=true\` is published to everyone who can view the target, or held in \`awaiting_approval\` when the workspace requires approval. Nobody is notified. Audited (\`qa.imported\`).`,
      security: sessionSecurity,
      "x-requires": `${PERM}+fresh`,
      middleware: [guard()] as const,
      request: { body: jsonBody(QaImportBody) },
      responses: { 200: jsonResponse(QaImportResultSchema, "Import result"), ...ERRORS },
    }),
    async (c) => {
      const { ctx, ...actor } = actorOf(c, services);
      const body = c.req.valid("json");
      return c.json(await importQa(services, ctx, actor, body), 200);
    },
  );
}
