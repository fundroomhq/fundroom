import { pgErrorCode, type TenantContext, type Tx } from "@fundroom/db";
import { publish } from "@fundroom/events";
import { GroupRepo } from "@fundroom/identity";
import {
  DOC_SCHEMA_VERSION,
  type PageDoc,
  type RenderedSection,
  renderSections,
} from "@fundroom/module-content";
import type { ModuleServices } from "@fundroom/module-kit";
import type { JsonObject, RequestFacts } from "@fundroom/ports";
import { type Actor, UpdatesError } from "../errors.js";
import {
  AUDIENCE_SCHEMA_VERSION,
  type Audience,
  AudienceSchema,
  audienceIncludes,
  canTransition,
  DEFAULT_AUDIENCE,
  normaliseRules,
  parseAudience,
  parseSectionRules,
  type Reader,
  type SectionRules,
  SectionRulesSchema,
  SLUG_RE,
  slugify,
  UpdatesModelError,
  VISIBILITY_SCHEMA_VERSION,
  validatePostDoc,
} from "../model.js";
import { PostRepo, SendRepo, VersionRepo } from "../repos/updates-repo.js";
import type { Post, PostVersion, Send } from "../schema/updates.js";
import { indexPost } from "../search.js";
import { templateByKey } from "../templates.js";
import { JOB_SEND } from "./names.js";

/*
 * Post lifecycle (E1.4, §13.3): template → draft (autosaved, one row edited in place) →
 * schedule / send → immutable version + send row → the worker fans out (delivery.ts) →
 * `sent`. The archive reads the published version for a reader; RLS already narrowed sent
 * posts to the reader's audience, the service filters sections and hydrates references.
 */
export interface PostSummary {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly state: Post["state"];
  readonly audience: Audience;
  readonly templateKey: string | null;
  readonly scheduledFor: Date | null;
  readonly sentAt: Date | null;
  readonly publishedVersionNo: number | null;
  readonly savedAt: Date;
  readonly authorMembershipId: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly lastSend: SendSummary | null;
}

export interface SendSummary {
  readonly id: string;
  readonly kind: Send["kind"];
  readonly status: Send["status"];
  readonly total: number;
  readonly sent: number;
  readonly failed: number;
  readonly skipped: number;
  /** ESP feedback (E2.6): recipients the provider reported delivered, bounced, complained. */
  readonly delivered: number;
  readonly bounced: number;
  readonly complained: number;
  readonly error: string | null;
  readonly versionId: string;
  readonly requestedBy: string | null;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  readonly createdAt: Date;
}

export interface VersionSummary {
  readonly id: string;
  readonly versionNo: number;
  readonly title: string;
  readonly createdAt: Date;
  readonly createdBy: string | null;
  /** `<slug>:v<n>` of the disclaimer stamped onto this version when it was snapshotted (E1.6). */
  readonly disclaimerVersion: string | null;
  readonly isPublished: boolean;
}

export interface PostDetail {
  readonly post: PostSummary;
  readonly doc: PageDoc;
  readonly visibility: SectionRules;
  readonly groups: readonly { readonly id: string; readonly name: string }[];
  readonly versions: readonly VersionSummary[];
}

export interface ArchiveEntry {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly sentAt: Date | null;
  readonly versionNo: number;
}

export interface ArchivePage {
  readonly post: ArchiveEntry;
  readonly version: { readonly id: string; readonly versionNo: number; readonly createdAt: Date };
  readonly sections: readonly RenderedSection[];
  readonly viewer: Reader["kind"];
}

export interface ReadInput {
  readonly reader: Reader;
  readonly facts: RequestFacts;
  readonly enabledModules: ReadonlySet<string>;
  readonly actor: Actor;
}

export interface DraftInput {
  readonly title?: string | undefined;
  readonly doc?: unknown;
  readonly audience?: unknown;
  readonly visibility?: unknown;
  readonly baseSavedAt?: Date | undefined;
}

