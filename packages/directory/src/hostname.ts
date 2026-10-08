import { normalizeHostname } from "@fundroom/custom-domains";

/**
 * The directory's spelling of a hostname: exactly the custom-domains package's (IDNA → punycode,
 * lower case, trailing dot stripped), after dropping a `:port` a `Host` header may carry. The
 * directory stores only this spelling, so a `Host` header and a stored claim cannot disagree.
 * `undefined` for anything that could never have been stored (IP literals, reserved names,
 * garbage) — callers answer "no" without a query.
 */
export function directoryHostname(input: string): string | undefined {
  const withoutPort = input.trim().replace(/:\d+$/u, "");
  const checked = normalizeHostname(withoutPort);
  return checked.ok ? checked.hostname : undefined;
}
