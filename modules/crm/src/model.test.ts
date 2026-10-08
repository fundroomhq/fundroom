import { readFileSync } from "node:fs";
import { COMMITMENT_STATUSES } from "@fundroom/round-terms";
import { describe, expect, it } from "vitest";
import {
  ACTIVITY_FOR_BOOKING_STATUS,
  ACTIVITY_KINDS,
  CUSTOM_STAGE_PREFIX,
  customStageKey,
  DEFAULT_STAGE_KEYS,
  DEFAULT_STAGES,
  NO_ROUND,
  PROTECTED_STAGE_KEYS,
  STAGE_FOR_COMMITMENT_STATUS,
  STAGE_KEY_RE,
  STAGE_ON_COMMITMENT,
  STAGE_ON_DECLINED,
  STAGE_ON_INTEREST,
  SUBJECT_KINDS,
  TRANSITION_CAUSES,
} from "./model.js";

describe("the default ladder", () => {
  it("is design/03 §82's ten stages, in order", () => {
    expect(DEFAULT_STAGE_KEYS).toEqual([
      "prospect",
      "contacted",
      "meeting",
      "diligence",
      "soft_committed",
      "committed",
      "docs_sent",
      "signed",
      "wired",
      "passed",
    ]);
  });

  it("marks wired and passed terminal, and nothing else", () => {
    expect(DEFAULT_STAGES.filter((s) => s.isTerminal).map((s) => s.key)).toEqual([
      "wired",
      "passed",
    ]);
  });

  it("uses keys the column CHECK admits and names the column can render", () => {
    for (const stage of DEFAULT_STAGES) {
      expect(STAGE_KEY_RE.test(stage.key), stage.key).toBe(true);
      expect(stage.name.length).toBeGreaterThan(0);
      expect(stage.name.length).toBeLessThanOrEqual(80);
    }
  });

  it("is frozen, so nothing can seed a workspace with a mutated ladder", () => {
    expect(Object.isFrozen(DEFAULT_STAGES)).toBe(true);
  });

  /*
   * The protected pair is not an arbitrary choice: it is exactly the stages the commitment
   * mapping lands on that a workspace could otherwise delete and then silently stop recording.
   */
  it("protects the two terminal stages from removal", () => {
    expect(PROTECTED_STAGE_KEYS).toEqual(["wired", "passed"]);
    for (const key of PROTECTED_STAGE_KEYS) expect(DEFAULT_STAGE_KEYS).toContain(key);
  });

  it("names the three stages the handlers land on, and they are all seeded", () => {
    expect([STAGE_ON_INTEREST, STAGE_ON_COMMITMENT, STAGE_ON_DECLINED]).toEqual([
      "contacted",
      "soft_committed",
      "passed",
    ]);
    for (const key of [STAGE_ON_INTEREST, STAGE_ON_COMMITMENT, STAGE_ON_DECLINED]) {
      expect(DEFAULT_STAGE_KEYS).toContain(key);
    }
  });
});

describe("the commitment-status mapping", () => {
  it("covers every status the round module can publish", () => {
    for (const status of COMMITMENT_STATUSES) {
      expect(STAGE_FOR_COMMITMENT_STATUS[status], status).toBeDefined();
    }
  });

  it("lands only on seeded stage keys", () => {
    for (const status of COMMITMENT_STATUSES) {
      expect(DEFAULT_STAGE_KEYS).toContain(STAGE_FOR_COMMITMENT_STATUS[status]);
    }
  });

  /*
   * A withdrawal ends the conversation; it does not rewind it. A board that quietly reset the
   * card to `prospect` would lose the fact that the investor said no.
   */
  it("sends a withdrawal to Passed and a wire to Wired", () => {
    expect(STAGE_FOR_COMMITMENT_STATUS["withdrawn"]).toBe("passed");
    expect(STAGE_FOR_COMMITMENT_STATUS["wired"]).toBe("wired");
    expect(STAGE_FOR_COMMITMENT_STATUS["soft"]).toBe("soft_committed");
    expect(STAGE_FOR_COMMITMENT_STATUS["verbal"]).toBe("committed");
    expect(STAGE_FOR_COMMITMENT_STATUS["signed"]).toBe("signed");
  });

  it("answers undefined for a status it does not know, so a handler can no-op", () => {
    expect(STAGE_FOR_COMMITMENT_STATUS["rescinded"]).toBeUndefined();
  });
});

describe("customStageKey", () => {
  it("slugifies a name under the custom prefix", () => {
    expect(customStageKey("Second meeting")).toBe("custom_second_meeting");
    expect(customStageKey("  IC review  ")).toBe("custom_ic_review");
  });

  /*
   * Always prefixed, never bare. A tenant's "Committed" must not collide with the seeded
   * `committed`, and a later release must be free to add a seeded key without discovering that
   * three workspaces already took the name.
   */
  it("cannot mint a seeded key", () => {
    for (const key of DEFAULT_STAGE_KEYS) {
      expect(customStageKey(key)).not.toBe(key);
      expect(customStageKey(key).startsWith(CUSTOM_STAGE_PREFIX)).toBe(true);
    }
  });

  it("still produces a valid key from a name with nothing usable in it", () => {
    expect(customStageKey("🎯 ——")).toBe("custom_stage");
    expect(customStageKey("")).toBe("custom_stage");
  });

  it("truncates a long name rather than producing a key the CHECK refuses", () => {
    const key = customStageKey("a".repeat(200));
    expect(key.length).toBeLessThanOrEqual(63);
    expect(STAGE_KEY_RE.test(key)).toBe(true);
  });

  it("produces a valid key for every shape we can think of", () => {
    const names = [
      "Warm intro",
      "2nd call",
      "Legal / diligence",
      "Términos",
      "___",
      "9 lives",
      "ALL CAPS NAME",
    ];
    for (const name of names) {
      expect(STAGE_KEY_RE.test(customStageKey(name)), name).toBe(true);
    }
  });
});

describe("vocabularies", () => {
  it("names the three polymorphic subjects", () => {
    expect(SUBJECT_KINDS).toEqual(["contact", "organization", "pipeline_item"]);
  });

  it("names every cause a transition can carry", () => {
    expect(TRANSITION_CAUSES).toEqual([
      "staff",
      "interest_submitted",
      "interest_decided",
      "commitment_created",
      "commitment_changed",
    ]);
  });

  /** The sentinel has to be unmistakable for a round id, or a card could go missing. */
  it("uses a no-round sentinel that cannot be a uuid", () => {
    expect(NO_ROUND).toBe("none");
    expect(/^[0-9a-f]{8}-/iu.test(NO_ROUND)).toBe(false);
  });
});

describe("activity vocabulary (E3.6)", () => {
  it("matches the activity_kind CHECK exactly", () => {
    const sqlText = readFileSync(
      new URL("../migrations/0002_activity.sql", import.meta.url),
      "utf8",
    );
    const line =
      sqlText.split("\n").find((l) => l.includes("CONSTRAINT activity_kind CHECK")) ?? "";
    expect([...line.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]).sort()).toEqual(
      [...ACTIVITY_KINDS].sort(),
    );
  });

  it("maps every booking status onto its own kind", () => {
    const kinds = Object.values(ACTIVITY_FOR_BOOKING_STATUS);
    expect(new Set(kinds).size).toBe(3);
    expect(Object.keys(ACTIVITY_FOR_BOOKING_STATUS).sort()).toEqual([
      "booked",
      "cancelled",
      "rescheduled",
    ]);
  });
});
