import type { FundRoomSchemas } from "@fundroom/sdk";
import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { api, call, isCode } from "./api.js";

export type Bootstrap = FundRoomSchemas["ModulesBootstrap"];
export type ModuleDescriptor = FundRoomSchemas["ModuleDescriptor"];
export type Me = FundRoomSchemas["Me"];
export type Person = FundRoomSchemas["Person"];
export type PersonDetail = FundRoomSchemas["PersonDetail"];
export type Group = FundRoomSchemas["Group"];
export type GroupDetail = FundRoomSchemas["GroupDetail"];
export type Invite = FundRoomSchemas["Invite"];
export type WhoHasAccess = FundRoomSchemas["WhoHasAccess"];
export type AccessHolder = FundRoomSchemas["AccessHolder"];
export type AccessExplanation = FundRoomSchemas["AccessExplanation"];
export type CsvDryRunResult = FundRoomSchemas["CsvDryRunResult"];
export type InviteImport = FundRoomSchemas["InviteImport"];
export type AccessSettings = FundRoomSchemas["AccessSettings"];
export type ResourceRef = FundRoomSchemas["ResourceRef"];
export type NavItem = { id: string; label: string; to: string; order: number; icon?: string };
export type RenderedPage = FundRoomSchemas["RenderedPage"];
export type RenderedSection = FundRoomSchemas["RenderedSection"];
export type RenderedBlock = FundRoomSchemas["RenderedBlock"];
export type VisibilityRule = FundRoomSchemas["VisibilityRule"];
export type ContentPage = FundRoomSchemas["ContentPage"];
export type ContentPageDetail = FundRoomSchemas["ContentPageDetail"];
export type ContentRevision = FundRoomSchemas["ContentRevision"];
export type PageDoc = FundRoomSchemas["PageDoc"];
export type PageSection = FundRoomSchemas["Section"];
export type PageBlock = FundRoomSchemas["Block"];
export type BlockDescriptor = FundRoomSchemas["BlockDescriptor"];
export type ContentSettingsLike = FundRoomSchemas["ContentSettings"];

export const bootstrapQuery = queryOptions({
  queryKey: ["bootstrap"],
  queryFn: () => call(api().GET("/modules")),
});

/** `null` = signed out (401 is a state, not an error). */
export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async (): Promise<Me | null> => {
    try {
      return await call(api().GET("/me"));
    } catch (error) {
      if (isCode(error, "unauthenticated")) return null;
      throw error;
    }
  },
});

/**
 * Put the truth about the session in the cache, and wait for it. Call this after anything that
 * creates, raises or ends a session, before navigating.
 *
 * The obvious `invalidateQueries({ queryKey: meQuery.queryKey })` is wrong here, and wrong in a
 * way that reads as correct. Invalidation marks the entry stale and refetches only queries that
 * have an **active observer**; a sign-in screen has none, because nothing on it renders
 * `useMe()`. The navigation that follows then reaches `_portal.tsx`'s
 * `ensureQueryData(meQuery)`, which resolves from the cache whenever data exists — stale or
 * not — and the cached value is the `null` written by the `/me` that 401'd *before* sign-in. So
 * a visitor who signs in from a gated route is redirected straight back to the sign-in screen
 * with a perfectly good session in their cookie jar, and the next page load works, which is
 * what makes it so easy to dismiss.
 *
 * `refetchType: "all"` includes the inactive queries, and awaiting it is what makes the cache
 * hold the answer before the guard reads it. This lives in one place rather than at each of the
 * ten call sites because the trap is the pattern, not any one of them: every site that changes
 * a session is followed by a navigation into a guard that reads the cache directly.
 *
 * `/me` is not the only answer that changes with the session: the bootstrap does too, and when
 * the identity changes nothing else in the cache is ours any more (see the body).
 */
