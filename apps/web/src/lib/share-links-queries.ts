import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { offeringStatusLabel } from "../components/compliance/common.js";
import { m } from "../paraglide/messages.js";
import { api, call, describeError, isApiError } from "./api.js";

/*
 * Queries and refusal copy for the share-link kernel routes (E2.3, §9.3, ADR-0041).
 *
 * Two vocabularies that never meet, exactly as the server has them: the admin list and its
 * mutations are keyed on the link's **id**, and the visitor-facing resolve / start / verify are
 * keyed on its **token**. Only the admin half is cached — the public three are one-shot steps in
 * a sign-in ceremony, and a cached resolve would keep a dead token alive on screen.
 */
export type ShareLink = FundRoomSchemas["ShareLink"];
export type ShareLinkList = FundRoomSchemas["ShareLinkList"];
export type ShareLinkStatus = ShareLink["status"];
export type ShareLinkCreated = FundRoomSchemas["ShareLinkCreated"];
export type ShareLinkVisit = FundRoomSchemas["ShareLinkVisit"];
export type LinkPolicy = FundRoomSchemas["LinkPolicy"];
export type ShareLinkResolution = FundRoomSchemas["ShareLinkResolution"];
export type InviteGrant = FundRoomSchemas["InviteGrant"];

export const SHARE_LINKS_KEY = ["share-links"] as const;

/** Revoked links are omitted by default: the list is about live sharing (the server's default). */
export function shareLinksQuery(includeRevoked = false) {
  return queryOptions({
    queryKey: [...SHARE_LINKS_KEY, "list", includeRevoked] as const,
    queryFn: () =>
      call(
        api().GET("/links", {
          params: { query: { includeRevoked: includeRevoked ? "true" : "false" } },
        }),
      ),
  });
}

/** Who came in through one link. Only fetched when the admin opens that link's panel. */
export function shareLinkVisitsQuery(id: string, enabled: boolean) {
  return queryOptions({
    queryKey: [...SHARE_LINKS_KEY, "visits", id] as const,
    queryFn: () => call(api().GET("/links/{id}/visits", { params: { path: { id } } })),
    enabled,
  });
}

/**
 * Every `error.reason` the link routes attach. The admin half and the visitor half are listed
 * together because they are one server vocabulary; which of them a given screen can provoke is
 * a property of which routes it calls, not of the list.
 */
export const SHARE_LINK_ERROR_REASONS = [
  // Admin (`POST /links`), from `linkPolicyPermitted` and the grant validation.
  "links_not_permitted",
  "audience_too_open",
  "unknown_resource_kind",
  // Visitor (`POST /links/{token}/start`), from `checkPasscode` and `admits`.
  "passcode_required",
  "passcode_wrong",
  "passcode_locked",
  "email_not_allowed",
] as const;
export type ShareLinkErrorReason = (typeof SHARE_LINK_ERROR_REASONS)[number];

function detailOf(error: unknown, key: string): string | undefined {
  if (!isApiError(error)) return undefined;
  const value = error.body.error[key];
  return typeof value === "string" ? value : undefined;
}

export function shareLinkErrorReason(error: unknown): ShareLinkErrorReason | undefined {
  const reason = detailOf(error, "reason");
  return SHARE_LINK_ERROR_REASONS.find((r) => r === reason);
}

/**
 * One sentence per refusal.
 *
 * The two offering refusals are the point of the whole function: the server decides whether a
 * link may be issued at all and what shape it may take (ADR-0041 D6), and the browser renders
 * that answer rather than re-deriving Rule 506's audience rule — a second copy of a securities
 * rule in a language that cannot see the workspace's offering period is a copy that will be
 * wrong. `error.offeringStatus` travels with the refusal so the sentence can name the mode the
 * admin is actually in.
 */
export function describeShareLinkError(error: unknown): string {
  const status = detailOf(error, "offeringStatus");
  switch (shareLinkErrorReason(error)) {
    case "links_not_permitted":
      return status === undefined
        ? m.share_links_error_not_permitted()
        : m.share_links_error_not_permitted_named({ status: offeringStatusLabel(status) });
    case "audience_too_open":
      return status === undefined
        ? m.share_links_error_audience_too_open()
        : m.share_links_error_audience_too_open_named({ status: offeringStatusLabel(status) });
    case "unknown_resource_kind":
      return m.share_links_error_unknown_resource_kind();
    case "passcode_required":
      return m.share_link_error_passcode_required();
    case "passcode_wrong":
      return m.share_link_error_passcode_wrong();
    case "passcode_locked":
      return m.share_link_error_passcode_locked();
    case "email_not_allowed":
      return m.share_link_error_email_not_allowed();
    default:
      return describeError(error).body;
  }
}

/** `active` / `paused` / `revoked`, and the badge variant each deserves. */
export function shareLinkStatusLabel(status: ShareLinkStatus | string): string {
  switch (status) {
    case "active":
      return m.share_links_status_active();
    case "paused":
      return m.share_links_status_paused();
    case "revoked":
      return m.share_links_status_revoked();
    default:
      return status;
  }
}

export function shareLinkStatusVariant(
  status: ShareLinkStatus | string,
): "success" | "warning" | "destructive" | "outline" {
  switch (status) {
    case "active":
      return "success";
    case "paused":
      return "warning";
    case "revoked":
      return "destructive";
    default:
      return "outline";
  }
}

/**
 * True when the link has reached a cap. It is not the same as "revoked": an exhausted link
 * admits nobody new, and goes on working for everybody it already admitted (contract A6). The
 * screen has to say that, because "exhausted" reads like "off" and it is not.
 */
export function isExhausted(link: ShareLink): boolean {
  return (
    (link.maxUses !== null && link.uses >= link.maxUses) ||
    (link.maxViews !== null && link.views >= link.maxViews)
  );
}

/** `a@x.com, b@y.com` / newline separated → a trimmed, non-empty list, order preserved. */
export function splitList(value: string): string[] {
  return value
    .split(/[\n,;\s]+/u)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
