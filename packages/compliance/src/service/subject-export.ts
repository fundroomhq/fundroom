import { createHash } from "node:crypto";
import { type Database, systemContext } from "@fundroom/db";
import { esignSubjectEnvelopes } from "@fundroom/esign";
import { AccessRequestRepo, AttestationRepo, MembershipRepo } from "@fundroom/identity";
import { integrationSubjectBookings } from "@fundroom/integrations";
import type { ModuleDsar } from "@fundroom/module-kit";
import { strFromU8, strToU8, unzipSync, type Zippable, zipSync } from "fflate";
import { ConsentEventRepo } from "../repos/compliance-repo.js";
import { MAX_SUBJECT_AUDIT_ROWS, SubjectRepo } from "../repos/subject-repo.js";
import { createAcceptanceService } from "./acceptances.js";
import { registerJson } from "./register.js";
import type { ComplianceDeps, TenantContext, Tx } from "./types.js";

/*
 * The subject-access export (E2.7 DSAR, GDPR art. 15 and 20): one zip holding what this
 * workspace keeps about one member.
 *
 *   manifest.json        { version, kind: "seed-host.dsar-export", workspace, subject,
 *                          generatedAt, files: { <name>: sha256 hex }, auditTruncated }
 *   README.txt           what each file is, in plain words, for the person receiving it
 *   profile.json         membership (kind, role, status, profile, relationship facts, dates),
 *                        groups, invites that carried the address, access requests (E3.1),
 *                        identity (email, name), and (E3.8) the SCIM projection and this
 *                        workspace's SSO identities
 *   attestations.json    attestations (NDA, accreditation, acceptances) with their data
 *   consent.json         the consent history (never the ip hash)
 *   acceptances.json     the acceptance register rows for this member (`registerJson`)
 *   sessions.json        this workspace's sessions of the person: device name, ip, user agent,
 *                        sign-in level and times (sessions serving other workspaces are theirs)
 *   share-links.json     share links the person redeemed, and each session counted on one
 *   mail.json            mail sent to them through this workspace (ids, stream, what it was
 *                        about, tracking flags, time — no body is stored, so none is exported)
 *   access.json          grants naming them directly (resource, capability, validity)
 *   requests.json        their own data-subject requests: kind, clock, outcome, export digest
 *   esign.json           e-signature envelopes sent to them (E3.5): what, when, status, and the
 *                        sha256 of the signed copy; never the vendor's ids or credentials
 *   esign/<id>-signed.pdf  the signed copies themselves (binary; the caller adds them through
 *                        `buildSubjectExport({ binaryFiles })` from the e-sign service, which
 *                        holds the storage and keys — this package does not)
 *   integration-bookings.json  meetings they booked through Calendly / Cal.com (E3.6): when,
 *                        status, the address and name they booked with; never vendor credentials
 *   audit.jsonl          audit events where the member is actor, subject or acted-for, one per
 *                        line as `{ seq, canonical, hash }` — see "audit lines" below
 *   modules/<id>.json    one per compiled-in module that declares a `dsar` exporter
 *
 * Audit lines. A line the member wrote themselves (`actor_membership_id` = the subject) is the
 * chain's canonical text verbatim, and re-hashes to `hash`. A line somebody else wrote (staff
 * acting on them, the system) carries facts about *that* person: their user id, session id, ip,
 * user agent and whatever they typed into `meta`/`diff` (a view-as reason, a note). Those are
 * redacted — the fields set to null, staff free text to "[redacted]" — and the line says so
 * (`redacted: [...]`). A redacted line therefore no longer re-hashes; `seq` and `hash` still
 * identify it in the chain, and the verifiable artefact for counsel is the workspace's signed
 * audit export (`POST /audit/exports`), not this file. The membership id of the staff member who
 * acted stays (who in the company handled their data is the subject's to know; a name never is).
 *
 * Deviations, on purpose:
 *  - documents the member uploaded appear as **metadata only** (module exporters return names,
 *    sizes and dates, never bytes): the file bytes can be large, may be malware-scanned
 *    evidence, and are downloaded separately through the data room if the person asks;
 *  - staff working notes about the person (`membership.relationship_note`, grant and request
 *    notes) are the workspace's own notes, not data the person provided, and are left out.
 *
 * The zip is byte-stable for a given `generatedAt` and content (fixed file order, every mtime is
 * `generatedAt`), so the sha256 stamped on the access request identifies exactly what was handed
 * over.
 */

