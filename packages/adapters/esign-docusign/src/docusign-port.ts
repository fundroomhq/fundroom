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
  type ESignSigner,
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
  toBase64,
} from "./http.js";
import { jwtClaims, parsePrivateKey, signJwt } from "./jwt.js";
import { detectPageSize, type PageSize } from "./pdf-pages.js";

/**
 * DocuSign eSignature REST API v2.1 over the OAuth JWT grant.
 *
 * Status mapping (DocuSign envelope `status` → ours):
 *
 * | DocuSign                         | ours        |
 * |----------------------------------|-------------|
 * | created, sent, correct           | sent        |
 * | delivered, signed                | delivered   |  (`signed` = all signed, completion pending)
 * | completed                        | completed   |
 * | declined                         | declined    |
 * | voided (voidedReason ~ /expir/)  | expired     |  (DocuSign voids an envelope when it expires)
 * | voided, deleted                  | voided      |
 * | timedout                         | expired     |
 * | anything else                    | sent + warn |  (non-terminal: the sync keeps polling)
 *
 * Recipient `status` → signer status: created/sent/autoresponded → pending, delivered → viewed,
 * signed/completed → signed, declined → declined.
 *
 * Signer keys travel with the envelope so `status()` can map recipients back: PDF envelopes tag each
 * signer with a recipient custom field `seedhost_signer_key=<key>`; template envelopes (template
 * roles cannot carry recipient custom fields) store `role=key;…` in the envelope text custom field
 * `seedhost_roles` and are mapped by `roleName`. `externalId` is the envelope text custom field
 * `seedhost_external_id` (hidden from signers).
 */

export const CREDENTIAL = {
  environment: "environment",
  integrationKey: "integrationKey",
  userId: "userId",
  privateKeyPem: "privateKeyPem",
  accountId: "accountId",
  hmacKey: "connectHmacKey",
  hmacKeySecondary: "connectHmacKeySecondary",
} as const;

export const AUTH_HOSTS = {
  demo: "account-d.docusign.com",
  production: "account.docusign.com",
} as const;

const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const EXTERNAL_ID_FIELD = "seedhost_external_id";
const ROLES_FIELD = "seedhost_roles";
const SIGNER_KEY_PREFIX = "seedhost_signer_key=";
const MAX_SIGNATURE_HEADERS = 100;
const MAX_CALLBACK_BYTES = 1024 * 1024;
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const REF_RE = /^[A-Za-z0-9-]{1,128}$/;
const B64_SHA256_RE = /^[A-Za-z0-9+/]{43}=$/;

/**
 * The account base URI comes from `/oauth/userinfo` and will receive our bearer token on every
 * call, so it must be an https origin on a DocuSign-operated `*.docusign.net` host — no userinfo,
 * no custom port, no path trickery. Returns the origin, or undefined when unacceptable.
 */
export function validateBaseUri(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 256) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.docusign\.net$/.test(host)) return undefined;
  return `https://${host}`;
}

/** Signing-ceremony URLs we hand to a browser must be DocuSign's own https pages. */
function validViewUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    if (!host.endsWith(".docusign.net") && !host.endsWith(".docusign.com")) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function mapEnvelopeStatus(
  status: string,
  voidedReason: string | undefined,
): ESignEnvelopeStatus | undefined {
  switch (status.toLowerCase()) {
    case "created":
    case "sent":
    case "correct":
      return "sent";
    case "delivered":
    case "signed":
      return "delivered";
    case "completed":
      return "completed";
    case "declined":
      return "declined";
    case "voided":
      return voidedReason && /expir/i.test(voidedReason) ? "expired" : "voided";
    case "deleted":
      return "voided";
    case "timedout":
      return "expired";
    default:
      return undefined;
  }
}

function mapRecipientStatus(status: string): ESignSignerStatus {
  switch (status.toLowerCase()) {
    case "delivered":
      return "viewed";
    case "signed":
    case "completed":
      return "signed";
    case "declined":
      return "declined";
    default:
      return "pending";
  }
}

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== "string") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function rejected(msg: string): ESignProviderError {
  return new ESignProviderError(`docusign: ${msg}`, "rejected", false);
}

