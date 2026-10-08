import { describe, expect, it } from "vitest";
import {
  anchorProofExitCode,
  checkpointLeafHash,
  formatAnchorProofVerification,
  verifyAnchorProof,
} from "./anchor-proof.js";
import { type CheckpointFacts, checkpointCanonical } from "./checkpoint.js";
import { buildMerkleTree, merkleLeafHash, toHex } from "./merkle.js";
import { createFakeAnchor } from "./testing/fake-anchor.js";

const facts: CheckpointFacts = {
  workspaceId: "0190f1a0-0000-7000-8000-000000000001",
  seq: 42,
  hash: "ab".repeat(32),
  eventId: "0190f1a0-0000-7000-8000-0000000000ee",
  headOccurredAt: new Date("2026-09-30T02:09:59.123Z"),
  previousCheckpointId: null,
};

async function proof(fake: Parameters<typeof createFakeAnchor>[0] = {}) {
  const leaf = checkpointLeafHash(facts);
  const tree = buildMerkleTree([
    merkleLeafHash(Buffer.from("other workspace 1")),
    leaf,
    merkleLeafHash(Buffer.from("other workspace 2")),
  ]);
  // The day after the checkpoint's head: on time.
  const tsa = createFakeAnchor({
    kind: "rfc3161",
    now: () => new Date("2026-10-01T00:00:00.000Z"),
    ...fake,
  });
  const receipt = await tsa.anchor(tree.root);
  return {
    doc: {
      checkpoint: JSON.parse(checkpointCanonical(facts)),
      leafHash: toHex(leaf),
      leafIndex: 1,
      path: (tree.paths[1] ?? []).map(toHex),
      treeSize: 3,
      root: toHex(tree.root),
      receipts: [receipt],
    },
    verifiers: { rfc3161: tsa.verify },
  };
}

describe("checkpointLeafHash", () => {
  it("is SHA-256(0x00 || canonical checkpoint)", () => {
    expect(toHex(checkpointLeafHash(facts))).toBe(
      toHex(merkleLeafHash(Buffer.from(checkpointCanonical(facts), "utf8"))),
    );
  });
});

describe("verifyAnchorProof", () => {
  it("verified with a trusted receipt (exit 0)", async () => {
    const { doc, verifiers } = await proof();
    const v = await verifyAnchorProof(doc, { verifiers });
    expect(v.verdict).toBe("verified");
    expect(anchorProofExitCode(v)).toBe(0);
    expect(v.trustedTime).toBe("2026-10-01T00:00:00.000Z");
    expect(formatAnchorProofVerification(v)).toContain(
      "OK   anchored: the checkpoint existed by 2026-10-01T00:00:00.000Z",
    );
  });

  it("a trusted time more than 8 days after the head is ANCHORED LATE (exit 3)", async () => {
    const { doc, verifiers } = await proof({ now: () => new Date("2026-10-09T03:00:00.000Z") });
    const v = await verifyAnchorProof(doc, { verifiers });
    expect(v.verdict).toBe("late");
    expect(anchorProofExitCode(v)).toBe(3);
    expect(v.problems[0]).toMatch(/^anchor_late: /u);
    expect(formatAnchorProofVerification(v)).toContain("ANCHORED LATE");
  });

  it("a verified receipt without a trusted time is presence only (exit 3), never 'existed by'", async () => {
    const { doc, verifiers } = await proof({ timeTrusted: false });
    const v = await verifyAnchorProof(doc, { verifiers });
    expect(v.verdict).toBe("presence_only");
    expect(anchorProofExitCode(v)).toBe(3);
    const text = formatAnchorProofVerification(v);
    expect(text).toContain("present in log, no trusted time");
    expect(text).not.toContain("existed by");
  });

  it("unverified origin when the signer is not pinned or no verifier exists (exit 3)", async () => {
    const { doc, verifiers } = await proof();
    const pinned = await verifyAnchorProof(doc, { verifiers, trustedPems: ["someone"] });
    expect(pinned.verdict).toBe("unverified_origin");
    expect(anchorProofExitCode(pinned)).toBe(3);
    expect((await verifyAnchorProof(doc, { verifiers: {} })).verdict).toBe("unverified_origin");
    expect((await verifyAnchorProof({ ...doc, receipts: [] }, { verifiers })).verdict).toBe(
      "unverified_origin",
    );
  });

  it("fails on a doctored checkpoint, path, root or receipt (exit 1); never throws", async () => {
    const { doc, verifiers } = await proof();
    const cases: unknown[] = [
      { ...doc, checkpoint: { ...doc.checkpoint, seq: 43 } },
      { ...doc, leafIndex: 0 },
      { ...doc, path: [...doc.path].reverse() },
      { ...doc, root: "00".repeat(32) },
      {
        ...doc,
        receipts: [{ ...doc.receipts[0], proof: { ...doc.receipts[0]?.proof, mac: "00" } }],
      },
      { ...doc, receipts: ["junk"] },
      { ...doc, checkpoint: "nope" },
      null,
      "text",
    ];
    for (const c of cases) {
      const v = await verifyAnchorProof(c, { verifiers });
      expect(v.verdict, JSON.stringify(c)?.slice(0, 80)).toBe("failed");
      expect(anchorProofExitCode(v)).toBe(1);
    }
  });

  it("a verifier that throws counts as failed", async () => {
    const { doc } = await proof();
    const v = await verifyAnchorProof(doc, {
      verifiers: {
        rfc3161: () => {
          throw new Error("boom");
        },
      },
    });
    expect(v.verdict).toBe("failed");
  });
});