export const DSAR_EXPORT_KIND = "seed-host.dsar-export";
export const DSAR_EXPORT_VERSION = 1;

export interface SubjectExportWorkspace {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface SubjectExportManifest {
  readonly version: typeof DSAR_EXPORT_VERSION;
  readonly kind: typeof DSAR_EXPORT_KIND;
  readonly workspace: SubjectExportWorkspace;
  readonly subject: { readonly membershipId: string };
  readonly generatedAt: string;
  readonly files: Readonly<Record<string, string>>;
  readonly auditTruncated: boolean;
}

export interface SubjectExport {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly manifest: SubjectExportManifest;
}

/** What the kernel itself contributes; `undefined` when the membership does not exist here. */
export interface KernelSubjectFiles {
  readonly files: Readonly<Record<string, string>>;
  readonly auditTruncated: boolean;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
export const sha256OfBytes = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

/** Reads the kernel's files for the export, on the caller's transaction. */
export async function collectKernelFiles(
  deps: Pick<ComplianceDeps, "db" | "audit" | "now">,
  ctx: TenantContext,
  tx: Tx,
  membershipId: string,
  generatedAt: Date,
): Promise<KernelSubjectFiles | undefined> {
  const person = await new MembershipRepo(ctx, tx).person(membershipId);
  if (person === undefined) return undefined;
  const m = person.membership;
  const subject = new SubjectRepo(ctx, tx);
  const invites = await subject.invites(membershipId, person.email);
  const accessRequests = await new AccessRequestRepo(ctx, tx).forSubject(
    membershipId,
    person.email,
  );

  const profile = {
    version: 1,
    membership: {
      id: m.id,
      kind: m.kind,
      role: m.role,
      status: m.status,
      source: m.source,
      profile: m.profile as Json,
      relationshipEstablishedAt: iso(m.relationshipEstablishedAt),
      relationshipSource: m.relationshipSource ?? null,
      expiresAt: iso(m.expiresAt),
      activatedAt: iso(m.activatedAt),
      lastSeenAt: iso(m.lastSeenAt),
      revokedAt: iso(m.revokedAt),
      revokeReason: m.revokeReason ?? null,
      createdAt: iso(m.createdAt),
    },
    identity: { email: person.email, displayName: person.displayName || null },
    groups: person.groups.map((g) => ({ id: g.id, name: g.name })),
    invites: invites.map((i) => ({
      id: i.id,
      email: i.email,
      kind: i.kind,
      role: i.role,
      status: i.status,
      message: i.message,
      createdAt: iso(i.createdAt),
      expiresAt: iso(i.expiresAt),
      acceptedAt: iso(i.acceptedAt),
      revokedAt: iso(i.revokedAt),
    })),
    // E3.1: the public "request access" submissions that became this membership or carried the
    // address. What the person wrote (name, firm, reason) and the outcome; never the code hash or
    // the ip hash, and not the staff decision/relationship notes (the workspace's own notes).
    accessRequests: accessRequests.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      firm: r.firm,
      reason: r.reason,
      status: r.status,
      createdAt: iso(r.createdAt),
      verifiedAt: iso(r.verifiedAt),
      expiresAt: iso(r.expiresAt),
      decidedAt: iso(r.decidedAt),
      autoApproved: r.autoApproved,
      relationshipEstablishedAt: iso(r.relationshipEstablishedAt),
      relationshipSource: r.relationshipSource,
      inviteId: r.inviteId,
    })),
    // E3.8: what the workspace's identity provider pushed about the person over SCIM, and the
    // single-sign-on identities linked through this workspace's connection(s).
    scim: (await subject.scimUsers(membershipId, m.userId)).map((u) => ({
      id: u.id,
      userName: u.userName,
      email: u.email,
      displayName: u.displayName,
      givenName: u.givenName,
      familyName: u.familyName,
      externalId: u.externalId,
      active: u.active,
      createdAt: iso(u.createdAt),
      updatedAt: iso(u.updatedAt),
      deletedAt: iso(u.deletedAt),
    })),
    ssoIdentities: (await subject.ssoIdentities(m.userId)).map((i) => {
      const bar = i.identifier.indexOf("|");
      return {
        protocol: i.type,
        connectionId: i.identifier.slice(0, bar),
        subject: i.identifier.slice(bar + 1),
        verifiedAt: iso(i.verifiedAt),
        createdAt: iso(i.createdAt),
      };
    }),
  };

  const attestations = (await new AttestationRepo(ctx, tx).listFor(membershipId))
    .sort((a, b) => a.signedAt.getTime() - b.signedAt.getTime() || a.id.localeCompare(b.id))
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      signedAt: iso(a.signedAt),
      expiresAt: iso(a.expiresAt),
      revokedAt: iso(a.revokedAt),
      data: a.data as Json,
      // A pointer into object storage, not a fact: the certificate itself has its own route.
      hasCertificate: a.evidenceRef !== null,
    }));

  const consent = (await new ConsentEventRepo(ctx, tx).listFor(membershipId)).map((e) => ({
    id: e.id,
    purpose: e.purpose,
    granted: e.granted,
    source: e.source,
    noticeDocumentId: e.noticeDocumentId ?? null,
    noticeVersionNo: e.noticeVersionNo ?? null,
    uaFamily: e.uaFamily ?? null,
    recordedAt: iso(e.recordedAt),
  }));

  const register = await createAcceptanceService({ db: deps.db, audit: deps.audit }).register(
    ctx,
    tx,
    { membershipId },
  );

  const sessions = (await subject.sessions(m.userId)).map((x) => ({
    id: x.id,
    deviceName: x.deviceName ?? null,
    ip: x.ip ?? null,
    userAgent: x.userAgent === "" ? null : x.userAgent,
    authLevel: x.authLevel,
    createdAt: iso(x.createdAt),
    lastSeenAt: iso(x.lastSeenAt),
    expiresAt: iso(x.absoluteExpiresAt),
    revokedAt: iso(x.revokedAt),
    revokedReason: x.revokedReason ?? null,
  }));
  const links = await subject.shareLinks(membershipId);
  const shareLinks = {
    version: 1,
    visits: links.visits.map((v) => ({
      linkId: v.linkId,
      firstSeenAt: iso(v.firstSeenAt),
      lastSeenAt: iso(v.lastSeenAt),
      views: v.views,
      passcodeOkAt: iso(v.passcodeOkAt),
      revokedAt: iso(v.revokedAt),
    })),
    views: links.views.map((v) => ({
      linkId: v.linkId,
      sessionId: v.sessionId,
      firstSeenAt: iso(v.firstSeenAt),
    })),
  };
  const mail = (await subject.mail(membershipId)).map((x) => ({
    id: x.id,
    provider: x.provider,
    stream: x.stream,
    refKind: x.refKind ?? null,
    refId: x.refId ?? null,
    trackingOpens: x.trackingOpens,
    trackingClicks: x.trackingClicks,
    sentAt: iso(x.sentAt),
  }));
  const grants = (await subject.directGrants(membershipId)).map((g) => ({
    id: g.id,
    resourceKind: g.resourceKind,
    resourceId: g.resourceId,
    capability: g.capability,
    effect: g.effect,
    validFrom: g.validFrom === null ? null : new Date(g.validFrom).toISOString(),
    validUntil: g.validUntil === null ? null : new Date(g.validUntil).toISOString(),
    maxViews: g.maxViews ?? null,
    createdAt: iso(g.createdAt),
    revokedAt: iso(g.revokedAt),
  }));
  const requests = (await subject.dataRequests(membershipId)).map((r) => ({
    id: r.id,
    kind: r.kind,
    status: r.status,
    requestedAt: iso(r.requestedAt),
    dueAt: iso(r.dueAt),
    completedAt: iso(r.completedAt),
    cancelledAt: iso(r.cancelledAt),
    exportSha256: r.exportSha256 ?? null,
  }));

  const esign = (await esignSubjectEnvelopes(tx, ctx, membershipId)) as Json[];
  const bookings = (await integrationSubjectBookings(tx, ctx, membershipId)) as Json[];

  const audit = await subject.auditRows(membershipId);
  const auditTruncated = audit.length > MAX_SUBJECT_AUDIT_ROWS;
  const auditLines = audit
    .slice(0, MAX_SUBJECT_AUDIT_ROWS)
    .map((r) => `${JSON.stringify(subjectAuditLine(r, membershipId))}\n`)
    .join("");

  return {
    files: {
      "profile.json": pretty(profile),
      "attestations.json": pretty({ version: 1, attestations }),
      "consent.json": pretty({ version: 1, events: consent }),
      "acceptances.json": `${registerJson(register, {
        workspaceId: ctx.workspaceId,
        generatedAt,
        filter: { membershipId },
      })}\n`,
      "sessions.json": pretty({ version: 1, sessions }),
      "share-links.json": pretty(shareLinks),
      "mail.json": pretty({ version: 1, messages: mail }),
      "access.json": pretty({ version: 1, grants }),
      "requests.json": pretty({ version: 1, requests }),
      "esign.json": pretty({ version: 1, envelopes: esign }),
      "integration-bookings.json": pretty({ version: 1, bookings }),
      "audit.jsonl": auditLines,
    },
    auditTruncated,
  };
}

