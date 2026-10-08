import { z } from "@hono/zod-openapi";

/*
 * The block registry (design/06 §8, ADR-0033 §2). A page document is a tree of sections and
 * typed blocks; every block type has a Zod schema per `schemaVersion` and an upgrade path,
 * the renderer refuses unknown types, and reference blocks (`metric_grid`, `document_list`,
 * `disclaimer`) hold ids only: the owning module hydrates them at render time after
 * visibility. `disclaimer` is the one this module hydrates itself — the legal library is a
 * kernel service (`ModuleServices.legal`), not another module's data.
 */
export const DOC_SCHEMA_VERSION = 1;

export const BLOCK_TYPES = [
  "hero",
  "rich_text",
  "metric_grid",
  "document_list",
  "team",
  "faq",
  "embed",
  "disclaimer",
  "round_summary",
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const SECTION_KEY_RE = /^[a-z0-9][a-z0-9-]{0,39}$/u;
export const BLOCK_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** Limits that keep a page "small" (whole-tree snapshot per revision). */
export const LIMITS = {
  sections: 50,
  blocksPerSection: 40,
  richTextChars: 20_000,
  docBytes: 512 * 1024,
} as const;

const httpsUrl = z
  .url({ protocol: /^https?$/u, hostname: z.regexes.hostname })
  .max(2048)
  .openapi({ example: "https://example.com/deck.pdf" });
/** A same-portal path or an http(s) URL. */
const href = z
  .string()
  .max(2048)
  .refine(
    (v) =>
      (v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\")) ||
      httpsUrl.safeParse(v).success,
    "must be an http(s) URL or a same-site path",
  );
const shortText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().default(null);

export const HeroSchema = z
  .object({
    heading: shortText(200),
    subheading: optionalText(600),
    imageUrl: httpsUrl.nullable().default(null),
    cta: z
      .object({ label: shortText(60), href })
      .nullable()
      .default(null),
  })
  .strict()
  .openapi("HeroBlockData");

export const RichTextSchema = z
  .object({
    /** Markdown subset rendered client-side into React elements (no HTML). */
    format: z.literal("markdown"),
    text: z.string().max(LIMITS.richTextChars),
  })
  .strict()
  .openapi("RichTextBlockData");

export const MetricGridSchema = z
  .object({
    /** `metrics.definition` ids; hydrated by the metrics module (E2.4). */
    definitionIds: z.array(z.uuid()).max(12),
    columns: z.number().int().min(1).max(4).default(3),
  })
  .strict()
  .openapi("MetricGridBlockData");

export const DocumentListSchema = z
  .object({
    /** A data-room folder whose visible documents are listed (E1.3), and/or explicit documents. */
    folderId: z.uuid().nullable().default(null),
    documentIds: z.array(z.uuid()).max(50).default([]),
    title: optionalText(120),
  })
  .strict()
  .openapi("DocumentListBlockData");

export const TeamMemberSchema = z
  .object({
    name: shortText(120),
    title: optionalText(120),
    bio: optionalText(1000),
    photoUrl: httpsUrl.nullable().default(null),
    linkedinUrl: httpsUrl.nullable().default(null),
  })
  .strict();

export const TeamSchema = z
  .object({ members: z.array(TeamMemberSchema).max(40) })
  .strict()
  .openapi("TeamBlockData");

export const FaqSchema = z
  .object({
    items: z
      .array(z.object({ question: shortText(300), answer: shortText(4000) }).strict())
      .max(60),
  })
  .strict()
  .openapi("FaqBlockData");

export const EMBED_PROVIDERS = ["youtube", "vimeo", "loom", "other"] as const;

/**
 * Renders as a link card in the portal: the app's CSP has `frame-src 'none'`, and a per-
 * workspace frame allow-list is E2.2's job. The provider is derived from the host so the
 * client can show the right icon.
 */
export const EmbedSchema = z
  .object({
    url: httpsUrl,
    title: optionalText(200),
    provider: z.enum(EMBED_PROVIDERS).default("other"),
  })
  .strict()
  .openapi("EmbedBlockData");

/** A legal-document slug (`core.legal_document.slug`); the same shape compliance validates. */
export const DISCLAIMER_SLUG_RE = /^[a-z][a-z0-9-]{0,62}$/u;

/**
 * A disclaimer block holds a slug, never the text (E1.6). The text is a tenant legal document
 * with its own version history, and a page that copied the words would quietly go stale the
 * moment the workspace published a new version; the stamp on the revision is what makes
 * "this reader saw v3" provable. `null` means the workspace default
 * (`legal.defaultDisclaimerSlug` in workspace settings).
 */
export const DisclaimerSchema = z
  .object({
    slug: z
      .string()
      .regex(DISCLAIMER_SLUG_RE)
      .nullable()
      .default(null)
      .openapi({ example: "offering-disclaimer" }),
  })
  .strict()
  .openapi("DisclaimerBlockData");

/**
 * The round summary carries **no data at all** — not even a round id (E2.5 §R).
 *
 * A page says "show the round" and the round module decides which one: the open round, or the
 * most recently closed one. Pinning an id would mean an editor has to remember to move the block
 * every time a raise closes, and the failure mode of forgetting is a page showing last year's
 * terms as though they were current — which is the one mistake an offering page must not make.
 * `.strict()` so a stored id from a future shape is a validation error rather than a field
 * quietly ignored.
 */
export const RoundSummarySchema = z.object({}).strict().openapi("RoundSummaryBlockData");

export interface BlockDefinition {
  readonly type: BlockType;
  /** `static` blocks carry their content; `reference` blocks carry ids another module hydrates. */
  readonly kind: "static" | "reference";
  readonly schemaVersion: number;
  readonly schemas: Readonly<Record<number, z.ZodType>>;
  /** Rewrites data written under an older schema version into the current shape. */
  readonly upgrade?: ((fromVersion: number, data: unknown) => unknown) | undefined;
}

export const BLOCK_REGISTRY: Readonly<Record<BlockType, BlockDefinition>> = {
  hero: { type: "hero", kind: "static", schemaVersion: 1, schemas: { 1: HeroSchema } },
  rich_text: {
    type: "rich_text",
    kind: "static",
    schemaVersion: 1,
    schemas: { 1: RichTextSchema },
  },
  metric_grid: {
    type: "metric_grid",
    kind: "reference",
    schemaVersion: 1,
    schemas: { 1: MetricGridSchema },
  },
  document_list: {
    type: "document_list",
    kind: "reference",
    schemaVersion: 1,
    schemas: { 1: DocumentListSchema },
  },
  team: { type: "team", kind: "static", schemaVersion: 1, schemas: { 1: TeamSchema } },
  faq: { type: "faq", kind: "static", schemaVersion: 1, schemas: { 1: FaqSchema } },
  embed: { type: "embed", kind: "static", schemaVersion: 1, schemas: { 1: EmbedSchema } },
  disclaimer: {
    type: "disclaimer",
    kind: "reference",
    schemaVersion: 1,
    schemas: { 1: DisclaimerSchema },
  },
  round_summary: {
    type: "round_summary",
    kind: "reference",
    schemaVersion: 1,
    schemas: { 1: RoundSummarySchema },
  },
};

export function isBlockType(type: string): type is BlockType {
  return Object.hasOwn(BLOCK_REGISTRY, type);
}

export function providerOf(url: string): (typeof EMBED_PROVIDERS)[number] {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "other";
  }
  if (host === "youtu.be" || host === "youtube.com" || host.endsWith(".youtube.com"))
    return "youtube";
  if (host === "vimeo.com" || host.endsWith(".vimeo.com")) return "vimeo";
  if (host === "loom.com" || host.endsWith(".loom.com")) return "loom";
  return "other";
}

// --- the document ---------------------------------------------------------------------------

export const BlockSchema = z
  .object({
    id: z.string().regex(BLOCK_ID_RE).openapi({ example: "hero-1" }),
    type: z.string().min(1).max(40).openapi({ example: "hero" }),
    schemaVersion: z.number().int().min(1),
    data: z.record(z.string(), z.unknown()),
  })
  .strict()
  .openapi("Block");

export const SectionSchema = z
  .object({
    key: z.string().regex(SECTION_KEY_RE).openapi({ example: "about" }),
    title: z.string().trim().max(120).nullable(),
    blocks: z.array(BlockSchema).max(LIMITS.blocksPerSection),
  })
  .strict()
  .openapi("Section");

export const PageDocSchema = z
  .object({ sections: z.array(SectionSchema).max(LIMITS.sections) })
  .strict()
  .openapi("PageDoc");

export type Block = z.output<typeof BlockSchema>;
export type Section = z.output<typeof SectionSchema>;
export type PageDoc = z.output<typeof PageDocSchema>;

export interface DocIssue {
  readonly path: string;
  readonly message: string;
  readonly code: string;
}

export class DocValidationError extends Error {
  override readonly name = "DocValidationError";
  constructor(readonly issues: readonly DocIssue[]) {
    super(issues.map((i) => `${i.path}: ${i.message}`).join("; ") || "invalid page document");
  }
}

function zodIssues(prefix: string, error: z.ZodError): DocIssue[] {
  return error.issues.map((i) => ({
    path: [prefix, ...i.path.map(String)].filter(Boolean).join("."),
    message: i.message,
    code: i.code,
  }));
}

/**
 * Structural check, block-type check, per-version data check with upgrades, uniqueness of
 * section keys and block ids, and the size cap. Returns the normalised document: every
 * block at the current schema version with defaults filled in.
 */
export function validateDoc(input: unknown): PageDoc {
  const structural = PageDocSchema.safeParse(input);
  if (!structural.success) throw new DocValidationError(zodIssues("doc", structural.error));
  const issues: DocIssue[] = [];
  const sectionKeys = new Set<string>();
  const blockIds = new Set<string>();
  const sections: Section[] = [];
  structural.data.sections.forEach((section, si) => {
    const sPath = `doc.sections.${si}`;
    if (sectionKeys.has(section.key))
      issues.push({ path: `${sPath}.key`, message: "duplicate section key", code: "duplicate" });
    sectionKeys.add(section.key);
    const blocks: Block[] = [];
    section.blocks.forEach((block, bi) => {
      const bPath = `${sPath}.blocks.${bi}`;
      if (blockIds.has(block.id))
        issues.push({ path: `${bPath}.id`, message: "duplicate block id", code: "duplicate" });
      blockIds.add(block.id);
      if (!isBlockType(block.type)) {
        issues.push({
          path: `${bPath}.type`,
          message: `unknown block type ${block.type}`,
          code: "unknown_type",
        });
        return;
      }
      const def = BLOCK_REGISTRY[block.type];
      if (block.schemaVersion > def.schemaVersion) {
        issues.push({
          path: `${bPath}.schemaVersion`,
          message: `${block.type} schema version ${block.schemaVersion} is newer than this server (${def.schemaVersion})`,
          code: "unsupported_version",
        });
        return;
      }
      let data: unknown = block.data;
      if (block.schemaVersion < def.schemaVersion) {
        if (def.upgrade === undefined) {
          issues.push({
            path: `${bPath}.schemaVersion`,
            message: "no upgrade path",
            code: "unsupported_version",
          });
          return;
        }
        data = def.upgrade(block.schemaVersion, data);
      }
      const schema = def.schemas[def.schemaVersion];
      if (schema === undefined)
        throw new Error(`registry: ${block.type} lacks schema v${def.schemaVersion}`);
      const parsed = schema.safeParse(data);
      if (!parsed.success) {
        issues.push(...zodIssues(`${bPath}.data`, parsed.error));
        return;
      }
      let out = parsed.data as Record<string, unknown>;
      if (block.type === "embed") out = { ...out, provider: providerOf(String(out["url"])) };
      blocks.push({ id: block.id, type: block.type, schemaVersion: def.schemaVersion, data: out });
    });
    sections.push({ key: section.key, title: section.title, blocks });
  });
  if (issues.length > 0) throw new DocValidationError(issues);
  const doc: PageDoc = { sections };
  const bytes = Buffer.byteLength(JSON.stringify(doc), "utf8");
  if (bytes > LIMITS.docBytes) {
    throw new DocValidationError([
      {
        path: "doc",
        message: `page is ${bytes} bytes; the limit is ${LIMITS.docBytes}`,
        code: "too_big",
      },
    ]);
  }
  return doc;
}

export interface BlockDescriptor {
  readonly type: BlockType;
  readonly kind: "static" | "reference";
  readonly schemaVersion: number;
}

export function blockDescriptors(): BlockDescriptor[] {
  return BLOCK_TYPES.map((type) => {
    const def = BLOCK_REGISTRY[type];
    return { type, kind: def.kind, schemaVersion: def.schemaVersion };
  });
}
