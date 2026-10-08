import { randomUUID } from "node:crypto";
import { OfferingPeriodRepo, seedDefaults } from "@fundroom/compliance";
import {
  ApiError,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  kernel as k,
  OkSchema,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import {
  isOwnCellUnavailableError,
  isPlacementError,
  localPlacementCell,
  releaseQuietly,
  withSlugClaim,
} from "@fundroom/control-plane";
import {
  createWorkspace,
  deleteWorkspace,
  lockWorkspaceFacts,
  pgErrorCode,
  systemContext,
  updateWorkspaceSettingsBlock,
} from "@fundroom/db";
import { parseWorkspaceSettings, WorkspaceSettingsSchema } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import { t } from "@fundroom/i18n";
import { sha256 } from "@fundroom/identity";
import { issueSessionCookies } from "@fundroom/identity/http";
import type { RateLimitRule } from "@fundroom/ports";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { cookieModeOf, requireSession } from "../middleware/auth.js";
import { cookieBasePathOf } from "../path-mount.js";
import { residencyTemplateFields } from "../residency/kernel.js";
import { hasBrand } from "./branding.js";
import { type ApiDeps, clientIp } from "./deps.js";
import { loginBody } from "./serialize.js";

/*
 * First-run setup (EXECUTION_PLAN §9.4, ADR-0018). Host-level routes: they never need a
 * workspace, because their job is to create the first one. The privileged step
 * (`POST /setup/owner`) is gated by the setup token; the probes run on the owner's fresh
 * session and are re-runnable from admin later. Every step is idempotent from the client's
 * point of view: once setup is complete the token routes answer `conflict`.
 *
 * Under the control plane (E-UP-11) there is no first run: the gate never reports "required",
 * no token exists, and the token routes always answer `conflict`. The status endpoint and the
 * probes stay, for the per-workspace wizard a hosted owner walks after signup (A-5).
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const TAGS = ["setup"];

/** Token guesses per client address: generous for typos, hopeless for brute force. */
export const SETUP_TOKEN_RATE: RateLimitRule = { max: 10, windowMs: 15 * 60_000 };
/** Test emails per signed-in user (F-28): enough to debug a relay, useless for sending spam. */
export const SETUP_MAIL_PROBE_RATE: RateLimitRule = { max: 5, windowMs: 60 * 60_000 };

export function slugFromName(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63)
    .replace(/-+$/u, "");
  return slug.length > 0 ? slug : "workspace";
}

async function checkToken(c: Context<AppEnv>, deps: ApiDeps, token: string): Promise<void> {
  const { setup } = deps;
  // E-UP-11: no first-run wizard under the control plane, so no token can be right.
  if (deps.controlPlane.enabled) {
    throw new ApiError(
      "conflict",
      "first-run setup is off on this host: workspaces are created by signup or by an operator",
    );
  }
  if (!(await setup.gate.required())) {
    throw new ApiError("conflict", "setup is already complete; sign in instead");
  }
  const ip = clientIp(c, deps.trustProxy) ?? "unknown";
  const decision = await deps.rateLimiter.hit(`setup:token:${sha256(ip)}`, SETUP_TOKEN_RATE);
  if (!decision.allowed) {
    throw new ApiError(
      "rate_limited",
      "too many setup attempts; try again later",
      { retryAfterMs: decision.retryAfterMs },
      { headers: { "Retry-After": String(Math.ceil(decision.retryAfterMs / 1000)) } },
    );
  }
  if (!setup.token.verify(token)) {
    deps.log("setup.token_rejected", { level: "warn" });
    throw new ApiError(
      "invalid_credential",
      "the setup token does not match; check the server logs",
    );
  }
  await deps.rateLimiter.reset(`setup:token:${sha256(ip)}`);
}

/**
 * The offering step is done once a period row exists — `GET /compliance/offering` opens one
 * lazily on the first read, so this is true as soon as the founder has actually looked at the
 * offering screen, which is the decision the wizard is asking them to make. It reads
 * `core.offering_period`, a kernel table, not a module's.
 */
async function hasOfferingPeriod(deps: ApiDeps, workspaceId: string): Promise<boolean> {
  const ctx = systemContext(workspaceId);
  return deps.db.withTenant(ctx, async (tx) => {
    const rows = await new OfferingPeriodRepo(ctx, tx).history();
    return rows.length > 0;
  });
}