/** Fields of an audit row that describe whoever acted, not the subject. */
const ACTOR_FIELDS = ["actor_user_id", "session_id", "ip", "user_agent"] as const;
/** `meta`/`diff` keys whose string values are text somebody typed (a reason, a note …). */
const FREE_TEXT_KEY =
  /^(reason|note|notes|message|comment|body|text|summary|description|title|relationship_?note|relationshipNote)$/iu;
export const REDACTED_TEXT = "[redacted]";

function redactFreeText(value: unknown, path: string, hits: string[]): unknown {
  if (Array.isArray(value)) return value.map((v, i) => redactFreeText(v, `${path}[${i}]`, hits));
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (FREE_TEXT_KEY.test(k) && typeof v === "string") {
      out[k] = REDACTED_TEXT;
      hits.push(`${path}.${k}`);
    } else if (FREE_TEXT_KEY.test(k) && v !== null && typeof v === "object") {
      // A diff entry `{ note: { from, to } }`: both sides are typed text.
      out[k] = REDACTED_TEXT;
      hits.push(`${path}.${k}`);
    } else {
      out[k] = redactFreeText(v, `${path}.${k}`, hits);
    }
  }
  return out;
}

export interface SubjectAuditLine {
  readonly seq: number;
  readonly canonical: string;
  readonly hash: string;
  /** Present when the line was written by somebody else and their facts were removed. */
  readonly redacted?: readonly string[];
}

