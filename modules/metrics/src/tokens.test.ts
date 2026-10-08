import { describe, expect, it } from "vitest";
import {
  CHART_MAX_SERIES,
  type ChartTokenPayload,
  decodeChartToken,
  resolveChartToken,
  signChartToken,
  verifyChartToken,
} from "./tokens.js";

/*
 * The capability token behind `GET /chart/{token}.png`. The property worth protecting is that
 * **every** refusal looks the same to the caller: `verifyChartToken` answers `undefined` for a
 * forgery, a stale token and a malformed one alike, so the route cannot accidentally grow a
 * distinguishable failure — which on a public route is an oracle (E2.2 shipped exactly that
 * bug on the handoff route and had to collapse it).
 */

const key = new Uint8Array(32).fill(7);
const otherKey = new Uint8Array(32).fill(9);
const NOW = new Date("2026-09-19T10:00:00.000Z");

const payload: ChartTokenPayload = {
  v: 1,
  w: "01920000-0000-7000-8000-000000000001",
  kid: "key-a",
  d: ["01920000-0000-7000-8000-0000000000a1"],
  k: "month",
  n: 12,
  asOf: "2026-09-18T09:00:00.000Z",
  exp: "2027-03-17T09:00:00.000Z",
};

describe("chart tokens", () => {
  it("round-trips a payload", () => {
    const token = signChartToken(key, payload);
    expect(token.split(".")).toHaveLength(2);
    expect(verifyChartToken(key, token, NOW)).toEqual(payload);
  });

  it("refuses a token signed under another workspace's key", () => {
    expect(verifyChartToken(otherKey, signChartToken(key, payload), NOW)).toBeUndefined();
  });

  it("refuses a tampered payload", () => {
    const token = signChartToken(key, payload);
    const [, sig] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...payload, d: ["01920000-0000-7000-8000-0000000000ff"] }),
    ).toString("base64url");
    expect(verifyChartToken(key, `${forged}.${sig}`, NOW)).toBeUndefined();
  });

  it("refuses an expired token, so an email read a year later gets nothing", () => {
    const token = signChartToken(key, { ...payload, exp: "2026-09-19T09:59:59.000Z" });
    expect(verifyChartToken(key, token, NOW)).toBeUndefined();
  });

  it("refuses a well-formed token whose signature is missing or extra", () => {
    const token = signChartToken(key, payload);
    const [body] = token.split(".");
    expect(verifyChartToken(key, body ?? "", NOW)).toBeUndefined();
    expect(verifyChartToken(key, `${token}.extra`, NOW)).toBeUndefined();
  });

  it("refuses garbage without throwing", () => {
    for (const bad of ["", ".", "a.b", "!!!.???", "e30.e30"]) {
      expect(() => verifyChartToken(key, bad, NOW)).not.toThrow();
      expect(verifyChartToken(key, bad, NOW)).toBeUndefined();
    }
  });

  it("refuses payload shapes the route cannot render", () => {
    const bad: Record<string, unknown>[] = [
      { ...payload, v: 2 },
      { ...payload, d: [] },
      { ...payload, d: Array.from({ length: CHART_MAX_SERIES + 1 }, () => payload.d[0]) },
      { ...payload, k: "custom" },
      { ...payload, n: 0 },
      { ...payload, n: 61 },
      { ...payload, n: 1.5 },
    ];
    for (const p of bad) {
      const body = Buffer.from(JSON.stringify(p)).toString("base64url");
      expect(decodeChartToken(`${body}.sig`)).toBeUndefined();
    }
  });

  it("names a set of metrics and never a reader", () => {
    // Decision D5: an `<img>` in an email is a tracking pixel the moment its URL identifies one
    // person, so there is nowhere in this payload to put a membership id.
    expect(Object.keys(payload).sort()).toEqual(["asOf", "d", "exp", "k", "kid", "n", "v", "w"]);
  });

  it("refuses a payload with no key id, because there would be no key to select", () => {
    for (const bad of [
      { ...payload, kid: "" },
      { v: 1, w: payload.w, d: payload.d },
    ]) {
      const body = Buffer.from(JSON.stringify(bad)).toString("base64url");
      expect(decodeChartToken(`${body}.sig`)).toBeUndefined();
    }
  });
});

describe("resolveChartToken", () => {
  /** The workspace's keys, as `crypto.keyById` would hand them back. */
  const keyring: Record<string, Uint8Array> = { "key-a": key, "key-b": otherKey };
  const keyById = async (kid: string) => {
    const found = keyring[kid];
    return found === undefined ? undefined : { key: found };
  };

  it("still verifies a token minted under key A after the workspace rotates to key B", async () => {
    /*
     * The whole point of `kid`. `crypto.rotate` is routine and `crypto.rewrap` runs nightly;
     * without the key id, rotating would silently 404 every chart image in every update ever
     * sent, for 180 days, with a token that still looks perfectly well-formed.
     */
    const token = signChartToken(key, payload);
    // The workspace has since rotated: `key-b` is current, `key-a` is retired but still readable.
    const resolved = await resolveChartToken(token, NOW, keyById);
    expect(resolved).toEqual({ ok: true, payload });
  });

  it("refuses a token naming a key the workspace does not have", async () => {
    const token = signChartToken(key, { ...payload, kid: "key-gone" });
    expect(await resolveChartToken(token, NOW, keyById)).toEqual({
      ok: false,
      reason: "unknown_key",
    });
  });

  it("selects by key id and only then verifies, so naming key B does not admit a key-A signature", async () => {
    // `kid` names *which key*, never a verification path: a forger who relabels a valid token
    // gets the wrong key and a signature mismatch, not a second chance.
    const relabelled = signChartToken(key, payload).split(".")[1] as string;
    const body = Buffer.from(JSON.stringify({ ...payload, kid: "key-b" })).toString("base64url");
    expect(await resolveChartToken(`${body}.${relabelled}`, NOW, keyById)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("tells the four refusals apart for the log, and only for the log", async () => {
    const reasons = await Promise.all([
      resolveChartToken("not-a-token", NOW, keyById),
      resolveChartToken(signChartToken(key, { ...payload, kid: "key-gone" }), NOW, keyById),
      resolveChartToken(signChartToken(otherKey, payload), NOW, keyById),
      resolveChartToken(
        signChartToken(key, { ...payload, exp: "2026-09-19T09:59:59.000Z" }),
        NOW,
        keyById,
      ),
    ]);
    expect(reasons.map((r) => (r.ok ? "ok" : r.reason))).toEqual([
      "malformed",
      "unknown_key",
      "bad_signature",
      "expired",
    ]);
    // Every one of them is the same shape to the caller: there is no payload to act on, so the
    // route has nothing to branch on and cannot grow a distinguishable answer by accident.
    expect(reasons.every((r) => !r.ok)).toBe(true);
  });

  it("lets the caller refuse a key minted for another purpose as simply absent", async () => {
    // The route's `keyById` closure checks `purpose`, so an unsubscribe key comes back as "no
    // such key" rather than as a key that happens not to match.
    const purposeChecked = async () => undefined;
    expect(await resolveChartToken(signChartToken(key, payload), NOW, purposeChecked)).toEqual({
      ok: false,
      reason: "unknown_key",
    });
  });
});
