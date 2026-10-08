import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/*
 * Queries for the branding kernel routes (E1.7): the workspace brand with its derived theme
 * tokens and contrast report, and the module enablement checklist that sits beside it in the
 * admin tree.
 */
export type Branding = FundRoomSchemas["Branding"];
export type BrandLogo = FundRoomSchemas["BrandLogo"];
export type BrandTokens = FundRoomSchemas["BrandTokens"];
export type ContrastFinding = FundRoomSchemas["ContrastFinding"];
export type BrandFont = Branding["fontFamily"];
export type BrandRadius = Branding["radius"];
export type ModuleEnablement = FundRoomSchemas["ModuleEnablement"];

/** Every bundled font stack, in the order the form offers them. */
export const BRAND_FONTS = [
  "system",
  "humanist",
  "geometric",
  "serif",
  "slab",
  "mono",
] as const satisfies readonly BrandFont[];

export const BRAND_RADII = ["sharp", "soft", "round"] as const satisfies readonly BrandRadius[];

/** Content types `POST /branding/logo` accepts; SVG is refused server-side as a script carrier. */
export const LOGO_ACCEPT = "image/png,image/jpeg,image/webp";

export const brandingQuery = queryOptions({
  queryKey: ["branding"],
  queryFn: () => call(api().GET("/branding")),
});

export const moduleEnablementQuery = queryOptions({
  queryKey: ["modules", "enablement"],
  queryFn: () => call(api().GET("/modules/enablement")),
});
