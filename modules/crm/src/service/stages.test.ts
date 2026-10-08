import { describe, expect, it } from "vitest";
import { CrmError } from "../errors.js";
import { DEFAULT_STAGES } from "../model.js";
import type { StageRow } from "../repos/crm-repo.js";
import { resolveLadder, type StageEntry } from "./stages.js";

/*
 * `PUT /crm/stages` without a database. Everything that can refuse a ladder — an id that is not
 * a stage of this workspace, a key that is not a key, two entries claiming one key, a seeded
 * terminal stage somebody tried to delete — is decided by `resolveLadder`, and none of it needs
 * Postgres to be true.
 */

const epoch = new Date("2026-01-01T00:00:00.000Z");

const existing: StageRow[] = DEFAULT_STAGES.map((s, i) => ({
  id: `0192f1a0-0000-7000-8000-00000000${String(i).padStart(4, "0")}`,
  key: s.key,
  name: s.name,
  position: i + 1,
  isTerminal: s.isTerminal,
  createdAt: epoch,
  updatedAt: epoch,
}));

const byKey = (key: string): StageRow => {
  const row = existing.find((s) => s.key === key);
  if (row === undefined) throw new Error(`no seeded stage ${key}`);
  return row;
};

/** The whole seeded ladder resubmitted unchanged — the no-op every screen sends on save. */
const asEntries = (rows: readonly StageRow[]): StageEntry[] =>
  rows.map((s) => ({ id: s.id, name: s.name, isTerminal: s.isTerminal }));

const failure = (entries: StageEntry[]): CrmError => {
  try {
    resolveLadder(entries, existing);
  } catch (error) {
    if (error instanceof CrmError) return error;
    throw error;
  }
  throw new Error("expected resolveLadder to refuse");
};

