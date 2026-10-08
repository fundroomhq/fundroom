import {
  ApiError,
  type ApiErrorCode,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  requestIdOf,
  sessionOrApiKeySecurity,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Membership, TenantContext } from "@fundroom/db";
import type { ModuleEnv, ModuleRouter, ModuleServices } from "@fundroom/module-kit";
import type { Context } from "hono";
import * as s from "./contracts.js";
import { type Actor, CrmError, type CrmErrorCode } from "./errors.js";
import type {
  ActivityRow,
  ContactRow,
  NoteRow,
  OrganizationRow,
  PipelineItemRow,
  StageRow,
  TaskRow,
} from "./repos/crm-repo.js";
import { type ActivityService, createActivityService } from "./service/activity.js";
import {
  type ContactDetail,
  type ContactService,
  createContactService,
} from "./service/contacts.js";
import { createNoteService, type NoteService } from "./service/notes.js";
import { createOrganizationService, type OrganizationService } from "./service/organizations.js";
import { type BoardItem, createPipelineService, type PipelineService } from "./service/pipeline.js";
import { createStageService, type StageService } from "./service/stages.js";
import { createTaskService, type TaskService } from "./service/tasks.js";

/*
 * `/api/v1/crm/*` (E2.5 §P). Every route is staff-only, behind `crm.read` or `crm.manage`, and
 * that is the whole access model: `requirePermission` answers **404** rather than 403 for a
 * non-staff caller, so an investor probing these paths learns nothing — and the RLS policies
 * underneath admit no external actor at all, so even a bug in this file cannot show them a row.
 *
 * Handlers hold no logic beyond shaping the response: the services decide, the repos touch SQL.
 * Services are built on **first use** — `moduleServicesOf` is a Proxy of thunks and touching one
 * at registration time throws against the OpenAPI generation stub.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const TAGS = ["crm"];

export const PERM_READ = "crm.read";
export const PERM_MANAGE = "crm.manage";

type Vars = ModuleEnv["Variables"];
interface Signed {
  /** Absent when an API key made the request (E3.4): the key acts as its creator. */
  readonly session?: NonNullable<Vars["session"]> | undefined;
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

function signed(c: Context<ModuleEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if ((!session && !c.get("apiKey")) || !membership || !tenant || !workspace)
    throw new ApiError("unauthenticated");
  return { session, membership, tenant, workspace };
}

const actorOf = (c: Context<ModuleEnv>, sg: Signed): Actor => ({
  membershipId: sg.membership.id,
  requestId: requestIdOf(c),
  sessionId: sg.session?.sessionId,
  apiKeyId: c.get("apiKey")?.id,
});

/**
 * `CrmErrorCode` is a strict subset of the API vocabulary: everything this module refuses is a
 * row that is not there, a rule about the caller's input, or a conflict with a row that is. The
 * *reason* for a conflict — `stage_in_use`, `stage_protected`, `duplicate_name` — travels in
 * `details`, because `ApiErrorCode` is a closed kernel vocabulary and a module must not widen it.
 */
const API_CODE: Readonly<Record<CrmErrorCode, ApiErrorCode>> = {
  not_found: "not_found",
  conflict: "conflict",
  validation_failed: "validation_failed",
  forbidden: "forbidden",
};

