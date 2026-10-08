import type { AnchorReceipt, AnchorVerification, AuditAnchorPort } from "@fundroom/ports";
import { type CheckpointFacts, checkpointCanonical } from "./checkpoint.js";
import { hashFromHex, merkleLeafHash, toHex, verifyMerkleInclusion } from "./merkle.js";

/*
 * Anchor proofs, offline (E3.13, ADR-0061): the leaf of a checkpoint, inclusion-path checks,
 * receipt checks through injected verifiers and the self-contained proof document
 * (`GET /audit/anchors/{checkpointId}/proof`, `fundroom audit verify-anchor`). No database and
 * no adapter imports: the product CLI injects the adapters' offline verifiers.
 */

/** `SHA-256(0x00 || utf8(checkpointCanonical(f)))`. */
export function checkpointLeafHash(f: CheckpointFacts): Uint8Array {
  return merkleLeafHash(Buffer.from(checkpointCanonical(f), "utf8"));
}

/** `GET /audit/anchors/{id}/proof` and `fundroom audit verify-anchor`: self-contained, offline. */
export interface AnchorProofDocument {
  readonly checkpoint: {
    readonly workspace_id: string;
    readonly seq: number;
    readonly hash: string;
    readonly event_id: string;
    readonly head_occurred_at: string;
    readonly previous_checkpoint_id: string | null;
  };
  readonly leafHash: string;
  readonly leafIndex: number;
  readonly path: readonly string[];
  readonly treeSize: number;
  readonly root: string;
  readonly receipts: readonly AnchorReceipt[];
}

/** A driver's offline `verify`, injectable without the adapter (export bundles, the CLI). */
export type AnchorVerifier = AuditAnchorPort["verify"];

export interface ReceiptCheck {
  readonly kind: string;
  readonly reference: string;
  /** `unchecked`: no verifier for this kind was available. */
  readonly status: AnchorVerification["status"] | "unchecked";
  readonly detail?: string;
  /** The time the anchor asserts (when the receipt verified), trusted or not. */
  readonly anchoredAt?: string;
  /**
   * The anchor time when it is TRUSTED: the receipt verified against a pinned signer AND its time
   * is signed by that signer (RFC 3161 genTime). A Rekor v2 receipt proves presence in a public
   * log, never when (its `anchoredAt` is the submitter's clock), so it is always null there.
   */
  readonly trustedTime: string | null;
}

/** Whether a verified result's time is signed evidence (`timeTrusted`, default: rfc3161 only). */
function timeIsTrusted(kind: string, v: AnchorVerification): boolean {
  if (v.status !== "verified") return false;
  // Stricter than the port's "trusted unless false": a driver that does not say is not trusted,
  // except RFC 3161, whose genTime is signed by definition.
  return v.timeTrusted ?? kind === "rfc3161";
}

/** How long after a checkpoint its first trusted anchor time may be before it is `anchor_late`. */
export const ANCHOR_LATE_DAYS = 8;

/**
 * One checkpoint's anchor state from its receipt checks:
 *  - `failed`         a receipt failed;
 *  - `inconsistent`   the checkpoint's head time is AFTER the trusted anchor time (beyond
 *                     ANCHOR_CLOCK_SLACK_MS): impossible for a genuine checkpoint (`anchor_inconsistent`);
 *  - `time_verified`  ≥ 1 trusted time, the earliest within ANCHOR_LATE_DAYS of the checkpoint;
 *  - `late`           trusted time, but later than that (only proves existence from then on —
 *                     e.g. history anchored when anchoring was first enabled, or a rewrite);
 *  - `presence_only`  verified receipts, none with a trusted time (Rekor only);
 *  - `unverified_origin` / `unchecked` / `none` (no receipt at all).
 */
export type CheckpointAnchorState =
  | "failed"
  | "inconsistent"
  | "time_verified"
  | "late"
  | "presence_only"
  | "unverified_origin"
  | "unchecked"
  | "none";

/** TSA accuracy plus clock slack: a head time later than the trusted time by more is impossible. */
export const ANCHOR_CLOCK_SLACK_MS = 5 * 60_000;

/**
 * `checkpointTimes[0]` is the head event's time (from the ROW, not the checkpoint's own claim,
 * wherever the row is available); further entries (e.g. the checkpoint's created_at) only count
 * for lateness.
 */
