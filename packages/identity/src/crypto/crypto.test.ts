import { randomBytes } from "node:crypto";
import { parseKeyRing } from "@fundroom/config";
import { describe, expect, it } from "vitest";
import { checkPasswordBreached } from "./hibp.js";
import { deriveKey, hashCode, KEY_PURPOSES, verifyCode } from "./keys.js";
import {
  checkPasswordPolicy,
  dummyPasswordHash,
  hashPassword,
  hashRecoveryCode,
  isSlowRecoveryHash,
  parsePasswordHash,
  verifyPassword,
  verifyRecoveryCodeHash,
} from "./password.js";
import { needsReseal, open, SecretBoxError, seal } from "./secretbox.js";
import {
  base32Decode,
  base32Encode,
  normalizeCode,
  otpCode,
  randomToken,
  recoveryCode,
  safeEqual,
  sha256,
} from "./tokens.js";

const K1 = randomBytes(32).toString("base64");
const K2 = randomBytes(32).toString("base64");

function ring(raw: string) {
  const r = parseKeyRing(raw);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join("; "));
  return r.ring;
}

describe("tokens", () => {
  it("randomToken is 256 bits of base64url", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(t, "base64url")).toHaveLength(32);
    expect(randomToken()).not.toBe(t);
  });

  it("otpCode is zero-padded and within range", () => {
    for (let i = 0; i < 200; i++) expect(otpCode(6)).toMatch(/^\d{6}$/u);
    expect(() => otpCode(3)).toThrow(RangeError);
  });

  it("base32 matches RFC 4648 vectors without padding", () => {
    expect(base32Encode(Buffer.from(""))).toBe("");
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Encode(Buffer.from("fo"))).toBe("MZXQ");
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(Buffer.from(base32Decode("MZXW6YTBOI")).toString()).toBe("foobar");
    expect(Buffer.from(base32Decode("mzxw 6ytb-oi======")).toString()).toBe("foobar");
    const bytes = randomBytes(20);
    expect(Buffer.from(base32Decode(base32Encode(bytes)))).toEqual(bytes);
    expect(() => base32Decode("1")).toThrow(/invalid base32/u);
  });

  it("recovery codes look like xxxx-xxxx and normalise", () => {
    const c = recoveryCode();
    expect(c).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}$/u);
    expect(normalizeCode(c.toUpperCase().replace("-", " "))).toBe(c.replace("-", ""));
  });

  it("safeEqual handles length mismatch without throwing", () => {
    expect(safeEqual(sha256("a"), sha256("a"))).toBe(true);
    expect(safeEqual(sha256("a"), sha256("b"))).toBe(false);
    expect(safeEqual(Buffer.from("ab"), Buffer.from("abc"))).toBe(false);
  });
});

describe("keys", () => {
  it("derives distinct sub-keys per purpose and caches them", () => {
    const r = ring(`v1:${K1}`);
    const a = deriveKey(r.current, KEY_PURPOSES.codeHmac);
    const b = deriveKey(r.current, KEY_PURPOSES.secretBox);
    expect(a).toHaveLength(32);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
    expect(deriveKey(r.current, KEY_PURPOSES.codeHmac)).toBe(a);
  });

  it("hashCode verifies under the current key and after rotation", () => {
    const old = ring(`v1:${K1}`);
    const mac = hashCode(old, "123456", "otp:ws:alice@example.com");
    expect(verifyCode(old, "123456", "otp:ws:alice@example.com", mac)).toBe(true);
    expect(verifyCode(old, "123457", "otp:ws:alice@example.com", mac)).toBe(false);
    expect(verifyCode(old, "123456", "otp:ws:bob@example.com", mac)).toBe(false);
    const rotated = ring(`v2:${K2},v1:${K1}`);
    expect(verifyCode(rotated, "123456", "otp:ws:alice@example.com", mac)).toBe(true);
    const fresh = ring(`v2:${K2}`);
    expect(verifyCode(fresh, "123456", "otp:ws:alice@example.com", mac)).toBe(false);
  });
});

describe("secretbox", () => {
  it("round-trips with AAD and rejects tampering", () => {
    const r = ring(`v1:${K1}`);
    const sealed = seal(r, Buffer.from("totp-seed"), "totp:u1");
    expect(sealed.startsWith("sb1.v1.")).toBe(true);
    expect(Buffer.from(open(r, sealed, "totp:u1")).toString()).toBe("totp-seed");
    expect(() => open(r, sealed, "totp:u2")).toThrow(SecretBoxError);
    const parts = sealed.split(".");
    parts[3] = `${parts[3]?.slice(0, -2)}AA`;
    expect(() => open(r, parts.join("."), "totp:u1")).toThrow(SecretBoxError);
    expect(() => open(r, "nope", "totp:u1")).toThrow(SecretBoxError);
  });

  it("refuses a truncated authentication tag (ASVS F-22)", () => {
    const r = ring(`v1:${K1}`);
    const sealed = seal(r, Buffer.from("totp-seed"), "totp:u1");
    const parts = sealed.split(".");
    // A 4-byte prefix of the real tag: Node's GCM would check only those 4 bytes.
    parts[4] = Buffer.from(parts[4] ?? "", "base64url")
      .subarray(0, 4)
      .toString("base64url");
    expect(() => open(r, parts.join("."), "totp:u1")).toThrow(SecretBoxError);
  });

  it("opens values sealed under an older ring key and flags them for reseal", () => {
    const old = ring(`v1:${K1}`);
    const sealed = seal(old, Buffer.from("x"));
    const rotated = ring(`v2:${K2},v1:${K1}`);
    expect(Buffer.from(open(rotated, sealed)).toString()).toBe("x");
    expect(needsReseal(rotated, sealed)).toBe(true);
    expect(needsReseal(old, sealed)).toBe(false);
    const gone = ring(`v2:${K2}`);
    expect(() => open(gone, sealed)).toThrow(/no key "v1"/u);
  });
});

