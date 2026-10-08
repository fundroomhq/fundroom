import { z } from "@hono/zod-openapi";

/*
 * Pure vocabulary of the data room: protection settings, the ltree path scheme, index
 * numbering, the upload allow-list and the watermark text. No I/O here.
 */

// --- protection (design/02 §4 "download / print controls") -----------------------------------
export const PROTECTION_SCHEMA_VERSION = 1;

export const ProtectionSchema = z
  .object({
    /** Investors may download (a watermarked copy when `watermark` is on). Staff with `data-room.download` always can. */
    download: z.boolean().default(false),
    /** Burn the viewer's identity into page images and downloaded PDFs. */
    watermark: z.boolean().default(true),
    /** Reserved: print = download_watermarked; kept for the per-document policy shape. */
    print: z.boolean().default(false),
    /**
     * E3.13: embed an invisible, per-recipient forensic mark into every page image served (and a
     * trace id into watermarked downloads), so a leaked page can be traced to who received it.
     * Independent of `watermark`. Never forced by share links.
     */
    forensic: z.boolean().default(false),
  })
  .strict()
  .openapi("DocumentProtection");
export type Protection = z.output<typeof ProtectionSchema>;

/**
 * Protection as a response shows it (E3.13 FIX1 D4): `forensic` is present for staff only — an
 * investor must not learn which documents carry the invisible mark.
 */
export const ProtectionViewSchema = z
  .object({
    download: z.boolean(),
    watermark: z.boolean(),
    print: z.boolean(),
    forensic: z.boolean().optional().openapi({ description: "Staff only; absent for investors" }),
  })
  .openapi("DocumentProtectionView");

/** `protection` for a response to `viewerKind`: externals never see `forensic`. */
export function protectionView(
  protection: Protection,
  viewerKind: "staff" | "external",
): z.output<typeof ProtectionViewSchema> {
  if (viewerKind === "staff") return { ...protection };
  const { forensic: _hidden, ...rest } = protection;
  return rest;
}

export function parseProtection(raw: unknown): Protection {
  const r = ProtectionSchema.safeParse(raw ?? {});
  return r.success ? r.data : ProtectionSchema.parse({});
}

// --- paths ------------------------------------------------------------------------------------
export const ROOT_LABEL = "r";
export const LTREE_PATH_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/u;

/** A folder's ltree label: its uuid without hyphens (32 hex chars). */
export function folderLabel(folderId: string): string {
  const label = folderId.replace(/-/gu, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(label)) throw new RangeError(`not a uuid: ${folderId}`);
  return label;
}

export function childPath(parentPath: string, folderId: string): string {
  return `${parentPath}.${folderLabel(folderId)}`;
}

export function isAncestorOrSelf(ancestor: string, path: string): boolean {
  return ancestor === path || path.startsWith(`${ancestor}.`);
}

export function pathDepth(path: string): number {
  return path.split(".").length;
}

// --- index numbering (design/03 B1 "deterministic index numbering for DD checklists") --------
export interface Numbered {
  readonly id: string;
  readonly sortOrder: number;
  readonly name: string;
}

/**
 * Siblings are numbered 1..n by (sort_order, name); folders come before documents within a
 * parent so a folder's number never shifts when a file is added. The index of a node is its
 * parent's index followed by its own number (`1.2.3`); the root has no index.
 */
export function numberSiblings<T extends Numbered>(
  folders: readonly T[],
  documents: readonly T[],
): Map<string, number> {
  const sort = (a: T, b: T) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "en");
  const out = new Map<string, number>();
  let n = 1;
  for (const f of [...folders].sort(sort)) out.set(f.id, n++);
  for (const d of [...documents].sort(sort)) out.set(d.id, n++);
  return out;
}

export function joinIndex(parentIndex: string | null, n: number): string {
  return parentIndex === null || parentIndex === "" ? String(n) : `${parentIndex}.${n}`;
}

