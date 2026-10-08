import type { HandoffKey } from "@fundroom/domain";
import { CompactSign, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createHandoffService,
  type HandoffVerdict,
  handoffWireReason,
  verifyHandoffAssertion,
} from "./handoff.js";

/*
 * E2.2 §6. Every happy path here is a real Ed25519 signature produced by `jose` — the same shape
 * as the fake OIDC IdP in `identity.integration.test.ts` — because a mocked verifier proves
 * nothing about a verifier whose whole job is to refuse forgeries. The hostile tokens are
 * hand-assembled from base64url segments, since the failures worth testing are exactly the ones
 * a well-behaved signing library will not produce for you.
 */

const SLUG = "acme";
const NOW = new Date("2026-09-13T12:00:00.000Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

interface Signer {
  readonly key: HandoffKey;
  readonly privateKey: PrivateKey;
  /** Raw public key bytes; only used to build the "alg confusion" token. */
  readonly publicKeyBytes: Uint8Array;
}

let host: Signer;
let stranger: Signer;

async function makeSigner(id: string): Promise<Signer> {
  const { privateKey, publicKey } = await generateKeyPair("Ed25519");
  const jwk = await exportJWK(publicKey);
  const x = jwk.x;
  if (typeof x !== "string") throw new Error("expected an OKP public key");
  return {
    key: { id, publicKey: x, label: "acme.example WordPress", addedAt: NOW.toISOString() },
    privateKey,
    publicKeyBytes: new Uint8Array(Buffer.from(x, "base64url")),
  };
}

function baseClaims(): Record<string, unknown> {
  return {
    iss: "https://acme.example",
    aud: SLUG,
    // Mixed case on purpose: the verdict must carry the canonical address.
    sub: "Investor@Acme.Example",
    jti: "handoff-0001",
    iat: NOW_S,
    exp: NOW_S + 60,
  };
}

async function sign(signer: Signer, claims: Record<string, unknown> = {}): Promise<string> {
  return await new SignJWT({ ...baseClaims(), ...claims })
    .setProtectedHeader({ alg: "EdDSA", kid: signer.key.id })
    .sign(signer.privateKey);
}

/** A token whose segments we control completely; the signature need not be real. */
function forge(
  header: Record<string, unknown>,
  claims: Record<string, unknown> = baseClaims(),
  signature = "AAAA",
): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
  return `${b64(header)}.${b64(claims)}.${signature}`;
}

async function verify(
  assertion: string,
  overrides: { keys?: readonly HandoffKey[]; workspaceSlug?: string; now?: Date } = {},
): Promise<HandoffVerdict> {
  return await verifyHandoffAssertion({
    assertion,
    workspaceSlug: overrides.workspaceSlug ?? SLUG,
    keys: overrides.keys ?? [host.key],
    now: overrides.now ?? NOW,
  });
}

beforeAll(async () => {
  host = await makeSigner("wp-2026-09");
  stranger = await makeSigner("wp-2026-09"); // same kid, different key material
});

