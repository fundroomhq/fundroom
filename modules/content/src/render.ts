import type { BlockHydrationContext, BlockViewer, RegisteredHydrator } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { BLOCK_REGISTRY, type Block, isBlockType, type PageDoc } from "./blocks.js";
import { ruleFor, sectionVisible, type VisibilityMap, type VisibilityRule } from "./visibility.js";

/*
 * Rendering (design/06 §8): apply visibility first, then hydrate the surviving reference
 * blocks through the providing module. An investor's response never carries data from a
 * section they cannot see, and a block whose module is disabled (or missing from this
 * build) renders a fallback marker instead of failing the page.
 */
export interface RenderedBlock {
  readonly id: string;
  readonly type: string;
  readonly schemaVersion: number;
  readonly data: JsonObject;
  /** Set on reference blocks that could not be hydrated. */
  readonly unavailable?: "module_unavailable" | "hydration_failed" | undefined;
}

export interface RenderedSection {
  readonly key: string;
  readonly title: string | null;
  readonly visibility: VisibilityRule;
  readonly blocks: readonly RenderedBlock[];
}

export interface RenderOptions {
  readonly doc: PageDoc;
  readonly visibility: VisibilityMap;
  readonly viewer: BlockViewer;
  readonly allowPublic: boolean;
  readonly hydrators: ReadonlyMap<string, RegisteredHydrator>;
  readonly enabledModules: ReadonlySet<string>;
  readonly context: BlockHydrationContext;
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

export async function renderSections(options: RenderOptions): Promise<RenderedSection[]> {
  const out: RenderedSection[] = [];
  for (const section of options.doc.sections) {
    const rule = ruleFor(options.visibility, section.key);
    if (!sectionVisible(rule, options.viewer, { allowPublic: options.allowPublic })) continue;
    const blocks: RenderedBlock[] = [];
    for (const block of section.blocks) blocks.push(await renderBlock(block, options));
    out.push({ key: section.key, title: section.title, visibility: rule, blocks });
  }
  return out;
}

async function renderBlock(block: Block, options: RenderOptions): Promise<RenderedBlock> {
  const base = {
    id: block.id,
    type: block.type,
    schemaVersion: block.schemaVersion,
    data: block.data as JsonObject,
  };
  if (!isBlockType(block.type) || BLOCK_REGISTRY[block.type].kind === "static") return base;
  const provider = options.hydrators.get(block.type);
  if (provider === undefined || !options.enabledModules.has(provider.module)) {
    return { ...base, unavailable: "module_unavailable" };
  }
  try {
    const hydrated = await provider.hydrator.hydrate(block.data as JsonObject, options.context);
    return { ...base, data: { ...base.data, hydrated } };
  } catch (error) {
    options.log?.("content.hydration_failed", {
      level: "warn",
      blockType: block.type,
      module: provider.module,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...base, unavailable: "hydration_failed" };
  }
}

/** Sections a viewer would see, keys only (cheap "is there anything public here?" check). */
export function visibleSectionKeys(
  doc: PageDoc,
  visibility: VisibilityMap,
  viewer: BlockViewer,
  allowPublic: boolean,
): string[] {
  return doc.sections
    .filter((s) => sectionVisible(ruleFor(visibility, s.key), viewer, { allowPublic }))
    .map((s) => s.key);
}
