import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { AuditRecorder } from "@fundroom/audit";
import { ciphertextLength, encryptStream } from "@fundroom/crypto";
import { pgErrorCode, systemContext, type TenantContext, type Tx } from "@fundroom/db";
import {
  type ModuleManifest,
  type ModuleServices,
  type PortableImportContext,
  PortableImportRefusal,
  type PortableTable,
} from "@fundroom/module-kit";
import type { DirectoryPort, JsonObject, JsonValue } from "@fundroom/ports";
import { brandingLogoKey, certificateKey } from "@fundroom/storage";
import { PortabilityError } from "./errors.js";
import type { PortabilityEngineDeps } from "./export.js";
import {
  blobEntryName,
  byteaHex,
  ENTRY,
  type ExportManifest,
  exportPublicKeys,
  IMPORT_ARCHIVE_PURPOSE,
  KERNEL_PORTABILITY_VERSION,
  MAX_LINE_BYTES,
  tableEntryName,
} from "./format.js";
import { BLOB_VALUE_RE, checkImportedKey, collectUuids, scrubForeign } from "./import-guards.js";
import { buildMigrations } from "./migrations.js";
import {
  maskAddress,
  type SheDescriptor,
  SUPPRESSION_KEY_PURPOSE,
  suppressionHash,
} from "./objects.js";
import { KERNEL_OWNER, type PlannedTable, planTables } from "./plan.js";
import { IdMap, isUuid, uuidv7 } from "./remap.js";
import {
  applyDeferred,
  countLiveOwners,
  createTombstoneUser,
  createUserWithEmail,
  describeTable,
  enterSystemContext,
  findCrossWorkspaceForeignKey,
  findForeignReferences,
  findUserIdByEmail,
  insertOwnerMembership,
  insertRows,
  insertSuppression,
  insertWorkspace,
  insertWorkspaceImport,
  liveMembershipOf,
  makeOwner,
  prepareImportSession,
  resetEsignCeremonies,
  type TableInfo,
  updateWorkspaceSettings,
} from "./repos/portability-repo.js";
import { type ExportVerification, verifyExportFile } from "./verify.js";
import { lines, ZipFileReader } from "./zip/reader.js";
import { ZipFileWriter } from "./zip/writer.js";

/*
 * The importer (E2.8 contract §2/§4). Order of events:
 *
 *  1. `verifyExportFile` — structure, signature, every hash, the audit chain. Unpinned origin is
 *     refused unless the operator passes `--allow-unverified`.
 *  2. Compatibility — every migration the source had must be applied here (a column the target
 *     lacks would otherwise be dropped silently), module sections not newer than this build's.
 *  3. Pass one over the tables: a new uuidv7 for every exported row id (in export order, so
 *     time-ordered ids keep their order) and the members' identities.
 *  4. ONE transaction: the workspace row and the members' global users (host context), then —
 *     switched to the new workspace's `system` actor on the same connection — every table in plan
 *     order through the generic remap, blob re-encryption and the module's `importRow`, deferred
 *     FK columns, the suppression list re-hashed, effective access rebuilt, module `afterImport`
 *     hooks, a search reindex request, the source audit trail archived (encrypted), and
 *     `core.workspace_import` + one `workspace.imported` audit event. Objects written before a
 *     failed commit are deleted.
 *
 * Identity: a member is matched to an existing `core.user_identity` by email, or a user is created
 * with that verified email. Nothing is reported about which it was — the result counts memberships,
 * never "existing" vs "new" accounts — so an import cannot be used to learn whether an address
 * already has an account on this instance. A member whose identity was erased (or who had no email
 * identity) gets an inert tombstone user that can never sign in.
 */

export interface ImportDeps extends PortabilityEngineDeps {
  readonly audit: AuditRecorder;
  /** What module `beforeImport`/`afterImport` hooks receive. */
  readonly moduleServices: ModuleServices;
  /**
   * Re-derives stored resource-rule paths from the imported resources (E3.2): folder grants and
   * gates get their folder's `path`, every other kind none, and pending invitations lose any
   * stored `resource.path` (acceptance derives it). Runs right before `rebuildAccess`, so the
   * effective-access rows are built from the corrected rules. Returns how many rows it changed,
   * reported as an import warning when non-zero.
   */
  readonly rederiveRulePaths?: ((tx: Tx, ctx: TenantContext) => Promise<number>) | undefined;
  /** Kernel re-derivation on the import tx (effective access). */
  readonly rebuildAccess?: ((tx: Tx, ctx: TenantContext) => Promise<void>) | undefined;
  /** Where temporary files go (the audit archive). */
  readonly tmpDir: string;
  /**
   * E3.11: the cell the new workspace lands in (`CELL_ID`). Omitted: the column default
   * (`'default'`) — only tests that predate cells rely on that.
   */
  readonly cellId?: string | undefined;
  /**
   * E3.11: the cell directory. A plain import claims its slug there before the workspace row is
   * written (`taken` → `slug_taken`, never naming the holder), activates the entry after the
   * commit and releases it when the import fails. A move's import (`input.relocation`) does not
   * claim: the slug belongs to the moving entry, which the switchover rebinds.
   */
  readonly directory?: Pick<DirectoryPort, "claimSlug" | "activate" | "release"> | undefined;
}

/**
 * E3.11: the import is the TARGET half of a move between cells (`@fundroom/control-plane`
 * moves). The workspace row is written with the control-plane facts the move carries, and the
 * `relocation` hold among `holds`, so it is never reachable before the switchover; the move id is
 * recorded on `core.workspace_import.source.moveId` (the move engine's crash repair finds the copy
 * by it).
 */
