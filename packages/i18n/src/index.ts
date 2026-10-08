/*
 * Locales (E2.8): the supported list, negotiation, the `en-XA` pseudo-locale and the server-side
 * message catalogue that emails render through.
 */
export {
  hasMessage,
  type MessageKey,
  type MessageVars,
  messageKeys,
  t,
  translator,
} from "./catalogue.js";
export {
  BASE_LOCALE,
  isSupportedLocale,
  LOCALES,
  type Locale,
  matchLocale,
  negotiateLocale,
  PSEUDO_LOCALE,
  parseAcceptLanguage,
} from "./locales.js";
export {
  PSEUDO_CLOSE,
  PSEUDO_EXPANSION,
  PSEUDO_OPEN,
  pseudoLocalize,
  pseudoLocalizeValue,
} from "./pseudo.js";
