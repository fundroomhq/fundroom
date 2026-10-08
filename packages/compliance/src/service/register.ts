/*
 * The acceptance register: who accepted what, when — and the export counsel asks for
 * (design/04 §1.6 "exportable as a signed PDF/CSV bundle for counsel", §7).
 *
 * Two things live here. The **keyset cursor**, which E1.6's as-built note asked for
 * ("the register paginates in memory over a keyset cursor (the repo has no keyset support yet);
 * fine at this scale, worth pushing into the repo when that package is next opened"), and the
 * **serialisers**, which are pure so the bytes a lawyer receives can be tested without a database.
 *
 * The PDF half of "signed PDF/CSV bundle" is deliberately NOT here. A signed bundle needs the
 * audit chain's own signature over it, and that machinery is E2.7's signed audit export. CSV and
 * JSON ship now; the signed bundle is E2.7's and should be built on top of this, not beside it.
 */

/** One row of the acceptance register: who accepted what, when. */
export interface RegisterEntry {
  readonly membershipId: string;
  readonly documentId: string;
  readonly slug: string;
  readonly versionNo: number;
  readonly stamp: string;
  readonly bodySha256: string | null;
  readonly acceptedAt: Date;
  readonly evidenceRef: string | null;
}

export interface RegisterFilter {
  readonly membershipId?: string | undefined;
  readonly documentId?: string | undefined;
  readonly slug?: string | undefined;
}

/**
 * The ordering key, and **every column of the ORDER BY** (E1.5's lesson, learned the hard way).
 *
 * `signed_at` alone is not a key. Two people accept the same version in the same microsecond every
 * time a version is published — the gate reappears for everybody at once and a room full of
 * investors clicks through it in the same second — and `timestamptz` has microsecond resolution,
 * not nanosecond. A cursor carrying only `signed_at` then either skips the second row (`<`) or
 * repeats the first for ever (`<=`). `membership_id` breaks the tie, and `kind` breaks the
 * remaining one: a single membership can accept two documents in one transaction, and the register
 * is keyed on the acceptance, not the acceptor.
 */
export interface RegisterKey {
  readonly signedAt: Date;
  readonly membershipId: string;
  readonly kind: string;
}

/** Newest first, then membership descending, then kind descending — the SQL's order, in code. */
export function compareRegisterKeys(a: RegisterKey, b: RegisterKey): number {
  const byTime = b.signedAt.getTime() - a.signedAt.getTime();
  if (byTime !== 0) return byTime;
  if (a.membershipId !== b.membershipId) return a.membershipId < b.membershipId ? 1 : -1;
  if (a.kind !== b.kind) return a.kind < b.kind ? 1 : -1;
  return 0;
}

export function registerKeyOf(entry: RegisterEntry): RegisterKey {
  return { signedAt: entry.acceptedAt, membershipId: entry.membershipId, kind: entry.stamp };
}

/**
 * The cursor on the wire: base64url of `<iso>|<membership_id>|<kind>`, all three parts, always.
 *
 * The pipe is safe as a separator because a stamp is `<slug>:v<n>` over `[a-z0-9-]` and a
 * membership id is a uuid, so neither can contain one. This is byte-for-byte the format
 * `apps/server/src/routes/compliance.ts` already issues, so cursors a client is holding when this
 * lands keep working — a paginated evidence export that restarts from the top on deploy is a
 * lawyer reading the same page twice and not knowing it.
 */
export function encodeRegisterCursor(key: RegisterKey): string {
  return Buffer.from(
    `${key.signedAt.toISOString()}|${key.membershipId}|${key.kind}`,
    "utf8",
  ).toString("base64url");
}

/**
 * `undefined` for anything that is not a **complete** cursor — never a partially-populated key.
 * A cursor missing its membership or its kind would page on the timestamp alone, which is the
 * E1.5 bug wearing a different hat, so it is refused rather than half-honoured.
 */
