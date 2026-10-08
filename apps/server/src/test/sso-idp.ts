import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DnsAnswer, DnsRecordType, DnsResolverPort } from "@fundroom/ports";

/*
 * Test identity providers for the E3.8 SSO integration files (`sso-*.integration.test.ts`, and
 * C/D may import it). Not imported by the server.
 *
 *  - `startFakeOidcIdp()`: a real-HTTP OpenID Provider on 127.0.0.1 (discovery document, JWKS,
 *    token endpoint with client_secret_post + PKCE S256) — the server reaches it through the SSO
 *    guarded fetch, so the test config must set `SSO_ALLOW_PRIVATE_HOSTS=127.0.0.1`. The
 *    authorization step is driven from the test: `authorize(beginUrl, …)` plays the user signing
 *    in at the IdP and returns the redirect back to our callback, with configurable claims (email,
 *    amr, acr, tid, …) and knobs for a wrong issuer / audience / nonce, a foreign signing key, or
 *    an `error` answer.
 *  - the SAML IdP (`createTestSamlIdp`, `parseAuthnRequest`, `encodeResponse`) is re-exported from
 *    `@fundroom/sso/testing`: a generated key + cert, and a knob for every attack in research §1.
 *  - `fakeDns()`: a `DnsResolverPort` whose TXT answers the test sets.
 */

export {
  createTestSamlIdp,
  EMAIL_NAMEID_FORMAT,
  encodeResponse,
  PERSISTENT_NAMEID_FORMAT,
  parseAuthnRequest,
  type SamlResponseOptions,
  selfSignedCertificate,
  type TestSamlIdp,
} from "@fundroom/sso/testing";

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signJwt(key: KeyObject, kid: string, claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = b64url(JSON.stringify(claims));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}

export interface AuthorizeOptions {
  /** Claims merged over the IdP's defaults for this sign-in (email, name, amr, acr, tid, …). */
  readonly claims?: Readonly<Record<string, unknown>> | undefined;
  /** Answer the authorization request with `?error=<code>` instead of a code. */
  readonly error?: string | undefined;
  /** ID token `iss` override (issuer mix-up). */
  readonly idTokenIssuer?: string | undefined;
  /** ID token `aud` override. */
  readonly audience?: string | undefined;
  /** ID token `nonce` override. */
  readonly nonce?: string | undefined;
  /** Sign the ID token with a key the JWKS does not publish. */
  readonly foreignKey?: boolean | undefined;
  /** Replace `state` in the redirect back. */
  readonly state?: string | undefined;
}

export interface FakeOidcIdp {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Default claims of every ID token (mutable between tests). */
  readonly defaults: Record<string, unknown>;
  /** Token-endpoint calls seen, and the last redirect_uri the IdP was asked to use. */
  readonly seen: {
    tokenCalls: number;
    lastRedirectUri: string | undefined;
    lastLoginHint: string | undefined;
  };
  /**
   * Plays the user signing in at the IdP: validates the authorization request our begin built and
   * returns the URL the IdP redirects the browser back to (our canonical-host callback).
   */
  authorize(beginUrl: string, options?: AuthorizeOptions): string;
  close(): Promise<void>;
}

interface PendingCode {
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly nonce: string | undefined;
  readonly options: AuthorizeOptions;
}

