import { describe, expect, it } from "vitest";
import {
  inQuietHours,
  isDigestDue,
  isValidTimezone,
  latestSlot,
  nextQuietEnd,
  wallClock,
} from "./schedule.js";

const at = (iso: string) => new Date(iso);
const NY = "America/New_York";
const LON = "Europe/London";
const SYD = "Australia/Sydney";
const KOL = "Asia/Kolkata";

describe("isValidTimezone", () => {
  it("accepts IANA zones and UTC, refuses anything else", () => {
    for (const tz of ["UTC", NY, LON, SYD, KOL, "Pacific/Chatham"]) {
      expect(isValidTimezone(tz), tz).toBe(true);
    }
    for (const tz of ["", "Mars/Olympus", "EST5EDT; DROP", "x".repeat(65)]) {
      expect(isValidTimezone(tz), tz).toBe(false);
    }
  });
});

describe("wallClock", () => {
  it("reads the local time, including half-hour offsets and midnight as hour 0", () => {
    expect(wallClock(at("2026-01-15T12:00:00Z"), NY)).toMatchObject({ day: 15, hour: 7 });
    expect(wallClock(at("2026-07-15T12:00:00Z"), NY)).toMatchObject({ hour: 8 });
    expect(wallClock(at("2026-01-15T12:00:00Z"), KOL)).toMatchObject({ hour: 17, minute: 30 });
    expect(wallClock(at("2026-01-15T05:00:00Z"), NY)).toMatchObject({ day: 15, hour: 0 });
  });

  it("an unknown zone falls back to UTC instead of throwing", () => {
    expect(wallClock(at("2026-01-15T12:00:00Z"), "Mars/Olympus")).toMatchObject({ hour: 12 });
  });
});

describe("latestSlot", () => {
  it("is today's local slot once it has passed, else yesterday's", () => {
    // 08:00 New York in winter is 13:00Z.
    expect(latestSlot(at("2026-01-15T13:30:00Z"), NY, 8).toISOString()).toBe(
      "2026-01-15T13:00:00.000Z",
    );
    expect(latestSlot(at("2026-01-15T12:59:59Z"), NY, 8).toISOString()).toBe(
      "2026-01-14T13:00:00.000Z",
    );
    // Exactly on the slot counts as passed.
    expect(latestSlot(at("2026-01-15T13:00:00Z"), NY, 8).toISOString()).toBe(
      "2026-01-15T13:00:00.000Z",
    );
  });

  it("follows DST: the same local hour is a different UTC hour in summer", () => {
    expect(latestSlot(at("2026-07-15T13:30:00Z"), NY, 8).toISOString()).toBe(
      "2026-07-15T12:00:00.000Z",
    );
    expect(latestSlot(at("2026-07-15T12:30:00Z"), LON, 8).toISOString()).toBe(
      "2026-07-15T07:00:00.000Z",
    );
  });

  it("a slot inside the spring-forward gap resolves to just after it", () => {
    // New York jumps 02:00 → 03:00 on 2026-03-08; 02:00 local does not exist that day.
    expect(latestSlot(at("2026-03-08T12:00:00Z"), NY, 2).toISOString()).toBe(
      "2026-03-08T07:00:00.000Z",
    );
    expect(wallClock(at("2026-03-08T07:00:00Z"), NY)).toMatchObject({ hour: 3 });
  });

  it("a slot inside the fall-back overlap resolves to its first occurrence", () => {
    // New York repeats 01:00–02:00 on 2026-11-01: first at 05:00Z (EDT), again at 06:00Z (EST).
    expect(latestSlot(at("2026-11-01T12:00:00Z"), NY, 1).toISOString()).toBe(
      "2026-11-01T05:00:00.000Z",
    );
  });

  it("the local date, not the UTC date, decides which day it is", () => {
    // 23:30Z on the 15th is already 10:30 on the 16th in Sydney (AEDT, +11).
    expect(latestSlot(at("2026-01-15T23:30:00Z"), SYD, 9).toISOString()).toBe(
      "2026-01-15T22:00:00.000Z",
    );
  });

  it("weekly: the latest passed slot on the chosen weekday", () => {
    // 2026-01-14 is a Wednesday. Monday 08:00 UTC slot → 2026-01-12.
    expect(latestSlot(at("2026-01-14T10:00:00Z"), "UTC", 8, 1).toISOString()).toBe(
      "2026-01-12T08:00:00.000Z",
    );
    // On the weekday itself, before the hour → a week earlier; after → today.
    expect(latestSlot(at("2026-01-12T07:00:00Z"), "UTC", 8, 1).toISOString()).toBe(
      "2026-01-05T08:00:00.000Z",
    );
    expect(latestSlot(at("2026-01-12T09:00:00Z"), "UTC", 8, 1).toISOString()).toBe(
      "2026-01-12T08:00:00.000Z",
    );
    // Sunday (0), in Sydney, where Sunday starts while UTC is still on Saturday.
    expect(latestSlot(at("2026-01-17T22:30:00Z"), SYD, 9, 0).toISOString()).toBe(
      "2026-01-17T22:00:00.000Z",
    );
  });
});

