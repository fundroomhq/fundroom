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

/**
 * ESignPort over the Documenso public API **v1** (`/api/v1/...`). Endpoint shapes were checked
 * against Documenso's own v1 contract (`packages/api/v1/{contract,schema,implementation}.ts`) and
 * the published v1 OpenAPI reference (https://openapi-v1.documenso.com) — see README.md.
 *
 * Status mapping (Documenso → port):
 *
 * | Documenso document.status | recipients                         | port envelope status |
 * |---------------------------|------------------------------------|----------------------|
 * | DRAFT                     | —                                  | sent (never seen after a successful create) |
 * | PENDING                   | no signer has readStatus OPENED    | sent                 |
 * | PENDING                   | any signer readStatus OPENED       | delivered            |
 * | COMPLETED                 | —                                  | completed            |
 * | REJECTED                  | —                                  | declined             |
 * | CANCELLED                 | —                                  | voided               |
 * | (HTTP 404)                | a cancelled pending doc is hard-deleted by v1 | throws `not_found` |
 *
 * | Documenso recipient                                     | port signer status |
 * |---------------------------------------------------------|--------------------|
 * | signingStatus SIGNED                                    | signed (at signedAt) |
 * | signingStatus REJECTED                                  | declined           |
 * | readStatus OPENED                                       | viewed             |
 * | otherwise                                               | pending            |
 *
 * Signer keys: Documenso recipients carry no free-form metadata, so the adapter derives the
 * signer key from position — the n-th signing recipient ordered by (signingOrder, recipient id) is
 * `s<n>`. `createEnvelope` therefore requires the input's signer keys, ordered by `order`, to be
 * exactly `s1..sN` (the kernel always uses that scheme) and refuses anything else.
 */

const VENDOR = "Documenso";
const DEFAULT_BASE_URL = "https://app.documenso.com";
/** Documenso sets `createdAt` when each delivery attempt runs; bound replay of a captured request. */
export const CALLBACK_SKEW_MS = 5 * 60 * 1000;
export const SECRET_HEADER = "x-documenso-secret";

export const documensoMeta: ESignVendorMeta = {
  driver: "documenso",
  displayName: "Documenso",
  selfHostable: true,
  baseUrl: { required: false, default: DEFAULT_BASE_URL },
  supports: { templates: true, pdf: true, embeddedSigning: true, void: true },
  callbackSecret: "ours",
  subProcessor: {
    name: "Documenso, Inc.",
    purpose: "Electronic signature of documents (envelopes, signer emails, audit certificate)",
    region: "Documenso Cloud (vendor-operated); self-hosted: the operator's own infrastructure",
    dpaUrl: "https://documen.so/dpa",
    jurisdiction: "varies",
    certifications: ["SOC 2"],
  },
};

export const documensoCredentialFields: readonly ESignCredentialField[] = [
  {
    key: "apiToken",
    label: "API token",
    kind: "secret",
    required: true,
    help: "Documenso → Settings → API Tokens (team tokens act for the team). Starts with api_.",
  },
];

type FieldType = "SIGNATURE" | "DATE" | "NAME";
const FIELD_TYPE: Record<ESignField["kind"], FieldType> = {
  signature: "SIGNATURE",
  date: "DATE",
  name: "NAME",
};

/** Fractions of the page (port) → Documenso's percentages of the page (0–100, origin top-left). */
export function toDocumensoGeometry(field: ESignField): {
  pageNumber: number;
  pageX: number;
  pageY: number;
  pageWidth: number;
  pageHeight: number;
} {
  const pct = (v: number): number => Math.round(Math.min(Math.max(v, 0), 1) * 100 * 1000) / 1000;
  if (!Number.isInteger(field.page) || field.page < 1) {
    throw new ESignProviderError(
      `${VENDOR} create: field page must be a 1-based integer`,
      "rejected",
      false,
    );
  }
  return {
    pageNumber: field.page,
    pageX: pct(field.x),
    pageY: pct(field.y),
    pageWidth: pct(field.w),
    pageHeight: pct(field.h),
  };
}

interface DocRecipient {
  readonly id: number;
  readonly email: string;
  readonly role: string;
  readonly signingOrder: number | null;
  readonly readStatus: string;
  readonly signingStatus: string;
  readonly signedAt: Date | undefined;
  readonly signingUrl: string | undefined;
}

