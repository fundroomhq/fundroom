import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createOutboundHttp, type OutboundHttp } from "@fundroom/outbound-http";
import type { SpreadsheetCredential } from "@fundroom/ports";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createNoopSpreadsheets } from "./noop.js";
import {
  createGoogleSheetsAdapter,
  isValidRange,
  isValidSpreadsheetId,
  parseServiceAccountJson,
  SHEETS_READONLY_SCOPE,
} from "./sheets-google.js";

/*
 * A real `node:http` server on 127.0.0.1 behind the real SSRF guard, which is the only way to
 * exercise the two things this adapter is actually made of: the bytes on the wire (a signed
 * assertion, a bearer header) and the guard's own refusals (`response_too_large`). The guard
 * blocks loopback by default, so the tests exempt `127.0.0.1` exactly as the documented
 * `OUTBOUND_HTTP_ALLOW_PRIVATE_HOSTS=127.0.0.1` dev escape hatch does.
 *
 * The RSA key is generated here and never committed: a private key in a repository is a private
 * key on every developer's disk and in every fork.
 */

const SPREADSHEET_ID = "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms";
const RANGE = "KPIs!A1:D100";

let privateKeyPem = "";
let publicKeyPem = "";
/**
 * A second, unrelated RSA key for the same `client_email`. It is both halves of the cache-key
 * defect: the admin who rotates a compromised key, and the workspace that pastes somebody
 * else's address with a key of its own.
 */
let otherPrivateKeyPem = "";
let server: Server;
let origin = "";
let http: OutboundHttp;
let clock = new Date("2026-09-19T08:00:00.000Z");

interface Signer {
  readonly label: string;
  readonly publicKeyPem: string;
}

interface Fake {
  tokenCalls: number;
  valuesCalls: number;
  tokenStatus: number;
  tokenBody: string;
  tokenContentType: string;
  valuesStatus: number;
  valuesBody: string;
  lastAssertion: string;
  lastAuthorization: string;
  lastValuesUrl: string;
  /** Statuses for successive values calls, oldest first; `valuesStatus` once it runs out. */
  valuesStatuses: number[];
  /** Bodies for successive token calls, oldest first; `tokenBody` once it runs out. */
  tokenBodies: string[];
  /**
   * Google, more or less: the token endpoint mints a token **only** for an assertion one of
   * `signers` actually signed, and the values endpoint serves rows **only** to the bearer of
   * `grantedToken`. Off by default, because most tests care about mapping and not about who
   * is allowed to read what.
   */
  strictAuth: boolean;
  signers: Signer[];
  grantedToken: string;
  /** Where a 302 from the values endpoint points, so a followed redirect is visible. */
  redirectTo: string;
  redirectCalls: number;
}

const fake: Fake = {
  tokenCalls: 0,
  valuesCalls: 0,
  tokenStatus: 200,
  tokenBody: JSON.stringify({ access_token: "ya29.token", expires_in: 3600, token_type: "Bearer" }),
  tokenContentType: "application/json",
  valuesStatus: 200,
  valuesBody: JSON.stringify({
    range: "KPIs!A1:D100",
    majorDimension: "ROWS",
    values: [
      ["period", "mrr"],
      ["2026-01", "1200.50"],
    ],
  }),
  lastAssertion: "",
  lastAuthorization: "",
  lastValuesUrl: "",
  valuesStatuses: [],
  tokenBodies: [],
  strictAuth: false,
  signers: [],
  grantedToken: "",
  redirectTo: "/redirected",
  redirectCalls: 0,
};

function reset(): void {
  fake.tokenCalls = 0;
  fake.valuesCalls = 0;
  fake.tokenStatus = 200;
  fake.tokenBody = JSON.stringify({
    access_token: "ya29.token",
    expires_in: 3600,
    token_type: "Bearer",
  });
  fake.tokenContentType = "application/json";
  fake.valuesStatus = 200;
  fake.valuesBody = JSON.stringify({
    range: "KPIs!A1:D100",
    majorDimension: "ROWS",
    values: [
      ["period", "mrr"],
      ["2026-01", "1200.50"],
    ],
  });
  fake.lastAssertion = "";
  fake.lastAuthorization = "";
  fake.lastValuesUrl = "";
  fake.valuesStatuses = [];
  fake.tokenBodies = [];
  fake.strictAuth = false;
  fake.signers = [];
  fake.grantedToken = "";
  fake.redirectTo = "/redirected";
  fake.redirectCalls = 0;
  clock = new Date("2026-09-19T08:00:00.000Z");
}

