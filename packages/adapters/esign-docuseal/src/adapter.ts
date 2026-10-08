import {
  type ESignAdapterDefinition,
  type ESignAdapterDeps,
  type ESignArtifacts,
  type ESignCallback,
  type ESignConnectionConfig,
  type ESignCredentialField,
  type ESignEnvelopeInput,
  type ESignEnvelopeState,
  type ESignEnvelopeStatus,
  type ESignField,
  type ESignPort,
  ESignProviderError,
  type ESignSigner,
  type ESignSignerStatus,
  type ESignVendorMeta,
  type ESignVerifyResult,
} from "@fundroom/ports";
import {
  asDate,
  asRecord,
  asString,
  fetchFailure,
  isPdf,
  parseJsonObject,
  readBounded,
  readJson,
  secretEquals,
  statusFailure,
  vendorMessage,
} from "./http.js";
import { pdfPageSize, toDocusealArea } from "./pdf-geometry.js";

/**
 * ESignPort over the DocuSeal REST API (`X-Auth-Token`). Endpoint shapes were checked against
 * DocuSeal's published OpenAPI document (https://console.docuseal.com/openapi.json) and, for the
 * self-hosted edition, its open-source routes/controllers — see README.md.
 *
 * Status mapping (DocuSeal → port):
 *
 * | DocuSeal submission                              | port envelope status |
 * |--------------------------------------------------|----------------------|
 * | status completed (or every submitter completed)  | completed            |
 * | status declined (or any submitter declined)      | declined             |
 * | status expired (or expire_at in the past)        | expired              |
 * | archived_at set, not completed                   | voided (our `void()` archives) |
 * | status pending, no submitter opened              | sent                 |
 * | status pending, any submitter opened/completed   | delivered            |
 *
 * | DocuSeal submitter status | port signer status |
 * |---------------------------|--------------------|
 * | completed                 | signed (at completed_at) |
 * | declined                  | declined (at declined_at) |
 * | opened                    | viewed (at opened_at) |
 * | awaiting / sent           | pending            |
 *
 * Identity: every submitter carries `external_id = "<externalId>.<signerKey>"` and
 * `metadata = { seedhost_envelope_id, seedhost_signer_key }`, so status, signing URLs and
 * callbacks map back to our envelope and signer without positional guessing.
 */

const VENDOR = "DocuSeal";
const DEFAULT_BASE_URL = "https://api.docuseal.com";
/** Custom header the admin adds to the DocuSeal webhook (value = our callback secret). */
export const SECRET_HEADER = "x-fundroom-signature";
/**
 * The pre-rename header name (A-2, ADR-0062). DocuSeal webhooks configured before the rename keep
 * sending it until an admin edits them, so it is accepted indefinitely; instructions show only
 * {@link SECRET_HEADER}.
 */
export const LEGACY_SECRET_HEADER = "x-seedhost-signature";

/**
 * Does a callback carry our secret? Every one of our secret headers that is PRESENT must match,
 * and at least one must be present: the new name is checked whenever it is sent (a bad value there
 * is never rescued by a good legacy header), and a legacy header that rides along is checked too
 * (never skipped because the new one matched). Constant-time per header.
 */
export function callbackSecretMatches(headers: Headers, secret: string | undefined): boolean {
  const given = [headers.get(SECRET_HEADER), headers.get(LEGACY_SECRET_HEADER)].filter(
    (value): value is string => value !== null,
  );
  if (given.length === 0) return false;
  let ok = true;
  for (const value of given) ok = secretEquals(value, secret) && ok;
  return ok;
}

export const docusealMeta: ESignVendorMeta = {
  driver: "docuseal",
  displayName: "DocuSeal",
  selfHostable: true,
  baseUrl: { required: false, default: DEFAULT_BASE_URL },
  supports: { templates: true, pdf: true, embeddedSigning: true, void: true },
  callbackSecret: "ours",
  subProcessor: {
    name: "DocuSeal LLC",
    purpose: "Electronic signature of documents (submissions, signer emails, audit log)",
    region:
      "US (api.docuseal.com) or EU/Ireland (api.docuseal.eu); self-hosted: the operator's own infrastructure",
    dpaUrl: "https://www.docuseal.com/privacy/gdpr",
    jurisdiction: "varies",
    certifications: [],
  },
};

