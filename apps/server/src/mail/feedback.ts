import { createHash, createHmac, randomBytes } from "node:crypto";
import type { AuditRecorder } from "@fundroom/audit";
import type { EnvelopeService } from "@fundroom/crypto";
import {
  type Database,
  findWorkspaceById,
  isPlatformWorkspace,
  type ResolvedWorkspace,
  systemContext,
  type TenantContext,
  type Tx,
} from "@fundroom/db";
import { type EventPayload, parseWorkspaceSettings } from "@fundroom/domain";
import { publish } from "@fundroom/events";
import {
  classifyEngagement,
  isProviderSuppression,
  isUnsubscribeLink,
  stripLink,
} from "@fundroom/mail";
import type { MailDeliveryEvent, MailStream, OutboundEmail, SentEmail } from "@fundroom/ports";
import {
  findMailMessageForWebhook,
  MailMessageRepo,
  type MailMessageRow,
  MailSuppressionRepo,
  type MailSuppressionRow,
  type SuppressionCursor,
} from "./repos/mail-repo.js";

/*
 * Mail feedback, the kernel half of E2.6 decisions 1–3.
 *
 *  - **Recording.** After a provider accepts a message sent on behalf of a workspace, one
 *    `core.mail_message` row maps its provider id back to (workspace, stream, ref, member). Ids
 *    only. Best effort: the send already happened, and failing it now would only make the caller
 *    retry a message that is on its way.
 *  - **Suppression.** Per workspace, keyed by HMAC-SHA256 of the lower-cased address under the
 *    workspace's own `mail-suppression` data key. Hard bounces and complaints add to it, soft
 *    bounces and delays never do; the composition root checks it for `broadcast` and
 *    `notification` sends only.
 *  - **Ingest.** Each webhook event is looked up by provider id in host context — the one
 *    cross-tenant read, SELECT-only by the table's fence — and everything after that runs in the
 *    owning workspace's system context: suppression, the consent re-check for opens/clicks, the
 *    `mail.delivery_recorded` event. An id we never recorded is ignored, never guessed at.
 *
 * Early events. A provider's webhook can arrive before the sender's `recordSent` commits (the
 * provider answers the send, fires its `delivered`/`bounce` webhook, and our insert is still in
 * flight). An unknown id whose event is younger than `MAIL_EARLY_EVENT_WINDOW_MS` is counted as
 * `retry`, and the route answers 503 so the provider re-delivers; an older unknown id is ignored.
 *
 * Provider suppressions. A hard bounce whose `reason` starts with `provider_suppressed:` (Resend
 * `email.suppressed`, Postmark `SubscriptionChange`, SES `OnAccountSuppressionList`) is the
 * provider's own list speaking, not a delivery: it is listed with reason `provider` and *not*
 * published — the catalogue has no "suppressed" kind, and calling it a bounce would count a send
 * that was never attempted in the bounce figures. The same entry is written when an adapter
 * refuses a send with `MailSuppressedError("provider")` (Postmark's 406), via
 * `noteProviderSuppression`.
 *
 * The send path and the pool. `suppressionFor`, `recordSent` and `noteProviderSuppression` run
 * *inside someone else's send*, and senders (notify's deliver job, updates) may hold a pooled
 * connection in their own transaction while they send. If these lookups took a connection from
 * the same pool, N concurrent senders holding all N connections would each wait for an (N+1)th
 * that never frees: a pool deadlock no database can detect, broken only by the 30 s statement
 * timeout that never fires because no statement is running. So they run on `sendDb`, a small pool
 * of their own (the container gives it 4 connections). That breaks the cycle rather than making
 * it rarer: a sender holding a main-pool connection may *wait* for a send-pool one, but a
 * send-pool transaction never waits for anything in the main pool — it touches only
 * `core.mail_message`, `core.mail_suppression`, `core.workspace_key` (keys for this purpose are
 * created only here) and `audit.event` (append-only), none of which a sender's transaction
 * locks. A short per-(workspace, address) TTL cache (`SUPPRESSION_CACHE_TTL_MS`) keeps a
 * broadcast from paying one round trip per recipient; it is invalidated in-process whenever
 * this process suppresses or lifts an entry, so the staleness it adds is bounded by the TTL and
 * only across processes. `recordSent` stays awaited (not fire-and-forget): a webhook for a
 * message whose row is not written yet is exactly the early-event case above, and awaiting it
 * keeps that window as small as it can be — on its own pool it cannot deadlock.
 *
 * Key rotation. `crypto.rotate` on the `mail-suppression` purpose is routine, and the list must
 * survive it: we never hold the addresses, so entries cannot be re-hashed under the new key.
 * Each row records the `key_id` it was hashed under, new entries use the current key, and a
 * lookup hashes the address under *every* key the workspace holds for the purpose (retired ones
 * included; keys are never deleted) — one HMAC per rotation, usually one. Rotation still does
 * what it is for: entries written after it are not confirmable with the retired key alone.
 */