export async function refreshSession(queryClient: QueryClient): Promise<void> {
  const before = sessionIdentity(queryClient.getQueryData(meQuery.queryKey));
  await queryClient.invalidateQueries({
    queryKey: meQuery.queryKey,
    exact: true,
    refetchType: "all",
  });
  const after = sessionIdentity(queryClient.getQueryData(meQuery.queryKey));
  /*
   * A different identity (signed out → in, one account → another, a membership that did not
   * exist before the invite was consumed) makes every cached answer someone else's: the sign-in
   * screen's bootstrap says "no membership", and anything left from a previous user must never
   * render for the next one (F-25). Drop them all, keeping only the fresh `/me` and the
   * bootstrap entry (refetched below — removing an entry a mounted screen observes would orphan
   * that observer). The same identity (step-up, a security-settings change) keeps its cache.
   */
  if (before !== after) {
    queryClient.removeQueries({
      predicate: (q) => !isExactKey(q.queryKey, meQuery.queryKey) && !isBootstrapKey(q.queryKey),
    });
  }
  /*
   * The bootstrap is session-dependent too (membership, permissions, pending acceptances) and
   * both guards render from it. Without this, the "no membership" answer the sign-in screen
   * fetched while signed out (30 s staleTime) is what `_portal` and `/admin` read right after
   * sign-in: "You don't have access here" for a member with a perfectly good session (E3.2).
   */
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: bootstrapQuery.queryKey, refetchType: "all" }),
    before === after
      ? queryClient.invalidateQueries({
          predicate: (q) =>
            q.queryKey[0] === meQuery.queryKey[0] && !isExactKey(q.queryKey, meQuery.queryKey),
          refetchType: "all",
        })
      : undefined,
  ]);
}

/** Who the cache belongs to: `undefined` (never asked), signed out, or a user + membership. */
function sessionIdentity(me: Me | null | undefined): string {
  if (me === undefined) return "unknown";
  if (me === null) return "anonymous";
  return `${me.session.userId}:${me.membership?.id ?? "-"}:${me.viewAs === null ? "-" : "view-as"}`;
}

function isExactKey(key: readonly unknown[], target: readonly unknown[]): boolean {
  return key.length === target.length && key.every((part, i) => part === target[i]);
}

function isBootstrapKey(key: readonly unknown[]): boolean {
  return isExactKey(key, bootstrapQuery.queryKey);
}

export function useBootstrap() {
  return useQuery(bootstrapQuery);
}

export function useMe() {
  return useQuery(meQuery);
}

// --- view as investor (E2.7) ---------------------------------------------------------------------

export type ViewAsState = FundRoomSchemas["ViewAsState"];

/**
 * The view-as session this workspace is being served under, or `null`. Read from the bootstrap
 * (falling back to `/me`), both of which the server fills from the session row — the client
 * never decides on its own that it is viewing as someone. Everything that would record the
 * investor's visit (dwell beats, "viewed" stamps) or fetch their bytes (downloads) checks this
 * and stands down, because the server refuses those writes with `view_as_read_only` anyway and a
 * refused beacon every five seconds is noise in the staff member's console and the server log.
 */
export function useViewAs(): ViewAsState | null {
  const bootstrap = useQuery(bootstrapQuery);
  const me = useQuery(meQuery);
  return bootstrap.data?.viewAs ?? me.data?.viewAs ?? null;
}

/**
 * After a view-as starts or ends, every cached answer belongs to the other identity. Drop them
 * (except the two the route guards read), then refetch `/me` and the bootstrap and wait, for the
 * same reason `refreshSession` waits: the navigation that follows lands in a guard that reads the
 * cache directly.
 */
export async function resetForViewAs(queryClient: QueryClient): Promise<void> {
  queryClient.removeQueries({
    predicate: (q) => q.queryKey[0] !== "me" && q.queryKey[0] !== "bootstrap",
  });
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: meQuery.queryKey, refetchType: "all" }),
    queryClient.invalidateQueries({ queryKey: bootstrapQuery.queryKey, refetchType: "all" }),
  ]);
}

