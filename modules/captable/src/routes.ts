import {
  ApiError,
  type ApiErrorCode,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import type { ModuleEnv, ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import type { Context } from "hono";
import * as s from "./contracts.js";
import { type Actor, CaptableError, type CaptableErrorCode } from "./errors.js";
import { type CaptableService, createCaptableService } from "./service/captable.js";

/*
 * `/api/v1/captable/*` (E3.6 §8). Staff routes sit behind `captable.read` / `captable.manage`
 * (`requirePermission` answers an external caller 404, no oracle); publishing a snapshot also
 * needs a fresh step-up. `GET /me` is the investor's card and answers 404 — the same answer a
 * disabled module gives — whenever there is nothing to show. Handlers only shape responses: the
 * service decides, the repo touches SQL.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 422, 429, 500, 503);
const TAGS = ["captable"];

export const PERM_READ = "captable.read";
export const PERM_MANAGE = "captable.manage";

type Vars = ModuleEnv["Variables"];
interface Signed {
  readonly session: NonNullable<Vars["session"]> | undefined;
  readonly membership: Membership;
  readonly tenant: TenantContext;
}

function signed(c: Context<ModuleEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  if ((!session && !c.get("apiKey")) || !membership || !tenant)
    throw new ApiError("unauthenticated");
  return { session, membership, tenant };
}

const actorOf = (c: Context<ModuleEnv>, sg: Signed): Actor => ({
  membershipId: sg.membership.id,
  requestId: requestIdOf(c),
  sessionId: sg.session?.sessionId,
});

const API_CODE: Readonly<Record<CaptableErrorCode, ApiErrorCode>> = {
  not_found: "not_found",
  conflict: "conflict",
  validation_failed: "validation_failed",
  import_invalid: "captable_import_invalid",
};

function rethrow(error: unknown): never {
  if (error instanceof CaptableError)
    throw new ApiError(API_CODE[error.code], error.message, error.details);
  throw error;
}

async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    rethrow(error);
  }
}

export function registerCaptableRoutes(api: ModuleRouter, services: ModuleServices): void {
  let service: CaptableService | undefined;
  const svc = () => (service ??= createCaptableService(services));
  const perm = (p: string, fresh = false) => services.guards.requirePermission(p, { fresh });
  const member = () => services.guards.requireMember();

  api.openapi(
    createRoute({
      method: "get",
      path: "/snapshots",
      tags: TAGS,
      summary: "Cap-table snapshots, newest first (drafts, published, superseded)",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      responses: { 200: jsonResponse(s.CaptableSnapshotListSchema, "Snapshots"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      return c.json({ snapshots: await svc().list(sg.tenant) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/snapshots/{id}",
      tags: TAGS,
      summary: "One snapshot: its summary, holders (aggregated) and every ledger line",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.CaptableIdParams },
      responses: { 200: jsonResponse(s.CaptableSnapshotDetailSchema, "Snapshot"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { id } = c.req.valid("param");
      return c.json(await guarded(() => svc().detail(sg.tenant, id)), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/import/dry-run",
      tags: TAGS,
      summary: "Preview a CSV import without writing anything",
      description:
        "Parses the CSV (our template, a Carta export or a Pulley export; at most 2 MiB and 5000 rows), matches holders to live members by email (case-insensitive) and returns the classes, the fully diluted summary, matched/unmatched counts, per-row warnings and every line — exactly what `POST /captable/import` would write for the same file. A file that cannot be imported is refused with 422 `captable_import_invalid` (`reason`, `problems`).",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { body: jsonBody(s.CaptableImportBodySchema) },
      responses: { 200: jsonResponse(s.CaptableImportPreviewSchema, "Preview"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      return c.json(await guarded(() => svc().dryRun(sg.tenant, body)), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/import",
      tags: TAGS,
      summary: "Import a CSV as a draft snapshot",
      description:
        "Same parsing and matching as the dry-run; writes an immutable draft snapshot (classes, lines and the computed summary). Nothing is visible to investors until the draft is published.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { body: jsonBody(s.CaptableImportBodySchema) },
      responses: { 201: jsonResponse(s.CaptableImportResultSchema, "Draft created"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      return c.json(await guarded(() => svc().import(sg.tenant, body, actorOf(c, sg))), 201);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/snapshots/{id}/publish",
      tags: TAGS,
      summary: "Publish a draft (the previously published snapshot becomes superseded)",
      description:
        "Needs a fresh step-up. At most one snapshot is published per workspace; publishing is serialised per workspace, so two concurrent publishes leave exactly one published. 409 `conflict` (`reason: not_draft`) for a snapshot that is not a draft.",
      security: sessionSecurity,
      "x-requires": `${PERM_MANAGE}+fresh`,
      middleware: [perm(PERM_MANAGE, true)] as const,
      request: { params: s.CaptableIdParams },
      responses: { 200: jsonResponse(s.CaptableSnapshotSchema, "Published"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { id } = c.req.valid("param");
      return c.json(await guarded(() => svc().publish(sg.tenant, id, actorOf(c, sg))), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/snapshots/{id}",
      tags: TAGS,
      summary: "Delete a draft snapshot",
      description:
        "Only a draft may be deleted: a published or superseded snapshot is a record (409 `conflict`, `reason: not_draft`).",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.CaptableIdParams },
      responses: { 200: jsonResponse(OkSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const { id } = c.req.valid("param");
      await guarded(() => svc().remove(sg.tenant, id, actorOf(c, sg)));
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/settings",
      tags: TAGS,
      summary: "What investors see, and the disclaimer shown with it",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      responses: { 200: jsonResponse(s.CaptableSettingsSchema, "Settings"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      return c.json(await guarded(() => svc().settings(sg.tenant)), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/settings",
      tags: TAGS,
      summary: "Replace the module settings",
      description:
        "`investorView`: `own_line` (default) shows a member their own lines; `summary` adds class-level totals without holder names; `none` hides the card. `disclaimer` overrides the default text (Markdown, ≤2000); `null` restores the default. Needs a fresh step-up: it can widen what every investor sees.",
      security: sessionSecurity,
      "x-requires": `${PERM_MANAGE}+fresh`,
      middleware: [perm(PERM_MANAGE, true)] as const,
      request: { body: jsonBody(s.CaptableSettingsBodySchema) },
      responses: { 200: jsonResponse(s.CaptableSettingsSchema, "Settings"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      return c.json(await guarded(() => svc().putSettings(sg.tenant, body, actorOf(c, sg))), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/me",
      tags: TAGS,
      summary: "The caller's own holdings in the published snapshot",
      description:
        "404 when the module is off, nothing is published, the workspace shows investors nothing (`investorView: none`) or the caller is a delegate whose scope does not admit the cap table. An `all`-scope delegate sees its principal's lines. Always carries the disclaimer: this is a mirror of the company's records, never the system of record.",
      security: sessionSecurity,
      "x-requires": "member",
      middleware: [member()] as const,
      responses: { 200: jsonResponse(s.CaptableMeSchema, "Holdings"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      return c.json(await guarded(() => svc().me(sg.tenant, sg.membership)), 200);
    },
  );
}
