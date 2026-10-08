import type { RenderedImage } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import type { IssuedMark } from "../forensic/marks.js";
import { ProtectionSchema } from "../model.js";
import { composePage, pageCacheKey, sharedDelivery } from "./delivery.js";
import { effectiveProtection } from "./documents.js";

const image: RenderedImage = {
  bytes: new Uint8Array([1]),
  width: 10,
  height: 10,
  contentType: "image/webp",
};
const mark: IssuedMark = {
  token: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
  keyId: "k",
  seed: new Uint8Array(32).fill(9),
};

function fakeRenderer() {
  const calls: string[] = [];
  return {
    calls,
    renderer: {
      async embedForensicMark(img: RenderedImage, spec: { seed: Uint8Array }) {
        calls.push(`mark(${[...img.bytes].join(",")};seed=${spec.seed[0]})`);
        return { ...img, bytes: new Uint8Array([...img.bytes, 2]) };
      },
      async watermarkImage(img: RenderedImage, spec: { lines: readonly string[] }) {
        calls.push(`visible(${[...img.bytes].join(",")};${spec.lines.join("|")})`);
        return { ...img, bytes: new Uint8Array([...img.bytes, 3]) };
      },
    },
  };
}

describe("composePage", () => {
  it("embeds the forensic mark on the clean raster first, then the visible watermark", async () => {
    const f = fakeRenderer();
    const out = await composePage(f.renderer, image, { mark, lines: ["ada", "acme"] });
    expect(f.calls).toEqual(["mark(1;seed=9)", "visible(1,2;ada|acme)"]);
    expect([...out.bytes]).toEqual([1, 2, 3]);
  });

  it("applies only the layers asked for", async () => {
    const f = fakeRenderer();
    expect([...(await composePage(f.renderer, image, { mark })).bytes]).toEqual([1, 2]);
    expect([...(await composePage(f.renderer, image, { lines: ["x"] })).bytes]).toEqual([1, 3]);
    expect(await composePage(f.renderer, image, {})).toBe(image);
    expect(f.calls).toEqual(["mark(1;seed=9)", "visible(1;x)"]);
  });
});

describe("pageCacheKey", () => {
  it("separates viewers, days, marks and the visible layer", () => {
    const k = (m: IssuedMark | undefined, w: boolean, who = "m1", day = "2026-10-01") =>
      pageCacheKey("v1", 3, who, day, m, w);
    expect(k(mark, true)).toBe("v1:3:m1:2026-10-01:0102030405060708:w");
    expect(k(undefined, true)).toBe("v1:3:m1:2026-10-01:-:w");
    expect(
      new Set([k(mark, true), k(undefined, true), k(mark, false), k(mark, true, "m2")]).size,
    ).toBe(4);
    expect(k(mark, true, "m1", "2026-10-02")).not.toBe(k(mark, true));
  });
});

describe("effectiveProtection (share-link force)", () => {
  const services = (force: boolean, seen: string[] = []) => ({
    shareLinks: {
      async forcedProtection(ws: string, m: string) {
        seen.push(`${ws}:${m}`);
        return { forceWatermark: force };
      },
    },
  });

  it("forces the visible watermark ON for a visitor of a forcing link", async () => {
    const off = ProtectionSchema.parse({ watermark: false, download: true, forensic: false });
    const seen: string[] = [];
    const p = await effectiveProtection(services(true, seen), "ws", "m1", off);
    expect(p).toEqual({ ...off, watermark: true });
    expect(seen).toEqual(["ws:m1"]);
  });

  it("never turns anything off, never forces forensic, skips the read when already on", async () => {
    const off = ProtectionSchema.parse({ watermark: false });
    expect(await effectiveProtection(services(false), "ws", "m1", off)).toEqual(off);
    const on = ProtectionSchema.parse({ watermark: true });
    const seen: string[] = [];
    expect(await effectiveProtection(services(true, seen), "ws", "m1", on)).toBe(on);
    expect(seen).toEqual([]);
    expect((await effectiveProtection(services(true), "ws", "m1", off)).forensic).toBe(false);
  });
});

describe("sharedDelivery (FIX1 D7)", () => {
  it("one delivery service — one set of caches — per database, whatever services wrapper asks", () => {
    const db = {};
    const base = { db, renderer: {}, log() {}, now: () => new Date() } as never as Parameters<
      typeof sharedDelivery
    >[0];
    const wrapped = { ...(base as object) } as typeof base;
    expect(sharedDelivery(base)).toBe(sharedDelivery(wrapped));
    const other = { ...(base as object), db: {} } as typeof base;
    expect(sharedDelivery(other)).not.toBe(sharedDelivery(base));
  });
});