export const docusealCredentialFields: readonly ESignCredentialField[] = [
  {
    key: "apiToken",
    label: "API key",
    kind: "secret",
    required: true,
    help: "DocuSeal → Settings → API (sent as X-Auth-Token).",
  },
];

type DocusealFieldType = "signature" | "date" | "text";
const FIELD_TYPE: Record<ESignField["kind"], DocusealFieldType> = {
  signature: "signature",
  date: "date",
  name: "text",
};

/**
 * The API root for a base URL: DocuSeal Cloud serves the API on its own host
 * (`https://api.docuseal.com`, `https://api.docuseal.eu`); a self-hosted instance serves it
 * under `/api` of the app origin.
 */
export function docusealApiRoot(baseUrl: string | undefined): string {
  const base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
  let host = "";
  try {
    host = new URL(base).hostname.toLowerCase();
  } catch {
    return base;
  }
  if (/^api\.docuseal\.(com|eu)$/u.test(host) || base.endsWith("/api")) return base;
  return `${base}/api`;
}

interface Submitter {
  readonly id: number;
  readonly status: string;
  readonly externalId: string | undefined;
  readonly signerKey: string | undefined;
  readonly envelopeId: string | undefined;
  readonly order: number;
  readonly openedAt: Date | undefined;
  readonly completedAt: Date | undefined;
  readonly declinedAt: Date | undefined;
}

interface Submission {
  readonly id: number;
  readonly status: string | undefined;
  readonly archivedAt: Date | undefined;
  readonly expireAt: Date | undefined;
  readonly completedAt: Date | undefined;
  readonly auditLogUrl: string | undefined;
  readonly documents: readonly { readonly url: string }[];
  readonly submitters: readonly Submitter[];
}

function parseSubmitter(value: unknown, index: number): Submitter | undefined {
  const s = asRecord(value);
  const id = s?.["id"];
  if (s === undefined || typeof id !== "number") return undefined;
  const meta = asRecord(s["metadata"]);
  const externalId = asString(s["external_id"]) ?? undefined;
  const dot = externalId?.lastIndexOf(".") ?? -1;
  const signerKey =
    asString(meta?.["seedhost_signer_key"]) ??
    (externalId !== undefined && dot > 0 ? externalId.slice(dot + 1) : undefined);
  const envelopeId =
    asString(meta?.["seedhost_envelope_id"]) ??
    (externalId !== undefined && dot > 0 ? externalId.slice(0, dot) : undefined);
  const completedAt = asDate(s["completed_at"]);
  const declinedAt = asDate(s["declined_at"]);
  const openedAt = asDate(s["opened_at"]);
  const status =
    asString(s["status"]) ??
    (completedAt ? "completed" : declinedAt ? "declined" : openedAt ? "opened" : "sent");
  return {
    id,
    status,
    externalId,
    signerKey,
    envelopeId,
    order: index,
    openedAt,
    completedAt,
    declinedAt,
  };
}

function parseSubmission(value: unknown, op: string): Submission {
  const s = asRecord(value);
  const id = s?.["id"];
  if (s === undefined || typeof id !== "number" || !Array.isArray(s["submitters"])) {
    throw new ESignProviderError(
      `${VENDOR} ${op}: unexpected submission shape`,
      "invalid_response",
      false,
    );
  }
  const submitters = s["submitters"]
    .map((v, i) => parseSubmitter(v, i))
    .filter((x): x is Submitter => x !== undefined);
  const documents = (Array.isArray(s["documents"]) ? s["documents"] : [])
    .map((d) => asString(asRecord(d)?.["url"]))
    .filter((u): u is string => u !== undefined)
    .map((url) => ({ url }));
  return {
    id,
    status: asString(s["status"]),
    archivedAt: asDate(s["archived_at"]),
    expireAt: asDate(s["expire_at"]),
    completedAt: asDate(s["completed_at"]),
    auditLogUrl: asString(s["audit_log_url"]) ?? undefined,
    documents,
    submitters,
  };
}

