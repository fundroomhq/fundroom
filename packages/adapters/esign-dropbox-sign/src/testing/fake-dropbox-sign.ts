import { createHmac, randomBytes } from "node:crypto";

/**
 * A scripted Dropbox Sign for unit tests: a `fetch` answering the v3 endpoints the adapter uses,
 * with in-memory signature requests and callback minting (multipart `json` field + event_hash).
 * Structurally implements `FakeVendorControl` from `@fundroom/esign/testing` (not imported, so the
 * adapter build does not depend on the kernel package).
 */

export const FAKE = {
  apiKey: "fake-dropbox-sign-api-key-0123456789abcdef",
  templateId: "c26b8a16784a872da37ea946b9ddec7c1e11dff6",
  templateRole: "Signer",
} as const;

const PDF = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
);

interface Signature {
  signature_id: string;
  signer_email_address: string;
  signer_name: string;
  signer_role: string | null;
  order: number | null;
  status_code: string;
  signed_at: number | null;
  last_viewed_at: number | null;
}

interface SignatureRequest {
  signature_request_id: string;
  title: string;
  is_complete: boolean;
  is_declined: boolean;
  has_error: boolean;
  test_mode: boolean;
  expires_at: number | null;
  metadata: Record<string, string>;
  signatures: Signature[];
  cancelled: boolean;
}

export interface FakeDropboxSignOptions {
  readonly documentBytes?: number;
  /** Answer 409 ("files being prepared") this many times before serving files. */
  readonly filesPreparing?: number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function error(status: number, name: string): Response {
  return json(status, {
    error: { error_msg: `leaky message with ${FAKE.apiKey}`, error_name: name },
  });
}

export function eventHash(apiKey: string, eventTime: string, eventType: string): string {
  return createHmac("sha256", apiKey).update(`${eventTime}${eventType}`).digest("hex");
}

export interface MintedRequest {
  headers: Headers;
  body: Uint8Array;
}

export interface FakeDropboxSign {
  readonly fetch: typeof fetch;
  readonly calls: { method: string; url: string; headers: Headers; body?: RequestInit["body"] }[];
  readonly failNext: (status: number, count?: number) => void;
  readonly vendor: {
    complete(ref: string): void;
    decline(ref: string): void;
    voidFromVendor(ref: string): void;
    view(ref: string): void;
    expire(ref: string): void;
    callback(ref: string, event: "completed" | "declined" | "viewed"): MintedRequest;
    forgedCallback(ref: string): MintedRequest;
    callbackAt(ref: string, eventTime: string): MintedRequest;
    created(): readonly { providerRef: string; input: unknown }[];
  };
}

export function multipartBody(
  fields: Record<string, string>,
  boundary = `----fundroom${randomBytes(8).toString("hex")}`,
): MintedRequest {
  let text = "";
  for (const [name, value] of Object.entries(fields)) {
    text += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  text += `--${boundary}--\r\n`;
  return {
    headers: new Headers({ "content-type": `multipart/form-data; boundary=${boundary}` }),
    body: new TextEncoder().encode(text),
  };
}

export function createFakeDropboxSign(options: FakeDropboxSignOptions = {}): FakeDropboxSign {
  const requests = new Map<string, SignatureRequest>();
  const created: { providerRef: string; input: unknown }[] = [];
  const calls: FakeDropboxSign["calls"] = [];
  const failures: number[] = [];
  let preparing = options.filesPreparing ?? 0;
  const nowS = () => Math.floor(Date.now() / 1000);

  function mustGet(id: string): SignatureRequest {
    const r = requests.get(id);
    if (!r) throw new Error(`fake dropbox sign: unknown request ${id}`);
    return r;
  }

  function view(r: SignatureRequest): Record<string, unknown> {
    const { cancelled: _c, ...rest } = r;
    return rest;
  }

  const fakeFetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url: url.href,
      headers,
      ...(init?.body !== undefined ? { body: init.body } : {}),
    });
    if (url.origin !== "https://api.hellosign.com" || !url.pathname.startsWith("/v3/"))
      return error(404, "not_found");
    const expected = `Basic ${Buffer.from(`${FAKE.apiKey}:`).toString("base64")}`;
    if (headers.get("authorization") !== expected) return error(401, "unauthorized");
    const failure = failures.shift();
    if (failure !== undefined) return error(failure, "injected_failure");
    const path = url.pathname.slice(3);

    if (method === "GET" && path === "/account") {
      return json(200, { account: { account_id: "acc123", email_address: "founder@example.com" } });
    }