// --- uploads (design/02 §4 "upload hygiene") --------------------------------------------------
/** Declared → sniffed type families the data room accepts. HTML/SVG/JS are refused. */
export const ALLOWED_TYPES: Readonly<Record<string, readonly string[]>> = {
  "application/pdf": ["application/pdf"],
  "image/png": ["image/png"],
  "image/jpeg": ["image/jpeg"],
  "image/webp": ["image/webp"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["application/zip"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["application/zip"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["application/zip"],
  "text/csv": ["text/plain"],
  "video/mp4": ["video/mp4"],
};

export const EXTENSION_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  mp4: "video/mp4",
};

/** Normalises a declared type; falls back to the extension when the browser says octet-stream. */
export function resolveDeclaredType(declared: string, fileName: string): string | undefined {
  const type = declared.split(";")[0]?.trim().toLowerCase() ?? "";
  if (type in ALLOWED_TYPES) return type;
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  const byExt = EXTENSION_TYPES[ext];
  if (byExt !== undefined && (type === "" || type === "application/octet-stream")) return byExt;
  return undefined;
}

/** Magic-byte sniff of the first bytes; `text/plain` for printable text, undefined when unknown. */
export function sniffBytes(head: Uint8Array): string | undefined {
  const at = (i: number) => head[i] ?? -1;
  if (at(0) === 0x25 && at(1) === 0x50 && at(2) === 0x44 && at(3) === 0x46 && at(4) === 0x2d)
    return "application/pdf";
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46 && at(8) === 0x57)
    return "image/webp";
  if (at(0) === 0x50 && at(1) === 0x4b && at(2) === 0x03 && at(3) === 0x04)
    return "application/zip";
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) return "video/mp4";
  if (at(0) === 0x3c) return "text/html"; // `<`: HTML/SVG/XML — refused by the allow-list
  const sample = head.subarray(0, Math.min(head.length, 4096));
  if (sample.length === 0) return undefined;
  let printable = 0;
  for (const b of sample) {
    if (b === 0) return undefined;
    if (b >= 0x20 || b === 0x09 || b === 0x0a || b === 0x0d) printable++;
  }
  return printable / sample.length > 0.95 ? "text/plain" : undefined;
}

/** True when the sniffed family agrees with the declared type (design/02 §4). */
export function typeMatches(declared: string, sniffed: string | undefined): boolean {
  const families = ALLOWED_TYPES[declared];
  if (families === undefined || sniffed === undefined) return false;
  return families.includes(sniffed);
}

/** Viewer can show it (PDFium / sharp); everything else is download-only. */
export function isPreviewable(contentType: string): boolean {
  return (
    contentType === "application/pdf" ||
    contentType === "image/png" ||
    contentType === "image/jpeg" ||
    contentType === "image/webp"
  );
}

// --- watermark ------------------------------------------------------------------------------
export interface WatermarkViewer {
  readonly email: string | null;
  readonly displayName: string;
  readonly workspaceSlug: string;
  readonly at: Date;
}

/** The lines burned into pages (design/02 §4: viewer email + timestamp + tenant). */
export function watermarkLines(v: WatermarkViewer): string[] {
  const when = v.at.toISOString().slice(0, 16).replace("T", " ");
  const who = v.email ?? v.displayName;
  return [`${who} · ${when} UTC`, `${v.workspaceSlug} · confidential`];
}

/** Day bucket for the watermark cache key (same viewer re-opening today hits the cache). */
export function dayBucket(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// --- folder templates (design/03 B1) ----------------------------------------------------------
export interface FolderTemplate {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly folders: readonly TemplateFolder[];
}
export interface TemplateFolder {
  readonly name: string;
  readonly children?: readonly TemplateFolder[] | undefined;
}

export const FOLDER_TEMPLATES: readonly FolderTemplate[] = [
  {
    id: "seed",
    name: "Seed round",
    description: "The persistent investor room a seed-stage company keeps between rounds.",
    folders: [
      { name: "Overview", children: [{ name: "Pitch deck" }, { name: "One-pager" }] },
      { name: "Financials", children: [{ name: "Historicals" }, { name: "Forecast" }] },
      { name: "Product" },
      { name: "Team" },
      { name: "Legal", children: [{ name: "Incorporation" }, { name: "Prior financings" }] },
      { name: "Other" },
    ],
  },
  {
    id: "series-a-dd",
    name: "Series A due diligence",
    description: "A due-diligence checklist structure with index numbers investors expect.",
    folders: [
      {
        name: "Corporate",
        children: [
          { name: "Charter and bylaws" },
          { name: "Board minutes and consents" },
          { name: "Cap table and option plan" },
        ],
      },
      {
        name: "Financial",
        children: [
          { name: "Financial statements" },
          { name: "Budget and forecast" },
          { name: "Bank and debt" },
          { name: "Tax" },
        ],
      },
      {
        name: "Commercial",
        children: [{ name: "Customer contracts" }, { name: "Pipeline and metrics" }],
      },
      {
        name: "Intellectual property",
        children: [
          { name: "Patents and trademarks" },
          { name: "Licences" },
          { name: "Open source" },
        ],
      },
      { name: "People", children: [{ name: "Employment agreements" }, { name: "Org chart" }] },
      { name: "Regulatory and compliance" },
      { name: "Litigation" },
    ],
  },
  {
    id: "board",
    name: "Board",
    description: "Board packs, minutes and consents, organised by meeting.",
    folders: [
      { name: "Board packs" },
      { name: "Minutes and consents" },
      { name: "Financial reports" },
      { name: "Policies" },
    ],
  },
];

export function templateById(id: string): FolderTemplate | undefined {
  return FOLDER_TEMPLATES.find((t) => t.id === id);
}
