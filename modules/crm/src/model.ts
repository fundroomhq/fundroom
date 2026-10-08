import type { CommitmentStatus } from "@fundroom/round-terms";

/*
 * Pure model of the CRM (E2.5 §C). The vocabulary a route validates, the default stage ladder
 * a workspace is seeded with, and the two mappings that turn a round event into a stage move.
 * No drizzle, no pg — `src/schema/crm.ts` types its columns *from* this file, so the value a
 * CHECK constraint admits and the value a zod schema admits cannot drift.
 */

/**
 * Stage keys, and the same expression as the `pipeline_stage_key_format` CHECK.
 *
 * A key is a machine name: the event handlers address `soft_committed` by it, and a tenant who
 * renames the column to "Circled" must not thereby break the mapping from a commitment status
 * onto a column. Custom stages get `custom_<slug>` so a tenant can never mint a key that a
 * later release might want for a seeded one.
 */
export const STAGE_KEY_RE = /^[a-z][a-z0-9_]{0,62}$/u;

/** Prefix for a key this module did not seed (E2.5 D10). */
export const CUSTOM_STAGE_PREFIX = "custom_";

export interface StageSeed {
  readonly key: string;
  readonly name: string;
  readonly isTerminal: boolean;
}

/**
 * The ladder from design/03 §82, seeded lazily on the first CRM read of a workspace rather than
 * by the migration (design/06 §416 is explicit about that: stages are tenant data, and a
 * migration that wrote rows for every workspace would also write them for the ones that never
 * switch the module on).
 *
 * `wired` and `passed` are terminal: money arrived, or the conversation ended. Nothing else is
 * — "signed" is not the end of anything until the wire clears.
 */
export const DEFAULT_STAGES: readonly StageSeed[] = Object.freeze([
  { key: "prospect", name: "Prospect", isTerminal: false },
  { key: "contacted", name: "Contacted", isTerminal: false },
  { key: "meeting", name: "Meeting", isTerminal: false },
  { key: "diligence", name: "Diligence", isTerminal: false },
  { key: "soft_committed", name: "Soft-committed", isTerminal: false },
  { key: "committed", name: "Committed", isTerminal: false },
  { key: "docs_sent", name: "Docs sent", isTerminal: false },
  { key: "signed", name: "Signed", isTerminal: false },
  { key: "wired", name: "Wired", isTerminal: true },
  { key: "passed", name: "Passed", isTerminal: true },
] as const);

/** The seeded keys, in ladder order. */
export const DEFAULT_STAGE_KEYS: readonly string[] = Object.freeze(
  DEFAULT_STAGES.map((s) => s.key),
);

/**
 * Seeded keys a `PUT /crm/stages` may not remove.
 *
 * Renaming and reordering them is fine; deleting them is not, and the reason is mechanical
 * rather than aesthetic. `round.commitment_changed` maps `wired` onto one column and
 * `withdrawn` onto the other, and a workspace that had deleted either would silently stop
 * recording half of what the round module tells it. The handlers tolerate a missing stage (they
 * no-op rather than throw), which is exactly why the refusal has to live here: a silent no-op
 * is not something an admin would ever notice.
 */
export const PROTECTED_STAGE_KEYS: readonly string[] = Object.freeze(["wired", "passed"]);

export const SUBJECT_KINDS = ["contact", "organization", "pipeline_item"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];

export const ORGANIZATION_KINDS = [
  "fund",
  "angel_group",
  "corporate",
  "family_office",
  "other",
] as const;
export type OrganizationKind = (typeof ORGANIZATION_KINDS)[number];

/** Why a card moved. `staff` is a human on the board; the rest are round events (§C). */
export const TRANSITION_CAUSES = [
  "staff",
  "interest_submitted",
  "interest_decided",
  "commitment_created",
  "commitment_changed",
] as const;
export type TransitionCause = (typeof TRANSITION_CAUSES)[number];

/** Where a card lands when a member indicates interest and has no card yet. */
export const STAGE_ON_INTEREST = "contacted";

/** Where a card lands when a commitment is first recorded against it. */
export const STAGE_ON_COMMITMENT = "soft_committed";

/** Where a card lands when an interest submission is declined. */
export const STAGE_ON_DECLINED = "passed";

/**
 * `round.commitment_status` → stage key (§C).
 *
 * A withdrawal maps onto `passed` rather than back onto `prospect`: the conversation had an
 * outcome, and a board that quietly reset the card would lose that. `soft` maps onto
 * `soft_committed` so a commitment that is created and then re-announced lands in the same
 * place both times.
 */
const COMMITMENT_STAGE_KEYS = {
  soft: "soft_committed",
  verbal: "committed",
  signed: "signed",
  wired: "wired",
  withdrawn: "passed",
  // `satisfies` rather than a type annotation, so this is exhaustive over the round module's
  // enum at compile time: adding a sixth commitment status there fails the build here rather
  // than silently leaving cards where they were.
} satisfies Record<CommitmentStatus, string>;

export const STAGE_FOR_COMMITMENT_STATUS: Readonly<Record<string, string | undefined>> =
  Object.freeze(COMMITMENT_STAGE_KEYS);

/**
 * A tenant-supplied stage name turned into a key.
 *
 * Always prefixed, never bare: `custom_` is what keeps a tenant's "Committed" from colliding
 * with the seeded `committed`, and what lets a later release add a seeded key without
 * discovering that three workspaces already used the name for something else. A name with no
 * usable characters at all (emoji, punctuation) still has to produce a valid key, so it falls
 * back to `custom_stage`; the caller disambiguates duplicates.
 */
export function customStageKey(name: string): string {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 40);
  return slug.length === 0 ? `${CUSTOM_STAGE_PREFIX}stage` : `${CUSTOM_STAGE_PREFIX}${slug}`;
}

/**
 * The sentinel `roundId` that means "cards attached to no round at all".
 *
 * `GET /crm/pipeline` with no `roundId` is every card; `roundId=none` is the ones whose
 * `round_id` is NULL. A query parameter cannot carry SQL NULL, and an empty string is
 * indistinguishable from the parameter being absent once a browser has serialised a form, so
 * the absence has to be spelled.
 */
export const NO_ROUND = "none";

/**
 * Contact activity (E3.6): what a verified booking webhook (Calendly / Cal.com) records on the
 * contact it is about — the same vocabulary as the `activity_kind` CHECK.
 */
export const ACTIVITY_KINDS = [
  "meeting_booked",
  "meeting_cancelled",
  "meeting_rescheduled",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** The activity a booking status becomes. One row per (booking, kind). */
export const ACTIVITY_FOR_BOOKING_STATUS: Readonly<
  Record<"booked" | "cancelled" | "rescheduled", ActivityKind>
> = {
  booked: "meeting_booked",
  cancelled: "meeting_cancelled",
  rescheduled: "meeting_rescheduled",
};

/** Rows `GET /crm/contacts/{id}/activity` returns at most, newest first. */
export const ACTIVITY_LIST_LIMIT = 100;