export function checkpointAnchorState(
  checks: readonly ReceiptCheck[],
  checkpointTimes: readonly (Date | null | undefined)[],
): { readonly state: CheckpointAnchorState; readonly trustedTime: string | null } {
  if (checks.some((c) => c.status === "failed")) return { state: "failed", trustedTime: null };
  const trusted = checks
    .map((c) => c.trustedTime)
    .filter((t): t is string => t !== null && !Number.isNaN(Date.parse(t)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  const earliest = trusted[0] ?? null;
  if (earliest !== null) {
    const head = checkpointTimes[0];
    if (
      head instanceof Date &&
      !Number.isNaN(head.getTime()) &&
      head.getTime() > Date.parse(earliest) + ANCHOR_CLOCK_SLACK_MS
    ) {
      return { state: "inconsistent", trustedTime: earliest };
    }
    const limit = ANCHOR_LATE_DAYS * 86_400_000;
    const late = checkpointTimes.some(
      (t) =>
        t instanceof Date &&
        !Number.isNaN(t.getTime()) &&
        Date.parse(earliest) > t.getTime() + limit,
    );
    return { state: late ? "late" : "time_verified", trustedTime: earliest };
  }
  if (checks.some((c) => c.status === "verified"))
    return { state: "presence_only", trustedTime: null };
  if (checks.some((c) => c.status === "unverified_origin"))
    return { state: "unverified_origin", trustedTime: null };
  return { state: checks.length === 0 ? "none" : "unchecked", trustedTime: null };
}

/** Verifies receipts over `root`; a verifier that throws counts as `failed`. */
export async function checkReceipts(
  root: Uint8Array,
  receipts: readonly AnchorReceipt[],
  verifiers: Readonly<Record<string, AnchorVerifier>>,
  trustedPems?: readonly string[],
  trustedOrigins?: readonly string[],
): Promise<ReceiptCheck[]> {
  const out: ReceiptCheck[] = [];
  const pins = {
    ...(trustedPems && trustedPems.length > 0 ? { pems: trustedPems } : {}),
    ...(trustedOrigins && trustedOrigins.length > 0 ? { origins: trustedOrigins } : {}),
  };
  const trusted = Object.keys(pins).length > 0 ? pins : undefined;
  for (const receipt of receipts) {
    const verify = Object.hasOwn(verifiers, receipt.kind) ? verifiers[receipt.kind] : undefined;
    if (!verify) {
      out.push({
        kind: receipt.kind,
        reference: receipt.reference,
        status: "unchecked",
        trustedTime: null,
      });
      continue;
    }
    try {
      const v = await verify(root, receipt, trusted);
      out.push({
        kind: receipt.kind,
        reference: receipt.reference,
        status: v.status,
        ...(v.detail !== undefined ? { detail: v.detail } : {}),
        ...(v.status === "verified" ? { anchoredAt: v.anchoredAt } : {}),
        trustedTime:
          v.status === "verified" && timeIsTrusted(receipt.kind, v) ? v.anchoredAt : null,
      });
    } catch (error) {
      out.push({
        kind: receipt.kind,
        reference: receipt.reference,
        status: "failed",
        detail: error instanceof Error ? error.message : String(error),
        trustedTime: null,
      });
    }
  }
  return out;
}

/** Path check for one stored or exported inclusion proof; `null` = valid, else the reason. */
export function inclusionProblem(
  leaf: Uint8Array,
  claimed: { readonly leafHash: unknown; readonly path: unknown; readonly treeSize: unknown },
  leafIndex: unknown,
  root: Uint8Array,
  expectedTreeSize?: number,
): string | null {
  const claimedLeaf = hashFromHex(claimed.leafHash);
  if (!claimedLeaf || toHex(claimedLeaf) !== toHex(leaf)) {
    return "the checkpoint's leaf hash differs from the anchored leaf";
  }
  if (!Array.isArray(claimed.path)) return "the inclusion path is malformed";
  const path: Uint8Array[] = [];
  for (const h of claimed.path) {
    const b = hashFromHex(h);
    if (!b) return "the inclusion path is malformed";
    path.push(b);
  }
  if (typeof claimed.treeSize !== "number" || typeof leafIndex !== "number") {
    return "the tree size or leaf index is malformed";
  }
  if (expectedTreeSize !== undefined && claimed.treeSize !== expectedTreeSize) {
    return `the proof's tree size ${claimed.treeSize} differs from the batch's ${expectedTreeSize} leaves`;
  }
  if (!verifyMerkleInclusion(leaf, leafIndex, claimed.treeSize, path, root)) {
    return "the inclusion path does not lead to the anchored root";
  }
  return null;
}

/**
 * `verified`: path holds and a trusted anchor time is within ANCHOR_LATE_DAYS of the checkpoint;
 * `late`: trusted time, but later; `presence_only`: in a public log, no trusted time;
 * `unverified_origin`: no receipt verified against a pinned signer; `failed`.
 */
export type ProofVerdict = "verified" | "late" | "presence_only" | "unverified_origin" | "failed";

export interface AnchorProofVerification {
  readonly verdict: ProofVerdict;
  /** The earliest trusted anchor time (ISO), or null. */
  readonly trustedTime: string | null;
  readonly problems: readonly string[];
  readonly receipts: readonly ReceiptCheck[];
  readonly checkpoint: AnchorProofDocument["checkpoint"] | null;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parses canonical checkpoint facts back from a proof's `checkpoint` object; null if malformed. */
function factsFromCanonical(c: unknown): CheckpointFacts | null {
  if (!isObject(c)) return null;
  const at = typeof c["head_occurred_at"] === "string" ? new Date(c["head_occurred_at"]) : null;
  if (
    typeof c["workspace_id"] !== "string" ||
    typeof c["seq"] !== "number" ||
    typeof c["hash"] !== "string" ||
    typeof c["event_id"] !== "string" ||
    !at ||
    Number.isNaN(at.getTime()) ||
    !(c["previous_checkpoint_id"] === null || typeof c["previous_checkpoint_id"] === "string")
  ) {
    return null;
  }
  return {
    workspaceId: c["workspace_id"],
    seq: c["seq"],
    hash: c["hash"],
    eventId: c["event_id"],
    headOccurredAt: at,
    previousCheckpointId: c["previous_checkpoint_id"] as string | null,
  };
}

/**
 * Offline check of a proof document (from the proof route): the leaf is recomputed from the
 * canonical checkpoint (re-serialised, so a doctored field changes it), the path must lead to the
 * root, and the receipts are checked over the root. `verified` needs at least one verified
 * receipt and no failed one; `unverified_origin` when the path holds but no receipt could be
 * verified against a pinned signer (or there is none); `failed` otherwise. Never throws.
 */
export async function verifyAnchorProof(
  doc: unknown,
  options: {
    readonly verifiers: Readonly<Record<string, AnchorVerifier>>;
    readonly trustedPems?: readonly string[] | undefined;
    /** Pinned Rekor checkpoint origins (`--rekor-origin`). */
    readonly trustedOrigins?: readonly string[] | undefined;
  },
): Promise<AnchorProofVerification> {
  const problems: string[] = [];
  const fail = (p: string): AnchorProofVerification => ({
    verdict: "failed",
    trustedTime: null,
    problems: [...problems, p],
    receipts: [],
    checkpoint: null,
  });
  if (!isObject(doc)) return fail("the proof is not a JSON object");
  const facts = factsFromCanonical(doc["checkpoint"]);
  if (!facts) return fail("the proof's checkpoint is malformed");
  const root = hashFromHex(doc["root"]);
  if (!root) return fail("the proof's root is malformed");
  const leaf = checkpointLeafHash(facts);
  const path = inclusionProblem(
    leaf,
    { leafHash: doc["leafHash"], path: doc["path"], treeSize: doc["treeSize"] },
    doc["leafIndex"],
    root,
  );
  if (path) problems.push(`anchor_path_invalid: ${path}`);
  const rawReceipts = Array.isArray(doc["receipts"]) ? doc["receipts"] : [];
  const receipts: AnchorReceipt[] = [];
  for (const r of rawReceipts) {
    if (
      isObject(r) &&
      typeof r["kind"] === "string" &&
      typeof r["reference"] === "string" &&
      typeof r["anchoredAt"] === "string" &&
      isObject(r["proof"])
    ) {
      receipts.push({
        kind: r["kind"],
        reference: r["reference"],
        anchoredAt: r["anchoredAt"],
        proof: r["proof"],
      });
    } else {
      problems.push("anchor_receipt_failed: a receipt is malformed");
    }
  }
  const checks = await checkReceipts(
    root,
    receipts,
    options.verifiers,
    options.trustedPems,
    options.trustedOrigins,
  );
  for (const c of checks) {
    if (c.status === "failed") {
      problems.push(`anchor_receipt_failed: ${c.kind} (${c.reference}): ${c.detail ?? "failed"}`);
    }
  }
  const checkpoint = JSON.parse(checkpointCanonical(facts)) as AnchorProofDocument["checkpoint"];
  const { state, trustedTime } = checkpointAnchorState(checks, [facts.headOccurredAt]);
  if (state === "inconsistent") {
    problems.push(
      `anchor_inconsistent: the checkpoint's head (${facts.headOccurredAt.toISOString()}) is later than its trusted anchor time ${trustedTime}`,
    );
  }
  if (state === "late") {
    problems.push(
      `anchor_late: the earliest trusted anchor time ${trustedTime} is more than ${ANCHOR_LATE_DAYS} days after the checkpoint's head (${facts.headOccurredAt.toISOString()})`,
    );
  }
  const verdict: ProofVerdict = problems.some((p) => !p.startsWith("anchor_late"))
    ? "failed"
    : state === "time_verified"
      ? "verified"
      : state === "late"
        ? "late"
        : state === "presence_only"
          ? "presence_only"
          : "unverified_origin";
  return { verdict, trustedTime, problems, receipts: checks, checkpoint };
}

export const ANCHOR_PROOF_EXIT = { verified: 0, failed: 1, unverifiedOrigin: 3 } as const;

/** 0 verified (trusted time, on time), 1 failed, 3 anything weaker (late, presence-only, unpinned). */
export function anchorProofExitCode(v: AnchorProofVerification): number {
  if (v.verdict === "failed") return ANCHOR_PROOF_EXIT.failed;
  return v.verdict === "verified" ? ANCHOR_PROOF_EXIT.verified : ANCHOR_PROOF_EXIT.unverifiedOrigin;
}

/** One receipt as a line: status, the time it asserts and whether that time is trusted. */
export function formatReceiptCheck(r: ReceiptCheck): string {
  const time =
    r.trustedTime !== null
      ? ` existed by ${r.trustedTime} (${r.kind} signed time)`
      : r.status === "verified"
        ? " present in log, no trusted time"
        : "";
  return `${r.kind.padEnd(8)} ${r.status}${time}  ${r.reference}${r.detail ? ` — ${r.detail}` : ""}`;
}

export function formatAnchorProofVerification(v: AnchorProofVerification): string {
  const lines: string[] = [];
  if (v.checkpoint) {
    lines.push(
      `checkpoint workspace ${v.checkpoint.workspace_id} seq ${v.checkpoint.seq} (head ${v.checkpoint.head_occurred_at})`,
    );
  }
  for (const r of v.receipts) lines.push(`  ${formatReceiptCheck(r)}`);
  for (const p of v.problems) lines.push(`  - ${p}`);
  if (v.verdict === "verified")
    lines.push(`OK   anchored: the checkpoint existed by ${v.trustedTime} (trusted time-stamp)`);
  else if (v.verdict === "late")
    lines.push(
      `ANCHORED LATE — the earliest trusted time-stamp (${v.trustedTime}) is more than ${ANCHOR_LATE_DAYS} days after the checkpoint: it proves the checkpoint existed from then on, not when it claims.`,
    );
  else if (v.verdict === "presence_only")
    lines.push(
      "PRESENT IN LOG, NO TRUSTED TIME — the root is in a public transparency log, but no receipt carries a time signed by a pinned authority (Rekor asserts no time). Add an RFC 3161 time-stamp authority for time evidence.",
    );
  else if (v.verdict === "unverified_origin")
    lines.push(
      "UNVERIFIED ORIGIN — the inclusion path holds, but no receipt verified against a pinned signer. Re-run with --anchor-cert <TSA cert / Rekor log key PEM>.",
    );
  else lines.push("FAIL anchor proof did not verify");
  return lines.join("\n");
}
