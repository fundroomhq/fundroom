import { describe, expect, it } from "vitest";
import {
  isScreenable,
  jaroWinkler,
  MATCHER_VERSION,
  nameScore,
  normalizeName,
  tokenSimilarity,
} from "./matcher.js";

/*
 * Golden cases for the matcher (E3.10). The threshold is SANCTIONS_MATCH_THRESHOLD's default,
 * 0.88: "hit" rows must reach it, "miss" rows must stay under it. A change that moves any row
 * across the line changes who gets held — bump MATCHER_VERSION with it.
 */
const THRESHOLD = 0.88;

describe("jaroWinkler", () => {
  it("matches the textbook values", () => {
    expect(jaroWinkler("martha", "marhta")).toBeCloseTo(0.9611, 4);
    expect(jaroWinkler("dixon", "dicksonx")).toBeCloseTo(0.8133, 4);
    expect(jaroWinkler("dwayne", "duane")).toBeCloseTo(0.84, 2);
    expect(jaroWinkler("abc", "abc")).toBe(1);
    expect(jaroWinkler("abc", "xyz")).toBe(0);
    expect(jaroWinkler("", "abc")).toBe(0);
  });

  it("is symmetric", () => {
    for (const [a, b] of [
      ["rosneft", "rosnefte"],
      ["mahan", "mahn"],
      ["petropars", "petroparis"],
    ] as const) {
      expect(jaroWinkler(a, b)).toBeCloseTo(jaroWinkler(b, a), 10);
    }
  });
});

describe("normalizeName", () => {
  it("folds diacritics, case and punctuation", () => {
    expect(normalizeName("Société Générale Café")).toEqual(["societe", "generale", "cafe"]);
    expect(normalizeName("Straße & Søn")).toEqual(["strasse", "son"]);
    expect(normalizeName("O'Neil-Łódź")).toEqual(["oneil", "lodz"]);
  });

  it("drops legal forms and glue words wherever they are", () => {
    expect(normalizeName("Acme Holdings Ltd.")).toEqual(["acme", "holdings"]);
    expect(normalizeName("ACME, S.A.")).toEqual(["acme"]);
    expect(normalizeName("Bank of the East GmbH & Co. KG")).toEqual(["bank", "east"]);
    expect(normalizeName("Open Joint Stock Company Rosneft PJSC")).toEqual([
      "open",
      "joint",
      "stock",
      "rosneft",
    ]);
  });

  it("keeps a name made only of legal forms rather than lose it", () => {
    expect(normalizeName("Company Limited")).toEqual(["company", "limited"]);
  });

  it("transliterates Cyrillic and Greek (jw4); keeps letters of other scripts", () => {
    expect(normalizeName("Роснефть")).toEqual(["rosneft"]);
    expect(normalizeName("株式会社 Acme")).toEqual(["株式会社", "acme"]);
  });
});

describe("tokenSimilarity guards", () => {
  it("only matches short tokens exactly", () => {
    expect(tokenSimilarity("abc", "abd")).toBe(0);
    expect(tokenSimilarity("abc", "abc")).toBe(1);
  });

  it("floors weak similarities to zero", () => {
    expect(tokenSimilarity("acme", "apex")).toBe(0);
    expect(tokenSimilarity("rosneft", "roseneft")).toBeGreaterThan(0.9);
  });
});