describe("resolveLadder", () => {
  it("keeps every id and numbers the ladder 1..n in array order", () => {
    const { writes, removed } = resolveLadder(asEntries(existing), existing);
    expect(writes.map((w) => w.id)).toEqual(existing.map((s) => s.id));
    expect(writes.map((w) => w.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(removed).toEqual([]);
  });

  it("renumbers a reordered ladder without touching keys", () => {
    const reordered = [...existing].reverse();
    const { writes } = resolveLadder(asEntries(reordered), existing);
    expect(writes.map((w) => w.key)).toEqual(reordered.map((s) => s.key));
    expect(writes.map((w) => w.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("renames a stage and leaves its key alone", () => {
    const entries = asEntries(existing);
    entries[4] = { id: byKey("soft_committed").id, name: "  Circled  ", isTerminal: false };
    const { writes } = resolveLadder(entries, existing);
    expect(writes[4]).toMatchObject({ key: "soft_committed", name: "Circled", position: 5 });
  });

  /*
   * A key is other people's stored data — the event handlers address `soft_committed` by it —
   * so a body that sends one for a *kept* stage is ignored rather than honoured. Renaming is
   * what this route is for; re-keying would be a migration.
   */
  it("ignores a key sent for a stage that is being kept", () => {
    const entries = asEntries(existing);
    entries[0] = { id: byKey("prospect").id, key: "lead", name: "Lead", isTerminal: false };
    const { writes } = resolveLadder(entries, existing);
    expect(writes[0]?.key).toBe("prospect");
  });

  it("mints custom_<slug> for a new stage with no key", () => {
    const entries = [...asEntries(existing), { name: "IC review", isTerminal: false }];
    const { writes } = resolveLadder(entries, existing);
    expect(writes.at(-1)).toEqual({
      key: "custom_ic_review",
      name: "IC review",
      isTerminal: false,
      position: 11,
    });
    expect(writes.at(-1)).not.toHaveProperty("id");
  });

  it("honours an explicit key on a new stage", () => {
    const entries = [...asEntries(existing), { key: "custom_ic", name: "IC", isTerminal: false }];
    const { writes } = resolveLadder(entries, existing);
    expect(writes.at(-1)?.key).toBe("custom_ic");
  });

  it("reports the stages the body left out", () => {
    const entries = asEntries(existing.filter((s) => s.key !== "meeting"));
    const { writes, removed } = resolveLadder(entries, existing);
    expect(removed.map((s) => s.key)).toEqual(["meeting"]);
    expect(writes).toHaveLength(9);
    expect(writes.map((w) => w.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("refuses an empty ladder", () => {
    const error = failure([]);
    expect(error.code).toBe("validation_failed");
    expect(error.details["field"]).toBe("stages");
  });

  it("refuses an id that is not a stage of this workspace", () => {
    const error = failure([
      { id: "0192f1a0-9999-7000-8000-999999999999", name: "Ghost", isTerminal: false },
    ]);
    expect(error.code).toBe("validation_failed");
    expect(error.details["field"]).toBe("id");
  });

  it("refuses the same stage twice", () => {
    const first = byKey("prospect");
    const error = failure([
      { id: first.id, name: "Prospect", isTerminal: false },
      { id: first.id, name: "Prospect again", isTerminal: false },
      ...asEntries(existing.filter((s) => s.id !== first.id)),
    ]);
    expect(error.code).toBe("validation_failed");
    expect(error.details["field"]).toBe("id");
  });

  it("refuses two new stages claiming one key", () => {
    const error = failure([
      ...asEntries(existing),
      { key: "custom_ic", name: "IC", isTerminal: false },
      { key: "custom_ic", name: "IC again", isTerminal: false },
    ]);
    expect(error.code).toBe("validation_failed");
    expect(error.details["key"]).toBe("custom_ic");
  });

  it("refuses a new stage whose key collides with a kept one", () => {
    const error = failure([
      ...asEntries(existing),
      { key: "prospect", name: "Prospect (new)", isTerminal: false },
    ]);
    expect(error.code).toBe("validation_failed");
    expect(error.details["key"]).toBe("prospect");
  });

  it("refuses a key the column CHECK would refuse", () => {
    const error = failure([
      ...asEntries(existing),
      { key: "IC Review", name: "IC", isTerminal: false },
    ]);
    expect(error.code).toBe("validation_failed");
    expect(error.details["field"]).toBe("key");
  });

  it("refuses a nameless stage", () => {
    const error = failure([...asEntries(existing), { name: "   ", isTerminal: false }]);
    expect(error.code).toBe("validation_failed");
    expect(error.details["field"]).toBe("name");
  });

  /*
   * The two the commitment-status mapping lands on. The handlers no-op when a stage is missing
   * rather than throwing, which is exactly why this refusal has to exist: a workspace that had
   * deleted `passed` would silently stop recording withdrawals, and nobody would notice.
   */
  it("refuses to remove Wired or Passed", () => {
    for (const key of ["wired", "passed"]) {
      const error = failure(asEntries(existing.filter((s) => s.key !== key)));
      expect(error.code, key).toBe("conflict");
      expect(error.details["reason"]).toBe("stage_protected");
      expect(error.details["key"]).toBe(key);
    }
  });

  it("allows a ladder that removes several ordinary stages at once", () => {
    const keep = existing.filter((s) => !["meeting", "diligence", "docs_sent"].includes(s.key));
    const { writes, removed } = resolveLadder(asEntries(keep), existing);
    expect(removed.map((s) => s.key).sort()).toEqual(["diligence", "docs_sent", "meeting"]);
    expect(writes).toHaveLength(7);
  });

  it("lets a tenant start over with a ladder of their own, keeping the terminal pair", () => {
    const entries: StageEntry[] = [
      { name: "Lead", isTerminal: false },
      { name: "Pitched", isTerminal: false },
      { id: byKey("wired").id, name: "Funded", isTerminal: true },
      { id: byKey("passed").id, name: "Passed", isTerminal: true },
    ];
    const { writes, removed } = resolveLadder(entries, existing);
    expect(writes.map((w) => w.key)).toEqual(["custom_lead", "custom_pitched", "wired", "passed"]);
    expect(removed).toHaveLength(8);
  });
});
