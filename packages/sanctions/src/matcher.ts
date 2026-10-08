/*
 * The local name matcher (E3.10, ADR-0058; owner: agent S), used by the `ofac` adapter:
 * normalise (NFKD, strip diacritics, lower case, drop punctuation and legal-form suffixes such as
 * inc, llc, ltd, limited, gmbh, sa, plc, corp, co, company), then a token-set Jaro-Winkler score
 * against every primary name and AKA. The version tag goes into `listVersion` (`…:jw4`): any change
 * to the rules below that can move a score must bump it, so every workspace is screened again.
 *
 * The score of two names is the best of three views:
 *
 *  1. Compact equality: the same letters once spaces are gone (`Aero Caribbean` = `AEROCARIBBEAN`)
 *     is 1.
 *  2. Token set: every token finds its best partner on the other side (Jaro-Winkler, each partner
 *     used once); each side's coverage is the length-weighted mean of its tokens' similarities,
 *     and the score is the mean of the two coverages — so word order and a missing legal form do
 *     not matter, while an extra word on either side costs what that word weighs.
 *  3. Containment: every distinctive token of the shorter name is found in the longer one (a
 *     company named after a listed party, or the listed party's short name) scores at least
 *     `CONTAINMENT_BASE`, rising with how much of the longer name it explains.
 *
 * Views 2 and 3 also run with adjacent tokens joined (jw2): where two neighbouring words of one
 * name, written together, are a word of the other ("Sino Trans" / "Sinotrans", "Al Noor" /
 * "Alnoor"), they count as that one word — spacing is not identity, and a split or merged word
 * must not hide a listed party when the rest of the names differ.
 *
 * False-positive guards, because every hit parks a customer in front of an operator:
 *  - tokens of 3 characters or fewer only match exactly (Jaro-Winkler rates any two short strings
 *    as close);
 *  - a token pair below `TOKEN_FLOOR` counts as no match at all, so a pile of vaguely similar
 *    words cannot add up to a hit;
 *  - common business words (`trading`, `international`, `group`, …) weigh less, and never count as
 *    the distinctive part of a containment: "Global Trading" is not "Al-Noor Global Trading".
 */

/** Recorded in every `listVersion` the matcher produced. */
export const MATCHER_VERSION = "jw4";

/** Token pairs less similar than this count as unmatched. */
export const TOKEN_FLOOR = 0.8;
/** Tokens this short or shorter only match exactly. */
export const SHORT_TOKEN_MAX = 3;
/** Weight of a common business word relative to its length. */
export const COMMON_WORD_WEIGHT = 0.4;
/** A containment hit scores at least this (plus up to 0.15 for how much it covers). */
export const CONTAINMENT_BASE = 0.85;
/** Distinctive characters the shorter name must carry for a containment hit. */
export const CONTAINMENT_MIN_CHARS = 5;
/** A containment token must match at least this well. */
const CONTAINMENT_TOKEN_MIN = 0.92;

/**
 * Legal forms and company-type words, dropped wherever they appear (after punctuation is gone,
 * so `S.A.` is `sa` and `Sp. z o.o.` is `sp z oo`).
 */
const LEGAL_FORMS: ReadonlySet<string> = new Set([
  "ab",
  "ag",
  "as",
  "asa",
  "bhd",
  "bv",
  "cjsc",
  "co",
  "company",
  "corp",
  "corporation",
  "cv",
  "eood",
  "fze",
  "fzco",
  "fzc",
  "fzllc",
  "gmbh",
  "inc",
  "incorporated",
  "jsc",
  "kft",
  "kg",
  "limited",
  "llc",
  "llp",
  "lp",
  "ltd",
  "ltda",
  "nv",
  "oao",
  "ohg",
  "ojsc",
  "ooo",
  "oy",
  "oyj",
  "pao",
  "pjsc",
  "plc",
  "pte",
  "pty",
  "pvt",
  "sa",
  "sae",
  "sal",
  "sarl",
  "sas",
  "sdn",
  "se",
  "sl",
  "spa",
  "srl",
  "sro",
  "tov",
  "zao",
  "zrt",
]);

/** Glue words that carry no identity (dropped like legal forms). */
const STOP_WORDS: ReadonlySet<string> = new Set(["and", "the", "of", "und", "et", "y"]);