export async function startFakeOidcIdp(
  options: {
    readonly clientId?: string;
    readonly clientSecret?: string;
    readonly path?: string;
  } = {},
): Promise<FakeOidcIdp> {
  const clientId = options.clientId ?? `client-${randomBytes(4).toString("hex")}`;
  const clientSecret = options.clientSecret ?? `secret-${randomBytes(12).toString("hex")}`;
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const foreign = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const kid = randomBytes(6).toString("hex");
  const codes = new Map<string, PendingCode>();
  const defaults: Record<string, unknown> = {};
  const seen: FakeOidcIdp["seen"] = {
    tokenCalls: 0,
    lastRedirectUri: undefined,
    lastLoginHint: undefined,
  };
  let issuer = "";

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", issuer || "http://127.0.0.1");
      const path = url.pathname.slice(new URL(issuer).pathname.replace(/\/$/u, "").length);
      if (req.method === "GET" && path === "/.well-known/openid-configuration") {
        return send(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          scopes_supported: ["openid", "email", "profile"],
        });
      }
      if (req.method === "GET" && path === "/jwks") {
        return send(res, 200, {
          keys: [{ ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" }],
        });
      }
      if (req.method === "POST" && path === "/token") {
        seen.tokenCalls += 1;
        const form = new URLSearchParams(await readBody(req));
        if (form.get("client_id") !== clientId || form.get("client_secret") !== clientSecret) {
          return send(res, 401, { error: "invalid_client" });
        }
        const code = form.get("code") ?? "";
        const pending = codes.get(code);
        codes.delete(code);
        if (pending === undefined || form.get("grant_type") !== "authorization_code") {
          return send(res, 400, { error: "invalid_grant" });
        }
        if (form.get("redirect_uri") !== pending.redirectUri) {
          return send(res, 400, { error: "invalid_grant", error_description: "redirect_uri" });
        }
        const verifier = form.get("code_verifier") ?? "";
        if (b64url(createHash("sha256").update(verifier).digest()) !== pending.codeChallenge) {
          return send(res, 400, { error: "invalid_grant", error_description: "pkce" });
        }
        const now = Math.floor(Date.now() / 1000);
        const o = pending.options;
        const claims = {
          sub: "subject-1",
          ...defaults,
          ...(o.claims ?? {}),
          iss: o.idTokenIssuer ?? issuer,
          aud: o.audience ?? clientId,
          iat: now,
          exp: now + 300,
          ...(o.nonce !== undefined
            ? { nonce: o.nonce }
            : pending.nonce === undefined
              ? {}
              : { nonce: pending.nonce }),
        };
        return send(res, 200, {
          access_token: randomBytes(16).toString("hex"),
          token_type: "Bearer",
          expires_in: 300,
          id_token: signJwt(o.foreignKey ? foreign : privateKey, kid, claims),
        });
      }
      return send(res, 404, { error: "not_found" });
    })().catch(() => send(res, 500, { error: "server_error" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  issuer = `http://127.0.0.1:${port}${options.path ?? ""}`;

  return {
    issuer,
    clientId,
    clientSecret,
    defaults,
    seen,
    authorize(beginUrl, o = {}) {
      const u = new URL(beginUrl);
      if (!beginUrl.startsWith(`${issuer}/authorize`)) throw new Error(`not this IdP: ${beginUrl}`);
      const p = u.searchParams;
      if (p.get("client_id") !== clientId) throw new Error("unknown client_id");
      if (p.get("response_type") !== "code") throw new Error("response_type must be code");
      if (p.get("code_challenge_method") !== "S256") throw new Error("PKCE S256 required");
      const redirectUri = p.get("redirect_uri");
      const state = p.get("state");
      const challenge = p.get("code_challenge");
      if (redirectUri === null || state === null || challenge === null) {
        throw new Error("authorization request is missing redirect_uri/state/code_challenge");
      }
      seen.lastRedirectUri = redirectUri;
      seen.lastLoginHint = p.get("login_hint") ?? undefined;
      const back = new URL(redirectUri);
      back.searchParams.set("state", o.state ?? state);
      if (o.error !== undefined) {
        back.searchParams.set("error", o.error);
        return back.href;
      }
      const code = randomBytes(16).toString("hex");
      codes.set(code, {
        redirectUri,
        codeChallenge: challenge,
        nonce: p.get("nonce") ?? undefined,
        options: o,
      });
      back.searchParams.set("code", code);
      return back.href;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A DNS resolver whose TXT answers the test controls (everything else is NXDOMAIN). */
export function fakeDns(): DnsResolverPort & { readonly txt: Map<string, string[]> } {
  const txt = new Map<string, string[]>();
  return {
    driver: "fake",
    txt,
    async resolve(name: string, type: DnsRecordType): Promise<DnsAnswer> {
      const values = type === "TXT" ? txt.get(name.toLowerCase()) : undefined;
      return {
        name,
        type,
        values: values ?? [],
        rcode: values === undefined ? "nxdomain" : "ok",
        resolver: "fake",
      };
    },
    async healthCheck() {},
  };
}
