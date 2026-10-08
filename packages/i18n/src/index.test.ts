import { describe, expect, it } from "vitest";
import {
  BASE_LOCALE,
  hasMessage,
  isSupportedLocale,
  LOCALES,
  matchLocale,
  messageKeys,
  negotiateLocale,
  PSEUDO_CLOSE,
  PSEUDO_OPEN,
  parseAcceptLanguage,
  pseudoLocalize,
  pseudoLocalizeValue,
  t,
  translator,
} from "./index.js";
// biome-ignore lint/correctness/useImportExtensions: JSON module, not a source file
import en from "./messages/en.json" with { type: "json" };
// biome-ignore lint/correctness/useImportExtensions: JSON module, not a source file
import enXA from "./messages/en-XA.json" with { type: "json" };

describe("locales", () => {
  it("lists the base locale first", () => {
    expect(LOCALES[0]).toBe(BASE_LOCALE);
  });

  it("recognises supported locales only", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("en-XA")).toBe(true);
    expect(isSupportedLocale("fr")).toBe(false);
    expect(isSupportedLocale("EN")).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
  });

  it("matches tags exactly, then by language, never falling back to the pseudo-locale", () => {
    expect(matchLocale("en")).toBe("en");
    expect(matchLocale("EN-xa")).toBe("en-XA");
    expect(matchLocale("en-GB")).toBe("en");
    expect(matchLocale("en_US")).toBe("en");
    expect(matchLocale("fr-FR")).toBeUndefined();
    expect(matchLocale("*")).toBeUndefined();
    expect(matchLocale("")).toBeUndefined();
    expect(matchLocale(null)).toBeUndefined();
  });

  it("parses Accept-Language by q-value, keeping order for ties and dropping q=0", () => {
    expect(parseAcceptLanguage("fr;q=0.5, en-GB, de;q=0.9, xx;q=0")).toEqual(["en-GB", "de", "fr"]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage(" , ;q=1")).toEqual([]);
  });

  it("negotiates: explicit preferences, then the header, then en", () => {
    expect(negotiateLocale(undefined)).toBe("en");
    expect(negotiateLocale("fr, de")).toBe("en");
    expect(negotiateLocale("fr, en-US;q=0.8")).toBe("en");
    expect(negotiateLocale("en", "en-XA")).toBe("en-XA");
    expect(negotiateLocale("en-XA", null, undefined)).toBe("en-XA");
    // Unknown preferences are skipped, not thrown on.
    expect(negotiateLocale(undefined, "klingon", "", "en-XA")).toBe("en-XA");
    expect(negotiateLocale(undefined, null, "en")).toBe("en");
  });
});

describe("pseudoLocalize", () => {
  it("accents, pads by ~35% and brackets", () => {
    const out = pseudoLocalize("Save changes");
    expect(out.startsWith(PSEUDO_OPEN)).toBe(true);
    expect(out.endsWith(PSEUDO_CLOSE)).toBe(true);
    expect(out).toContain("Šáṽé çĥáñĝéš");
    expect(out).not.toMatch(/[a-zA-Z]/u);
    const padding = out.length - "Save changes".length - 2;
    expect(padding).toBe(Math.round(12 * 0.35));
  });

  it("never alters {placeholders}", () => {
    const out = pseudoLocalize("{count} session(s) signed out for {user_name}.");
    expect(out).toContain("{count}");
    expect(out).toContain("{user_name}");
    expect(out.match(/\{[^}]*\}/gu)).toEqual(["{count}", "{user_name}"]);
  });

  it("keeps ICU syntax and localises only the nested messages", () => {
    const out = pseudoLocalize("{count, plural, one {# item} other {# items}} left");
    expect(out).toContain("{count, plural, one {# íţéɱ} other {# íţéɱš}}");
    expect(out).toContain("ļéƒţ");
  });

  it("leaves digits, punctuation, whitespace and unbalanced braces alone", () => {
    expect(pseudoLocalize("")).toBe("");
    expect(pseudoLocalize("42 %")).toContain("42 %");
    expect(pseudoLocalize("a {b")).toContain("á {b");
  });

  it("breaks long padding into words", () => {
    const out = pseudoLocalize("x".repeat(100));
    expect(out).toMatch(/······ ······/u);
  });

  it("transforms inlang variant messages and plural objects, leaving selectors alone", () => {
    const variant = [
      {
        declarations: ["input count", "local countPlural = count: plural"],
        selectors: ["countPlural"],
        match: { "countPlural=one": "{count} item", "countPlural=*": "{count} items" },
      },
    ];
    const out = pseudoLocalizeValue(variant) as typeof variant;
    expect(out[0]?.declarations).toEqual(variant[0]?.declarations);
    expect(out[0]?.selectors).toEqual(["countPlural"]);
    expect(out[0]?.match["countPlural=one"]).toContain("{count} íţéɱ");
    expect(pseudoLocalizeValue({ one: "a", other: "b" })).toEqual({
      one: pseudoLocalize("a"),
      other: pseudoLocalize("b"),
    });
    expect(pseudoLocalizeValue(3)).toBe(3);
  });
});

describe("server catalogue", () => {
  it("renders en with {vars}", () => {
    expect(t("en", "auth.magic.subject", { title: "Acme (Seed)" })).toBe("Sign in to Acme (Seed)");
  });

  it("selects plural forms on vars.count with Intl.PluralRules", () => {
    expect(t("en", "auth.otp.expires", { count: 1 })).toBe(
      "It expires in 1 minute and works once.",
    );
    expect(t("en", "auth.otp.expires", { count: 10 })).toBe(
      "It expires in 10 minutes and works once.",
    );
    // No count: the `other` form, never a throw.
    expect(t("en", "auth.otp.expires")).toBe("It expires in {count} minutes and works once.");
  });

  it("renders the pseudo-locale", () => {
    const out = t("en-XA", "auth.magic.subject", { title: "Acme" });
    expect(out.startsWith(PSEUDO_OPEN)).toBe(true);
    expect(out).toContain("Acme");
  });

  it("falls back to en for unsupported locales and region variants", () => {
    const want = t("en", "auth.invite.button");
    expect(t("fr", "auth.invite.button")).toBe(want);
    expect(t(null, "auth.invite.button")).toBe(want);
    expect(t(undefined, "auth.invite.button")).toBe(want);
    expect(t("en-GB", "auth.invite.button")).toBe(want);
  });

  it("never throws on a missing key or a missing variable", () => {
    // A key that is not in the catalogue (a dynamic string that slipped past the type).
    expect(t("en-XA", "nope.missing" as never)).toBe("nope.missing");
    expect(hasMessage("nope.missing")).toBe(false);
    expect(hasMessage("auth.invite.button")).toBe(true);
    expect(t("en", "auth.magic.subject")).toBe("Sign in to {title}");
    expect(t("en", "auth.magic.subject", { other: "x" })).toBe("Sign in to {title}");
  });

  it("binds a translator to one locale", () => {
    const tr = translator("en");
    expect(tr("auth.invite.subject", { target: "Acme" })).toBe("You're invited to Acme");
  });

  it("keeps en and en-XA in key parity with every plural having `other`", () => {
    expect(Object.keys(enXA).sort()).toEqual(Object.keys(en).sort());
    expect(messageKeys().length).toBe(Object.keys(en).length);
    for (const [key, value] of Object.entries(en)) {
      if (typeof value !== "string") expect(value, key).toHaveProperty("other");
    }
  });
});
