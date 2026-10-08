/**
 * A scripted fake of the slice of the DocuSeal API this adapter calls (unit tests only). Mirrors
 * DocuSeal where it matters: `X-Auth-Token`, `/submissions` returning an array of submitters,
 * `/submissions/pdf` returning a submission (absent on the open-source edition → 404), document
 * URLs on the vendor host that must NOT receive the API key, archive-on-DELETE, and webhooks with
 * the admin-configured secret header.
 */

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

export interface FakeDocusealControl extends FakeVendorControl {
  readonly apiToken: string;
  readonly callbackSecret: string;
  readonly requests: { method: string; url: string; token: string | null }[];
  failNext(status: number, times?: number): void;
  setArtifact(bytes: Uint8Array | undefined, options?: { readonly chunked?: boolean }): void;
  /** Raw submission as the fake stores it. */
  submission(providerRef: string): Record<string, unknown> | undefined;
}

export const FAKE_TEMPLATE_ID = 202;
export const FAKE_TEMPLATE_ROLE = "Investor";

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

interface FakeSubmitter {
  id: number;
  submission_id: number;
  uuid: string;
  slug: string;
  email: string;
  name: string;
  role: string;
  external_id: string | null;
  metadata: Record<string, unknown>;
  status: "awaiting" | "sent" | "opened" | "completed" | "declined";
  order: number;
  values: Record<string, unknown>;
  sent_at: string | null;
  opened_at: string | null;
  completed_at: string | null;
  declined_at: string | null;
  completed_redirect_url: string | null;
}