function misconfigured(msg: string): ESignProviderError {
  return new ESignProviderError(`docusign: ${msg}`, "unauthorized", false);
}

function fraction(v: number): boolean {
  return Number.isFinite(v) && v >= 0 && v <= 1;
}

interface Account {
  readonly apiBase: string;
  readonly name: string | undefined;
}

export class DocusignPort implements ESignPort {
  readonly driver = "docusign" as const;
  private token: { value: string; expiresAt: number } | undefined;
  private tokenInflight: Promise<string> | undefined;
  private account: Account | undefined;
  private accountInflight: Promise<Account> | undefined;

  constructor(
    private readonly config: ESignConnectionConfig,
    private readonly deps: ESignAdapterDeps,
  ) {}

  private cred(key: string): string | undefined {
    const v = this.config.credentials[key];
    return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
  }

  private authHost(): string {
    const env = this.cred(CREDENTIAL.environment) ?? "demo";
    if (env !== "demo" && env !== "production")
      throw misconfigured("environment must be demo or production");
    return AUTH_HOSTS[env];
  }

  // ---------- OAuth ----------

  private async accessToken(): Promise<string> {
    const nowMs = this.deps.now().getTime();
    if (this.token && nowMs < this.token.expiresAt - TOKEN_REFRESH_MARGIN_MS)
      return this.token.value;
    if (!this.tokenInflight) {
      this.tokenInflight = this.requestToken().finally(() => {
        this.tokenInflight = undefined;
      });
    }
    return this.tokenInflight;
  }

  private async requestToken(): Promise<string> {
    const integrationKey = this.cred(CREDENTIAL.integrationKey);
    const userId = this.cred(CREDENTIAL.userId);
    const pem = this.cred(CREDENTIAL.privateKeyPem);
    if (!integrationKey || !userId || !pem)
      throw misconfigured("integration key, user id and private key are required");
    const host = this.authHost();
    let key: ReturnType<typeof parsePrivateKey>;
    try {
      key = parsePrivateKey(pem);
    } catch (err) {
      throw misconfigured((err as Error).message);
    }
    const now = this.deps.now();
    const assertion = signJwt(jwtClaims({ integrationKey, userId, audience: host, now }), key);
    const res = await send(this.deps.fetch, "token request", `https://${host}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    });
    let body: unknown;
    try {
      body = await jsonOrThrow(res, "token request");
    } catch (err) {
      // The token endpoint answers 400 for consent_required / invalid_grant / bad keys: all of them
      // mean "these credentials cannot authenticate", never a retryable request problem.
      if (err instanceof ESignProviderError && err.code === "rejected") {
        throw new ESignProviderError(err.message, "unauthorized", false, err.status);
      }
      throw err;
    }
    if (!isRecord(body)) throw invalid("token request", "no JSON object");
    const value = str(body["access_token"]);
    const expiresIn =
      typeof body["expires_in"] === "number" ? body["expires_in"] : Number(body["expires_in"]);
    if (!value || !Number.isFinite(expiresIn) || expiresIn <= 0)
      throw invalid("token request", "no access token");
    this.token = { value, expiresAt: now.getTime() + expiresIn * 1000 };
    return value;
  }

  private async resolveAccount(): Promise<Account> {
    if (this.account) return this.account;
    if (!this.accountInflight) {
      this.accountInflight = this.fetchAccount().finally(() => {
        this.accountInflight = undefined;
      });
    }
    return this.accountInflight;
  }

  private async fetchAccount(): Promise<Account> {
    const token = await this.accessToken();
    const res = await send(
      this.deps.fetch,
      "userinfo",
      `https://${this.authHost()}/oauth/userinfo`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      },
    );
    const body = await jsonOrThrow(res, "userinfo");
    if (!isRecord(body) || !Array.isArray(body["accounts"]))
      throw invalid("userinfo", "no accounts");
    const accounts = body["accounts"].filter(isRecord);
    const wanted = this.cred(CREDENTIAL.accountId);
    const chosen = wanted
      ? accounts.find((a) => a["account_id"] === wanted)
      : (accounts.find((a) => a["is_default"] === true || a["is_default"] === "true") ??
        accounts[0]);
    if (!chosen) {
      throw misconfigured(
        wanted
          ? "the configured account id is not available to this user"
          : "the user has no accounts",
      );
    }
    const accountId = str(chosen["account_id"]);
    if (!accountId || !REF_RE.test(accountId)) throw invalid("userinfo", "no account id");
    const origin = validateBaseUri(chosen["base_uri"]);
    if (!origin) throw invalid("userinfo", "a base URI that is not an https *.docusign.net origin");
    this.account = {
      apiBase: `${origin}/restapi/v2.1/accounts/${encodeURIComponent(accountId)}`,
      name: str(chosen["account_name"]),
    };
    return this.account;
  }

