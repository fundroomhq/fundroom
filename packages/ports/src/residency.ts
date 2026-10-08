/**
 * Per-tenant data residency (EXECUTION_PLAN §15 E3.11, ADR-0059): the normalised facts every
 * residency surface (the tenant's residency page, the DPA's data-location annex and sub-processor
 * list) is built from.
 *
 * Every location here is OPERATOR-DECLARED: the product cannot verify where a database or bucket
 * physically is, so each surface says so.
 */

/** Legal jurisdictions a region (or a vendor) may declare. Mirrored in `@fundroom/config`. */
export const JURISDICTIONS = ["eu", "uk", "ch", "us", "ca", "au", "other"] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];

/** One normalised sub-processor fact. Every adapter that sends tenant data to a third party declares one. */
export interface SubProcessorMeta {
  readonly name: string;
  readonly purpose: string;
  readonly dataProcessed: string;
  /** Human text, e.g. "United States". */
  readonly location: string;
  /** Machine value used for out-of-region flags; `varies` = a global edge or per-request routing. */
  readonly jurisdiction: Jurisdiction | "varies";
  /** e.g. "EU SCCs (Module 3)", "UK IDTA". */
  readonly transferMechanism?: string | undefined;
  readonly dpaUrl?: string | undefined;
  readonly certifications?: readonly string[] | undefined;
}

/** Well-known AWS region names; anything else renders as its code. Widely published, not verified. */
const AWS_REGION_PLACES: Readonly<Record<string, readonly [string, Jurisdiction]>> = {
  "us-east-1": ["N. Virginia, United States", "us"],
  "us-east-2": ["Ohio, United States", "us"],
  "us-west-1": ["N. California, United States", "us"],
  "us-west-2": ["Oregon, United States", "us"],
  "ca-central-1": ["Montreal, Canada", "ca"],
  "ca-west-1": ["Calgary, Canada", "ca"],
  "eu-west-1": ["Ireland", "eu"],
  "eu-west-2": ["London, United Kingdom", "uk"],
  "eu-west-3": ["Paris, France", "eu"],
  "eu-central-1": ["Frankfurt, Germany", "eu"],
  "eu-central-2": ["Zurich, Switzerland", "ch"],
  "eu-north-1": ["Stockholm, Sweden", "eu"],
  "eu-south-1": ["Milan, Italy", "eu"],
  "eu-south-2": ["Spain", "eu"],
  "ap-southeast-2": ["Sydney, Australia", "au"],
  "ap-southeast-4": ["Melbourne, Australia", "au"],
};

/**
 * Where an AWS region is, for adapters that send data to AWS (SES, S3). A region missing from
 * the table still gets a jurisdiction from its prefix where that is unambiguous (`us-gov-*`,
 * `us-*`, `ca-*`), else `other` — never a guess at a country.
 */
export function awsRegionLocation(region: string): {
  readonly location: string;
  readonly jurisdiction: Jurisdiction;
} {
  const known = AWS_REGION_PLACES[region];
  if (known !== undefined)
    return { location: `AWS ${region} (${known[0]})`, jurisdiction: known[1] };
  const jurisdiction: Jurisdiction = region.startsWith("us-")
    ? "us"
    : region.startsWith("ca-")
      ? "ca"
      : "other";
  return { location: `AWS ${region}`, jurisdiction };
}

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host);
  if (m === null) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

function isPrivateIpv6(host: string): boolean {
  const h = host.replace(/^\[|\]$/gu, "").toLowerCase();
  if (!h.includes(":")) return false;
  return h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80:");
}

/**
 * True when a hostname is evidently infrastructure the operator runs next to the app: localhost,
 * a private / loopback / link-local / CGNAT address, a single-label name (a compose or k8s
 * service) or a `.local`/`.internal`/`.lan`/`.svc` name. Used by adapters (S3, SMTP, clamd) to
 * tell "the operator's own" from a third party; a public name is never assumed to be the
 * operator's.
 */
export function isOperatorRunEndpoint(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isPrivateIpv4(h) || isPrivateIpv6(h)) return true;
  if (!h.includes(".") && !h.includes(":")) return true; // a compose/k8s service name
  return /\.(local|internal|lan|home\.arpa|svc|cluster\.local)$/u.test(h);
}
