import { describe, expect, it } from "vitest";
import {
  decodeAuditCursor,
  decodeWorkspaceCursor,
  encodeAuditCursor,
  encodeWorkspaceCursor,
  type PlatformDeps,
  PlatformError,
  screeningAllowsRelease,
  screeningLiftsSanctions,
  unsuspendWorkspace,
} from "./platform.js";
import { likePattern } from "./repos/platform-repo.js";

/*
 * The operator API's pure pieces (E3.10): opaque keyset cursors that round-trip at full timestamp
 * precision and refuse anything else, the search pattern's escaping, and when a sanctions hold or
 * suspension may be lifted.
 */
describe("workspace cursor", () => {
  it("round-trips created_at text at microsecond precision and the id", () => {
    const row = {
      cursorCreatedAt: "2026-09-27 10:11:12.123456+00",
      id: "01920000-0000-7000-8000-000000000001",
    };
    expect(decodeWorkspaceCursor(encodeWorkspaceCursor(row))).toEqual({
      createdAt: row.cursorCreatedAt,
      id: row.id,
    });
  });

  it("refuses tampered or foreign cursors", () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    expect(decodeWorkspaceCursor("not base64 json")).toBeUndefined();
    expect(decodeWorkspaceCursor(b64(["2026-09-27", "x'; DROP TABLE"]))).toBeUndefined();
    expect(
      decodeWorkspaceCursor(b64(["yesterday", "01920000-0000-7000-8000-000000000001"])),
    ).toBeUndefined();
    expect(decodeWorkspaceCursor(b64({ a: 1 }))).toBeUndefined();
  });
});

describe("audit cursor", () => {
  it("round-trips a seq and refuses anything else", () => {
    expect(decodeAuditCursor(encodeAuditCursor(42))).toBe(42);
    expect(decodeAuditCursor(Buffer.from("seq:-1").toString("base64url"))).toBeUndefined();
    expect(decodeAuditCursor("garbage")).toBeUndefined();
  });
});

describe("likePattern", () => {
  it("escapes LIKE wildcards and the escape character", () => {
    expect(likePattern("a_b%c\\d")).toBe("%a\\_b\\%c\\\\d%");
  });
});

describe("screeningAllowsRelease", () => {
  it("needs a clean screen or a cleared decision", () => {
    expect(screeningAllowsRelease(undefined)).toBe(false);
    expect(screeningAllowsRelease({ outcome: "clear", decision: null })).toBe(true);
    expect(screeningAllowsRelease({ outcome: "potential_match", decision: "cleared" })).toBe(true);
    expect(screeningAllowsRelease({ outcome: "error", decision: "cleared" })).toBe(true);
    expect(screeningAllowsRelease({ outcome: "potential_match", decision: null })).toBe(false);
    expect(screeningAllowsRelease({ outcome: "potential_match", decision: "confirmed" })).toBe(
      false,
    );
    expect(screeningAllowsRelease({ outcome: "error", decision: null })).toBe(false);
  });
});

describe("screeningLiftsSanctions (fix round 3)", () => {
  it("only a real non-match lifts a confirmed match: never an error, cleared or not", () => {
    expect(screeningLiftsSanctions({ outcome: "clear", decision: null })).toBe(true);
    expect(screeningLiftsSanctions({ outcome: "potential_match", decision: "cleared" })).toBe(true);
    expect(screeningLiftsSanctions({ outcome: "error", decision: "cleared" })).toBe(false);
    expect(screeningLiftsSanctions({ outcome: "error", decision: null })).toBe(false);
    expect(screeningLiftsSanctions({ outcome: "potential_match", decision: null })).toBe(false);
    expect(screeningLiftsSanctions({ outcome: "potential_match", decision: "confirmed" })).toBe(
      false,
    );
    expect(screeningLiftsSanctions(undefined)).toBe(false);
  });
});

describe("unsuspendWorkspace (E3.11 R2-11)", () => {
  it("refuses the relocation hold at the function, before touching the database", async () => {
    let touched = false;
    const deps = {
      db: {
        withHost: async () => {
          touched = true;
        },
      },
      audit: {},
      invalidate: () => {},
    } as unknown as PlatformDeps;
    const error = await unsuspendWorkspace(
      deps,
      "01920000-0000-7000-8000-0000000000a1",
      { hold: "relocation" as never },
      { kind: "system", source: "cli" },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).reason).toBe("hold_not_liftable");
    expect(touched).toBe(false);
  });
});
