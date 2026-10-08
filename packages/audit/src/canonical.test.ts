import { describe, expect, it } from "vitest";
import { parseCanonical, sha256Hex, verifyExportedChain } from "./canonical.js";

/** Builds a chain the way Postgres does: hash = sha256(canonical), canonical embeds prev_hash. */
function chain(n: number, start = 1, prev: string | null = null) {
  const rows = [];
  let p = prev;
  for (let seq = start; seq < start + n; seq++) {
    const canonical = JSON.stringify({
      id: `0192000-${seq}`,
      seq,
      action: "auth.login",
      prev_hash: p,
      occurred_at: "2026-09-11T10:00:00.000000Z",
      workspace_id: "ws",
    });
    const hash = sha256Hex(canonical);
    rows.push({ seq, canonical, hash });
    p = hash;
  }
  return rows;
}

describe("verifyExportedChain", () => {
  it("accepts a clean chain and reports the head", () => {
    const rows = chain(5);
    const r = verifyExportedChain(rows);
    expect(r).toEqual({ ok: true, checked: 5, headHash: rows[4]?.hash });
  });

  it("accepts bytes for the hash column", () => {
    const rows = chain(2).map((r) => ({ ...r, hash: Buffer.from(r.hash, "hex") }));
    expect(verifyExportedChain(rows).ok).toBe(true);
  });

  it("detects an altered row", () => {
    const rows = chain(3);
    const tampered = rows.map((r) =>
      r.seq === 2 ? { ...r, canonical: r.canonical.replace("auth.login", "auth.logout") } : r,
    );
    const r = verifyExportedChain(tampered);
    expect(r.ok).toBe(false);
    expect(r.problem).toEqual({ seq: 2, reason: "hash mismatch (row altered)" });
    expect(r.checked).toBe(1);
  });

  it("detects a re-chained row (hash recomputed but prev broken)", () => {
    const rows = chain(3);
    const forged = JSON.stringify({ ...JSON.parse(rows[1]?.canonical ?? ""), action: "x.y" });
    const tampered = [rows[0], { seq: 2, canonical: forged, hash: sha256Hex(forged) }, rows[2]];
    const r = verifyExportedChain(tampered as never);
    expect(r.ok).toBe(false);
    expect(r.problem?.seq).toBe(3);
    expect(r.problem?.reason).toMatch(/prev_hash/u);
  });

  it("detects a removed row (gap) and a duplicated row", () => {
    const rows = chain(4);
    const gap = verifyExportedChain([rows[0], rows[2], rows[3]] as never);
    expect(gap.problem).toEqual({ seq: 3, reason: "expected seq 2" });
    const dup = verifyExportedChain([rows[0], rows[1], rows[1], rows[2]] as never);
    expect(dup.problem?.seq).toBe(2);
  });

  it("verifies a slice given the hash before it", () => {
    const rows = chain(6);
    const slice = rows.slice(3);
    expect(verifyExportedChain(slice, { expectedPrevHash: rows[2]?.hash ?? null }).ok).toBe(true);
    expect(verifyExportedChain(slice, { expectedPrevHash: rows[1]?.hash ?? null }).ok).toBe(false);
    // Without the anchor, a slice is verified for internal consistency only.
    expect(verifyExportedChain(slice).ok).toBe(true);
  });

  it("rejects a slice that claims to start a chain mid-way", () => {
    const rows = chain(3, 4, null);
    expect(verifyExportedChain(rows).problem?.reason).toMatch(/starts after seq 1/u);
  });

  it("rejects canonical text whose embedded seq disagrees with the row", () => {
    const rows = chain(2);
    const r = verifyExportedChain([rows[0], { ...rows[1], seq: 3 }] as never);
    expect(r.problem?.reason).toMatch(/expected seq 2/u);
    const r2 = verifyExportedChain([
      { ...rows[0], seq: 1, canonical: rows[1]?.canonical ?? "" },
    ] as never);
    expect(r2.problem?.reason).toMatch(/canonical seq differs|prev_hash/u);
  });

  it("parseCanonical validates the required fields", () => {
    expect(() => parseCanonical("[]")).toThrow(/not a JSON object/u);
    expect(() => parseCanonical('{"id":"a"}')).toThrow(/lacks/u);
    const f = parseCanonical(chain(1)[0]?.canonical ?? "");
    expect(f.seq).toBe(1);
    expect(f.prev_hash).toBeNull();
  });
});