export function decodeRegisterCursor(cursor: string): RegisterKey | undefined {
  const parts = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  if (parts.length !== 3) return undefined;
  const [at, membershipId, kind] = parts;
  if (at === undefined || membershipId === undefined || kind === undefined) return undefined;
  if (membershipId === "" || kind === "") return undefined;
  const signedAt = new Date(at);
  if (Number.isNaN(signedAt.getTime())) return undefined;
  return { signedAt, membershipId, kind };
}

export interface RegisterPage {
  readonly entries: readonly RegisterEntry[];
  /** Absent when the page is the last one. Feed it back as `after`. */
  readonly nextCursor: string | undefined;
}

/* ------------------------------------------------------------------ export */

/** The columns, in order. Changing this changes a file somebody's lawyer already has. */
export const REGISTER_COLUMNS = [
  "membership_id",
  "document_id",
  "slug",
  "version_no",
  "stamp",
  "body_sha256",
  "accepted_at",
  "evidence_ref",
] as const;

/*
 * Two escaping jobs, and they are not the same job.
 *
 * RFC 4180 says a field containing a comma, a quote or a line break is wrapped in quotes and its
 * own quotes are doubled. That makes the file *parseable*.
 *
 * It does nothing about the other problem. Excel, LibreOffice and Google Sheets all treat a cell
 * beginning `=`, `+`, `-`, `@` (or a tab or carriage return before one of those) as a formula, so
 * a document slug of `=HYPERLINK("http://evil","click")` — or `@SUM(1+1)*cmd|'/c calc'!A0` —
 * executes when counsel opens the export. The values here are tenant-controlled: slugs, and the
 * `evidence_ref` a storage adapter produced. Prefixing an apostrophe is the fix everybody lands
 * on; it is visible in the cell, which is the point, and it is applied *before* quoting so the
 * apostrophe itself is inside the field.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/u;
const NEEDS_QUOTES = /[",\r\n]/u;

export function csvField(value: string): string {
  const guarded = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

function csvRow(entry: RegisterEntry): string {
  return [
    entry.membershipId,
    entry.documentId,
    entry.slug,
    String(entry.versionNo),
    entry.stamp,
    entry.bodySha256 ?? "",
    entry.acceptedAt.toISOString(),
    entry.evidenceRef ?? "",
  ]
    .map(csvField)
    .join(",");
}

/**
 * RFC 4180 CSV, CRLF-terminated, with a UTF-8 BOM so Excel does not mangle a non-ASCII slug.
 *
 * Rows are re-sorted by the register's own total order before serialising: an export a tenant may
 * hand to a regulator has to come out byte-identical whichever pages it was assembled from.
 */
export function registerCsv(entries: readonly RegisterEntry[]): string {
  const sorted = [...entries].sort((a, b) =>
    compareRegisterKeys(registerKeyOf(a), registerKeyOf(b)),
  );
  const lines = [REGISTER_COLUMNS.join(","), ...sorted.map(csvRow)];
  return `﻿${lines.join("\r\n")}\r\n`;
}

export interface RegisterExportMeta {
  readonly workspaceId: string;
  readonly generatedAt: Date;
  readonly filter?: RegisterFilter | undefined;
}

/**
 * The same register as JSON. Same sort, fixed key order, ISO timestamps — a machine-readable
 * companion to the CSV rather than a different answer to the same question.
 */
export function registerJson(entries: readonly RegisterEntry[], meta: RegisterExportMeta): string {
  const sorted = [...entries].sort((a, b) =>
    compareRegisterKeys(registerKeyOf(a), registerKeyOf(b)),
  );
  return JSON.stringify(
    {
      version: 1,
      workspaceId: meta.workspaceId,
      generatedAt: meta.generatedAt.toISOString(),
      filter: {
        membershipId: meta.filter?.membershipId ?? null,
        documentId: meta.filter?.documentId ?? null,
        slug: meta.filter?.slug ?? null,
      },
      count: sorted.length,
      entries: sorted.map((e) => ({
        membershipId: e.membershipId,
        documentId: e.documentId,
        slug: e.slug,
        versionNo: e.versionNo,
        stamp: e.stamp,
        bodySha256: e.bodySha256,
        acceptedAt: e.acceptedAt.toISOString(),
        evidenceRef: e.evidenceRef,
      })),
    },
    null,
    2,
  );
}
