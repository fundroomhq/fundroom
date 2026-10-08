import {
  type AccreditationAdapterDefinition,
  type AccreditationAdapterDeps,
  type AccreditationConnectionConfig,
  type AccreditationCredentialField,
  type AccreditationEvidence,
  AccreditationProviderError,
  type AccreditationVendorCheck,
  type AccreditationVendorMeta,
  type AccreditationVendorPort,
  type AccreditationVendorStartResult,
  type AccreditationVendorStatus,
} from "@fundroom/ports";
import {
  asDate,
  asRecord,
  asString,
  bytesEqual,
  clip,
  decoyKey,
  fetchFailure,
  hmacSha256,
  isPdf,
  MAX_EVIDENCE_BYTES,
  parseJsonObject,
  readBounded,
  readJson,
  statusFailure,
  vendorMessage,
} from "./http.js";

/**
 * AccreditationVendorPort over the Parallel Markets (iCapital Identity Solutions) Server API v2.
 * Shapes follow the vendor's OpenAPI document v2.1.1 (`parallel-api.swagger.yml`) and the
 * developer docs (https://developer.parallelmarkets.com) — see README.md for what was inferred.
 *
 * Flow: `start()` pre-creates a partner record (`POST /partner-records/individuals|businesses`,
 * "profile-first") and answers a `widget` handoff; the investor completes accreditation in
 * Parallel's JS SDK on our handoff page with `required_entity_id` = that record id. The provider
 * ref is the record id; callbacks name it as `entity.id`.
 *
 * Which accreditation answers `check()`: a record can hold several accreditation attempts. If any
 * is `current`, the most recently certified one (`certified_at`, else `created_at`) answers — not
 * the one expiring last, so a renewal with a shorter-lived basis is still seen; otherwise the most
 * recently created attempt answers.
 * With no attempt (or only an unsubmitted one) the record's `details.indicated_unaccredited_at`
 * (the investor told Parallel they are not accredited) answers `not_accredited`.
 *
 * | Parallel accreditation.status         | port                  |
 * |---------------------------------------|-----------------------|
 * | (no attempt yet)                      | in_progress (vendorStatus `no_accreditation`) |
 * | unsubmitted                           | in_progress           |
 * | submitter_pending, third_party_pending| needs_investor_action |
 * | pending                               | under_review          |
 * | current                               | accredited            |
 * | rejected                              | not_accredited        |
 * | expired                               | expired               |
 * | canceled                              | canceled              |
 * | (record indicated_unaccredited_at)    | not_accredited (vendorStatus `indicated_unaccredited`) |
 * | anything else                         | unknown               |
 */

const VENDOR = "Parallel Markets";
const DRIVER = "parallel-markets" as const;

const API_ROOT = {
  production: "https://api.parallelmarkets.com/v2",
  demo: "https://demo-api.parallelmarkets.com/v2",
} as const;

export const TIMESTAMP_HEADER = "parallel-timestamp";
export const SIGNATURE_HEADER = "parallel-signature";
/** Parallel recommends checking the timestamp is recent; we allow ±5 minutes of clock skew. */
export const CALLBACK_SKEW_MS = 5 * 60 * 1000;
/** Accreditation pages followed per check (each page is one authenticated GET). */
export const MAX_PAGES = 5;
const MAX_REFS = 20;

export const parallelMarketsMeta: AccreditationVendorMeta = {
  driver: DRIVER,
  label: "Parallel Markets",
  handoff: "widget",
  supportsEntities: true,
  certificate: true,
  callbackSignature:
    "Parallel-Timestamp + Parallel-Signature (base64 HMAC-SHA256 over timestamp + body, base64-decoded webhook key)",
  subProcessor: {
    name: "Parallel Markets (iCapital Identity Solutions, Institutional Capital Network, Inc.)",
    purpose:
      "Accredited-investor verification under Rule 506(c): investor identity and accreditation flow, reviewer decision, certification letter",
    location: "United States",
    url: "https://parallelmarkets.com",
    jurisdiction: "us",
  },
};