/**
 * One `audit.jsonl` line. Verbatim when the subject acted; otherwise the other actor's user id,
 * session, ip and user agent are nulled and typed free text in `meta`/`diff` is replaced, and
 * the line lists what was removed (it no longer re-hashes — see the header).
 */
export function subjectAuditLine(
  row: { readonly seq: number; readonly canonical: string; readonly hash: string },
  subjectMembershipId: string,
): SubjectAuditLine {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(row.canonical) as Record<string, unknown>;
  } catch {
    // Not expected (the chain's canonical text is JSON); never leak what cannot be inspected.
    return { seq: row.seq, canonical: "{}", hash: row.hash, redacted: ["*"] };
  }
  if (parsed["actor_membership_id"] === subjectMembershipId) {
    return { seq: row.seq, canonical: row.canonical, hash: row.hash };
  }
  const hits: string[] = [];
  for (const f of ACTOR_FIELDS) {
    if (parsed[f] !== null && parsed[f] !== undefined) {
      parsed[f] = null;
      hits.push(f);
    }
  }
  for (const f of ["meta", "diff"] as const) {
    if (parsed[f] !== null && parsed[f] !== undefined)
      parsed[f] = redactFreeText(parsed[f], f, hits);
  }
  if (hits.length === 0) return { seq: row.seq, canonical: row.canonical, hash: row.hash };
  return { seq: row.seq, canonical: JSON.stringify(parsed), hash: row.hash, redacted: hits };
}