export interface ImportRelocation {
  readonly moveId: string;
  /** Every hold the copy starts with (`relocation` plus the source's other holds). */
  readonly holds: readonly string[];
  readonly planId: string | null;
  readonly legalName: string | null;
  readonly country: string | null;
  /**
   * Runs last inside the import transaction, in the new workspace's `system` context (the move
   * engine's own rows and audit entries: the subscription binding, `workspace.move_import`).
   */
  readonly beforeCommit?: ((tx: Tx, workspaceId: string) => Promise<void>) | undefined;
}

export interface ImportWorkspaceInput {
  readonly file: string;
  readonly slug: string;
  /** Default: the source workspace's name. */
  readonly name?: string | undefined;
  readonly trustedPublicKeys?: readonly string[] | undefined;
  readonly allowUnverified?: boolean | undefined;
  /** Guarantees a live staff owner with this email (promoted or created). */
  readonly ownerEmail?: string | undefined;
  /** Operator label recorded on `core.workspace_import`. */
  readonly importedBy: string;
  /** TEST SEAM ONLY: source tables this build does not declare, tolerated and not imported. */
  readonly allowUndeclared?: readonly string[] | undefined;
  /** E3.11: this import is a move's (see `ImportRelocation`). */
  readonly relocation?: ImportRelocation | undefined;
}

export interface ImportWorkspaceResult {
  readonly workspaceId: string;
  readonly importId: string;
  readonly slug: string;
  readonly signature: "trusted" | "unverified";
  /** Rows inserted per `<schema>.<table>`. */
  readonly counts: Readonly<Record<string, number>>;
  readonly objects: number;
  readonly warnings: readonly string[];
  readonly verification: ExportVerification;
}

/**
 * The kernel's re-derivation on the import transaction, in the one order that is correct (E3.2):
 * rule paths from the imported resources first, then effective access from those rules — a rebuild
 * over the paths as the file carried them would materialise an over-broad rule before it was
 * corrected. Returns the warnings to report (a non-zero re-derivation count).
 */
export async function rederiveAccess(
  deps: Pick<ImportDeps, "rederiveRulePaths" | "rebuildAccess">,
  tx: Tx,
  ctx: TenantContext,
): Promise<string[]> {
  const rederived = (await deps.rederiveRulePaths?.(tx, ctx)) ?? 0;
  await deps.rebuildAccess?.(tx, ctx);
  return rederived > 0
    ? [
        `${rederived} access rule(s) or pending invitation(s) carried a resource path that did not match the resource; the path was re-derived from the imported data`,
      ]
    : [];
}

const BATCH_ROWS = 500;
const BATCH_BYTES = 4 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

interface Identity {
  readonly email: string;
  readonly displayName: string;
}

function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function identityOf(value: unknown): Identity | null {
  if (!isObject(value) || typeof value["email"] !== "string") return null;
  const email = value["email"].trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) return null;
  return {
    email,
    displayName: typeof value["displayName"] === "string" ? value["displayName"] : "",
  };
}

async function* rowsOf(zip: ZipFileReader, entryName: string): AsyncGenerator<JsonObject> {
  const entry = zip.entry(entryName);
  if (entry === undefined) return;
  for await (const line of lines(zip.read(entry), MAX_LINE_BYTES)) {
    if (line.length === 0) continue;
    const row: unknown = JSON.parse(line);
    if (!isObject(row))
      throw new PortabilityError("invalid_input", `${entryName}: a line is not an object`);
    yield row;
  }
}

/** Source tables to insert, in THIS build's plan order; refuses tables this build does not know. */
function importPlan(
  manifest: ExportManifest,
  plan: readonly PlannedTable[],
  tolerated: ReadonlySet<string>,
): PlannedTable[] {
  const carried = new Map(
    manifest.tables.filter((t) => t.skipped === undefined).map((t) => [t.name, t]),
  );
  const known = new Set(plan.map((p) => p.name));
  const unknown = [...carried.keys()].filter((n) => !known.has(n) && !tolerated.has(n));
  if (unknown.length > 0)
    throw new PortabilityError(
      "incompatible",
      `the export carries tables this instance does not declare: ${unknown.join(", ")}`,
      unknown,
    );
  return plan.filter((p) => carried.has(p.name) && p.spec.mode === "rows");
}

function checkCompatibility(
  manifest: ExportManifest,
  modules: readonly ModuleManifest[],
  applied: Readonly<Record<string, readonly string[]>>,
): void {
  const problems: string[] = [];
  const byId = new Map(modules.map((m) => [m.id, m]));
  const carriedOwners = new Set(
    manifest.tables
      .filter((t) => t.skipped === undefined && t.rows > 0)
      .map((t) => t.name.split(".")[0] as string),
  );
  for (const [id, section] of Object.entries(manifest.modules)) {
    if (id === KERNEL_OWNER) {
      if (section.version > KERNEL_PORTABILITY_VERSION)
        problems.push(
          `the kernel section is version ${section.version}, this build reads ${KERNEL_PORTABILITY_VERSION}`,
        );
    } else {
      const m = byId.get(id);
      if (m === undefined) {
        if (section.migrations.length > 0 && m === undefined && [...carriedOwners].length > 0)
          problems.push(`module ${id} is not compiled into this instance`);
        continue;
      }
      const version = m.portability?.version ?? 0;
      if (section.version > version)
        problems.push(
          `module ${id}'s section is version ${section.version}, this build reads ${version}`,
        );
    }
    const have = new Set(applied[id] ?? []);
    const missing = section.migrations.filter((n) => !have.has(n));
    if (missing.length > 0)
      problems.push(
        `${id}: migrations not applied here: ${missing.join(", ")} (upgrade this instance first)`,
      );
  }
  if (problems.length > 0)
    throw new PortabilityError("incompatible", "the export does not fit this instance", problems);
}