  /** One REST call; a 401 drops the cached token and retries once (token revoked early). */
  private async api(
    op: string,
    method: string,
    path: string,
    body?: unknown,
    accept = "application/json",
  ): Promise<Response> {
    const account = await this.resolveAccount();
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept };
      if (body !== undefined) headers["content-type"] = "application/json";
      const init: RequestInit = { method, headers };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await send(this.deps.fetch, op, `${account.apiBase}${path}`, init);
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel().catch(() => undefined);
        this.token = undefined;
        continue;
      }
      return res;
    }
  }

  // ---------- ESignPort ----------

  async verifyCredentials(): Promise<ESignVerifyResult> {
    if (!this.cred(CREDENTIAL.hmacKey)) {
      return { ok: false, reason: "misconfigured", detail: "Connect HMAC key is missing" };
    }
    try {
      this.token = undefined;
      this.account = undefined;
      const account = await this.resolveAccount();
      return { ok: true, account: account.name };
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
    if (input.signers.length === 0) throw rejected("an envelope needs at least one signer");
    const signers = [...input.signers].sort((a, b) => a.order - b.order);
    const textCustomFields: { name: string; value: string; show: string; required: string }[] = [
      { name: EXTERNAL_ID_FIELD, value: input.externalId, show: "false", required: "false" },
    ];
    const definition: Record<string, unknown> = {
      emailSubject: input.title.slice(0, 100),
      status: "sent",
    };
    if (input.message) definition["emailBlurb"] = input.message.slice(0, 10000);

    if (input.document.kind === "pdf") {
      const doc = input.document;
      const { size, mixed, found } = detectPageSize(doc.bytes);
      if (mixed || !found) {
        this.deps.log?.warn(
          { driver: "docusign", mixed, found, width: size.width, height: size.height },
          "esign: field placement assumes a uniform page size",
        );
      }
      const known = new Set(signers.map((s) => s.signerKey));
      for (const f of doc.fields) {
        if (!known.has(f.signerKey)) throw rejected("a field names an unknown signer");
      }
      definition["documents"] = [
        {
          documentId: "1",
          name: doc.filename.slice(0, 100) || "document.pdf",
          fileExtension: "pdf",
          documentBase64: toBase64(doc.bytes),
        },
      ];
      definition["recipients"] = {
        signers: signers.map((s, i) => ({
          ...this.recipient(s, i, input.embedded),
          customFields: [`${SIGNER_KEY_PREFIX}${s.signerKey}`],
          tabs: tabsFor(
            doc.fields.filter((f) => f.signerKey === s.signerKey),
            size,
          ),
        })),
      };
    } else {
      const tpl = input.document;
      const textTabs = Object.entries(tpl.prefill).map(([tabLabel, value]) => ({
        tabLabel,
        value,
      }));
      const roles: string[] = [];
      definition["templateId"] = tpl.templateRef;
      definition["templateRoles"] = signers.map((s, i) => {
        if (!s.role) throw rejected("template envelopes need a role for every signer");
        roles.push(`${s.role}=${s.signerKey}`);
        const { recipientId: _unused, ...rest } = this.recipient(s, i, input.embedded);
        return { ...rest, roleName: s.role, tabs: { textTabs } };
      });
      const rolesValue = roles.join(";");
      if (rolesValue.length <= 100) {
        textCustomFields.push({
          name: ROLES_FIELD,
          value: rolesValue,
          show: "false",
          required: "false",
        });
      } else {
        this.deps.log?.warn(
          { driver: "docusign" },
          "esign: role map too long for a custom field; signer keys will be unmapped",
        );
      }
    }
    definition["customFields"] = { textCustomFields };

    const res = await this.api("create envelope", "POST", "/envelopes", definition);
    const body = await jsonOrThrow(res, "create envelope");
    const providerRef = isRecord(body) ? str(body["envelopeId"]) : undefined;
    if (!providerRef || !GUID_RE.test(providerRef))
      throw invalid("create envelope", "no envelope id");
    return { providerRef };
  }

  private recipient(s: ESignSigner, index: number, embedded: boolean): Record<string, string> {
    const r: Record<string, string> = {
      recipientId: String(index + 1),
      routingOrder: String(Math.max(1, Math.trunc(s.order))),
      name: s.name.slice(0, 100),
      email: s.email,
    };
    // A clientUserId makes the recipient "captive": DocuSign does not email the signing link and
    // the ceremony is only reachable through views/recipient (signingUrl()).
    if (embedded) r["clientUserId"] = s.signerKey;
    return r;
  }

  private envPath(providerRef: string): string {
    if (!REF_RE.test(providerRef))
      throw new ESignProviderError("docusign: malformed envelope reference", "not_found", false);
    return `/envelopes/${encodeURIComponent(providerRef)}`;
  }

  private async recipients(providerRef: string): Promise<Record<string, unknown>[]> {
    const res = await this.api("get recipients", "GET", `${this.envPath(providerRef)}/recipients`);
    const body = await jsonOrThrow(res, "get recipients");
    if (!isRecord(body)) throw invalid("get recipients", "no JSON object");
    return Array.isArray(body["signers"]) ? body["signers"].filter(isRecord) : [];
  }

  async status(providerRef: string): Promise<ESignEnvelopeState> {
    const res = await this.api("get envelope", "GET", this.envPath(providerRef));
    const env = await jsonOrThrow(res, "get envelope");
    if (!isRecord(env)) throw invalid("get envelope", "no JSON object");
    const raw = str(env["status"]);
    if (!raw) throw invalid("get envelope", "no status");
    let status = mapEnvelopeStatus(raw, str(env["voidedReason"]));
    if (!status) {
      this.deps.log?.warn(
        { driver: "docusign", vendorStatus: raw.slice(0, 40) },
        "esign: unknown envelope status",
      );
      status = "sent";
    }
    const recipients = await this.recipients(providerRef);
    let roleMap: Map<string, string> | undefined;
    if (recipients.some((r) => !signerKeyTag(r))) roleMap = await this.roleMap(providerRef);

    const signers: { signerKey: string; status: ESignSignerStatus; at?: Date }[] = [];
    for (const r of recipients) {
      const role = str(r["roleName"]);
      const signerKey = signerKeyTag(r) ?? (role ? roleMap?.get(role) : undefined);
      if (!signerKey) continue;
      const st = mapRecipientStatus(str(r["status"]) ?? "");
      const at =
        st === "signed"
          ? parseDate(r["signedDateTime"])
          : st === "declined"
            ? parseDate(r["declinedDateTime"])
            : st === "viewed"
              ? parseDate(r["deliveredDateTime"])
              : undefined;
      signers.push(at ? { signerKey, status: st, at } : { signerKey, status: st });
    }
    const completedAt = status === "completed" ? parseDate(env["completedDateTime"]) : undefined;
    return completedAt ? { status, signers, completedAt } : { status, signers };
  }

  private async roleMap(providerRef: string): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const res = await this.api(
      "get custom fields",
      "GET",
      `${this.envPath(providerRef)}/custom_fields`,
    );
    const body = await jsonOrThrow(res, "get custom fields");
    const fields =
      isRecord(body) && Array.isArray(body["textCustomFields"]) ? body["textCustomFields"] : [];
    for (const f of fields) {
      if (!isRecord(f) || f["name"] !== ROLES_FIELD || typeof f["value"] !== "string") continue;
      for (const pair of f["value"].split(";")) {
        const at = pair.lastIndexOf("=");
        if (at > 0) map.set(pair.slice(0, at), pair.slice(at + 1));
      }
    }
    return map;
  }

  async signingUrl(
    providerRef: string,
    signerKey: string,
    returnUrl: string,
  ): Promise<string | undefined> {
    const recipients = await this.recipients(providerRef);
    let roleMap: Map<string, string> | undefined;
    if (recipients.some((r) => !signerKeyTag(r))) roleMap = await this.roleMap(providerRef);
    const r = recipients.find((x) => {
      const role = str(x["roleName"]);
      return (signerKeyTag(x) ?? (role ? roleMap?.get(role) : undefined)) === signerKey;
    });
    if (!r)
      throw new ESignProviderError("docusign: no such signer on this envelope", "not_found", false);
    const clientUserId = str(r["clientUserId"]);
    if (!clientUserId) return undefined; // remote recipient: DocuSign emailed the link
    const res = await this.api(
      "recipient view",
      "POST",
      `${this.envPath(providerRef)}/views/recipient`,
      {
        returnUrl,
        authenticationMethod: "none",
        clientUserId,
        recipientId: str(r["recipientId"]),
        userName: str(r["name"]),
        email: str(r["email"]),
      },
    );
    const body = await jsonOrThrow(res, "recipient view");
    const url = validViewUrl(isRecord(body) ? body["url"] : undefined);
    if (!url) throw invalid("recipient view", "no https DocuSign signing URL");
    return url;
  }

  async downloadSigned(
    providerRef: string,
    limits: { readonly maxBytes: number },
  ): Promise<ESignArtifacts> {
    const base = this.envPath(providerRef);
    // DocuSign serves documents at any stage (the unsigned PDF before completion), so check first.
    const env = await jsonOrThrow(await this.api("get envelope", "GET", base), "get envelope");
    const raw = isRecord(env) ? str(env["status"]) : undefined;
    if (!raw || mapEnvelopeStatus(raw, undefined) !== "completed") {
      throw rejected("the envelope is not completed");
    }
    const doc = await this.api(
      "download document",
      "GET",
      `${base}/documents/combined?certificate=false`,
      undefined,
      "application/pdf",
    );
    if (!doc.ok) await throwForStatus(doc, "download document");
    const document = await readBounded(doc, "download document", limits.maxBytes);
    if (!isPdf(document)) throw invalid("download document", "something that is not a PDF");

    const cert = await this.api(
      "download certificate",
      "GET",
      `${base}/documents/certificate`,
      undefined,
      "application/pdf",
    );
    if (cert.status === 404) {
      await cert.body?.cancel().catch(() => undefined);
      return { document };
    }
    if (!cert.ok) await throwForStatus(cert, "download certificate");
    const certificate = await readBounded(cert, "download certificate", limits.maxBytes);
    if (!isPdf(certificate)) throw invalid("download certificate", "something that is not a PDF");
    return { document, certificate };
  }

  async void(providerRef: string, reason: string): Promise<void> {
    const res = await this.api("void envelope", "PUT", this.envPath(providerRef), {
      status: "voided",
      voidedReason: (reason.trim() || "Voided").slice(0, 200),
    });
    await throwForStatus(res, "void envelope");
    await res.body?.cancel().catch(() => undefined);
  }

  /**
   * Connect HMAC: each active key yields one header `X-DocuSign-Signature-<n>` (n = 1…100) holding
   * base64(HMAC-SHA256(key, raw body)). Accept when any header matches any configured key (primary
   * plus an optional secondary during rotation). Every comparison runs (no early exit) and uses
   * `timingSafeEqual` on fixed-length digests. The payload carries no signed timestamp, so no
   * freshness window can be enforced; a replay only causes one extra status pull (§0).
   */
  async parseCallback(request: {
    readonly headers: Headers;
    readonly body: Uint8Array;
  }): Promise<ESignCallback | undefined> {
    try {
      const keys = [this.cred(CREDENTIAL.hmacKey), this.cred(CREDENTIAL.hmacKeySecondary)].filter(
        (k): k is string => k !== undefined,
      );
      const body = request.body;
      if (keys.length === 0 || body.byteLength === 0 || body.byteLength > MAX_CALLBACK_BYTES)
        return undefined;
      const provided: Buffer[] = [];
      for (let n = 1; n <= MAX_SIGNATURE_HEADERS; n++) {
        const h = request.headers.get(`x-docusign-signature-${n}`)?.trim();
        if (h && B64_SHA256_RE.test(h)) provided.push(Buffer.from(h, "base64"));
      }
      if (provided.length === 0) return undefined;
      const expected = keys.map((k) => createHmac("sha256", k).update(body).digest());
      let ok = false;
      for (const p of provided) {
        for (const e of expected) {
          if (p.length === e.length && timingSafeEqual(p, e)) ok = true;
        }
      }
      if (!ok) return undefined;
      return describeCallback(
        Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8"),
      );
    } catch {
      return undefined;
    }
  }
}

