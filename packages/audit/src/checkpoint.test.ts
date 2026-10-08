import { randomBytes } from "node:crypto";
import { parseKeyRing } from "@fundroom/config";
import { describe, expect, it } from "vitest";
import {
  type CheckpointFacts,
  checkpointCanonical,
  signCheckpoint,
  verifyCheckpointSignature,
} from "./checkpoint.js";

function ring(ids: string[]) {
  const raw = ids.map((id) => `${id}:${randomBytes(32).toString("base64")}`).join(",");
  const r = parseKeyRing(raw);
  if (!r.ok) throw new Error("bad ring");
  return r.ring;
}

const facts: CheckpointFacts = {
  workspaceId: "01920000-0000-7000-8000-000000000001",
  seq: 42,
  hash: "AB".repeat(32),
  eventId: "01920000-0000-7000-8000-000000000002",
  headOccurredAt: new Date("2026-09-11T02:10:00Z"),
  previousCheckpointId: null,
};

describe("checkpoint signatures", () => {
  it("canonical form is stable and lower-cases the hash", () => {
    expect(checkpointCanonical(facts)).toBe(
      '{"workspace_id":"01920000-0000-7000-8000-000000000001","seq":42,"hash":"' +
        "ab".repeat(32) +
        '","event_id":"01920000-0000-7000-8000-000000000002","head_occurred_at":"2026-09-11T02:10:00.000Z","previous_checkpoint_id":null}',
    );
  });

  it("signs with the current key and verifies by key id", () => {
    const r = ring(["v1"]);
    const { keyId, signature } = signCheckpoint(r, facts);
    expect(keyId).toBe("v1");
    expect(signature).toHaveLength(32);
    expect(verifyCheckpointSignature(r, facts, keyId, signature)).toBe(true);
    expect(verifyCheckpointSignature(r, { ...facts, seq: 43 }, keyId, signature)).toBe(false);
    expect(verifyCheckpointSignature(ring(["v1"]), facts, keyId, signature)).toBe(false);
  });

  it("survives key rotation: old checkpoints verify with the retired key still in the ring", () => {
    const old = ring(["v1"]);
    const sig = signCheckpoint(old, facts);
    const rotatedRaw = `v2:${randomBytes(32).toString("base64")},v1:${Buffer.from(old.current.key).toString("base64")}`;
    const rotated = parseKeyRing(rotatedRaw);
    if (!rotated.ok) throw new Error("bad ring");
    expect(verifyCheckpointSignature(rotated.ring, facts, "v1", sig.signature)).toBe(true);
    // Unknown key id: every entry is tried.
    expect(verifyCheckpointSignature(rotated.ring, facts, null, sig.signature)).toBe(true);
    expect(verifyCheckpointSignature(rotated.ring, facts, "v9", sig.signature)).toBe(true);
  });
});
