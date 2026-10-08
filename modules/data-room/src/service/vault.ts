import { systemContext, type TenantContext, type Tx } from "@fundroom/db";
import { type EventEnvelope, type EventHandler, publish } from "@fundroom/events";
import type { ESignEnvelopeView, ModuleServices } from "@fundroom/module-kit";
import { childPath, type Protection } from "../model.js";
import { createQaTargetIndexer } from "../qa/search.js";
import { DocumentRepo, FolderRepo } from "../repos/dataroom-repo.js";
import { QaLifecycleRepo } from "../repos/qa-lifecycle-repo.js";
import type { Folder } from "../schema/dataroom.js";
import { createFolderService } from "./folders.js";
import {
  createDocumentFromStaged,
  discardStaged,
  type FromBytesResult,
  type StagedBytes,
  stageBytes,
} from "./from-bytes.js";
import { createSearchIndexer } from "./search.js";

/*
 * Vaulting signed e-signature documents (EXECUTION_PLAN §15 E3.5, ADR-0053; README "Vaulting").
 *
 * `esign.envelope_completed` → `data-room.vault {workspaceId, envelopeId}` → this service:
 *
 *  1. Skips (never fails) when the data room is disabled for the workspace at run time — the
 *     kernel keeps the artifact, vaulting is best effort — when the envelope names no vault
 *     folder, is not completed, or is already vaulted (redelivery, retry: idempotent).
 *  2. Reads the envelope (`services.esign.get`, a short tx) and the artifacts
 *     (`services.esign.readArtifact`, OUTSIDE any transaction), and stages the bytes on quarantine
 *     keys (storage writes, also outside).
 *  3. ONE transaction, serialised per workspace by an advisory lock taken first: re-check the
 *     dedupe key; ensure the folder path (missing segments are created, a name clash reuses the
 *     existing folder); create the signed document and — when the vendor sent one — the
 *     certificate as a second document, both under legal hold `esign:<envelopeId>`; index them;
 *     audit `document.vaulted`; publish `document.vaulted`. Lock order: vault advisory lock →
 *     question rows (only when an existing folder is flagged) → folder / document rows →
 *     workspace row (`acl_version`) → search entries → audit chain → outbox.
 *
 * The staff-only veil: the first folder of the path the vault CREATES is `staff_only`, so
 * everything it files is invisible to every external member whatever they were granted (README).
 * If the whole path already exists and nothing on it is staff-only, the leaf is flagged
 * staff-only (fail closed, audited) rather than filing a signed document where investors can see
 * it. Existing folders above are left as they are.
 */
export const JOB_VAULT = "data-room.vault";
/** Folder levels a vault path may create (the hint is kernel data, but bounded anyway). */
export const VAULT_MAX_SEGMENTS = 8;
/** `folder_name_length`. */
const MAX_FOLDER_NAME = 200;
/** `document_title_length`. */
const MAX_TITLE = 300;
/** File names are shown and sanitised again on download (`attachmentDisposition`). */
const MAX_FILE_BASE = 200;
export const VAULT_PROTECTION: Protection = Object.freeze({
  download: false,
  watermark: true,
  print: false,
  // E3.13: a vaulted signed document is staff-only; no forensic mark.
  forensic: false,
});

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/gu;

/** `Signed documents/Seed round` → `["Signed documents", "Seed round"]`: trimmed, bounded, no empties. */
export function vaultPathSegments(hint: string | null | undefined): string[] {
  if (typeof hint !== "string") return [];
  return hint
    .split("/")
    .map((s) =>
      s.replace(CONTROL, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_FOLDER_NAME).trim(),
    )
    .filter((s) => s.length > 0)
    .slice(0, VAULT_MAX_SEGMENTS);
}

export interface VaultTitles {
  readonly signed: string;
  readonly certificate: string;
  readonly signedFile: string;
  readonly certificateFile: string;
}

function withSuffix(base: string, suffix: string, max: number): string {
  return `${base.slice(0, max - suffix.length).trimEnd()}${suffix}`;
}

