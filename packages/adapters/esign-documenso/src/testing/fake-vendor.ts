/**
 * A scripted fake of the slice of the Documenso v1 API this adapter calls. Pure request →
 * response (`handle(request)`), so it backs both a fake `fetch` for unit tests and the real
 * node:http server in `fake-server.ts`. Behaviour mirrors Documenso where it matters to us:
 * `Authorization: <token>` (or `Bearer <token>`), presigned upload/download URLs that must NOT
 * carry the Authorization header, hard delete of a pending document, `X-Documenso-Secret`
 * callbacks with a per-attempt `createdAt`.
 */

/** Structurally identical to `FakeVendorControl` in `@fundroom/esign/testing` (kept local so this
 *  package depends only on `@fundroom/ports` at runtime). */
export interface FakeVendorControl {
  complete(providerRef: string): void;
  decline(providerRef: string): void;
  voidFromVendor(providerRef: string): void;
  callback(
    providerRef: string,
    event: "completed" | "declined" | "viewed",
  ): { headers: Headers; body: Uint8Array };
  forgedCallback(providerRef: string): { headers: Headers; body: Uint8Array };
  created(): readonly { providerRef: string; input: unknown }[];
}

export interface FakeDocumensoOptions {
  /** Origin the fake answers as (used in presigned and signing URLs). Can be a getter for servers. */
  readonly baseUrl: string | (() => string);
  readonly apiToken?: string;
  /** The secret the fake signs callbacks with (the connection's callbackSecret). */
  readonly callbackSecret?: string;
  readonly now?: () => Date;
}

export interface FakeRequestLogEntry {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
}

export interface FakeDocumensoControl extends FakeVendorControl {
  readonly apiToken: string;
  /** The secret callbacks are signed with right now. */
  readonly callbackSecret: string;
  /** Point the fake at the secret the server generated for the connection (PUT /esign/connection
   *  answers it once), like an admin pasting it into Documenso's webhook form. */
  setCallbackSecret(secret: string): void;
  /** Every request the fake received, in order. */
  readonly requests: FakeRequestLogEntry[];
  /** The next `times` API calls (not presigned transfers) answer `status` with a JSON error. */
  failNext(status: number, times?: number): void;
  /** Replace the signed artifact served for completed documents (e.g. an oversize or non-PDF body). */
  setArtifact(bytes: Uint8Array | undefined, options?: { readonly chunked?: boolean }): void;
  /** The fields posted for a document (Documenso units: percentages). */
  fieldsOf(providerRef: string): readonly Record<string, unknown>[];
  /** Raw document status, or undefined once hard-deleted. */
  documentStatus(providerRef: string): string | undefined;
}

interface FakeRecipient {
  id: number;
  name: string;
  email: string;
  role: string;
  signingOrder: number | null;
  token: string;
  readStatus: "NOT_OPENED" | "OPENED";
  signingStatus: "NOT_SIGNED" | "SIGNED" | "REJECTED";
  sendStatus: "NOT_SENT" | "SENT";
  signedAt: string | null;
}

interface FakeDocument {
  id: number;
  externalId: string | null;
  title: string;
  status: "DRAFT" | "PENDING" | "COMPLETED" | "REJECTED" | "CANCELLED";
  recipients: FakeRecipient[];
  fields: Record<string, unknown>[];
  needsUpload: boolean;
  uploaded: boolean;
  completedAt: string | null;
  createdAt: string;
}

export const FAKE_TEMPLATE_ID = 101;
export const FAKE_TEMPLATE_ROLE = "Signer";

