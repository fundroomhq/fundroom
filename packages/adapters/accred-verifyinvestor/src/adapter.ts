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
 * AccreditationVendorPort over the VerifyInvestor.com Regular API v1 (Invitation API for start,
 * verification requests for status, certificate PDF for evidence). Endpoint shapes come from the
 * vendor's API reference (https://www.verifyinvestor.com/api-docs) — see README.md for what was
 * inferred and needs a live staging check.
 *
 * Provider refs:
 * - `inv:<invitationId>` — an invitation whose investor has no VerifyInvestor account yet;
 * - `vr:<verificationRequestId>` — a verification request. `start()` answers `vr:` straight away
 *   when the investor already has an account (the Invitation API then creates the request at once);
 *   `check()` on an `inv:` ref answers `providerRef: "vr:<id>"` once the request exists.
 *
 * Status mapping (VerifyInvestor `status` → port):
 *
 * | VerifyInvestor                         | port                   |
 * |----------------------------------------|------------------------|
 * | (invitation, no request yet)           | needs_investor_action (vendorStatus `invitation_sent`) |
 * | (invitation 404, or >30 days old with no request) | canceled (vendorStatus `invitation_expired`) |
 * | waiting_for_investor_acceptance        | needs_investor_action  |
 * | accepted_by_investor                   | in_progress            |
 * | waiting_for_review, in_review          | under_review           |
 * | waiting_for_information_from_investor  | needs_investor_action  |
 * | accredited                             | accredited             |
 * | not_accredited                         | not_accredited         |
 * | accepted_expire, declined_expire       | canceled (the *request* lapsed unanswered; nothing was decided about the investor) |
 * | declined_by_investor                   | canceled               |
 * | self_not_accredited                    | canceled (the investor accepted then withdrew — the vendor's own wording; no reviewer decision) |
 * | anything else                          | unknown                |
 *
 * `expiresAt` comes from `verified_expires_at`, a calendar date (`YYYY-MM-DD`): the accreditation
 * is treated as standing through the END of that day, UTC (23:59:59.999Z). `decidedAt` is
 * `completed_at`, reported only for accredited / not_accredited.
 */

const VENDOR = "VerifyInvestor";
const DRIVER = "verifyinvestor" as const;

const API_ROOT = {
  production: "https://www.verifyinvestor.com/api/v1",
  staging: "https://verifyinvestor-staging.herokuapp.com/api/v1",
} as const;

export const SIGNATURE_HEADER = "x-signature-sha256";
const MAX_REFS = 20;

export const verifyInvestorMeta: AccreditationVendorMeta = {
  driver: DRIVER,
  label: "VerifyInvestor.com",
  handoff: "invite_email",
  supportsEntities: true,
  certificate: true,
  callbackSignature: "X-Signature-SHA256 (HMAC-SHA256 of the raw body with your webhook secret)",
  subProcessor: {
    name: "VerifyInvestor.com, LLC (a tZERO Group company)",
    purpose:
      "Accredited-investor verification under Rule 506(c): investor invitation email, document review by licensed reviewers, verification certificate",
    location: "United States",
    url: "https://www.verifyinvestor.com",
    jurisdiction: "us",
  },
};

export const verifyInvestorCredentialFields: readonly AccreditationCredentialField[] = [
  {
    key: "apiToken",
    label: "API token",
    kind: "secret",
    required: true,
    help: "VerifyInvestor.com → Settings → API Info → API Token (the private one, not the User Authorization Token). Staging and production tokens differ.",
  },
  {
    key: "webhookSecret",
    label: "Webhook secret",
    kind: "secret",
    required: false,
    help: "Settings → API Info → generate a webhook secret, and set the Webhook URL to the callback URL shown here. Without it the status is polled only.",
  },
  {
    key: "environment",
    label: "Environment",
    kind: "select",
    options: ["staging", "production"],
    required: true,
    help: "Staging (verifyinvestor-staging.herokuapp.com) for testing; production bills your account per verification.",
  },
  {
    key: "portalName",
    label: "Portal name",
    kind: "text",
    required: false,
    help: "Shown to investors as the requesting party. Defaults to the workspace name.",
  },
];

/** "Invitations expire after 30 days" (vendor docs). */
export const INVITATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const REF_RE = /^(inv|vr):([1-9][0-9]{0,15})$/u;

export function mapVerifyInvestorStatus(status: string): AccreditationVendorStatus {
  switch (status) {
    case "waiting_for_investor_acceptance":
    case "waiting_for_information_from_investor":
      return "needs_investor_action";
    case "accepted_by_investor":
      return "in_progress";
    case "waiting_for_review":
    case "in_review":
      return "under_review";
    case "accredited":
      return "accredited";
    case "not_accredited":
      return "not_accredited";
    case "accepted_expire":
    case "declined_expire":
    case "declined_by_investor":
    case "self_not_accredited":
      return "canceled";
    default:
      return "unknown";
  }
}

/** `YYYY-MM-DD` → end of that day UTC; a full timestamp is taken as is. */
export function parseVerifiedExpiresAt(value: unknown): Date | undefined {
  if (typeof value !== "string") return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (m !== null) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999));
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return asDate(value);
}

