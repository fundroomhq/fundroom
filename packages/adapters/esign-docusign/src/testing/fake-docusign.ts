import { createHmac, generateKeyPairSync, type KeyObject, randomUUID, verify } from "node:crypto";

/**
 * A scripted DocuSign for unit tests: a `fetch` implementation that answers the OAuth and REST
 * endpoints the adapter uses, keeps envelope state in memory, and verifies the JWT assertion with
 * the matching public key (so a test proves the claims AND the RS256 signature). Structurally
 * implements `FakeVendorControl` from `@fundroom/esign/testing` (not imported, so the adapter's
 * build does not depend on the kernel package).
 */

export const FAKE = {
  integrationKey: "11111111-2222-3333-4444-555555555555",
  userId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  accountId: "0f0f0f0f-1111-2222-3333-444444444444",
  baseUri: "https://demo.docusign.net",
  hmacKey: "fake-connect-hmac-key-1",
  templateId: "9e9e9e9e-0000-4000-8000-000000000001",
  templateRole: "Signer",
} as const;

const PDF = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [] /Count 0 /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n",
);

interface Recipient {
  recipientId: string;
  routingOrder: string;
  name: string;
  email: string;
  roleName?: string;
  clientUserId?: string;
  customFields?: string[];
  status: string;
  signedDateTime?: string;
  declinedDateTime?: string;
  deliveredDateTime?: string;
}

interface Envelope {
  id: string;
  status: string;
  voidedReason?: string;
  completedDateTime?: string;
  customFields: { name: string; value: string }[];
  recipients: Recipient[];
  input: unknown;
}

export interface FakeDocusignOptions {
  /** Signed-PDF size served by documents/combined (padding after a valid header). */
  readonly documentBytes?: number;
  /** Override what userinfo answers as base_uri (base-URI validation tests). */
  readonly baseUri?: string;
  /** Token lifetime in seconds. */
  readonly expiresIn?: number;
}