/** Words half the world's company names contain: weigh less, never distinctive. */
const COMMON_WORDS: ReadonlySet<string> = new Set([
  "agency",
  "air",
  "airlines",
  "alliance",
  "america",
  "american",
  "asia",
  "bank",
  "capital",
  "center",
  "centre",
  "commercial",
  "construction",
  "consulting",
  "development",
  "east",
  "electronics",
  "energy",
  "engineering",
  "enterprise",
  "enterprises",
  "export",
  "finance",
  "financial",
  "first",
  "foods",
  "fund",
  "gas",
  "general",
  "global",
  "group",
  "holding",
  "holdings",
  "import",
  "industrial",
  "industries",
  "industry",
  "intl",
  "international",
  "investment",
  "investments",
  "logistics",
  "management",
  "manufacturing",
  "marine",
  "media",
  "middle",
  "national",
  "network",
  "new",
  "north",
  "oil",
  "partners",
  "petroleum",
  "resources",
  "service",
  "services",
  "shipping",
  "solutions",
  "south",
  "systems",
  "tech",
  "technologies",
  "technology",
  "trade",
  "trading",
  "transport",
  "united",
  "ventures",
  "west",
  "world",
]);

/** Letters NFKD leaves alone. */
const FOLD: Readonly<Record<string, string>> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  ł: "l",
  þ: "th",
  ı: "i",
};

/**
 * Cyrillic and Greek to Latin (jw3, RR2-4), lower case, applied after NFKD has taken the marks off
 * (so `й` is `и`, `ё` is `е`, `ά` is `α`). Close to BGN/PCGN, which is how OFAC romanises: the
 * soft and hard signs vanish ("Роснефть" → "rosneft"). A vendored table, not a package: two
 * scripts, and the output must not move without a MATCHER_VERSION bump. Other scripts (Arabic,
 * Hebrew, CJK, …) have no reliable letter-for-letter romanisation; a name with no Latin letter
 * left is unscreenable (`isScreenable`) and held for an operator rather than cleared.
 */
const TRANSLIT: Readonly<Record<string, string>> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ж: "zh",
  з: "z",
  и: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
  // Ukrainian, Belarusian, Serbian, Macedonian
  є: "ye",
  і: "i",
  ґ: "g",
  ў: "u",
  ђ: "dj",
  ј: "j",
  љ: "lj",
  њ: "nj",
  ћ: "c",
  џ: "dz",
  ѓ: "gj",
  ќ: "kj",
  ѕ: "dz",
  // Greek
  α: "a",
  β: "v",
  γ: "g",
  δ: "d",
  ε: "e",
  ζ: "z",
  η: "i",
  θ: "th",
  ι: "i",
  κ: "k",
  λ: "l",
  μ: "m",
  ν: "n",
  ξ: "x",
  ο: "o",
  π: "p",
  ρ: "r",
  σ: "s",
  ς: "s",
  τ: "t",
  υ: "y",
  φ: "f",
  χ: "ch",
  ψ: "ps",
  ω: "o",
};

function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[ßæœøđðłþı]/gu, (ch) => FOLD[ch] ?? ch)
    .replace(/[\u0370-\u03ff\u0400-\u052f]/gu, (ch) => TRANSLIT[ch] ?? ch);
}