interface DocView {
  readonly id: number;
  readonly status: string;
  readonly completedAt: Date | undefined;
  readonly recipients: readonly DocRecipient[];
}

function parseRecipient(value: unknown): DocRecipient | undefined {
  const r = asRecord(value);
  if (r === undefined) return undefined;
  const id = r["id"] ?? r["recipientId"];
  if (typeof id !== "number") return undefined;
  const order = r["signingOrder"];
  return {
    id,
    email: asString(r["email"]) ?? "",
    role: asString(r["role"]) ?? "SIGNER",
    signingOrder: typeof order === "number" ? order : null,
    readStatus: asString(r["readStatus"]) ?? "NOT_OPENED",
    signingStatus: asString(r["signingStatus"]) ?? "NOT_SIGNED",
    signedAt: asDate(r["signedAt"]),
    signingUrl: asString(r["signingUrl"]),
  };
}

function parseDocument(value: unknown, op: string): DocView {
  const d = asRecord(value);
  const id = d?.["id"];
  const status = asString(d?.["status"]);
  if (d === undefined || typeof id !== "number" || status === undefined) {
    throw new ESignProviderError(
      `${VENDOR} ${op}: unexpected document shape`,
      "invalid_response",
      false,
    );
  }
  const recipients = Array.isArray(d["recipients"])
    ? d["recipients"].map(parseRecipient).filter((r): r is DocRecipient => r !== undefined)
    : [];
  return { id, status, completedAt: asDate(d["completedAt"]), recipients };
}

/** Signing recipients (CC/viewers excluded) in the order that defines `s1..sN`. */
function signingRecipients(recipients: readonly DocRecipient[]): DocRecipient[] {
  return recipients
    .filter((r) => r.role !== "CC" && r.role !== "VIEWER")
    .slice()
    .sort((a, b) => {
      const ao = a.signingOrder ?? Number.MAX_SAFE_INTEGER;
      const bo = b.signingOrder ?? Number.MAX_SAFE_INTEGER;
      return ao !== bo ? ao - bo : a.id - b.id;
    });
}

export function mapDocumentStatus(
  doc: Pick<DocView, "status" | "recipients">,
): ESignEnvelopeStatus {
  switch (doc.status) {
    case "COMPLETED":
      return "completed";
    case "REJECTED":
      return "declined";
    case "CANCELLED":
      return "voided";
    default: {
      // DRAFT, PENDING, and any status a newer Documenso adds: still open.
      const opened = signingRecipients(doc.recipients).some(
        (r) => r.readStatus === "OPENED" || r.signingStatus === "SIGNED",
      );
      return opened ? "delivered" : "sent";
    }
  }
}

export function mapRecipientStatus(
  r: Pick<DocRecipient, "readStatus" | "signingStatus">,
): ESignSignerStatus {
  if (r.signingStatus === "SIGNED") return "signed";
  if (r.signingStatus === "REJECTED") return "declined";
  if (r.readStatus === "OPENED") return "viewed";
  return "pending";
}

/** Signers sorted by order; their keys must be s1..sN (see the file comment). */
function orderedSigners(signers: readonly ESignSigner[]): ESignSigner[] {
  if (signers.length === 0) {
    throw new ESignProviderError(
      `${VENDOR} create: at least one signer is required`,
      "rejected",
      false,
    );
  }
  const sorted = signers
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.order !== b.s.order ? a.s.order - b.s.order : a.i - b.i))
    .map((x) => x.s);
  sorted.forEach((s, i) => {
    if (s.signerKey !== `s${i + 1}`) {
      throw new ESignProviderError(
        `${VENDOR} create: signer keys must be s1..sN in signing order`,
        "rejected",
        false,
      );
    }
  });
  return sorted;
}

function apiRoot(baseUrl: string | undefined): string {
  const base = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/u, "");
  return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
}