interface FakeSubmission {
  id: number;
  name: string;
  status: "pending" | "completed" | "declined" | "expired";
  archived_at: string | null;
  completed_at: string | null;
  expire_at: string | null;
  submitters: FakeSubmitter[];
  fields: unknown[];
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function createFakeDocuseal(options: {
  readonly baseUrl: string;
  readonly apiToken?: string;
  readonly callbackSecret?: string;
  readonly now?: () => Date;
  /** "ce": the open-source edition (no /submissions/pdf). Default "pro". */
  readonly edition?: "ce" | "pro";
  /** Omit `status` fields, like older self-hosted versions. */
  readonly legacyShapes?: boolean;
}): { handle(request: Request): Promise<Response>; vendor: FakeDocusealControl } {
  const apiToken = options.apiToken ?? "fake-docuseal-api-key";
  const callbackSecret = options.callbackSecret ?? "fake-docuseal-webhook-secret";
  const now = options.now ?? (() => new Date());
  const base = options.baseUrl.replace(/\/+$/u, "");
  const submissions = new Map<number, FakeSubmission>();
  const createdLog: { providerRef: string; input: unknown }[] = [];
  const requests: { method: string; url: string; token: string | null }[] = [];
  let nextSubmission = 70;
  let nextSubmitter = 300;
  let failures = { status: 500, remaining: 0 };
  let artifact: { bytes: Uint8Array; chunked: boolean } | undefined;

  const submitterView = (s: FakeSubmitter, withEmbed: boolean) => ({
    id: s.id,
    submission_id: s.submission_id,
    uuid: s.uuid,
    email: s.email,
    slug: s.slug,
    ...(options.legacyShapes === true ? {} : { status: s.status }),
    values: Object.entries(s.values).map(([field, value]) => ({ field, value })),
    metadata: s.metadata,
    sent_at: s.sent_at,
    opened_at: s.opened_at,
    completed_at: s.completed_at,
    declined_at: s.declined_at,
    created_at: now().toISOString(),
    updated_at: now().toISOString(),
    name: s.name,
    phone: null,
    external_id: s.external_id,
    preferences: {},
    role: s.role,
    ...(withEmbed ? { embed_src: `${base}/s/${s.slug}` } : {}),
    documents:
      s.status === "completed"
        ? [{ name: "signed", url: `${base}/file/signed/${s.submission_id}.pdf` }]
        : [],
  });

  const submissionView = (sub: FakeSubmission) => ({
    id: sub.id,
    name: sub.name,
    slug: `sub${sub.id}`,
    source: "api",
    submitters_order: "preserved",
    audit_log_url: sub.completed_at === null ? null : `${base}/file/audit/${sub.id}.pdf`,
    combined_document_url: null,
    created_at: now().toISOString(),
    updated_at: now().toISOString(),
    archived_at: sub.archived_at,
    expire_at: sub.expire_at,
    variables: {},
    ...(options.legacyShapes === true ? {} : { status: sub.status }),
    completed_at: sub.completed_at,
    submitters: sub.submitters.map((s) => submitterView(s, false)),
    documents:
      sub.completed_at === null
        ? []
        : [{ name: "signed", url: `${base}/file/signed/${sub.id}.pdf` }],
    submission_events: [],
  });

  const makeSubmission = (
    name: string,
    list: Record<string, unknown>[],
    fields: unknown[],
  ): FakeSubmission => {
    nextSubmission += 1;
    const id = nextSubmission;
    const sub: FakeSubmission = {
      id,
      name,
      status: "pending",
      archived_at: null,
      completed_at: null,
      expire_at: null,
      fields,
      submitters: list.map((s, i) => {
        nextSubmitter += 1;
        return {
          id: nextSubmitter,
          submission_id: id,
          uuid: `uuid-${nextSubmitter}`,
          slug: `slug${nextSubmitter}`,
          email: typeof s["email"] === "string" ? s["email"] : "",
          name: typeof s["name"] === "string" ? s["name"] : "",
          role: typeof s["role"] === "string" ? s["role"] : FAKE_TEMPLATE_ROLE,
          external_id: typeof s["external_id"] === "string" ? s["external_id"] : null,
          metadata: (s["metadata"] as Record<string, unknown> | undefined) ?? {},
          status: "sent",
          order: typeof s["order"] === "number" ? s["order"] : i,
          values: (s["values"] as Record<string, unknown> | undefined) ?? {},
          sent_at: now().toISOString(),
          opened_at: null,
          completed_at: null,
          declined_at: null,
          completed_redirect_url:
            typeof s["completed_redirect_url"] === "string" ? s["completed_redirect_url"] : null,
        };
      }),
    };
    submissions.set(id, sub);
    return sub;
  };

  const artifactResponse = (fallback: string): Response => {
    const bytes = artifact?.bytes ?? fakePdf(fallback);
    if (artifact?.chunked === true) {
      let offset = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(c) {
            if (offset >= bytes.byteLength) {
              c.close();
              return;
            }
            c.enqueue(bytes.slice(offset, offset + 1024));
            offset += 1024;
          },
        }),
        { status: 200 },
      );
    }
    return new Response(bytes, {
      status: 200,
      headers: { "content-length": String(bytes.byteLength) },
    });
  };

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const token = request.headers.get("x-auth-token");
    requests.push({ method: request.method, url: url.pathname + url.search, token });
    const path = url.pathname;

    const file = /^\/file\/(signed|audit)\/(\d+)\.pdf$/u.exec(path);
    if (file !== null) {
      if (token !== null || request.headers.get("authorization") !== null) {
        return new Response("credentials must not be sent here", { status: 400 });
      }
      const sub = submissions.get(Number(file[2]));
      if (sub === undefined || sub.completed_at === null)
        return new Response("gone", { status: 404 });
      return file[1] === "signed"
        ? artifactResponse(`Signed ${sub.name}`)
        : new Response(fakePdf(`Audit ${sub.id}`));
    }

    if (!path.startsWith("/api/")) return json(404, { error: "Not found" });
    if (token !== apiToken) return json(401, { error: "Not authenticated" });
    if (failures.remaining > 0) {
      failures = { ...failures, remaining: failures.remaining - 1 };
      return json(failures.status, { error: `injected ${failures.status}` });
    }
    const route = path.slice(4);
    const method = request.method;
    const readBody = async (): Promise<Record<string, unknown>> => {
      try {
        return JSON.parse(await request.text()) as Record<string, unknown>;
      } catch {
        return {};
      }
    };

    if (method === "GET" && route === "/templates") {
      return json(200, { data: [], pagination: { count: 0, next: null, prev: null } });
    }
    if (method === "POST" && route === "/submissions") {
      const body = await readBody();
      if (body["template_id"] !== FAKE_TEMPLATE_ID)
        return json(422, { error: "Template not found" });
      const list = Array.isArray(body["submitters"])
        ? (body["submitters"] as Record<string, unknown>[])
        : [];
      if (list.some((s) => s["role"] !== undefined && s["role"] !== FAKE_TEMPLATE_ROLE)) {
        return json(422, { error: "Unknown submitter role" });
      }
      const sub = makeSubmission("Subscription agreement", list, []);
      createdLog.push({ providerRef: String(sub.id), input: body });
      return json(
        200,
        sub.submitters.map((s) => submitterView(s, true)),
      );
    }
    if (method === "POST" && route === "/submissions/pdf") {
      if (options.edition === "ce") return json(404, { error: "Not found" });
      const body = await readBody();
      const docs = Array.isArray(body["documents"])
        ? (body["documents"] as Record<string, unknown>[])
        : [];
      const file =
        typeof docs[0]?.["file"] === "string"
          ? Buffer.from(docs[0]["file"], "base64")
          : Buffer.alloc(0);
      if (!file.subarray(0, 5).toString("latin1").startsWith("%PDF-"))
        return json(422, { error: "Invalid file" });
      const list = Array.isArray(body["submitters"])
        ? (body["submitters"] as Record<string, unknown>[])
        : [];
      const roles = new Set(list.map((s) => s["role"]));
      const fields = Array.isArray(docs[0]?.["fields"])
        ? (docs[0]["fields"] as Record<string, unknown>[])
        : [];
      for (const f of fields) {
        if (!roles.has(f["role"])) return json(422, { error: "Field role has no submitter" });
        const areas = Array.isArray(f["areas"]) ? (f["areas"] as Record<string, unknown>[]) : [];
        for (const a of areas) {
          for (const k of ["x", "y", "w", "h", "page"]) {
            if (typeof a[k] !== "number") return json(422, { error: `area.${k} missing` });
          }
        }
      }
      const sub = makeSubmission(
        typeof body["name"] === "string" ? body["name"] : "Document",
        list,
        fields,
      );
      createdLog.push({ providerRef: String(sub.id), input: body });
      return json(200, {
        ...submissionView(sub),
        submitters: sub.submitters.map((s) => submitterView(s, true)),
      });
    }
    const sm = /^\/submissions\/(\d+)(\/documents)?$/u.exec(route);
    if (sm !== null) {
      const sub = submissions.get(Number(sm[1]));
      if (sub === undefined) return json(404, { error: "Not found" });
      if (method === "GET" && sm[2] === undefined) return json(200, submissionView(sub));
      if (method === "GET" && sm[2] !== undefined) {
        return json(200, {
          id: sub.id,
          documents: [{ name: "signed", url: `${base}/file/signed/${sub.id}.pdf` }],
        });
      }
      if (method === "DELETE" && sm[2] === undefined) {
        sub.archived_at = now().toISOString();
        return json(200, { id: sub.id, archived_at: sub.archived_at });
      }
    }
    const pm = /^\/submitters\/(\d+)$/u.exec(route);
    if (pm !== null && method === "PUT") {
      const body = await readBody();
      for (const sub of submissions.values()) {
        const s = sub.submitters.find((x) => x.id === Number(pm[1]));
        if (s !== undefined) {
          if (typeof body["completed_redirect_url"] === "string")
            s.completed_redirect_url = body["completed_redirect_url"];
          return json(200, submitterView(s, true));
        }
      }
      return json(404, { error: "Not found" });
    }
    return json(404, { error: "Not found" });
  }

  const find = (ref: string): FakeSubmission => {
    const sub = submissions.get(Number(ref));
    if (sub === undefined) throw new Error(`fake docuseal: no submission ${ref}`);
    return sub;
  };

  const hook = (
    ref: string,
    event: string,
    secret: string,
  ): { headers: Headers; body: Uint8Array } => {
    const sub = submissions.get(Number(ref));
    const first = sub?.submitters[0];
    const data = event.startsWith("form.")
      ? {
          ...(first === undefined ? {} : submitterView(first, false)),
          submission: { id: Number(ref), status: sub?.status ?? "pending" },
        }
      : sub === undefined
        ? { id: Number(ref) }
        : submissionView(sub);
    return {
      headers: new Headers({ "content-type": "application/json", "x-fundroom-signature": secret }),
      body: new TextEncoder().encode(
        JSON.stringify({ event_type: event, timestamp: now().toISOString(), data }),
      ),
    };
  };

  const vendor: FakeDocusealControl = {
    apiToken,
    callbackSecret,
    requests,
    complete(ref) {
      const sub = find(ref);
      const at = now().toISOString();
      sub.status = "completed";
      sub.completed_at = at;
      for (const s of sub.submitters) {
        s.status = "completed";
        s.opened_at = s.opened_at ?? at;
        s.completed_at = at;
      }
    },
    decline(ref) {
      const sub = find(ref);
      sub.status = "declined";
      const first = sub.submitters[0];
      if (first !== undefined) {
        first.status = "declined";
        first.declined_at = now().toISOString();
      }
    },
    voidFromVendor(ref) {
      find(ref).archived_at = now().toISOString();
    },
    callback(ref, event) {
      const sub = submissions.get(Number(ref));
      if (event === "viewed" && sub !== undefined) {
        for (const s of sub.submitters) {
          if (s.status === "sent") {
            s.status = "opened";
            s.opened_at = now().toISOString();
          }
        }
      }
      return hook(
        ref,
        event === "completed"
          ? "submission.completed"
          : event === "declined"
            ? "form.declined"
            : "form.viewed",
        callbackSecret,
      );
    },
    forgedCallback(ref) {
      return hook(ref, "submission.completed", `${callbackSecret}!`);
    },
    created: () => createdLog.slice(),
    failNext(status, times = 1) {
      failures = { status, remaining: times };
    },
    setArtifact(bytes, opts) {
      artifact = bytes === undefined ? undefined : { bytes, chunked: opts?.chunked === true };
    },
    submission(ref) {
      const sub = submissions.get(Number(ref));
      return sub === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(sub)) as Record<string, unknown>);
    },
  };

  return { handle, vendor };
}

export function fakeFetch(handle: (request: Request) => Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) =>
    handle(input instanceof Request ? input : new Request(input, init))) as typeof fetch;
}