export function mapSubmissionStatus(
  sub: Pick<Submission, "status" | "archivedAt" | "expireAt" | "submitters">,
  now: Date,
): ESignEnvelopeStatus {
  const all = sub.submitters;
  const completed =
    sub.status === "completed" || (all.length > 0 && all.every((s) => s.status === "completed"));
  if (completed) return "completed";
  if (sub.status === "declined" || all.some((s) => s.status === "declined")) return "declined";
  if (sub.archivedAt !== undefined) return "voided";
  if (
    sub.status === "expired" ||
    (sub.expireAt !== undefined && sub.expireAt.getTime() <= now.getTime())
  ) {
    return "expired";
  }
  return all.some((s) => s.status === "opened" || s.status === "completed") ? "delivered" : "sent";
}

export function mapSubmitterStatus(status: string): ESignSignerStatus {
  switch (status) {
    case "completed":
      return "signed";
    case "declined":
      return "declined";
    case "opened":
      return "viewed";
    default:
      return "pending";
  }
}

function signerAt(s: Submitter): Date | undefined {
  switch (s.status) {
    case "completed":
      return s.completedAt;
    case "declined":
      return s.declinedAt;
    case "opened":
      return s.openedAt;
    default:
      return undefined;
  }
}

function checkSigners(signers: readonly ESignSigner[]): ESignSigner[] {
  if (signers.length === 0) {
    throw new ESignProviderError(
      `${VENDOR} create: at least one signer is required`,
      "rejected",
      false,
    );
  }
  const keys = new Set<string>();
  for (const s of signers) {
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(s.signerKey) || keys.has(s.signerKey)) {
      throw new ESignProviderError(
        `${VENDOR} create: signer keys must be unique [A-Za-z0-9_-]`,
        "rejected",
        false,
      );
    }
    keys.add(s.signerKey);
  }
  return signers
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.order !== b.s.order ? a.s.order - b.s.order : a.i - b.i))
    .map((x) => x.s);
}