/** The signer of an assertion, by trial verification — what Google does with the real key. */
function signerOf(assertion: string): Signer | undefined {
  const [header, claims, signature] = assertion.split(".");
  return fake.signers.find((candidate) => {
    try {
      return createVerify("RSA-SHA256")
        .update(`${header}.${claims}`)
        .verify(candidate.publicKeyPem, Buffer.from(signature ?? "", "base64url"));
    } catch {
      return false;
    }
  });
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", origin === "" ? "http://127.0.0.1" : origin);
  if (url.pathname === "/token") {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      fake.tokenCalls += 1;
      fake.lastAssertion = new URLSearchParams(body).get("assertion") ?? "";
      if (fake.strictAuth) {
        const signer = signerOf(fake.lastAssertion);
        if (signer === undefined) {
          // Exactly what Google answers an assertion signed with a key it does not know.
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: `ya29.${signer.label}`, expires_in: 3600 }));
        return;
      }
      res.writeHead(fake.tokenStatus, {
        "content-type": fake.tokenContentType,
      });
      res.end(fake.tokenBodies.shift() ?? fake.tokenBody);
    });
    return;
  }
  if (url.pathname === "/redirected") {
    fake.redirectCalls += 1;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ range: "KPIs!A1:D100", values: [["period", "mrr"]] }));
    return;
  }
  fake.valuesCalls += 1;
  fake.lastValuesUrl = req.url ?? "";
  fake.lastAuthorization = req.headers.authorization ?? "";
  if (fake.strictAuth && req.headers.authorization !== `Bearer ${fake.grantedToken}`) {
    res.writeHead(403, { "content-type": "application/json" });
    res.end(
      JSON.stringify({ error: { code: 403, message: "The caller does not have permission" } }),
    );
    return;
  }
  const status = fake.valuesStatuses.shift() ?? fake.valuesStatus;
  if (status === 302) {
    res.writeHead(302, { location: fake.redirectTo });
    res.end();
    return;
  }
  res.writeHead(status, { "content-type": "application/json" });
  res.end(fake.valuesBody);
}

function credential(): SpreadsheetCredential {
  return { clientEmail: "kpi-sync@acme-123.iam.gserviceaccount.com", privateKeyPem };
}

function serviceAccountJson(): string {
  return JSON.stringify({
    type: "service_account",
    project_id: "acme-123",
    private_key_id: "abc",
    private_key: privateKeyPem,
    client_email: "kpi-sync@acme-123.iam.gserviceaccount.com",
    token_uri: "https://oauth2.googleapis.com/token",
  });
}

/** A fresh adapter per test: the token cache is per instance, and most tests care about it. */
function adapter(
  overrides: {
    readonly maxResponseBytes?: number;
    readonly fetch?: OutboundHttp;
    readonly log?: (event: string, fields?: Readonly<Record<string, unknown>>) => void;
  } = {},
) {
  const guard = overrides.fetch ?? http;
  return createGoogleSheetsAdapter({
    fetch: guard.fetch,
    tokenEndpoint: `${origin}/token`,
    apiBaseUrl: origin,
    now: () => clock,
    ...(overrides.log === undefined ? {} : { log: overrides.log }),
    ...(overrides.maxResponseBytes === undefined
      ? {}
      : { maxResponseBytes: overrides.maxResponseBytes }),
  });
}

beforeAll(async () => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  privateKeyPem = pair.privateKey;
  publicKeyPem = pair.publicKey;
  const other = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  otherPrivateKeyPem = other.privateKey;
  server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  http = createOutboundHttp({ allowedPrivateHosts: ["127.0.0.1"], timeoutMs: 5_000 });
});