export const parallelMarketsCredentialFields: readonly AccreditationCredentialField[] = [
  {
    key: "apiKey",
    label: "API key",
    kind: "secret",
    required: true,
    help: "Parallel dashboard → Developer → API keys (shown once). Demo and production keys differ.",
  },
  {
    key: "clientId",
    label: "Client ID",
    kind: "text",
    required: true,
    help: "The JS SDK client_id. Register the handoff URL shown here as the client's redirect URI.",
  },
  {
    key: "webhookSigningKey",
    label: "Webhook signing key",
    kind: "secret",
    required: false,
    help: "Dashboard → Webhooks: set the callback URL shown here and paste the signing key (base64). Without it the status is polled only.",
  },
  {
    key: "environment",
    label: "Environment",
    kind: "select",
    options: ["demo", "production"],
    required: true,
    help: "Demo (sandbox) for testing; production records are billed to your Parallel account.",
  },
];

/** Parallel ids are opaque base64-ish strings (e.g. `VXNlcjox`). */
const ID_RE = /^[A-Za-z0-9+/=_-]{1,200}$/u;

export function mapParallelStatus(status: string): AccreditationVendorStatus {
  switch (status) {
    case "current":
      return "accredited";
    case "pending":
      return "under_review";
    case "submitter_pending":
    case "third_party_pending":
      return "needs_investor_action";
    case "unsubmitted":
      return "in_progress";
    case "rejected":
      return "not_accredited";
    case "expired":
      return "expired";
    case "canceled":
      return "canceled";
    default:
      return "unknown";
  }
}

interface AccreditationView {
  readonly status: string;
  readonly createdAt: Date | undefined;
  readonly expiresAt: Date | undefined;
  readonly certifiedAt: Date | undefined;
  readonly rejectedAt: Date | undefined;
  readonly canceledAt: Date | undefined;
  readonly assertion: string | undefined;
  readonly rejectionReason: string | undefined;
  readonly letterUrl: string | undefined;
}

function parseAccreditation(value: unknown): AccreditationView | undefined {
  const a = asRecord(value);
  const status = asString(a?.["status"]);
  if (a === undefined || status === undefined) return undefined;
  const docs = Array.isArray(a["documents"]) ? a["documents"] : [];
  const letter = docs
    .map((d) => asRecord(d))
    .find((d) => d?.["type"] === "certification-letter" && typeof d["download_url"] === "string");
  return {
    status,
    createdAt: asDate(a["created_at"]) ?? asDate(a["started_at"]),
    expiresAt: asDate(a["expires_at"]),
    certifiedAt: asDate(a["certified_at"]),
    rejectedAt: asDate(a["rejected_at"]),
    canceledAt: asDate(a["canceled_at"]),
    assertion: asString(a["assertion_type"]),
    rejectionReason: asString(a["rejection_reason"]),
    letterUrl: asString(letter?.["download_url"]),
  };
}

const time = (d: Date | undefined): number => d?.getTime() ?? Number.NEGATIVE_INFINITY;

/** The attempt that answers for the record (see the file comment). */
export function pickAccreditation<
  T extends Pick<AccreditationView, "status" | "createdAt" | "certifiedAt">,
>(list: readonly T[]): T | undefined {
  const current = list.filter((a) => a.status === "current");
  const pool = current.length > 0 ? current : list;
  // Among current attempts the most recently certified wins — NOT the latest expiry: a renewal
  // certified on a shorter-lived basis is still the vendor's latest word on the investor.
  const key = (a: T): number =>
    current.length > 0 ? time(a.certifiedAt ?? a.createdAt) : time(a.createdAt);
  let best: T | undefined;
  for (const a of pool) if (best === undefined || key(a) >= key(best)) best = a;
  return best;
}

