import {
  awsRegionLocation,
  isOperatorRunEndpoint,
  type Jurisdiction,
  type SubProcessorMeta,
} from "@fundroom/ports";

export { isOperatorRunEndpoint };

/*
 * E3.11: who holds the bytes when STORAGE_DRIVER=s3, for the residency page and the DPA's
 * sub-processor list. Decided from the configured endpoint and region only — never the bucket
 * name or a credential, which say nothing about location and must not reach a tenant.
 *
 *  - no endpoint, or an `amazonaws.com` one: AWS S3 in `S3_REGION`;
 *  - an endpoint the operator evidently runs (localhost, a private or link-local address, a
 *    single-label or `.local`/`.internal`/`.lan`/cluster host — Garage, MinIO, SeaweedFS next to
 *    the app): `null`, the operator's own infrastructure;
 *  - a few well-known S3-compatible providers whose hostnames name their region;
 *  - any other public endpoint: an unidentified provider with jurisdiction `varies`, rather
 *    than a guess — the operator has to declare it.
 */

const STORAGE_PURPOSE = "Object storage (uploaded documents, images, exports and backups of files)";
const STORAGE_DATA =
  "Every file the workspace stores: data-room documents, update attachments, logos, exports";

function vendor(
  name: string,
  location: string,
  jurisdiction: Jurisdiction | "varies",
  dpaUrl?: string,
): SubProcessorMeta {
  return {
    name,
    purpose: STORAGE_PURPOSE,
    dataProcessed: STORAGE_DATA,
    location,
    jurisdiction,
    ...(dpaUrl === undefined ? {} : { dpaUrl }),
  };
}

const SPACES: Readonly<Record<string, readonly [string, Jurisdiction]>> = {
  nyc3: ["New York, United States", "us"],
  sfo2: ["San Francisco, United States", "us"],
  sfo3: ["San Francisco, United States", "us"],
  ams3: ["Amsterdam, Netherlands", "eu"],
  fra1: ["Frankfurt, Germany", "eu"],
  lon1: ["London, United Kingdom", "uk"],
  tor1: ["Toronto, Canada", "ca"],
  syd1: ["Sydney, Australia", "au"],
  sgp1: ["Singapore", "other"],
  blr1: ["Bangalore, India", "other"],
};

/** The sub-processor behind an S3 configuration; `null` = the operator's own object store. */
export function s3SubProcessor(input: {
  readonly region?: string | undefined;
  readonly endpoint?: string | undefined;
}): SubProcessorMeta | null {
  let host: string | undefined;
  if (input.endpoint !== undefined) {
    try {
      host = new URL(input.endpoint).hostname.toLowerCase();
    } catch {
      host = undefined;
    }
    if (host === undefined || host.length === 0) {
      return vendor(
        "Object storage provider (S3-compatible, not identified)",
        "Not identified by the software",
        "varies",
      );
    }
  }
  if (host === undefined || host === "amazonaws.com" || host.endsWith(".amazonaws.com")) {
    const region =
      input.region ?? /(?:^|\.)s3[.-]([a-z]{2}(?:-gov)?-[a-z]+-\d)\./u.exec(host ?? "")?.[1];
    if (region === undefined) {
      return vendor(
        "Amazon Web Services, Inc. (Amazon S3)",
        "AWS (region not configured)",
        "varies",
      );
    }
    const where = awsRegionLocation(region);
    return vendor(
      "Amazon Web Services, Inc. (Amazon S3)",
      where.location,
      where.jurisdiction,
      "https://d1.awsstatic.com/legal/aws-dpa/aws-dpa.pdf",
    );
  }
  if (isOperatorRunEndpoint(host)) return null;
  const dpa = "https://www.cloudflare.com/cloudflare-customer-dpa/";
  if (host.endsWith(".r2.cloudflarestorage.com")) {
    if (host.endsWith(".eu.r2.cloudflarestorage.com")) {
      return vendor("Cloudflare, Inc. (R2)", "European Union (R2 EU jurisdiction)", "eu", dpa);
    }
    if (host.endsWith(".fedramp.r2.cloudflarestorage.com")) {
      return vendor("Cloudflare, Inc. (R2)", "United States (R2 FedRAMP jurisdiction)", "us", dpa);
    }
    return vendor(
      "Cloudflare, Inc. (R2)",
      "Cloudflare's network (no jurisdiction pinned)",
      "varies",
      dpa,
    );
  }
  const b2 = /^s3\.([a-z]{2})-[a-z]+-\d{3}\.backblazeb2\.com$/u.exec(host);
  if (b2 !== null) {
    const j: Jurisdiction | "varies" = b2[1] === "us" ? "us" : b2[1] === "eu" ? "eu" : "varies";
    return vendor(
      "Backblaze, Inc. (B2)",
      j === "us" ? "United States" : j === "eu" ? "European Union" : "Backblaze B2",
      j,
    );
  }
  const spaces = /(?:^|\.)([a-z]{3}\d)\.digitaloceanspaces\.com$/u.exec(host);
  if (spaces !== null) {
    const known = SPACES[spaces[1] ?? ""];
    return vendor(
      "DigitalOcean, LLC (Spaces)",
      known?.[0] ?? `DigitalOcean ${spaces[1]}`,
      known?.[1] ?? "varies",
    );
  }
  if (/(?:^|\.)(fsn1|nbg1|hel1)\.your-objectstorage\.com$/u.test(host)) {
    return vendor("Hetzner Online GmbH (Object Storage)", "Germany or Finland", "eu");
  }
  if (/(?:^|\.)s3\.(fr-par|nl-ams|pl-waw)\.scw\.cloud$/u.test(host)) {
    return vendor(
      "Scaleway SAS (Object Storage)",
      "European Union (France, Netherlands or Poland)",
      "eu",
    );
  }
  return vendor(
    "Object storage provider (S3-compatible, not identified)",
    "Not identified by the software",
    "varies",
  );
}
