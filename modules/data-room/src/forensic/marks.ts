import { pgErrorCode, systemContext } from "@fundroom/db";
import { forensicSeed, newForensicToken } from "@fundroom/forensic";
import type { ModuleServices } from "@fundroom/module-kit";
import { ForensicMarkRepo } from "../repos/forensic-repo.js";

/*
 * Forensic mark issuance (E3.13, ADR-0061 §1.6). One `dataroom.forensic_mark` row per (viewer
 * membership, document version): its random token, under the key-ring entry current when it was
 * issued, keys the invisible pattern every page served to that viewer carries.
 *
 * Writes run in a short SYSTEM-context transaction of their own (staff may only read the table,
 * externals see nothing) and never inside a caller's transaction. `last_served_at` moves at most
 * once an hour per row: an in-process memo answers the re-reads of a reading session without
 * touching the database.
 */
export const MARK_TOUCH_MS = 60 * 60_000;
const MEMO_ENTRIES = 10_000;
const ISSUE_ATTEMPTS = 3;

export interface IssuedMark {
  readonly token: Uint8Array;
  readonly keyId: string;
  /** `forensicSeed(patternKey(keyId), token)`: what the renderer embeds. */
  readonly seed: Uint8Array;
}

export interface MarkIssuer {
  issue(
    workspaceId: string,
    membershipId: string,
    documentId: string,
    versionId: string,
    /** Served while `membershipId` (staff) views as this investor: recorded on the mark. */
    viewAsMembershipId?: string | undefined,
  ): Promise<IssuedMark>;
}

interface Memo {
  readonly token: Uint8Array;
  readonly keyId: string;
  readonly touchedAt: number;
}

/** Where marks live; the database by default (a seam for unit tests). */
export interface MarkStore {
  /**
   * Upserts the (membership, version) mark in one system-context transaction: inserts `fresh`
   * on first sight, else moves `last_served_at` to now; re-keys a row whose key `inRing` rejects.
   */
  upsert(
    workspaceId: string,
    row: {
      membershipId: string;
      documentId: string;
      versionId: string;
      viewAsMembershipId?: string | undefined;
    },
    fresh: () => { token: Uint8Array; keyId: string },
    inRing: (keyId: string) => boolean,
  ): Promise<{ token: Uint8Array; keyId: string }>;
}

export function databaseMarkStore(services: Pick<ModuleServices, "db">): MarkStore {
  return {
    upsert(workspaceId, row, fresh, inRing) {
      const sys = systemContext(workspaceId);
      return services.db.withTenant(sys, async (tx) => {
        const repo = new ForensicMarkRepo(sys, tx);
        let mark = await repo.upsertServed({ ...row, ...fresh() });
        if (!inRing(mark.keyId)) {
          // The row's key left the ring: nothing it marked is detectable any more.
          const next = fresh();
          mark = (await repo.rekey(mark.id, next.token, next.keyId)) ?? mark;
        }
        return { token: new Uint8Array(mark.token), keyId: mark.keyId };
      });
    },
  };
}

export function createMarkIssuer(
  services: Pick<ModuleServices, "db" | "forensicKeys" | "now">,
  store: MarkStore = databaseMarkStore(services),
): MarkIssuer {
  const memo = new Map<string, Memo>();
  const inRing = (keyId: string) => services.forensicKeys.get(keyId) !== undefined;
  const fresh = () => ({ token: newForensicToken(), keyId: services.forensicKeys.current().keyId });

  function remember(key: string, value: Memo): void {
    memo.delete(key);
    memo.set(key, value);
    while (memo.size > MEMO_ENTRIES) {
      const oldest = memo.keys().next().value;
      if (oldest === undefined) break;
      memo.delete(oldest);
    }
  }

  async function upsert(
    workspaceId: string,
    membershipId: string,
    documentId: string,
    versionId: string,
    viewAsMembershipId: string | undefined,
  ): Promise<{ token: Uint8Array; keyId: string }> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await store.upsert(
          workspaceId,
          { membershipId, documentId, versionId, viewAsMembershipId },
          fresh,
          inRing,
        );
      } catch (error) {
        // 23505 here can only be the global token uniqueness (64 random bits): draw again.
        if (pgErrorCode(error) !== "23505" || attempt >= ISSUE_ATTEMPTS) throw error;
      }
    }
  }

  return {
    async issue(workspaceId, membershipId, documentId, versionId, viewAsMembershipId) {
      // A view-as serve is its own memo entry, so it is recorded on the row (at most hourly).
      const key = `${workspaceId}:${membershipId}:${versionId}:${viewAsMembershipId ?? ""}`;
      const now = services.now().getTime();
      const hit = memo.get(key);
      let mark: { token: Uint8Array; keyId: string } | undefined;
      if (hit !== undefined && now - hit.touchedAt < MARK_TOUCH_MS && inRing(hit.keyId)) {
        mark = hit;
      } else {
        mark = await upsert(workspaceId, membershipId, documentId, versionId, viewAsMembershipId);
        remember(key, { ...mark, touchedAt: now });
      }
      const patternKey = services.forensicKeys.get(mark.keyId);
      if (patternKey === undefined) throw new Error("forensic key vanished from the key ring");
      return { token: mark.token, keyId: mark.keyId, seed: forensicSeed(patternKey, mark.token) };
    },
  };
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 (no padding). */
export function base32(bytes: Uint8Array): string {
  let out = "";
  let buffer = 0;
  let bits = 0;
  for (const b of bytes) {
    buffer = (buffer << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

export function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** The trace code of a mark: the first 8 base32 characters of its token (40 bits). */
export function traceCode(token: Uint8Array): string {
  return base32(token).slice(0, 8);
}

/** The visible trace line of a forensically marked download. */
export function traceLine(token: Uint8Array): string {
  return `trace ${traceCode(token)}`;
}
