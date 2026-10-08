import { createHmac } from "node:crypto";

/**
 * A scripted fake of the slice of the VerifyInvestor.com API v1 this adapter calls. Pure request →
 * response (`handle(request)`), so it backs both a fake `fetch` for unit tests and the real
 * node:http server in `fake-server.ts`. Behaviour mirrors the vendor where it matters to us:
 * `Authorization: Token <token>`, invitations whose `verification_request_id` stays null until the
 * investor has an account (immediately set for `existingInvestors`), verification requests with
 * `verified_expires_at` as a calendar date, a PDF certificate per request, and
 * `X-Signature-SHA256` callbacks (hex HMAC of the raw body — the encoding is configurable because
 * the vendor does not document it).
 */

export interface FakeVerifyInvestorOptions {
  readonly apiToken?: string;
  readonly webhookSecret?: string;
  /** How callbacks encode the signature. Default "hex". */
  readonly signatureEncoding?: "hex" | "base64";
  /** Emails that already have a VerifyInvestor account (a request is created at invitation). */
  readonly existingInvestors?: readonly string[];
  /** The billing endpoint answers 404 (older accounts); verify falls back to the API root. */
  readonly billingDisabled?: boolean;
  readonly now?: () => Date;
}

export interface FakeRequestLogEntry {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
}

interface FakeRequest {
  id: number;
  investorId: number;
  status: string;
  createdAt: string;
  completedAt: string | null;
  verifiedExpiresAt: string | null;
  legalName: string | null;
  portalName: string | null;
  waitingForInfo: boolean;
}

interface FakeInvitation {
  id: number;
  email: string;
  suggestedLegalName: string | null;
  portalName: string | null;
  createdAt: string;
  requestId: number | null;
}

