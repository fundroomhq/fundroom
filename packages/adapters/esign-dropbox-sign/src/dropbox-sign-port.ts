import { createHmac, timingSafeEqual } from "node:crypto";
import {
  type ESignAdapterDeps,
  type ESignArtifacts,
  type ESignCallback,
  type ESignConnectionConfig,
  type ESignEnvelopeInput,
  type ESignEnvelopeState,
  type ESignEnvelopeStatus,
  type ESignField,
  type ESignPort,
  ESignProviderError,
  type ESignSignerStatus,
  type ESignVerifyResult,
} from "@fundroom/ports";
import {
  invalid,
  isPdf,
  isRecord,
  jsonOrThrow,
  readBounded,
  send,
  str,
  throwForStatus,
} from "./http.js";
import { multipartField } from "./multipart.js";
import { detectPageSize, type PageSize } from "./pdf-pages.js";

/**
 * Dropbox Sign (formerly HelloSign) API v3, HTTP basic auth with the API key as the username and an
 * empty password.
 *
 * Status mapping (signature request → ours), evaluated top to bottom:
 *
 * | Dropbox Sign                                     | ours       |
 * |--------------------------------------------------|------------|
 * | GET answers 410 Gone (cancelled request)         | voided     |
 * | is_declined                                      | declined   |
 * | is_complete                                      | completed  |
 * | expires_at in the past                           | expired    |
 * | any signature viewed (last_viewed_at) or signed  | delivered  |
 * | otherwise (incl. has_error, logged)              | sent       |
 *
 * Signature `status_code` → signer status: signed → signed, declined → declined, otherwise viewed when
 * `last_viewed_at` is set, else pending.
 *
 * Signer keys: metadata `seedhost_signers` holds a JSON array of `[signerKey, role|null]` in signer
 * order; `status()` maps each vendor signature back by `signer_role` (templates), then by its
 * 0-based `order`, then by position. `externalId` travels as metadata `seedhost_external_id`.
 *
 * Embedded signing is NOT offered: a Dropbox Sign `sign_url` only works inside their
 * `hellosign-embedded` iframe library on a domain registered to an API app, while our portal opens
 * signing URLs top-level (ADR-0040 frame rule). Every signer therefore gets the vendor's email and
 * `signingUrl()` answers undefined.
 */

export const API_BASE = "https://api.hellosign.com/v3";
export const CREDENTIAL = { apiKey: "apiKey", testMode: "testMode" } as const;

const EXTERNAL_ID_KEY = "seedhost_external_id";
const SIGNERS_KEY = "seedhost_signers";
const REF_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_RE = /^[0-9a-f]{64}$/i;
/** Callback freshness. Future skew is bounded tightly; the past bound must cover Dropbox Sign's
 *  retry schedule (6 retries, 5 min → 20+ h, same `event_time`): rejecting a retry counts toward the
 *  10 consecutive failures after which Dropbox Sign clears the callback URL. Replays are harmless
 *  wake-ups (contract §0). */
export const CALLBACK_MAX_FUTURE_SKEW_S = 5 * 60;
export const CALLBACK_MAX_AGE_S = 72 * 60 * 60;
/** Dropbox Sign sizes width/height at 80 DPI even in the 72 DPI page coordinate system. */
const SIZE_SCALE = 80 / 72;

export function mapSignatureRequest(
  req: Record<string, unknown>,
  now: Date,
): { status: ESignEnvelopeStatus; vendorError: boolean } {
  const signatures = Array.isArray(req["signatures"]) ? req["signatures"].filter(isRecord) : [];
  if (req["is_declined"] === true) return { status: "declined", vendorError: false };
  if (req["is_complete"] === true) return { status: "completed", vendorError: false };
  const expiresAt = typeof req["expires_at"] === "number" ? req["expires_at"] : undefined;
  if (expiresAt !== undefined && expiresAt * 1000 < now.getTime())
    return { status: "expired", vendorError: false };
  const touched = signatures.some(
    (s) => typeof s["last_viewed_at"] === "number" || s["status_code"] === "signed",
  );
  return { status: touched ? "delivered" : "sent", vendorError: req["has_error"] === true };
}

function signerStatus(s: Record<string, unknown>): { status: ESignSignerStatus; at?: Date } {
  const at = (v: unknown) =>
    typeof v === "number" && Number.isFinite(v) ? new Date(v * 1000) : undefined;
  const code = s["status_code"];
  if (code === "signed") return withAt("signed", at(s["signed_at"]));
  if (code === "declined") return { status: "declined" };
  const viewed = at(s["last_viewed_at"]);
  return viewed ? { status: "viewed", at: viewed } : { status: "pending" };
}