/** Lower-cased, diacritic-free tokens with legal forms and stop words kept (the raw material). */
function rawTokens(name: string): string[] {
  return (
    fold(name)
      // Joining marks inside a word: `S.A.` → `sa`, `O'Neil` → `oneil`, `a.k.a` → `aka`.
      .replace(/[.'’`´]/gu, "")
      .replace(/&/gu, " and ")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((t) => t.length > 0)
  );
}

/** A name reduced to comparable tokens, in their original order. */
export function normalizeName(name: string): readonly string[] {
  const tokens = rawTokens(name);
  const kept = tokens.filter((t) => !LEGAL_FORMS.has(t) && !STOP_WORDS.has(t));
  // A name made of nothing but legal forms ("Company Limited") keeps them rather than vanish.
  return kept.length > 0 ? kept : tokens;
}

/**
 * Whether the LOCAL matcher can screen a name (jw4): it has a token with a Latin letter, and no
 * token keeps letters of another script after transliteration — "---", "株式会社" or
 * "بنك ملي Trading" cannot be compared with a romanised list (scored, the unreadable part would
 * simply not count, and the rest could come out "clear"). The `ofac` driver holds such a name for
 * an operator; OpenSanctions matches other scripts itself.
 */
export function isScreenable(name: string): boolean {
  const tokens = normalizeName(name);
  return (
    tokens.some((t) => /\p{Script=Latin}/u.test(t)) &&
    tokens.every((t) => /^[\p{Script=Latin}\p{N}]+$/u.test(t))
  );
}

/**
 * Cyrillic and Greek letters that LOOK like Latin ones (a UTS #39-style confusables subset, by
 * case: an upper-case `Н` looks like `H`, a lower-case `н` does not). Used only inside a word
 * that mixes them with Latin letters ("Ѕberbank", "НezЬollaһ") — the spoof pattern, where a
 * sound-based transliteration ("dzberbank") would miss the name the reader sees.
 */
const CONFUSABLE: Readonly<Record<string, string>> = {
  // Cyrillic upper case
  А: "A",
  В: "B",
  Е: "E",
  Ѕ: "S",
  І: "I",
  Ј: "J",
  К: "K",
  М: "M",
  Н: "H",
  О: "O",
  Р: "P",
  С: "C",
  Т: "T",
  У: "Y",
  Х: "X",
  Ь: "b",
  Һ: "H",
  Ԛ: "Q",
  Ԝ: "W",
  // Cyrillic lower case
  а: "a",
  е: "e",
  ѕ: "s",
  і: "i",
  ј: "j",
  о: "o",
  р: "p",
  с: "c",
  у: "y",
  х: "x",
  һ: "h",
  ԛ: "q",
  ԝ: "w",
  ь: "b",
  // Greek upper case
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
  // Greek lower case
  α: "a",
  ι: "i",
  κ: "k",
  ο: "o",
  ρ: "p",
  ν: "v",
  υ: "u",
};

const LATIN_LETTER = /\p{Script=Latin}/u;
const CYRILLIC_GREEK = /[\u0370-\u03ff\u0400-\u052f]/u;

/**
 * The token lists a subject name is scored as (jw4): the name itself, and — when a word mixes
 * Latin with Cyrillic/Greek letters — the name with those words read by appearance. The score is
 * the best over the variants.
 */
export function nameVariants(name: string): readonly (readonly string[])[] {
  const plain = normalizeName(name);
  let mixed = false;
  const byLook = name.replace(/[^\s]+/gu, (word) => {
    if (!LATIN_LETTER.test(word) || !CYRILLIC_GREEK.test(word)) return word;
    mixed = true;
    return Array.from(word, (ch) => CONFUSABLE[ch] ?? ch).join("");
  });
  return mixed ? [plain, normalizeName(byLook)] : [plain];
}

/** `tokenScore` of the best variant of the subject against already-normalised list tokens. */
export function variantScore(
  variants: readonly (readonly string[])[],
  listTokens: readonly string[],
): number {
  let best = 0;
  for (const v of variants) best = Math.max(best, tokenScore(v, listTokens));
  return best;
}

/** Jaro-Winkler similarity of two strings, 0..1 (prefix scale 0.1, prefix up to 4). */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  const s = Array.from(a);
  const t = Array.from(b);
  if (s.length === 0 || t.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(s.length, t.length) / 2) - 1);
  const sMatched = new Array<boolean>(s.length).fill(false);
  const tMatched = new Array<boolean>(t.length).fill(false);
  let matches = 0;
  for (let i = 0; i < s.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(t.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (tMatched[j] || s[i] !== t[j]) continue;
      sMatched[i] = true;
      tMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < s.length; i++) {
    if (!sMatched[i]) continue;
    while (!tMatched[k]) k++;
    if (s[i] !== t[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / s.length + m / t.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && prefix < s.length && prefix < t.length && s[prefix] === t[prefix]) {
    prefix++;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Similarity of two tokens with the short-token and floor guards applied. */
export function tokenSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length <= SHORT_TOKEN_MAX || b.length <= SHORT_TOKEN_MAX) return 0;
  const score = jaroWinkler(a, b);
  return score < TOKEN_FLOOR ? 0 : score;
}

function weightOf(token: string): number {
  return COMMON_WORDS.has(token) ? token.length * COMMON_WORD_WEIGHT : token.length;
}

function isDistinctive(token: string): boolean {
  return !COMMON_WORDS.has(token) && token.length > SHORT_TOKEN_MAX;
}

/**
 * Best one-to-one pairing of `a`'s tokens with `b`'s (greedy on the highest similarity first;
 * names have a handful of tokens). Returns, for each token of `a`, its partner's similarity.
 */
function align(a: readonly string[], b: readonly string[]): { sa: number[]; sb: number[] } {
  const pairs: { i: number; j: number; s: number }[] = [];
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const s = tokenSimilarity(a[i] as string, b[j] as string);
      if (s > 0) pairs.push({ i, j, s });
    }
  }
  pairs.sort((x, y) => y.s - x.s);
  const sa = new Array<number>(a.length).fill(0);
  const sb = new Array<number>(b.length).fill(0);
  const usedA = new Array<boolean>(a.length).fill(false);
  const usedB = new Array<boolean>(b.length).fill(false);
  for (const { i, j, s } of pairs) {
    if (usedA[i] || usedB[j]) continue;
    usedA[i] = true;
    usedB[j] = true;
    sa[i] = s;
    sb[j] = s;
  }
  return { sa, sb };
}

function coverage(tokens: readonly string[], scores: readonly number[]): number {
  let total = 0;
  let got = 0;
  for (let i = 0; i < tokens.length; i++) {
    const w = weightOf(tokens[i] as string);
    total += w;
    got += w * (scores[i] ?? 0);
  }
  return total === 0 ? 0 : got / total;
}

/** Deduplicated tokens (a repeated word says nothing new). */
function uniq(tokens: readonly string[]): string[] {
  return [...new Set(tokens)];
}

/**
 * The containment view of `inner` inside the other name: `innerScores` are its tokens' partner
 * similarities, `outerCoverage` how much of the other name they explain. 0 when it does not apply.
 */
function containment(
  inner: readonly string[],
  innerScores: readonly number[],
  outerCoverage: number,
): number {
  let chars = 0;
  for (let i = 0; i < inner.length; i++) {
    const t = inner[i] as string;
    // Every word that is not a short one must be there — common words included, so "Hamburg
    // Software" is not inside "Hamburg Trade Bank" — but only distinctive ones count as identity.
    if (t.length <= SHORT_TOKEN_MAX) continue;
    if ((innerScores[i] ?? 0) < CONTAINMENT_TOKEN_MIN) return 0;
    if (isDistinctive(t)) chars += t.length;
  }
  return chars >= CONTAINMENT_MIN_CHARS ? CONTAINMENT_BASE + 0.15 * outerCoverage : 0;
}

/**
 * `a` with each pair of neighbours joined where the joined word IS a token of `b`, left to right,
 * each token joined at most once. Exact only: Jaro-Winkler rates any word that starts with a
 * token as close to it ("kalashnikov" + "concern" ~ "kalashnikov"), so a fuzzy join would turn
 * every "<listed name> <anything>" into a hit.
 */
export function joinAdjacent(a: readonly string[], b: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    const here = a[i] as string;
    const next = a[i + 1];
    if (next !== undefined) {
      const joined = here + next;
      if (b.includes(joined)) {
        out.push(joined);
        i++;
        continue;
      }
    }
    out.push(here);
  }
  return out;
}