export function summarise(
  p: Post,
  published: PostVersion | undefined,
  last: Send | undefined,
): PostSummary {
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    state: p.state,
    audience: parseAudience(p.audience),
    templateKey: p.templateKey,
    scheduledFor: p.scheduledFor,
    sentAt: p.sentAt,
    publishedVersionNo: published?.versionNo ?? null,
    savedAt: p.savedAt,
    authorMembershipId: p.authorMembershipId,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    lastSend: last ? sendSummary(last) : null,
  };
}

export function sendSummary(s: Send): SendSummary {
  return {
    id: s.id,
    kind: s.kind,
    status: s.status,
    total: s.total,
    sent: s.sent,
    failed: s.failed,
    skipped: s.skipped,
    delivered: s.delivered,
    bounced: s.bounced,
    complained: s.complained,
    error: s.error,
    versionId: s.versionId,
    requestedBy: s.requestedBy,
    startedAt: s.startedAt,
    finishedAt: s.finishedAt,
    createdAt: s.createdAt,
  };
}

export function createPostService(services: ModuleServices) {
  const { db } = services;
  const now = () => services.now();

  function audit(
    tx: Tx,
    ctx: TenantContext,
    actor: Actor | null,
    action: string,
    postId: string,
    meta: JsonObject = {},
  ) {
    return services.audit.record(tx, ctx, {
      action,
      resourceKind: "post",
      resourceId: postId,
      ...(actor ? { actorMembershipId: actor.membershipId, requestId: actor.requestId } : {}),
      meta,
    });
  }

  async function live(ctx: TenantContext, tx: Tx, id: string): Promise<Post> {
    const p = await new PostRepo(ctx, tx).live(id);
    if (p === undefined) throw new UpdatesError("not_found", "no such update");
    return p;
  }

  async function detail(ctx: TenantContext, tx: Tx, p: Post): Promise<PostDetail> {
    const versions = await new VersionRepo(ctx, tx).forPost(p.id);
    const sends = await new SendRepo(ctx, tx).forPost(p.id);
    const groups = await new GroupRepo(ctx, tx).list();
    const published = versions.find((v) => v.id === p.publishedVersionId);
    return {
      post: summarise(p, published, sends[0]),
      doc: p.doc as PageDoc,
      visibility: parseSectionRules(p.visibility),
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
      versions: versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        title: v.title,
        createdAt: v.createdAt,
        createdBy: v.createdBy,
        disclaimerVersion: v.disclaimerVersion,
        isPublished: v.id === p.publishedVersionId,
      })),
    };
  }

  async function uniqueSlug(ctx: TenantContext, tx: Tx, base: string): Promise<string> {
    const posts = new PostRepo(ctx, tx);
    let slug = base;
    for (let i = 2; (await posts.bySlug(slug)) !== undefined; i++) slug = `${base}-${i}`;
    return slug;
  }

  async function checkGroups(ctx: TenantContext, tx: Tx, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await new GroupRepo(ctx, tx).byIds(ids);
    const missing = ids.filter((id) => !found.some((g) => g.id === id));
    if (missing.length > 0)
      throw new UpdatesError("validation_failed", "unknown group", { groupIds: missing });
  }

  /** Snapshots the draft into a new immutable version and points the post at it. */
  async function snapshot(
    ctx: TenantContext,
    tx: Tx,
    p: Post,
    actor: Actor | null,
  ): Promise<PostVersion> {
    const versions = new VersionRepo(ctx, tx);
    const v = await versions.create({
      postId: p.id,
      versionNo: await versions.nextNo(p.id),
      title: p.title,
      doc: p.doc,
      docSchemaVersion: p.docSchemaVersion,
      visibility: p.visibility,
      visibilitySchemaVersion: p.visibilitySchemaVersion,
      audience: p.audience,
      audienceSchemaVersion: p.audienceSchemaVersion,
      // The disclaimer in force at this instant, read in the transaction that writes the
      // snapshot: "these words went out under that legal text" has to be one atomic fact.
      disclaimerVersion: (await services.legal.stampFor(tx, ctx)) ?? null,
      createdBy: actor?.membershipId ?? null,
    });
    await new PostRepo(ctx, tx).update(p.id, { publishedVersionId: v.id });
    await audit(tx, ctx, actor, "update.published", p.id, {
      versionId: v.id,
      versionNo: v.versionNo,
    });
    await publish(tx, ctx, "update.published", {
      postId: p.id,
      versionId: v.id,
      audienceGroupIds:
        parseAudience(p.audience).kind === "groups"
          ? (parseAudience(p.audience) as { groupIds: string[] }).groupIds
          : [],
    });
    return v;
  }

  async function startSend(
    ctx: TenantContext,
    tx: Tx,
    p: Post,
    version: PostVersion,
    kind: Send["kind"],
    actor: Actor,
    testTo: readonly string[] = [],
  ): Promise<Send> {
    const s = await new SendRepo(ctx, tx).create({
      postId: p.id,
      versionId: version.id,
      kind,
      requestedBy: actor.membershipId,
    });
    await services.queue.sendInTransaction(
      tx,
      JOB_SEND,
      { workspaceId: ctx.workspaceId, sendId: s.id, testTo: [...testTo] },
      { idempotencyKey: `send:${s.id}` },
    );
    return s;
  }

  return {
    async list(ctx: TenantContext): Promise<PostSummary[]> {
      return db.withTenant(ctx, async (tx) => {
        const posts = await new PostRepo(ctx, tx).list();
        const out: PostSummary[] = [];
        for (const p of posts) {
          const versions = new VersionRepo(ctx, tx);
          const published = p.publishedVersionId
            ? await versions.byId(p.publishedVersionId)
            : undefined;
          const sends = await new SendRepo(ctx, tx).forPost(p.id);
          out.push(summarise(p, published, sends[0]));
        }
        return out;
      });
    },

    async get(ctx: TenantContext, id: string): Promise<PostDetail> {
      return db.withTenant(ctx, async (tx) => detail(ctx, tx, await live(ctx, tx, id)));
    },

    async create(
      ctx: TenantContext,
      input: { title: string; template: string },
      actor: Actor,
    ): Promise<PostDetail> {
      const template = templateByKey(input.template);
      if (template === undefined) throw new UpdatesError("validation_failed", "unknown template");
      const title = input.title.trim();
      if (title.length === 0 || title.length > 200)
        throw new UpdatesError("validation_failed", "title is required");
      return db.withTenant(ctx, async (tx) => {
        const doc = validatePostDoc(template.doc);
        const p = await new PostRepo(ctx, tx).create({
          slug: await uniqueSlug(ctx, tx, slugify(title)),
          title,
          doc,
          docSchemaVersion: DOC_SCHEMA_VERSION,
          visibility: normaliseRules(doc, {}),
          visibilitySchemaVersion: VISIBILITY_SCHEMA_VERSION,
          audience: DEFAULT_AUDIENCE,
          audienceSchemaVersion: AUDIENCE_SCHEMA_VERSION,
          templateKey: template.key,
          authorMembershipId: actor.membershipId,
          createdBy: actor.membershipId,
        });
        await audit(tx, ctx, actor, "update.created", p.id, { template: template.key });
        return detail(ctx, tx, p);
      });
    },

    async saveDraft(
      ctx: TenantContext,
      id: string,
      input: DraftInput,
      actor: Actor,
    ): Promise<PostDetail> {
      return db.withTenant(ctx, async (tx) => {
        const p = await live(ctx, tx, id);
        if (p.state === "sending") throw new UpdatesError("conflict", "the update is being sent");
        if (
          input.baseSavedAt !== undefined &&
          p.savedAt.getTime() !== input.baseSavedAt.getTime()
        ) {
          throw new UpdatesError("conflict", "the draft changed since you loaded it", {
            savedAt: p.savedAt.toISOString(),
          });
        }
        const patch: Parameters<PostRepo["update"]>[1] = { savedAt: now() };
        const changed: string[] = [];
        if (input.title !== undefined) {
          const title = input.title.trim();
          if (title.length === 0 || title.length > 200)
            throw new UpdatesError("validation_failed", "title is required");
          patch.title = title;
          if (p.state === "draft" && p.publishedVersionId === null)
            patch.slug = await uniqueSlug(ctx, tx, slugify(title));
          changed.push("title");
        }
        let doc = p.doc as PageDoc;
        if (input.doc !== undefined) {
          try {
            doc = validatePostDoc(input.doc);
          } catch (error) {
            if (error instanceof UpdatesModelError)
              throw new UpdatesError("validation_failed", error.message, error.details);
            throw error;
          }
          patch.doc = doc;
          patch.docSchemaVersion = DOC_SCHEMA_VERSION;
          changed.push("doc");
        }
        let rules = parseSectionRules(p.visibility);
        if (input.visibility !== undefined) {
          const parsed = SectionRulesSchema.safeParse(input.visibility);
          if (!parsed.success) throw new UpdatesError("validation_failed", "invalid section rules");
          const keys = new Set(doc.sections.map((s) => s.key));
          const unknown = Object.keys(parsed.data).filter((k) => !keys.has(k));
          if (unknown.length > 0)
            throw new UpdatesError("validation_failed", "unknown section", { keys: unknown });
          await checkGroups(
            ctx,
            tx,
            Object.values(parsed.data).flatMap((r) => (r.mode === "groups" ? r.groupIds : [])),
          );
          rules = parsed.data;
          changed.push("visibility");
        }
        patch.visibility = normaliseRules(doc, rules);
        if (input.audience !== undefined) {
          const parsed = AudienceSchema.safeParse(input.audience);
          if (!parsed.success) throw new UpdatesError("validation_failed", "invalid audience");
          if (parsed.data.kind === "groups") await checkGroups(ctx, tx, parsed.data.groupIds);
          patch.audience = parsed.data;
          changed.push("audience");
        }
        let updated: Post | undefined;
        try {
          updated = await new PostRepo(ctx, tx).update(p.id, patch);
        } catch (error) {
          if (pgErrorCode(error) === "23505") throw new UpdatesError("conflict", "slug in use");
          throw error;
        }
        if (updated === undefined) throw new UpdatesError("not_found", "no such update");
        if (changed.some((c) => c !== "doc" && c !== "title")) {
          await audit(tx, ctx, actor, "update.updated", p.id, { fields: changed });
        }
        // The archive (and RLS) read the live audience of a sent post, so its hits must follow.
        // Title and doc edits only reach investors through a new version, which re-indexes then.
        if (updated.state === "sent" && changed.includes("audience"))
          await indexPost(services, tx, ctx, updated);
        return detail(ctx, tx, updated);
      });
    },

    async schedule(
      ctx: TenantContext,
      id: string,
      scheduledFor: Date,
      actor: Actor,
    ): Promise<PostDetail> {
      if (scheduledFor.getTime() <= now().getTime())
        throw new UpdatesError("validation_failed", "scheduled time must be in the future");
      return db.withTenant(ctx, async (tx) => {
        const p = await live(ctx, tx, id);
        if (!canTransition(p.state, "scheduled"))
          throw new UpdatesError("conflict", `cannot schedule a ${p.state} update`);
        const updated = await new PostRepo(ctx, tx).transition(p.id, p.state, "scheduled", {
          scheduledFor,
        });
        if (updated === undefined) throw new UpdatesError("conflict", "state changed");
        await audit(tx, ctx, actor, "update.scheduled", p.id, {
          scheduledFor: scheduledFor.toISOString(),
        });
        return detail(ctx, tx, updated);
      });
    },

    async unschedule(ctx: TenantContext, id: string, actor: Actor): Promise<PostDetail> {
      return db.withTenant(ctx, async (tx) => {
        const p = await live(ctx, tx, id);
        if (p.state !== "scheduled")
          throw new UpdatesError("conflict", "the update is not scheduled");
        const updated = await new PostRepo(ctx, tx).transition(p.id, "scheduled", "draft", {
          scheduledFor: null,
        });
        if (updated === undefined) throw new UpdatesError("conflict", "state changed");
        await audit(tx, ctx, actor, "update.unscheduled", p.id);
        return detail(ctx, tx, updated);
      });
    },

    /** Publishes a version and queues the live send. `actor` null = the dispatcher. */
    async send(
      ctx: TenantContext,
      id: string,
      actor: Actor | null,
    ): Promise<{ detail: PostDetail; send: Send }> {
      return db.withTenant(ctx, async (tx) => {
        const p = await live(ctx, tx, id);
        if (!canTransition(p.state, "sending"))
          throw new UpdatesError("conflict", `cannot send a ${p.state} update`);
        const posts = new PostRepo(ctx, tx);
        const moved = await posts.transition(p.id, p.state, "sending", { scheduledFor: null });
        if (moved === undefined) throw new UpdatesError("conflict", "state changed");
        const version = await snapshot(ctx, tx, moved, actor);
        const s = await startSend(
          ctx,
          tx,
          moved,
          version,
          "live",
          actor ?? { membershipId: p.authorMembershipId ?? p.createdBy ?? "" },
        );
        const fresh = await live(ctx, tx, id);
        // `sending` is not readable in the archive: a re-send of a sent post drops out of search
        // until the delivery job moves it back to `sent` (and indexes the new version).
        await indexPost(services, tx, ctx, fresh);
        return { detail: await detail(ctx, tx, fresh), send: s };
      });
    },

    /** Test send of the current draft to the given addresses; no state change. */
    async testSend(
      ctx: TenantContext,
      id: string,
      to: readonly string[],
      actor: Actor,
    ): Promise<Send> {
      if (to.length === 0 || to.length > 5)
        throw new UpdatesError("validation_failed", "one to five addresses");
      return db.withTenant(ctx, async (tx) => {
        const p = await live(ctx, tx, id);
        if (p.state === "sending") throw new UpdatesError("conflict", "the update is being sent");
        const versions = new VersionRepo(ctx, tx);
        const v = await versions.create({
          postId: p.id,
          versionNo: await versions.nextNo(p.id),
          title: p.title,
          doc: p.doc,
          docSchemaVersion: p.docSchemaVersion,
          visibility: p.visibility,
          visibilitySchemaVersion: p.visibilitySchemaVersion,
          audience: p.audience,
          audienceSchemaVersion: p.audienceSchemaVersion,
          // A test send is a real send to a real inbox, so it is stamped like any other.
          disclaimerVersion: (await services.legal.stampFor(tx, ctx)) ?? null,
          createdBy: actor.membershipId,
        });
        return startSend(ctx, tx, p, v, "test", actor, to);
      });
    },

    /** Publishes to the web archive without email (a correction, or a post-hoc archive entry). */
    async publishToArchive(ctx: TenantContext, id: string, actor: Actor): Promise<PostDetail> {
      return db.withTenant(ctx, async (tx) => {
        const p = await live(ctx, tx, id);
        if (p.state === "sending") throw new UpdatesError("conflict", "the update is being sent");
        await snapshot(ctx, tx, p, actor);
        const posts = new PostRepo(ctx, tx);
        if (p.state !== "sent") {
          await posts.update(p.id, {
            state: "sent",
            sentAt: p.sentAt ?? now(),
            scheduledFor: null,
          });
        }
        const fresh = await live(ctx, tx, id);
        await indexPost(services, tx, ctx, fresh);
        return detail(ctx, tx, fresh);
      });
    },

    async archive(
      ctx: TenantContext,
      id: string,
      actor: Actor,
      archived: boolean,
    ): Promise<PostDetail> {
      return db.withTenant(ctx, async (tx) => {
        const p = await live(ctx, tx, id);
        const to = archived ? "archived" : p.publishedVersionId ? "sent" : "draft";
        if (p.state === to) return detail(ctx, tx, p);
        if (!canTransition(p.state, to))
          throw new UpdatesError("conflict", `cannot move a ${p.state} update to ${to}`);
        const updated = await new PostRepo(ctx, tx).transition(p.id, p.state, to);
        if (updated === undefined) throw new UpdatesError("conflict", "state changed");
        await audit(tx, ctx, actor, "update.updated", p.id, { fields: ["state"], state: to });
        await indexPost(services, tx, ctx, updated);
        return detail(ctx, tx, updated);
      });
    },

    async remove(ctx: TenantContext, id: string, actor: Actor): Promise<void> {
      await db.withTenant(ctx, async (tx) => {
        const p = await live(ctx, tx, id);
        if (p.state === "sending") throw new UpdatesError("conflict", "the update is being sent");
        await new PostRepo(ctx, tx).update(p.id, { deletedAt: now() });
        await audit(tx, ctx, actor, "update.deleted", p.id, { state: p.state });
        await indexPost(services, tx, ctx, p.id);
      });
    },

    async sends(ctx: TenantContext, id: string): Promise<SendSummary[]> {
      return db.withTenant(ctx, async (tx) => {
        await live(ctx, tx, id);
        return (await new SendRepo(ctx, tx).forPost(id)).map(sendSummary);
      });
    },

    /** Sent posts the reader may open (RLS narrows external readers to their audience). */
    async archiveList(ctx: TenantContext, reader: Reader): Promise<ArchiveEntry[]> {
      return db.withTenant(ctx, async (tx) => {
        const posts = await new PostRepo(ctx, tx).archive();
        const out: ArchiveEntry[] = [];
        for (const p of posts) {
          if (!p.publishedVersionId || !audienceIncludes(parseAudience(p.audience), reader))
            continue;
          const v = await new VersionRepo(ctx, tx).byId(p.publishedVersionId);
          if (v === undefined) continue;
          out.push({
            id: p.id,
            slug: p.slug,
            title: v.title,
            sentAt: p.sentAt,
            versionNo: v.versionNo,
          });
        }
        return out;
      });
    },

    async archiveRead(
      ctx: TenantContext,
      slug: string,
      input: ReadInput,
    ): Promise<ArchivePage | undefined> {
      const found = await db.withTenant(ctx, async (tx) => {
        const posts = new PostRepo(ctx, tx);
        const p = SLUG_RE.test(slug) ? await posts.bySlug(slug) : await posts.live(slug);
        if (p === undefined || p.publishedVersionId === null) return undefined;
        if (p.state !== "sent" && input.reader.kind !== "staff") return undefined;
        if (!audienceIncludes(parseAudience(p.audience), input.reader)) return undefined;
        const v = await new VersionRepo(ctx, tx).byId(p.publishedVersionId);
        return v === undefined ? undefined : { p, v };
      });
      if (found === undefined) return undefined;
      const { p, v } = found;
      const viewer = {
        kind: input.reader.kind,
        groupIds: input.reader.groupIds,
        ...(ctx.membershipId ? { membershipId: ctx.membershipId } : {}),
      };
      // Rendered with no transaction held: block hydrators (metrics, round, data room) open
      // their own `withTenant`, and doing that inside the read's transaction holds one pool
      // connection while waiting for another (E2.7 H3 — deadlocks a one-connection pool).
      const sections = await renderSections({
        doc: v.doc as PageDoc,
        visibility: parseSectionRules(v.visibility),
        viewer,
        allowPublic: false,
        hydrators: services.registry.blockHydrators,
        enabledModules: input.enabledModules,
        context: { tenant: ctx, viewer, facts: input.facts },
        log: services.log,
      });
      // Engagement signal (E1.5): an investor reading the archive, never staff previewing
      // their own update. Nor staff viewing the portal as this investor (E2.7): not the
      // investor's read. Its own short transaction, so the outbox row commits with it.
      if (input.reader.kind === "external" && ctx.viewAs === undefined) {
        await db.withTenant(ctx, (tx) =>
          publish(tx, ctx, "update.viewed", {
            postId: p.id,
            versionId: v.id,
            membershipId: input.actor.membershipId,
            sessionId: input.actor.sessionId ?? null,
          }),
        );
      }
      return {
        post: {
          id: p.id,
          slug: p.slug,
          title: v.title,
          sentAt: p.sentAt,
          versionNo: v.versionNo,
        },
        version: { id: v.id, versionNo: v.versionNo, createdAt: v.createdAt },
        sections,
        viewer: input.reader.kind,
      };
    },

    /**
     * Live group ids of a membership (the reader's audience). A delegate whose scope admits updates
     * reads through its principal's groups as well (E3.2), exactly as the RLS twin
     * `updates.audience_includes_current` does (migration 0003).
     */
    async groupIdsOf(ctx: TenantContext, membershipId: string): Promise<string[]> {
      return db.withTenant(ctx, (tx) =>
        new GroupRepo(ctx, tx).audienceGroupIdsFor(membershipId, "updates"),
      );
    },
  };
}

export type PostService = ReturnType<typeof createPostService>;