export async function importWorkspace(
  deps: ImportDeps,
  input: ImportWorkspaceInput,
): Promise<ImportWorkspaceResult> {
  const now = deps.now?.() ?? new Date();
  const slug = input.slug.trim().toLowerCase();
  if (!SLUG_RE.test(slug))
    throw new PortabilityError("invalid_input", `invalid slug ${input.slug}`);
  const ownerEmail = input.ownerEmail?.trim().toLowerCase();
  if (ownerEmail !== undefined && !EMAIL_RE.test(ownerEmail))
    throw new PortabilityError("invalid_input", "invalid --owner-email");

  // 1. verification: integrity first (against the embedded key), then origin separately, so a
  // signature by a key nobody pinned is "unverified origin" (overridable) rather than corruption.
  const integrity = await verifyExportFile(input.file);
  if (!integrity.ok || integrity.manifest === null)
    throw new PortabilityError(
      "verification_failed",
      "the export did not verify",
      integrity.problems,
    );
  const manifest = integrity.manifest;
  const trusted =
    input.trustedPublicKeys?.some((k) => k.trim() === manifest.signature.publicKey) === true;
  if (!trusted && input.allowUnverified !== true)
    throw new PortabilityError(
      "unverified_origin",
      `the export is signed by key ${manifest.signature.keyId} (${manifest.signature.publicKey}), which is not a trusted public key; pass --public-key <the source's export key> (or --allow-unverified to import it anyway)`,
    );
  const verification: ExportVerification = { ...integrity, trusted };

  // 2. compatibility
  const applied = await buildMigrations(deps.modules);
  checkCompatibility(manifest, deps.modules, applied);
  const plan = planTables(deps.modules);
  const tables = importPlan(manifest, plan, new Set(input.allowUndeclared ?? []));

  const zip = await ZipFileReader.open(input.file);
  const uploaded: string[] = [];
  /** The workspace whose slug this import claimed in the directory (released on failure). */
  let claimed: string | undefined;
  const archivePath = join(deps.tmpDir, `import-audit-${uuidv7()}.zip`);
  try {
    // 3. pass one: new ids, identities
    const ids = new IdMap();
    const sourceWs = manifest.source.workspaceId;
    if (!isUuid(sourceWs))
      throw new PortabilityError("invalid_input", "manifest source.workspaceId is not a uuid");
    const workspaceId = ids.allocate(sourceWs);
    const identities = new Map<string, Identity | null>();
    // Every uuid the file carries outside `$` keys and verbatim (evidence) columns; after pass
    // one, those that are not an exported row's id are the "verbatim" references the database
    // is asked about (README "Import refusal rules").
    const referenced = new Set<string>();
    let workspaceRow: JsonObject | undefined;
    for (const p of tables) {
      const verbatim = new Set(p.kernel?.verbatimColumns ?? []);
      for await (const row of rowsOf(zip, tableEntryName(p.schema, p.table))) {
        for (const [k, v] of Object.entries(row)) {
          if (!k.startsWith("$") && !verbatim.has(k)) collectUuids(v, referenced);
        }
        if (p.kernel?.special === "workspace") {
          workspaceRow = row;
          continue;
        }
        const id = row["id"];
        if (isUuid(id)) ids.allocate(id);
        if (p.kernel?.special === "membership" && isUuid(id))
          identities.set(id.toLowerCase(), identityOf(row["$identity"]));
      }
    }
    if (workspaceRow === undefined)
      throw new PortabilityError("invalid_input", "the export has no core.workspace row");
    const verbatimUuids = [...referenced].filter((u) => !ids.has(u));
    // An export signed by THIS instance was written by this instance's exporter: its references to
    // rows of its own source workspace (e.g. the analytics cursor's last raw event, not carried)
    // are genuine. From anywhere else — even a pinned key — the claimed source is just a claim.
    const signedHere = exportPublicKeys(deps.keyRing).some(
      (k) => k.publicKey === manifest.signature.publicKey,
    );

    const ictx: PortableImportContext = {
      workspaceId,
      sourceWorkspaceId: sourceWs,
      now,
      mapId: ids.mapId,
      remapLtree: ids.remapLtree,
      remapKey: ids.remapKey,
    };
    const ctx = systemContext(workspaceId);
    const counts: Record<string, number> = {};
    const warnings: string[] = omittedImportWarnings(manifest);
    const importId = uuidv7();
    const relocation = input.relocation;

    // E3.11: the directory decides slug uniqueness across cells, before the local row exists (a
    // move's import does not claim: the moving entry owns the slug).
    if (relocation === undefined && deps.directory !== undefined) {
      let claim: "claimed" | "taken";
      try {
        claim = await deps.directory.claimSlug({
          workspaceId,
          slug,
          cellId: deps.cellId ?? "default",
        });
      } catch (error) {
        throw new PortabilityError(
          "import_failed",
          `the cell directory could not be asked whether the slug is free: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (claim === "taken")
        throw new PortabilityError("slug_taken", `a live workspace already uses the slug ${slug}`);
      claimed = workspaceId;
    }

    await deps.db.withHost(async (tx) => {
      // 4a. host phase: the workspace and the members' users.
      //
      // Settings (A-3 R2 M1): the two whole-document writes below are not the lost-update shape
      // that `updateWorkspaceSettingsBlock` exists for — the row is inserted by this transaction,
      // so no other writer can see it before the commit. Nor can they bypass a plan: a plain
      // import creates a workspace with no plan (unrestricted, like every plan-less workspace),
      // and a move's import carries the source's own plan with the source's own settings and
      // module enablement — the same workspace's configuration, which a downgrade freezes rather
      // than strips (what is on stays on), so a relocation keeps it unchanged too. An operator
      // who later assigns a plan is an ordinary plan change: nothing new can be turned on.
      const settings = ids.deepRemap(
        isObject(workspaceRow?.["settings"]) ? (workspaceRow?.["settings"] as JsonValue) : {},
      ) as JsonObject;
      const logoMeta = isObject(workspaceRow?.["$blobs"])
        ? workspaceRow?.["$blobs"]["logo"]
        : undefined;
      const logoSha =
        isObject(logoMeta) &&
        typeof logoMeta["sha256"] === "string" &&
        /^[0-9a-f]{64}$/u.test(logoMeta["sha256"])
          ? logoMeta["sha256"]
          : undefined;
      {
        // The logo key is the engine's to write: a logo without a carried blob is dropped rather
        // than kept pointing at whatever object key the file names.
        const branding = isObject(settings["branding"]) ? settings["branding"] : undefined;
        if (
          branding &&
          branding["logo"] !== undefined &&
          branding["logo"] !== null &&
          logoSha === undefined
        )
          branding["logo"] = null;
      }
      try {
        await insertWorkspace(tx, {
          id: workspaceId,
          slug,
          name: (input.name ?? String(workspaceRow?.["name"] ?? manifest.source.name)).trim(),
          settings,
          offeringStatus: String(workspaceRow?.["offering_status"] ?? "none"),
          defaultLocale: String(workspaceRow?.["default_locale"] ?? "en"),
          cellId: deps.cellId,
          ...(relocation === undefined
            ? {}
            : {
                holds: relocation.holds,
                planId: relocation.planId,
                legalName: relocation.legalName,
                country: relocation.country,
              }),
        });
      } catch (error) {
        if (pgErrorCode(error) === "23505")
          throw new PortabilityError(
            "slug_taken",
            `a live workspace already uses the slug ${slug}`,
          );
        if (pgErrorCode(error) === "23503" && deps.cellId !== undefined)
          throw new PortabilityError(
            "incompatible",
            `the cell ${deps.cellId} (CELL_ID) or the carried plan is not registered in this database`,
          );
        throw error;
      }
      if (logoSha !== undefined) {
        const branding = isObject(settings["branding"]) ? settings["branding"] : undefined;
        const logo = branding && isObject(branding["logo"]) ? branding["logo"] : undefined;
        if (branding && logo) {
          const sha = logoSha;
          const key = brandingLogoKey(workspaceId, sha);
          await putPlain(
            key,
            sha,
            typeof logo["contentType"] === "string" ? logo["contentType"] : undefined,
          );
          branding["logo"] = { ...logo, key };
          await updateWorkspaceSettings(tx, workspaceId, settings);
        }
      }

      const userByEmail = new Map<string, string>();
      const userByMembership = new Map<string, string>();
      const resolveEmail = async (identity: Identity): Promise<string> => {
        const known = userByEmail.get(identity.email);
        if (known !== undefined) return known;
        let userId = await findUserIdByEmail(tx, identity.email);
        if (userId === undefined) {
          userId = uuidv7();
          await createUserWithEmail(tx, { id: userId, ...identity });
        }
        userByEmail.set(identity.email, userId);
        return userId;
      };
      for (const [membershipId, identity] of identities) {
        if (identity === null) {
          const tomb = uuidv7();
          await createTombstoneUser(tx, tomb);
          userByMembership.set(membershipId, tomb);
        } else {
          userByMembership.set(membershipId, await resolveEmail(identity));
        }
      }
      const ownerUserId =
        ownerEmail === undefined
          ? undefined
          : await resolveEmail({ email: ownerEmail, displayName: "" });

      // 4b. tenant phase, same transaction
      await enterSystemContext(tx, workspaceId);
      await prepareImportSession(tx);

      // Verbatim uuids that name a row of ANOTHER workspace on this instance: cleared (or, in a
      // NOT NULL column, the import is refused) — a crafted file must not point the copy at a
      // victim's folders, memberships or groups. See README "Import refusal rules".
      const foreign = new Map<string, string>();
      let hits: Awaited<ReturnType<typeof findForeignReferences>>;
      try {
        hits = await findForeignReferences(tx, workspaceId, sourceWs, verbatimUuids);
      } catch (error) {
        if (pgErrorCode(error) === "42501")
          throw new PortabilityError(
            "incompatible",
            "the import cannot check cross-workspace references: the database role that owns the schema is subject to row-level security (make it superuser or BYPASSRLS, as the migration runner expects)",
          );
        throw error;
      }
      for (const h of hits) if (!(signedHere && h.inSource)) foreign.set(h.id, h.table);
      let clearedReferences = 0;
      if (foreign.size > 0) {
        const scrubbed = scrubForeign(settings, foreign);
        if (scrubbed.cleared > 0) {
          clearedReferences += scrubbed.cleared;
          await updateWorkspaceSettings(tx, workspaceId, scrubbed.value as JsonObject);
        }
      }
      const unsafe = (message: string): PortabilityError =>
        new PortabilityError("unsafe_reference", message);
      const inserted = new Set<string>();
      const pendingTables = new Set(tables.map((p) => p.name));
      const deferred: {
        table: TableInfo;
        column: string;
        type: string;
        pairs: { id: string; value: string }[];
      }[] = [];
      const objectDescriptors = new Map<string, SheDescriptor | null>();
      const moduleStarted = new Set<string>();
      const manifestRows = new Map(manifest.tables.map((t) => [t.name, t.rows]));

      async function putPlain(key: string, sha: string, contentType: string | undefined) {
        const entry = zip.entry(blobEntryName(sha));
        if (entry === undefined)
          throw new PortabilityError("invalid_input", `blob ${sha} is missing`);
        await deps.storage.put(key, ReadableStream.from(zip.read(entry)), {
          contentLength: entry.size,
          sha256: sha,
          ...(contentType === undefined ? {} : { contentType }),
        });
        uploaded.push(key);
      }

      async function putEncrypted(
        key: string,
        sha: string,
        purpose: string,
      ): Promise<SheDescriptor> {
        const entry = zip.entry(blobEntryName(sha));
        if (entry === undefined)
          throw new PortabilityError("invalid_input", `blob ${sha} is missing`);
        const dek = await deps.envelope.currentKey(tx, ctx, purpose);
        await deps.storage.put(key, encryptStream(dek.key, ReadableStream.from(zip.read(entry))), {
          contentType: "application/octet-stream",
          contentLength: ciphertextLength(entry.size),
          metadata: { "sh-format": "she1" },
        });
        uploaded.push(key);
        return { format: "she1", keyId: dek.keyId, keyRef: dek.keyRef };
      }

      /**
       * Blob columns, by the engine only: the JSONL value must be `blob:<sha256>` (or null — no
       * file), agree with `$blobs` and the row's own sha256 column, and the stored key is the
       * source key remapped, checked to name only the new workspace and this import's rows.
       * Returns the key each column got (null when none), which `importRow` may not change.
       */
      const importBlobs = async (
        p: PlannedTable,
        row: JsonObject,
        meta: unknown,
      ): Promise<Map<string, string | null>> => {
        const assigned = new Map<string, string | null>();
        for (const b of p.spec.blobs ?? []) {
          const value = row[b.keyColumn];
          if (value === null || value === undefined) {
            assigned.set(b.keyColumn, null);
            continue;
          }
          const match = typeof value === "string" ? BLOB_VALUE_RE.exec(value) : null;
          if (match === null)
            throw unsafe(
              `${p.name}.${b.keyColumn}: an imported object key must be "blob:<sha256>" or null, not ${JSON.stringify(String(value).slice(0, 120))}; the importer writes object keys itself`,
            );
          const sha = match[1] as string;
          const m = isObject(meta) ? meta[b.keyColumn] : undefined;
          if (!isObject(m) || m["sha256"] !== sha || typeof m["key"] !== "string")
            throw new PortabilityError(
              "invalid_input",
              `${p.name}: ${b.keyColumn} lacks a $blobs entry for blob ${sha}`,
            );
          if (b.sha256Column !== undefined) {
            const declared = row[b.sha256Column];
            const hex =
              byteaHex(declared) ??
              (typeof declared === "string" && /^[0-9a-f]{64}$/iu.test(declared)
                ? declared.toLowerCase()
                : undefined);
            if (hex !== sha)
              throw unsafe(
                `${p.name}.${b.sha256Column} does not match the blob its ${b.keyColumn} carries (${sha})`,
              );
          }
          const newKey = ictx.remapKey(m["key"]);
          const why = checkImportedKey(newKey, workspaceId, ids.isNewId);
          if (why !== null)
            throw unsafe(
              `${p.name}.${b.keyColumn}: the object key ${JSON.stringify(newKey.slice(0, 200))} ${why}`,
            );
          let descriptor = objectDescriptors.get(newKey);
          if (descriptor === undefined) {
            if (b.encryptionColumn !== undefined) {
              descriptor = await putEncrypted(newKey, sha, b.purpose ?? "workspace-dek");
            } else {
              await putPlain(newKey, sha, undefined);
              descriptor = null;
            }
            objectDescriptors.set(newKey, descriptor);
          }
          row[b.keyColumn] = newKey;
          assigned.set(b.keyColumn, newKey);
          if (b.encryptionColumn !== undefined)
            row[b.encryptionColumn] = descriptor as unknown as JsonValue;
        }
        return assigned;
      };

      /** After `importRow`: the engine's keys stand; a null one may become a placeholder here. */
      const checkKeysAfterImportRow = (
        p: PlannedTable,
        row: JsonObject,
        assigned: ReadonlyMap<string, string | null>,
      ): void => {
        for (const [column, engineValue] of assigned) {
          const after = row[column] ?? null;
          if (after === engineValue) continue;
          if (
            engineValue === null &&
            typeof after === "string" &&
            after.startsWith(`ws/${workspaceId}/`) &&
            checkImportedKey(after, workspaceId, ids.isNewId) === null
          )
            continue;
          throw unsafe(
            `${p.name}.${column}: the table's importRow changed the object key the importer wrote`,
          );
        }
      };

      /** Clears foreign uuids from a row; a NOT NULL column holding one refuses the import. */
      const scrubRow = (
        p: PlannedTable,
        row: JsonObject,
        skip: ReadonlySet<string>,
        notNull: (column: string) => boolean,
      ): void => {
        if (foreign.size === 0) return;
        for (const [k, v] of Object.entries(row)) {
          if (skip.has(k) || v === null || v === undefined) continue;
          if (typeof v === "string") {
            const table = foreign.get(v.toLowerCase());
            if (table === undefined) continue;
            if (notNull(k))
              throw unsafe(
                `${p.name}.${k} names ${v}, a row of ${table} in another workspace on this instance`,
              );
            row[k] = null;
            clearedReferences += 1;
            continue;
          }
          const scrubbed = scrubForeign(v as JsonValue, foreign);
          if (scrubbed.cleared > 0) {
            row[k] = scrubbed.value;
            clearedReferences += scrubbed.cleared;
          }
        }
      };

      const importCertificate = async (row: JsonObject, cert: unknown) => {
        if (!isObject(cert)) {
          // No carried certificate: a `cert:` reference would name an object the import never wrote.
          if (typeof row["evidence_ref"] === "string" && row["evidence_ref"].startsWith("cert:"))
            row["evidence_ref"] = null;
          return;
        }
        if (!isUuid(cert["certificateId"]))
          throw unsafe("core.attestation: a certificate id is not a uuid");
        const certificateId = cert["certificateId"].toLowerCase();
        let keyId: string | undefined;
        for (const form of ["json", "pdf"] as const) {
          const sha = cert[form];
          if (typeof sha !== "string") return;
          const d = await putEncrypted(
            certificateKey(workspaceId, certificateId, form),
            sha,
            "workspace-dek",
          );
          keyId = d.keyId;
        }
        if (keyId !== undefined) row["evidence_ref"] = `cert:v1:${certificateId}:she1:${keyId}`;
      };

      let suppressionKey: { keyId: string; key: Uint8Array } | undefined;

      for (const p of tables) {
        if (p.kernel?.special === "workspace") {
          counts[p.name] = 1;
          pendingTables.delete(p.name);
          continue;
        }
        const module =
          p.owner === KERNEL_OWNER ? undefined : deps.modules.find((m) => m.id === p.owner);
        if (module?.portability?.beforeImport && !moduleStarted.has(module.id)) {
          const rows: Record<string, number> = {};
          for (const t of module.portability.tables)
            rows[t.table] = manifestRows.get(`${p.schema}.${t.table}`) ?? 0;
          await module.portability.beforeImport({ tx, ctx, services: deps.moduleServices, rows });
        }
        if (module) moduleStarted.add(module.id);

        const info = await describeTable(tx, p.schema, p.table);
        const insertable = new Map(
          info.columns.filter((c) => !c.generated).map((c) => [c.name, c]),
        );
        const allColumns = new Set(info.columns.map((c) => c.name));
        const overriding = info.columns.some((c) => c.identityAlways);
        const deferrals = info.foreignKeys.filter(
          (fk) => !fk.deferrable && pendingTables.has(`${fk.refSchema}.${fk.refTable}`),
        );
        const deferredHere = new Map<string, { id: string; value: string }[]>();
        /*
         * A self-reference (a folder's parent, a delegate's principal) is not deferred while its
         * target may still come: rows arrive in primary-key order, and a real workspace can hold a
         * child whose id sorts before its parent's (random or clock-skewed ids, an earlier import).
         * Nulling the column and patching it afterwards would break any CHECK that ties the column
         * to the row's shape (`folder_root_shape`), so such a row waits until its parent has been
         * batched — one multi-row INSERT checks its foreign keys at the end of the statement — and
         * only a row whose parent never arrives falls back to the deferred update.
         */
        const selfRefs = deferrals.filter(
          (fk) => fk.refSchema === p.schema && fk.refTable === p.table,
        );
        const waiting = new Map<string, JsonObject[]>();
        const missingParent = (row: JsonObject): string | undefined => {
          for (const fk of selfRefs) {
            const v = row[fk.column];
            if (typeof v === "string" && v !== row["id"] && !inserted.has(v)) return v;
          }
          return undefined;
        };
        // Values the engine wrote (or evidence kept verbatim): never scrubbed.
        const engineColumns = new Set<string>([
          "id",
          "workspace_id",
          ...(p.kernel?.verbatimColumns ?? []),
          ...(p.kernel?.special === "membership" ? ["user_id"] : []),
          ...(p.spec.blobs ?? []).flatMap((b) =>
            b.encryptionColumn === undefined ? [b.keyColumn] : [b.keyColumn, b.encryptionColumn],
          ),
        ]);
        let batch: JsonObject[] = [];
        let batchKeys = "";
        let batchBytes = 0;
        let n = 0;
        const flush = async () => {
          if (batch.length === 0) return;
          await insertRows(tx, p.schema, p.table, batchKeys.split(","), batch, overriding);
          batch = [];
          batchBytes = 0;
        };

        const batchRow = async (row: JsonObject): Promise<void> => {
          for (const fk of deferrals) {
            const v = row[fk.column];
            if (typeof v !== "string" || inserted.has(v)) continue;
            const col = insertable.get(fk.column);
            if (col?.notNull || typeof row["id"] !== "string")
              throw new PortabilityError(
                "incompatible",
                `${p.name}.${fk.column} references a row inserted later and cannot be deferred`,
              );
            let pairs = deferredHere.get(fk.column);
            if (pairs === undefined) {
              pairs = [];
              deferredHere.set(fk.column, pairs);
            }
            pairs.push({ id: row["id"], value: v });
            row[fk.column] = null;
          }
          if (typeof row["id"] === "string") inserted.add(row["id"]);
          const keys = Object.keys(row).sort().join(",");
          const text = JSON.stringify(row);
          if (
            keys !== batchKeys ||
            batch.length >= BATCH_ROWS ||
            batchBytes + text.length > BATCH_BYTES
          ) {
            await flush();
            batchKeys = keys;
          }
          batch.push(row);
          batchBytes += text.length;
          n += 1;
        };

        /** Batches one row, then every row that was waiting for it as its parent. */
        const emit = async (first: JsonObject, orphan = false): Promise<void> => {
          const queue: JsonObject[] = [first];
          for (let row = queue.shift(); row !== undefined; row = queue.shift()) {
            if (!orphan) {
              const parent = missingParent(row);
              if (parent !== undefined) {
                const list = waiting.get(parent);
                if (list === undefined) waiting.set(parent, [row]);
                else list.push(row);
                continue;
              }
            }
            await batchRow(row);
            const id = row["id"];
            if (typeof id !== "string") continue;
            const children = waiting.get(id);
            if (children !== undefined) {
              waiting.delete(id);
              queue.push(...children);
            }
          }
        };

        if (p.kernel?.special === "mail_suppression") {
          for await (const raw of rowsOf(zip, tableEntryName(p.schema, p.table))) {
            const row = ids.deepRemap(raw) as JsonObject;
            if (typeof row["address"] !== "string" || typeof row["id"] !== "string") continue;
            suppressionKey ??= await deps.envelope.currentKey(tx, ctx, SUPPRESSION_KEY_PURPOSE);
            await insertSuppression(tx, {
              workspaceId,
              id: row["id"],
              addressHash: suppressionHash(suppressionKey.key, row["address"]),
              keyId: suppressionKey.keyId,
              addressMasked:
                typeof row["address_masked"] === "string"
                  ? row["address_masked"]
                  : maskAddress(row["address"]),
              reason: String(row["reason"] ?? "manual"),
              createdAt: String(row["created_at"] ?? now.toISOString()),
              createdBy:
                typeof row["created_by"] === "string" &&
                !foreign.has(row["created_by"].toLowerCase())
                  ? row["created_by"]
                  : null,
            });
            n += 1;
          }
          counts[p.name] = n;
          pendingTables.delete(p.name);
          continue;
        }

        for await (const raw of rowsOf(zip, tableEntryName(p.schema, p.table))) {
          const blobMeta = raw["$blobs"];
          const cert = raw["$certificate"];
          const sourceId = typeof raw["id"] === "string" ? raw["id"].toLowerCase() : undefined;
          const verbatim: JsonObject = {};
          for (const c of p.kernel?.verbatimColumns ?? []) {
            if (c in raw) verbatim[c] = raw[c] as JsonValue;
          }
          const source: JsonObject = {};
          for (const [k, v] of Object.entries(raw)) {
            if (k.startsWith("$") || k in verbatim) continue;
            source[k] = v as JsonValue;
          }
          let row = ids.deepRemap(source) as JsonObject;
          Object.assign(row, verbatim);
          if (allColumns.has("workspace_id")) row["workspace_id"] = workspaceId;
          if (p.kernel?.special === "membership") {
            const userId = sourceId === undefined ? undefined : userByMembership.get(sourceId);
            if (userId === undefined)
              throw new PortabilityError("invalid_input", "a membership row has no identity");
            row["user_id"] = userId;
          }
          if (p.kernel?.special === "attestation") await importCertificate(row, cert);
          const assigned = await importBlobs(p, row, blobMeta);
          const spec: PortableTable = p.spec;
          if (spec.importRow) {
            const r = spec.importRow(row, ictx);
            if (r === null) continue;
            row = r;
          }
          checkKeysAfterImportRow(p, row, assigned);
          scrubRow(p, row, engineColumns, (c) => insertable.get(c)?.notNull === true);
          for (const key of Object.keys(row)) {
            if (!insertable.has(key)) {
              if (allColumns.has(key)) {
                delete row[key]; // generated: recomputed here
                continue;
              }
              throw new PortabilityError(
                "incompatible",
                `${p.name}: column ${key} does not exist on this instance`,
              );
            }
          }
          await emit(row);
        }
        // Rows whose parent never arrived (absent from the export, or a cycle): deferred as before.
        for (const list of waiting.values()) {
          for (const row of list) await emit(row, true);
        }
        waiting.clear();
        await flush();
        for (const [column, pairs] of deferredHere) {
          const col = insertable.get(column);
          deferred.push({ table: info, column, type: col?.type ?? "uuid", pairs });
        }
        counts[p.name] = n;
        pendingTables.delete(p.name);
      }

      for (const d of deferred) {
        await applyDeferred(tx, d.table.schema, d.table.table, d.column, d.type, d.pairs);
      }

      // Foreign keys, generically: no imported row may reference a workspace-scoped parent row
      // outside the new workspace (FK checks bypass RLS, so the database alone would allow it).
      const importedTables = new Set(
        Object.entries(counts)
          .filter(([, n]) => n > 0)
          .map(([name]) => name),
      );
      const crossing = await findCrossWorkspaceForeignKey(tx, workspaceId, importedTables);
      if (crossing !== undefined)
        throw unsafe(
          `${crossing.child} references a ${crossing.parent} row outside the new workspace (constraint ${crossing.constraint})`,
        );
      if (clearedReferences > 0)
        warnings.push(
          `${clearedReferences} reference(s) to rows of other workspaces on this instance were cleared (see the portability README, "Import refusal rules")`,
        );

      // E3.5 fix A16: no e-sign connection travels, so no document may demand an e-signature.
      const reset = await resetEsignCeremonies(tx, workspaceId);
      if (reset.length > 0)
        warnings.push(
          `${reset.length} legal document(s) used the e-signature ceremony (${reset.join(", ")}); no e-signature connection is imported, so they were reset to click-wrap — reconnect a provider and switch them back`,
        );

      // --owner-email: a live staff owner for that address, promoted or created.
      if (ownerUserId !== undefined) {
        const existing = await liveMembershipOf(tx, workspaceId, ownerUserId);
        if (existing) await makeOwner(tx, existing.id);
        else await insertOwnerMembership(tx, { id: uuidv7(), workspaceId, userId: ownerUserId });
      }
      if ((await countLiveOwners(tx, workspaceId, now)) === 0)
        warnings.push(
          "the imported workspace has no live owner; re-run with --owner-email or add one",
        );

      // re-derivation
      warnings.push(...(await rederiveAccess(deps, tx, ctx)));
      for (const m of deps.modules) {
        if (m.portability?.afterImport) {
          try {
            await m.portability.afterImport({ tx, ctx, services: deps.moduleServices });
          } catch (error) {
            if (error instanceof PortableImportRefusal)
              throw new PortabilityError("invalid_input", `${m.id}: ${error.message}`);
            throw error;
          }
        }
      }
      for (const m of deps.modules) {
        if (m.search !== undefined) await deps.moduleServices.search.requestReindex(tx, ctx, m.id);
      }

      // the source audit trail, archived as evidence
      let archiveKey: string | null = null;
      let archiveEnc: SheDescriptor | null = null;
      const archive = await ZipFileWriter.create(archivePath, now);
      try {
        for (const name of [
          ENTRY.manifest,
          ENTRY.signature,
          ENTRY.auditEvents,
          ENTRY.auditCheckpoints,
        ]) {
          const entry = zip.entry(name);
          if (entry) await archive.add(name, zip.read(entry), { deflate: name.endsWith("jsonl") });
        }
        const { size } = await archive.finish();
        archiveKey = `ws/${workspaceId}/imports/${importId}/audit.zip`;
        const dek = await deps.envelope.currentKey(tx, ctx, IMPORT_ARCHIVE_PURPOSE);
        await deps.storage.put(
          archiveKey,
          encryptStream(
            dek.key,
            ReadableStream.from(createReadStream(archivePath) as AsyncIterable<Uint8Array>),
          ),
          {
            contentType: "application/octet-stream",
            contentLength: ciphertextLength(size),
            metadata: { "sh-format": "she1" },
          },
        );
        uploaded.push(archiveKey);
        archiveEnc = { format: "she1", keyId: dek.keyId, keyRef: dek.keyRef };
      } finally {
        await archive.abort();
      }

      const signature = verification.trusted === true ? "trusted" : "unverified";
      const source: JsonObject = {
        workspaceId: sourceWs,
        slug: manifest.source.slug,
        exportedAt: manifest.exportedAt,
        instanceVersion: manifest.source.instanceVersion,
        manifestSha256: await manifestDigest(zip),
        signature,
        keyId: manifest.signature.keyId,
        auditHeadHash: manifest.audit.headHash,
        auditHeadSeq: manifest.audit.headSeq,
        ...(relocation === undefined ? {} : { moveId: relocation.moveId }),
      };
      await insertWorkspaceImport(tx, {
        id: importId,
        workspaceId,
        source,
        counts,
        auditArchiveKey: archiveKey,
        auditArchiveEncryption: archiveEnc as unknown as JsonObject | null,
        importedBy: input.importedBy.slice(0, 200),
      });
      await deps.audit.record(tx, ctx, {
        action: "workspace.imported",
        resourceKind: "workspace_import",
        resourceId: importId,
        actorKind: "system",
        meta: {
          sourceWorkspaceId: sourceWs,
          manifestSha256: source["manifestSha256"] as string,
          sourceAuditHeadHash: manifest.audit.headHash,
          sourceAuditHeadSeq: manifest.audit.headSeq,
          signature,
          keyId: manifest.signature.keyId,
          tables: Object.keys(counts).length,
          rows: Object.values(counts).reduce((a, b) => a + b, 0),
          objects: uploaded.length,
        },
      });
      if (relocation?.beforeCommit !== undefined) {
        await enterSystemContext(tx, workspaceId);
        await relocation.beforeCommit(tx, workspaceId);
      }
    });
    if (claimed !== undefined) {
      // Best effort: the directory's reconcile sweep activates an entry whose workspace exists.
      await deps.directory?.activate(claimed).catch((error: unknown) =>
        deps.log?.("portability.directory_activate_failed", {
          level: "warn",
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      claimed = undefined;
    }

    deps.log?.("portability.imported", { workspaceId, importId, objects: uploaded.length });
    return {
      workspaceId,
      importId,
      slug,
      signature: verification.trusted === true ? "trusted" : "unverified",
      counts,
      objects: uploaded.length,
      warnings,
      verification,
    };
  } catch (error) {
    if (uploaded.length > 0) await deps.storage.deleteMany(uploaded).catch(() => undefined);
    if (claimed !== undefined) await deps.directory?.release(claimed).catch(() => undefined);
    throw error;
  } finally {
    await zip.close();
    await rm(archivePath, { force: true });
  }
}

async function manifestDigest(zip: ZipFileReader): Promise<string> {
  const entry = zip.entry(ENTRY.manifest);
  if (entry === undefined) return "";
  return createHash("sha256")
    .update(await zip.readAll(entry))
    .digest("hex");
}

/** What the SOURCE left out (module schemas it did not load): reported, never silent. */
export function omittedImportWarnings(manifest: Pick<ExportManifest, "omitted">): string[] {
  const out: string[] = [];
  for (const o of manifest.omitted ?? []) {
    const known = o.tables.every((t) => t.rows !== null);
    const rows = o.tables.reduce((n, t) => n + (t.rows ?? 0), 0);
    if (known && rows === 0) continue;
    const owner =
      o.module === null
        ? "which no module of the source build owned"
        : `(module ${o.module}, not loaded on the source instance)`;
    out.push(
      `the export omits schema ${o.schema} ${owner}${known ? `: ${rows} row(s)` : ""} — that data is not in the file and was not imported`,
    );
  }
  return out;
}