describe("isDigestDue", () => {
  const daily = { timezone: NY, hour: 8 };

  it("nothing waiting and never sent → not due", () => {
    expect(isDigestDue(at("2026-01-15T13:30:00Z"), daily, null, null)).toBe(false);
  });

  it("due once the local slot passes after the last digest, and not again that day", () => {
    const last = at("2026-01-14T13:05:00Z");
    expect(isDigestDue(at("2026-01-15T12:30:00Z"), daily, last, null)).toBe(false);
    expect(isDigestDue(at("2026-01-15T13:00:00Z"), daily, last, null)).toBe(true);
    const sent = at("2026-01-15T13:00:10Z");
    expect(isDigestDue(at("2026-01-15T20:00:00Z"), daily, sent, null)).toBe(false);
    expect(isDigestDue(at("2026-01-16T13:00:00Z"), daily, sent, null)).toBe(true);
  });

  it("catches up after a missed hour instead of waiting a day", () => {
    const last = at("2026-01-14T13:00:00Z");
    // The 08:00 run never happened; the 11:00 run still sends today's digest.
    expect(isDigestDue(at("2026-01-15T16:00:00Z"), daily, last, null)).toBe(true);
  });

  it("a first digest waits for the next slot after the oldest waiting row", () => {
    const oldest = at("2026-01-15T03:00:00Z"); // 22:00 local on the 14th
    // 03:30 local on the 15th: yesterday's 08:00 slot predates the row → not due.
    expect(isDigestDue(at("2026-01-15T08:30:00Z"), daily, null, oldest)).toBe(false);
    expect(isDigestDue(at("2026-01-15T13:00:00Z"), daily, null, oldest)).toBe(true);
  });

  it("the member's timezone, not UTC, decides the hour", () => {
    const last = at("2026-01-14T00:00:00Z");
    // 08:00 UTC is 03:00 in New York: a New York 08:00 digest is not due yet today.
    expect(isDigestDue(at("2026-01-15T08:00:00Z"), daily, last, null)).toBe(true); // yesterday's slot
    const sentYesterday = at("2026-01-14T13:00:00Z");
    expect(isDigestDue(at("2026-01-15T08:00:00Z"), daily, sentYesterday, null)).toBe(false);
    expect(
      isDigestDue(at("2026-01-15T08:00:00Z"), { timezone: "UTC", hour: 8 }, sentYesterday, null),
    ).toBe(true);
  });

  it("across a DST change the slot stays at the local hour", () => {
    // Sent Saturday 2026-03-07 08:00 EST (13:00Z). Sunday 08:00 is EDT = 12:00Z.
    const last = at("2026-03-07T13:00:00Z");
    expect(isDigestDue(at("2026-03-08T11:59:00Z"), daily, last, null)).toBe(false);
    expect(isDigestDue(at("2026-03-08T12:00:00Z"), daily, last, null)).toBe(true);
  });

  it("weekly: due once per week on the chosen day", () => {
    const weekly = { timezone: "UTC", hour: 8, weekday: 1 };
    const last = at("2026-01-05T08:00:05Z"); // Monday
    expect(isDigestDue(at("2026-01-09T09:00:00Z"), weekly, last, null)).toBe(false); // Friday
    expect(isDigestDue(at("2026-01-12T07:59:00Z"), weekly, last, null)).toBe(false);
    expect(isDigestDue(at("2026-01-12T08:00:00Z"), weekly, last, null)).toBe(true);
    // Missed Monday entirely: Tuesday still catches up.
    expect(isDigestDue(at("2026-01-13T02:00:00Z"), weekly, last, null)).toBe(true);
  });
});