function rethrow(error: unknown): never {
  if (error instanceof CrmError)
    throw new ApiError(API_CODE[error.code], error.message, error.details);
  throw error;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const stageBody = (row: StageRow) => ({
  id: row.id,
  key: row.key,
  name: row.name,
  position: row.position,
  isTerminal: row.isTerminal,
});

const organizationBody = (row: OrganizationRow) => ({
  id: row.id,
  name: row.name,
  domain: row.domain,
  website: row.website,
  kind: row.kind,
  notes: row.notes,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const organizationSummary = (row: OrganizationRow) => ({ id: row.id, name: row.name });

const contactBody = (row: ContactRow) => ({
  id: row.id,
  organizationId: row.organizationId,
  membershipId: row.membershipId,
  displayName: row.displayName,
  email: row.email,
  title: row.title,
  tags: row.tags,
  notes: row.notes,
  ownerMembershipId: row.ownerMembershipId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const contactSummary = (row: ContactRow) => ({
  id: row.id,
  displayName: row.displayName,
  email: row.email,
});

const noteBody = (row: NoteRow) => ({
  id: row.id,
  subjectKind: row.subjectKind,
  subjectId: row.subjectId,
  body: row.body,
  authorMembershipId: row.authorMembershipId,
  createdAt: row.createdAt.toISOString(),
});

const taskBody = (row: TaskRow) => ({
  id: row.id,
  subjectKind: row.subjectKind,
  subjectId: row.subjectId,
  title: row.title,
  dueAt: iso(row.dueAt),
  assigneeMembershipId: row.assigneeMembershipId,
  doneAt: iso(row.doneAt),
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const boardItemBody = (entry: BoardItem) => ({
  id: entry.item.id,
  roundId: entry.item.roundId,
  stageId: entry.item.stageId,
  stageKey: entry.stage?.key ?? null,
  amount: entry.item.amount,
  currency: entry.item.currency,
  commitmentId: entry.item.commitmentId,
  ownerMembershipId: entry.item.ownerMembershipId,
  position: entry.item.position,
  contact: entry.contact === null ? null : contactSummary(entry.contact),
  organization: entry.organization === null ? null : organizationSummary(entry.organization),
});

const contactItemBody = (entry: { item: PipelineItemRow; stage: StageRow | null }) => ({
  id: entry.item.id,
  roundId: entry.item.roundId,
  stageId: entry.item.stageId,
  stageKey: entry.stage?.key ?? null,
  stageName: entry.stage?.name ?? null,
  amount: entry.item.amount,
  currency: entry.item.currency,
  commitmentId: entry.item.commitmentId,
  ownerMembershipId: entry.item.ownerMembershipId,
  position: entry.item.position,
});

const contactDetailBody = (detail: ContactDetail) => ({
  contact: contactBody(detail.contact),
  organization: detail.organization === null ? null : organizationSummary(detail.organization),
  notes: detail.notes.map(noteBody),
  tasks: detail.tasks.map(taskBody),
  items: detail.items.map(contactItemBody),
});

const activityBody = (row: ActivityRow) => ({
  id: row.id,
  contactId: row.contactId,
  kind: row.kind,
  occurredAt: row.occurredAt.toISOString(),
  startsAt: row.startsAt.toISOString(),
  endsAt: iso(row.endsAt),
  title: row.title,
  provider: row.provider,
  bookingId: row.bookingId,
});

/** `undefined` stays absent (patch semantics), `null` clears, a string becomes a `Date`. */
const dateField = (v: string | null | undefined): Date | null | undefined =>
  v === undefined ? undefined : v === null ? null : new Date(v);

export function registerCrmRoutes(api: ModuleRouter, services: ModuleServices): void {
  // Built on first use: nothing may be constructed at registration time.
  let stages: StageService | undefined;
  let organizations: OrganizationService | undefined;
  let contacts: ContactService | undefined;
  let pipeline: PipelineService | undefined;
  let notes: NoteService | undefined;
  let tasks: TaskService | undefined;
  let activities: ActivityService | undefined;
  const stageSvc = () => (stages ??= createStageService(services));
  const organizationSvc = () => (organizations ??= createOrganizationService(services));
  const contactSvc = () => (contacts ??= createContactService(services));
  const pipelineSvc = () => (pipeline ??= createPipelineService(services));
  const noteSvc = () => (notes ??= createNoteService(services));
  const taskSvc = () => (tasks ??= createTaskService(services));
  const activitySvc = () => (activities ??= createActivityService(services));
  const perm = (p: string, fresh = false) => services.guards.requirePermission(p, { fresh });
  /** An `apiKey: true` matrix row (E3.4): a workspace API key holding `p` may call it too. */
  const keyPerm = (p: string) => services.guards.requirePermission(p, { apiKey: true });

  // --- stages -----------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/stages",
      tags: TAGS,
      summary: "The workspace's pipeline stages, in ladder order",
      description:
        "Seeds the ten defaults — Prospect through Passed — the first time anybody looks. Stages are tenant data, so the migration writes none: a workspace that never switches the CRM on never acquires them.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      responses: { 200: jsonResponse(s.CrmStageListSchema, "Stages"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const rows = await stageSvc().list(sg.tenant);
      return c.json({ stages: rows.map(stageBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/stages",
      tags: TAGS,
      summary: "Replace the ladder: rename, reorder, add and remove stages",
      description:
        "A whole-list write, because position is a property of the list: two admins each moving one stage through a per-stage API would produce an order neither asked for. An entry with an `id` keeps that stage (and its key, which the event handlers address); an entry without one is new, taking `key` if given and `custom_<slug>` otherwise. Positions become 1..n in array order. A stage still holding live cards is refused with `stage_in_use`, and the two seeded terminal stages — Wired and Passed — cannot be removed at all, because the commitment-status mapping lands on them.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { body: jsonBody(s.PutStagesBody) },
      responses: { 200: jsonResponse(s.CrmStageListSchema, "Stages"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const rows = await stageSvc().replace(sg.tenant, body.stages, actorOf(c, sg));
        return c.json({ stages: rows.map(stageBody) }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- organisations ----------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/organizations",
      tags: TAGS,
      summary: "Organisations: funds, angel groups, corporates, family offices",
      description:
        "Keyset pagination on `id` (uuidv7, so creation order). `q` matches the name or the domain, case-insensitively.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { query: s.OrganizationsQuery },
      responses: { 200: jsonResponse(s.CrmOrganizationPageSchema, "Page"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const q = c.req.valid("query");
      const result = await organizationSvc().list(sg.tenant, {
        ...(q.q === undefined ? {} : { q: q.q }),
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        limit: q.limit,
      });
      return c.json(
        { items: result.items.map(organizationBody), nextCursor: result.nextCursor },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/organizations",
      tags: TAGS,
      summary: "Add an organisation",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { body: jsonBody(s.CreateOrganizationBody) },
      responses: { 201: jsonResponse(s.CrmOrganizationSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const row = await organizationSvc().create(sg.tenant, body, actorOf(c, sg));
        return c.json(organizationBody(row), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/organizations/{id}",
      tags: TAGS,
      summary: "One organisation",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.CrmIdParams },
      responses: { 200: jsonResponse(s.CrmOrganizationSchema, "Organisation"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const row = await organizationSvc().get(sg.tenant, c.req.valid("param").id);
        return c.json(organizationBody(row), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/organizations/{id}",
      tags: TAGS,
      summary: "Edit an organisation",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.CrmIdParams, body: jsonBody(s.PatchOrganizationBody) },
      responses: { 200: jsonResponse(s.CrmOrganizationSchema, "Organisation"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const row = await organizationSvc().patch(
          sg.tenant,
          c.req.valid("param").id,
          c.req.valid("json"),
          actorOf(c, sg),
        );
        return c.json(organizationBody(row), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/organizations/{id}",
      tags: TAGS,
      summary: "Remove an organisation (soft; its cards keep their subject)",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.CrmIdParams },
      responses: { 200: jsonResponse(OkSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await organizationSvc().remove(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- contacts ---------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/contacts",
      tags: TAGS,
      summary: "Contacts, with search, an organisation filter and a tag filter",
      description:
        "`q` is answered two ways at once: the generated `search_tsv` for whole words, and an ILIKE prefix on the name and the email for the half-typed case — a search box that went blank while somebody was still typing would read as 'no such person'.",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_READ}+apikey`,
      middleware: [keyPerm(PERM_READ)] as const,
      request: { query: s.ContactsQuery },
      responses: { 200: jsonResponse(s.CrmContactPageSchema, "Page"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const q = c.req.valid("query");
      const result = await contactSvc().list(sg.tenant, {
        ...(q.q === undefined ? {} : { q: q.q }),
        ...(q.organizationId === undefined ? {} : { organizationId: q.organizationId }),
        ...(q.tag === undefined ? {} : { tag: q.tag }),
        ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
        limit: q.limit,
      });
      return c.json({ items: result.items.map(contactBody), nextCursor: result.nextCursor }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/contacts",
      tags: TAGS,
      summary: "Add a contact, optionally linked to a member",
      description:
        "A contact is not a login: `membershipId` is an optional link to `core.membership`, and at most one live contact may hold each. When it is given, an empty `displayName` and an absent `email` default from the member — a staff member who picked somebody out of the people list should not have to retype their name. What they do type is theirs from then on; no later event overwrites it.",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_MANAGE}+apikey`,
      middleware: [keyPerm(PERM_MANAGE)] as const,
      request: { body: jsonBody(s.CreateContactBody) },
      responses: { 201: jsonResponse(s.CrmContactSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const row = await contactSvc().create(sg.tenant, body, actorOf(c, sg));
        return c.json(contactBody(row), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/contacts/{id}",
      tags: TAGS,
      summary: "One contact with its organisation, notes, tasks and pipeline cards",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_READ}+apikey`,
      middleware: [keyPerm(PERM_READ)] as const,
      request: { params: s.CrmIdParams },
      responses: { 200: jsonResponse(s.CrmContactDetailSchema, "Contact"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const detail = await contactSvc().detail(sg.tenant, c.req.valid("param").id);
        return c.json(contactDetailBody(detail), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/contacts/{id}/activity",
      tags: TAGS,
      summary: "A contact's activity: meetings booked, rescheduled or cancelled (newest first)",
      description:
        "Recorded from verified Calendly / Cal.com booking webhooks: one entry per booking and kind, at most 100, newest first. A booking by somebody with no contact is never turned into one.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { params: s.CrmIdParams },
      responses: { 200: jsonResponse(s.CrmActivityListSchema, "Activity"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const rows = await activitySvc().forContact(sg.tenant, c.req.valid("param").id);
        return c.json({ activities: rows.map(activityBody) }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/contacts/{id}",
      tags: TAGS,
      summary: "Edit a contact, or link it to a member",
      security: sessionOrApiKeySecurity,
      "x-requires": `${PERM_MANAGE}+apikey`,
      middleware: [keyPerm(PERM_MANAGE)] as const,
      request: { params: s.CrmIdParams, body: jsonBody(s.PatchContactBody) },
      responses: { 200: jsonResponse(s.CrmContactSchema, "Contact"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const row = await contactSvc().patch(
          sg.tenant,
          c.req.valid("param").id,
          c.req.valid("json"),
          actorOf(c, sg),
        );
        return c.json(contactBody(row), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/contacts/{id}",
      tags: TAGS,
      summary: "Remove a contact (soft; its notes and cards stay for the record)",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.CrmIdParams },
      responses: { 200: jsonResponse(OkSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await contactSvc().remove(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- pipeline ---------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/pipeline",
      tags: TAGS,
      summary: "The board: stages and the cards in them",
      description:
        "`roundId` absent is every card; `roundId=none` is the cards attached to no round; a uuid is that round's. `amount` on a card is a **forecast** — what staff expect — never the committed figure: that lives on `round.commitment` and is reached through `commitmentId`, which is what the reconciliation panel joins on.",
      security: sessionSecurity,
      "x-requires": PERM_READ,
      middleware: [perm(PERM_READ)] as const,
      request: { query: s.PipelineQuery },
      responses: { 200: jsonResponse(s.CrmPipelineBoardSchema, "Board"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const q = c.req.valid("query");
      const board = await pipelineSvc().board(sg.tenant, q.roundId);
      return c.json(
        { stages: board.stages.map(stageBody), items: board.items.map(boardItemBody) },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/pipeline",
      tags: TAGS,
      summary: "Put a card on the board",
      description:
        "A card needs a contact or an organisation. Without a stage it lands in the first one; `stageKey` and `stageId` both work, and `stageKey` is what survives a rename. One card per (round, contact).",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { body: jsonBody(s.CreatePipelineItemBody) },
      responses: { 201: jsonResponse(s.CrmContactPipelineItemSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const placed = await pipelineSvc().create(sg.tenant, body, actorOf(c, sg));
        return c.json(contactItemBody(placed), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/pipeline/{id}",
      tags: TAGS,
      summary: "Move a card, or change its forecast, owner or linked commitment",
      description:
        "A stage change writes a `crm.stage_transition` row and an audit event carrying the two stage **keys** — that history is what 'stage transitions are audited' means, and it survives the stage being renamed or removed. Moving a card to the stage it is already in writes nothing at all.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.CrmIdParams, body: jsonBody(s.PatchPipelineItemBody) },
      responses: { 200: jsonResponse(s.CrmContactPipelineItemSchema, "Card"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const placed = await pipelineSvc().patch(
          sg.tenant,
          c.req.valid("param").id,
          c.req.valid("json"),
          actorOf(c, sg),
        );
        return c.json(contactItemBody(placed), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/pipeline/{id}",
      tags: TAGS,
      summary: "Take a card off the board (soft; its history stays)",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.CrmIdParams },
      responses: { 200: jsonResponse(OkSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await pipelineSvc().remove(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- notes ------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "post",
      path: "/notes",
      tags: TAGS,
      summary: "Write a note against a contact, an organisation or a card",
      description:
        "The audit row records the subject and the length, never the text. A CRM note is the most candid prose in the product, and the audit log is the one table exported wholesale to counsel.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { body: jsonBody(s.CreateNoteBody) },
      responses: { 201: jsonResponse(s.CrmNoteSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        const row = await noteSvc().create(sg.tenant, c.req.valid("json"), actorOf(c, sg));
        return c.json(noteBody(row), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/notes/{id}",
      tags: TAGS,
      summary: "Remove a note (soft)",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.CrmIdParams },
      responses: { 200: jsonResponse(OkSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await noteSvc().remove(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  // --- tasks ------------------------------------------------------------------------------
  api.openapi(
    createRoute({
      method: "post",
      path: "/tasks",
      tags: TAGS,
      summary: "Set a follow-up against a contact, an organisation or a card",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { body: jsonBody(s.CreateTaskBody) },
      responses: { 201: jsonResponse(s.CrmTaskSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      try {
        const row = await taskSvc().create(
          sg.tenant,
          {
            subjectKind: body.subjectKind,
            subjectId: body.subjectId,
            title: body.title,
            ...(body.dueAt === undefined ? {} : { dueAt: new Date(body.dueAt) }),
            ...(body.assigneeMembershipId === undefined
              ? {}
              : { assigneeMembershipId: body.assigneeMembershipId }),
          },
          actorOf(c, sg),
        );
        return c.json(taskBody(row), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "patch",
      path: "/tasks/{id}",
      tags: TAGS,
      summary: "Rename, reschedule, reassign or tick off a task",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.CrmIdParams, body: jsonBody(s.PatchTaskBody) },
      responses: { 200: jsonResponse(s.CrmTaskSchema, "Task"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      const body = c.req.valid("json");
      const dueAt = dateField(body.dueAt);
      try {
        const row = await taskSvc().patch(
          sg.tenant,
          c.req.valid("param").id,
          {
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(dueAt === undefined ? {} : { dueAt }),
            ...(body.assigneeMembershipId === undefined
              ? {}
              : { assigneeMembershipId: body.assigneeMembershipId }),
            ...(body.done === undefined ? {} : { done: body.done }),
          },
          actorOf(c, sg),
        );
        return c.json(taskBody(row), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/tasks/{id}",
      tags: TAGS,
      summary: "Drop a task",
      description:
        "A real delete, not a tombstone: `crm.task` carries no `deleted_at`, because a task is a reminder somebody set for themselves and a tombstoned reminder still shows up in the count.",
      security: sessionSecurity,
      "x-requires": PERM_MANAGE,
      middleware: [perm(PERM_MANAGE)] as const,
      request: { params: s.CrmIdParams },
      responses: { 200: jsonResponse(OkSchema, "Deleted"), ...ERRORS },
    }),
    async (c) => {
      const sg = signed(c);
      try {
        await taskSvc().remove(sg.tenant, c.req.valid("param").id, actorOf(c, sg));
        return c.json({ ok: true as const }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );
}