    if (
      method === "POST" &&
      (path === "/signature_request/send" || path === "/signature_request/send_with_template")
    ) {
      const id = randomBytes(20).toString("hex");
      let received: Record<string, unknown>;
      let signatures: Signature[];
      let metadata: Record<string, string>;
      let testMode: boolean;
      let title: string;
      if (path === "/signature_request/send") {
        const form = init?.body;
        if (!(form instanceof FormData)) return error(400, "bad_request");
        const file = form.get("files[0]");
        if (!(file instanceof Blob)) return error(400, "bad_request");
        received = {};
        for (const [k, v] of form.entries()) if (typeof v === "string") received[k] = v;
        received["files[0]"] = { size: file.size, type: file.type };
        metadata = {};
        signatures = [];
        for (const [k, v] of Object.entries(received)) {
          const mm = /^metadata\[(.+)\]$/.exec(k);
          if (mm?.[1] && typeof v === "string") metadata[mm[1]] = v;
        }
        for (let i = 0; received[`signers[${i}][email_address]`]; i++) {
          const order = received[`signers[${i}][order]`];
          signatures.push({
            signature_id: randomBytes(16).toString("hex"),
            signer_email_address: String(received[`signers[${i}][email_address]`]),
            signer_name: String(received[`signers[${i}][name]`]),
            signer_role: null,
            order: typeof order === "string" ? Number(order) : null,
            status_code: "awaiting_signature",
            signed_at: null,
            last_viewed_at: null,
          });
        }
        try {
          JSON.parse(String(received["form_fields_per_document"] ?? "[]"));
        } catch {
          return error(400, "bad_request");
        }
        testMode = received["test_mode"] === "1";
        title = String(received["title"] ?? "");
      } else {
        received = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if (
          !Array.isArray(received["template_ids"]) ||
          received["template_ids"][0] !== FAKE.templateId
        ) {
          return error(400, "bad_request");
        }
        const signers = (received["signers"] ?? []) as {
          role: string;
          name: string;
          email_address: string;
        }[];
        if (signers.some((s) => s.role !== FAKE.templateRole)) return error(400, "bad_request");
        signatures = signers.map((s) => ({
          signature_id: randomBytes(16).toString("hex"),
          signer_email_address: s.email_address,
          signer_name: s.name,
          signer_role: s.role,
          order: null,
          status_code: "awaiting_signature",
          signed_at: null,
          last_viewed_at: null,
        }));
        metadata = (received["metadata"] ?? {}) as Record<string, string>;
        testMode = received["test_mode"] === true;
        title = String(received["title"] ?? "");
      }
      const req: SignatureRequest = {
        signature_request_id: id,
        title,
        is_complete: false,
        is_declined: false,
        has_error: false,
        test_mode: testMode,
        expires_at: null,
        metadata,
        signatures,
        cancelled: false,
      };
      requests.set(id, req);
      created.push({ providerRef: id, input: received });
      return json(200, { signature_request: view(req) });
    }

    const get = /^\/signature_request\/([A-Za-z0-9]+)$/.exec(path);
    if (method === "GET" && get) {
      const r = requests.get(get[1] ?? "");
      if (!r) return error(404, "not_found");
      if (r.cancelled) return error(410, "deleted");
      return json(200, { signature_request: view(r) });
    }
    const files = /^\/signature_request\/files\/([A-Za-z0-9]+)$/.exec(path);
    if (method === "GET" && files) {
      const r = requests.get(files[1] ?? "");
      if (!r) return error(404, "not_found");
      if (url.searchParams.get("file_type") !== "pdf") return error(400, "bad_request");
      if (preparing > 0) {
        preparing--;
        return error(409, "conflict");
      }
      const bytes = new Uint8Array(
        Math.max(options.documentBytes ?? PDF.byteLength, PDF.byteLength),
      );
      bytes.set(PDF);
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": String(bytes.byteLength) },
      });
    }
    const cancel = /^\/signature_request\/cancel\/([A-Za-z0-9]+)$/.exec(path);
    if (method === "POST" && cancel) {
      const r = requests.get(cancel[1] ?? "");
      if (!r) return error(404, "not_found");
      if (r.cancelled) return error(410, "deleted");
      if (r.is_complete) return error(400, "bad_request");
      r.cancelled = true;
      return new Response(null, { status: 200 });
    }
    return error(404, "not_found");
  };

  function callbackFor(
    ref: string,
    eventType: string,
    key: string,
    eventTime = String(nowS()),
  ): MintedRequest {
    const r = mustGet(ref);
    const payload = {
      event: {
        event_time: eventTime,
        event_type: eventType,
        event_hash: eventHash(key, eventTime, eventType),
        event_metadata: {
          related_signature_id: r.signatures[0]?.signature_id ?? null,
          reported_for_account_id: "acc123",
        },
      },
      signature_request: view(r),
    };
    return multipartBody({ json: JSON.stringify(payload) });
  }

  const vendor: FakeDropboxSign["vendor"] = {
    complete(ref: string) {
      const r = mustGet(ref);
      r.is_complete = true;
      for (const s of r.signatures) {
        s.status_code = "signed";
        s.signed_at = nowS();
      }
    },
    decline(ref: string) {
      const r = mustGet(ref);
      r.is_declined = true;
      const first = r.signatures[0];
      if (first) first.status_code = "declined";
    },
    voidFromVendor(ref: string) {
      mustGet(ref).cancelled = true;
    },
    view(ref: string) {
      for (const s of mustGet(ref).signatures) s.last_viewed_at = nowS();
    },
    expire(ref: string) {
      mustGet(ref).expires_at = nowS() - 60;
    },
    callback(ref: string, event: "completed" | "declined" | "viewed") {
      const type =
        event === "completed"
          ? "signature_request_all_signed"
          : event === "declined"
            ? "signature_request_declined"
            : "signature_request_viewed";
      return callbackFor(ref, type, FAKE.apiKey);
    },
    forgedCallback(ref: string) {
      return callbackFor(ref, "signature_request_all_signed", "not-the-api-key");
    },
    callbackAt(ref: string, eventTime: string) {
      return callbackFor(ref, "signature_request_all_signed", FAKE.apiKey, eventTime);
    },
    created: () => created,
  };

  return {
    fetch: fakeFetch as typeof fetch,
    calls,
    vendor,
    failNext: (status: number, count = 1) => {
      for (let i = 0; i < count; i++) failures.push(status);
    },
  };
}