describe("quiet hours", () => {
  const overnight = { timezone: NY, start: 22, end: 7 };
  const lunch = { timezone: "UTC", start: 12, end: 14 };

  it("no window, an empty window or an out-of-range hour means never quiet", () => {
    const now = at("2026-01-15T03:00:00Z");
    expect(inQuietHours(now, { timezone: "UTC", start: null, end: null })).toBe(false);
    expect(inQuietHours(now, { timezone: "UTC", start: 3, end: null })).toBe(false);
    expect(inQuietHours(now, { timezone: "UTC", start: 3, end: 3 })).toBe(false);
    expect(inQuietHours(now, { timezone: "UTC", start: 3, end: 24 })).toBe(false);
    expect(nextQuietEnd(now, { timezone: "UTC", start: null, end: null })).toBeUndefined();
  });

  it("a same-day window: start inclusive, end exclusive", () => {
    expect(inQuietHours(at("2026-01-15T11:59:00Z"), lunch)).toBe(false);
    expect(inQuietHours(at("2026-01-15T12:00:00Z"), lunch)).toBe(true);
    expect(inQuietHours(at("2026-01-15T13:59:00Z"), lunch)).toBe(true);
    expect(inQuietHours(at("2026-01-15T14:00:00Z"), lunch)).toBe(false);
    expect(nextQuietEnd(at("2026-01-15T12:30:00Z"), lunch)?.toISOString()).toBe(
      "2026-01-15T14:00:00.000Z",
    );
    expect(nextQuietEnd(at("2026-01-15T15:00:00Z"), lunch)).toBeUndefined();
  });

  it("a window wrapping midnight, in local time", () => {
    // 22:00–07:00 New York (EST, -5) = 03:00Z–12:00Z.
    expect(inQuietHours(at("2026-01-15T02:59:00Z"), overnight)).toBe(false);
    expect(inQuietHours(at("2026-01-15T03:00:00Z"), overnight)).toBe(true);
    expect(inQuietHours(at("2026-01-15T05:00:00Z"), overnight)).toBe(true); // 00:00 local
    expect(inQuietHours(at("2026-01-15T11:59:00Z"), overnight)).toBe(true);
    expect(inQuietHours(at("2026-01-15T12:00:00Z"), overnight)).toBe(false);
    // Before local midnight → ends tomorrow morning; after → ends this morning.
    expect(nextQuietEnd(at("2026-01-15T04:00:00Z"), overnight)?.toISOString()).toBe(
      "2026-01-15T12:00:00.000Z",
    );
    expect(nextQuietEnd(at("2026-01-16T03:30:00Z"), overnight)?.toISOString()).toBe(
      "2026-01-16T12:00:00.000Z",
    );
  });

  it("a quiet night that spans a DST change ends at the local hour, not the UTC one", () => {
    // Night of 2026-03-07 → 03-08 in New York: starts EST, ends EDT. 07:00 EDT = 11:00Z.
    const night = at("2026-03-08T04:00:00Z"); // 23:00 EST on the 7th
    expect(inQuietHours(night, overnight)).toBe(true);
    expect(nextQuietEnd(night, overnight)?.toISOString()).toBe("2026-03-08T11:00:00.000Z");
    expect(inQuietHours(at("2026-03-08T11:00:00Z"), overnight)).toBe(false);
    expect(inQuietHours(at("2026-03-08T10:59:00Z"), overnight)).toBe(true);
  });
});