afterAll(async () => {
  await http.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(reset);

describe("createGoogleSheetsAdapter", () => {
  it("self-identifies as the sheets-google driver", () => {
    expect(adapter().driver).toBe("sheets-google");
  });

  it("reads a range and returns its rows", async () => {
    const result = await adapter().read(credential(), SPREADSHEET_ID, RANGE);
    expect(result).toEqual({
      ok: true,
      range: {
        rows: [
          ["period", "mrr"],
          ["2026-01", "1200.50"],
        ],
      },
    });
    /*
     * `UNFORMATTED_VALUE` is the fix for the sheet that imports nothing: `FORMATTED_VALUE`
     * is the cell as *displayed*, so a currency-formatted MRR column arrived as "$12,400" and
     * `parseFixed` refused every one of them. `dateTimeRenderOption` rides along because
     * unformatted dates are serial numbers, which would break the period column instead.
     */
    expect(fake.lastValuesUrl).toBe(
      `/v4/spreadsheets/${SPREADSHEET_ID}/values/${encodeURIComponent(RANGE)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`,
    );
    expect(fake.lastAuthorization).toBe("Bearer ya29.token");
  });

  it("signs an RS256 JWT-bearer assertion for the read-only scope", async () => {
    await adapter().read(credential(), SPREADSHEET_ID, RANGE);
    const [header, claims, signature] = fake.lastAssertion.split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    const payload = JSON.parse(Buffer.from(claims ?? "", "base64url").toString()) as {
      iss: string;
      scope: string;
      aud: string;
      iat: number;
      exp: number;
    };
    expect(payload.iss).toBe("kpi-sync@acme-123.iam.gserviceaccount.com");
    expect(payload.scope).toBe(SHEETS_READONLY_SCOPE);
    expect(payload.aud).toBe(`${origin}/token`);
    expect(payload.exp - payload.iat).toBe(3600);
    const ok = createVerify("RSA-SHA256")
      .update(`${header}.${claims}`)
      .verify(publicKeyPem, Buffer.from(signature ?? "", "base64url"));
    expect(ok).toBe(true);
  });

  it("caches the access token: a second read inside its lifetime asks for no new token", async () => {
    const sheets = adapter();
    await sheets.read(credential(), SPREADSHEET_ID, RANGE);
    clock = new Date(clock.getTime() + 60_000);
    await sheets.read(credential(), SPREADSHEET_ID, "KPIs!A1:B2");
    expect(fake.tokenCalls).toBe(1);
    expect(fake.valuesCalls).toBe(2);
  });

  it("refreshes the token once it is inside the expiry skew", async () => {
    const sheets = adapter();
    await sheets.read(credential(), SPREADSHEET_ID, RANGE);
    // 3 600 s lifetime, 60 s skew: at t+3 550 s the cached token is no longer spendable.
    clock = new Date(clock.getTime() + 3_550_000);
    await sheets.read(credential(), SPREADSHEET_ID, RANGE);
    expect(fake.tokenCalls).toBe(2);
  });

  it("does not share a cached token between adapters", async () => {
    await adapter().read(credential(), SPREADSHEET_ID, RANGE);
    await adapter().read(credential(), SPREADSHEET_ID, RANGE);
    expect(fake.tokenCalls).toBe(2);
  });

  describe("the access-token cache is keyed on the whole credential", () => {
    /*
     * The cache is per adapter instance and the composition root builds **one instance per
     * process**, shared by every tenant. Keyed on `client_email` it was a cross-tenant hole:
     * `parseServiceAccountJson` can only check that the PEM is readable — nothing local can
     * check that a key belongs to the address beside it — so a workspace that pastes somebody
     * else's `client_email` with a key of its own reads their sheet on their cached token,
     * without ever signing an assertion Google would accept.
     *
     * These run against a fake Google that behaves like the real one in the only two ways that
     * matter: it mints a token **only** for an assertion it can verify, and it serves rows
     * **only** to the bearer it minted for.
     */
    it("does not let a second workspace spend the first workspace's token", async () => {
      fake.strictAuth = true;
      fake.signers = [{ label: "victim", publicKeyPem }];
      fake.grantedToken = "ya29.victim";
      const sheets = adapter();

      const genuine = await sheets.read(credential(), SPREADSHEET_ID, RANGE);
      expect(genuine).toMatchObject({ ok: true });

      // Same address, a key the attacker generated. Google has never seen it.
      const forged = await sheets.read(
        { clientEmail: credential().clientEmail, privateKeyPem: otherPrivateKeyPem },
        SPREADSHEET_ID,
        RANGE,
      );
      expect(forged).toMatchObject({ ok: false, reason: "unauthorized" });
      expect(JSON.stringify(forged)).not.toContain("1200.50");

      // The decisive counts: the forger had to ask for a token of its own (and was refused),
      // and never reached the values endpoint at all.
      expect(fake.tokenCalls).toBe(2);
      expect(fake.valuesCalls).toBe(1);
    });

    it("mints a new token when the key is rotated, rather than spending the old one", async () => {
      // The same hole with no attacker in it: revoking a compromised key changed nothing for
      // up to 59 minutes, because the token it had already bought stayed in the cache.
      const sheets = adapter();
      await sheets.read(credential(), SPREADSHEET_ID, RANGE);
      expect(fake.tokenCalls).toBe(1);

      const rotated = { clientEmail: credential().clientEmail, privateKeyPem: otherPrivateKeyPem };
      await sheets.read(rotated, SPREADSHEET_ID, RANGE);
      expect(fake.tokenCalls).toBe(2);

      // And the new key's token is cached under its own key, so the sweep is still a cache.
      await sheets.read(rotated, SPREADSHEET_ID, RANGE);
      expect(fake.tokenCalls).toBe(2);
    });
  });

  describe("a 401 from the values endpoint", () => {
    it("drops the cached token, mints a fresh one and retries exactly once", async () => {
      fake.tokenBodies = [
        JSON.stringify({ access_token: "ya29.stale", expires_in: 3600 }),
        JSON.stringify({ access_token: "ya29.fresh", expires_in: 3600 }),
      ];
      fake.valuesStatuses = [401];
      const result = await adapter().read(credential(), SPREADSHEET_ID, RANGE);
      expect(result).toMatchObject({ ok: true });
      expect(fake.tokenCalls).toBe(2);
      expect(fake.valuesCalls).toBe(2);
      // The retry went out on the *new* token; retrying on the repudiated one buys nothing.
      expect(fake.lastAuthorization).toBe("Bearer ya29.fresh");
    });

    it("gives up after the retry instead of looping", async () => {
      fake.valuesStatus = 401;
      const result = await adapter().read(credential(), SPREADSHEET_ID, RANGE);
      expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
      expect(fake.valuesCalls).toBe(2);
      expect(fake.tokenCalls).toBe(2);
    });

    it("does not retry a 403, which no new token can fix", async () => {
      // 403 is "the sheet is not shared with this service account". A fresh token is the same
      // token as far as the spreadsheet's ACL is concerned; retrying only doubles the quota.
      fake.valuesStatus = 403;
      const result = await adapter().read(credential(), SPREADSHEET_ID, RANGE);
      expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
      expect(fake.valuesCalls).toBe(1);
      expect(fake.tokenCalls).toBe(1);
    });
  });

  describe("expires_in", () => {
    it("accepts a numeric string, which RFC 6749 does not forbid", async () => {
      // Read as "not a number", the lifetime fell to 0, the entry was born unspendable and
      // every read became a token call — a cache that silently stopped being one.
      fake.tokenBody = JSON.stringify({ access_token: "ya29.token", expires_in: "3600" });
      const sheets = adapter();
      await sheets.read(credential(), SPREADSHEET_ID, RANGE);
      clock = new Date(clock.getTime() + 60_000);
      await sheets.read(credential(), SPREADSHEET_ID, RANGE);
      expect(fake.tokenCalls).toBe(1);
    });

    it("treats an unusable value as a short-lived token, not a dead one", async () => {
      fake.tokenBody = JSON.stringify({ access_token: "ya29.token", expires_in: "soon" });
      const sheets = adapter();
      await sheets.read(credential(), SPREADSHEET_ID, RANGE);
      clock = new Date(clock.getTime() + 60_000);
      await sheets.read(credential(), SPREADSHEET_ID, RANGE);
      expect(fake.tokenCalls).toBe(1);
      // ...and genuinely short-lived: five minutes on it re-authenticates rather than
      // spending something whose real lifetime nobody told us.
      clock = new Date(clock.getTime() + 250_000);
      await sheets.read(credential(), SPREADSHEET_ID, RANGE);
      expect(fake.tokenCalls).toBe(2);
    });
  });

  it("refuses to follow a redirect, which is the whole point of maxRedirects: 0", async () => {
    /*
     * A redirect is how an authenticated outbound request gets aimed somewhere else, and the
     * bearer token is on it. The composition root builds this adapter's guard with
     * `maxRedirects: 0` (`apps/server/src/container.ts`); this is the test that the setting
     * means something.
     */
    const noRedirects = createOutboundHttp({
      allowedPrivateHosts: ["127.0.0.1"],
      maxRedirects: 0,
      timeoutMs: 5_000,
    });
    try {
      fake.valuesStatus = 302;
      const result = await adapter({ fetch: noRedirects }).read(
        credential(),
        SPREADSHEET_ID,
        RANGE,
      );
      expect(result).toMatchObject({ ok: false, reason: "transport" });
      expect(fake.redirectCalls).toBe(0);
    } finally {
      await noRedirects.close();
    }
  });

  it("never puts the access token or the private key in a log line or a detail", async () => {
    /*
     * Everything this adapter says out loud, across a success and every kind of refusal. The
     * token endpoint's error bodies echo the assertion back, so "only the status is logged" is
     * a rule that has to be pinned rather than trusted.
     */
    const said: string[] = [];
    const log = (event: string, fields?: Readonly<Record<string, unknown>>) => {
      said.push(`${event} ${JSON.stringify(fields ?? {})}`);
    };
    const sheets = adapter({ log });

    await sheets.read(credential(), SPREADSHEET_ID, RANGE);
    const assertion = fake.lastAssertion;
    fake.valuesStatus = 500;
    said.push(JSON.stringify(await sheets.read(credential(), SPREADSHEET_ID, RANGE)));
    fake.valuesStatus = 200;
    fake.tokenStatus = 400;
    fake.tokenBody = JSON.stringify({ error: "invalid_grant", assertion });
    clock = new Date(clock.getTime() + 3_600_000);
    said.push(JSON.stringify(await sheets.read(credential(), SPREADSHEET_ID, RANGE)));
    said.push(JSON.stringify(await sheets.read(credential(), SPREADSHEET_ID, "..")));

    const transcript = said.join("\n");
    expect(transcript).not.toContain("ya29.token");
    expect(transcript).not.toContain("PRIVATE KEY");
    expect(transcript).not.toContain(privateKeyPem.slice(40, 80));
    expect(transcript).not.toContain(assertion.slice(0, 40));
    // It is not silent, either: a refusal that says nothing is its own kind of defect.
    expect(said.some((line) => line.includes("values_rejected"))).toBe(true);
  });

  describe("failure mapping", () => {
    it("maps a 401 at the token endpoint to unauthorized, naming the token endpoint", async () => {
      fake.tokenStatus = 401;
      fake.tokenBody = JSON.stringify({ error: "invalid_client" });
      const result = await adapter().read(credential(), SPREADSHEET_ID, RANGE);
      expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
      const detail = (result as { detail: string }).detail;
      expect(detail).toContain("token endpoint");
      expect(detail).not.toContain("share the spreadsheet");
      expect(fake.valuesCalls).toBe(0);
    });

    it("maps a 403 at the values endpoint to unauthorized, telling the admin to share the sheet", async () => {
      fake.valuesStatus = 403;
      fake.valuesBody = JSON.stringify({ error: { status: "PERMISSION_DENIED" } });
      const result = await adapter().read(credential(), SPREADSHEET_ID, RANGE);
      expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
      const detail = (result as { detail: string }).detail;
      expect(detail).toContain("share the spreadsheet");
      expect(detail).toContain("kpi-sync@acme-123.iam.gserviceaccount.com");
      expect(detail).not.toContain("token endpoint");
    });

    it("maps a 401 at the values endpoint to unauthorized", async () => {
      fake.valuesStatus = 401;
      const result = await adapter().read(credential(), SPREADSHEET_ID, RANGE);
      expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
    });

    it("maps 404 to not_found", async () => {
      fake.valuesStatus = 404;
      await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toMatchObject({
        ok: false,
        reason: "not_found",
      });
    });

    it("maps 429 and 503 to rate_limited on both endpoints", async () => {
      fake.valuesStatus = 429;
      await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toMatchObject({
        ok: false,
        reason: "rate_limited",
      });
      reset();
      fake.valuesStatus = 503;
      await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toMatchObject({
        ok: false,
        reason: "rate_limited",
      });
      reset();
      fake.tokenStatus = 429;
      await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toMatchObject({
        ok: false,
        reason: "rate_limited",
      });
    });

    it("maps a 400 from the values endpoint to malformed (google could not parse the range)", async () => {
      fake.valuesStatus = 400;
      await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toMatchObject({
        ok: false,
        reason: "malformed",
      });
    });

    it("maps a 500 to transport", async () => {
      fake.valuesStatus = 500;
      await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toMatchObject({
        ok: false,
        reason: "transport",
      });
      reset();
      fake.tokenStatus = 500;
      await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toMatchObject({
        ok: false,
        reason: "transport",
      });
    });

    it("maps an unreachable endpoint to transport and never throws", async () => {
      const sheets = createGoogleSheetsAdapter({
        fetch: http.fetch,
        // Nothing listens here; the guard raises a connection error, not an HTTP status.
        tokenEndpoint: "http://127.0.0.1:1/token",
        apiBaseUrl: origin,
        now: () => clock,
      });
      await expect(sheets.read(credential(), SPREADSHEET_ID, RANGE)).resolves.toMatchObject({
        ok: false,
        reason: "transport",
      });
    });

    it("maps unparseable JSON to malformed on both endpoints", async () => {
      fake.valuesBody = "<!doctype html><html>nope</html>";
      await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toMatchObject({
        ok: false,
        reason: "malformed",
      });
      reset();
      fake.tokenBody = "not json at all";
      await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toMatchObject({
        ok: false,
        reason: "malformed",
      });
    });

    it("reads an EMPTY range as a success with zero rows, not a failure", async () => {
      // Google omits `values` when the rectangle is empty. That is a founder's sheet on the day
      // they connect it; calling it malformed would park a brand-new connection in a failure
      // state and climb `consecutive_failures` nightly over a fault that does not exist.
      fake.valuesBody = JSON.stringify({ range: "KPIs!A1:D100", majorDimension: "ROWS" });
      await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toEqual({
        ok: true,
        range: { rows: [] },
      });
    });

    it("still maps a body carrying neither `range` nor `values` to malformed", async () => {
      for (const body of [
        JSON.stringify({ majorDimension: "ROWS" }),
        JSON.stringify({}),
        JSON.stringify({ error: { status: "INTERNAL" } }),
        JSON.stringify({ range: 7 }),
      ]) {
        fake.valuesBody = body;
        await expect(
          adapter().read(credential(), SPREADSHEET_ID, RANGE),
          body,
        ).resolves.toMatchObject({ ok: false, reason: "malformed" });
      }
    });

    it("maps a token response without an access token to malformed", async () => {
      fake.tokenBody = JSON.stringify({ expires_in: 3600 });
      await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toMatchObject({
        ok: false,
        reason: "malformed",
      });
    });

    it("maps a non-scalar cell to malformed", async () => {
      fake.valuesBody = JSON.stringify({ values: [[{ nested: true }]] });
      await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toMatchObject({
        ok: false,
        reason: "malformed",
      });
    });

    it("coerces numbers and booleans a sheet renders as scalars", async () => {
      fake.valuesBody = JSON.stringify({ values: [["a", 1, true, null]] });
      await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toEqual({
        ok: true,
        range: { rows: [["a", "1", "true", ""]] },
      });
    });
  });

  it("turns the JSON numbers UNFORMATTED_VALUE returns into plain decimal strings", async () => {
    /*
     * Unformatted, a numeric cell arrives as a JSON *number*, and the metrics module's rule
     * is that a value travels as a decimal string through `parseFixed` and nowhere else. The
     * ends of the range are the part that bites: `String(1e21)` is "1e+21", which
     * `parseFixed` refuses on purpose, so the coercion expands the exponent here instead of
     * handing on a spelling that would be dropped without a word.
     */
    fake.valuesBody = JSON.stringify({
      range: "KPIs!A1:D100",
      values: [
        ["2026-01", 12400, 1200.5, 0.125],
        [1e21, 1.5e-7, -2.5e-7, 0],
      ],
    });
    await expect(adapter().read(credential(), SPREADSHEET_ID, RANGE)).resolves.toEqual({
      ok: true,
      range: {
        rows: [
          ["2026-01", "12400", "1200.5", "0.125"],
          ["1000000000000000000000", "0.00000015", "-0.00000025", "0"],
        ],
      },
    });
  });

  describe("size caps", () => {
    it("maps the guard's response_too_large to too_large", async () => {
      const tiny = createOutboundHttp({
        allowedPrivateHosts: ["127.0.0.1"],
        maxResponseBytes: 256,
        timeoutMs: 5_000,
      });
      try {
        fake.valuesBody = JSON.stringify({ values: [Array.from({ length: 200 }, () => "cell")] });
        const sheets = adapter({ fetch: tiny });
        await expect(sheets.read(credential(), SPREADSHEET_ID, RANGE)).resolves.toMatchObject({
          ok: false,
          reason: "too_large",
        });
      } finally {
        await tiny.close();
      }
    });

    it("refuses a body over the adapter's own cap", async () => {
      fake.valuesBody = JSON.stringify({ values: [Array.from({ length: 200 }, () => "cell")] });
      await expect(
        adapter({ maxResponseBytes: 64 }).read(credential(), SPREADSHEET_ID, RANGE),
      ).resolves.toMatchObject({ ok: false, reason: "too_large" });
    });
  });

  describe("input validation", () => {
    it("refuses a spreadsheet id that is not in google's alphabet, without any HTTP call", async () => {
      for (const id of [
        "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit",
        "../../v4/spreadsheets/other",
        "short",
        `${SPREADSHEET_ID}/values/A1`,
        "",
      ]) {
        const result = await adapter().read(credential(), id, RANGE);
        expect(result, id).toMatchObject({ ok: false, reason: "malformed" });
      }
      expect(fake.tokenCalls).toBe(0);
      expect(fake.valuesCalls).toBe(0);
    });

    it("refuses a range that is not A1 notation, without any HTTP call", async () => {
      for (const range of ["", "A1:D100?alt=media", "Sheet1!DROP TABLE", "a".repeat(201), "!"]) {
        const result = await adapter().read(credential(), SPREADSHEET_ID, range);
        expect(result, JSON.stringify(range)).toMatchObject({ ok: false, reason: "malformed" });
      }
      expect(fake.tokenCalls).toBe(0);
      expect(fake.valuesCalls).toBe(0);
    });

    it("accepts the A1 spellings an admin actually types", () => {
      for (const range of [
        "A1:D100",
        "A:D",
        "1:100",
        "KPIs!A1:D100",
        "KPIs",
        "'My Sheet'!A1:D100",
        "'My Sheet'",
        "Sheet 1!A1",
      ]) {
        expect(isValidRange(range), range).toBe(true);
      }
      for (const range of ["'My Sheet'!", "Sheet1!A1:D100!B2", "KPIs!../x"]) {
        expect(isValidRange(range), range).toBe(false);
      }
      expect(isValidSpreadsheetId(SPREADSHEET_ID)).toBe(true);
      expect(isValidSpreadsheetId("nope")).toBe(false);
    });

    it("refuses a sheet name made of nothing, which the comment always claimed it did", () => {
      /*
       * `SHEET_NAME_RE` admitted `..`, and `new URL` normalises `/values/..` clean away — so
       * the bearer token went to `spreadsheets.get` instead of `values.get`, which is exactly
       * the "addresses a different API method entirely" the file's own comment says is
       * refused. It was not refused. The blast radius was a `malformed` answer rather than a
       * leak, but an invariant a comment asserts and the code does not hold is the defect
       * class this codebase cares most about.
       */
      for (const range of [
        "..",
        ".",
        "  ",
        " ",
        "-",
        ". . . .",
        "...!A1",
        "'..'",
        "'  '",
        "..!A1:B2",
      ]) {
        expect(isValidRange(range), JSON.stringify(range)).toBe(false);
      }
      // Still legal, and the reason the alphabet has dots and dashes in it at all.
      for (const range of ["Q1.2026", "KPIs-2026", "'Q1 2026 (final)'", "'売上'"]) {
        expect(isValidRange(range), range).toBe(true);
      }
    });

    it("never sends a request for a range that is not one, whatever the spelling", async () => {
      for (const range of ["..", "  ", "-", ". . . ."]) {
        const result = await adapter().read(credential(), SPREADSHEET_ID, range);
        expect(result, JSON.stringify(range)).toMatchObject({ ok: false, reason: "malformed" });
      }
      expect(fake.tokenCalls).toBe(0);
      expect(fake.valuesCalls).toBe(0);
    });

    it("refuses a private key that is not a readable PEM, without any HTTP call", async () => {
      const result = await adapter().read(
        {
          clientEmail: "kpi-sync@acme-123.iam.gserviceaccount.com",
          privateKeyPem: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----",
        },
        SPREADSHEET_ID,
        RANGE,
      );
      expect(result).toMatchObject({ ok: false, reason: "malformed" });
      expect(fake.tokenCalls).toBe(0);
    });
  });

  it("passes a configuration health check and refuses a plaintext non-loopback endpoint", async () => {
    await expect(adapter().healthCheck()).resolves.toBeUndefined();
    await expect(
      createGoogleSheetsAdapter({
        fetch: http.fetch,
        tokenEndpoint: "http://oauth2.example.com/token",
      }).healthCheck(),
    ).rejects.toThrow(/https/u);
  });
});

describe("parseServiceAccountJson", () => {
  it("accepts a real service-account file and keeps only the two fields we use", () => {
    const parsed = parseServiceAccountJson(serviceAccountJson());
    expect(parsed).toEqual({
      ok: true,
      credential: {
        clientEmail: "kpi-sync@acme-123.iam.gserviceaccount.com",
        privateKeyPem,
      },
    });
  });

  it("rejects anything else with a typed failure and never throws", () => {
    const bad: readonly string[] = [
      "",
      "not json",
      "[]",
      '"a string"',
      JSON.stringify({ private_key: "x" }),
      JSON.stringify({ client_email: "not-an-email", private_key: "x" }),
      JSON.stringify({ client_email: "a@b.com" }),
      JSON.stringify({ client_email: "a@b.com", private_key: 42 }),
      JSON.stringify({
        client_email: "a@b.com",
        private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
      }),
    ];
    for (const raw of bad) {
      const result = parseServiceAccountJson(raw);
      expect(result, raw.slice(0, 40)).toMatchObject({ ok: false, reason: "malformed" });
    }
  });

  it("ignores a token_uri in the pasted file", () => {
    const parsed = parseServiceAccountJson(
      JSON.stringify({
        client_email: "kpi-sync@acme-123.iam.gserviceaccount.com",
        private_key: privateKeyPem,
        token_uri: "http://169.254.169.254/latest/meta-data",
      }),
    );
    expect(parsed).toMatchObject({ ok: true });
    expect(JSON.stringify(parsed)).not.toContain("169.254");
  });
});

describe("createNoopSpreadsheets", () => {
  it("answers not_found for every read and says why", async () => {
    const sheets = createNoopSpreadsheets();
    expect(sheets.driver).toBe("noop");
    const result = await sheets.read(credential(), SPREADSHEET_ID, RANGE);
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect((result as { detail: string }).detail).toContain("SPREADSHEET_DRIVER=noop");
    await expect(sheets.healthCheck()).resolves.toBeUndefined();
  });
});
