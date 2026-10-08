import { type HandoffKey, MAX_HANDOFF_KEYS } from "@fundroom/domain";
import { compactVerify, decodeProtectedHeader, importJWK } from "jose";
import { normalizeEmail } from "../repos/user-repo.js";

/*
 * Host-asserted identity handoff: verification only (E2.2 §6, design/08 §3 option B,
 * design/05 §2.4). A host that already knows who its visitor is (a WordPress membership site, a
 * Next.js app) mints a short-lived assertion on its *server* and the loader posts it over the
 * bridge; this module decides whether to believe it. Nothing here mints a session, reads the
 * database or claims the `jti` — the route does that, so this stays a pure function of
 * (assertion, slug, registered keys, clock) and can be tested exhaustively without a container.
 *
 * Four properties are the whole point:
 *
 * 1. **EdDSA only, and the token never chooses the algorithm** (E2.2 decision 6). We store the
 *    *public* half of a host-generated Ed25519 key, so there is no secret of ours at rest and a
 *    compromise of the settings jsonb cannot mint an assertion. `alg` arrives from the attacker,
 *    so it is only ever *checked*; the key is selected by `kid` from the registered list and
 *    verified with that key's algorithm. Letting `alg` pick the verification path is how JWT
 *    verifiers get broken (RS256 token verified as HS256 against the public key).
 * 2. **The claim set is checked after the signature, never before.** An unverified payload is
 *    attacker-authored JSON; reading it first is how a rejection reason becomes an oracle.
 * 3. **A 60-second, single-use window, measured on our clock.** `exp - iat <= 60` bounds what the
 *    host says it minted and `exp - now <= 60` bounds how long we will hold it open, because only
 *    the second one survives a host whose clock runs fast. Single use is the caller's
 *    `claimIdempotencyKey(tx, ctx, "auth.handoff:<ws>:<jti>")` (E2.2 decision 7), which is why
 *    `jti` is validated against that key's own format *here* rather than throwing two layers down.
 * 4. **A rejection says why, and nothing else.** The reason is coarse and enumerated; the `kid`
 *    that matched is returned only on success. Two of the reasons are for the audit log only —
 *    see `handoffWireReason`, which the route must apply before the reason reaches a caller.
 *
 * Trust semantics (design/05 §2.4): a host assertion is assurance level 1 in that document's
 * numbering and `AUTH_LEVEL.host = 0` in ours. It proves who the *host* says this is, never what
 * they may see — the email must still match an existing membership (`checkEligibility`), the
 * workspace must have turned `trustHostIdentity` on, and the data room's step-up still asks.
 */

/** What the route needs from a believed assertion. `keyId` is for the audit event. */
export interface HandoffAssertion {
  /** `sub`, normalised the way every other login path normalises an email. */
  readonly email: string;
  /** `iss`, normalised to an https origin. Audit only; it grants nothing. */
  readonly issuer: string;
  /** Single-use id; the caller turns it into an idempotency key. */
  readonly jti: string;
  /** `kid` of the registered key that verified the signature. */
  readonly keyId: string;
}

/**
 * Why an assertion was refused. Coarse on purpose: enough for an operator reading
 * `embed.handoff_rejected` to tell a misconfigured plugin from an attack, never enough to steer
 * a forgery. `malformed` covers everything that is not the token shape we accept at all.
 */
export type HandoffRejection =
  | "malformed"
  | "unknown_key"
  | "bad_signature"
  | "expired"
  | "not_yet"
  | "audience"
  | "lifetime"
  | "claims";

export type HandoffVerdict =
  | ({ readonly ok: true } & HandoffAssertion)
  | { readonly ok: false; readonly reason: HandoffRejection };

export interface VerifyHandoffInput {
  /** The compact JWS as posted over the bridge. Untrusted, unbounded, attacker-authored. */
  readonly assertion: string;
  /** The workspace the embed document belongs to; `aud` must equal it exactly. */
  readonly workspaceSlug: string;
  /** `settings.embed.handoffKeys`. An empty list means the workspace registered none. */
  readonly keys: readonly HandoffKey[];
  readonly now: Date;
}

/** The only signature algorithm this protocol has (E2.2 decision 6; no HS256, ever). */
const HANDOFF_ALG = "EdDSA";

/**
 * Longest assertion we will look at. One of these is ~300 characters; 4 KiB is room for a name
 * claim and then some. `POST /api/v1/embed/handoff` is public (E2.2 §5), so the first thing the
 * verifier does is bound the work an anonymous caller can buy — before any parse, decode or
 * regex runs over the input.
 */
