/**
 * One actionable problem with the environment. `key` is the env var name
 * (or a pseudo-key like `SECRET_KEY_RING|FUNDROOM_SECRET_KEY` for cross-field rules).
 */
export interface ConfigIssue {
  readonly key: string;
  readonly message: string;
  readonly example?: string;
}

/**
 * Thrown by `loadConfig()` when the environment is invalid. Carries every issue
 * found, not just the first, so an operator fixes the env in one round trip.
 */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    super(formatConfigIssues(issues));
    this.issues = issues;
  }
}

/**
 * Renders issues grouped by key, one line per problem, with an example when we have one.
 *
 *   Invalid configuration (2 problems):
 *     DATABASE_URL: required. Example: postgres://seedhost:secret@db:5432/seedhost
 *     BASE_URL: must use https in APP_ENV=prod. Example: https://investors.example.com
 */
export function formatConfigIssues(issues: readonly ConfigIssue[]): string {
  const byKey = new Map<string, ConfigIssue[]>();
  for (const issue of issues) {
    const list = byKey.get(issue.key) ?? [];
    list.push(issue);
    byKey.set(issue.key, list);
  }
  const lines: string[] = [];
  const n = issues.length;
  lines.push(`Invalid configuration (${n} ${n === 1 ? "problem" : "problems"}):`);
  for (const [key, list] of byKey) {
    for (const issue of list) {
      const example = issue.example ? ` Example: ${issue.example}` : "";
      lines.push(`  ${key}: ${issue.message}${example}`);
    }
  }
  lines.push("");
  lines.push(
    "Every secret also accepts NAME_FILE=/run/secrets/name (Docker / Kubernetes secrets).",
  );
  lines.push("See .env.example for the full list.");
  return lines.join("\n");
}