/** The score of two already-normalised token lists (see the header). */
export function tokenScore(aTokens: readonly string[], bTokens: readonly string[]): number {
  const base = pairScore(aTokens, bTokens);
  if (base >= 1) return base;
  const aJoined = joinAdjacent(aTokens, bTokens);
  const bJoined = joinAdjacent(bTokens, aTokens);
  return Math.max(
    base,
    aJoined.length < aTokens.length ? pairScore(aJoined, bTokens) : 0,
    bJoined.length < bTokens.length ? pairScore(aTokens, bJoined) : 0,
  );
}

function pairScore(aTokens: readonly string[], bTokens: readonly string[]): number {
  const a = uniq(aTokens);
  const b = uniq(bTokens);
  if (a.length === 0 || b.length === 0) return 0;
  if (a.join("") === b.join("")) return 1;
  const { sa, sb } = align(a, b);
  const covA = coverage(a, sa);
  const covB = coverage(b, sb);
  let score = (covA + covB) / 2;
  // Containment, either way round: one name's distinctive tokens all found in the other.
  score = Math.max(score, containment(a, sa, covB), containment(b, sb, covA));
  return Math.min(1, score);
}

/** Token-set similarity of two names, 0..1. */
export function nameScore(a: string, b: string): number {
  let best = 0;
  for (const bTokens of nameVariants(b))
    best = Math.max(best, variantScore(nameVariants(a), bTokens));
  return best;
}