type JsonObject = Awaited<ReturnType<ModuleDsar["export"]>>;

export interface DsarExporter {
  readonly id: string;
  readonly dsar?: ModuleDsar | undefined;
}

/**
 * Runs every module exporter, **sequentially**, each in its own `system` transaction of the
 * workspace — never nested inside another transaction, so the export holds at most one pool
 * connection at a time. Enablement is ignored on purpose (as erasure ignores it): a module
 * switched off today still holds what it wrote while it was on. A failing exporter fails the
 * whole export — an access answer that silently lacks a module is worse than none.
 *
 * Order: by id, except that a module runs after the modules it names in `dsar.after`, whose
 * exports it is handed as `related` (a cycle falls back to id order for the modules in it).
 */
export async function collectModuleFiles(
  db: Pick<Database, "withTenant">,
  workspaceId: string,
  membershipId: string,
  modules: readonly DsarExporter[],
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const exported = new Map<string, JsonObject>();
  const ctx = systemContext(workspaceId);
  for (const m of dsarOrder(modules)) {
    const exporter = m.dsar;
    if (exporter === undefined) continue;
    const related: Record<string, JsonObject> = {};
    for (const id of exporter.after ?? []) {
      const data = exported.get(id);
      if (data !== undefined) related[id] = data;
    }
    const data = await db.withTenant(ctx, (tx) =>
      exporter.export({ tx, ctx, membershipId, related }),
    );
    exported.set(m.id, data);
    out[`modules/${m.id}.json`] = pretty(data);
  }
  return out;
}