export const SUPPRESSION_KEY_PURPOSE = "mail-suppression";
/** An unknown message id whose event is younger than this is retried (503), not ignored. */
export const MAIL_EARLY_EVENT_WINDOW_MS = 10 * 60_000;
/** How long a suppression answer (either way) is reused for the same workspace and address. */
export const SUPPRESSION_CACHE_TTL_MS = 15_000;
const SUPPRESSION_CACHE_MAX = 10_000;
const PROVIDER_ID_MAX = 300;
const REF_KIND_MAX = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

type Log = (event: string, fields?: Readonly<Record<string, unknown>>) => void;
export type SuppressionReason = MailSuppressionRow["reason"];

export interface MailFeedbackOptions {
  readonly db: Database;
  /**
   * Pool for the send path (`suppressionFor`, `recordSent`, `noteProviderSuppression`), which
   * runs inside callers that may hold a `db` connection. Must not be `db` in production — see
   * "The send path and the pool" above. Defaults to `db` for tests that send outside any tx.
   */
  readonly sendDb?: Database | undefined;
  /**
   * The workspace's own origins (its host, the instance base URL). A clicked link on any other
   * origin is stored as its origin only (`stripLink`'s `ownOrigins`). Without it, every origin
   * keeps its redacted path. An entry with a path (`https://acme.com/investors`, a BASE_URL that
   * is a path mount — E3.9) owns only URLs under that path: the rest of that origin is the host
   * site's.
   */
  readonly ownOrigins?: ((workspace: ResolvedWorkspace) => readonly string[]) | undefined;
  readonly suppressionCacheTtlMs?: number | undefined;
  readonly envelope: Pick<EnvelopeService, "currentKey" | "keysFor">;
  readonly audit: AuditRecorder;
  /**
   * `legal.allowsPurpose(member, "email_tracking")`, folded with the workspace consent mode. Asked
   * at ingest for every open/click, because consent can be withdrawn after the send.
   */
  readonly allowsTracking: (tx: Tx, ctx: TenantContext, membershipId: string) => Promise<boolean>;
  readonly now?: (() => Date) | undefined;
  readonly log?: Log | undefined;
}

export interface IngestResult {
  /** Published as `mail.delivery_recorded`. */
  readonly recorded: number;
  /** No message id, or an id we never recorded. */
  readonly ignored: number;
  /** Open/click events refused by the analytics mode or the member's consent. */
  readonly dropped: number;
  /** Addresses newly added to a suppression list. */
  readonly suppressed: number;
  /** Events for a message we do not know *yet* (too recent to ignore): the route asks for a retry. */
  readonly retry: number;
}

export interface SuppressionView {
  readonly id: string;
  readonly address: string;
  readonly reason: SuppressionReason;
  readonly messageRef: string | null;
  readonly createdAt: Date;
}

export interface MailFeedback {
  /** The reason `address` is suppressed in the workspace, or `undefined` when it may be mailed. */
  suppressionFor(workspaceId: string, address: string): Promise<SuppressionReason | undefined>;
  /**
   * The provider refused to send to `address` from its own suppression list
   * (`MailSuppressedError("provider")`): list it in the workspace with reason `provider`.
   */
  noteProviderSuppression(provider: string, workspaceId: string, address: string): Promise<void>;
  /** Writes the `core.mail_message` row for an accepted message. Callers treat failure as a log line. */
  recordSent(provider: string, message: OutboundEmail, sent: SentEmail): Promise<void>;
  /** Applies one parsed webhook's events; `provider` is the configured driver, not the payload's word. */
  ingest(provider: string, events: readonly MailDeliveryEvent[]): Promise<IngestResult>;
  listSuppressions(
    ctx: TenantContext,
    page: { readonly limit: number; readonly after?: SuppressionCursor | undefined },
  ): Promise<{ items: SuppressionView[]; next: SuppressionCursor | undefined }>;
  /** Deletes the entry and audits `mail.unsuppressed`; `false` when there is no such entry. */
  unsuppress(
    ctx: TenantContext,
    id: string,
    actor: { readonly membershipId?: string | undefined; readonly requestId?: string | undefined },
  ): Promise<boolean>;
}