export function createDocumensoPort(
  config: ESignConnectionConfig,
  deps: ESignAdapterDeps,
): ESignPort {
  const root = apiRoot(config.baseUrl);
  const token = config.credentials["apiToken"] ?? "";
  const secrets = [token, config.callbackSecret ?? ""].filter((s) => s.length > 0);

  const call = async (
    op: string,
    method: string,
    path: string,
    body?: unknown,
    okStatuses: readonly number[] = [200, 201],
  ): Promise<unknown> => {
    if (token.length === 0) {
      throw new ESignProviderError(
        `${VENDOR} ${op}: no API token configured`,
        "unauthorized",
        false,
      );
    }
    let res: Response;
    try {
      res = await deps.fetch(`${root}${path}`, {
        method,
        redirect: "manual",
        headers: {
          authorization: token,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (err) {
      throw fetchFailure(VENDOR, op, err);
    }
    if (!okStatuses.includes(res.status)) {
      const detail =
        res.status >= 400 && res.status < 500 ? await vendorMessage(res, secrets) : undefined;
      if (detail === undefined) await res.body?.cancel().catch(() => {});
      throw statusFailure(VENDOR, op, res.status, detail);
    }
    return readJson(res, VENDOR, op);
  };

  /** Fetch a vendor-issued (presigned) URL: no Authorization header ever goes to it. */
  const fetchPresigned = async (op: string, url: string, init: RequestInit): Promise<Response> => {
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
    try {
      return await deps.fetch(target.toString(), { ...init, redirect: "manual" });
    } catch (err) {
      throw fetchFailure(VENDOR, op, err);
    }
  };

  const getDocument = async (op: string, providerRef: string): Promise<DocView> => {
    if (!/^[1-9][0-9]{0,15}$/u.test(providerRef)) {
      throw new ESignProviderError(
        `${VENDOR} ${op}: not a Documenso document id`,
        "not_found",
        false,
      );
    }
    return parseDocument(await call(op, "GET", `/documents/${providerRef}`), op);
  };

  const bestEffortDelete = async (documentId: number): Promise<void> => {
    try {
      await call("cleanup", "DELETE", `/documents/${documentId}`);
    } catch (err) {
      deps.log?.warn(
        {
          vendor: "documenso",
          documentId,
          code: err instanceof ESignProviderError ? err.code : "error",
        },
        "esign.documenso: could not delete a half-created draft",
      );
    }
  };

  const distribution = (input: ESignEnvelopeInput): Record<string, unknown> => ({
    subject: input.title.slice(0, 255),
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.redirectUrl === undefined ? {} : { redirectUrl: input.redirectUrl }),
    signingOrder: new Set(input.signers.map((s) => s.order)).size > 1 ? "SEQUENTIAL" : "PARALLEL",
    distributionMethod: input.embedded ? "NONE" : "EMAIL",
  });

  const send = async (documentId: number, input: ESignEnvelopeInput): Promise<void> => {
    await call("send", "POST", `/documents/${documentId}/send`, { sendEmail: !input.embedded });
  };

  const createFromPdf = async (
    input: ESignEnvelopeInput,
    doc: Extract<ESignEnvelopeInput["document"], { kind: "pdf" }>,
  ): Promise<number> => {
    if (!isPdf(doc.bytes)) {
      throw new ESignProviderError(`${VENDOR} create: document is not a PDF`, "rejected", false);
    }
    const signers = orderedSigners(input.signers);
    const created = asRecord(
      await call("create", "POST", "/documents", {
        title: input.title,
        externalId: input.externalId,
        recipients: signers.map((s) => ({
          name: s.name,
          email: s.email,
          role: "SIGNER",
          signingOrder: s.order,
        })),
        meta: distribution(input),
      }),
    );
    const documentId = created?.["documentId"];
    const uploadUrl = asString(created?.["uploadUrl"]);
    if (typeof documentId !== "number" || uploadUrl === undefined) {
      throw new ESignProviderError(
        `${VENDOR} create: unexpected response shape`,
        "invalid_response",
        false,
      );
    }
    try {
      const recipients = signingRecipients(
        (Array.isArray(created?.["recipients"]) ? created["recipients"] : [])
          .map(parseRecipient)
          .filter((r): r is DocRecipient => r !== undefined),
      );
      if (recipients.length !== signers.length) {
        throw new ESignProviderError(
          `${VENDOR} create: recipient count mismatch`,
          "invalid_response",
          false,
        );
      }
      const recipientFor = new Map(
        signers.map((s, i) => [s.signerKey, recipients[i] as DocRecipient]),
      );

      // Documenso v1 hands out a presigned PUT URL (S3 or Azure) for the PDF bytes.
      const upload = await fetchPresigned("upload", uploadUrl, {
        method: "PUT",
        headers: {
          "content-type": "application/pdf",
          ...(new URL(uploadUrl).hostname.endsWith(".blob.core.windows.net")
            ? { "x-ms-blob-type": "BlockBlob" }
            : {}),
        },
        body: doc.bytes,
      });
      await upload.body?.cancel().catch(() => {});
      if (upload.status < 200 || upload.status >= 300)
        throw statusFailure(VENDOR, "upload", upload.status);

      if (doc.fields.length > 0) {
        const fields = doc.fields.map((f) => {
          const recipient = recipientFor.get(f.signerKey);
          if (recipient === undefined) {
            throw new ESignProviderError(
              `${VENDOR} create: field for an unknown signer`,
              "rejected",
              false,
            );
          }
          return { recipientId: recipient.id, type: FIELD_TYPE[f.kind], ...toDocumensoGeometry(f) };
        });
        await call("fields", "POST", `/documents/${documentId}/fields`, fields);
      }
      await send(documentId, input);
    } catch (err) {
      await bestEffortDelete(documentId);
      throw err;
    }
    return documentId;
  };

  const createFromTemplate = async (
    input: ESignEnvelopeInput,
    doc: Extract<ESignEnvelopeInput["document"], { kind: "template" }>,
  ): Promise<number> => {
    if (!/^[1-9][0-9]{0,15}$/u.test(doc.templateRef)) {
      throw new ESignProviderError(
        `${VENDOR} create: template reference must be a numeric Documenso template id`,
        "rejected",
        false,
      );
    }
    const signers = orderedSigners(input.signers);
    const template = asRecord(await call("template", "GET", `/templates/${doc.templateRef}`));
    const tRecipients = (Array.isArray(template?.["Recipient"]) ? template["Recipient"] : [])
      .map((v) => asRecord(v))
      .filter((r): r is Record<string, unknown> => r !== undefined && typeof r["id"] === "number");
    const tFields = (Array.isArray(template?.["Field"]) ? template["Field"] : [])
      .map((v) => asRecord(v))
      .filter((r): r is Record<string, unknown> => r !== undefined && typeof r["id"] === "number");

    // Template role → template recipient: match the recipient's placeholder name, then its email
    // placeholder, then its numeric id; a single-recipient template takes a role-less signer.
    const used = new Set<number>();
    const recipients = signers.map((s) => {
      const role = s.role?.trim().toLowerCase();
      const match =
        role === undefined || role.length === 0
          ? tRecipients.length === 1
            ? tRecipients[0]
            : undefined
          : tRecipients.find(
              (r) =>
                !used.has(r["id"] as number) &&
                ((asString(r["name"]) ?? "").trim().toLowerCase() === role ||
                  (asString(r["email"]) ?? "").trim().toLowerCase() === role ||
                  String(r["id"]) === role),
            );
      if (match === undefined) {
        throw new ESignProviderError(
          `${VENDOR} create: template has no recipient for role "${s.role ?? ""}"`,
          "rejected",
          false,
        );
      }
      used.add(match["id"] as number);
      return { id: match["id"] as number, email: s.email, name: s.name, signingOrder: s.order };
    });

    // Prefill: a key naming a template text/number field (by its label) becomes a prefillFields
    // entry; every other key is passed as a PDF form value (AcroForm field name).
    const prefillFields: { id: number; type: "text" | "number"; value: string }[] = [];
    const formValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(doc.prefill)) {
      const k = key.trim().toLowerCase();
      const field = tFields.find((f) => {
        const label = asString(asRecord(f["fieldMeta"])?.["label"]);
        const type = asString(f["type"]);
        return (type === "TEXT" || type === "NUMBER") && label?.trim().toLowerCase() === k;
      });
      if (field !== undefined) {
        prefillFields.push({
          id: field["id"] as number,
          type: field["type"] === "NUMBER" ? "number" : "text",
          value,
        });
      } else {
        formValues[key] = value;
      }
    }

    const generated = asRecord(
      await call("create", "POST", `/templates/${doc.templateRef}/generate-document`, {
        title: input.title,
        externalId: input.externalId,
        recipients,
        meta: distribution(input),
        ...(prefillFields.length > 0 ? { prefillFields } : {}),
        ...(Object.keys(formValues).length > 0 ? { formValues } : {}),
      }),
    );
    const documentId = generated?.["documentId"];
    if (typeof documentId !== "number") {
      throw new ESignProviderError(
        `${VENDOR} create: unexpected response shape`,
        "invalid_response",
        false,
      );
    }
    try {
      await send(documentId, input);
    } catch (err) {
      await bestEffortDelete(documentId);
      throw err;
    }
    return documentId;
  };

  const downloadUrl = async (op: string, url: string, maxBytes: number): Promise<Uint8Array> => {
    const res = await fetchPresigned(op, url, { method: "GET" });
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

  return {
    driver: "documenso",

    async verifyCredentials(): Promise<ESignVerifyResult> {
      if (token.length === 0)
        return { ok: false, reason: "misconfigured", detail: "API token missing" };
      try {
        await call("verify", "GET", "/documents?page=1&perPage=1");
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
          detail: `${err.message} (is the base URL a Documenso instance?)`,
        };
      }
    },

    async createEnvelope(input) {
      const documentId =
        input.document.kind === "pdf"
          ? await createFromPdf(input, input.document)
          : await createFromTemplate(input, input.document);
      return { providerRef: String(documentId) };
    },

    async status(providerRef): Promise<ESignEnvelopeState> {
      const doc = await getDocument("status", providerRef);
      const status = mapDocumentStatus(doc);
      const signers = signingRecipients(doc.recipients).map((r, i) => {
        const s = mapRecipientStatus(r);
        return {
          signerKey: `s${i + 1}`,
          status: s,
          ...(s === "signed" && r.signedAt !== undefined ? { at: r.signedAt } : {}),
        };
      });
      return {
        status,
        signers,
        ...(status === "completed" ? { completedAt: doc.completedAt ?? deps.now() } : {}),
      };
    },

    async signingUrl(providerRef, signerKey, _returnUrl) {
      // v1 fixes the post-signing redirect at creation (meta.redirectUrl); it cannot be set per call.
      const doc = await getDocument("signing url", providerRef);
      if (doc.status !== "PENDING") return undefined;
      const index = /^s([1-9][0-9]*)$/u.exec(signerKey);
      if (index === null) return undefined;
      const recipient = signingRecipients(doc.recipients)[Number(index[1]) - 1];
      const url = recipient?.signingUrl;
      if (url === undefined) return undefined;
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:" || parsed.protocol === "http:"
          ? parsed.toString()
          : undefined;
      } catch {
        return undefined;
      }
    },

    async downloadSigned(providerRef, limits): Promise<ESignArtifacts> {
      const doc = await getDocument("download", providerRef);
      if (doc.status !== "COMPLETED") {
        throw new ESignProviderError(
          `${VENDOR} download: document is not completed`,
          "rejected",
          false,
        );
      }
      const answer = asRecord(await call("download", "GET", `/documents/${providerRef}/download`));
      const url = asString(answer?.["downloadUrl"]);
      if (url === undefined) {
        throw new ESignProviderError(
          `${VENDOR} download: no download URL`,
          "invalid_response",
          false,
        );
      }
      // Documenso seals its signing certificate into the completed PDF; v1 has no separate file.
      return { document: await downloadUrl("download", url, limits.maxBytes) };
    },

    async void(providerRef, _reason) {
      // v1 DELETE hard-deletes a pending document (recipients get a cancellation mail) but only
      // soft-deletes a completed one — never send it for a terminal document.
      const doc = await getDocument("void", providerRef);
      if (doc.status === "COMPLETED" || doc.status === "REJECTED" || doc.status === "CANCELLED") {
        throw new ESignProviderError(
          `${VENDOR} void: document is already final`,
          "rejected",
          false,
        );
      }
      await call("void", "DELETE", `/documents/${providerRef}`);
    },

    async parseCallback(request): Promise<ESignCallback | undefined> {
      try {
        if (!secretEquals(request.headers.get(SECRET_HEADER), config.callbackSecret))
          return undefined;
        const body = parseJsonObject(request.body);
        if (body === undefined) return undefined;
        const event = asString(body["event"]);
        const payload = asRecord(body["payload"]);
        if (event === undefined || payload === undefined) return undefined;
        const createdAt = asDate(body["createdAt"]);
        if (
          createdAt !== undefined &&
          Math.abs(deps.now().getTime() - createdAt.getTime()) > CALLBACK_SKEW_MS
        ) {
          return undefined;
        }
        const id = payload["id"];
        const providerRef =
          typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? String(id) : undefined;
        const externalId = asString(payload["externalId"]);
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

export const documensoAdapter: ESignAdapterDefinition = {
  meta: documensoMeta,
  credentialFields: documensoCredentialFields,
  create: createDocumensoPort,
};