export const sessionsQuery = queryOptions({
  queryKey: ["me", "sessions"],
  queryFn: () => call(api().GET("/me/sessions")),
});
export const devicesQuery = queryOptions({
  queryKey: ["me", "devices"],
  queryFn: () => call(api().GET("/me/devices")),
});
export const passkeysQuery = queryOptions({
  queryKey: ["auth", "passkeys"],
  queryFn: () => call(api().GET("/auth/passkeys")),
});
export const totpQuery = queryOptions({
  queryKey: ["auth", "totp"],
  queryFn: () => call(api().GET("/auth/totp")),
});
export const passwordQuery = queryOptions({
  queryKey: ["auth", "password"],
  queryFn: () => call(api().GET("/auth/password")),
});
export const oidcProvidersQuery = queryOptions({
  queryKey: ["auth", "oidc", "providers"],
  queryFn: () => call(api().GET("/auth/oidc/providers")),
});

function isNavItem(value: unknown): value is NavItem {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["label"] === "string" &&
    typeof v["to"] === "string" &&
    typeof v["order"] === "number"
  );
}

/** Items of a nav slot across enabled, visible modules, sorted by `order`. */
export function navItemsFor(bootstrap: Bootstrap | undefined, slot: string): NavItem[] {
  if (!bootstrap) return [];
  const items: NavItem[] = [];
  for (const mod of bootstrap.modules) {
    if (!mod.enabled || mod.hidden) continue;
    for (const entry of mod.slots[slot] ?? []) if (isNavItem(entry)) items.push(entry);
  }
  return items.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

export function visibleModules(bootstrap: Bootstrap | undefined): ModuleDescriptor[] {
  return (bootstrap?.modules ?? []).filter((mod) => mod.enabled && !mod.hidden);
}

// --- access management (E1.1) ------------------------------------------------------------------

export interface PeopleFilter {
  kind?: "staff" | "external" | undefined;
  status?: string | undefined;
  groupId?: string | undefined;
  q?: string | undefined;
}

export function peopleQuery(filter: PeopleFilter = {}) {
  return queryOptions({
    queryKey: ["access", "people", filter],
    queryFn: () =>
      call(
        api().GET("/access/people", {
          params: {
            query: {
              ...(filter.kind ? { kind: filter.kind } : {}),
              ...(filter.status ? { status: filter.status } : {}),
              ...(filter.groupId ? { groupId: filter.groupId } : {}),
              ...(filter.q ? { q: filter.q } : {}),
              limit: 200,
            },
          },
        }),
      ),
  });
}

export function personQuery(id: string) {
  return queryOptions({
    queryKey: ["access", "person", id],
    queryFn: () => call(api().GET("/access/people/{id}", { params: { path: { id } } })),
  });
}

export const groupsQuery = queryOptions({
  queryKey: ["access", "groups"],
  queryFn: () => call(api().GET("/access/groups")),
});

export function groupQuery(id: string) {
  return queryOptions({
    queryKey: ["access", "group", id],
    queryFn: () => call(api().GET("/access/groups/{id}", { params: { path: { id } } })),
  });
}

export function invitesQuery(status: "pending" | "accepted" | "expired" | "revoked" = "pending") {
  return queryOptions({
    queryKey: ["access", "invites", status],
    queryFn: () =>
      call(api().GET("/access/invites", { params: { query: { status, limit: 200 } } })),
  });
}

export function importQuery(id: string) {
  return queryOptions({
    queryKey: ["access", "import", id],
    queryFn: () =>
      call(api().GET("/access/invites/csv/imports/{id}", { params: { path: { id } } })),
  });
}

export function whoHasAccessQuery(resource: ResourceRef) {
  return queryOptions({
    queryKey: ["access", "who", resource.kind, resource.id, resource.path ?? ""],
    queryFn: () =>
      call(
        api().GET("/access/resources/{kind}/{id}/who", {
          params: {
            path: { kind: resource.kind, id: resource.id },
            query: resource.path ? { path: resource.path } : {},
          },
        }),
      ),
  });
}

export function explainQuery(resource: ResourceRef, membershipId: string) {
  return queryOptions({
    queryKey: ["access", "explain", resource.kind, resource.id, resource.path ?? "", membershipId],
    queryFn: () =>
      call(
        api().GET("/access/resources/{kind}/{id}/explain", {
          params: {
            path: { kind: resource.kind, id: resource.id },
            query: { membershipId, ...(resource.path ? { path: resource.path } : {}) },
          },
        }),
      ),
  });
}

export const accessSettingsQuery = queryOptions({
  queryKey: ["access", "settings"],
  queryFn: () => call(api().GET("/access/settings")),
});

// --- content page (E1.2) -------------------------------------------------------------------------

export function renderedPageQuery(slug: string) {
  return queryOptions({
    queryKey: ["content", "render", slug],
    queryFn: () => call(api().GET("/content/render/{slug}", { params: { path: { slug } } })),
  });
}

export const contentPagesQuery = queryOptions({
  queryKey: ["content", "pages"],
  queryFn: () => call(api().GET("/content/pages")),
});

export function contentPageQuery(id: string) {
  return queryOptions({
    queryKey: ["content", "page", id],
    queryFn: () => call(api().GET("/content/pages/{id}", { params: { path: { id } } })),
  });
}

export function contentRevisionsQuery(id: string) {
  return queryOptions({
    queryKey: ["content", "revisions", id],
    queryFn: () => call(api().GET("/content/pages/{id}/revisions", { params: { path: { id } } })),
  });
}

export function contentPreviewQuery(id: string, as: string) {
  return queryOptions({
    queryKey: ["content", "preview", id, as],
    queryFn: () =>
      call(api().GET("/content/pages/{id}/preview", { params: { path: { id }, query: { as } } })),
    staleTime: 0,
  });
}

export const contentBlocksQuery = queryOptions({
  queryKey: ["content", "blocks"],
  queryFn: () => call(api().GET("/content/blocks")),
});

export const contentSettingsQuery = queryOptions({
  queryKey: ["content", "settings"],
  queryFn: () => call(api().GET("/content/settings")),
});

// --- data room (E1.3, admin) --------------------------------------------------------------------

export type DataRoomTree = FundRoomSchemas["DataRoomTree"];
export type DataRoomTreeFolder = FundRoomSchemas["DataRoomTreeFolder"];
export type DataRoomTreeDocument = FundRoomSchemas["DataRoomTreeDocument"];
export type DataRoomDocument = FundRoomSchemas["DataRoomDocument"];
export type DataRoomDocumentDetail = FundRoomSchemas["DataRoomDocumentDetail"];
export type DataRoomVersion = FundRoomSchemas["DataRoomVersion"];
export type DataRoomFolder = FundRoomSchemas["DataRoomFolder"];
export type DataRoomTrash = FundRoomSchemas["DataRoomTrash"];
export type DataRoomTemplate = FundRoomSchemas["DataRoomTemplate"];
export type DataRoomSettingsLike = FundRoomSchemas["DataRoomSettings"];
export type DataRoomUpload = FundRoomSchemas["DataRoomUpload"];

export const dataRoomTreeQuery = queryOptions({
  queryKey: ["data-room", "tree"],
  queryFn: () => call(api().GET("/data-room/tree")),
});

export function dataRoomDocumentQuery(id: string) {
  return queryOptions({
    queryKey: ["data-room", "document", id],
    queryFn: () => call(api().GET("/data-room/documents/{id}", { params: { path: { id } } })),
  });
}

export const dataRoomTrashQuery = queryOptions({
  queryKey: ["data-room", "trash"],
  queryFn: () => call(api().GET("/data-room/trash")),
});

export const dataRoomTemplatesQuery = queryOptions({
  queryKey: ["data-room", "templates"],
  queryFn: () => call(api().GET("/data-room/templates")),
});

export const dataRoomSettingsQuery = queryOptions({
  queryKey: ["data-room", "settings"],
  queryFn: () => call(api().GET("/data-room/settings")),
});