/** Lower-cased and trimmed: `Ada@Example.com ` and `ada@example.com` are one mailbox to an ESP. */
export function normalizeAddress(address: string): string {
  return address.trim().toLowerCase();
}

/** `a•••@example.com`: recognisable to the admin who knows the address, useless to anyone else. */
export function maskAddress(address: string): string {
  const normalized = normalizeAddress(address);
  const at = normalized.lastIndexOf("@");
  if (at <= 0) return "•••";
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1).slice(0, 253);
  return `${local[0] ?? ""}•••@${domain}`;
}

export function addressHash(key: Uint8Array, address: string): Buffer {
  return createHmac("sha256", key).update(normalizeAddress(address), "utf8").digest();
}

function streamOf(message: OutboundEmail): MailStream {
  return message.stream ?? "transactional";
}

function view(row: MailSuppressionRow): SuppressionView {
  return {
    id: row.id,
    address: row.addressMasked,
    reason: row.reason,
    messageRef: row.messageRef,
    createdAt: row.createdAt,
  };
}

export function createMailFeedback(options: MailFeedbackOptions): MailFeedback {
  const { db, envelope, audit } = options;
  const now = options.now ?? (() => new Date());
  const log: Log = options.log ?? (() => {});
  const sendDb = options.sendDb ?? db;
  const cacheTtl = options.suppressionCacheTtlMs ?? SUPPRESSION_CACHE_TTL_MS;

  /*
   * (workspace, address) → the last answer. Keyed by a digest under a per-process random pepper,
   * so the map holds no address and no hash comparable with anything outside this process.
   */
  const pepper = randomBytes(32);
  const cache = new Map<string, { reason: SuppressionReason | undefined; until: number }>();
  const cacheKey = (workspaceId: string, address: string) =>
    `${workspaceId}:${createHash("sha256").update(pepper).update(normalizeAddress(address)).digest("base64url")}`;
  function forget(workspaceId: string, address: string): void {
    cache.delete(cacheKey(workspaceId, address));
  }
  function remember(key: string, reason: SuppressionReason | undefined): void {
    if (cacheTtl <= 0) return;
    cache.delete(key);
    if (cache.size >= SUPPRESSION_CACHE_MAX) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { reason, until: now().getTime() + cacheTtl });
  }

  /** The address hashed under every `mail-suppression` key the workspace has ever held. */
  async function lookupHashes(tx: Tx, ctx: TenantContext, address: string): Promise<Buffer[]> {
    const keys = await envelope.keysFor(tx, ctx, SUPPRESSION_KEY_PURPOSE);
    return keys.map((key) => addressHash(key.key, address));
  }

  /** Suppress `recipient` in the message's workspace; audits only a *new* entry. */
  async function suppress(
    tx: Tx,
    ctx: TenantContext,
    row: MailMessageRow,
    event: MailDeliveryEvent,
    reason: "bounce" | "complaint" | "provider",
  ): Promise<boolean> {
    if (event.recipient.trim() === "") return false;
    const repo = new MailSuppressionRepo(ctx, tx);
    // Listed under a key since rotated away: already suppressed, not a second entry.
    if ((await repo.find(await lookupHashes(tx, ctx, event.recipient))) !== undefined) return false;
    const key = await envelope.currentKey(tx, ctx, SUPPRESSION_KEY_PURPOSE);
    const inserted = await repo.insertIfAbsent({
      addressHash: addressHash(key.key, event.recipient),
      keyId: key.keyId,
      addressMasked: maskAddress(event.recipient),
      reason,
      messageRef: row.id,
      createdBy: null,
    });
    if (inserted === undefined) return false;
    await audit.record(tx, ctx, {
      action: "mail.suppressed",
      resourceKind: "mail_suppression",
      resourceId: inserted.id,
      subjectMembershipId: row.membershipId,
      meta: {
        reason,
        provider: row.provider,
        messageRef: row.id,
        stream: row.stream,
        ...(event.bounceType === undefined ? {} : { bounceType: event.bounceType }),
      },
    });
    return true;
  }

  /** decision 1: opens/clicks only in `engagement` mode, only for a member whose consent allows it. */
  async function trackingAllowed(
    tx: Tx,
    ctx: TenantContext,
    row: MailMessageRow,
    mode: () => Promise<string>,
  ): Promise<boolean> {
    if (row.membershipId === null) return false;
    if ((await mode()) !== "engagement") return false;
    return options.allowsTracking(tx, ctx, row.membershipId);
  }

  return {
    async suppressionFor(workspaceId, address) {
      if (isPlatformWorkspace(workspaceId)) return undefined;
      const key = cacheKey(workspaceId, address);
      const hit = cache.get(key);
      if (hit !== undefined && hit.until > now().getTime()) return hit.reason;
      const ctx = systemContext(workspaceId);
      const reason = await sendDb.withTenant(ctx, async (tx) => {
        const found = await new MailSuppressionRepo(ctx, tx).find(
          await lookupHashes(tx, ctx, address),
        );
        return found?.reason;
      });
      remember(key, reason);
      return reason;
    },

    async noteProviderSuppression(provider, workspaceId, address) {
      if (isPlatformWorkspace(workspaceId) || address.trim() === "") return;
      const ctx = systemContext(workspaceId);
      await sendDb.withTenant(ctx, async (tx) => {
        const repo = new MailSuppressionRepo(ctx, tx);
        if ((await repo.find(await lookupHashes(tx, ctx, address))) !== undefined) return;
        const key = await envelope.currentKey(tx, ctx, SUPPRESSION_KEY_PURPOSE);
        const inserted = await repo.insertIfAbsent({
          addressHash: addressHash(key.key, address),
          keyId: key.keyId,
          addressMasked: maskAddress(address),
          reason: "provider",
          messageRef: null,
          createdBy: null,
        });
        if (inserted === undefined) return;
        await audit.record(tx, ctx, {
          action: "mail.suppressed",
          resourceKind: "mail_suppression",
          resourceId: inserted.id,
          meta: { reason: "provider", provider, source: "send_refused" },
        });
      });
      forget(workspaceId, address);
    },

    async recordSent(provider, message, sent) {
      const workspaceId = message.workspaceId;
      if (workspaceId === undefined || isPlatformWorkspace(workspaceId)) return;
      const providerMessageId = sent.messageId.trim();
      if (providerMessageId === "" || providerMessageId.length > PROVIDER_ID_MAX) return;
      const ref = message.ref;
      // Ids only, and only well-formed ones: a ref that is not a uuid cannot be echoed as the
      // event's `refId`, so it is not stored as one either.
      const refKind =
        ref !== undefined && ref.kind.length > 0 && ref.kind.length <= REF_KIND_MAX
          ? ref.kind
          : null;
      const refId = ref !== undefined && UUID_RE.test(ref.id) ? ref.id.toLowerCase() : null;
      const membershipId =
        ref?.membershipId !== undefined && UUID_RE.test(ref.membershipId)
          ? ref.membershipId.toLowerCase()
          : null;
      const ctx = systemContext(workspaceId);
      await sendDb.withTenant(ctx, (tx) =>
        new MailMessageRepo(ctx, tx).record({
          provider,
          providerMessageId,
          stream: streamOf(message),
          refKind,
          refId,
          membershipId,
          trackingOpens: message.tracking?.opens === true,
          trackingClicks: message.tracking?.clicks === true,
          sentAt: Number.isNaN(sent.acceptedAt.getTime()) ? now() : sent.acceptedAt,
        }),
      );
    },

    async ingest(provider, events) {
      let recorded = 0;
      let ignored = 0;
      let dropped = 0;
      let suppressed = 0;
      let retry = 0;
      for (const event of events) {
        const providerMessageId = event.messageId?.trim() ?? "";
        if (providerMessageId === "" || providerMessageId.length > PROVIDER_ID_MAX) {
          ignored += 1;
          continue;
        }
        const row = await db.withHost((tx) =>
          findMailMessageForWebhook(tx, provider, providerMessageId),
        );
        const occurredAt = Number.isNaN(event.occurredAt.getTime()) ? now() : event.occurredAt;
        if (row === undefined) {
          // Not recorded *yet* (the provider beat our insert): ask for a retry. Otherwise it is
          // not ours, was swept, or is instance-level mail — never guessed at.
          if (now().getTime() - occurredAt.getTime() <= MAIL_EARLY_EVENT_WINDOW_MS) retry += 1;
          else ignored += 1;
          continue;
        }
        const ctx = systemContext(row.workspaceId);
        let loaded: { ws: ResolvedWorkspace | undefined } | undefined;
        const workspace = async () => {
          loaded ??= { ws: await findWorkspaceById(db, row.workspaceId) };
          return loaded.ws;
        };
        const mode = async () => {
          const ws = await workspace();
          return ws === undefined ? "off" : parseWorkspaceSettings(ws.settings).analytics.mode;
        };
        const providerSuppression = isProviderSuppression(event);
        // A click on an unsubscribe link is the recipient leaving, not engaging.
        const unsubscribeClick = event.kind === "click" && isUnsubscribeLink(event.url);
        const ws = event.kind === "click" && !unsubscribeClick ? await workspace() : undefined;
        const link =
          event.kind === "click" && !unsubscribeClick
            ? stripLink(event.url, {
                ownOrigins:
                  ws === undefined || options.ownOrigins === undefined
                    ? undefined
                    : ownOriginsFor(event.url, options.ownOrigins(ws)),
              })
            : null;
        const outcome = await db.withTenant(ctx, async (tx) => {
          let added = false;
          if (providerSuppression) {
            added = await suppress(tx, ctx, row, event, "provider");
            return { published: false, added };
          }
          if (event.kind === "complaint") added = await suppress(tx, ctx, row, event, "complaint");
          else if (event.kind === "bounce" && event.bounceType === "hard")
            added = await suppress(tx, ctx, row, event, "bounce");
          if (unsubscribeClick) return { published: false, added };
          const engagement = event.kind === "open" || event.kind === "click";
          if (engagement && !(await trackingAllowed(tx, ctx, row, mode))) {
            return { published: false, added };
          }
          const verdict = classifyEngagement({ ...event, occurredAt }, { sentAt: row.sentAt });
          const payload: EventPayload<"mail.delivery_recorded"> = {
            messageRef: row.id,
            providerMessageId,
            kind: event.kind,
            bounceType: event.kind === "bounce" ? (event.bounceType ?? null) : null,
            automated: verdict.automated,
            refKind: row.refKind,
            refId: row.refId,
            membershipId: row.membershipId,
            link,
            occurredAt: occurredAt.toISOString(),
          };
          await publish(tx, ctx, "mail.delivery_recorded", payload);
          return { published: true, added };
        });
        // After the commit, so a concurrent lookup cannot re-cache the pre-commit answer.
        if (outcome.added) {
          forget(row.workspaceId, event.recipient);
          suppressed += 1;
        }
        if (outcome.published) recorded += 1;
        else if (!providerSuppression) dropped += 1;
      }
      if (events.length > 0) {
        log("mail.webhook_ingested", { provider, recorded, ignored, dropped, suppressed, retry });
      }
      return { recorded, ignored, dropped, suppressed, retry };
    },

    async listSuppressions(ctx, page) {
      return db.withTenant(ctx, async (tx) => {
        const rows = await new MailSuppressionRepo(ctx, tx).page(page.limit + 1, page.after);
        const items = rows.slice(0, page.limit).map(view);
        const last = items[items.length - 1];
        return {
          items,
          next: rows.length > page.limit && last !== undefined ? { id: last.id } : undefined,
        };
      });
    },

    async unsuppress(ctx, id, actor) {
      const lifted = await db.withTenant(ctx, async (tx) => {
        const removed = await new MailSuppressionRepo(ctx, tx).removeById(id);
        if (removed === undefined) return false;
        await audit.record(tx, ctx, {
          action: "mail.unsuppressed",
          resourceKind: "mail_suppression",
          resourceId: removed.id,
          ...(actor.membershipId === undefined ? {} : { actorMembershipId: actor.membershipId }),
          ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
          meta: { reason: removed.reason, messageRef: removed.messageRef },
        });
        return true;
      });
      if (lifted) {
        // We never hold the address, so the entry's cached answer cannot be named: drop the
        // workspace's whole slice of the cache, after the commit (a lift is rare; a refill is
        // one query per address).
        for (const key of cache.keys()) {
          if (key.startsWith(`${ctx.workspaceId}:`)) cache.delete(key);
        }
      }
      return lifted;
    },
  };
}

/**
 * `stripLink`'s `ownOrigins` for one clicked URL: its own origin when one of `bases` owns it, else
 * none. A bare origin owns its whole origin; an origin + path owns only that path and below.
 */
export function ownOriginsFor(url: string | undefined | null, bases: readonly string[]): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    return [];
  }
  const owned = bases.some((base) => {
    let b: URL;
    try {
      b = new URL(base);
    } catch {
      return false;
    }
    if (b.origin !== parsed.origin) return false;
    const prefix = b.pathname.replace(/\/+$/u, "");
    return prefix === "" || parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`);
  });
  return owned ? [parsed.origin] : [];
}