const MAX_ASSERTION_LENGTH = 4096;

/**
 * Widest acceptance window, in seconds (design/05 §2.4 "exp=+60s", E2.2 §6, ADR-0040 decision 7).
 *
 * Enforced twice, against two different clocks, because one check alone is not the promise:
 * `exp - iat <= 60` bounds what the *host* says it minted, and `exp - now <= 60` bounds how long
 * *we* will hold it open. Only the second survives a host whose clock is ahead or which simply
 * lies — with `iat` alone, a token stamped `iat = now + 60, exp = now + 120` satisfies a 60-second
 * lifetime and is nonetheless accepted for two minutes.
 */
const MAX_LIFETIME_SECONDS = 60;

/**
 * How far ahead of us an `iat`/`nbf` may sit before we call it a clock problem.
 *
 * Small on purpose, and it forgives a skewed clock without ever *extending* the window: the
 * `exp - now` bound above still caps acceptance at 60 seconds, so a host that is ahead of us buys
 * nothing by it. Its real job is the diagnostic — a host 30 seconds fast is told `not_yet`, which
 * names the fault, rather than `lifetime`, which points at the wrong thing. ADR-0040 decision 7
 * says "an `iat` not in the future"; this is that, plus the couple of seconds any two servers
 * disagree by.
 */
const MAX_CLOCK_SKEW_SECONDS = 5;

/**
 * `jti` format. Matches the shape `claimIdempotencyKey` accepts, because the caller builds
 * `auth.handoff:<ws>:<jti>` from it (E2.2 decision 7): a hostile `jti` must be a rejection here,
 * not an exception thrown on a key-format regex inside the transaction.
 */
const JTI_RE = /^[A-Za-z0-9_.-]{8,200}$/u;

/**
 * Compact serialisation, three non-empty base64url segments.
 *
 * This single test is what rejects a JWE (five segments), a JSON-serialised JWS (an object, so it
 * starts with `{`), an unsecured token (`alg: none` leaves the signature segment empty) and any
 * input carrying whitespace, a NUL or non-ASCII — all before `jose` sees a byte of it. Three
 * fixed groups separated by a character the groups cannot match: no ambiguity, so no backtracking
 * on a long hostile input.
 */
const COMPACT_JWS_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;

/**
 * A real DNS host, for `iss`.
 *
 * `URL` is far more permissive than DNS: `https://*.acme.com` parses, and `*` survives into
 * `origin`. That string then lands in `embed.handoff_accepted` looking like an origin somebody
 * could act on, so the host is checked against the label grammar rather than trusted because it
 * parsed. Same shape as `HOST_LABEL` in `packages/domain/src/embed/embed-origins.ts`.
 */
const ISS_HOST_RE =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;

function reject(reason: HandoffRejection): HandoffVerdict {
  return { ok: false, reason };
}

/** A registered key as a verification key, or `undefined` if the stored bytes are not one. */
async function importVerificationKey(publicKey: string): Promise<CryptoKey | undefined> {
  try {
    return await importJWK({ kty: "OKP", crv: "Ed25519", x: publicKey }, HANDOFF_ALG);
  } catch {
    return undefined;
  }
}

/** A JWT NumericDate: seconds since the epoch, integral and in a range a clock can produce. */
function numericDate(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value;
}

/**
 * `iss` as a bare https origin, or `undefined`.
 *
 * Deliberately stricter than `normalizeEmbedOrigin`: that one admits loopback `http://` because a
 * browser treats it as a secure context, but `iss` names the *server* that signed this, which has
 * no such excuse. A path, query or fragment is refused rather than trimmed — an issuer we
 * repaired is an issuer that does not match what the host thinks it sent, and this value ends up
 * in an audit record people read.
 */
function httpsOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 255) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  if (url.search !== "" || url.hash !== "") return undefined;
  if (url.pathname !== "/" && url.pathname !== "") return undefined;
  if (!ISS_HOST_RE.test(url.hostname.toLowerCase())) return undefined;
  return url.origin.toLowerCase();
}

/**
 * Verifies one host-minted handoff assertion. Never throws: every hostile input resolves to an
 * `ok: false` verdict, because the caller is a public route and an exception there is a 500 with
 * a stack trace instead of an audited rejection.
 */