/*
 * The documents a brand-new workspace starts with (ADR-0037 deferred the call site to E1.7).
 * `seedDefaults` writes a privacy notice and the default disclaimer, and hands back the slug
 * that `legal.defaultDisclaimerSlug` has to point at; both happen here, in ONE transaction,
 * because a settings key naming a document that was never created is precisely the "acceptance
 * gate pointing at nothing" this exists to prevent.
 *
 * That transaction is deliberately its OWN, opened after the workspace, the owner, the
 * `workspace.created` event and the audit row have committed — i.e. **outside** the rollback
 * path above. The rollback exists to stop a workspace with no owner from telling the setup gate
 * that setup is complete; a workspace that is missing two seeded documents has no such problem.
 * It is simply un-seeded, which is the state every workspace created before this epic is in,
 * which every screen already copes with, and which `seedDefaults` — idempotent by construction —
 * can repair on a later run. Putting it inside the rollback would trade that harmless gap for a
 * far worse failure: a template bug would delete a perfectly good workspace and its owner, and
 * the delete is itself best-effort (`.catch(() => undefined)`), so a delete that failed after a
 * seed that failed is exactly the half-built tenant nobody wants. Seeding is therefore allowed
 * to fail, loudly in the log and nowhere else.
 */
async function seedLegalDefaults(
  deps: ApiDeps,
  c: Context<AppEnv>,
  workspace: Awaited<ReturnType<typeof createWorkspace>>,
  actor: { membershipId: string; userId: string },
): Promise<void> {
  const ctx = systemContext(workspace.id);
  const residency = residencyTemplateFields(deps);
  try {
    await deps.db.withTenant(ctx, async (tx) => {
      const { defaultDisclaimerSlug } = await seedDefaults(
        { db: deps.db, audit: deps.audit, log: deps.log },
        ctx,
        tx,
        {
          // The workspace name is the only merge field the wizard knows at this point; every
          // other field renders empty by contract, and admin can republish from the library.
          context: {
            company: { name: workspace.name },
            portal: { url: deps.baseUrl.href },
            // E3.11: the deployment's declared region and sub-processors (operator facts).
            workspace: {
              ...(residency.dataRegion === undefined ? {} : { dataRegion: residency.dataRegion }),
            },
            subProcessors: residency.subProcessors,
            dataLocation: residency.dataLocation,
          },
          actor: {
            membershipId: actor.membershipId,
            userId: actor.userId,
            requestId: requestIdOf(c),
          },
        },
      );
      // The `legal` block alone, merged on the row-locked copy (A-3 R2 M1): never the request's
      // cached settings, never the whole document. Lock order (E3.5 LX): when the seed above
      // audited or indexed, this transaction already holds the workspace row (both take it
      // first), so the lock is a no-op; otherwise nothing after it is taken before it.
      const current = parseWorkspaceSettings(
        (await lockWorkspaceFacts(tx, workspace.id))?.settings,
      );
      const next = WorkspaceSettingsSchema.parse({
        ...current,
        legal: { ...current.legal, defaultDisclaimerSlug },
      });
      await updateWorkspaceSettingsBlock(tx, workspace.id, "legal", next.legal);
    });
    deps.resolver.invalidate();
  } catch (error) {
    deps.log("setup.seed_failed", {
      level: "error",
      workspaceId: workspace.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** An active staff owner or admin somewhere on this instance: the founder, now or later. */
async function isStaffOwner(c: Context<AppEnv>, deps: ApiDeps): Promise<boolean> {
  const s = c.get("session");
  if (s === undefined) return false;
  const memberships = await deps.auth.listMemberships(s.userId);
  return memberships.some(
    (m) =>
      m.kind === "staff" && (m.role === "owner" || m.role === "admin") && m.status === "active",
  );
}

/** Probes are for whoever just became owner (or any staff owner/admin later, from admin). */
async function requireStaffOwner(c: Context<AppEnv>, deps: ApiDeps): Promise<string> {
  const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
  if (!(await isStaffOwner(c, deps)))
    throw new ApiError("forbidden", "only a workspace owner or admin can run setup probes");
  return s.userId;
}

/*
 * The mail probe sends from the instance's own address, so on a multi-tenant host it must not
 * be a relay for whoever administers *some* workspace (E2.10 F-28):
 *
 *  - **Who it goes to.** The caller's own address, or a verified address of an active staff
 *    member of a workspace the caller owns or administers. Anything else is 400, with the same
 *    words whether the address is unknown, unverified or somebody else's colleague.
 *  - **How strong the session is.** Owners and admins need level 2 everywhere else (§6.2); the
 *    probes are host-level, so `requirePermission` never ran for them. Level 2 is required here
 *    too — except for a founder who has not set up a second factor yet (the wizard lets them
 *    skip that step, and the mail step comes next): they may send to their own address only.
 *  - **How often.** `SETUP_MAIL_PROBE_RATE` per user, whatever the address.
 */
async function guardMailProbe(
  deps: ApiDeps,
  caller: { userId: string; sessionId: string; authLevel: number },
  to: string,
  own: string | undefined,
): Promise<void> {
  const toSelf = own !== undefined && to.toLowerCase() === own.toLowerCase();
  if (caller.authLevel < 2 && (!toSelf || (await deps.auth.hasSecondFactor(caller.userId)))) {
    throw new ApiError(
      "step_up_required",
      "confirm it's you with your authenticator app or a passkey",
      {
        reason: "level",
        requiredLevel: 2,
        currentLevel: caller.authLevel,
      },
    );
  }
  if (!toSelf && !(await deps.auth.isVerifiedStaffColleague(caller.userId, to))) {
    throw new ApiError(
      "invalid_request",
      "the test email can go to your own address or a verified address of your workspace's staff",
      { field: "to" },
    );
  }
  const decision = await deps.rateLimiter.hit(
    `setup:mail-probe:user:${caller.userId}`,
    SETUP_MAIL_PROBE_RATE,
  );
  if (!decision.allowed) {
    throw new ApiError(
      "rate_limited",
      "too many test emails; try again later",
      { retryAfterMs: decision.retryAfterMs },
      { headers: { "Retry-After": String(Math.ceil(decision.retryAfterMs / 1000)) } },
    );
  }
}

export function registerSetupRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  api.openapi(
    createRoute({
      method: "get",
      path: "/setup/status",
      "x-requires": "public",
      tags: TAGS,
      summary: "Whether first-run setup is still required, and what the wizard can offer",
      description:
        "Public, but the body depends on the caller. A signed-in active staff owner or admin gets everything, `progress`, `drivers` and `probes` included. While setup is still required, anyone gets what the token and owner steps need (`tenancy`, `instanceName`, `baseUrl`, `passwordEnabled`, `tokenSource`). Once setup is complete, everyone else gets `{ required: false }` only.",
      responses: { 200: jsonResponse(k.SetupStatusSchema, "Status"), ...ERRORS },
    }),
    async (c) => {
      const { setup } = deps;
      const required = await setup.gate.required();
      /*
       * Drivers, probe results, progress and the base URL fingerprint the deployment and are of
       * no use to a stranger once the instance is set up. Before that, the token and owner steps
       * run anonymously and need the instance facts, but still not the drivers or probes (the
       * mail and storage steps come after the owner exists, on the owner's session).
       */
      if (!(await isStaffOwner(c, deps))) {
        if (!required) return c.json({ required: false }, 200);
        return c.json(
          {
            required: true,
            tenancy: deps.tenancy,
            instanceName: setup.instanceName,
            baseUrl: deps.baseUrl.href,
            passwordEnabled: deps.passwordEnabled,
            tokenSource: setup.token.source,
          },
          200,
        );
      }
      const workspace = c.get("workspace");
      const progress = {
        owner: !required,
        mail: deps.readiness.passed("mail"),
        storage: deps.readiness.passed("storage"),
        branding: workspace === undefined ? false : hasBrand(workspace),
        offering: workspace === undefined ? false : await hasOfferingPeriod(deps, workspace.id),
      };
      return c.json(
        {
          required,
          progress,
          tenancy: deps.tenancy,
          instanceName: setup.instanceName,
          baseUrl: deps.baseUrl.href,
          passwordEnabled: deps.passwordEnabled,
          drivers: { storage: deps.storage.driver, mail: deps.mailer.driver },
          ...(required ? { tokenSource: setup.token.source } : {}),
          probes: {
            mail: deps.readiness.passed("mail") ? ("passed" as const) : ("pending" as const),
            storage: deps.readiness.passed("storage") ? ("passed" as const) : ("pending" as const),
          },
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/setup/token/verify",
      "x-requires": "public",
      tags: TAGS,
      summary: "Check the setup token before showing the owner form",
      description: "Rate-limited per client address. `conflict` once setup is complete.",
      request: { body: jsonBody(k.SetupTokenBody) },
      responses: { 200: jsonResponse(OkSchema, "Token accepted"), ...ERRORS },
    }),
    async (c) => {
      await checkToken(c, deps, c.req.valid("json").token);
      return c.json({ ok: true as const }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/setup/owner",
      "x-requires": "public",
      tags: TAGS,
      summary: "Create the first workspace and its owner; signs the owner in",
      description:
        "The one privileged step. Creates the workspace and an active `staff/owner` membership for the email, starts a level-1 session (cookie set) and retires the setup token. Add a passkey or a password + TOTP on that session next.",
      request: { body: jsonBody(k.SetupOwnerBody) },
      responses: {
        200: jsonResponse(k.SetupOwnerResponse, "Owner created; session cookie set"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      await checkToken(c, deps, body.token);
      const { setup } = deps;
      const slug = body.workspaceSlug ?? slugFromName(body.workspaceName);

      let workspace: Awaited<ReturnType<typeof createWorkspace>>;
      try {
        // E3.11: placed on this process's cell when this database has it, and the slug claimed
        // in the cell directory first (a workspace of another cell holding it is the same
        // `conflict` as the local unique index).
        const cellId = await localPlacementCell(deps.db, deps.controlPlane.cellId);
        workspace = await withSlugClaim(deps.directory, { slug, cellId, log: deps.log }, (id) =>
          createWorkspace(deps.db, { id, slug, name: body.workspaceName, cellId }),
        );
      } catch (error) {
        if (
          pgErrorCode(error) === "23505" ||
          (isPlacementError(error) && error.reason === "slug_taken")
        )
          throw new ApiError("conflict", `the slug "${slug}" is taken`, { slug });
        if (isPlacementError(error)) throw new ApiError("directory_unavailable", error.message);
        if (isOwnCellUnavailableError(error))
          throw new ApiError("service_unavailable", error.message);
        throw error;
      }

      try {
        const result = await deps.auth.bootstrapOwner({
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          email: body.email,
          displayName: body.displayName,
          ip: clientIp(c, deps.trustProxy),
          userAgent: c.req.header("user-agent")?.slice(0, 512),
        });
        const ctx = systemContext(workspace.id);
        await deps.db.withTenant(ctx, async (tx) => {
          await publish(tx, ctx, "workspace.created", {
            workspaceId: workspace.id,
            slug: workspace.slug,
          });
          await deps.audit.record(tx, ctx, {
            action: "workspace.created",
            resourceKind: "workspace",
            resourceId: workspace.id,
            actorKind: "staff",
            actorMembershipId: result.membership?.id ?? null,
            actorUserId: result.session.userId,
            requestId: requestIdOf(c),
            meta: { slug: workspace.slug, source: "setup", tokenSource: setup.token.source },
          });
        });
        if (result.membership !== undefined && result.membership !== null) {
          await seedLegalDefaults(deps, c, workspace, {
            membershipId: result.membership.id,
            userId: result.session.userId,
          });
        }
        setup.token.consume();
        setup.gate.invalidate();
        deps.resolver.invalidate();
        deps.log("setup.completed", {
          workspaceId: workspace.id,
          slug: workspace.slug,
          userId: result.session.userId,
        });
        issueSessionCookies(c, {
          token: result.token,
          deviceToken: result.deviceToken,
          mode: cookieModeOf(c),
          basePath: cookieBasePathOf(c),
        });
        return c.json(
          {
            ...loginBody(result),
            workspace: { id: workspace.id, slug: workspace.slug, name: workspace.name },
          },
          200,
        );
      } catch (error) {
        // A workspace without an owner would make the gate report "complete"; undo it.
        await deleteWorkspace(deps.db, workspace.id, {
          lookup: deps.domainLookup,
          workspaces: deps.resolver,
        }).catch(() => undefined);
        // Never the owner's: the slug goes back to everybody (E3.11 directory).
        await releaseQuietly(deps.directory, workspace.id, deps.log);
        setup.gate.invalidate();
        throw error;
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/setup/probes/mail",
      "x-requires": "owner-or-admin",
      tags: TAGS,
      summary: "Send a test email through the configured mailer",
      description:
        "To the caller's own address (the default) or a verified address of an active staff member of a workspace the caller owns or administers. Needs a level-2 session, except for a caller with no second factor yet sending to their own address. Rate-limited per user.",
      security: sessionSecurity,
      middleware: [requireSession()] as const,
      request: { body: jsonBody(k.SetupMailProbeBody) },
      responses: {
        200: jsonResponse(k.SetupProbeResultSchema, "Delivered to the provider"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const userId = await requireStaffOwner(c, deps);
      const s = c.get("session") as NonNullable<AppEnv["Variables"]["session"]>;
      const body = c.req.valid("json");
      const own = await deps.auth.primaryEmail(userId);
      const to = body.to ?? own;
      if (to === undefined) throw new ApiError("invalid_request", "no address to send to");
      await guardMailProbe(
        deps,
        { userId, sessionId: s.sessionId, authLevel: s.authLevel },
        to,
        own,
      );
      // The operator's own language (E2.8); the probe goes to them, before any workspace exists.
      const locale = c.get("session")?.user.locale ?? undefined;
      const started = performance.now();
      const sent = await deps.mailer.send({
        to,
        // Deliberately no `workspaceId` (E1.7): the probe answers "does outbound mail work on
        // this instance?", and the wizard runs it before any workspace need exist. Stamping the
        // operator's own workspace would brand an instance-level diagnostic as if a tenant had
        // sent it, so the instance brand is the honest one here.
        subject: t(locale, "setup.mail_probe.subject", { instance: deps.setup.instanceName }),
        text: [t(locale, "setup.mail_probe.body_1"), "", t(locale, "setup.mail_probe.text_2")].join(
          "\n",
        ),
        template: {
          name: "notification",
          props: {
            title: t(locale, "setup.mail_probe.title"),
            paragraphs: [
              t(locale, "setup.mail_probe.body_1"),
              t(locale, "setup.mail_probe.body_2"),
            ],
            ...(locale === undefined ? {} : { locale }),
          },
        },
        tags: ["setup", "probe"],
      });
      const latencyMs = Math.round(performance.now() - started);
      deps.readiness.markPassed("mail", deps.mailer.driver);
      deps.log("setup.probe_passed", { probe: "mail", driver: deps.mailer.driver, latencyMs });
      return c.json(
        { ok: true as const, driver: deps.mailer.driver, latencyMs, detail: sent.messageId },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/setup/probes/storage",
      "x-requires": "owner-or-admin",
      tags: TAGS,
      summary: "Write, read back and delete a probe object in the configured storage",
      security: sessionSecurity,
      middleware: [requireSession()] as const,
      responses: { 200: jsonResponse(k.SetupProbeResultSchema, "Round trip succeeded"), ...ERRORS },
    }),
    async (c) => {
      await requireStaffOwner(c, deps);
      const key = `setup/probe-${randomUUID()}.txt`;
      const payload = new TextEncoder().encode(
        `fundroom storage probe ${new Date().toISOString()}\n`,
      );
      const started = performance.now();
      await deps.storage.healthCheck();
      await deps.storage.put(key, payload, {
        contentType: "text/plain",
        contentLength: payload.byteLength,
      });
      try {
        const read = await deps.storage.get(key);
        if (read === undefined)
          throw new ApiError("service_unavailable", "probe object vanished after write");
        const bytes = new Uint8Array(await new Response(read.body).arrayBuffer());
        if (bytes.byteLength !== payload.byteLength || !bytes.every((b, i) => b === payload[i])) {
          throw new ApiError("service_unavailable", "probe object read back differently");
        }
      } finally {
        await deps.storage.delete(key).catch(() => undefined);
      }
      const latencyMs = Math.round(performance.now() - started);
      deps.readiness.markPassed("storage", deps.storage.driver);
      deps.log("setup.probe_passed", { probe: "storage", driver: deps.storage.driver, latencyMs });
      return c.json(
        { ok: true as const, driver: deps.storage.driver, latencyMs, detail: key },
        200,
      );
    },
  );
}