export function createDocusealPort(
  config: ESignConnectionConfig,
  deps: ESignAdapterDeps,
): ESignPort {
  const root = docusealApiRoot(config.baseUrl);
  const token = config.credentials["apiToken"] ?? "";
  const secrets = [token, config.callbackSecret ?? ""].filter((s) => s.length > 0);

  const call = async (
    op: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> => {
    if (token.length === 0) {
      throw new ESignProviderError(`${VENDOR} ${op}: no API key configured`, "unauthorized", false);
    }
    let res: Response;
    try {
      res = await deps.fetch(`${root}${path}`, {
        method,
        redirect: "manual",
        headers: {
          "x-auth-token": token,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw fetchFailure(VENDOR, op, err);
    }
    if (res.status < 200 || res.status >= 300) {
      const detail =
        res.status >= 400 && res.status < 500 ? await vendorMessage(res, secrets) : undefined;
      if (detail === undefined) await res.body?.cancel().catch(() => {});
      throw statusFailure(VENDOR, op, res.status, detail);
    }
    return readJson(res, VENDOR, op);
  };

  const getSubmission = async (op: string, providerRef: string): Promise<Submission> => {
    if (!/^[1-9][0-9]{0,15}$/u.test(providerRef)) {
      throw new ESignProviderError(
        `${VENDOR} ${op}: not a DocuSeal submission id`,
        "not_found",
        false,
      );
    }
    return parseSubmission(await call(op, "GET", `/submissions/${providerRef}`), op);
  };

  /** Download a vendor-issued document URL without our API key. */
  const download = async (op: string, url: string, maxBytes: number): Promise<Uint8Array> => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      throw new ESignProviderError(
        `${VENDOR} ${op}: vendor returned an invalid URL`,
        "invalid_response",
        false,
      );
    }
    if (target.protocol !== "https:" && target.protocol !== "http:") {
      throw new ESignProviderError(
        `${VENDOR} ${op}: vendor returned a non-http URL`,
        "invalid_response",
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
      throw statusFailure(VENDOR, op, res.status);
    }
    const bytes = await readBounded(res, maxBytes, VENDOR, op);
    if (!isPdf(bytes)) {
      throw new ESignProviderError(
        `${VENDOR} ${op}: artifact is not a PDF`,
        "invalid_response",
        false,
      );
    }
    return bytes;
  };

  const submitterBase = (input: ESignEnvelopeInput, s: ESignSigner, order: number) => ({
    name: s.name,
    email: s.email,
    external_id: `${input.externalId}.${s.signerKey}`,
    metadata: { seedhost_envelope_id: input.externalId, seedhost_signer_key: s.signerKey },
    send_email: !input.embedded,
    order,
    ...(input.redirectUrl === undefined ? {} : { completed_redirect_url: input.redirectUrl }),
  });

  const common = (input: ESignEnvelopeInput) => ({
    send_email: !input.embedded,
    order: "preserved",
    ...(input.redirectUrl === undefined ? {} : { completed_redirect_url: input.redirectUrl }),
    ...(input.message === undefined
      ? {}
      : {
          message: {
            subject: input.title.slice(0, 255),
            body: `${input.message}\n\n{{submitter.link}}`,
          },
        }),
  });

  /** Our order (1-based, possibly sparse) → DocuSeal's 0-based order index. */
  const orderIndex = (sorted: readonly ESignSigner[]): Map<string, number> => {
    const distinct = [...new Set(sorted.map((s) => s.order))];
    return new Map(sorted.map((s) => [s.signerKey, distinct.indexOf(s.order)]));
  };

  const submissionIdOf = (answer: unknown, op: string): number => {
    const direct = asRecord(answer)?.["id"];
    if (typeof direct === "number" && !Array.isArray(answer)) return direct; // POST /submissions/pdf
    const first = Array.isArray(answer) ? asRecord(answer[0]) : undefined; // POST /submissions
    const id = first?.["submission_id"];
    if (typeof id !== "number") {
      throw new ESignProviderError(
        `${VENDOR} ${op}: unexpected response shape`,
        "invalid_response",
        false,
      );
    }
    return id;
  };

  const createFromTemplate = async (
    input: ESignEnvelopeInput,
    doc: Extract<ESignEnvelopeInput["document"], { kind: "template" }>,
  ): Promise<number> => {
    if (!/^[1-9][0-9]{0,15}$/u.test(doc.templateRef)) {
      throw new ESignProviderError(
        `${VENDOR} create: template reference must be a numeric DocuSeal template id`,
        "rejected",
        false,
      );
    }
    const sorted = checkSigners(input.signers);
    if (sorted.length > 1 && sorted.some((s) => s.role === undefined || s.role.length === 0)) {
      throw new ESignProviderError(
        `${VENDOR} create: template signers need a role each`,
        "rejected",
        false,
      );
    }
    const orders = orderIndex(sorted);
    const answer = await call("create", "POST", "/submissions", {
      template_id: Number(doc.templateRef),
      ...common(input),
      submitters: sorted.map((s, i) => ({
        ...submitterBase(input, s, orders.get(s.signerKey) ?? 0),
        ...(s.role === undefined || s.role.length === 0 ? {} : { role: s.role }),
        // Prefill goes to the first signer: template fields belong to a role, and our templates
        // put the prefilled facts (investor, amount, …) on the signer's own role.
        ...(i === 0 && Object.keys(doc.prefill).length > 0 ? { values: { ...doc.prefill } } : {}),
      })),
    });
    return submissionIdOf(answer, "create");
  };

  const createFromPdf = async (
    input: ESignEnvelopeInput,
    doc: Extract<ESignEnvelopeInput["document"], { kind: "pdf" }>,
  ): Promise<number> => {
    if (!isPdf(doc.bytes)) {
      throw new ESignProviderError(`${VENDOR} create: document is not a PDF`, "rejected", false);
    }
    const sorted = checkSigners(input.signers);
    const orders = orderIndex(sorted);
    const roleOf = new Map(sorted.map((s) => [s.signerKey, s.role ?? `Signer ${s.signerKey}`]));
    const nameOf = new Map(sorted.map((s) => [s.signerKey, s.name]));
    const page = pdfPageSize(doc.bytes);
    if (page.mixed) {
      deps.log?.warn(
        { vendor: "docuseal" },
        "esign.docuseal: PDF has mixed page sizes; using the first",
      );
    }
    const fields = doc.fields.map((f, i) => {
      const role = roleOf.get(f.signerKey);
      if (role === undefined) {
        throw new ESignProviderError(
          `${VENDOR} create: field for an unknown signer`,
          "rejected",
          false,
        );
      }
      if (!Number.isInteger(f.page) || f.page < 1) {
        throw new ESignProviderError(
          `${VENDOR} create: field page must be a 1-based integer`,
          "rejected",
          false,
        );
      }
      return {
        name: `${f.kind}_${f.signerKey}_${i + 1}`,
        type: FIELD_TYPE[f.kind],
        role,
        required: true,
        areas: [toDocusealArea(f, page.size)],
      };
    });
    const answer = await call("create", "POST", "/submissions/pdf", {
      name: input.title,
      ...common(input),
      documents: [
        {
          name: doc.filename.replace(/\.pdf$/iu, "") || "document",
          file: Buffer.from(doc.bytes.buffer, doc.bytes.byteOffset, doc.bytes.byteLength).toString(
            "base64",
          ),
          fields,
        },
      ],
      submitters: sorted.map((s) => {
        const nameValues = Object.fromEntries(
          fields
            .filter((f) => f.type === "text" && f.role === roleOf.get(s.signerKey))
            .map((f) => [f.name, nameOf.get(s.signerKey)]),
        );
        return {
          ...submitterBase(input, s, orders.get(s.signerKey) ?? 0),
          role: roleOf.get(s.signerKey),
          ...(Object.keys(nameValues).length > 0 ? { values: nameValues } : {}),
        };
      }),
    });
    return submissionIdOf(answer, "create");
  };

  return {
    driver: "docuseal",

    async verifyCredentials(): Promise<ESignVerifyResult> {
      if (token.length === 0)
        return { ok: false, reason: "misconfigured", detail: "API key missing" };
      try {
        await call("verify", "GET", "/templates?limit=1");
        return { ok: true };
      } catch (err) {
        if (!(err instanceof ESignProviderError)) return { ok: false, reason: "unreachable" };
        if (err.code === "unauthorized") return { ok: false, reason: "unauthorized" };
        if (err.code === "unavailable" || err.code === "rate_limited") {
          return { ok: false, reason: "unreachable", detail: err.message };
        }
        return {
          ok: false,
          reason: "misconfigured",
          detail: `${err.message} (is the base URL a DocuSeal instance?)`,
        };
      }
    },

    async createEnvelope(input) {
      try {
        const id =
          input.document.kind === "pdf"
            ? await createFromPdf(input, input.document)
            : await createFromTemplate(input, input.document);
        return { providerRef: String(id) };
      } catch (err) {
        if (
          input.document.kind === "pdf" &&
          err instanceof ESignProviderError &&
          err.code === "not_found"
        ) {
          // The open-source edition has no /submissions/pdf (DocuSeal Pro / Cloud only).
          throw new ESignProviderError(
            `${VENDOR} create: this DocuSeal edition has no PDF submissions API (DocuSeal Pro or Cloud required)`,
            "rejected",
            false,
            404,
          );
        }
        throw err;
      }
    },

    async status(providerRef): Promise<ESignEnvelopeState> {
      const sub = await getSubmission("status", providerRef);
      const status = mapSubmissionStatus(sub, deps.now());
      const signers = sub.submitters.map((s) => {
        const at = signerAt(s);
        return {
          signerKey: s.signerKey ?? `s${s.order + 1}`,
          status: mapSubmitterStatus(s.status),
          ...(at === undefined ? {} : { at }),
        };
      });
      const last = sub.submitters
        .map((s) => s.completedAt?.getTime() ?? 0)
        .reduce((a, b) => Math.max(a, b), 0);
      return {
        status,
        signers,
        ...(status === "completed"
          ? { completedAt: sub.completedAt ?? (last > 0 ? new Date(last) : deps.now()) }
          : {}),
      };
    },

    async signingUrl(providerRef, signerKey, returnUrl) {
      const sub = await getSubmission("signing url", providerRef);
      const st = mapSubmissionStatus(sub, deps.now());
      if (st !== "sent" && st !== "delivered") return undefined;
      const submitter = sub.submitters.find((s) => s.signerKey === signerKey);
      if (
        submitter === undefined ||
        submitter.status === "completed" ||
        submitter.status === "declined"
      ) {
        return undefined;
      }
      // PUT /submitters/{id} sets the per-signer redirect and answers with the signing link.
      const updated = asRecord(
        await call("signing url", "PUT", `/submitters/${submitter.id}`, {
          completed_redirect_url: returnUrl,
        }),
      );
      const src = asString(updated?.["embed_src"]);
      if (src === undefined) return undefined;
      try {
        const url = new URL(src);
        return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
      } catch {
        return undefined;
      }
    },

    async downloadSigned(providerRef, limits): Promise<ESignArtifacts> {
      const sub = await getSubmission("download", providerRef);
      if (mapSubmissionStatus(sub, deps.now()) !== "completed") {
        throw new ESignProviderError(
          `${VENDOR} download: submission is not completed`,
          "rejected",
          false,
        );
      }
      // merge=true asks for one combined PDF of every document in the submission.
      const docs = asRecord(
        await call("download", "GET", `/submissions/${providerRef}/documents?merge=true`),
      );
      const urls = (Array.isArray(docs?.["documents"]) ? docs["documents"] : [])
        .map((d) => asString(asRecord(d)?.["url"]))
        .filter((u): u is string => u !== undefined);
      const url = urls[0] ?? sub.documents[0]?.url;
      if (url === undefined) {
        throw new ESignProviderError(
          `${VENDOR} download: no signed document URL`,
          "invalid_response",
          false,
        );
      }
      if (urls.length > 1) {
        deps.log?.warn(
          { vendor: "docuseal", documents: urls.length },
          "esign.docuseal: kept the first of several documents",
        );
      }
      const document = await download("download", url, limits.maxBytes);
      const certificate =
        sub.auditLogUrl === undefined
          ? undefined
          : await download("audit log", sub.auditLogUrl, limits.maxBytes);
      return certificate === undefined ? { document } : { document, certificate };
    },

    async void(providerRef, _reason) {
      const sub = await getSubmission("void", providerRef);
      const st = mapSubmissionStatus(sub, deps.now());
      if (st === "voided") return; // already archived
      if (st !== "sent" && st !== "delivered") {
        throw new ESignProviderError(
          `${VENDOR} void: submission is already final`,
          "rejected",
          false,
        );
      }
      await call("void", "DELETE", `/submissions/${providerRef}`);
    },

    async parseCallback(request): Promise<ESignCallback | undefined> {
      // DocuSeal sends the admin-configured header verbatim on every delivery attempt. Its
      // `timestamp` is the event's creation time and is reused across retries (up to 48 h), so a
      // freshness window would drop legitimate retries; the pull-verify rule makes replay harmless.
      try {
        if (!callbackSecretMatches(request.headers, config.callbackSecret)) return undefined;
        const body = parseJsonObject(request.body);
        if (body === undefined) return undefined;
        const event = asString(body["event_type"]);
        const data = asRecord(body["data"]);
        if (event === undefined || data === undefined) return undefined;
        let submissionId: unknown;
        let submitter: Record<string, unknown> | undefined;
        if (event.startsWith("form.")) {
          submissionId = asRecord(data["submission"])?.["id"] ?? data["submission_id"];
          submitter = data;
        } else if (event.startsWith("submission.")) {
          submissionId = data["id"];
          submitter = Array.isArray(data["submitters"])
            ? asRecord(data["submitters"][0])
            : undefined;
        } else {
          return undefined;
        }
        const parsed =
          submitter === undefined ? undefined : parseSubmitter({ id: 0, ...submitter }, 0);
        const providerRef =
          typeof submissionId === "number" && Number.isSafeInteger(submissionId) && submissionId > 0
            ? String(submissionId)
            : undefined;
        const externalId = parsed?.envelopeId;
        if (providerRef === undefined && externalId === undefined) return undefined;
        return {
          event: event.slice(0, 64),
          ...(providerRef === undefined ? {} : { providerRef }),
          ...(externalId === undefined ? {} : { externalId }),
        };
      } catch {
        return undefined;
      }
    },
  };
}

export const docusealAdapter: ESignAdapterDefinition = {
  meta: docusealMeta,
  credentialFields: docusealCredentialFields,
  create: createDocusealPort,
};
