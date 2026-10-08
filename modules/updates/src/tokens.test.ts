import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signUnsubscribeToken, verifyUnsubscribeToken } from "./tokens.js";

describe("unsubscribe tokens", () => {
  const key = randomBytes(32);
  const payload = { v: 1 as const, ws: "ws", m: "m", k: "k1", e: 2_000_000_000 };

  it("round-trips and rejects tampering, other keys and expiry", () => {
    const token = signUnsubscribeToken(key, payload);
    const now = new Date(1_900_000_000 * 1000);
    expect(verifyUnsubscribeToken(key, token, now)).toEqual(payload);
    expect(verifyUnsubscribeToken(randomBytes(32), token, now)).toBeUndefined();
    expect(verifyUnsubscribeToken(key, `${token}x`, now)).toBeUndefined();
    expect(verifyUnsubscribeToken(key, token, new Date(2_100_000_000 * 1000))).toBeUndefined();
    expect(verifyUnsubscribeToken(key, "not.a.token", now)).toBeUndefined();
    expect(verifyUnsubscribeToken(key, "", now)).toBeUndefined();
  });
});
