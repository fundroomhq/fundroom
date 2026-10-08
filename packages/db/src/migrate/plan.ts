import type { ParsedMigration } from "./parse.js";

export interface AppliedMigration {
  readonly module: string;
  readonly name: string;
  readonly checksum: string;
}

export interface ModuleMigrations {
  /** Module id (`core`, `data-room`, …). Owns one Postgres schema and one journal namespace. */
  readonly module: string;
  readonly migrations: readonly ParsedMigration[];
}

export interface PlannedStep {
  readonly module: string;
  readonly migration: ParsedMigration;
}

export interface PlanProblem {
  readonly module: string;
  readonly name: string;
  readonly problem: string;
}

export interface MigrationPlan {
  readonly steps: readonly PlannedStep[];
  readonly problems: readonly PlanProblem[];
  readonly appliedCount: number;
}

export interface PlanOptions {
  /** Apply a pending migration whose sequence is below the module's newest applied one. Default false. */
  readonly allowOutOfOrder?: boolean;
}

export class MigrationPlanError extends Error {
  override readonly name = "MigrationPlanError";
  constructor(readonly problems: readonly PlanProblem[]) {
    super(
      `Cannot plan migrations:\n${problems.map((p) => `  ${p.module}/${p.name}: ${p.problem}`).join("\n")}`,
    );
  }
}

/**
 * Pure planning: compares journal rows with files on disk, module by module, in the order
 * the modules were given (kernel first, then dependency order from the registry).
 */
export function planMigrations(
  modules: readonly ModuleMigrations[],
  applied: readonly AppliedMigration[],
  options: PlanOptions = {},
): MigrationPlan {
  const steps: PlannedStep[] = [];
  const problems: PlanProblem[] = [];
  const appliedByModule = new Map<string, Map<string, AppliedMigration>>();
  for (const row of applied) {
    const m = appliedByModule.get(row.module) ?? new Map<string, AppliedMigration>();
    m.set(row.name, row);
    appliedByModule.set(row.module, m);
  }

  const seenModules = new Set<string>();
  for (const mod of modules) {
    if (seenModules.has(mod.module)) {
      problems.push({ module: mod.module, name: "*", problem: "module listed twice" });
      continue;
    }
    seenModules.add(mod.module);

    const journal = appliedByModule.get(mod.module) ?? new Map<string, AppliedMigration>();
    const onDisk = new Map<string, ParsedMigration>();
    const seenSeq = new Map<number, string>();
    const sorted = [...mod.migrations].sort((a, b) => a.name.localeCompare(b.name, "en"));

    for (const mig of sorted) {
      const dup = seenSeq.get(mig.sequence);
      if (dup !== undefined) {
        problems.push({
          module: mod.module,
          name: mig.name,
          problem: `sequence ${String(mig.sequence).padStart(4, "0")} is also used by ${dup}`,
        });
      }
      seenSeq.set(mig.sequence, mig.name);
      onDisk.set(mig.name, mig);
    }

    for (const row of journal.values()) {
      if (!onDisk.has(row.name)) {
        problems.push({
          module: mod.module,
          name: row.name,
          problem:
            "applied in the database but missing on disk (migrations are forward-only; restore the file)",
        });
      }
    }

    let newestApplied = -1;
    for (const mig of sorted) {
      if (journal.has(mig.name)) newestApplied = Math.max(newestApplied, mig.sequence);
    }

    for (const mig of sorted) {
      const row = journal.get(mig.name);
      if (row) {
        if (row.checksum !== mig.checksum) {
          problems.push({
            module: mod.module,
            name: mig.name,
            problem: `checksum changed since it was applied (journal ${row.checksum}, file ${mig.checksum}); applied migrations are immutable, add a new one`,
          });
        }
        continue;
      }
      if (mig.sequence < newestApplied && !options.allowOutOfOrder) {
        problems.push({
          module: mod.module,
          name: mig.name,
          problem: `is pending but a newer migration (${String(newestApplied).padStart(4, "0")}) is already applied; renumber it or pass --allow-out-of-order`,
        });
        continue;
      }
      steps.push({ module: mod.module, migration: mig });
    }
  }

  for (const module of appliedByModule.keys()) {
    if (!seenModules.has(module)) {
      // A module that was migrated once but is not loaded now: nothing to do, data stays (design/06 §9).
    }
  }

  return { steps, problems, appliedCount: applied.length };
}