export async function verifyHandoffAssertion(input: VerifyHandoffInput): Promise<HandoffVerdict> {
  const { assertion, keys, workspaceSlug } = input;
  // The type says `string`; the network does not. Guarded before `.length` so a non-string from
  // an unvalidated caller is a verdict rather than a TypeError.
  if (typeof assertion !== "string" || assertion.length > MAX_ASSERTION_LENGTH)
    return reject("malformed");
  if (!COMPACT_JWS_RE.test(assertion)) return reject("malformed");

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(assertion);
  } catch {
    return reject("malformed");
  }
  // `alg` is checked, never consulted. Anything but EdDSA is not a token of this protocol at all,
  // so it is `malformed` — reporting `bad_signature` would imply we tried, which we must not.
  if (header.alg !== HANDOFF_ALG) return reject("malformed");
  // A key travelling inside the token is a key nobody registered. We never fetch or trust one.
  if (header.jwk !== undefined) return reject("malformed");
  if (header.jku !== undefined || header.x5u !== undefined || header.x5c !== undefined)
    return reject("malformed");
  // We implement no extensions, so any `crit` header names one we cannot honour (RFC 7515 §4.1.11
  // requires rejection rather than the silent ignore that makes `crit` worth setting).
  if (header.crit !== undefined) return reject("malformed");

  /*
   * Every key registered under this `kid`, not the first one.
   *
   * `HandoffKeySchema` does not make `id` unique and the settings PUT replaces the whole list, so
   * the ordinary rotation shape — add the new key, drop the old one a day later — can legitimately
   * put two rows under one `kid`. Stopping at the first match would then reject every assertion
   * signed by the other one, for as long as the overlap lasts, which is exactly the outage the
   * overlap exists to prevent. Trying each is bounded work: `MAX_HANDOFF_KEYS` caps the list at
   * four, and the slice repeats that cap here so this stays bounded even if it is ever handed a
   * list nothing validated.
   */
  const candidates =
    typeof header.kid === "string"
      ? keys.filter((k) => k.id === header.kid).slice(0, MAX_HANDOFF_KEYS)
      : [];
  // An absent `kid` and one naming nothing are the same answer: neither selects a key.
  if (candidates.length === 0) return reject("unknown_key");

  let payloadBytes: Uint8Array | undefined;
  let keyId: string | undefined;
  // Tracks whether any candidate was usable at all. The schema guarantees 43 base64url characters,
  // not that they decode to a key WebCrypto will take; a `kid` whose every row is unusable
  // verifies nothing, and "re-register the key" is a different fix from "re-sign the assertion".
  let anyImported = false;
  for (const candidate of candidates) {
    const key = await importVerificationKey(candidate.publicKey);
    if (!key) continue;
    anyImported = true;
    try {
      const verified = await compactVerify(assertion, key, { algorithms: [HANDOFF_ALG] });
      payloadBytes = verified.payload;
      keyId = candidate.id;
      break;
    } catch {
      // Try the next row under this `kid`. Which one matched is not observable: they all share the
      // `kid`, so the `keyId` returned on success is the same string either way.
    }
  }
  if (payloadBytes === undefined || keyId === undefined) {
    /*
     * `unknown_key` and `bad_signature` are both true things an operator needs in
     * `embed.handoff_rejected` — "you have not registered that key" and "you registered it and the
     * signature is wrong" are different support tickets. They must not both reach the *caller*,
     * though: the pair is a `kid`-existence oracle, letting an unauthenticated prober enumerate
     * which key ids a workspace has registered. The route collapses them with
     * `handoffWireReason()` below; the precise reason stays on this side of the wire.
     *
     * The comparison that must be constant-time is the Ed25519 check itself, which is Node's.
     * `kid`, the public key and every claim are public values, so there is nothing else here worth
     * comparing in constant time.
     */
    return reject(anyImported ? "bad_signature" : "unknown_key");
  }

  let claims: Record<string, unknown>;
  try {
    // `fatal` so invalid UTF-8 in a signed payload is a rejection rather than U+FFFD soup.
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes);
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return reject("malformed");
    claims = parsed as Record<string, unknown>;
  } catch {
    return reject("malformed");
  }

  // `aud` binds the assertion to one workspace. A single-element array is how most JWT libraries
  // spell one audience and is accepted; two audiences is a token minted for somewhere else as
  // well, which is not a token for us.
  const rawAud = claims["aud"];
  const audience =
    typeof rawAud === "string"
      ? rawAud
      : Array.isArray(rawAud) && rawAud.length === 1 && typeof rawAud[0] === "string"
        ? rawAud[0]
        : undefined;
  if (audience === undefined || audience !== workspaceSlug) return reject("audience");

  const exp = numericDate(claims["exp"]);
  const iat = numericDate(claims["iat"]);
  // Absent or unparseable is `claims`, not `expired`: a token with no `exp` never expires, which
  // is a malformed claim set rather than a stale one.
  if (exp === undefined || iat === undefined) return reject("claims");

  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const nbf = claims["nbf"] === undefined ? undefined : numericDate(claims["nbf"]);
  if (claims["nbf"] !== undefined && nbf === undefined) return reject("claims");
  // A future `iat` (or `nbf`, honoured if the host set one) is reported before the window and the
  // expiry because a wrong host clock produces all three symptoms and only this one names it.
  if (iat > nowSeconds + MAX_CLOCK_SKEW_SECONDS) return reject("not_yet");
  if (nbf !== undefined && nbf > nowSeconds + MAX_CLOCK_SKEW_SECONDS) return reject("not_yet");
  // `exp <= iat` is the same mistake as an over-long window seen from the other side.
  if (exp <= iat || exp - iat > MAX_LIFETIME_SECONDS) return reject("lifetime");
  // There is deliberately no second bound of `exp` against our own clock, because the two checks
  // above already are one: `iat <= now + MAX_CLOCK_SKEW_SECONDS` and `exp <= iat + 60` compose to
  // `exp <= now + 65`, so a host that stamps `iat` forward cannot buy a longer window — it can
  // only buy the skew we already said we tolerate. An explicit `exp - now > 60` check here would
  // be reachable, but only by *honest* hosts: a site whose clock is two seconds fast, minting the
  // documented `exp = iat + 60`, would fail every handoff and fail it as `lifetime` — a reason
  // that reads as "your token is malformed" when the truth is "your clock differs from ours by
  // less than our own tolerance". Tightening it to `60 + skew` instead makes the check
  // unreachable, and a dead branch guarding nothing is worse than the arithmetic being stated.
  // So the honest number is recorded here rather than enforced twice: **the longest an assertion
  // can be accepted for is `MAX_LIFETIME_SECONDS + MAX_CLOCK_SKEW_SECONDS`**, and shrinking the
  // skew is what shrinks it.
  if (exp <= nowSeconds) return reject("expired");

  // `sub` is an email because that is what a membership is keyed on. `normalizeEmail` is the same
  // validator every other login path uses, so a handoff cannot admit an address the OTP flow
  // would refuse.
  const rawSub = claims["sub"];
  let email: string;
  try {
    email = normalizeEmail(typeof rawSub === "string" ? rawSub : "");
  } catch {
    return reject("claims");
  }

  const jti = claims["jti"];
  if (typeof jti !== "string" || !JTI_RE.test(jti)) return reject("claims");

  const issuer = httpsOrigin(claims["iss"]);
  if (issuer === undefined) return reject("claims");

  return { ok: true, email, issuer, jti, keyId };
}