export interface FakeVerifyInvestorControl {
  readonly apiToken: string;
  readonly webhookSecret: string;
  readonly requests: FakeRequestLogEntry[];
  /** The investor signs up and a verification request appears for an `inv:` ref. Returns `vr:<id>`. */
  signUp(providerRef: string): string;
  accredit(providerRef: string, options?: { readonly expiresAt?: Date }): void;
  reject(providerRef: string): void;
  cancel(providerRef: string): void;
  unknownStatus(providerRef: string, raw: string): void;
  setStatus(
    providerRef: string,
    status: string,
    options?: { readonly waitingForInfo?: boolean },
  ): void;
  /** The next `times` API calls answer this HTTP status. */
  failNext(kind: "rate_limited" | "unavailable" | number, times?: number): void;
  /** Replace the certificate served (undefined = default PDF, null = 404). */
  setCertificate(bytes: Uint8Array | null | undefined): void;
  callback(refs: readonly string[]): { headers: Headers; rawBody: Uint8Array };
  forgedCallback(refs: readonly string[]): { headers: Headers; rawBody: Uint8Array };
  /**
   * The invitation lapses unanswered: `"gone"` — the vendor stops returning it (404; its list only
   * holds active invitations); `"aged"` — it is still returned but is older than 30 days.
   */
  expireInvitation(providerRef: string, how: "gone" | "aged"): void;
  /** The invitation bodies the fake received. */
  invitations(): readonly Record<string, unknown>[];
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

const dateOnly = (d: Date): string => d.toISOString().slice(0, 10);

export function createFakeVerifyInvestor(options: FakeVerifyInvestorOptions = {}): {
  handle(request: Request): Promise<Response>;
  vendor: FakeVerifyInvestorControl;
} {
  const apiToken = options.apiToken ?? "vi_fake_api_token_0123456789";
  const webhookSecret = options.webhookSecret ?? "vi-fake-webhook-secret";
  const now = options.now ?? (() => new Date());
  const existing = new Set((options.existingInvestors ?? []).map((e) => e.toLowerCase()));

  const invitations = new Map<number, FakeInvitation>();
  const vrs = new Map<number, FakeRequest>();
  const investorIds = new Map<string, number>();
  const invitationBodies: Record<string, unknown>[] = [];
  const requests: FakeRequestLogEntry[] = [];
  let nextInvitation = 60;
  let nextRequest = 340;
  let nextInvestor = 135;
  let failures = { status: 500, remaining: 0 };
  let certificate: Uint8Array | null | undefined;

  const investorFor = (email: string): number => {
    const key = email.toLowerCase();
    let id = investorIds.get(key);
    if (id === undefined) {
      nextInvestor += 1;
      id = nextInvestor;
      investorIds.set(key, id);
    }
    return id;
  };

  const createRequest = (inv: FakeInvitation): FakeRequest => {
    nextRequest += 1;
    const vr: FakeRequest = {
      id: nextRequest,
      investorId: investorFor(inv.email),
      status: "waiting_for_investor_acceptance",
      createdAt: now().toISOString(),
      completedAt: null,
      verifiedExpiresAt: null,
      legalName: inv.suggestedLegalName?.toUpperCase() ?? null,
      portalName: inv.portalName,
      waitingForInfo: false,
    };
    vrs.set(vr.id, vr);
    inv.requestId = vr.id;
    return vr;
  };

  /** Resolve a provider ref to its request, signing the investor up for an `inv:` ref. */
  const requestOf = (ref: string): FakeRequest => {
    const m = /^(inv|vr):(\d+)$/u.exec(ref);
    if (m === null) throw new Error(`fake VerifyInvestor: bad ref ${ref}`);
    const id = Number(m[2]);
    if (m[1] === "vr") {
      const vr = vrs.get(id);
      if (vr === undefined) throw new Error(`fake VerifyInvestor: no request ${ref}`);
      return vr;
    }
    const inv = invitations.get(id);
    if (inv === undefined) throw new Error(`fake VerifyInvestor: no invitation ${ref}`);
    const vr = inv.requestId === null ? undefined : vrs.get(inv.requestId);
    return vr ?? createRequest(inv);
  };

  const requestView = (vr: FakeRequest) => ({
    id: vr.id,
    created_at: vr.createdAt,
    waiting_for_info: vr.waitingForInfo,
    completed_at: vr.completedAt,
    verified_expires_at: vr.verifiedExpiresAt,
    legal_name: vr.legalName,
    portal_name: vr.portalName,
    deal_name: null,
    status: vr.status,
    verification_request_step: vr.status,
    investor: { id: vr.investorId },
  });

  const invitationView = (inv: FakeInvitation) => ({
    id: inv.id,
    verification_request_id: inv.requestId,
    created_at: inv.createdAt,
    deal_name: null,
    portal_name: inv.portalName,
    suggested_legal_name: inv.suggestedLegalName,
    email: inv.email,
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
    if (!path.startsWith("/api/v1")) return json(404, { error: "Not found" });
    if (request.headers.get("authorization") !== `Token ${apiToken}`) {
      return json(401, { error: "Invalid API token" });
    }
    if (failures.remaining > 0) {
      failures.remaining -= 1;
      return json(failures.status, { error: `Simulated failure ${failures.status}` });
    }
    const rest = path.slice("/api/v1".length);

    if (method === "GET" && rest === "") {
      return json(200, {
        version: "1.1",
        current_time: now().toISOString(),
        documentation_url: "https://www.verifyinvestor.com/docs/api-v1.pdf",
      });
    }
    if (method === "GET" && rest === "/billing") {
      if (options.billingDisabled === true) return json(404, { error: "Not found" });
      return json(200, {
        from_date: url.searchParams.get("from_date"),
        to_date: url.searchParams.get("to_date"),
        regular: 0,
      });
    }
    if (method === "POST" && rest === "/verification_request_invitations") {
      const b = (body ?? {}) as Record<string, unknown>;
      invitationBodies.push(b);
      const investors = Array.isArray(b["investors"]) ? b["investors"] : [];
      if (investors.length === 0) return json(422, { error: "At least one investor is required." });
      const created = investors.map((raw) => {
        const i = (raw ?? {}) as Record<string, unknown>;
        const email = typeof i["email"] === "string" ? i["email"] : "";
        nextInvitation += 1;
        const inv: FakeInvitation = {
          id: nextInvitation,
          email,
          suggestedLegalName:
            typeof i["suggested_legal_name"] === "string" ? i["suggested_legal_name"] : null,
          portalName: typeof b["portal_name"] === "string" ? b["portal_name"] : null,
          createdAt: now().toISOString(),
          requestId: null,
        };
        invitations.set(inv.id, inv);
        if (existing.has(email.toLowerCase())) createRequest(inv);
        return inv;
      });
      if (created.some((c) => !c.email.includes("@"))) {
        return json(422, { error: "Invalid email address." });
      }
      return json(201, {
        meta: "Verification Request Invitation(s) successfully created.",
        verification_request_invitations: created.map(invitationView),
      });
    }
    let m = /^\/verification_request_invitations\/(\d+)$/u.exec(rest);
    if (method === "GET" && m !== null) {
      const inv = invitations.get(Number(m[1]));
      if (inv === undefined) return json(404, { error: "Invitation not found." });
      const vr = inv.requestId === null ? undefined : vrs.get(inv.requestId);
      if (vr === undefined) {
        return json(200, {
          meta: "Investor has not yet created a VerifyInvestor.com account",
          ...invitationView(inv),
        });
      }
      const { investor: _investor, verification_request_step: _step, ...nested } = requestView(vr);
      return json(200, {
        id: inv.id,
        created_at: inv.createdAt,
        portal_name: inv.portalName,
        deal_name: null,
        suggested_legal_name: inv.suggestedLegalName,
        email: inv.email,
        verification_request: nested,
      });
    }
    m = /^(?:\/users\/(\d+))?\/verification_requests\/(\d+)$/u.exec(rest);
    if (method === "GET" && m !== null) {
      const vr = vrs.get(Number(m[2]));
      if (vr === undefined || (m[1] !== undefined && Number(m[1]) !== vr.investorId)) {
        return json(404, { error: "Verification request not found." });
      }
      return json(200, requestView(vr));
    }
    m = /^\/users\/(\d+)\/verification_requests\/(\d+)\/certificate$/u.exec(rest);
    if (method === "GET" && m !== null) {
      const vr = vrs.get(Number(m[2]));
      if (
        vr === undefined ||
        Number(m[1]) !== vr.investorId ||
        vr.status !== "accredited" ||
        certificate === null
      ) {
        return json(404, { error: "No certificate found" });
      }
      const bytes = certificate ?? fakePdf(`VerifyInvestor certificate ${vr.id}`);
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    }
    return json(404, { error: "Not found" });
  };

  const sign = (rawBody: Uint8Array, secret: string): string => {
    const mac = createHmac("sha256", secret).update(rawBody);
    return options.signatureEncoding === "base64" ? mac.digest("base64") : mac.digest("hex");
  };

  const webhook = (refs: readonly string[], secret: string) => {
    const vr = requestOf(refs[0] ?? "");
    const rawBody = new TextEncoder().encode(
      JSON.stringify({
        action: "verification_result",
        verification_request_id: vr.id,
        investor_id: vr.investorId,
        legal_name: vr.legalName,
        status: vr.status,
        identifier: "42",
      }),
    );
    return {
      headers: new Headers({
        "content-type": "application/json",
        "x-signature-sha256": sign(rawBody, secret),
      }),
      rawBody,
    };
  };

  const decide = (ref: string, status: string, expiresAt?: Date): void => {
    const vr = requestOf(ref);
    vr.status = status;
    vr.completedAt = now().toISOString();
    vr.verifiedExpiresAt =
      status === "accredited"
        ? dateOnly(expiresAt ?? new Date(now().getTime() + 90 * 24 * 3600 * 1000))
        : null;
  };

  const vendor: FakeVerifyInvestorControl = {
    apiToken,
    webhookSecret,
    requests,
    signUp(ref) {
      return `vr:${requestOf(ref).id}`;
    },
    accredit(ref, opts) {
      decide(ref, "accredited", opts?.expiresAt);
    },
    reject(ref) {
      decide(ref, "not_accredited");
    },
    cancel(ref) {
      const vr = requestOf(ref);
      vr.status = "declined_by_investor";
    },
    unknownStatus(ref, raw) {
      requestOf(ref).status = raw;
    },
    setStatus(ref, status, opts) {
      const vr = requestOf(ref);
      vr.status = status;
      vr.waitingForInfo = opts?.waitingForInfo === true;
    },
    failNext(kind, times = 1) {
      const status = kind === "rate_limited" ? 429 : kind === "unavailable" ? 500 : kind;
      failures = { status, remaining: times };
    },
    setCertificate(bytes) {
      certificate = bytes;
    },
    callback: (refs) => webhook(refs, webhookSecret),
    forgedCallback: (refs) => webhook(refs, `${webhookSecret}-forged`),
    expireInvitation(ref, how) {
      const m = /^inv:(\d+)$/u.exec(ref);
      const inv = m === null ? undefined : invitations.get(Number(m[1]));
      if (inv === undefined) throw new Error(`fake VerifyInvestor: no invitation ${ref}`);
      if (how === "gone") invitations.delete(inv.id);
      else inv.createdAt = new Date(now().getTime() - 31 * 24 * 3600 * 1000).toISOString();
    },
    invitations: () => invitationBodies.slice(),
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