describe("password", () => {
  it("hashes with scrypt and verifies", async () => {
    const h = await hashPassword("correct horse battery staple");
    // OWASP floor (F-17): N=2^16 with p=2 (equivalent cost to N=2^17, p=1, half the memory).
    expect(h.startsWith("scrypt$16$8$2$")).toBe(true);
    expect(parsePasswordHash(h)?.params).toEqual({ logN: 16, r: 8, p: 2 });
    expect(await verifyPassword("correct horse battery staple", h)).toEqual({
      ok: true,
      needsRehash: false,
    });
    expect((await verifyPassword("Correct horse battery staple", h)).ok).toBe(false);
    expect(await verifyPassword("x", "garbage")).toEqual({ ok: false, needsRehash: false });
  });

  it("flags weaker parameters for rehash", async () => {
    const weak = await hashPassword("correct horse battery staple", { logN: 14, r: 8, p: 1 });
    expect(await verifyPassword("correct horse battery staple", weak)).toEqual({
      ok: true,
      needsRehash: true,
    });
  });

  it("flags the pre-E2.10 default (N=2^16, p=1) for rehash on the next login", async () => {
    const old = await hashPassword("correct horse battery staple", { logN: 16, r: 8, p: 1 });
    expect(await verifyPassword("correct horse battery staple", old)).toEqual({
      ok: true,
      needsRehash: true,
    });
  });

  it("stores recovery codes as salted scrypt hashes bound to their scope (F-18)", async () => {
    const a = await hashRecoveryCode("abcd2345", "recovery:u1");
    const b = await hashRecoveryCode("abcd2345", "recovery:u1");
    expect(a.startsWith("rc1$")).toBe(true);
    expect(isSlowRecoveryHash(a)).toBe(true);
    expect(a).not.toBe(b); // salted
    expect(await verifyRecoveryCodeHash("abcd2345", "recovery:u1", a)).toBe(true);
    expect(await verifyRecoveryCodeHash("abcd2346", "recovery:u1", a)).toBe(false);
    expect(await verifyRecoveryCodeHash("abcd2345", "recovery:u2", a)).toBe(false);
    expect(await verifyRecoveryCodeHash("abcd2345", "recovery:u1", "legacy-hmac")).toBe(false);
    expect(isSlowRecoveryHash("bGVnYWN5")).toBe(false);
  });

  it("dummy hash is stable and never verifies a real guess", async () => {
    expect(await dummyPasswordHash()).toBe(await dummyPasswordHash());
    expect((await verifyPassword("anything", await dummyPasswordHash())).ok).toBe(false);
  });

  it("policy is length-only (NIST 800-63B)", () => {
    expect(checkPasswordPolicy("short")).toBe("too_short");
    expect(checkPasswordPolicy("a".repeat(12))).toBeUndefined();
    expect(checkPasswordPolicy("p@ss".repeat(3))).toBeUndefined();
    expect(checkPasswordPolicy("a".repeat(257))).toBe("too_long");
  });
});

describe("hibp", () => {
  const sha1Password = "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8"; // sha1("password")
  const fetchWith =
    (body: string, status = 200) =>
    async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      expect(url).toBe(`https://api.pwnedpasswords.com/range/${sha1Password.slice(0, 5)}`);
      return new Response(body, { status });
    };

  it("reports a breached password from the k-anonymity range", async () => {
    const body = `0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${sha1Password.slice(5)}:3861493\r\nFFFFF:0`;
    expect(await checkPasswordBreached("password", { fetch: fetchWith(body) })).toEqual({
      status: "breached",
      count: 3861493,
    });
  });

  it("treats padded zero-count rows and absent suffixes as clear", async () => {
    const body = `0018A45C4D1DEF81644B54AB7F969B88D65:1\r\n${sha1Password.slice(5)}:0`;
    expect(await checkPasswordBreached("password", { fetch: fetchWith(body) })).toEqual({
      status: "clear",
    });
  });

  it("is unavailable, not clear, on HTTP or network failure", async () => {
    expect((await checkPasswordBreached("password", { fetch: fetchWith("", 503) })).status).toBe(
      "unavailable",
    );
    const failing = async () => {
      throw new Error("ECONNRESET");
    };
    expect(await checkPasswordBreached("password", { fetch: failing })).toEqual({
      status: "unavailable",
      reason: "ECONNRESET",
    });
  });

  it("is unavailable when HIBP hangs past the timeout (F-21: the caller's fail mode decides)", async () => {
    const hanging = (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const result = await checkPasswordBreached("password", { fetch: hanging, timeoutMs: 20 });
    expect(result.status).toBe("unavailable");
  });
});
