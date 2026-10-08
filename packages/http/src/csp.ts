/*
 * Content-Security-Policy builder (EXECUTION_PLAN §10 "Frontend", design/02 §5). Pure: a map
 * of directive → sources (or `true` for valueless directives such as
 * `upgrade-insecure-requests`) rendered in insertion order, `;`-separated, values
 * de-duplicated. Anything a caller passes is a keyword or origin the caller chose; the
 * builder only refuses characters that could terminate or forge a directive.
 */
export type CspDirectives = Readonly<Record<string, readonly string[] | true>>;

const DIRECTIVE_RE = /^[a-z][a-z0-9-]*$/u;
const SOURCE_FORBIDDEN_RE = /[;,\s]/u;

export function buildCsp(directives: CspDirectives): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(directives)) {
    if (!DIRECTIVE_RE.test(name)) throw new Error(`invalid CSP directive ${JSON.stringify(name)}`);
    if (value === true) {
      parts.push(name);
      continue;
    }
    const seen = new Set<string>();
    for (const source of value) {
      if (source === "" || SOURCE_FORBIDDEN_RE.test(source)) {
        throw new Error(`invalid CSP source ${JSON.stringify(source)} for ${name}`);
      }
      seen.add(source);
    }
    parts.push(seen.size === 0 ? name : `${name} ${[...seen].join(" ")}`);
  }
  return parts.join("; ");
}

/** Renders `frame-ancestors` sources; an empty allow-list means nobody may frame the page. */
export function frameAncestorsSources(origins: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const o of origins) {
    const trimmed = o.trim();
    if (trimmed === "") continue;
    out.push(trimmed);
  }
  return out.length === 0 ? ["'none'"] : out;
}