/**
 * What a rejection may say to the *caller*, as opposed to what the audit record says.
 *
 * `unknown_key` and `bad_signature` collapse into one: apart they are a `kid`-existence oracle on
 * a public, unauthenticated endpoint, letting anyone enumerate which key ids a workspace has
 * registered by watching which of the two comes back. Every other reason describes the token the
 * caller already holds and tells them nothing they did not supply, so it survives intact — a
 * plugin author debugging `lifetime` or `audience` needs to be told which one it is.
 */
export type HandoffWireReason =
  | Exclude<HandoffRejection, "unknown_key" | "bad_signature">
  | "invalid_assertion";

/** Collapses a verdict's reason to what may cross the wire. See {@link HandoffWireReason}. */
export function handoffWireReason(reason: HandoffRejection): HandoffWireReason {
  return reason === "unknown_key" || reason === "bad_signature" ? "invalid_assertion" : reason;
}

export interface HandoffService {
  verifyAssertion(input: VerifyHandoffInput): Promise<HandoffVerdict>;
}

/**
 * Container-friendly wrapper. Verification is a pure function of its input — no clock, no
 * database, no key cache worth the invalidation — so `verifyHandoffAssertion` is the real
 * surface and this exists so the route can be wired like every other service.
 */
export function createHandoffService(): HandoffService {
  return { verifyAssertion: verifyHandoffAssertion };
}