/** Id order, with every module after the exporters it names in `dsar.after`. */
export function dsarOrder(modules: readonly DsarExporter[]): DsarExporter[] {
  const pending = [...modules]
    .filter((m) => m.dsar !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
  const present = new Set(pending.map((m) => m.id));
  const done = new Set<string>();
  const order: DsarExporter[] = [];
  while (pending.length > 0) {
    const i = pending.findIndex((m) =>
      (m.dsar?.after ?? []).every((d) => done.has(d) || !present.has(d)),
    );
    const [next] = pending.splice(i < 0 ? 0 : i, 1);
    if (next === undefined) break;
    order.push(next);
    done.add(next.id);
  }
  return order;
}

function readme(manifest: Omit<SubjectExportManifest, "files">, names: readonly string[]): string {
  const modules = names.filter((n) => n.startsWith("modules/"));
  return [
    `Personal data export — ${manifest.workspace.name}`,
    "",
    `Generated ${manifest.generatedAt} for membership ${manifest.subject.membershipId}.`,
    "This archive answers a data-subject access request. It holds what this workspace keeps about",
    "you, as JSON files anyone can open in a text editor.",
    "",
    "  profile.json       your membership, groups, invitations, access requests, sign-in identity,",
    "                     and what your organisation's identity provider sent about you (SSO, SCIM)",
    "  attestations.json  what you attested to (NDAs, accreditation, acceptances)",
    "  consent.json       every consent decision you (or your browser's privacy signal) made",
    "  acceptances.json   the documents you accepted, with the exact version and its digest",
    "  sessions.json      your sign-ins here: device, ip address, browser and times",
    "  share-links.json   share links you opened, and when",
    "  mail.json          emails sent to you from here (what they were about and when)",
    "  access.json        access granted to you personally",
    "  requests.json      your data requests (like this one) and how they were answered",
    "  esign.json         documents sent to you for electronic signature, and their status",
    ...(names.some((n) => n.startsWith("esign/"))
      ? ["  esign/*.pdf        the copies of those documents you signed"]
      : []),
    ...(names.includes("integration-bookings.json")
      ? ["  integration-bookings.json  meetings you booked through the scheduling links here"]
      : []),
    "  audit.jsonl        security log entries in which you acted or were acted on, one per line,",
    "                     each with its position and hash in the tamper-evident chain; entries",
    "                     written by someone else have that person's details removed",
    ...modules.map((n) => `  ${n.padEnd(19)}what the ${n.slice(8, -5)} feature holds about you`),
    "  manifest.json      the sha256 of every file above, so nothing can be altered unnoticed",
    "",
    "Documents you uploaded are listed by name, size and date; their contents are not included",
    "here and can be requested separately.",
    ...(manifest.auditTruncated
      ? ["", `The audit log was cut at ${MAX_SUBJECT_AUDIT_ROWS} entries; ask for the rest.`]
      : []),
    "",
  ].join("\n");
}

/** Builds the zip. Pure: same inputs and `generatedAt`, same bytes. */
export function buildSubjectExport(input: {
  readonly workspace: SubjectExportWorkspace;
  readonly membershipId: string;
  readonly generatedAt: Date;
  readonly files: Readonly<Record<string, string>>;
  /** Binary entries (the signed e-sign PDFs, E3.5); listed in the manifest like the rest. */
  readonly binaryFiles?: Readonly<Record<string, Uint8Array>> | undefined;
  readonly auditTruncated?: boolean | undefined;
}): SubjectExport {
  const base = {
    version: DSAR_EXPORT_VERSION,
    kind: DSAR_EXPORT_KIND,
    workspace: { id: input.workspace.id, slug: input.workspace.slug, name: input.workspace.name },
    subject: { membershipId: input.membershipId },
    generatedAt: input.generatedAt.toISOString(),
    auditTruncated: input.auditTruncated ?? false,
  } as const;
  const binary = input.binaryFiles ?? {};
  const names = [...Object.keys(input.files), ...Object.keys(binary)].sort();
  const contents: Record<string, Uint8Array> = {};
  for (const [name, text] of Object.entries(input.files)) contents[name] = strToU8(text);
  for (const [name, bytes] of Object.entries(binary)) {
    if (contents[name] === undefined) contents[name] = bytes;
  }
  contents["README.txt"] = strToU8(readme(base, names));
  const ordered = Object.keys(contents).sort();
  const files: Record<string, string> = {};
  for (const name of ordered) files[name] = sha256OfBytes(contents[name] ?? new Uint8Array());
  const manifest: SubjectExportManifest = { ...base, files };

  const mtime = input.generatedAt;
  const zippable: Zippable = { "manifest.json": [strToU8(pretty(manifest)), { mtime }] };
  for (const name of ordered) zippable[name] = [contents[name] ?? new Uint8Array(), { mtime }];
  const bytes = zipSync(zippable, { level: 6 });
  return { bytes, sha256: sha256OfBytes(bytes), manifest };
}

export interface SubjectExportCheck {
  readonly manifest: SubjectExportManifest | undefined;
  /** Every entry except `manifest.json`, as text. */
  readonly files: Readonly<Record<string, string>>;
  /** Empty when every listed file is present with the listed sha256 and nothing is unlisted. */
  readonly problems: readonly string[];
}

/**
 * Opens an export and checks it against its own manifest — for the recipient, support staff and
 * the tests. It proves the archive is internally consistent, not who made it (the zip's sha256
 * on the access request, visible to the workspace's staff, is what ties it to an answer).
 */
export function verifySubjectExport(bytes: Uint8Array): SubjectExportCheck {
  const problems: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    return { manifest: undefined, files: {}, problems: ["not a zip archive"] };
  }
  const raw = entries["manifest.json"];
  let manifest: SubjectExportManifest | undefined;
  if (raw === undefined) problems.push("manifest.json is missing");
  else {
    try {
      manifest = JSON.parse(strFromU8(raw)) as SubjectExportManifest;
    } catch {
      problems.push("manifest.json is not JSON");
    }
  }
  if (manifest !== undefined && manifest.kind !== DSAR_EXPORT_KIND) {
    problems.push(`manifest kind is ${JSON.stringify(manifest.kind)}`);
  }
  const files: Record<string, string> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name === "manifest.json") continue;
    files[name] = strFromU8(data);
    const listed = manifest?.files[name];
    if (listed === undefined) problems.push(`${name} is not in the manifest`);
    else if (listed !== sha256OfBytes(data)) problems.push(`${name} does not match its sha256`);
  }
  for (const name of Object.keys(manifest?.files ?? {})) {
    if (entries[name] === undefined) problems.push(`${name} is listed but missing`);
  }
  return { manifest, files, problems };
}
