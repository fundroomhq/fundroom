import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { api, call } from "./api.js";

/*
 * Self-service signup (E3.10, ADR-0058 §5.7): `/api/v1/signup/*` on the canonical host, only
 * with SIGNUP_MODE=open (`config.signup`). `start` answers `{ ok: true }` whatever the address
 * is and `verify` never says whether it already had an account, so nothing here can either.
 */
export type SignupComplete = FundRoomSchemas["SignupComplete"];

/** The same rule as the server's `SlugSchema`: a lower-case DNS label, not version-shaped. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const RESERVED_SLUG_RE = /^(?:v\d+|\d+\.\d+\.\d+)$/u;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug) && !RESERVED_SLUG_RE.test(slug);
}

/** A company name as a workspace address: "Acme Böhm & Co." → "acme-bohm-co". */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 63)
    .replace(/-+$/u, "");
}

/**
 * The host the new workspace will live on. In multi-tenant mode every workspace has
 * `<slug>.<canonical host>` (a custom domain comes later, from its own admin screen).
 */
export function previewHost(slug: string, canonicalOrigin: string): string {
  let host: string;
  try {
    host = new URL(canonicalOrigin).host;
  } catch {
    return slug;
  }
  return `${slug}.${host}`;
}

/**
 * `GET /signup/slug?slug=` — slugs are public hostnames, so availability is not a secret; the
 * server still rate-limits it per IP, which is why the form debounces before asking.
 */
export function slugAvailabilityQuery(slug: string) {
  return queryOptions({
    queryKey: ["signup", "slug", slug] as const,
    queryFn: () => call(api().GET("/signup/slug", { params: { query: { slug } } })),
    staleTime: 10_000,
  });
}

/*
 * ISO 3166-1 alpha-2 codes, named in the reader's language by `Intl.DisplayNames` at render
 * time — the list itself is data, not copy. The company's country of registration (for the
 * host's sanctions screening and invoicing), not the person's.
 */
export const COUNTRY_CODES: readonly string[] = `
  AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI
  BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN
  CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK
  FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM
  HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN
  KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK
  ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP
  NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW
  SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF
  TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI
  VN VU WF WS YE YT ZA ZM ZW
`
  .trim()
  .split(/\s+/u);

/** `[code, name]` pairs sorted by name in `locale`; a code the runtime cannot name keeps its code. */
export function countryOptions(locale: string): { code: string; name: string }[] {
  let names: Intl.DisplayNames | undefined;
  try {
    names = new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    names = undefined;
  }
  const collator = new Intl.Collator(locale);
  return COUNTRY_CODES.map((code) => ({ code, name: names?.of(code) ?? code })).sort((a, b) =>
    collator.compare(a.name, b.name),
  );
}

/*
 * E3.11: where the new workspace's data can live. Each region is a cell; one served by another
 * deployment has its own sign-up page (`signupUrl`), `null` is this origin. The server lists only
 * active cells that take sign-ups, and 404s when signup is off (so does this page).
 */
export type SignupRegion = FundRoomSchemas["SignupRegion"];

export const signupRegionsQuery = queryOptions({
  queryKey: ["signup", "regions"] as const,
  queryFn: () => call(api().GET("/signup/regions")),
  staleTime: 5 * 60_000,
});

/** A region's sign-up page elsewhere, only as an https URL (anything else is not offered). */
export function regionSignupHref(region: SignupRegion): string | null {
  if (region.signupUrl === null) return null;
  try {
    const url = new URL(region.signupUrl);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/*
 * A-5: the plans a new workspace can start on — the host's public, unarchived plans, in the
 * host's order (`GET /signup/plans`, 404 when signup is closed). No prices: the product stores
 * only the provider's price ids, so the host's own site is where prices are shown. `paid`: the
 * plan has a provider price AND the install sells it by self-serve checkout (false under manual
 * billing, priced or not); a paid plan with no trial lands the founder on the billing page first.
 */
export type SignupPlan = FundRoomSchemas["SignupPlan"];

export const signupPlansQuery = queryOptions({
  queryKey: ["signup", "plans"] as const,
  queryFn: () => call(api().GET("/signup/plans")),
  staleTime: 60_000,
});

/** The same rule as the server's `PlanIdSchema`. */
const PLAN_ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/u;

export function isPlanId(value: string): boolean {
  return PLAN_ID_RE.test(value);
}

/**
 * The plan the form starts on: the one the link asked for (`/signup?plan=`) when the host offers
 * it, else the first that needs no checkout to start (not `paid`, or with a trial), else none — then
 * no `planId` is sent and the server starts the workspace on its default plan.
 */
export function initialPlan(
  plans: readonly SignupPlan[],
  requested: string | undefined,
): string | undefined {
  const asked = plans.find((p) => p.id === requested);
  if (asked !== undefined) return asked.id;
  return plans.find((p) => !p.paid || p.trialDays > 0)?.id;
}
