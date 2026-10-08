import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";
import { api, call } from "./api.js";

/*
 * Data residency (E3.11, ADR-0059): where this workspace's data lives, as the host DECLARED it.
 * The product cannot see where a database or bucket physically is, so every location on these
 * screens is the operator's statement, and the copy says so. The regime in Legal settings
 * (`legal.privacyRegion`) is a different thing — which consent and notice rules apply — and the
 * page keeps the two visibly apart.
 */
export type Residency = FundRoomSchemas["Residency"];
export type ResidencyComponent = FundRoomSchemas["ResidencyComponent"];
export type ResidencySubProcessor = FundRoomSchemas["ResidencySubProcessor"];
export type ResidencyRelocation = FundRoomSchemas["ResidencyRelocation"];
export type Jurisdiction = FundRoomSchemas["Jurisdiction"];
export type VendorJurisdiction = FundRoomSchemas["VendorJurisdiction"];
export type MoveState = FundRoomSchemas["MoveState"];

export const residencyQuery = queryOptions({
  queryKey: ["residency"],
  queryFn: () => call(api().GET("/residency")),
});

export function jurisdictionLabel(j: VendorJurisdiction): string {
  switch (j) {
    case "eu":
      return m.residency_jurisdiction_eu();
    case "uk":
      return m.residency_jurisdiction_uk();
    case "ch":
      return m.residency_jurisdiction_ch();
    case "us":
      return m.residency_jurisdiction_us();
    case "ca":
      return m.residency_jurisdiction_ca();
    case "au":
      return m.residency_jurisdiction_au();
    case "varies":
      return m.residency_jurisdiction_varies();
    default:
      return m.residency_jurisdiction_other();
  }
}

export function componentLabel(component: ResidencyComponent["component"]): string {
  switch (component) {
    // E3.12: the AI model, present only when the host configured one.
    case "ai":
      return m.residency_component_ai();
    case "database":
      return m.residency_component_database();
    case "jobs":
      return m.residency_component_jobs();
    case "search":
      return m.residency_component_search();
    case "analytics":
      return m.residency_component_analytics();
    case "objectStorage":
      return m.residency_component_object_storage();
    case "backups":
      return m.residency_component_backups();
    case "email":
      return m.residency_component_email();
    case "telemetry":
      return m.residency_component_telemetry();
    case "virusScan":
      return m.residency_component_virus_scan();
    default:
      return m.residency_component_error_reporting();
  }
}

/** How a region reads: its label, else its code (a region without a label is still a region). */
export function regionName(region: { code: string; label: string }): string {
  return region.label.trim() === "" ? region.code : region.label;
}

/** Move states in the order a move walks through them (the terminal ones are not steps). */
export const MOVE_STEPS = [
  "requested",
  "exporting",
  "exported",
  "importing",
  "imported",
  "switched",
] as const satisfies readonly MoveState[];

/** A move that is over, one way or the other: nothing more will happen to it. */
export function isMoveOver(state: MoveState): boolean {
  return state === "retired" || state === "failed" || state === "cancelled";
}

/** After the switch the workspace lives in the target cell; the move can no longer be undone. */
export function isMoveSwitched(state: MoveState): boolean {
  return state === "switched" || state === "retired";
}

/** Cancel is the operator's until the target has finished importing (the server decides). */
export function isMoveCancellable(state: MoveState): boolean {
  return (
    state === "requested" || state === "exporting" || state === "exported" || state === "importing"
  );
}

export function moveStateLabel(state: MoveState): string {
  switch (state) {
    case "requested":
      return m.move_state_requested();
    case "exporting":
      return m.move_state_exporting();
    case "exported":
      return m.move_state_exported();
    case "importing":
      return m.move_state_importing();
    case "imported":
      return m.move_state_imported();
    case "switched":
      return m.move_state_switched();
    case "retired":
      return m.move_state_retired();
    case "failed":
      return m.move_state_failed();
    default:
      return m.move_state_cancelled();
  }
}

/**
 * How long ago `iso` was, in the reader's language ("3 minutes ago"), from `Intl` — no catalogue
 * copy to translate. Rounded to the largest unit that fits.
 */
export function formatAge(iso: string, now: number = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86_400), "day");
}

/** Only an https link is rendered as a link; anything else (a `javascript:` URL) stays text. */
export function safeHttpsUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
