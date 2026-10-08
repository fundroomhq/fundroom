import { BASE_LOCALE, type Locale, matchLocale } from "./locales.js";
// biome-ignore lint/correctness/useImportExtensions: JSON module, not a source file
import en from "./messages/en.json" with { type: "json" };
// biome-ignore lint/correctness/useImportExtensions: JSON module, not a source file
import enXA from "./messages/en-XA.json" with { type: "json" };

/*
 * The server-side message catalogue (E2.8): email subjects and bodies, rendered in the
 * recipient's language (`user.locale ?? workspace.default_locale ?? "en"`).
 *
 * The SPA's messages are Paraglide's (`apps/web/messages`); these are the few sentences the
 * server itself writes. Both catalogues are pseudo-localised by `scripts/i18n-pseudo.mjs` and
 * parity-checked by `scripts/check-i18n.mjs`.
 *
 * Message shape: a string with `{name}` references, or a plural object keyed by
 * `Intl.PluralRules` categories (`one`, `other`, …; `other` is required) that selects on
 * `vars.count`.
 *
 * `t` never throws: an unknown locale renders `en`, a key missing from a locale renders the `en`
 * text, a key missing everywhere renders the key itself, and a missing variable leaves its
 * `{name}` in place. Every one of those is a bug to fix, but not one worth dropping a sign-in
 * code over.
 */
export type MessageKey = keyof typeof en;

type PluralForms = Readonly<Partial<Record<Intl.LDMLPluralRule, string>>> & {
  readonly other: string;
};
type MessageValue = string | PluralForms;
type Catalogue = Readonly<Record<string, MessageValue>>;

const CATALOGUES: Readonly<Record<Locale, Catalogue>> = {
  en: en as Catalogue,
  "en-XA": enXA as Catalogue,
};

export type MessageVars = Readonly<Record<string, string | number>>;

const pluralRules = new Map<string, Intl.PluralRules>();

function pluralCategory(locale: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (rules === undefined) {
    // `en-XA` is a valid tag whose region nobody has data for; Intl falls back to `en`.
    rules = new Intl.PluralRules(locale);
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

function interpolate(pattern: string, vars: MessageVars | undefined): string {
  if (vars === undefined) return pattern;
  return pattern.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/gu, (whole, name: string) => {
    const v = vars[name];
    return v === undefined ? whole : String(v);
  });
}

function select(value: MessageValue, locale: Locale, vars: MessageVars | undefined): string {
  if (typeof value === "string") return value;
  const count = Number(vars?.["count"]);
  if (!Number.isFinite(count)) return value.other;
  return value[pluralCategory(locale, count)] ?? value.other;
}

/** True when `key` exists in the base catalogue (for callers holding a dynamic string). */
export function hasMessage(key: string): key is MessageKey {
  return Object.hasOwn(CATALOGUES[BASE_LOCALE], key);
}

/** Renders `key` in `locale` (any string; unsupported ones fall back to `en`). */
export function t(locale: string | null | undefined, key: MessageKey, vars?: MessageVars): string {
  const l = matchLocale(locale) ?? BASE_LOCALE;
  const value = CATALOGUES[l][key] ?? CATALOGUES[BASE_LOCALE][key];
  if (value === undefined) return key;
  return interpolate(select(value, l, vars), vars);
}

/** A `t` bound to one locale, for templates that render many strings. */
export function translator(
  locale: string | null | undefined,
): (key: MessageKey, vars?: MessageVars) => string {
  return (key, vars) => t(locale, key, vars);
}

/** The keys of the base catalogue (tests and the parity check). */
export function messageKeys(): readonly MessageKey[] {
  return Object.keys(CATALOGUES[BASE_LOCALE]) as MessageKey[];
}