/** A minimal, structurally valid one-page PDF (base-14 Helvetica). */
export function fakePdf(label: string): Uint8Array {
  const safe = label.replace(/[()\\\r\n]/gu, " ");
  const stream = `BT /F1 12 Tf 72 720 Td (${safe}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createFakeDocumenso(options: FakeDocumensoOptions): {
  handle(request: Request): Promise<Response>;
  vendor: FakeDocumensoControl;
} {
  const apiToken = options.apiToken ?? "api_fake_documenso_token";
  let callbackSecret = options.callbackSecret ?? "fake-documenso-webhook-secret";
  const now = options.now ?? (() => new Date());
  const base = (): string =>
    (typeof options.baseUrl === "function" ? options.baseUrl() : options.baseUrl).replace(
      /\/+$/u,
      "",
    );

  const documents = new Map<number, FakeDocument>();
  /** Last known snapshot, kept after a hard delete so a callback can still describe it. */
  const snapshots = new Map<number, FakeDocument>();
  const createdLog: { providerRef: string; input: unknown }[] = [];
  const requests: FakeRequestLogEntry[] = [];
  let nextDocId = 1000;
  let nextRecipientId = 500;
  let nextFieldId = 9000;
  let failures: { status: number; remaining: number } = { status: 500, remaining: 0 };
  let artifact: { bytes: Uint8Array; chunked: boolean } | undefined;

  const template = {
    id: FAKE_TEMPLATE_ID,
    externalId: null,
    type: "PRIVATE",
    title: "Subscription agreement",
    userId: 1,
    teamId: 1,
    Recipient: [
      {
        id: 7,
        email: "investor@template.invalid",
        name: FAKE_TEMPLATE_ROLE,
        signingOrder: 1,
        role: "SIGNER",
      },
    ],
    Field: [
      {
        id: 70,
        recipientId: 7,
        type: "TEXT",
        page: 1,
        fieldMeta: { type: "text", label: "investor_name" },
      },
      { id: 71, recipientId: 7, type: "SIGNATURE", page: 1, fieldMeta: null },
    ],
  };

  const recipientView = (r: FakeRecipient, documentId: number) => ({
    id: r.id,
    documentId,
    email: r.email,
    name: r.name,
    role: r.role,
    signingOrder: r.signingOrder,
    token: r.token,
    signedAt: r.signedAt,
    readStatus: r.readStatus,
    signingStatus: r.signingStatus,
    sendStatus: r.sendStatus,
    signingUrl: `${base()}/sign/${r.token}`,
  });

  const docView = (d: FakeDocument) => ({
    id: d.id,
    externalId: d.externalId,
    userId: 1,
    teamId: 1,
    title: d.title,
    status: d.status,
    createdAt: d.createdAt,
    updatedAt: now().toISOString(),
    completedAt: d.completedAt,
    recipients: d.recipients.map((r) => recipientView(r, d.id)),
    fields: [],
  });

  const newRecipients = (
    list: readonly { name?: unknown; email?: unknown; role?: unknown; signingOrder?: unknown }[],
  ): FakeRecipient[] =>
    list.map((r) => {
      nextRecipientId += 1;
      return {
        id: nextRecipientId,
        name: typeof r.name === "string" ? r.name : "",
        email: typeof r.email === "string" ? r.email : "",
        role: typeof r.role === "string" ? r.role : "SIGNER",
        signingOrder: typeof r.signingOrder === "number" ? r.signingOrder : null,
        token: `tok${nextRecipientId}x${Math.random().toString(36).slice(2, 10)}`,
        readStatus: "NOT_OPENED",
        signingStatus: "NOT_SIGNED",
        sendStatus: "NOT_SENT",
        signedAt: null,
      };
    });

  const store = (d: FakeDocument): void => {
    documents.set(d.id, d);
    snapshots.set(d.id, d);
  };

  const find = (ref: string): FakeDocument => {
    const d = documents.get(Number(ref));
    if (d === undefined) throw new Error(`fake documenso: no document ${ref}`);
    return d;
  };

  const readBody = async (
    request: Request,
  ): Promise<Record<string, unknown> | unknown[] | undefined> => {
    const text = await request.text();
    if (text.length === 0) return undefined;
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };

  const artifactResponse = (d: FakeDocument): Response => {
    const bytes = artifact?.bytes ?? fakePdf(`Signed: ${d.title}`);
    if (artifact?.chunked === true) {
      // No Content-Length: the adapter has to count while streaming.
      const chunk = 1024;
      let offset = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset >= bytes.byteLength) {
            controller.close();
            return;
          }
          controller.enqueue(bytes.slice(offset, offset + chunk));
          offset += chunk;
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/pdf" } });
    }
    return new Response(bytes, {
      status: 200,
      headers: { "content-type": "application/pdf", "content-length": String(bytes.byteLength) },
    });
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const authorization = request.headers.get("authorization");
    requests.push({ method: request.method, url: url.pathname + url.search, authorization });
    const path = url.pathname;

    // ---- presigned object-store URLs: must never see our API token -------------------------
    const s3 = /^\/__s3\/(upload|download)\/(\d+)$/u.exec(path);
    if (s3 !== null) {
      if (authorization !== null) {
        return new Response("<Error><Code>InvalidArgument</Code></Error>", { status: 400 });
      }
      if (url.searchParams.get("X-Amz-Signature") !== "fake")
        return new Response("denied", { status: 403 });
      const d = documents.get(Number(s3[2]));
      if (d === undefined) return new Response("no such key", { status: 404 });
      if (s3[1] === "upload") {
        if (request.method !== "PUT") return new Response("method", { status: 405 });
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (!new TextDecoder().decode(bytes.slice(0, 5)).startsWith("%PDF-")) {
          return new Response("not a pdf", { status: 400 });
        }
        d.uploaded = true;
        return new Response(null, { status: 200 });
      }
      if (request.method !== "GET" || d.status !== "COMPLETED")
        return new Response("no", { status: 404 });
      return artifactResponse(d);
    }

    if (!path.startsWith("/api/v1/")) return json(404, { message: "Not found" });
    const bearer =
      authorization?.startsWith("Bearer ") === true ? authorization.slice(7) : authorization;
    if (bearer !== apiToken) return json(401, { message: "Unauthorized" });
    if (failures.remaining > 0) {
      failures = { ...failures, remaining: failures.remaining - 1 };
      return json(failures.status, { message: `injected ${failures.status}` });
    }
    const route = path.slice("/api/v1".length);
    const method = request.method;

    if (method === "GET" && route === "/documents") {
      return json(200, { documents: [...documents.values()].map(docView), totalPages: 1 });
    }
    if (method === "POST" && route === "/documents") {
      const body = (await readBody(request)) as Record<string, unknown> | undefined;
      if (
        body === undefined ||
        typeof body["title"] !== "string" ||
        !Array.isArray(body["recipients"])
      ) {
        return json(400, { message: "Invalid request body" });
      }
      nextDocId += 1;
      const d: FakeDocument = {
        id: nextDocId,
        externalId: typeof body["externalId"] === "string" ? body["externalId"] : null,
        title: body["title"],
        status: "DRAFT",
        recipients: newRecipients(body["recipients"] as Record<string, unknown>[]),
        fields: [],
        needsUpload: true,
        uploaded: false,
        completedAt: null,
        createdAt: now().toISOString(),
      };
      store(d);
      createdLog.push({ providerRef: String(d.id), input: body });
      return json(200, {
        uploadUrl: `${base()}/__s3/upload/${d.id}?X-Amz-Signature=fake`,
        documentId: d.id,
        externalId: d.externalId,
        recipients: d.recipients.map((r) => ({
          recipientId: r.id,
          name: r.name,
          email: r.email,
          token: r.token,
          role: r.role,
          signingOrder: r.signingOrder,
          signingUrl: `${base()}/sign/${r.token}`,
        })),
      });
    }
    const tpl = /^\/templates\/(\d+)(\/generate-document)?$/u.exec(route);
    if (tpl !== null) {
      if (Number(tpl[1]) !== FAKE_TEMPLATE_ID) return json(404, { message: "Template not found" });
      if (method === "GET" && tpl[2] === undefined) return json(200, template);
      if (method === "POST" && tpl[2] !== undefined) {
        const body = (await readBody(request)) as Record<string, unknown> | undefined;
        const list = Array.isArray(body?.["recipients"])
          ? (body["recipients"] as Record<string, unknown>[])
          : [];
        if (list.some((r) => !template.Recipient.some((t) => t.id === r["id"]))) {
          return json(400, { message: "Recipient not found in template" });
        }
        nextDocId += 1;
        const d: FakeDocument = {
          id: nextDocId,
          externalId: typeof body?.["externalId"] === "string" ? body["externalId"] : null,
          title: typeof body?.["title"] === "string" ? body["title"] : template.title,
          status: "DRAFT",
          recipients: newRecipients(
            list.map((r) => ({
              name: r["name"],
              email: r["email"],
              role: "SIGNER",
              signingOrder: r["signingOrder"],
            })),
          ),
          fields: [],
          needsUpload: false,
          uploaded: false,
          completedAt: null,
          createdAt: now().toISOString(),
        };
        store(d);
        createdLog.push({ providerRef: String(d.id), input: body });
        return json(200, {
          documentId: d.id,
          externalId: d.externalId,
          recipients: d.recipients.map((r) => ({
            recipientId: r.id,
            name: r.name,
            email: r.email,
            token: r.token,
            role: r.role,
            signingOrder: r.signingOrder,
            signingUrl: `${base()}/sign/${r.token}`,
          })),
        });
      }
      return json(405, { message: "Method not allowed" });
    }

    const doc = /^\/documents\/(\d+)(\/fields|\/send|\/download)?$/u.exec(route);
    if (doc === null) return json(404, { message: "Not found" });
    const d = documents.get(Number(doc[1]));
    if (d === undefined) return json(404, { message: "Document not found" });
    const sub = doc[2];

    if (sub === undefined && method === "GET") return json(200, docView(d));
    if (sub === undefined && method === "DELETE") {
      if (d.status === "COMPLETED" || d.status === "REJECTED") {
        return json(200, docView(d)); // soft delete in Documenso; the fake just keeps it
      }
      documents.delete(d.id); // hard delete of a draft/pending document
      return json(200, docView(d));
    }
    if (sub === "/fields" && method === "POST") {
      const body = await readBody(request);
      const list = Array.isArray(body) ? body : body === undefined ? [] : [body];
      for (const f of list as Record<string, unknown>[]) {
        if (!d.recipients.some((r) => r.id === f["recipientId"])) {
          return json(400, { message: "Invalid recipient ID" });
        }
        for (const k of ["pageX", "pageY", "pageWidth", "pageHeight"]) {
          const v = f[k];
          if (typeof v !== "number" || v < 0 || v > 100)
            return json(400, { message: `Invalid ${k}` });
        }
        nextFieldId += 1;
        d.fields.push({ id: nextFieldId, ...f });
      }
      return json(200, { fields: d.fields, documentId: d.id });
    }
    if (sub === "/send" && method === "POST") {
      if (d.status === "COMPLETED") return json(400, { message: "Document is already complete" });
      if (d.needsUpload && !d.uploaded) return json(500, { message: "Document data missing" });
      d.status = "PENDING";
      for (const r of d.recipients) r.sendStatus = "SENT";
      return json(200, { message: "Document sent for signing successfully", ...docView(d) });
    }
    if (sub === "/download" && method === "GET") {
      if (d.status !== "COMPLETED") return json(400, { message: "Document is not completed yet." });
      return json(200, { downloadUrl: `${base()}/__s3/download/${d.id}?X-Amz-Signature=fake` });
    }
    return json(405, { message: "Method not allowed" });
  }

  const webhook = (
    ref: string,
    event: string,
    secret: string,
  ): { headers: Headers; body: Uint8Array } => {
    const d = snapshots.get(Number(ref));
    const payload =
      d === undefined
        ? { id: Number(ref) }
        : {
            id: d.id,
            externalId: d.externalId,
            title: d.title,
            status: d.status,
            recipients: d.recipients.map((r) => recipientView(r, d.id)),
          };
    const body = new TextEncoder().encode(
      JSON.stringify({
        event,
        payload,
        createdAt: now().toISOString(),
        webhookEndpoint: "https://fundroom.test/hook",
      }),
    );
    return {
      headers: new Headers({ "content-type": "application/json", "x-documenso-secret": secret }),
      body,
    };
  };

  const vendor: FakeDocumensoControl = {
    apiToken,
    get callbackSecret() {
      return callbackSecret;
    },
    setCallbackSecret(secret) {
      callbackSecret = secret;
    },
    requests,
    complete(ref) {
      const d = find(ref);
      d.status = "COMPLETED";
      d.completedAt = now().toISOString();
      for (const r of d.recipients) {
        r.readStatus = "OPENED";
        r.signingStatus = "SIGNED";
        r.signedAt = d.completedAt;
      }
    },
    decline(ref) {
      const d = find(ref);
      d.status = "REJECTED";
      const first = d.recipients[0];
      if (first !== undefined) {
        first.readStatus = "OPENED";
        first.signingStatus = "REJECTED";
      }
    },
    voidFromVendor(ref) {
      // Cancelling a pending document in Documenso v1 deletes it.
      find(ref);
      documents.delete(Number(ref));
    },
    callback(ref, event) {
      const d = documents.get(Number(ref));
      if (event === "viewed" && d !== undefined) {
        for (const r of d.recipients) r.readStatus = "OPENED";
      }
      const name =
        event === "completed"
          ? "DOCUMENT_COMPLETED"
          : event === "declined"
            ? "DOCUMENT_REJECTED"
            : "DOCUMENT_OPENED";
      return webhook(ref, name, callbackSecret);
    },
    forgedCallback(ref) {
      return webhook(ref, "DOCUMENT_COMPLETED", `${callbackSecret}-forged`);
    },
    created: () => createdLog.slice(),
    failNext(status, times = 1) {
      failures = { status, remaining: times };
    },
    setArtifact(bytes, opts) {
      artifact = bytes === undefined ? undefined : { bytes, chunked: opts?.chunked === true };
    },
    fieldsOf(ref) {
      return (snapshots.get(Number(ref))?.fields ?? []).slice();
    },
    documentStatus(ref) {
      return documents.get(Number(ref))?.status;
    },
  };

  return { handle, vendor };
}

/** A `fetch` that answers from the fake (for unit tests that want no sockets). */
export function fakeFetch(handle: (request: Request) => Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    return handle(request);
  }) as typeof fetch;
}
