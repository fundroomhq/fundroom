/*
 * What a delegate's scope admits, by module (E3.2). A delegate acts for an
 * investor with a scope — `all`, `data_room` or `updates` — and content addressed to every member
 * belongs to a module: an update or a content page addressed to everybody is "updates" content, the
 * data room is "data room" content, and the round and the KPIs are neither, so only an `all`
 * delegate reads them.
 *
 * The SQL twin is `core.current_delegation_admits(module)` (core migration 0017), which the round,
 * metrics, content and updates policies and the search `members` arm call. Keep the two in step:
 * `apps/server/src/delegates.integration.test.ts` asks both the same questions.
 */
export type DelegateScopeName = "all" | "data_room" | "updates";

/** Module ids a narrow scope admits. `all` admits every module. */
export const DELEGATE_SCOPE_CONTENT_MODULES: Readonly<
  Record<Exclude<DelegateScopeName, "all">, readonly string[]>
> = Object.freeze({
  data_room: Object.freeze(["data-room"]),
  updates: Object.freeze(["updates", "content"]),
});

/**
 * Whether a reader with this delegate scope may read a module's member-wide content. `null` /
 * `undefined` is "not a delegate" (admitted); an unknown scope is refused (deny-safe).
 */
export function delegationAdmitsModule(scope: string | null | undefined, module: string): boolean {
  if (scope === null || scope === undefined || scope === "all") return true;
  const modules = (DELEGATE_SCOPE_CONTENT_MODULES as Record<string, readonly string[] | undefined>)[
    scope
  ];
  return modules?.includes(module) ?? false;
}
