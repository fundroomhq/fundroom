import { useSyncExternalStore } from "react";
import {
  baseLocale,
  cookieMaxAge,
  cookieName,
  getTextDirection,
  type Locale,
  locales,
  overwriteGetLocale,
} from "../paraglide/runtime.js";
import { api, call } from "./api.js";

/*
 * Which language the SPA speaks (E2.8). This module owns the answer; Paraglide's `getLocale` is
 * overwritten to read it, so every `m.*()` call, every `Intl` formatter that asks `getLocale()`
 * and `<html lang>` agree.
 *
 * Order, first supported answer wins:
 *   1. the signed-in user's explicit choice (`Session.user.locale`, `PUT /me/locale`)
 *   2. `?lang=` on the page URL (the embed passes the host page's language this way)
 *   3. the `PARAGLIDE_LOCALE` cookie (the last explicit choice on this device, signed in or not)
 *   4. the browser's languages (`navigator.languages`)
 *   5. the workspace default (`workspace.defaultLocale` in the bootstrap)
 *   6. `en`
 *
 * The pseudo-locale `en-XA` is QA tooling: it is only ever selected in a dev build or when the
 * operator has turned on `I18N_PSEUDO_LOCALE` (bootstrap `pseudoLocale`). A browser never asks
 * for it by accident — tag matching falls back by language (`en-GB` → `en`) but never onto it.
 *
 * Inputs 1, 5 and the pseudo flag arrive with `/me` and the bootstrap, after the first paint;
 * `LocaleSync` (in `App`) feeds them in, and a change re-renders the tree under the new locale.
 */
export const PSEUDO_LOCALE = "en-XA" as const satisfies Locale;

export interface LocaleInputs {
  readonly user?: string | null | undefined;
  readonly query?: string | null | undefined;
  readonly cookie?: string | null | undefined;
  readonly navigator?: readonly string[] | undefined;
  readonly workspace?: string | null | undefined;
  readonly pseudoAllowed: boolean;
}

/** The supported locale a BCP 47 tag asks for (exact, then by language; never the pseudo-locale). */
export function matchLocale(
  tag: string | null | undefined,
  pseudoAllowed: boolean,
): Locale | undefined {
  if (typeof tag !== "string" || tag.trim() === "") return undefined;
  const lower = tag.trim().toLowerCase();
  const allowed = locales.filter((l) => pseudoAllowed || l !== PSEUDO_LOCALE);
  const exact = allowed.find((l) => l.toLowerCase() === lower);
  if (exact !== undefined) return exact;
  const language = lower.split(/[-_]/u)[0];
  return allowed.find((l) => l !== PSEUDO_LOCALE && l.toLowerCase() === language);
}

/** Pure: the locale for these inputs (exported for tests). */
export function resolveLocale(inputs: LocaleInputs): Locale {
  const candidates = [
    inputs.user,
    inputs.query,
    inputs.cookie,
    ...(inputs.navigator ?? []),
    inputs.workspace,
  ];
  for (const c of candidates) {
    const l = matchLocale(c, inputs.pseudoAllowed);
    if (l !== undefined) return l;
  }
  return baseLocale;
}

/** The locales a picker may offer. */
export function selectableLocales(pseudoAllowed: boolean): Locale[] {
  return locales.filter((l) => pseudoAllowed || l !== PSEUDO_LOCALE);
}

// --- browser inputs -----------------------------------------------------------------------------