/** `<envelope title> — signed` / `<envelope title> — certificate`, within the column limits. */
export function vaultTitles(envelopeTitle: string): VaultTitles {
  const base =
    envelopeTitle.replace(CONTROL, " ").replace(/\s+/gu, " ").trim() || "Signed document";
  const file =
    base
      .replace(/[/\\:*?"<>|]/gu, "_")
      .slice(0, MAX_FILE_BASE)
      .trim() || "document";
  return {
    signed: withSuffix(base, " — signed", MAX_TITLE),
    certificate: withSuffix(base, " — certificate", MAX_TITLE),
    signedFile: `${file} (signed).pdf`,
    certificateFile: `${file} (certificate).pdf`,
  };
}

/** The folder operations `ensureVaultFolder` needs; the service binds them to a transaction. */
export interface VaultFolderOps {
  child(parent: VaultFolder, name: string): Promise<VaultFolder | undefined>;
  create(parent: VaultFolder, name: string, staffOnly: boolean): Promise<VaultFolder>;
  flagStaffOnly(folder: VaultFolder): Promise<VaultFolder>;
}

export type VaultFolder = Pick<Folder, "id" | "path" | "name" | "staffOnly">;

export interface EnsuredVaultFolder {
  readonly leaf: VaultFolder;
  readonly created: readonly VaultFolder[];
  /** An existing folder that was flagged staff-only because nothing on the path was. */
  readonly flagged: VaultFolder | undefined;
}

/**
 * Walks `segments` down from `root`: an existing child with the same name (case-insensitive) is
 * reused, a missing one created. The first folder created while nothing above is staff-only is
 * created staff-only (its whole subtree is then veiled); if every segment existed and none was
 * staff-only, the leaf is flagged. Postcondition: the leaf is at or below a staff-only folder.
 */
export async function ensureVaultFolder(
  ops: VaultFolderOps,
  root: VaultFolder,
  segments: readonly string[],
): Promise<EnsuredVaultFolder> {
  if (segments.length === 0) throw new Error("ensureVaultFolder: no path segments");
  let current = root;
  let covered = root.staffOnly;
  const created: VaultFolder[] = [];
  for (const name of segments) {
    const existing = await ops.child(current, name);
    if (existing !== undefined) {
      current = existing;
    } else {
      current = await ops.create(current, name, !covered);
      created.push(current);
    }
    covered ||= current.staffOnly;
  }
  if (covered) return { leaf: current, created, flagged: undefined };
  const flagged = await ops.flagStaffOnly(current);
  return { leaf: flagged, created, flagged };
}

export type VaultOutcome =
  | {
      readonly status: "vaulted";
      readonly documentId: string;
      readonly versionId: string;
      readonly certificateDocumentId: string | null;
      readonly folderId: string;
    }
  | {
      readonly status: "skipped";
      readonly reason:
        | "module_disabled"
        | "unknown_envelope"
        | "not_completed"
        | "no_vault_folder"
        | "already_vaulted"
        | "no_artifact"
        | "not_a_pdf";
    };

export interface VaultService {
  vault(input: {
    readonly workspaceId: string;
    readonly envelopeId: string;
  }): Promise<VaultOutcome>;
}

/** The envelope's vault folder hint (`core.esign_envelope.vault_folder`), or null. */
export function vaultFolderOf(view: Pick<ESignEnvelopeView, "vaultFolder">): string | null {
  return typeof view.vaultFolder === "string" ? view.vaultFolder : null;
}

export function createVaultService(services: ModuleServices): VaultService {
  const { db, log } = services;
  const indexer = createSearchIndexer(services);
  const qaIndexer = createQaTargetIndexer(services);
  const folders = createFolderService(services);

  function skipped(reason: Extract<VaultOutcome, { status: "skipped" }>["reason"]) {
    return { status: "skipped", reason } as const;
  }

  function folderOps(ctx: TenantContext, tx: Tx): VaultFolderOps {
    const repo = new FolderRepo(ctx, tx);
    return {
      async child(parent, name) {
        const lower = name.toLowerCase();
        return (await repo.children(parent.id)).find((f) => f.name.toLowerCase() === lower);
      },
      async create(parent, name, staffOnly) {
        const id = crypto.randomUUID();
        const siblings = await repo.children(parent.id);
        return repo.create({
          id,
          parentId: parent.id,
          name,
          path: childPath(parent.path, id),
          sortOrder: siblings.reduce((m, s) => Math.max(m, s.sortOrder), 0) + 1,
          staffOnly,
          createdBy: null,
        });
      },
      async flagStaffOnly(folder) {
        // The subtree's published Q&A changes ACL with it: question rows first (Q&A lock order).
        await new QaLifecycleRepo(ctx, tx).lockOnTargets({ underPath: folder.path }, "share");
        const updated = await repo.update(folder.id, { staffOnly: true });
        if (updated === undefined) throw new Error(`folder ${folder.id} vanished`);
        return updated;
      },
    };
  }

  async function fileIt(
    ctx: TenantContext,
    view: ESignEnvelopeView,
    segments: readonly string[],
    signed: StagedBytes,
    certificate: StagedBytes | undefined,
  ): Promise<
    | { outcome: VaultOutcome; results: FromBytesResult[] }
    | { outcome: Extract<VaultOutcome, { status: "skipped" }>; results: [] }
  > {
    const root = await folders.ensureRoot(ctx.workspaceId);
    const titles = vaultTitles(view.title);
    const now = services.now();
    return db.withTenant(ctx, async (tx) => {
      // Serialises every vault of this workspace: two envelopes completing at once into the same
      // new path see each other's folders instead of both creating one (or one hitting the
      // unique name index), and the dedupe re-check below is race-free.
      await new FolderRepo(ctx, tx).lockVault();
      const docs = new DocumentRepo(ctx, tx);
      if ((await docs.byEsignEnvelope(view.id)) !== undefined)
        return { outcome: skipped("already_vaulted"), results: [] };
      const ensured = await ensureVaultFolder(folderOps(ctx, tx), root, segments);
      const leaf = ensured.leaf;
      const reason = `esign:${view.id}`;
      const results: FromBytesResult[] = [];
      results.push(
        await createDocumentFromStaged(services, tx, ctx, {
          folder: leaf,
          staged: signed,
          title: titles.signed,
          fileName: titles.signedFile,
          protection: VAULT_PROTECTION,
          legalHoldReason: reason,
          esignEnvelopeId: view.id,
          createdBy: null,
          now,
        }),
      );
      if (certificate !== undefined) {
        results.push(
          await createDocumentFromStaged(services, tx, ctx, {
            folder: leaf,
            staged: certificate,
            title: titles.certificate,
            fileName: titles.certificateFile,
            protection: VAULT_PROTECTION,
            legalHoldReason: reason,
            createdBy: null,
            now,
          }),
        );
      }
      const [main, cert] = results;
      if (main === undefined) throw new Error("vault: no signed document");
      // A new or newly flagged staff-only folder: the materialised effective-access rows must
      // learn the veil (packages/authz rebuild). The module's own checks, RLS and the search ACL
      // already hold it from this commit on.
      const newlyVeiled = ensured.created.some((f) => f.staffOnly) || ensured.flagged !== undefined;
      if (newlyVeiled) await services.authz.bump(tx, ctx, "data-room.vault");
      if (ensured.flagged !== undefined) {
        // Everything already in the flagged folder turns staff-only in search now.
        await qaIndexer.subtreeBack(tx, ctx, ensured.flagged.path);
        await indexer.subtree(tx, ctx, ensured.flagged.path);
      }
      await indexer.folders(
        tx,
        ctx,
        ensured.created.map((f) => f.id),
      );
      await indexer.documents(
        tx,
        ctx,
        results.map((r) => r.document.id),
      );
      const cause = { cause: "esign.vault", envelopeId: view.id };
      for (const f of ensured.created) {
        await services.audit.record(tx, ctx, {
          action: "folder.created",
          resourceKind: "folder",
          resourceId: f.id,
          meta: { ...cause, staffOnly: f.staffOnly },
        });
      }
      if (ensured.flagged !== undefined) {
        await services.audit.record(tx, ctx, {
          action: "folder.updated",
          resourceKind: "folder",
          resourceId: ensured.flagged.id,
          diff: { before: { staffOnly: false }, after: { staffOnly: true } },
          meta: cause,
        });
      }
      for (const [i, r] of results.entries()) {
        await services.audit.record(tx, ctx, {
          action: "document.vaulted",
          resourceKind: "document",
          resourceId: r.document.id,
          subjectMembershipId: view.membershipId,
          meta: {
            ...cause,
            artifact: i === 0 ? "signed" : "certificate",
            purpose: view.purpose,
            versionId: r.version.id,
            folderId: leaf.id,
            legalHold: true,
            deduplicated: r.deduplicated,
          },
        });
      }
      await publish(tx, ctx, "document.vaulted", {
        documentId: main.document.id,
        versionId: main.version.id,
        envelopeId: view.id,
      });
      return {
        outcome: {
          status: "vaulted",
          documentId: main.document.id,
          versionId: main.version.id,
          certificateDocumentId: cert?.document.id ?? null,
          folderId: leaf.id,
        },
        results,
      };
    });
  }

  return {
    async vault({ workspaceId, envelopeId }) {
      const ctx = systemContext(workspaceId);
      const enabled = (await services.enablement.get(db, ctx)).enabled.has("data-room");
      if (!enabled) {
        log("data-room.vault_skipped", { workspaceId, envelopeId, reason: "module_disabled" });
        return skipped("module_disabled");
      }
      const loaded = await db.withTenant(ctx, async (tx) => ({
        view: await services.esign.get(tx, ctx, envelopeId),
        existing: await new DocumentRepo(ctx, tx).byEsignEnvelope(envelopeId),
      }));
      const view = loaded.view;
      const early =
        view === undefined
          ? "unknown_envelope"
          : loaded.existing !== undefined || view.vaultedDocumentId !== null
            ? "already_vaulted"
            : view.status !== "completed" || !view.hasSigned
              ? "not_completed"
              : vaultPathSegments(vaultFolderOf(view)).length === 0
                ? "no_vault_folder"
                : undefined;
      if (early !== undefined || view === undefined) {
        log("data-room.vault_skipped", { workspaceId, envelopeId, reason: early });
        return skipped(early ?? "unknown_envelope");
      }
      // Kernel reads and storage writes: outside any transaction (pool-deadlock rule).
      const signedBytes = await services.esign.readArtifact(ctx, envelopeId, "signed");
      if (signedBytes === undefined) {
        log("data-room.vault_skipped", { workspaceId, envelopeId, reason: "no_artifact" });
        return skipped("no_artifact");
      }
      const certBytes = view.hasCertificate
        ? await services.esign.readArtifact(ctx, envelopeId, "certificate")
        : undefined;
      const staged: (StagedBytes | undefined)[] = [];
      let keep = false;
      try {
        const signed = await stageBytes(services, workspaceId, signedBytes);
        staged.push(signed);
        const certificate =
          certBytes === undefined ? undefined : await stageBytes(services, workspaceId, certBytes);
        staged.push(certificate);
        if (signed === undefined || signed.contentType !== "application/pdf") {
          log("data-room.vault_skipped", { workspaceId, envelopeId, reason: "not_a_pdf" });
          return skipped("not_a_pdf");
        }
        const cert = certificate?.contentType === "application/pdf" ? certificate : undefined;
        const { outcome, results } = await fileIt(
          ctx,
          view,
          vaultPathSegments(vaultFolderOf(view)),
          signed,
          cert,
        );
        if (outcome.status === "vaulted") {
          // Staged objects now belong to their blobs, unless a servable blob already had them.
          keep = true;
          await discardStaged(
            services,
            results.map((r, i) => (r.deduplicated ? (i === 0 ? signed : cert) : undefined)),
          );
          if (cert !== certificate) await discardStaged(services, [certificate]);
          log("data-room.vaulted", {
            workspaceId,
            envelopeId,
            documentId: outcome.documentId,
            certificateDocumentId: outcome.certificateDocumentId,
          });
        }
        return outcome;
      } finally {
        if (!keep) await discardStaged(services, staged);
      }
    },
  };
}

/**
 * `esign.envelope_completed` → one `data-room.vault` job per envelope (idempotency key), on the
 * dispatcher's transaction. Not gated here: the job decides at run time whether the data room is
 * enabled (and skips if not), so a redelivered event and a retried job both land on the same
 * dedupe. Envelopes of every purpose are vaulted when they name a vault folder.
 */
export function createVaultHandler(live: () => ModuleServices): EventHandler {
  return async (event, { tx, ctx }) => {
    if (event.topic !== "esign.envelope_completed")
      throw new Error(`data-room: esign.envelope_completed handler got ${event.topic}`);
    if (ctx.actorKind === "host") return;
    const { envelopeId } = (event as unknown as EventEnvelope<"esign.envelope_completed">).payload;
    await live().queue.sendInTransaction(
      tx,
      JOB_VAULT,
      { workspaceId: ctx.workspaceId, envelopeId },
      { idempotencyKey: `${JOB_VAULT}:${envelopeId}` },
    );
  };
}