function idOf(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,15}$/u.test(value)) return value;
  return undefined;
}

/** Decode a signature header given as hex (64 chars) or base64 (with or without padding). */
function decodeSignature(header: string): Uint8Array | undefined {
  const value = header.trim().replace(/^sha256=/iu, "");
  if (/^[0-9a-f]{64}$/iu.test(value)) return Buffer.from(value, "hex");
  if (/^[A-Za-z0-9+/_-]{43}={0,1}$/u.test(value)) {
    const bytes = Buffer.from(value.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");
    return bytes.byteLength === 32 ? bytes : undefined;
  }
  return undefined;
}

interface RequestView {
  readonly id: string;
  readonly status: string;
  readonly investorId: string | undefined;
  readonly check: AccreditationVendorCheck;
}

export function createVerifyInvestorPort(
  config: AccreditationConnectionConfig,
  deps: AccreditationAdapterDeps,
): AccreditationVendorPort {
  const token = config.credentials["apiToken"] ?? "";
  const webhookSecret = config.credentials["webhookSecret"] ?? "";
  const portalName = (config.credentials["portalName"] ?? "").trim();
  const environment = config.credentials["environment"] === "production" ? "production" : "staging";
  const root = (() => {
    if (deps.apiBaseUrl === undefined) return API_ROOT[environment];
    const base = deps.apiBaseUrl.replace(/\/+$/u, "");
    return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
  })();
  const secrets = [token, webhookSecret].filter((s) => s.length > 0);
  const decoy = decoyKey();
  const decoySignature = new Uint8Array(32);

  const send = async (
    op: string,
    method: string,
    path: string,
    body: unknown,
    accept: string,
  ): Promise<Response> => {
    if (token.length === 0) {
      throw new AccreditationProviderError(
        `${VENDOR} ${op}: no API token configured`,
        "unauthorized",
        false,
      );
    }
    try {
      return await deps.fetch(`${root}${path}`, {
        method,
        redirect: "manual",
        headers: {
          authorization: `Token ${token}`,
          accept,
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

  const call = async (
    op: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    const res = await send(op, method, path, body, "application/json");
    if (res.status !== 200 && res.status !== 201) return fail(op, res);
    return readJson(res, VENDOR, op);
  };

  const parseRef = (op: string, providerRef: string): { kind: "inv" | "vr"; id: string } => {
    const m = REF_RE.exec(providerRef);
    if (m === null) {
      throw new AccreditationProviderError(
        `${VENDOR} ${op}: not a VerifyInvestor reference`,
        "not_found",
        false,
      );
    }
    return { kind: m[1] as "inv" | "vr", id: m[2] as string };
  };

  const viewRequest = (value: unknown, op: string): RequestView => {
    const r = asRecord(value);
    const id = idOf(r?.["id"]);
    const status = asString(r?.["status"]);
    if (r === undefined || id === undefined || status === undefined) {
      throw new AccreditationProviderError(
        `${VENDOR} ${op}: unexpected verification request shape`,
        "unavailable",
        false,
      );
    }
    const mapped =
      r["waiting_for_info"] === true && mapVerifyInvestorStatus(status) === "under_review"
        ? "needs_investor_action"
        : mapVerifyInvestorStatus(status);
    const decided = mapped === "accredited" || mapped === "not_accredited";
    const expiresAt =
      mapped === "accredited" ? parseVerifiedExpiresAt(r["verified_expires_at"]) : undefined;
    const decidedAt = decided ? asDate(r["completed_at"]) : undefined;
    return {
      id,
      status,
      investorId: idOf(asRecord(r["investor"])?.["id"]),
      check: {
        status: mapped,
        vendorStatus: clip(status, 100),
        ...(expiresAt === undefined ? {} : { expiresAt }),
        ...(decidedAt === undefined ? {} : { decidedAt }),
      },
    };
  };

  const getRequest = async (op: string, id: string): Promise<RequestView> =>
    viewRequest(await call(op, "GET", `/verification_requests/${id}`), op);

  /** Resolve a ref to its verification request, or undefined while the invitation is unanswered. */
  /**
   * Resolve a ref to its verification request. `request` is undefined while the invitation is
   * unanswered; `lapsed` is set when the invitation is gone (404 — the vendor lists only active
   * invitations) or older than the documented 30-day lifetime with no request behind it.
   */
  const resolve = async (
    op: string,
    providerRef: string,
  ): Promise<{ request: RequestView | undefined; upgraded: boolean; lapsed: boolean }> => {
    const ref = parseRef(op, providerRef);
    if (ref.kind === "vr") {
      return { request: await getRequest(op, ref.id), upgraded: false, lapsed: false };
    }
    const res = await send(
      op,
      "GET",
      `/verification_request_invitations/${ref.id}`,
      undefined,
      "application/json",
    );
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return { request: undefined, upgraded: false, lapsed: true };
    }
    if (res.status !== 200) return fail(op, res);
    const invitation = asRecord(await readJson(res, VENDOR, op));
    if (invitation === undefined) {
      throw new AccreditationProviderError(
        `${VENDOR} ${op}: unexpected invitation shape`,
        "unavailable",
        false,
      );
    }
    const vrId =
      idOf(invitation["verification_request_id"]) ??
      idOf(asRecord(invitation["verification_request"])?.["id"]);
    if (vrId === undefined) {
      const created = asDate(invitation["created_at"]);
      const lapsed =
        created !== undefined && deps.now().getTime() - created.getTime() > INVITATION_TTL_MS;
      return { request: undefined, upgraded: false, lapsed };
    }
    // Re-read the request itself: the invitation's nested copy lacks the investor id.
    return { request: await getRequest(op, vrId), upgraded: true, lapsed: false };
  };

  return {
    driver: DRIVER,

    async verifyCredentials(): Promise<void> {
      // The billing counter is the cheapest documented authenticated read (a few integers).
      const today = deps.now().toISOString().slice(0, 10);
      const res = await send(
        "verify",
        "GET",
        `/billing?from_date=${today}&to_date=${today}`,
        undefined,
        "application/json",
      );
      if (res.status === 200) {
        await res.body?.cancel().catch(() => {});
        return;
      }
      if (res.status === 404) {
        // Accounts without the billing endpoint: fall back to the API root the vendor documents as
        // its authentication example.
        await res.body?.cancel().catch(() => {});
        const rootRes = await send("verify", "GET", "", undefined, "application/json");
        if (rootRes.status === 200) {
          await rootRes.body?.cancel().catch(() => {});
          return;
        }
        return fail("verify", rootRes);
      }
      return fail("verify", res);
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
      const fullName = [input.firstName, input.lastName]
        .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
        .join(" ");
      const suggested = (input.legalName ?? "").trim() || fullName.trim();
      const portal = portalName || (input.portalName ?? "").trim();
      const answer = asRecord(
        await call("start", "POST", "/verification_request_invitations", {
          ...(portal.length > 0 ? { portal_name: portal.slice(0, 200) } : {}),
          investors: [
            {
              email,
              ...(suggested.length > 0 ? { suggested_legal_name: suggested.slice(0, 200) } : {}),
              type: "ai",
            },
          ],
        }),
      );
      const list = answer?.["verification_request_invitations"];
      const first = Array.isArray(list) ? asRecord(list[0]) : undefined;
      const invitationId = idOf(first?.["id"]);
      if (invitationId === undefined) {
        throw new AccreditationProviderError(
          `${VENDOR} start: unexpected invitation response`,
          "unavailable",
          false,
        );
      }
      const vrId = idOf(first?.["verification_request_id"]);
      return {
        providerRef: vrId === undefined ? `inv:${invitationId}` : `vr:${vrId}`,
        handoff: { kind: "invite_sent" },
        vendorStatus: "invitation_sent",
      };
    },

    async check({ providerRef }): Promise<AccreditationVendorCheck> {
      const { request, upgraded, lapsed } = await resolve("check", providerRef);
      if (request === undefined && lapsed) {
        return { status: "canceled", vendorStatus: "invitation_expired" };
      }
      if (request === undefined) {
        return { status: "needs_investor_action", vendorStatus: "invitation_sent" };
      }
      return upgraded ? { ...request.check, providerRef: `vr:${request.id}` } : request.check;
    },

    async fetchEvidence({ providerRef }): Promise<AccreditationEvidence | null> {
      const { request } = await resolve("evidence", providerRef);
      if (request === undefined || request.check.status !== "accredited") return null;
      if (request.investorId === undefined) return null;
      const op = "evidence";
      const res = await send(
        op,
        "GET",
        `/users/${request.investorId}/verification_requests/${request.id}/certificate`,
        undefined,
        "application/pdf",
      );
      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      if (res.status !== 200) return fail(op, res);
      const bytes = await readBounded(res, MAX_EVIDENCE_BYTES, VENDOR, op);
      if (!isPdf(bytes)) {
        throw new AccreditationProviderError(
          `${VENDOR} ${op}: certificate is not a PDF`,
          "unavailable",
          false,
        );
      }
      return { contentType: "application/pdf", bytes };
    },

    async parseCallback({ headers, rawBody }) {
      // VerifyInvestor signs the raw body only — there is no timestamp, so a captured callback
      // can be replayed. That is harmless here: a callback is only a wake-up, and the status is
      // always re-read over the authenticated API.
      try {
        // Always spend one HMAC (decoy key when no secret) and one compare, whatever the input.
        const expected = hmacSha256(webhookSecret.length > 0 ? webhookSecret : decoy, rawBody);
        const header = headers.get(SIGNATURE_HEADER);
        const given = header === null || header.length > 200 ? undefined : decodeSignature(header);
        const matches = bytesEqual(given ?? decoySignature, expected);
        if (webhookSecret.length === 0 || given === undefined || !matches) return undefined;
        const body = parseJsonObject(rawBody);
        if (body === undefined) return undefined;
        const id = idOf(body["verification_request_id"]);
        return { refs: id === undefined ? [] : [`vr:${id}`].slice(0, MAX_REFS) };
      } catch {
        return undefined;
      }
    },
  };
}

export const verifyInvestorAdapter: AccreditationAdapterDefinition = {
  meta: verifyInvestorMeta,
  credentialFields: verifyInvestorCredentialFields,
  create: createVerifyInvestorPort,
};