describe("nameScore golden cases", () => {
  const hits: [string, string][] = [
    // exact, case and punctuation
    ["Aerocaribbean Airlines", "AEROCARIBBEAN AIRLINES"],
    ["Banco Nacional de Cuba", "BANCO NACIONAL DE CUBA"],
    // legal forms on either side
    ["Tidewater Middle East Co", "TIDEWATER MIDDLE EAST CO."],
    ["Petropars", "PETROPARS LTD."],
    ["Kalashnikov Concern", "KALASHNIKOV CONCERN JSC"],
    // diacritics
    ["Société Générale Café S.A.", "SOCIETE GENERALE CAFE"],
    // spacing / concatenation
    ["Aero Caribbean Airlines Inc.", "AEROCARIBBEAN AIRLINES"],
    ["Petro Pars", "PETROPARS LTD."],
    // word order (persons are listed "LAST, First")
    ["Smith & Jones Ltd", "JONES, Smith"],
    // typos and transliteration
    ["Mahn Air", "MAHAN AIR"],
    ["Mostafa Holdings", "MUSTAFA HOLDING"],
    // containment: a listed party's name inside the subject, or the subject inside it
    ["Rosneft Ltd", "ROSNEFT OIL COMPANY"],
    ["Mahan Airways", "MAHAN AIR"],
    ["Novatek", "NOVATEK PAO"],
    // jw4: a split or merged word is the same word (adjacent tokens joined)
    ["Sino Trans Shipping", "SINOTRANS LTD"],
    ["Al Noor Petroleum Services", "ALNOOR PETROLEUM"],
    ["Blue Sky Holding", "BLUESKY"],
    // jw4: Cyrillic and Greek are transliterated before tokenising
    ["Роснефть", "ROSNEFT OIL COMPANY"],
    ["ПАО Новатэк", "NOVATEK PAO"],
    ["Πετροπαρς", "PETROPARS LTD."],
    // jw4: Latin words spoofed with look-alike Cyrillic/Greek letters are read by appearance
    ["Ѕberbank", "SBERBANK"],
    ["Хinjiang Production", "XINJIANG PRODUCTION AND CONSTRUCTION CORPS"],
    ["НezЬollaһ", "HEZBOLLAH"],
    ["Ρetropars", "PETROPARS LTD."],
  ];
  it.each(hits)("%s ~ %s is a potential match", (a, b) => {
    expect(nameScore(a, b)).toBeGreaterThanOrEqual(THRESHOLD);
    expect(nameScore(b, a)).toBeCloseTo(nameScore(a, b), 10);
  });

  const misses: [string, string][] = [
    // short tokens: one letter apart is a different name
    ["ABC Ltd", "ABD LTD"],
    // common business words alone are not an identity
    ["Global Trading Group", "AL NOOR TRADING GROUP"],
    ["Global Trading LLC", "AL-NOOR GLOBAL TRADING"],
    ["Oil Ltd", "ROSNEFT OIL COMPANY"],
    ["Star Enterprises", "RED STAR ENTERPRISES"],
    // a shared place or first word is not enough
    ["Hamburg Software GmbH", "HAMBURG TRADE BANK"],
    ["Acme Analytics", "ACME TRADING CO"],
    ["Kalashnikov Coffee Roasters", "KALASHNIKOV CONCERN JSC"],
    // similar-looking but different parties
    ["Bank Mellat", "BANK MELLI IRAN"],
    ["Bank of America", "BANK MELLI IRAN"],
    ["Nova Technologies", "NOVATEK PAO"],
    ["Pars Oil", "PETROPARS LTD."],
    ["Blue Ocean Ventures", "BLUE SKY ALLIANCE"],
  ];
  it.each(misses)("%s ≁ %s", (a, b) => {
    expect(nameScore(a, b)).toBeLessThan(THRESHOLD);
  });

  it("scores in 0..1 and 0 for an empty name", () => {
    expect(nameScore("", "ACME")).toBe(0);
    expect(nameScore("---", "ACME")).toBe(0);
    for (const [a, b] of [...hits, ...misses]) {
      const s = nameScore(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it("a name with no Latin letter after transliteration cannot be screened", () => {
    expect(isScreenable("Роснефть")).toBe(true);
    // jw4: any token left in another script makes the whole name unscreenable (locally).
    expect(isScreenable("Acme 株式会社")).toBe(false);
    expect(isScreenable("بنك ملي Trading")).toBe(false);
    expect(isScreenable("Ѕberbank")).toBe(true);
    expect(isScreenable("株式会社")).toBe(false);
    expect(isScreenable("شركة النور")).toBe(false);
    expect(isScreenable("--- !!!")).toBe(false);
    expect(isScreenable("1234")).toBe(false);
  });

  it("transliterates like BGN/PCGN (signs vanish)", () => {
    expect(normalizeName("Роснефть")).toEqual(["rosneft"]);
    expect(normalizeName("Щёлково Агро")).toEqual(["shchelkovo", "agro"]);
  });

  it("tags its version", () => {
    expect(MATCHER_VERSION).toBe("jw4");
  });
});
