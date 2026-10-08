import { describe, expect, it } from "vitest";
import { parseTimestamptz, parseTstzRange, toTstzRange } from "./access-repo.js";

/*
 * `core.access_grant.validity` comes back as Postgres's own text. Postgres prints a UTC offset as
 * `+00` — which `new Date()` rejects — so these tests use exactly what the database returns
 * (captured from Postgres 18), not the ISO strings this package writes.
 */
describe("parseTimestamptz", () => {
  it("reads every offset form Postgres prints", () => {
    expect(parseTimestamptz("2026-09-24 00:54:53.603565+00")?.toISOString()).toBe(
      "2026-09-24T00:54:53.603Z",
    );
    expect(parseTimestamptz("2026-09-24 00:54:53+00")?.toISOString()).toBe(
      "2026-09-24T00:54:53.000Z",
    );
    expect(parseTimestamptz("2026-09-24 06:24:53+05:30")?.toISOString()).toBe(
      "2026-09-24T00:54:53.000Z",
    );
    expect(parseTimestamptz("2026-09-23 21:54:53.5-03")?.toISOString()).toBe(
      "2026-09-24T00:54:53.500Z",
    );
    expect(parseTimestamptz("1900-01-01 00:53:28+00:53:28")?.toISOString()).toBe(
      "1900-01-01T00:00:00.000Z",
    );
    expect(parseTimestamptz("2026-09-24T00:54:53.603Z")?.toISOString()).toBe(
      "2026-09-24T00:54:53.603Z",
    );
  });

  it("refuses what is not a timestamp", () => {
    expect(parseTimestamptz("")).toBeUndefined();
    expect(parseTimestamptz("infinity")).toBeUndefined();
    expect(parseTimestamptz("2026-09-24")).toBeUndefined();
    expect(parseTimestamptz("2026-13-45 99:99:99+00")).toBeUndefined();
  });
});

describe("parseTstzRange", () => {
  it("reads the bounds of a range exactly as Postgres returns it", () => {
    expect(
      parseTstzRange('["2026-09-23 23:54:53.603565+00","2026-09-24 00:54:53.603+00")'),
    ).toEqual({
      from: new Date("2026-09-23T23:54:53.603Z"),
      until: new Date("2026-09-24T00:54:53.603Z"),
    });
  });

  it("treats an empty or infinite bound as open", () => {
    expect(parseTstzRange('["2026-09-11 10:00:00+00",)')).toEqual({
      from: new Date("2026-09-11T10:00:00.000Z"),
      until: undefined,
    });
    expect(parseTstzRange("[-infinity,infinity)")).toEqual({ from: undefined, until: undefined });
    expect(parseTstzRange("(,)")).toEqual({ from: undefined, until: undefined });
  });

  it("fails closed on a bound it cannot read: never started, already ended", () => {
    const r = parseTstzRange('["someday","later")');
    expect(r.from?.getTime()).toBeGreaterThan(Date.now());
    expect(r.until?.getTime()).toBe(0);
    const junk = parseTstzRange("not a range");
    expect(junk.from?.getTime()).toBeGreaterThan(Date.now());
    expect(junk.until?.getTime()).toBe(0);
  });

  it("round-trips what toTstzRange writes", () => {
    const from = new Date("2026-01-01T00:00:00.000Z");
    const until = new Date("2026-02-01T12:30:00.250Z");
    expect(parseTstzRange(toTstzRange(from, until))).toEqual({ from, until });
    expect(parseTstzRange(toTstzRange(undefined, undefined))).toEqual({
      from: undefined,
      until: undefined,
    });
  });
});
