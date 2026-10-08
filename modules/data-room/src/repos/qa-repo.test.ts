import { describe, expect, it } from "vitest";
import { decodeQaCursor, encodeQaCursor } from "./qa-repo.js";

describe("Q&A keyset cursor", () => {
  it("round-trips every ORDER BY column at microsecond precision", () => {
    const c = {
      createdAt: "2026-09-25T10:11:12.123456Z",
      id: "0199aa00-0000-7000-8000-000000000001",
    };
    expect(decodeQaCursor(encodeQaCursor(c))).toEqual(c);
  });

  it("rejects anything else", () => {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const raw of [
      "nonsense",
      b64(["2026-01-01T00:00:00Z"]),
      b64(["2026-01-01T00:00:00Z", "not-a-uuid"]),
      b64(["yesterday", "0199aa00-0000-7000-8000-000000000001"]),
      b64({ createdAt: "2026-01-01T00:00:00Z", id: "0199aa00-0000-7000-8000-000000000001" }),
      b64(["2026-01-01T00:00:00Z", "0199aa00-0000-7000-8000-000000000001'; --"]),
      // parseable by Date, but not the µs UTC text the cursor carries
      b64(["2026-01-01T00:00:00Z", "0199aa00-0000-7000-8000-000000000001"]),
      b64(["2026-01-01", "0199aa00-0000-7000-8000-000000000001"]),
      b64(["2026-01-01T00:00:00.123456+05:00", "0199aa00-0000-7000-8000-000000000001"]),
      // the right shape, but not a real time (Postgres would refuse the cast: a 500)
      b64(["2026-02-30T00:00:00.000000Z", "0199aa00-0000-7000-8000-000000000001"]),
      b64(["2026-01-01T25:00:00.000000Z", "0199aa00-0000-7000-8000-000000000001"]),
    ])
      expect(decodeQaCursor(raw)).toBeUndefined();
  });
});
