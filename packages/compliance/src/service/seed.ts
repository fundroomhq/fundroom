import type { TenantContext, Tx } from "@fundroom/db";
import type { Actor } from "../errors.js";
import { LegalDocumentRepo } from "../repos/compliance-repo.js";
import type { TemplateContext } from "../templates/contract.js";
import { templateById } from "../templates/library.js";
import { createDocumentService, type DocumentSummary } from "./documents.js";
import type { ComplianceDeps } from "./types.js";

/*
 * The documents a new workspace starts with (E1.7's setup wizard calls this; this package only
 * exposes it).
 *
 * Two, and only two. The privacy notice, because the moment a workspace has a member it is
 * processing personal data and a controller with no notice is already in breach; and a default
 * disclaimer, because updates and page revisions stamp one at publish and a workspace with none
 * would ship offering material with nothing attached. Everything else in the library is opt-in:
 * seeding an NDA nobody asked for teaches admins to skim legal documents, which is the opposite
 * of what any of this is for.
 */

/** `legal.defaultDisclaimerSlug` points here after seeding. */
export const DEFAULT_DISCLAIMER_SLUG = "offering-legends";
export const PRIVACY_NOTICE_SLUG = "privacy-notice";

export interface SeedInput {
  /** Merge-field values for the render; anything unset degrades to an empty string. */
  readonly context?: TemplateContext | undefined;
  readonly actor: Actor;
}

export interface SeedResult {
  readonly documents: readonly DocumentSummary[];
  /** The slug to store in `legal.defaultDisclaimerSlug`, for the caller to write. */
  readonly defaultDisclaimerSlug: string;
}

const SEEDED: readonly { readonly slug: string; readonly templateId: string }[] = [
  { slug: PRIVACY_NOTICE_SLUG, templateId: "privacy-notice" },
  { slug: DEFAULT_DISCLAIMER_SLUG, templateId: "legends" },
];

/**
 * Idempotent: a slug that already exists is left exactly as it is, including its version history.
 * Re-running the wizard, or running it against a workspace an operator has already configured by
 * hand, must never republish over a tenant's edits.
 */
export async function seedDefaults(
  deps: ComplianceDeps,
  ctx: TenantContext,
  tx: Tx,
  input: SeedInput,
): Promise<SeedResult> {
  const documents = createDocumentService(deps);
  const repo = new LegalDocumentRepo(ctx, tx);
  const out: DocumentSummary[] = [];

  for (const { slug, templateId } of SEEDED) {
    const existing = await repo.bySlug(slug);
    if (existing !== undefined) {
      out.push((await documents.read(ctx, tx, existing.id)) satisfies DocumentSummary);
      continue;
    }
    const template = templateById(templateId);
    if (template === undefined) continue;
    out.push(
      await documents.create(ctx, tx, {
        slug,
        title: template.title,
        from: template.id,
        ...(input.context === undefined ? {} : { context: input.context }),
        actor: input.actor,
      }),
    );
  }

  return { documents: out, defaultDisclaimerSlug: DEFAULT_DISCLAIMER_SLUG };
}