function withAt(
  status: ESignSignerStatus,
  at: Date | undefined,
): { status: ESignSignerStatus; at?: Date } {
  return at ? { status, at } : { status };
}

function rejected(msg: string): ESignProviderError {
  return new ESignProviderError(`dropbox-sign: ${msg}`, "rejected", false);
}

function fraction(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= 1;
}

/** Fractions (top-left origin) → Dropbox Sign's page coordinate system (72 DPI, `page` given). */
export function formFieldsFor(
  fields: readonly ESignField[],
  signerIndex: ReadonlyMap<string, number>,
  size: PageSize,
): Record<string, unknown>[] {
  return fields.map((f, i) => {
    const signer = signerIndex.get(f.signerKey);
    if (signer === undefined) throw rejected("a field names an unknown signer");
    if (!Number.isInteger(f.page) || f.page < 1 || ![f.x, f.y, f.w, f.h].every(fraction)) {
      throw rejected("field geometry must be page fractions on a 1-based page");
    }
    const type = f.kind === "signature" ? "signature" : f.kind === "date" ? "date_signed" : "text";
    return {
      document_index: 0,
      api_id: `seedhost_${i}_${f.kind}`,
      name: f.kind === "name" ? "Full name" : "",
      type,
      x: Math.round(f.x * size.width),
      y: Math.round(f.y * size.height),
      width: Math.max(1, Math.round(f.w * size.width * SIZE_SCALE)),
      height: Math.max(1, Math.round(f.h * size.height * SIZE_SCALE)),
      required: true,
      signer,
      page: f.page,
    };
  });
}

export class DropboxSignPort implements ESignPort {
  readonly driver = "dropbox-sign" as const;

  constructor(
    private readonly config: ESignConnectionConfig,
    private readonly deps: ESignAdapterDeps,
  ) {}

  private apiKey(): string | undefined {
    const v = this.config.credentials[CREDENTIAL.apiKey];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  }

  private testMode(): boolean {
    return this.config.credentials[CREDENTIAL.testMode] !== "live";
  }

