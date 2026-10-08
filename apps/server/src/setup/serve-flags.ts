/*
 * `serve --roles api,web` (E2.9). Platforms whose environment is app-wide (Fly's `[env]`) cannot
 * give two process groups different `ROLES`, so the roles travel on the command line instead.
 * The flag only overrides `ROLES` in the raw environment; `loadConfig()` still validates the
 * value and the ROLES/WORKER_MODE rules, so a bad flag fails exactly like a bad variable.
 */
export function applyServeFlags(args: readonly string[], env: NodeJS.ProcessEnv): string | null {
  const i = args.indexOf("--roles");
  if (i < 0) return null;
  const value = args[i + 1];
  if (value === undefined || value.startsWith("--") || value.trim() === "") {
    return "--roles needs a comma-separated list (api, web, worker)";
  }
  env["ROLES"] = value;
  return null;
}
