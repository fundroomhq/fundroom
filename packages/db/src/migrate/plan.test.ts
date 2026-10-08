import { describe, expect, it } from "vitest";
import { parseMigration } from "./parse.js";
import { planMigrations } from "./plan.js";

const mig = (name: string, body = `SELECT '${name}';`) => parseMigration(`${name}.sql`, body);

describe("planMigrations", () => {
  it("applies everything on an empty journal, modules in the given order", () => {
    const plan = planMigrations(
      [
        { module: "core", migrations: [mig("0002_b"), mig("0001_a")] },
        { module: "data-room", migrations: [mig("0001_init")] },
      ],
      [],
    );
    expect(plan.problems).toEqual([]);
    expect(plan.steps.map((s) => `${s.module}/${s.migration.name}`)).toEqual([
      "core/0001_a",
      "core/0002_b",
      "data-room/0001_init",
    ]);
  });

  it("skips applied migrations whose checksum matches", () => {
    const a = mig("0001_a");
    const plan = planMigrations(
      [{ module: "core", migrations: [a, mig("0002_b")] }],
      [{ module: "core", name: "0001_a", checksum: a.checksum }],
    );
    expect(plan.problems).toEqual([]);
    expect(plan.steps.map((s) => s.migration.name)).toEqual(["0002_b"]);
    expect(plan.appliedCount).toBe(1);
  });

  it("reports checksum drift instead of silently re-running or skipping", () => {
    const plan = planMigrations(
      [{ module: "core", migrations: [mig("0001_a", "SELECT 2;")] }],
      [{ module: "core", name: "0001_a", checksum: "sha256:old" }],
    );
    expect(plan.steps).toEqual([]);
    expect(plan.problems).toEqual([
      expect.objectContaining({
        module: "core",
        name: "0001_a",
        problem: expect.stringMatching(/checksum/u),
      }),
    ]);
  });

  it("reports migrations applied in the database but missing on disk", () => {
    const plan = planMigrations(
      [{ module: "core", migrations: [] }],
      [{ module: "core", name: "0001_gone", checksum: "sha256:x" }],
    );
    expect(plan.problems[0]?.problem).toMatch(/missing on disk/u);
  });

  it("refuses out-of-order migrations unless allowed", () => {
    const b = mig("0002_b");
    const applied = [{ module: "core", name: "0002_b", checksum: b.checksum }];
    const modules = [{ module: "core", migrations: [mig("0001_a"), b] }];
    const strict = planMigrations(modules, applied);
    expect(strict.steps).toEqual([]);
    expect(strict.problems[0]?.problem).toMatch(/allow-out-of-order/u);
    const relaxed = planMigrations(modules, applied, { allowOutOfOrder: true });
    expect(relaxed.problems).toEqual([]);
    expect(relaxed.steps.map((s) => s.migration.name)).toEqual(["0001_a"]);
  });

  it("reports duplicate sequence numbers and duplicate modules", () => {
    const plan = planMigrations(
      [
        { module: "core", migrations: [mig("0001_a"), mig("0001_b")] },
        { module: "core", migrations: [] },
      ],
      [],
    );
    expect(plan.problems.map((p) => p.problem)).toEqual([
      expect.stringMatching(/sequence 0001 is also used by 0001_a/u),
      "module listed twice",
    ]);
  });

  it("ignores journal rows for modules that are not loaded (data stays, nothing runs)", () => {
    const plan = planMigrations(
      [{ module: "core", migrations: [] }],
      [{ module: "updates", name: "0001_init", checksum: "sha256:x" }],
    );
    expect(plan.problems).toEqual([]);
    expect(plan.steps).toEqual([]);
  });
});
