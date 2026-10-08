import { createHmac, randomBytes } from "node:crypto";

/**
 * A scripted fake of the slice of the Parallel Markets Server API v2 this adapter calls. Pure
 * request → response (`handle(request)`), so it backs both a fake `fetch` for unit tests and the
 * real node:http server in `fake-server.ts`. Behaviour mirrors the vendor where it matters to us:
 * `Authorization: Bearer <key>`, `{data, pagination:{next_cursor}}` lists, certification letters
 * behind short-lived download URLs on a different path that must NOT carry the API key, and
 * `Parallel-Timestamp` / `Parallel-Signature` callbacks (base64 HMAC-SHA256 with the base64-decoded
 * key over timestamp + body).
 */

export interface FakeParallelMarketsOptions {
  /** Origin the fake answers as (used in download URLs). Can be a getter for servers. */
  readonly baseUrl: string | (() => string);
  readonly apiKey?: string;
  /** Base64 webhook signing key. */
  readonly webhookSigningKey?: string;
  /** Page size of accreditation lists (to exercise cursors). Default 50. */
  readonly pageSize?: number;
  /** Answer 409 when an individual record with the same email already exists. */
  readonly conflictOnDuplicateEmail?: boolean;
  readonly now?: () => Date;
}

export interface FakeRequestLogEntry {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

interface FakeAccreditation {
  id: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  certifiedAt: string | null;
  rejectedAt: string | null;
  canceledAt: string | null;
  assertionType: string | null;
  rejectionReason: string | null;
}

interface FakeRecord {
  id: string;
  type: "individual" | "business";
  createdAt: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  indicatedUnaccreditedAt: string | null;
  accreditations: FakeAccreditation[];
}

export interface FakeParallelMarketsControl {
  readonly apiKey: string;
  readonly webhookSigningKey: string;
  readonly requests: FakeRequestLogEntry[];
  accredit(
    providerRef: string,
    options?: { readonly expiresAt?: Date; readonly assertion?: string },
  ): void;
  reject(providerRef: string): void;
  cancel(providerRef: string): void;
  unknownStatus(providerRef: string, raw: string): void;
  /** Add an accreditation attempt in this raw status (returns its id). */
  addAttempt(
    providerRef: string,
    status: string,
    options?: { readonly createdAt?: Date; readonly expiresAt?: Date; readonly certifiedAt?: Date },
  ): string;
  indicateUnaccredited(providerRef: string): void;
  failNext(kind: "rate_limited" | "unavailable" | number, times?: number): void;
  /** Replace the letter served (undefined = default PDF). */
  setLetter(bytes: Uint8Array | undefined): void;
  /** Download tokens stop working immediately (simulates a URL used after ~30 s). */
  expireDownloads(): void;
  callback(refs: readonly string[]): { headers: Headers; rawBody: Uint8Array };
  forgedCallback(refs: readonly string[]): { headers: Headers; rawBody: Uint8Array };
  /** A callback signed at an explicit unix time (seconds). */
  callbackAt(
    refs: readonly string[],
    unixSeconds: number,
  ): { headers: Headers; rawBody: Uint8Array };
  records(): readonly { id: string; type: string; email: string | null; name: string | null }[];
}

/** A minimal, structurally valid one-page PDF. */
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

const DOWNLOAD_TTL_MS = 30_000;

export function createFakeParallelMarkets(options: FakeParallelMarketsOptions): {
  handle(request: Request): Promise<Response>;
  vendor: FakeParallelMarketsControl;
} {
  const apiKey = options.apiKey ?? "pm_fake_api_key_0123456789abcdef";
  const signingKey =
    options.webhookSigningKey ??
    Buffer.from("fake-parallel-webhook-signing-key!").toString("base64");
  const now = options.now ?? (() => new Date());
  const pageSize = options.pageSize ?? 50;
  const base = (): string =>
    (typeof options.baseUrl === "function" ? options.baseUrl() : options.baseUrl).replace(
      /\/+$/u,
      "",
    );

  const records = new Map<string, FakeRecord>();
  const downloads = new Map<string, { recordId: string; expires: number }>();
  const requests: FakeRequestLogEntry[] = [];
  let nextRecord = 1;
  let nextAccreditation = 1;
  let failures = { status: 500, remaining: 0 };
  let letter: Uint8Array | undefined;

  const recordOf = (ref: string): FakeRecord => {
    const r = records.get(ref);
    if (r === undefined) throw new Error(`fake Parallel: no record ${ref}`);
    return r;
  };

  const newAttempt = (r: FakeRecord, status: string, createdAt = now()): FakeAccreditation => {
    const a: FakeAccreditation = {
      id: Buffer.from(`Accreditation:${nextAccreditation++}`).toString("base64"),
      status,
      createdAt: createdAt.toISOString(),
      expiresAt: null,
      certifiedAt: null,
      rejectedAt: null,
      canceledAt: null,
      assertionType: null,
      rejectionReason: null,
    };
    r.accreditations.push(a);
    return a;
  };

  /** The attempt the investor is working on: the newest one not yet decided, or a new one. */
  const openAttempt = (ref: string): FakeAccreditation => {
    const r = recordOf(ref);
    const open = [...r.accreditations]
      .reverse()
      .find((a) =>
        ["unsubmitted", "pending", "submitter_pending", "third_party_pending"].includes(a.status),
      );
    return open ?? newAttempt(r, "unsubmitted");
  };

  const accreditationView = (r: FakeRecord, a: FakeAccreditation) => {
    const documents: unknown[] = [];
    if (a.status === "current") {
      const token = randomBytes(12).toString("hex");
      downloads.set(token, { recordId: r.id, expires: now().getTime() + DOWNLOAD_TTL_MS });
      documents.push({
        download_url: `${base()}/secure-files/${token}`,
        download_url_expires: 30,
        type: "certification-letter",
      });
    }
    return {
      id: a.id,
      status: a.status,
      expires_at: a.expiresAt,
      assertion_type: a.assertionType,
      rejection_reason: a.rejectionReason,
      created_at: a.createdAt,
      started_at: a.createdAt,
      submitted_at: a.status === "unsubmitted" ? null : a.createdAt,
      certified_at: a.certifiedAt,
      rejected_at: a.rejectedAt,
      canceled_at: a.canceledAt,
      ...(r.type === "business"
        ? { name: r.name }
        : { first_name: r.firstName, last_name: r.lastName }),
      documents,
      reviewer_note: null,
    };
  };

  const recordView = (r: FakeRecord) => ({
    id: r.id,
    created_at: r.createdAt,
    external_id: null,
    ref_code: null,
    type: r.type,
    details:
      r.type === "business"
        ? { name: r.name, indicated_unaccredited_at: r.indicatedUnaccreditedAt }
        : {
            email: r.email,
            first_name: r.firstName,
            last_name: r.lastName,
            indicated_unaccredited_at: r.indicatedUnaccreditedAt,
          },
    traits: [],
    identity_link_established_at: null,
    archived_at: null,
  });

  const handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const text = method === "GET" ? "" : await request.text();
    let body: unknown;
    try {
      body = text.length > 0 ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    requests.push({
      method,
      url: request.url,
      authorization: request.headers.get("authorization"),
      body,
    });
    const path = url.pathname.replace(/\/+$/u, "");

    // Download URLs: token in the path, no API key (a storage host in real life).
    const dl = /^\/secure-files\/([0-9a-f]+)$/u.exec(path);
    if (method === "GET" && dl !== null) {
      const entry = downloads.get(dl[1] as string);
      if (entry === undefined || entry.expires < now().getTime()) {
        return new Response("<Error>AccessDenied</Error>", { status: 403 });
      }
      const bytes = letter ?? fakePdf(`Parallel certification letter ${entry.recordId}`);
      return new Response(bytes, { status: 200, headers: { "content-type": "application/pdf" } });
    }

    if (!path.startsWith("/v2/")) return json(404, { error: "Not found" });
    if (request.headers.get("authorization") !== `Bearer ${apiKey}`) {
      return json(401, { error: "Invalid authentication token provided." });
    }
    if (failures.remaining > 0) {
      failures.remaining -= 1;
      return json(failures.status, { error: `Simulated failure ${failures.status}` });
    }
    const rest = path.slice("/v2".length);

    if (method === "GET" && rest === "/partner-records/file-types") {
      return json(200, { data: [{ id: "tax-return", name: "Tax return" }] });
    }
    if (method === "POST" && rest === "/partner-records/individuals") {
      const b = (body ?? {}) as Record<string, unknown>;
      const email = typeof b["email"] === "string" ? b["email"] : null;
      if (
        options.conflictOnDuplicateEmail === true &&
        email !== null &&
        [...records.values()].some((r) => r.email?.toLowerCase() === email.toLowerCase())
      ) {
        return json(409, { error: "A record with this email already exists." });
      }
      const r: FakeRecord = {
        id: Buffer.from(`PodUserRecord:${nextRecord++}`).toString("base64"),
        type: "individual",
        createdAt: now().toISOString(),
        email,
        firstName: typeof b["first_name"] === "string" ? b["first_name"] : null,
        lastName: typeof b["last_name"] === "string" ? b["last_name"] : null,
        name: null,
        indicatedUnaccreditedAt: null,
        accreditations: [],
      };
      records.set(r.id, r);
      return json(201, { data: recordView(r) });
    }
    if (method === "GET" && rest === "/partner-records/individuals") {
      const q = (url.searchParams.get("email") ?? "").toLowerCase();
      const data = [...records.values()]
        .filter((r) => r.type === "individual" && (r.email ?? "").toLowerCase().includes(q))
        .map(recordView);
      return json(200, { data, pagination: { next_cursor: null } });
    }
    if (method === "POST" && rest === "/partner-records/businesses") {
      const b = (body ?? {}) as Record<string, unknown>;
      const r: FakeRecord = {
        id: Buffer.from(`PodBusinessRecord:${nextRecord++}`).toString("base64"),
        type: "business",
        createdAt: now().toISOString(),
        email: null,
        firstName: null,
        lastName: null,
        name: typeof b["name"] === "string" ? b["name"] : null,
        indicatedUnaccreditedAt: null,
        accreditations: [],
      };
      records.set(r.id, r);
      return json(201, { data: recordView(r) });
    }
    let m = /^\/partner-records\/([^/]+)\/accreditations$/u.exec(rest);
    if (method === "GET" && m !== null) {
      const r = records.get(decodeURIComponent(m[1] as string));
      if (r === undefined) return json(404, { error: "The specified object could not be found." });
      const offset = Number(url.searchParams.get("cursor") ?? "0") || 0;
      const page = r.accreditations.slice(offset, offset + pageSize);
      const next = offset + pageSize < r.accreditations.length ? String(offset + pageSize) : null;
      return json(200, {
        data: page.map((a) => accreditationView(r, a)),
        pagination: { next_cursor: next },
      });
    }
    m = /^\/partner-records\/([^/]+)$/u.exec(rest);
    if (method === "GET" && m !== null) {
      const r = records.get(decodeURIComponent(m[1] as string));
      if (r === undefined) return json(404, { error: "The specified object could not be found." });
      return json(200, recordView(r));
    }
    return json(404, { error: "The specified object could not be found." });
  };

  const sign = (timestamp: string, rawBody: Uint8Array, keyB64: string): string =>
    createHmac("sha256", Buffer.from(keyB64, "base64"))
      .update(Buffer.concat([Buffer.from(timestamp), rawBody]))
      .digest("base64");

  const webhook = (refs: readonly string[], keyB64: string, unixSeconds: number) => {
    const id = refs[0] ?? "";
    const r = records.get(id);
    const rawBody = new TextEncoder().encode(
      JSON.stringify({
        entity: { id, type: r?.type ?? "individual" },
        event: "data_update",
        scope: "accreditation_status",
      }),
    );
    const timestamp = String(unixSeconds);
    return {
      headers: new Headers({
        "content-type": "application/json",
        "parallel-timestamp": timestamp,
        "parallel-signature": sign(timestamp, rawBody, keyB64),
      }),
      rawBody,
    };
  };
  const unixNow = (): number => Math.floor(now().getTime() / 1000);
  const forgedKey = Buffer.from("not-the-real-signing-key-at-all!!").toString("base64");

  const vendor: FakeParallelMarketsControl = {
    apiKey,
    webhookSigningKey: signingKey,
    requests,
    accredit(ref, opts) {
      const a = openAttempt(ref);
      a.status = "current";
      a.certifiedAt = now().toISOString();
      a.expiresAt = (
        opts?.expiresAt ?? new Date(now().getTime() + 90 * 24 * 3600 * 1000)
      ).toISOString();
      a.assertionType = opts?.assertion ?? (recordOf(ref).type === "business" ? "worth" : "income");
    },
    reject(ref) {
      const a = openAttempt(ref);
      a.status = "rejected";
      a.rejectedAt = now().toISOString();
      a.assertionType = "income";
      a.rejectionReason = "income-invalid";
    },
    cancel(ref) {
      const a = openAttempt(ref);
      a.status = "canceled";
      a.canceledAt = now().toISOString();
    },
    unknownStatus(ref, raw) {
      openAttempt(ref).status = raw;
    },
    addAttempt(ref, status, opts) {
      const a = newAttempt(recordOf(ref), status, opts?.createdAt);
      if (opts?.expiresAt !== undefined) a.expiresAt = opts.expiresAt.toISOString();
      if (status === "current")
        a.certifiedAt = (opts?.certifiedAt ?? new Date(a.createdAt)).toISOString();
      return a.id;
    },
    indicateUnaccredited(ref) {
      recordOf(ref).indicatedUnaccreditedAt = now().toISOString();
    },
    failNext(kind, times = 1) {
      const status = kind === "rate_limited" ? 429 : kind === "unavailable" ? 500 : kind;
      failures = { status, remaining: times };
    },
    setLetter(bytes) {
      letter = bytes;
    },
    expireDownloads() {
      for (const d of downloads.values()) d.expires = 0;
    },
    callback: (refs) => webhook(refs, signingKey, unixNow()),
    forgedCallback: (refs) => webhook(refs, forgedKey, unixNow()),
    callbackAt: (refs, unixSeconds) => webhook(refs, signingKey, unixSeconds),
    records: () =>
      [...records.values()].map((r) => ({ id: r.id, type: r.type, email: r.email, name: r.name })),
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