function toCheck(a: AccreditationView): AccreditationVendorCheck {
  const status = mapParallelStatus(a.status);
  const decidedAt =
    status === "accredited"
      ? a.certifiedAt
      : status === "not_accredited"
        ? a.rejectedAt
        : status === "canceled"
          ? a.canceledAt
          : undefined;
  return {
    status,
    vendorStatus: clip(a.status, 100),
    ...(a.expiresAt === undefined || (status !== "accredited" && status !== "expired")
      ? {}
      : { expiresAt: a.expiresAt }),
    ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(a.assertion === undefined ? {} : { assertion: clip(a.assertion, 100) }),
    ...(status === "not_accredited" && a.rejectionReason !== undefined
      ? { rejectionReason: clip(a.rejectionReason, 200) }
      : {}),
  };
}

/** Standard base64 of exactly 32 bytes (an HMAC-SHA256 digest), or undefined. */
function decodeSignature(header: string): Uint8Array | undefined {
  const value = header.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(value)) return undefined;
  const bytes = Buffer.from(value, "base64");
  return bytes.byteLength === 32 ? bytes : undefined;
}

export function createParallelMarketsPort(
  config: AccreditationConnectionConfig,
  deps: AccreditationAdapterDeps,
): AccreditationVendorPort {
  const apiKey = config.credentials["apiKey"] ?? "";
  const clientId = (config.credentials["clientId"] ?? "").trim();
  const signingKey = config.credentials["webhookSigningKey"] ?? "";
  const environment = config.credentials["environment"] === "production" ? "production" : "demo";
  const root = (() => {
    if (deps.apiBaseUrl === undefined) return API_ROOT[environment];
    const base = deps.apiBaseUrl.replace(/\/+$/u, "");
    return base.endsWith("/v2") ? base : `${base}/v2`;
  })();
  const secrets = [apiKey, signingKey].filter((s) => s.length > 0);
  const decoy = decoyKey();
  const decoySignature = new Uint8Array(32);

  const send = async (op: string, method: string, path: string, body?: unknown) => {
    if (apiKey.length === 0) {
      throw new AccreditationProviderError(
        `${VENDOR} ${op}: no API key configured`,
        "unauthorized",
        false,
      );
    }
    try {
      return await deps.fetch(`${root}${path}`, {
        method,
        redirect: "manual",
        headers: {
          authorization: `Bearer ${apiKey}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw fetchFailure(VENDOR, op, err);
    }
  };

  const fail = async (op: string, res: Response): Promise<never> => {
    const detail =
      res.status >= 400 && res.status < 500 && res.status !== 401 && res.status !== 403
        ? await vendorMessage(res, secrets)
        : undefined;
    if (detail === undefined) await res.body?.cancel().catch(() => {});
    throw statusFailure(VENDOR, op, res.status, detail);
  };

  const call = async (op: string, method: string, path: string, body?: unknown) => {
    const res = await send(op, method, path, body);
    if (res.status !== 200 && res.status !== 201) return fail(op, res);
    return readJson(res, VENDOR, op);
  };

  const recordPath = (op: string, providerRef: string): string => {
    if (!ID_RE.test(providerRef)) {
      throw new AccreditationProviderError(
        `${VENDOR} ${op}: not a Parallel record id`,
        "not_found",
        false,
      );
    }
    return `/partner-records/${encodeURIComponent(providerRef)}`;
  };

  const listAccreditations = async (op: string, providerRef: string) => {
    const base = `${recordPath(op, providerRef)}/accreditations`;
    const out: AccreditationView[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const answer = asRecord(
        await call(
          op,
          "GET",
          cursor === undefined ? base : `${base}?cursor=${encodeURIComponent(cursor)}`,
        ),
      );
      if (answer === undefined || !Array.isArray(answer["data"])) {
        throw new AccreditationProviderError(
          `${VENDOR} ${op}: unexpected accreditation list shape`,
          "unavailable",
          false,
        );
      }
      for (const item of answer["data"]) {
        const a = parseAccreditation(item);
        if (a !== undefined) out.push(a);
      }
      const next = asString(asRecord(answer["pagination"])?.["next_cursor"]);
      if (next === undefined || next.length === 0 || next === cursor) break;
      cursor = next;
    }
    return out;
  };

  /** Exact-email match among existing individual records (profile-first 409 recovery). */
  const findIndividualByEmail = async (email: string): Promise<string | undefined> => {
    const answer = asRecord(
      await call(
        "start",
        "GET",
        `/partner-records/individuals?archived=false&email=${encodeURIComponent(email)}`,
      ),
    );
    const list = Array.isArray(answer?.["data"]) ? answer["data"] : [];
    const wanted = email.toLowerCase();
    for (const item of list) {
      const r = asRecord(item);
      const id = asString(r?.["id"]);
      const mail = asString(asRecord(r?.["details"])?.["email"]);
      if (id !== undefined && ID_RE.test(id) && mail?.toLowerCase() === wanted) return id;
    }
    return undefined;
  };

  return {
    driver: DRIVER,

    async verifyCredentials(): Promise<void> {
      // A small static enumeration behind the API key: the cheapest authenticated read.
      await call("verify", "GET", "/partner-records/file-types");
    },

    async start(input): Promise<AccreditationVendorStartResult> {
      const email = input.email.trim();
      if (email.length === 0 || email.length > 254) {
        throw new AccreditationProviderError(
          `${VENDOR} start: an investor email is required`,
          "invalid_request",
          false,
        );
      }
      if (clientId.length === 0) {
        throw new AccreditationProviderError(
          `${VENDOR} start: no client id configured`,
          "invalid_request",
          false,
        );
      }
      const firstName = input.firstName?.trim() || undefined;
      const lastName = input.lastName?.trim() || undefined;
      const entity = input.subject === "entity";
      const op = "start";
      let recordId: string | undefined;
      let reused = false;
      if (entity) {
        const name = (input.legalName ?? "").trim();
        if (name.length === 0) {
          throw new AccreditationProviderError(
            `${VENDOR} start: an entity needs a legal name`,
            "invalid_request",
            false,
          );
        }
        const created = asRecord(
          await call(op, "POST", "/partner-records/businesses", { name: name.slice(0, 200) }),
        );
        recordId = asString(asRecord(created?.["data"])?.["id"]);
      } else {
        const res = await send(op, "POST", "/partner-records/individuals", {
          email,
          ...(firstName === undefined ? {} : { first_name: firstName.slice(0, 100) }),
          ...(lastName === undefined ? {} : { last_name: lastName.slice(0, 100) }),
        });
        if (res.status === 409 || res.status === 422) {
          // The vendor does not document a duplicate answer; if it refuses a second record for
          // the same email, reuse the existing one (the accreditation belongs to the person).
          const detail = await vendorMessage(res, secrets);
          recordId = await findIndividualByEmail(email);
          if (recordId === undefined) throw statusFailure(VENDOR, op, res.status, detail);
          reused = true;
        } else if (res.status !== 200 && res.status !== 201) {
          return fail(op, res);
        } else {
          recordId = asString(
            asRecord(asRecord(await readJson(res, VENDOR, op))?.["data"])?.["id"],
          );
        }
      }
      if (recordId === undefined || !ID_RE.test(recordId)) {
        throw new AccreditationProviderError(
          `${VENDOR} start: unexpected record response`,
          "unavailable",
          false,
        );
      }
      return {
        providerRef: recordId,
        handoff: {
          kind: "widget",
          sdk: "parallel-markets",
          config: {
            clientId,
            environment,
            requiredEntityId: recordId,
            email,
            ...(firstName === undefined ? {} : { firstName }),
            ...(lastName === undefined ? {} : { lastName }),
            entityType: entity ? "business" : "self",
          },
        },
        // `record_reused`: the person already had a record (renewal) — it may already carry a
        // current accreditation, so the first check can answer a decision straight away.
        vendorStatus: reused ? "record_reused" : "record_created",
      };
    },

    async check({ providerRef }): Promise<AccreditationVendorCheck> {
      const list = await listAccreditations("check", providerRef);
      const chosen = pickAccreditation(list);
      if (chosen === undefined || chosen.status === "unsubmitted") {
        const record = asRecord(await call("check", "GET", recordPath("check", providerRef)));
        const details =
          asRecord(record?.["details"]) ?? asRecord(asRecord(record?.["data"])?.["details"]);
        const indicated = asDate(details?.["indicated_unaccredited_at"]);
        if (indicated !== undefined && indicated.getTime() >= time(chosen?.createdAt)) {
          return {
            status: "not_accredited",
            vendorStatus: "indicated_unaccredited",
            decidedAt: indicated,
          };
        }
        if (chosen === undefined)
          return { status: "in_progress", vendorStatus: "no_accreditation" };
      }
      return toCheck(chosen);
    },

    async fetchEvidence({ providerRef }): Promise<AccreditationEvidence | null> {
      const op = "evidence";
      const chosen = pickAccreditation(await listAccreditations(op, providerRef));
      if (chosen === undefined || chosen.status !== "current" || chosen.letterUrl === undefined) {
        return null;
      }
      // The letter URL carries its own ~30 s token and usually points at a storage host: it is
      // fetched at once, through the guarded client, and never with our API key.
      let target: URL;
      try {
        target = new URL(chosen.letterUrl);
      } catch {
        throw new AccreditationProviderError(
          `${VENDOR} ${op}: vendor returned an invalid URL`,
          "unavailable",
          false,
        );
      }
      const apiIsHttps = root.startsWith("https:");
      if (target.protocol !== "https:" && !(target.protocol === "http:" && !apiIsHttps)) {
        throw new AccreditationProviderError(
          `${VENDOR} ${op}: vendor returned a non-https URL`,
          "unavailable",
          false,
        );
      }
      let res: Response;
      try {
        res = await deps.fetch(target.toString(), {
          method: "GET",
          redirect: "manual",
          headers: { accept: "application/pdf" },
        });
      } catch (err) {
        throw fetchFailure(VENDOR, op, err);
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        // An expired download token answers 4xx; a retry lists again and gets a fresh URL.
        throw new AccreditationProviderError(
          `${VENDOR} ${op}: letter download failed (HTTP ${res.status})`,
          res.status === 429 ? "rate_limited" : "unavailable",
          true,
          res.status,
        );
      }
      const bytes = await readBounded(res, MAX_EVIDENCE_BYTES, VENDOR, op);
      if (!isPdf(bytes)) {
        throw new AccreditationProviderError(
          `${VENDOR} ${op}: certification letter is not a PDF`,
          "unavailable",
          false,
        );
      }
      return { contentType: "application/pdf", bytes };
    },

    async parseCallback({ headers, rawBody, now }) {
      try {
        // Always spend one HMAC (decoy key when no usable key) and one compare, whatever the input.
        const realKey = signingKey.length > 0 ? Buffer.from(signingKey, "base64") : undefined;
        const usable = realKey !== undefined && realKey.byteLength > 0;
        const ts = headers.get(TIMESTAMP_HEADER)?.trim() ?? null;
        const sig = headers.get(SIGNATURE_HEADER);
        const tsOk = ts !== null && /^[0-9]{1,12}$/u.test(ts);
        const timestamp = tsOk ? ts : "0";
        const message = Buffer.concat([Buffer.from(timestamp, "utf8"), rawBody]);
        const expected = hmacSha256(usable ? realKey : decoy, message);
        const given = sig === null ? undefined : decodeSignature(sig);
        const matches = bytesEqual(given ?? decoySignature, expected);
        if (!usable || !tsOk || given === undefined || !matches) return undefined;
        if (Math.abs(now.getTime() - Number(timestamp) * 1000) > CALLBACK_SKEW_MS) return undefined;
        const body = parseJsonObject(rawBody);
        if (body === undefined) return undefined;
        const id = asString(asRecord(body["entity"])?.["id"]);
        return { refs: id !== undefined && ID_RE.test(id) ? [id].slice(0, MAX_REFS) : [] };
      } catch {
        return undefined;
      }
    },
  };
}

export const parallelMarketsAdapter: AccreditationAdapterDefinition = {
  meta: parallelMarketsMeta,
  credentialFields: parallelMarketsCredentialFields,
  create: createParallelMarketsPort,
};