  private async call(
    op: string,
    method: string,
    path: string,
    body?: FormData | unknown,
  ): Promise<Response> {
    const key = this.apiKey();
    if (!key)
      throw new ESignProviderError("dropbox-sign: the API key is missing", "unauthorized", false);
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`,
      accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (body instanceof FormData) init.body = body;
    else if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    return send(this.deps.fetch, op, `${API_BASE}${path}`, init);
  }

  private refPath(providerRef: string): string {
    if (!REF_RE.test(providerRef)) {
      throw new ESignProviderError(
        "dropbox-sign: malformed signature request reference",
        "not_found",
        false,
      );
    }
    return encodeURIComponent(providerRef);
  }

  async verifyCredentials(): Promise<ESignVerifyResult> {
    try {
      const body = await jsonOrThrow(
        await this.call("get account", "GET", "/account"),
        "get account",
      );
      const account = isRecord(body) && isRecord(body["account"]) ? body["account"] : undefined;
      if (!account)
        return {
          ok: false,
          reason: "misconfigured",
          detail: "dropbox-sign: /account returned no account",
        };
      return { ok: true, account: str(account["email_address"]) ?? str(account["account_id"]) };
    } catch (err) {
      if (!(err instanceof ESignProviderError)) return { ok: false, reason: "misconfigured" };
      if (err.code === "unauthorized")
        return { ok: false, reason: "unauthorized", detail: err.message };
      if (err.code === "unavailable" || err.code === "rate_limited") {
        return { ok: false, reason: "unreachable", detail: err.message };
      }
      return { ok: false, reason: "misconfigured", detail: err.message };
    }
  }

  async createEnvelope(input: ESignEnvelopeInput): Promise<{ readonly providerRef: string }> {
    if (input.signers.length === 0) throw rejected("a signature request needs at least one signer");
    const signers = [...input.signers].sort((a, b) => a.order - b.order);
    const signerMap = JSON.stringify(signers.map((s) => [s.signerKey, s.role ?? null]));
    const metadata: Record<string, string> = { [EXTERNAL_ID_KEY]: input.externalId };
    if (signerMap.length <= 1000) metadata[SIGNERS_KEY] = signerMap;
    else
      this.deps.log?.warn(
        { driver: "dropbox-sign" },
        "esign: signer map too long for metadata; mapping by position",
      );
    const title = input.title.slice(0, 255);

    let res: Response;
    if (input.document.kind === "pdf") {
      const doc = input.document;
      const { size, mixed, found } = detectPageSize(doc.bytes);
      if (mixed || !found) {
        this.deps.log?.warn(
          { driver: "dropbox-sign", mixed, found, width: size.width, height: size.height },
          "esign: field placement assumes a uniform page size",
        );
      }
      const index = new Map(signers.map((s, i) => [s.signerKey, i] as const));
      const formFields = formFieldsFor(doc.fields, index, size);
      const form = new FormData();
      form.append(
        "files[0]",
        new Blob([doc.bytes as Uint8Array<ArrayBuffer>], { type: "application/pdf" }),
        doc.filename || "document.pdf",
      );
      form.append("title", title);
      form.append("subject", title);
      if (input.message) form.append("message", input.message.slice(0, 5000));
      signers.forEach((s, i) => {
        form.append(`signers[${i}][name]`, s.name);
        form.append(`signers[${i}][email_address]`, s.email);
        if (signers.length > 1) form.append(`signers[${i}][order]`, String(i));
      });
      for (const [k, v] of Object.entries(metadata)) form.append(`metadata[${k}]`, v);
      form.append("form_fields_per_document", JSON.stringify(formFields));
      form.append("test_mode", this.testMode() ? "1" : "0");
      if (input.redirectUrl) form.append("signing_redirect_url", input.redirectUrl);
      res = await this.call("send signature request", "POST", "/signature_request/send", form);
    } else {
      const tpl = input.document;
      const body: Record<string, unknown> = {
        template_ids: [tpl.templateRef],
        title,
        subject: title,
        signers: signers.map((s) => {
          if (!s.role) throw rejected("template requests need a role for every signer");
          return { role: s.role, name: s.name, email_address: s.email };
        }),
        custom_fields: Object.entries(tpl.prefill).map(([name, value]) => ({ name, value })),
        metadata,
        test_mode: this.testMode(),
      };
      if (input.message) body["message"] = input.message.slice(0, 5000);
      if (input.redirectUrl) body["signing_redirect_url"] = input.redirectUrl;
      res = await this.call(
        "send with template",
        "POST",
        "/signature_request/send_with_template",
        body,
      );
    }
    const out = await jsonOrThrow(res, "send signature request");
    const req =
      isRecord(out) && isRecord(out["signature_request"]) ? out["signature_request"] : undefined;
    const providerRef = req ? str(req["signature_request_id"]) : undefined;
    if (!providerRef || !REF_RE.test(providerRef))
      throw invalid("send signature request", "no signature request id");
    return { providerRef };
  }

  private async getRequest(providerRef: string): Promise<Record<string, unknown> | "gone"> {
    const res = await this.call(
      "get signature request",
      "GET",
      `/signature_request/${this.refPath(providerRef)}`,
    );
    if (res.status === 410) {
      await res.body?.cancel().catch(() => undefined);
      return "gone";
    }
    const body = await jsonOrThrow(res, "get signature request");
    const req =
      isRecord(body) && isRecord(body["signature_request"]) ? body["signature_request"] : undefined;
    if (!req) throw invalid("get signature request", "no signature request");
    return req;
  }

  async status(providerRef: string): Promise<ESignEnvelopeState> {
    const req = await this.getRequest(providerRef);
    if (req === "gone") return { status: "voided", signers: [] };
    const now = this.deps.now();
    const { status, vendorError } = mapSignatureRequest(req, now);
    if (vendorError)
      this.deps.log?.warn({ driver: "dropbox-sign" }, "esign: signature request reports has_error");
    const keys = signerKeys(req);
    const signatures = Array.isArray(req["signatures"]) ? req["signatures"].filter(isRecord) : [];
    const used = new Set<string>();
    const signers: { signerKey: string; status: ESignSignerStatus; at?: Date }[] = [];
    signatures.forEach((sig, i) => {
      const role = str(sig["signer_role"]);
      const order = typeof sig["order"] === "number" ? sig["order"] : undefined;
      const key =
        (role ? keys.find(([, r]) => r === role)?.[0] : undefined) ??
        (order !== undefined ? keys[order]?.[0] : undefined) ??
        keys[i]?.[0];
      if (!key || used.has(key)) return;
      used.add(key);
      signers.push({ signerKey: key, ...signerStatus(sig) });
    });
    if (status !== "completed") return { status, signers };
    const signedAt = signers.map((s) => s.at?.getTime() ?? 0).reduce((a, b) => Math.max(a, b), 0);
    return { status, signers, completedAt: signedAt > 0 ? new Date(signedAt) : now };
  }

  async signingUrl(): Promise<string | undefined> {
    return undefined;
  }

  async downloadSigned(
    providerRef: string,
    limits: { readonly maxBytes: number },
  ): Promise<ESignArtifacts> {
    // The files endpoint also serves an in-progress request's PDF, so require completion first.
    const req = await this.getRequest(providerRef);
    if (req === "gone" || req["is_complete"] !== true)
      throw rejected("the signature request is not complete");
    const res = await this.call(
      "download files",
      "GET",
      `/signature_request/files/${this.refPath(providerRef)}?file_type=pdf`,
    );
    if (res.status === 409) {
      // "files are still being prepared": try again later.
      await res.body?.cancel().catch(() => undefined);
      throw new ESignProviderError(
        "dropbox-sign: signed files are still being prepared",
        "unavailable",
        true,
        409,
      );
    }
    if (!res.ok) await throwForStatus(res, "download files");
    const document = await readBounded(res, "download files", limits.maxBytes);
    if (!isPdf(document)) throw invalid("download files", "something that is not a PDF");
    // The merged PDF already ends with Dropbox Sign's audit trail page; there is no separate file.
    return { document };
  }

  async void(providerRef: string, _reason: string): Promise<void> {
    const res = await this.call(
      "cancel signature request",
      "POST",
      `/signature_request/cancel/${this.refPath(providerRef)}`,
    );
    if (res.status === 410) {
      await res.body?.cancel().catch(() => undefined);
      return; // already cancelled
    }
    await throwForStatus(res, "cancel signature request");
    await res.body?.cancel().catch(() => undefined);
  }

  /**
   * Callbacks are `multipart/form-data` with the event JSON in the `json` field. Authenticity:
   * `event.event_hash` = hex HMAC-SHA256(key = API key, event_time + event_type), compared in
   * constant time. The hash covers only time and type — not the request id — which is why a callback
   * is only a wake-up (§0). `event_time` must lie within [now − 72 h, now + 5 min].
   */
  async parseCallback(request: {
    readonly headers: Headers;
    readonly body: Uint8Array;
  }): Promise<ESignCallback | undefined> {
    try {
      const key = this.apiKey();
      if (!key) return undefined;
      const raw = extractEventJson(request.headers.get("content-type"), request.body);
      if (raw === undefined) return undefined;
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed) || !isRecord(parsed["event"])) return undefined;
      const event = parsed["event"];
      const time = event["event_time"];
      const type = event["event_type"];
      const hash = event["event_hash"];
      if (typeof time !== "string" || !/^\d{1,12}$/.test(time)) return undefined;
      if (typeof type !== "string" || !/^[a-z_]{1,64}$/.test(type)) return undefined;
      if (typeof hash !== "string" || !HASH_RE.test(hash)) return undefined;
      const expected = createHmac("sha256", key).update(`${time}${type}`).digest();
      const provided = Buffer.from(hash, "hex");
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
        return undefined;
      const nowS = Math.floor(this.deps.now().getTime() / 1000);
      const t = Number(time);
      if (t > nowS + CALLBACK_MAX_FUTURE_SKEW_S || t < nowS - CALLBACK_MAX_AGE_S) return undefined;

      const req = isRecord(parsed["signature_request"]) ? parsed["signature_request"] : undefined;
      const id = req ? str(req["signature_request_id"]) : undefined;
      const meta = req && isRecord(req["metadata"]) ? req["metadata"] : undefined;
      const ext = meta ? str(meta[EXTERNAL_ID_KEY]) : undefined;
      return {
        event: type,
        ...(id && REF_RE.test(id) ? { providerRef: id } : {}),
        ...(ext && REF_RE.test(ext) ? { externalId: ext } : {}),
      };
    } catch {
      return undefined;
    }
  }
}

function signerKeys(req: Record<string, unknown>): [string, string | null][] {
  const meta = isRecord(req["metadata"]) ? req["metadata"] : undefined;
  const raw = meta ? meta[SIGNERS_KEY] : undefined;
  if (typeof raw !== "string") return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list)) return [];
    return list
      .filter((e): e is [string, string | null] => Array.isArray(e) && typeof e[0] === "string")
      .map(([k, r]) => [k, typeof r === "string" ? r : null]);
  } catch {
    return [];
  }
}

/** The event JSON: the multipart `json` field (what Dropbox Sign sends); also a raw JSON body. */
function extractEventJson(contentType: string | null, body: Uint8Array): string | undefined {
  if (body.byteLength === 0) return undefined;
  if (
    contentType &&
    /^\s*application\/json\b/i.test(contentType) &&
    body.byteLength <= 1024 * 1024
  ) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8");
  }
  return multipartField(contentType, body, "json");
}
