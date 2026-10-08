import { describe, expect, it } from "vitest";
import { dsarRow, dsarValue } from "./dsar-rows.js";

describe("dsarRow", () => {
  it("writes dates as ISO, drops bytes and omitted keys, keeps nested JSON", () => {
    const row = dsarRow(
      {
        id: "x",
        at: new Date("2026-09-22T10:00:00.000Z"),
        ipHash: Buffer.from("secret"),
        tokenHash: "never",
        props: { url: "/a", when: new Date("2026-01-01T00:00:00.000Z") },
        tags: ["a", new Uint8Array([1])],
        big: 12n,
        nan: Number.NaN,
        none: null,
      },
      ["tokenHash"],
    );
    expect(row).toEqual({
      id: "x",
      at: "2026-09-22T10:00:00.000Z",
      props: { url: "/a", when: "2026-01-01T00:00:00.000Z" },
      tags: ["a"],
      big: "12",
      nan: null,
      none: null,
    });
  });
  it("maps undefined to null", () => {
    expect(dsarValue(undefined)).toBeNull();
  });
});
