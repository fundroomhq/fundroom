import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/*
 * Queries for the cap table module (E3.6 §8).
 *
 * **Every share count, amount and percentage is a decimal string.** `numeric(24, 6)` share
 * counts and `numeric(20, 6)` principal amounts do not survive a round trip through a double,
 * and a cap table is exactly the place somebody would notice a share going missing. The server
 * computes every total and every "% fully diluted"; the web app only prints them
 * (`modules/captable/format.ts`), and never adds, subtracts or compares two of them.
 */

export const CAPTABLE_FORMATS = ["template", "carta", "pulley"] as const;
export type CaptableFormat = (typeof CAPTABLE_FORMATS)[number];

export const CAPTABLE_INVESTOR_VIEWS = ["own_line", "summary", "none"] as const;
export type CaptableInvestorView = (typeof CAPTABLE_INVESTOR_VIEWS)[number];

export type CaptableSource = FundRoomSchemas["CaptableSnapshotSource"];
export type CaptableSnapshotStatus = FundRoomSchemas["CaptableSnapshotStatus"];
export type CaptableSecurityKind = FundRoomSchemas["CaptableSecurityKind"];
export type CaptableCurrencyAmount = FundRoomSchemas["CaptableCurrencyAmount"];
export type CaptableClassSummary = FundRoomSchemas["CaptableClassSummary"];
export type CaptableOptionPool = FundRoomSchemas["CaptableOptionPool"];
export type CaptableConvertible = FundRoomSchemas["CaptableConvertible"];
export type CaptableSummary = FundRoomSchemas["CaptableSummary"];
export type CaptableSnapshot = FundRoomSchemas["CaptableSnapshot"];
export type CaptableSnapshotList = FundRoomSchemas["CaptableSnapshotList"];
export type CaptableHolder = FundRoomSchemas["CaptableHolder"];
export type CaptableHolding = FundRoomSchemas["CaptableHolding"];
export type CaptableSnapshotDetail = FundRoomSchemas["CaptableSnapshotDetail"];
/** Request bodies are inlined in the OpenAPI document (not components), so these two are spelled out. */
export interface CaptableImportBody {
  readonly format: CaptableFormat;
  readonly csv: string;
  readonly asOf: string;
  readonly note?: string;
}
/** A warning, or one of a refusal's `problems` (same shape): where, then what. */
export type CaptableImportProblem = FundRoomSchemas["CaptableImportWarning"];
export type CaptableImportLine = FundRoomSchemas["CaptableImportLine"];
export type CaptableImportPreview = FundRoomSchemas["CaptableImportPreview"];
export type CaptableImportResult = FundRoomSchemas["CaptableImportResult"];
export type CaptableSettings = FundRoomSchemas["CaptableSettings"];
export interface CaptableSettingsBody {
  readonly investorView: CaptableInvestorView;
  readonly disclaimer: string | null;
}
export type CaptableMyHolding = FundRoomSchemas["CaptableMyHolding"];
export type CaptableInvestorShareBucket = FundRoomSchemas["CaptableInvestorShareBucket"];
export type CaptableInvestorConvertiblesBucket =
  FundRoomSchemas["CaptableInvestorConvertiblesBucket"];
export type CaptableInvestorSummary = FundRoomSchemas["CaptableInvestorSummary"];
export type CaptableMe = FundRoomSchemas["CaptableMe"];

// --- queries ------------------------------------------------------------------------------------

export const captableSnapshotsQuery = queryOptions({
  queryKey: ["captable", "snapshots"],
  queryFn: () => call(api().GET("/captable/snapshots")).then((r) => r.snapshots),
});

export function captableSnapshotQuery(id: string) {
  return queryOptions({
    queryKey: ["captable", "snapshots", id],
    queryFn: () =>
      call(
        api().GET("/captable/snapshots/{id}", {
          params: { path: { id } },
        }),
      ),
  });
}

export const captableSettingsQuery = queryOptions({
  queryKey: ["captable", "settings"],
  queryFn: () => call(api().GET("/captable/settings")),
});

export const captableMeQuery = queryOptions({
  queryKey: ["captable", "me"],
  queryFn: () => call(api().GET("/captable/me")),
});
