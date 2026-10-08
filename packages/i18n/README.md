# @fundroom/i18n

Locales for FundRoom ("i18n coverage of investor UI").

- `LOCALES` (`en`, and the generated pseudo-locale `en-XA`), `BASE_LOCALE`, `isSupportedLocale`,
  `matchLocale(tag)` (exact, then by language; never falls back onto the pseudo-locale).
- `negotiateLocale(acceptLanguage, ...preferences)`: the first supported explicit preference
  (e.g. `user.locale`, then `workspace.default_locale`), else the best `Accept-Language` match,
  else `en`. Never throws.
- `pseudoLocalize(s)` / `pseudoLocalizeValue(v)`: accents, ~35% padding and `⟦ ⟧` brackets;
  `{placeholders}`, ICU arguments and inlang variant selectors are left untouched. The same
  function generates both catalogues' `en-XA.json` (`node scripts/i18n-pseudo.mjs`; `--check`
  fails CI on drift).
- The server catalogue for email: `t(locale, key, vars)` over `src/messages/en.json`. A message
  is a string with `{name}` references, or a plural object `{ "one": …, "other": … }` selected
  on `vars.count` with `Intl.PluralRules`. An unknown locale renders `en`, a missing key falls
  back to `en` (then to the key itself), a missing variable stays `{name}` — nothing throws.

Emails go out in `user.locale ?? workspace.default_locale ?? "en"` (`recipientLocale` in
`@fundroom/identity`). The catalogue is used by the identity mail templates (sign-in code,
share-link code, magic link, new device, invite), the `@fundroom/mail` layout footer and
`<Html lang>`, the updates email chrome (view on the web, unsubscribe, `[Test]`) and the setup
test email; English output is byte-identical to what those templates sent before E2.8.

The SPA's own messages are Paraglide's, in `apps/web/messages`; `pnpm lint:i18n`
(`scripts/check-i18n.mjs`) checks both catalogues (key parity, pseudo drift, unused web keys,
fake "(s)" plurals, and hard-coded JSX text or user-visible attributes in `apps/web/src` and
`packages/ui/src`). `en-XA` is accepted in production only when `I18N_PSEUDO_LOCALE=true`.
No real translation ships yet: adding one is a catalogue plus an entry in `LOCALES` and in
`apps/web/project.inlang/settings.json`.
