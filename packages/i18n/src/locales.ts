/*
 * Locales and negotiation (E2.8).
 *
 * `en` is the base (and today the only real) locale; `en-XA` is the generated pseudo-locale
 * (`pseudo.ts`), offered only in development or when the operator turns on
 * `I18N_PSEUDO_LOCALE`. Adding a language = adding it here, to `apps/web/project.inlang` and to
 * `@fundroom/contracts` `LocaleSchema`, plus its message files.
 */

/** Every locale the product ships. `en-XA` is the generated pseudo-locale (dev / flag only). */
export const LOCALES = ["en", "en-XA"] as const;
export type Locale = (typeof LOCALES)[number];

export const BASE_LOCALE: Locale = "en";
export const PSEUDO_LOCALE: Locale = "en-XA";

export function isSupportedLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * The supported locale a BCP 47 tag asks for, or undefined.
 *
 * Exact matches win case-insensitively (`EN-xa` → `en-XA`). Otherwise the tag's language is
 * matched against the real locales (`en-GB` → `en`). The pseudo-locale is never reached by
 * falling back: nobody's browser asks for it by accident.
 */
export function matchLocale(tag: string | null | undefined): Locale | undefined {
  if (typeof tag !== "string") return undefined;
  const t = tag.trim();
  if (t === "" || t === "*") return undefined;
  const lower = t.toLowerCase();
  for (const l of LOCALES) if (l.toLowerCase() === lower) return l;
  const language = lower.split(/[-_]/u)[0];
  for (const l of LOCALES) if (l !== PSEUDO_LOCALE && l.toLowerCase() === language) return l;
  return undefined;
}

/** `Accept-Language` parsed into tags, best first (q-value, then order). q=0 entries dropped. */
export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (typeof header !== "string" || header.trim() === "") return [];
  return header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      let q = 1;
      for (const p of params) {
        const m = /^\s*q\s*=\s*([0-9.]+)\s*$/u.exec(p);
        if (m) q = Number(m[1]);
      }
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((e) => e.tag !== "" && e.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((e) => e.tag);
}

/**
 * Picks the locale to use.
 *
 * `preferences` are explicit choices, most specific first — e.g. `user.locale`, then
 * `workspace.defaultLocale` — and the first supported one wins. Only when none is set does the
 * `Accept-Language` header (or any list of tags joined with commas) decide, and when that
 * matches nothing either the answer is `en`. Unknown or malformed values are skipped, never
 * thrown on: this runs on every email send.
 */
export function negotiateLocale(
  acceptLanguage: string | null | undefined,
  ...preferences: readonly (string | null | undefined)[]
): Locale {
  for (const p of preferences) {
    const m = matchLocale(p);
    if (m !== undefined) return m;
  }
  for (const tag of parseAcceptLanguage(acceptLanguage)) {
    const m = matchLocale(tag);
    if (m !== undefined) return m;
  }
  return BASE_LOCALE;
}
