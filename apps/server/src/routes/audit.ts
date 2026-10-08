import {
  type AuditEventListRow,
  buildExportBundleAsync,
  ExportRangeTooLargeError,
  exportPublicKeys,
  listAuditEventsPage,
  MAX_EXPORT_ROWS,
  readWorkspaceExport,
  verifyWorkspace,
} from "@fundroom/audit";
import {
  ApiError,
  audit as a,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  requestIdOf,
  sessionOrApiKeySecurity,
  sessionSecurity,
  z,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import type { ApiDeps } from "./deps.js";

/*
 * Audit log (E2.7 package A): search, chain verification, the export signing keys and the
 * signed export bundle, under `/api/v1/audit/*` (authz-matrix.yaml "audit log (E2.7)").
 * Contracts live in `@fundroom/contracts` `audit.ts`; the bundle format and the offline
 * verifier in `@fundroom/audit` (`bundle.ts`, README "Signed export").
 *
 * - Reads run in the caller's tenant context, so the `tenant_fence` policy on `audit.event` is
 *   what keeps workspace B out of A's rows, not the WHERE clause alone.
 * - `GET /audit/verify` is `verifyWorkspace`, which opens its own system-context transaction;
 *   the handler holds no transaction while it runs (no second pool connection under a held tx).
 * - The export reads the range in one tenant transaction, builds the zip after releasing it
 *   (deflate on fflate's worker thread, so neither a pool connection nor the event loop is held
 *   for the build), then records `audit.exported` in a second, sequential transaction. The range
 *   was fixed at read time, so that row is never inside the bundle it describes; a failed build
 *   records nothing and returns nothing. At most `MAX_EXPORT_ROWS` rows (413 above), and one
 *   export per workspace at a time in this process (409 `export_running`): a bundle costs about
 *   0.9 s and 170 MB at the cap, and a double-click should not cost twice that.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 413, 429, 500, 503);
/** `GET /audit/verify` per member (E3.13 FIX1 A6). */
export const AUDIT_VERIFY_RATE_LIMIT = { max: 6, windowMs: 60_000 } as const;
const TAGS = ["audit"];

type Vars = AppEnv["Variables"];
interface Signed {
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

function signed(c: Context<AppEnv>): Signed {
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!membership || !tenant || !workspace) throw new ApiError("unauthenticated");
  return { membership, tenant, workspace };
}

/** The keyset cursor is the last seq served, as opaque base64url. */
function encodeCursor(seq: number): string {
  return Buffer.from(String(seq), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): number {
  const text = Buffer.from(cursor, "base64url").toString("utf8");
  if (!/^[1-9]\d{0,17}$/u.test(text)) throw new ApiError("validation_failed", "bad cursor");
  return Number(text);
}

function eventBody(e: AuditEventListRow) {
  return {
    id: e.id,
    seq: e.seq,
    occurredAt: e.occurredAt.toISOString(),
    actorKind: e.actorKind as "staff" | "external" | "system" | "host",
    actorMembershipId: e.actorMembershipId,
    actorName: e.actorName,
    onBehalfOfMembershipId: e.onBehalfOfMembershipId,
    action: e.action,
    resourceKind: e.resourceKind,
    resourceId: e.resourceId,
    subjectMembershipId: e.subjectMembershipId,
    subjectName: e.subjectName,
    outcome: e.outcome,
    ip: e.ip,
    userAgent: e.userAgent,
    requestId: e.requestId,
    meta: e.meta,
    diff: e.diff,
  };
}

export function registerAuditRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (p: string, fresh = false) =>
    requirePermission({ authz: () => deps.authz }, p, { fresh });
  /** Workspaces with an export in progress in this process (single-flight). */
  const exporting = new Set<string>();

  api.openapi(
    createRoute({
      method: "get",
      path: "/audit/events",
      tags: TAGS,
      summary: "Search the workspace audit log",
      description:
        "Newest first (`seq` descending). `action` is exact, or a prefix when it ends in `.`. `from`/`to` bound `occurredAt` inclusively. Names are joined from this workspace's memberships at read time and are `null` for a person who has been erased; the ids stay. Investors get 404, other staff without `audit.read` 403.",
      security: sessionOrApiKeySecurity,
      "x-requires": "audit.read+apikey",
      middleware: [
        requirePermission({ authz: () => deps.authz }, "audit.read", { apiKey: true }),
      ] as const,
      request: { query: a.AuditEventsQuery },
      responses: { 200: jsonResponse(a.AuditEventPageSchema, "One page of events"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const q = c.req.valid("query");
      const beforeSeq = q.cursor === undefined ? undefined : decodeCursor(q.cursor);
      const rows = await deps.db.withTenant(s.tenant, (tx) =>
        listAuditEventsPage(
          tx,
          s.workspace.id,
          {
            action: q.action,
            actorMembershipId: q.actorMembershipId,
            subjectMembershipId: q.subjectMembershipId,
            resourceKind: q.resourceKind,
            resourceId: q.resourceId,
            outcome: q.outcome,
            from: q.from === undefined ? undefined : new Date(q.from),
            to: q.to === undefined ? undefined : new Date(q.to),
          },
          { beforeSeq, limit: q.limit + 1 },
        ),
      );
      const items = rows.slice(0, q.limit);
      const last = items.at(-1);
      return c.json(
        {
          items: items.map(eventBody),
          nextCursor: rows.length > q.limit && last ? encodeCursor(last.seq) : null,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/audit/verify",
      tags: TAGS,
      summary: "Verify the workspace's hash chain and signed checkpoints",
      description:
        "Walks the whole chain in the database (every hash recomputed), checks each daily checkpoint still matches the row it snapshotted, and verifies checkpoint signatures under the server's key ring. With external anchoring, each anchored checkpoint's inclusion path and receipts are verified offline too (`anchors` summary; problems prefixed `anchor_path_invalid`, `anchor_receipt_failed`, `anchor_missing`; `anchor_late` is listed but does not clear `ok`). Only a trusted RFC 3161 time counts as `verified`; Rekor-only receipts are `presenceOnly`. At most 6 per member per minute (429 `rate_limited`). `ok: false` with `problems` when anything differs — a row rewritten or removed by someone with database access shows up here.",
      security: sessionSecurity,
      "x-requires": "audit.read",
      middleware: [perm("audit.read")] as const,
      responses: { 200: jsonResponse(a.AuditVerificationSchema, "Verification"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      // Walking the chain and checking every receipt is the most expensive read here: per member,
      // a handful per minute (E3.13 FIX1 A6). Receipt checks are also cached in-process.
      const limit = await deps.rateLimiter.hit(
        `audit:verify:${s.membership.id}`,
        AUDIT_VERIFY_RATE_LIMIT,
      );
      if (!limit.allowed) {
        throw new ApiError("rate_limited", "too many verifications; try again shortly", {
          retryAfterMs: limit.retryAfterMs,
        });
      }
      const r = await verifyWorkspace(
        {
          db: deps.db,
          keyRing: deps.keyRing,
          anchorDrivers: deps.auditAnchoring.drivers,
          anchorVerifiers: deps.auditAnchoring.verifiers,
        },
        s.workspace.id,
      );
      return c.json(
        {
          ok: r.ok,
          headSeq: r.headSeq,
          checkedRows: r.checkedRows,
          checkpoints: r.checkpoints,
          problems: [...r.problems],
          anchors: r.anchors,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/audit/export-key",
      tags: TAGS,
      summary: "The public keys export bundles are signed with",
      description:
        "Ed25519 public keys (base64, raw 32 bytes), one per server key ring entry; `current` signs new exports, the rest verify older ones. Record the current key somewhere you control: a bundle proves its origin only against a key obtained independently of it.",
      security: sessionSecurity,
      "x-requires": "audit.read",
      middleware: [perm("audit.read")] as const,
      responses: { 200: jsonResponse(a.AuditExportKeysSchema, "Public keys"), ...ERRORS },
    }),
    (c) => {
      signed(c);
      return c.json({ alg: "Ed25519" as const, keys: exportPublicKeys(deps.keyRing) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/audit/exports",
      tags: TAGS,
      summary: "Download a signed export of the audit log",
      description:
        "A zip with `manifest.json`, `manifest.sig` (Ed25519 over the manifest bytes), `events.jsonl` (the exact text each row's hash was computed over), `events.csv`, `checkpoints.json` and `VERIFY.md`; checkable offline with `fundroom audit verify-export`. The time window becomes the contiguous seq range covering it (a chain only verifies over contiguous rows), so a row with an out-of-order timestamp between those seqs is included. At most 50,000 rows (413 `payload_too_large` otherwise: narrow the date range and export in parts); one export per workspace at a time (409 `conflict`, reason `export_running`). Owner/legal only, with a fresh sign-in; records `audit.exported` with the range and the zip's sha256. `Cache-Control: private, no-store`.",
      security: sessionSecurity,
      "x-requires": "audit.export+fresh",
      middleware: [perm("audit.export", true)] as const,
      request: { body: jsonBody(a.AuditExportBody) },
      responses: {
        200: {
          description: "The signed bundle",
          content: { "application/zip": { schema: z.string().openapi({ format: "binary" }) } },
        },
        ...ERRORS,
      },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      const from = body.from === undefined ? undefined : new Date(body.from);
      const to = body.to === undefined ? undefined : new Date(body.to);
      if (exporting.has(s.workspace.id)) {
        throw new ApiError(
          "conflict",
          "an audit export for this workspace is already running; try again when it finishes",
          { reason: "export_running" },
        );
      }
      exporting.add(s.workspace.id);
      let bundle: Awaited<ReturnType<typeof buildExportBundleAsync>>;
      try {
        const input = await deps.db
          .withTenant(s.tenant, (tx) =>
            readWorkspaceExport(tx, {
              workspace: { id: s.workspace.id, slug: s.workspace.slug, name: s.workspace.name },
              from,
              to,
              generatedBy: { membershipId: s.membership.id },
              keyRing: deps.keyRing,
            }),
          )
          .catch((error: unknown) => {
            if (error instanceof ExportRangeTooLargeError) {
              throw new ApiError("payload_too_large", error.message, {
                rows: error.rows,
                maxRows: MAX_EXPORT_ROWS,
              });
            }
            throw error;
          });
        // Built with no transaction held; the range is already fixed by the read above.
        bundle = await buildExportBundleAsync(input);
        const b = bundle;
        await deps.db.withTenant(s.tenant, (tx) =>
          deps.audit.record(tx, s.tenant, {
            action: "audit.exported",
            resourceKind: "audit",
            requestId: requestIdOf(c),
            meta: {
              fromSeq: b.manifest.range.fromSeq,
              toSeq: b.manifest.range.toSeq,
              rows: b.manifest.rowCount,
              sha256: b.sha256,
              keyId: b.manifest.signature.keyId,
            },
          }),
        );
      } finally {
        exporting.delete(s.workspace.id);
      }
      const stamp = bundle.manifest.generatedAt.slice(0, 10);
      return c.body(bundle.bytes as Uint8Array<ArrayBuffer>, 200, {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="audit-${s.workspace.slug}-${stamp}.zip"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Content-SHA256": bundle.sha256,
      }) as never;
    },
  );
}