describe("handoff assertion verification (E2.2 §6, design/08 §3 option B)", () => {
  it("accepts a genuinely signed assertion and returns the normalised claims", async () => {
    const verdict = await verify(await sign(host));
    expect(verdict).toEqual({
      ok: true,
      email: "investor@acme.example",
      issuer: "https://acme.example",
      jti: "handoff-0001",
      keyId: "wp-2026-09",
    });
  });

  it("exposes the same verification through createHandoffService()", async () => {
    const service = createHandoffService();
    const verdict = await service.verifyAssertion({
      assertion: await sign(host),
      workspaceSlug: SLUG,
      keys: [host.key],
      now: NOW,
    });
    expect(verdict.ok).toBe(true);
  });

  // --- serialisation: compact JWS only -------------------------------------------------------

  it("rejects a JWE as malformed", async () => {
    const jwe = ["e30", "", "AAAA", "BBBB", "CCCC"].join(".");
    expect(await verify(jwe)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a JSON-serialised JWS as malformed", async () => {
    const compact = await sign(host);
    const [protectedHeader, payload, signature] = compact.split(".");
    const json = JSON.stringify({ protected: protectedHeader, payload, signature });
    expect(await verify(json)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects an unsecured token (empty signature segment) as malformed", async () => {
    const unsecured = `${forge({ alg: "none" }).split(".").slice(0, 2).join(".")}.`;
    expect(await verify(unsecured)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects `alg: none` with a non-empty signature as malformed", async () => {
    expect(await verify(forge({ alg: "none", kid: "wp-2026-09" }))).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects an assertion longer than the parse budget as malformed", async () => {
    const long = `${"a".repeat(5000)}.${"b".repeat(10)}.${"c".repeat(10)}`;
    expect(await verify(long)).toEqual({ ok: false, reason: "malformed" });
  });

  // --- algorithm: EdDSA, chosen by us, never by the token ------------------------------------

  it("rejects an HS256 token signed with the registered public key as malformed, not bad_signature", async () => {
    // The classic algorithm-confusion forgery: the public key is public, so if `alg` could pick
    // the verification path an attacker would sign an HMAC with it and be believed.
    const forged = await new SignJWT(baseClaims())
      .setProtectedHeader({ alg: "HS256", kid: host.key.id })
      .sign(host.publicKeyBytes);
    expect(await verify(forged)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects any other alg as malformed", async () => {
    for (const alg of ["RS256", "ES256", "Ed448", "EDDSA", ""]) {
      expect(await verify(forge({ alg, kid: host.key.id }))).toEqual({
        ok: false,
        reason: "malformed",
      });
    }
  });

  it("rejects a header carrying its own key material (jwk/jku/x5u/x5c)", async () => {
    const headers = [
      { jwk: { kty: "OKP", crv: "Ed25519", x: stranger.key.publicKey } },
      { jku: "https://evil.example/jwks.json" },
      { x5u: "https://evil.example/cert.pem" },
      { x5c: ["AAAA"] },
    ];
    for (const extra of headers) {
      const verdict = await verify(forge({ alg: "EdDSA", kid: host.key.id, ...extra }));
      expect(verdict).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("rejects a crit header, since we implement no extensions", async () => {
    const forged = forge({ alg: "EdDSA", kid: host.key.id, crit: ["exp"], exp: NOW_S });
    expect(await verify(forged)).toEqual({ ok: false, reason: "malformed" });
  });

  // --- key selection: by kid, from the registered list ----------------------------------------

  it("rejects an absent kid as unknown_key", async () => {
    expect(await verify(forge({ alg: "EdDSA" }))).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("rejects a kid naming no registered key as unknown_key", async () => {
    const forged = await new SignJWT(baseClaims())
      .setProtectedHeader({ alg: "EdDSA", kid: "rotated-away" })
      .sign(host.privateKey);
    expect(await verify(forged)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("rejects every assertion when the workspace has registered no keys", async () => {
    expect(await verify(await sign(host), { keys: [] })).toEqual({
      ok: false,
      reason: "unknown_key",
    });
  });

  it("rejects a registered key whose material will not import as unknown_key", async () => {
    // `HandoffKeySchema` pins 43 base64url characters, but these keys arrive from the settings
    // jsonb, so the verifier does not assume the shape held: material of the wrong length never
    // imports, and the honest answer is "that key verifies nothing", not "the host signed badly".
    const broken: HandoffKey = { ...host.key, publicKey: "AAAAAAAAAAAAAAAAAAAAAA" };
    expect(await verify(await sign(host), { keys: [broken] })).toEqual({
      ok: false,
      reason: "unknown_key",
    });
    // Thirty-two bytes that are not the right public key *do* import — WebCrypto validates the
    // length, not the point — and fail at the signature, which is the same refusal by a
    // different name.
    const wrong: HandoffKey = { ...host.key, publicKey: "_".repeat(43) };
    expect(await verify(await sign(host), { keys: [wrong] })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("tries every key registered under one kid, in either order", async () => {
    // Rotation overlap: `HandoffKeySchema` does not make `id` unique and the settings PUT replaces
    // the whole list, so "add the new key, drop the old one tomorrow" legitimately puts two rows
    // under one `kid`. Stopping at the first match would reject every assertion signed by the
    // other one for the length of the overlap — the outage the overlap exists to prevent.
    const assertion = await sign(host);
    expect((await verify(assertion, { keys: [host.key, stranger.key] })).ok).toBe(true);
    expect((await verify(assertion, { keys: [stranger.key, host.key] })).ok).toBe(true);
    // Whichever row matched, the kid they share is what comes back.
    expect(await verify(assertion, { keys: [stranger.key, host.key] })).toMatchObject({
      ok: true,
      keyId: "wp-2026-09",
    });
  });

  it("still refuses an assertion no key under that kid verifies", async () => {
    const outsider = await makeSigner("wp-2026-09");
    expect(await verify(await sign(outsider), { keys: [host.key, stranger.key] })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("skips an unusable row and verifies against a good one under the same kid", async () => {
    const unusable: HandoffKey = { ...host.key, publicKey: "AAAAAAAAAAAAAAAAAAAAAA" };
    expect((await verify(await sign(host), { keys: [unusable, host.key] })).ok).toBe(true);
  });

  it("rejects an EdDSA signature made by an unregistered key as bad_signature", async () => {
    const forged = await new SignJWT(baseClaims())
      .setProtectedHeader({ alg: "EdDSA", kid: host.key.id })
      .sign(stranger.privateKey);
    expect(await verify(forged)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("rejects a tampered payload as bad_signature", async () => {
    const [header, , signature] = (await sign(host)).split(".");
    const swapped = Buffer.from(
      JSON.stringify({ ...baseClaims(), sub: "attacker@acme.example" }),
      "utf8",
    ).toString("base64url");
    expect(await verify(`${header}.${swapped}.${signature}`)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("collapses unknown_key and bad_signature on the wire, keeping both for the audit", async () => {
    // Apart, the pair is a `kid`-existence oracle on a public endpoint: a prober learns which key
    // ids a workspace has registered by watching which of the two comes back. The verifier keeps
    // the precise reason (the operator debugging a handoff needs it, and it belongs in
    // `embed.handoff_rejected`); the route must map it through `handoffWireReason` first.
    const unregistered = await verify(await sign(host), { keys: [] });
    const wrongKey = await verify(await sign(stranger), { keys: [host.key] });
    expect(unregistered).toEqual({ ok: false, reason: "unknown_key" });
    expect(wrongKey).toEqual({ ok: false, reason: "bad_signature" });
    expect(handoffWireReason("unknown_key")).toBe("invalid_assertion");
    expect(handoffWireReason("bad_signature")).toBe("invalid_assertion");
    // Everything else describes the token the caller already holds, so it survives intact.
    for (const reason of [
      "malformed",
      "expired",
      "not_yet",
      "audience",
      "lifetime",
      "claims",
    ] as const) {
      expect(handoffWireReason(reason)).toBe(reason);
    }
  });

  it("leaks nothing about the key beyond the reason on a failed verdict", async () => {
    const verdict = await verify(await sign(stranger));
    expect(Object.keys(verdict).sort()).toEqual(["ok", "reason"]);
  });

  // --- audience ------------------------------------------------------------------------------

  it("rejects an assertion minted for another workspace", async () => {
    expect(await verify(await sign(host, { aud: "beta" }))).toEqual({
      ok: false,
      reason: "audience",
    });
  });

  it("accepts `aud` as a single-element array", async () => {
    expect((await verify(await sign(host, { aud: [SLUG] }))).ok).toBe(true);
  });

  it("rejects a multi-audience assertion", async () => {
    expect(await verify(await sign(host, { aud: [SLUG, "beta"] }))).toEqual({
      ok: false,
      reason: "audience",
    });
  });

  it("rejects a missing or non-string `aud`", async () => {
    for (const aud of [undefined, 42, { slug: SLUG }]) {
      expect(await verify(await sign(host, { aud }))).toEqual({ ok: false, reason: "audience" });
    }
  });

  // --- window: exp, iat, nbf -----------------------------------------------------------------

  it("rejects an expired assertion", async () => {
    const assertion = await sign(host, { iat: NOW_S - 120, exp: NOW_S - 60 });
    expect(await verify(assertion)).toEqual({ ok: false, reason: "expired" });
  });

  it("treats an `exp` exactly on the clock as expired", async () => {
    const assertion = await sign(host, { iat: NOW_S - 30, exp: NOW_S });
    expect(await verify(assertion)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects an `iat` beyond the skew allowance as not_yet", async () => {
    const iat = NOW_S + 6;
    expect(await verify(await sign(host, { iat, exp: iat + 60 }))).toEqual({
      ok: false,
      reason: "not_yet",
    });
  });

  it("tolerates a fast host clock minting the documented 60-second window", async () => {
    // The interop case that decided the bound. An honest host whose clock is inside the skew
    // allowance, minting exactly the `exp = iat + 60` the plugin docs specify, must be accepted —
    // rejecting it would fail *every* handoff from a site that is a second or two fast, and fail
    // it as `lifetime`, which reads as "your token is malformed" rather than "our clocks differ
    // by less than our own tolerance".
    for (const skew of [1, 3, 5]) {
      const iat = NOW_S + skew;
      expect((await verify(await sign(host, { iat, exp: iat + 60 }))).ok).toBe(true);
    }
  });

  it("cannot be held open longer than the lifetime plus the skew allowance", async () => {
    // `iat <= now + 5` and `exp <= iat + 60` compose, so `now + 65` is the ceiling and there is
    // no separate check enforcing it. This pins the arithmetic: one second past the allowance is
    // refused by the `iat` bound, which is the branch that actually names the problem.
    expect(await verify(await sign(host, { iat: NOW_S + 6, exp: NOW_S + 66 }))).toEqual({
      ok: false,
      reason: "not_yet",
    });
  });

  it("refuses a forward-stamped assertion that would be good for two minutes", async () => {
    // The regression: `iat = now + 60, exp = now + 120` satisfies `exp - iat <= 60` and was
    // accepted, giving a skewed or lying host a 120-second window.
    const verdict = await verify(await sign(host, { iat: NOW_S + 60, exp: NOW_S + 120 }));
    expect(verdict.ok).toBe(false);
    expect(verdict).toEqual({ ok: false, reason: "not_yet" });
  });

  it("honours a future `nbf` as not_yet", async () => {
    const assertion = await sign(host, { iat: NOW_S, exp: NOW_S + 60, nbf: NOW_S + 300 });
    expect(await verify(assertion)).toEqual({ ok: false, reason: "not_yet" });
  });

  it("rejects a window longer than 60 s as lifetime", async () => {
    const assertion = await sign(host, { iat: NOW_S - 10, exp: NOW_S + 51 });
    expect(await verify(assertion)).toEqual({ ok: false, reason: "lifetime" });
  });

  it("accepts a window of exactly 60 s", async () => {
    expect((await verify(await sign(host, { iat: NOW_S, exp: NOW_S + 60 }))).ok).toBe(true);
  });

  it("rejects an `exp` at or before `iat` as lifetime", async () => {
    // An inverted window is the same mistake as an over-long one seen from the other side, and it
    // is reported ahead of `expired` because the window, not the clock, is what is wrong.
    for (const claims of [
      { iat: NOW_S, exp: NOW_S },
      { iat: NOW_S, exp: NOW_S - 1 },
    ]) {
      expect(await verify(await sign(host, claims))).toEqual({ ok: false, reason: "lifetime" });
    }
  });

  it("rejects a missing or non-numeric exp/iat as claims", async () => {
    const broken: Array<Record<string, unknown>> = [
      { exp: undefined },
      { iat: undefined },
      { exp: `${NOW_S + 60}` },
      { iat: 1.5 },
      { exp: Number.MAX_SAFE_INTEGER + 2 },
      { iat: -1 },
      { nbf: "soon" },
    ];
    for (const claims of broken) {
      expect(await verify(await sign(host, claims))).toEqual({ ok: false, reason: "claims" });
    }
  });

  // --- subject, issuer, jti ------------------------------------------------------------------

  it("rejects a subject that is not a syntactically valid email", async () => {
    for (const sub of [undefined, "", "not-an-email", "no@tld", "two @spaces.example", 42]) {
      expect(await verify(await sign(host, { sub }))).toEqual({ ok: false, reason: "claims" });
    }
  });

  it("rejects a jti outside ^[A-Za-z0-9_.-]{8,200}$", async () => {
    // The caller builds `auth.handoff:<ws>:<jti>` from this (E2.2 decision 7), so a colon, a
    // newline or an over-long value must die here rather than inside the transaction.
    const hostile = [
      undefined,
      "",
      "short7",
      "has:colon:in:it",
      "has space",
      "has\nnewline",
      "a".repeat(201),
      42,
    ];
    for (const jti of hostile) {
      expect(await verify(await sign(host, { jti }))).toEqual({ ok: false, reason: "claims" });
    }
  });

  it("accepts a jti at both ends of the allowed length", async () => {
    for (const jti of ["a".repeat(8), "a".repeat(200)]) {
      expect((await verify(await sign(host, { jti }))).ok).toBe(true);
    }
  });

  it("rejects an issuer that is not a bare https origin", async () => {
    const hostile = [
      undefined,
      "",
      "acme.example",
      "http://acme.example",
      "https://acme.example/wp-json",
      "https://acme.example/?a=1",
      "https://acme.example/#f",
      "https://user:pw@acme.example",
      "javascript:alert(1)",
      42,
      // `*` is a legal URL host character and survives into `origin`, so a wildcard used to land
      // in the `embed.handoff_accepted` audit record looking like an origin somebody could act on.
      "https://*.acme.example",
      "https://*",
      "https://acme.*.example",
      "https://_dmarc.acme.example",
      "https://-acme.example",
      "https://acme..example",
    ];
    for (const iss of hostile) {
      expect(await verify(await sign(host, { iss }))).toEqual({ ok: false, reason: "claims" });
    }
  });

  it("normalises the issuer to a lower-case origin", async () => {
    const verdict = await verify(await sign(host, { iss: "https://Acme.Example:443/" }));
    expect(verdict).toMatchObject({ ok: true, issuer: "https://acme.example" });
  });

  // --- hostile input: a verdict, never an exception -------------------------------------------

  it("never throws, whatever is posted at it", async () => {
    const nestedJws = await sign(host);
    const hostile: unknown[] = [
      "",
      ".",
      "..",
      "a.b.c",
      "a.b.c.d.e",
      "{}",
      "null",
      `${"a".repeat(100_000)}.b.c`,
      "aaaa. bbbb.cccc",
      "aaaa.bb\u0000bb.cccc",
      "aaaa.bbbb.cccc\u0000",
      "aaaa.YmJiYg==.cccc", // padded base64, not base64url
      // A JWS whose payload is another JWS: signed by nobody we know, and the inner token must
      // never be unwrapped and believed.
      `${Buffer.from(JSON.stringify({ alg: "EdDSA", kid: host.key.id }), "utf8").toString("base64url")}.${Buffer.from(nestedJws, "utf8").toString("base64url")}.AAAA`,
      nestedJws.replace(".", "~"),
      `${nestedJws}.`,
      undefined,
      null,
      42,
      { assertion: nestedJws },
      [nestedJws],
    ];
    for (const assertion of hostile) {
      const verdict = await verifyHandoffAssertion({
        assertion: assertion as string,
        workspaceSlug: SLUG,
        keys: [host.key],
        now: NOW,
      });
      expect(verdict.ok).toBe(false);
    }
  });

  it("rejects a validly signed payload that is not a JSON object as malformed", async () => {
    // Genuinely signed by a registered key, so this exercises the claim-set shape check rather
    // than the signature check: a JWS payload need not be a JWT, and ours must be.
    for (const payload of ["[]", '"a string"', "null", "42", "not json at all", ""]) {
      const assertion = await new CompactSign(new TextEncoder().encode(payload))
        .setProtectedHeader({ alg: "EdDSA", kid: host.key.id })
        .sign(host.privateKey);
      expect(await verify(assertion)).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("rejects a signed payload that is not valid UTF-8 as malformed", async () => {
    const assertion = await new CompactSign(new Uint8Array([0xff, 0xfe, 0x7b, 0x7d]))
      .setProtectedHeader({ alg: "EdDSA", kid: host.key.id })
      .sign(host.privateKey);
    expect(await verify(assertion)).toEqual({ ok: false, reason: "malformed" });
  });
});