export interface FakeDocusign {
  readonly fetch: typeof fetch;
  readonly privateKeyPem: string;
  readonly calls: { method: string; url: string; headers: Headers; body?: string }[];
  readonly tokenRequests: () => number;
  readonly lastAssertion: () => string | undefined;
  readonly revokeTokens: () => void;
  /** Queue HTTP failures for the next REST (non-OAuth) calls. */
  readonly failNext: (status: number, count?: number) => void;
  readonly vendor: {
    complete(providerRef: string): void;
    decline(providerRef: string): void;
    voidFromVendor(providerRef: string): void;
    view(providerRef: string): void;
    callback(
      providerRef: string,
      event: "completed" | "declined" | "viewed",
    ): { headers: Headers; body: Uint8Array };
    forgedCallback(providerRef: string): { headers: Headers; body: Uint8Array };
    created(): readonly { providerRef: string; input: unknown }[];
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function hmacHeader(key: string, body: Uint8Array): string {
  return createHmac("sha256", key).update(body).digest("base64");
}

/** One RSA keypair per test process (key generation is slow). */
let keys: { privateKey: KeyObject; publicKey: KeyObject } | undefined;

export function createFakeDocusign(options: FakeDocusignOptions = {}): FakeDocusign {
  keys ??= generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const pub = keys.publicKey;
  const envelopes = new Map<string, Envelope>();
  const created: { providerRef: string; input: unknown }[] = [];
  const calls: FakeDocusign["calls"] = [];
  const tokens = new Set<string>();
  const failures: number[] = [];
  let tokenRequests = 0;
  let lastAssertion: string | undefined;
  const now = () => new Date().toISOString();

  function checkAssertion(assertion: string): boolean {
    const parts = assertion.split(".");
    if (parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string];
    const ok = verify("sha256", Buffer.from(`${h}.${p}`), pub, Buffer.from(s, "base64url"));
    if (!ok) return false;
    const header = JSON.parse(Buffer.from(h, "base64url").toString()) as Record<string, unknown>;
    const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
    return (
      header["alg"] === "RS256" &&
      claims["iss"] === FAKE.integrationKey &&
      claims["sub"] === FAKE.userId &&
      claims["aud"] === "account-d.docusign.com" &&
      claims["scope"] === "signature impersonation"
    );
  }

  function authed(headers: Headers): boolean {
    const auth = headers.get("authorization") ?? "";
    return auth.startsWith("Bearer ") && tokens.has(auth.slice(7));
  }

  function mustGet(id: string): Envelope {
    const env = envelopes.get(id);
    if (!env) throw new Error(`fake docusign: unknown envelope ${id}`);
    return env;
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
    const bodyText = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      method,
      url: url.href,
      headers,
      ...(bodyText !== undefined ? { body: bodyText } : {}),
    });

    if (url.host === "account-d.docusign.com") {
      if (method === "POST" && url.pathname === "/oauth/token") {
        tokenRequests++;
        const form = new URLSearchParams(bodyText ?? "");
        const assertion = form.get("assertion") ?? "";
        lastAssertion = assertion;
        if (
          form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer" ||
          !checkAssertion(assertion)
        ) {
          return json(400, {
            error: "invalid_grant",
            error_description: "no_valid_keys_or_signatures",
          });
        }
        const token = `tok-${randomUUID()}`;
        tokens.add(token);
        return json(200, {
          access_token: token,
          token_type: "Bearer",
          expires_in: options.expiresIn ?? 3600,
        });
      }
      if (method === "GET" && url.pathname === "/oauth/userinfo") {
        if (!authed(headers)) return json(401, { error: "invalid_token" });
        return json(200, {
          sub: FAKE.userId,
          accounts: [
            {
              account_id: "other-account",
              is_default: false,
              account_name: "Other",
              base_uri: "https://eu.docusign.net",
            },
            {
              account_id: FAKE.accountId,
              is_default: true,
              account_name: "Acme Ventures",
              base_uri: options.baseUri ?? FAKE.baseUri,
            },
          ],
        });
      }
      return json(404, { error: "not_found" });
    }

    const prefix = `/restapi/v2.1/accounts/${FAKE.accountId}`;
    if (url.origin !== FAKE.baseUri || !url.pathname.startsWith(prefix)) {
      return json(404, { errorCode: "NOT_FOUND" });
    }
    if (!authed(headers)) return json(401, { errorCode: "USER_AUTHENTICATION_FAILED" });
    const failure = failures.shift();
    if (failure !== undefined)
      return json(failure, { errorCode: "INJECTED", message: "secret echo: hunter2" });

    const path = url.pathname.slice(prefix.length);
    if (method === "POST" && path === "/envelopes") {
      const def = JSON.parse(bodyText ?? "{}") as Record<string, unknown>;
      const id = randomUUID();
      const custom = ((def["customFields"] as Record<string, unknown> | undefined)?.[
        "textCustomFields"
      ] ?? []) as {
        name: string;
        value: string;
      }[];
      let recipients: Recipient[];
      if (typeof def["templateId"] === "string") {
        if (def["templateId"] !== FAKE.templateId)
          return json(400, { errorCode: "TEMPLATE_ID_INVALID" });
        recipients = ((def["templateRoles"] ?? []) as Record<string, string>[]).map((r, i) => ({
          recipientId: String(i + 1),
          routingOrder: r["routingOrder"] ?? "1",
          name: r["name"] ?? "",
          email: r["email"] ?? "",
          ...(r["roleName"] ? { roleName: r["roleName"] } : {}),
          ...(r["clientUserId"] ? { clientUserId: r["clientUserId"] } : {}),
          status: "sent",
        }));
      } else {
        recipients = (
          ((def["recipients"] as Record<string, unknown>)?.["signers"] ?? []) as Record<
            string,
            unknown
          >[]
        ).map((r) => ({
          recipientId: String(r["recipientId"]),
          routingOrder: String(r["routingOrder"]),
          name: String(r["name"]),
          email: String(r["email"]),
          ...(typeof r["clientUserId"] === "string" ? { clientUserId: r["clientUserId"] } : {}),
          customFields: (r["customFields"] as string[] | undefined) ?? [],
          status: "sent",
        }));
      }
      envelopes.set(id, { id, status: "sent", customFields: custom, recipients, input: def });
      created.push({ providerRef: id, input: def });
      return json(201, { envelopeId: id, status: "sent", uri: `/envelopes/${id}` });
    }
    const m = /^\/envelopes\/([^/]+)(\/.*)?$/.exec(path);
    const env = m ? envelopes.get(m[1] ?? "") : undefined;
    if (!m || !env) return json(404, { errorCode: "ENVELOPE_DOES_NOT_EXIST" });
    const sub = m[2] ?? "";
    if (method === "GET" && sub === "") {
      return json(200, {
        envelopeId: env.id,
        status: env.status,
        ...(env.voidedReason ? { voidedReason: env.voidedReason } : {}),
        ...(env.completedDateTime ? { completedDateTime: env.completedDateTime } : {}),
      });
    }
    if (method === "PUT" && sub === "") {
      const body = JSON.parse(bodyText ?? "{}") as Record<string, unknown>;
      if (body["status"] !== "voided") return json(400, { errorCode: "INVALID_REQUEST_PARAMETER" });
      if (env.status === "completed" || env.status === "voided") {
        return json(400, { errorCode: "ENVELOPE_CANNOT_VOID_INVALID_STATE" });
      }
      env.status = "voided";
      env.voidedReason = String(body["voidedReason"]);
      return json(200, { envelopeId: env.id });
    }
    if (method === "GET" && sub === "/recipients") return json(200, { signers: env.recipients });
    if (method === "GET" && sub === "/custom_fields")
      return json(200, { textCustomFields: env.customFields });
    if (method === "POST" && sub === "/views/recipient") {
      const body = JSON.parse(bodyText ?? "{}") as Record<string, unknown>;
      const r = env.recipients.find(
        (x) => x.clientUserId && x.clientUserId === body["clientUserId"],
      );
      if (!r || body["email"] !== r.email || body["userName"] !== r.name) {
        return json(400, { errorCode: "UNKNOWN_ENVELOPE_RECIPIENT" });
      }
      return json(201, { url: `https://demo.docusign.net/Signing/MTRedeem/v1/${randomUUID()}` });
    }
    if (method === "GET" && (sub === "/documents/combined" || sub === "/documents/certificate")) {
      const size =
        sub === "/documents/combined" ? (options.documentBytes ?? PDF.byteLength) : PDF.byteLength;
      const bytes = new Uint8Array(Math.max(size, PDF.byteLength));
      bytes.set(PDF);
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": String(bytes.byteLength) },
      });
    }
    return json(404, { errorCode: "NOT_FOUND" });
  };

  function callbackBody(providerRef: string, event: string): Uint8Array {
    const env = mustGet(providerRef);
    return new TextEncoder().encode(
      JSON.stringify({
        event,
        apiVersion: "v2.1",
        uri: `/restapi/v2.1/accounts/${FAKE.accountId}/envelopes/${providerRef}`,
        retryCount: 0,
        configurationId: 1234,
        generatedDateTime: now(),
        data: {
          accountId: FAKE.accountId,
          envelopeId: providerRef,
          envelopeSummary: {
            status: env.status,
            customFields: { textCustomFields: env.customFields },
          },
        },
      }),
    );
  }

  const vendor: FakeDocusign["vendor"] = {
    complete(ref) {
      const env = mustGet(ref);
      env.status = "completed";
      env.completedDateTime = now();
      for (const r of env.recipients) {
        r.status = "completed";
        r.signedDateTime = now();
      }
    },
    decline(ref) {
      const env = mustGet(ref);
      env.status = "declined";
      const first = env.recipients[0];
      if (first) {
        first.status = "declined";
        first.declinedDateTime = now();
      }
    },
    voidFromVendor(ref) {
      const env = mustGet(ref);
      env.status = "voided";
      env.voidedReason = "Voided by sender";
    },
    view(ref) {
      const env = mustGet(ref);
      env.status = "delivered";
      for (const r of env.recipients) {
        r.status = "delivered";
        r.deliveredDateTime = now();
      }
    },
    callback(ref, event) {
      const body = callbackBody(ref, `envelope-${event === "viewed" ? "delivered" : event}`);
      return {
        headers: new Headers({
          "content-type": "application/json",
          "x-docusign-signature-1": hmacHeader(FAKE.hmacKey, body),
        }),
        body,
      };
    },
    forgedCallback(ref) {
      const body = callbackBody(ref, "envelope-completed");
      return {
        headers: new Headers({
          "content-type": "application/json",
          "x-docusign-signature-1": hmacHeader("wrong-key", body),
        }),
        body,
      };
    },
    created: () => created,
  };

  return {
    fetch: fakeFetch as typeof fetch,
    privateKeyPem,
    calls,
    tokenRequests: () => tokenRequests,
    lastAssertion: () => lastAssertion,
    revokeTokens: () => tokens.clear(),
    failNext: (status, count = 1) => {
      for (let i = 0; i < count; i++) failures.push(status);
    },
    vendor,
  };
}
