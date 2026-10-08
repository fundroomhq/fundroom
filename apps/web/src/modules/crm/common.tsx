import { useQuery } from "@tanstack/react-query";
import type { PipelineItem } from "../../lib/crm-queries.js";
import { initials } from "../../lib/format.js";
import { type PeopleFilter, type Person, peopleQuery } from "../../lib/queries.js";
import { m } from "../../paraglide/messages.js";

/*
 * Small pieces the four CRM screens share.
 *
 * The people list is fetched with `retry: false` on purpose: `/access/people` is another
 * module's route behind `access.read`, and a CRM editor who cannot read the directory should
 * lose the owner picker, not the screen. Every caller treats "no people" as a fact rather than
 * an error.
 */
export function usePeople(filter: PeopleFilter = {}) {
  return useQuery({ ...peopleQuery(filter), retry: false });
}

export function peopleOf(query: ReturnType<typeof usePeople>): readonly Person[] {
  return query.data?.items ?? [];
}

export function nameOfMembership(
  people: readonly Person[],
  membershipId: string | null | undefined,
): string | undefined {
  if (typeof membershipId !== "string") return undefined;
  const person = people.find((p) => p.membershipId === membershipId);
  return person === undefined ? undefined : person.displayName || (person.email ?? undefined);
}

/**
 * An owner on a card: initials for the eye, the whole name for anything that reads the page
 * aloud. Initials on their own are a puzzle, not a label.
 */
export function OwnerMark({ name }: { name: string | undefined }) {
  if (name === undefined) {
    return <span className="text-xs text-muted-foreground">{m.crm_owner_none()}</span>;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <span
        aria-hidden="true"
        className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-[10px] font-medium"
      >
        {initials(name)}
      </span>
      <span className="sr-only">{m.crm_owner_is({ name })}</span>
    </span>
  );
}

/** What a pipeline item is *about*: the contact if there is one, otherwise the organisation. */
export function itemSubjectName(item: PipelineItem): string {
  return item.contact?.displayName ?? item.organization?.name ?? m.crm_item_no_subject();
}