function signerKeyTag(r: Record<string, unknown>): string | undefined {
  if (!Array.isArray(r["customFields"])) return undefined;
  for (const f of r["customFields"]) {
    if (typeof f === "string" && f.startsWith(SIGNER_KEY_PREFIX))
      return f.slice(SIGNER_KEY_PREFIX.length) || undefined;
  }
  return undefined;
}

/** Names only: the authenticated body picks which envelope to re-pull, nothing else. */
function describeCallback(text: string): ESignCallback {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (isRecord(parsed)) {
    const event = str(parsed["event"])?.slice(0, 64) ?? "unknown";
    const data = isRecord(parsed["data"]) ? parsed["data"] : {};
    const envelopeId = str(data["envelopeId"]);
    const providerRef = envelopeId && GUID_RE.test(envelopeId) ? envelopeId : undefined;
    let externalId: string | undefined;
    const summary = isRecord(data["envelopeSummary"]) ? data["envelopeSummary"] : undefined;
    const custom =
      summary && isRecord(summary["customFields"]) ? summary["customFields"] : undefined;
    if (custom && Array.isArray(custom["textCustomFields"])) {
      for (const f of custom["textCustomFields"]) {
        if (
          isRecord(f) &&
          f["name"] === EXTERNAL_ID_FIELD &&
          typeof f["value"] === "string" &&
          GUID_RE.test(f["value"])
        ) {
          externalId = f["value"];
        }
      }
    }
    return {
      event,
      ...(providerRef ? { providerRef } : {}),
      ...(externalId ? { externalId } : {}),
    };
  }
  // Legacy XML Connect format: pick the envelope id only.
  const m = /<EnvelopeID>\s*([0-9a-fA-F-]{36})\s*<\/EnvelopeID>/.exec(text);
  const xmlRef = m?.[1] && GUID_RE.test(m[1]) ? m[1] : undefined;
  return xmlRef ? { event: "xml", providerRef: xmlRef } : { event: "unknown" };
}

function num(n: number): string {
  return String(Math.round(n));
}

/** Fractions (top-left origin) → DocuSign points (72 DPI, top-left origin, 1-based page). */
export function tabsFor(fields: readonly ESignField[], size: PageSize): Record<string, unknown[]> {
  const tabs: Record<string, unknown[]> = {};
  for (const f of fields) {
    if (!Number.isInteger(f.page) || f.page < 1 || ![f.x, f.y, f.w, f.h].every(fraction)) {
      throw rejected("field geometry must be page fractions on a 1-based page");
    }
    const base = {
      documentId: "1",
      pageNumber: String(f.page),
      xPosition: num(f.x * size.width),
      yPosition: num(f.y * size.height),
    };
    const sized = { ...base, width: num(f.w * size.width), height: num(f.h * size.height) };
    const list =
      f.kind === "signature"
        ? "signHereTabs"
        : f.kind === "date"
          ? "dateSignedTabs"
          : "fullNameTabs";
    tabs[list] ??= [];
    tabs[list].push(f.kind === "signature" ? base : sized);
  }
  return tabs;
}
