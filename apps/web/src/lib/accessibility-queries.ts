import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/*
 * The workspace's accessibility statement (E2.8): public, so it is readable before sign-in.
 * The server answers with the published legal document of that kind, or the shipped template
 * rendered with the workspace's facts.
 */
export type AccessibilityStatement = FundRoomSchemas["AccessibilityStatement"];

export const accessibilityStatementQuery = queryOptions({
  queryKey: ["compliance", "accessibility-statement"],
  queryFn: () => call(api().GET("/compliance/accessibility-statement")),
  staleTime: 5 * 60_000,
});
