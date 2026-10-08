import { forensicSeed } from "@fundroom/forensic";
import { describe, expect, it } from "vitest";
import {
  base32,
  createMarkIssuer,
  hex,
  MARK_TOUCH_MS,
  type MarkStore,
  traceLine,
} from "./marks.js";

const KEY_A = new Uint8Array(32).fill(1);
const KEY_B = new Uint8Array(32).fill(2);

function setup(initial: Record<string, Uint8Array> = { a: KEY_A }) {
  const ring = new Map(Object.entries(initial));
  let currentId = Object.keys(initial)[0] ?? "a";
  let now = Date.parse("2026-10-01T10:00:00Z");
  const rows = new Map<string, { token: Uint8Array; keyId: string; touches: number }>();
  let calls = 0;
  let failNext: unknown;
  const store: MarkStore = {
    async upsert(_ws, row, fresh, inRing) {
      calls++;
      if (failNext !== undefined) {
        const e = failNext;
        failNext = undefined;
        throw e;
      }
      const key = `${row.membershipId}:${row.versionId}`;
      let r = rows.get(key);
      if (r === undefined) {
        r = { ...fresh(), touches: 0 };
        rows.set(key, r);
      } else {
        r.touches++;
        if (!inRing(r.keyId)) Object.assign(r, fresh());
      }
      return { token: r.token, keyId: r.keyId };
    },
  };
  const issuer = createMarkIssuer(
    {
      db: undefined as never,
      now: () => new Date(now),
      forensicKeys: {
        current: () => ({ keyId: currentId, patternKey: ring.get(currentId) as Uint8Array }),
        get: (id) => ring.get(id),
      },
    },
    store,
  );
  return {
    issuer,
    rows,
    ring,
    calls: () => calls,
    advance: (ms: number) => {
      now += ms;
    },
    rotate: (id: string, key: Uint8Array) => {
      ring.set(id, key);
      currentId = id;
    },
    failWith: (e: unknown) => {
      failNext = e;
    },
  };
}

describe("base32 / trace line", () => {
  it("encodes RFC 4648 test vectors (no padding)", () => {
    const enc = (s: string) => base32(new TextEncoder().encode(s));
    expect(enc("")).toBe("");
    expect(enc("f")).toBe("MY");
    expect(enc("fo")).toBe("MZXQ");
    expect(enc("foo")).toBe("MZXW6");
    expect(enc("foob")).toBe("MZXW6YQ");
    expect(enc("fooba")).toBe("MZXW6YTB");
    expect(enc("foobar")).toBe("MZXW6YTBOI");
  });

  it("the trace line is 8 base32 characters of the token, the trace id its full hex", () => {
    const token = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03, 0x04]);
    expect(traceLine(token)).toMatch(/^trace [A-Z2-7]{8}$/u);
    expect(traceLine(token)).toBe(`trace ${base32(token).slice(0, 8)}`);
    expect(hex(token)).toBe("deadbeef01020304");
  });
});

describe("createMarkIssuer", () => {
  it("issues one stable token per (viewer, version) and seeds it with the row's key", async () => {
    const t = setup();
    const a1 = await t.issuer.issue("ws", "m1", "d1", "v1");
    const a2 = await t.issuer.issue("ws", "m1", "d1", "v1");
    const b = await t.issuer.issue("ws", "m2", "d1", "v1");
    const v2 = await t.issuer.issue("ws", "m1", "d1", "v2");
    expect(a1.token).toHaveLength(8);
    expect(hex(a2.token)).toBe(hex(a1.token));
    expect(hex(b.token)).not.toBe(hex(a1.token));
    expect(hex(v2.token)).not.toBe(hex(a1.token));
    expect(a1.keyId).toBe("a");
    expect(hex(a1.seed)).toBe(hex(forensicSeed(KEY_A, a1.token)));
  });

  it("touches the row at most once an hour (in-process memo)", async () => {
    const t = setup();
    await t.issuer.issue("ws", "m1", "d1", "v1");
    for (let i = 0; i < 5; i++) await t.issuer.issue("ws", "m1", "d1", "v1");
    expect(t.calls()).toBe(1);
    t.advance(MARK_TOUCH_MS - 1);
    await t.issuer.issue("ws", "m1", "d1", "v1");
    expect(t.calls()).toBe(1);
    t.advance(2);
    await t.issuer.issue("ws", "m1", "d1", "v1");
    expect(t.calls()).toBe(2);
    expect(t.rows.get("m1:v1")?.touches).toBe(1);
  });

  it("keeps a mark under an older key while that key is still in the ring", async () => {
    const t = setup();
    const before = await t.issuer.issue("ws", "m1", "d1", "v1");
    t.rotate("b", KEY_B);
    t.advance(MARK_TOUCH_MS + 1);
    const after = await t.issuer.issue("ws", "m1", "d1", "v1");
    expect(after.keyId).toBe("a");
    expect(hex(after.token)).toBe(hex(before.token));
    // New recipients get the current key.
    expect((await t.issuer.issue("ws", "m9", "d1", "v1")).keyId).toBe("b");
  });

  it("re-keys a mark whose key left the ring (bypassing the memo)", async () => {
    const t = setup();
    const before = await t.issuer.issue("ws", "m1", "d1", "v1");
    t.rotate("b", KEY_B);
    t.ring.delete("a");
    const after = await t.issuer.issue("ws", "m1", "d1", "v1");
    expect(after.keyId).toBe("b");
    expect(hex(after.token)).not.toBe(hex(before.token));
    expect(hex(after.seed)).toBe(hex(forensicSeed(KEY_B, after.token)));
  });

  it("retries a token collision (23505) and surfaces anything else", async () => {
    const t = setup();
    t.failWith(Object.assign(new Error("dup"), { code: "23505" }));
    await expect(t.issuer.issue("ws", "m1", "d1", "v1")).resolves.toBeDefined();
    expect(t.calls()).toBe(2);
    t.failWith(Object.assign(new Error("boom"), { code: "57014" }));
    await expect(t.issuer.issue("ws", "m2", "d1", "v1")).rejects.toThrow("boom");
  });
});