function readCookie(): string | undefined {
  if (typeof document === "undefined") return undefined;
  for (const part of document.cookie.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === cookieName) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

function writeCookie(locale: Locale | null): void {
  if (typeof document === "undefined") return;
  // biome-ignore lint/suspicious/noDocumentCookie: Paraglide's own runtime writes this cookie the same way, and the Cookie Store API is missing from the Safari and Firefox versions we support.
  document.cookie =
    locale === null
      ? `${cookieName}=; path=/; max-age=0; SameSite=Lax`
      : `${cookieName}=${encodeURIComponent(locale)}; path=/; max-age=${cookieMaxAge}; SameSite=Lax`;
}

function readQuery(): string | undefined {
  if (typeof window === "undefined") return undefined;
  return new URLSearchParams(window.location.search).get("lang") ?? undefined;
}

function readNavigator(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

function devBuild(): boolean {
  return import.meta.env?.DEV === true && import.meta.env?.MODE !== "test";
}

// --- the store ----------------------------------------------------------------------------------

interface State {
  inputs: LocaleInputs;
  locale: Locale;
}

let state: State | undefined;
const listeners = new Set<() => void>();

function initialInputs(): LocaleInputs {
  return {
    query: readQuery(),
    cookie: readCookie(),
    navigator: readNavigator(),
    pseudoAllowed: devBuild(),
  };
}

function current(): State {
  if (state === undefined) {
    const inputs = initialInputs();
    state = { inputs, locale: resolveLocale(inputs) };
  }
  return state;
}

function applyDocument(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dir = getTextDirection(locale);
}

function update(patch: Partial<LocaleInputs>): void {
  const before = current();
  const inputs = { ...before.inputs, ...patch };
  const locale = resolveLocale(inputs);
  state = { inputs, locale };
  if (locale !== before.locale) {
    applyDocument(locale);
    for (const l of listeners) l();
  }
}

// Paraglide asks this module from the moment it is loaded (App imports it), not from `initLocale`
// only, so a screen test mounting `App` directly gets the same answers as the real boot.
overwriteGetLocale(() => current().locale);

/** Boot: read the synchronous inputs and set `<html lang/dir>`. */
export function initLocale(): Locale {
  state = undefined;
  const { locale } = current();
  applyDocument(locale);
  return locale;
}

/** The current locale (outside React). */
export function currentLocale(): Locale {
  return current().locale;
}

/** The server values last fed in, so a re-render that repeats them changes nothing. */
let synced: { user?: string | null | undefined; workspace?: string | null | undefined } = {};

/**
 * Feeds the server-side inputs in (from `/me` and the bootstrap). Only a value that differs
 * from the last one the server reported is applied, so a local choice the server did not store
 * (the pseudo-locale in a dev build) is not overwritten by the next render.
 */
export function syncLocale(input: {
  readonly user?: string | null | undefined;
  readonly workspace?: string | null | undefined;
  readonly pseudoLocale?: boolean | undefined;
}): void {
  const prev = current().inputs;
  const patch: { -readonly [K in keyof LocaleInputs]?: LocaleInputs[K] } = {};
  if (input.user !== undefined && input.user !== synced.user) {
    synced = { ...synced, user: input.user };
    patch.user = input.user;
  }
  if (input.workspace !== undefined && input.workspace !== synced.workspace) {
    synced = { ...synced, workspace: input.workspace };
    patch.workspace = input.workspace;
  }
  const pseudoAllowed = devBuild() || input.pseudoLocale === true;
  if (input.pseudoLocale !== undefined && pseudoAllowed !== prev.pseudoAllowed)
    patch.pseudoAllowed = pseudoAllowed;
  if (Object.keys(patch).length > 0) update(patch);
}

/**
 * The reader picks a language (`null` = "use the default"). Remembered on this device (cookie)
 * and, when signed in, on the account (`PUT /me/locale`) so emails follow too. The pseudo-locale
 * stays local when the server does not accept it (a dev build without `I18N_PSEUDO_LOCALE`).
 */
export async function chooseLocale(
  locale: Locale | null,
  options: { readonly signedIn: boolean; readonly serverAcceptsPseudo: boolean },
): Promise<void> {
  writeCookie(locale);
  const persist =
    options.signedIn && (locale !== PSEUDO_LOCALE || options.serverAcceptsPseudo === true);
  // Not persisted while signed in (the pseudo-locale on a server that refuses it): the stored
  // account choice must not outrank what the reader just picked, for this page's lifetime.
  update({ cookie: locale ?? undefined, user: persist ? locale : undefined });
  if (persist) await call(api().PUT("/me/locale", { body: { locale } }));
}

/**
 * Tests only: forget the cookie and every synced input and start again from the browser, with
 * `inputs` layered on top (e.g. `{ user: "en-XA", pseudoAllowed: true }`).
 */
export function resetLocaleForTests(inputs?: Partial<LocaleInputs>): void {
  writeCookie(null);
  synced = {};
  const merged = { ...initialInputs(), ...inputs };
  state = { inputs: merged, locale: resolveLocale(merged) };
  applyDocument(state.locale);
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The current locale; re-renders the caller when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, currentLocale, currentLocale);
}

/** The reader's own explicit choice (`Session.user.locale`), as last synced. */
export function userLocaleChoice(): string | null | undefined {
  return current().inputs.user;
}
