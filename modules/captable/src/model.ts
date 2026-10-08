import { formatFixed } from "@fundroom/decimal";
import { z } from "zod";

/*
 * The cap-table vocabulary and the pure arithmetic (E3.6 §8). No drizzle, no pg: the importer,
 * the routes and the tests all read these, and `only-repos-touch-drizzle` keeps SQL out of here.
 *
 * Every quantity is a `bigint` scaled by 1e6 (`@fundroom/decimal`), the scale of both numeric
 * columns (`shares numeric(24, 6)`, `amount numeric(20, 6)`), and leaves this module as a plain
 * decimal string. A cap table rendered through a double is a cap table that does not add up.
 */

export const SECURITY_KINDS = [
  "common",
  "preferred",
  "option_pool",
  "option",
  "warrant",
  "safe",
  "note",
] as const;
export type SecurityKind = (typeof SECURITY_KINDS)[number];

/** Kinds whose lines carry shares and count towards fully diluted. */
export const SHARE_KINDS: readonly SecurityKind[] = [
  "common",
  "preferred",
  "option_pool",
  "option",
  "warrant",
];
/** Convertibles: an amount (principal), no shares until they convert. */
export const CONVERTIBLE_KINDS: readonly SecurityKind[] = ["safe", "note"];

export const SNAPSHOT_SOURCES = ["csv", "carta", "pulley"] as const;
export type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number];

export const SNAPSHOT_STATUSES = ["draft", "published", "superseded"] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];

export const IMPORT_FORMATS = ["template", "carta", "pulley"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export const SOURCE_OF_FORMAT: Readonly<Record<ImportFormat, SnapshotSource>> = {
  template: "csv",
  carta: "carta",
  pulley: "pulley",
};

export const INVESTOR_VIEWS = ["own_line", "summary", "none"] as const;
export type InvestorView = (typeof INVESTOR_VIEWS)[number];

/** Import caps (contract §8): 2 MiB of UTF-8, 5000 data rows. */
export const IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 5000;
export const IMPORT_MAX_CLASSES = 200;
/** Problems listed in one refusal; warnings kept in one preview. */
export const IMPORT_MAX_PROBLEMS = 100;
export const IMPORT_MAX_WARNINGS = 200;

/**
 * The JSON body limit the two import routes need (the server applies it instead of the API's
 * 1 MiB default): a JSON string escapes a control character to six bytes, so six times the CSV
 * plus room for the envelope always fits.
 */
export const CAPTABLE_IMPORT_BODY_LIMIT_BYTES = 6 * IMPORT_MAX_BYTES + 64 * 1024;

export const NOTE_MAX = 500;
export const DISCLAIMER_MAX = 2000;
export const SNAPSHOT_LIST_LIMIT = 200;

/** What erasure writes over a holder's name (the numbers stay: a cap table is a record). */
export const ERASED_HOLDER_NAME = "Erased holder";

/**
 * Shown on every investor view unless the workspace overrides it. This module is a *mirror* of
 * the company's cap table, never the cap table itself: the ledger of record lives with counsel,
 * Carta, Pulley or the company's share register, and a figure here can be stale or rounded.
 */
export const DEFAULT_DISCLAIMER =
  "This summary is provided for information only. It is a snapshot imported from the company's " +
  "records as of the date shown and is **not** the company's system of record: the stock ledger " +
  "maintained by the company (or its transfer agent or equity-management provider) governs. " +
  "Figures may be rounded, may not reflect later issuances, transfers, conversions or " +
  "cancellations, and do not constitute legal, tax or investment advice. Contact the company to " +
  "confirm your holdings.";

// --- settings -------------------------------------------------------------------------------

export interface CaptableSettings {
  readonly investorView: InvestorView;
  /** Markdown override of `DEFAULT_DISCLAIMER`; `null` = the default. */
  readonly disclaimer: string | null;
}

export const DEFAULT_SETTINGS: CaptableSettings = Object.freeze({
  investorView: "own_line",
  disclaimer: null,
});

/** The module's block in `core.module_enablement.config` (`config.settings`). */
export const CaptableSettingsSchema = z.object({
  investorView: z.enum(INVESTOR_VIEWS).default("own_line"),
  disclaimer: z.union([z.string().max(DISCLAIMER_MAX), z.null()]).default(null),
});

/**
 * The settings stored in the module's enablement row, defaulted field by field. A stored value
 * that no longer parses (hand-edited, an older shape) falls back to the default rather than
 * failing the investor's page — the default (`own_line`) is also the least revealing view that
 * still shows anything.
 */
export function parseSettings(config: unknown): CaptableSettings {
  const block =
    config !== null && typeof config === "object"
      ? (config as Record<string, unknown>)["settings"]
      : undefined;
  const parsed = CaptableSettingsSchema.safeParse(block ?? {});
  if (!parsed.success) return DEFAULT_SETTINGS;
  const disclaimer = parsed.data.disclaimer?.trim() ?? "";
  return {
    investorView: parsed.data.investorView,
    disclaimer: disclaimer.length === 0 ? null : disclaimer,
  };
}

export const effectiveDisclaimer = (s: CaptableSettings): string =>
  s.disclaimer ?? DEFAULT_DISCLAIMER;

// --- decimals -------------------------------------------------------------------------------

/** Integral digits the columns hold: `shares numeric(24, 6)`, `amount numeric(20, 6)`. */
export const SHARES_INTEGRAL_DIGITS = 18;
export const AMOUNT_INTEGRAL_DIGITS = 14;

const PLAIN_DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/u;

/**
 * Plain decimal text → fixed point at scale 1e6, or `undefined` when it is not a plain decimal or
 * has more than `integralDigits` integral digits after rounding. `@fundroom/decimal`'s
 * `parseFixed` is this with 14 (the `numeric(20, 6)` of an amount); shares are `numeric(24, 6)`
 * and need 18. More than six fraction digits round half away from zero.
 */
export function parseQuantity(text: string, integralDigits: number): bigint | undefined {
  const t = text.trim();
  if (!PLAIN_DECIMAL_RE.test(t)) return undefined;
  const negative = t.startsWith("-");
  const unsigned = t.replace(/^[+-]/u, "");
  const dot = unsigned.indexOf(".");
  const integral = (dot === -1 ? unsigned : unsigned.slice(0, dot)).replace(/^0+/u, "");
  const fraction = dot === -1 ? "" : unsigned.slice(dot + 1);
  const kept = fraction.slice(0, 6).padEnd(6, "0");
  let v = BigInt(`${integral === "" ? "0" : integral}${kept}`);
  if ((fraction.codePointAt(6) ?? 0) >= 0x35) v += 1n;
  if (v >= 10n ** BigInt(integralDigits + 6)) return undefined;
  return negative ? -v : v;
}

/** Canonical decimal text: no exponent, no trailing fraction zeros ("1000000", "0.5"). */
export function decimalText(v: bigint): string {
  const s = formatFixed(v, 6);
  return s.includes(".") ? s.replace(/0+$/u, "").replace(/\.$/u, "") : s;
}

/** `part / whole × 100`, rounded half away from zero to 4 places, as text ("12.3456"). */
export function percentText(part: bigint, whole: bigint): string {
  return percentPlaces(part, whole, 4);
}

/** `part / whole × 100` rounded half away from zero to `places` (1…4) decimal places. */
export function percentPlaces(part: bigint, whole: bigint, places: 1 | 2 | 3 | 4): string {
  const unit = 10n ** BigInt(places);
  if (whole <= 0n || part <= 0n) return `0.${"0".repeat(places)}`;
  const n = part * 100n * unit;
  const q = n / whole;
  const rounded = (n % whole) * 2n >= whole ? q + 1n : q;
  return `${rounded / unit}.${(rounded % unit).toString().padStart(places, "0")}`;
}

// --- summary --------------------------------------------------------------------------------

export interface SummaryClass {
  readonly name: string;
  readonly kind: SecurityKind;
  readonly position: number;
}

/** One ledger line as the summary needs it (quantities scaled by 1e6). */
export interface SummaryLine {
  readonly classIndex: number;
  readonly holderName: string;
  readonly holderEmail: string | null;
  readonly membershipId: string | null;
  readonly shares: bigint | null;
  readonly amount: bigint | null;
  readonly currency: string | null;
}

export interface CurrencyAmount {
  readonly currency: string;
  readonly amount: string;
}

export interface ClassSummary {
  readonly name: string;
  readonly kind: SecurityKind;
  readonly position: number;
  readonly shares: string | null;
  readonly fullyDilutedShares: string;
  readonly percentFullyDiluted: string;
  readonly amounts: CurrencyAmount[];
  readonly holders: number;
  readonly lines: number;
}

export interface OptionPoolSummary {
  readonly poolShares: string | null;
  readonly granted: string | null;
  readonly available: string | null;
}

export interface ConvertibleSummary {
  readonly currency: string;
  readonly safes: string;
  readonly notes: string;
  readonly total: string;
}

/** Stored as `snapshot.totals` (schema version 1) and returned as `summary`. */
export interface CaptableSummary {
  readonly fullyDilutedShares: string;
  readonly classes: ClassSummary[];
  readonly optionPool: OptionPoolSummary | null;
  readonly convertiblesOutstanding: ConvertibleSummary[];
  readonly holderCount: number;
  readonly lineCount: number;
  readonly matchedHolders: number;
  readonly unmatchedHolders: number;
}

export const TOTALS_SCHEMA_VERSION = 1;

/**
 * Who a line belongs to, for counting and grouping holders: the linked member, else the address
 * (citext semantics: case-insensitive), else the name as written.
 */
export function holderKey(line: Pick<SummaryLine, "membershipId" | "holderEmail" | "holderName">) {
  if (line.membershipId !== null) return `m:${line.membershipId}`;
  if (line.holderEmail !== null) return `e:${line.holderEmail.toLowerCase()}`;
  return `n:${line.holderName.trim().replace(/\s+/gu, " ").toLowerCase()}`;
}

const sumOf = (values: readonly bigint[]): bigint => values.reduce((a, b) => a + b, 0n);

/**
 * Fully diluted shares per class (as-converted, 1:1 for preferred — conversion ratios are not
 * modelled). Common, preferred, warrants and granted options count their shares; an option pool
 * counts only what is still **available** (pool − granted, floored at zero, taken from the pools
 * in display order), so a grant is never counted twice; SAFEs and notes count nothing until they
 * convert. Returns one value per class, in `classes` order.
 */
export function fullyDilutedByClass(
  classes: readonly SummaryClass[],
  lines: readonly SummaryLine[],
): bigint[] {
  const shares = classes.map((_, i) =>
    sumOf(lines.filter((l) => l.classIndex === i).map((l) => l.shares ?? 0n)),
  );
  let granted = sumOf(classes.map((c, i) => (c.kind === "option" ? (shares[i] ?? 0n) : 0n)));
  const order = classes
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.position - b.c.position || a.i - b.i);
  const fd = classes.map(() => 0n);
  for (const { c, i } of order) {
    const s = shares[i] ?? 0n;
    if (c.kind === "safe" || c.kind === "note") fd[i] = 0n;
    else if (c.kind === "option_pool") {
      const used = granted < s ? granted : s;
      granted -= used;
      fd[i] = s - used;
    } else fd[i] = s;
  }
  return fd;
}

function amountsOf(lines: readonly SummaryLine[]): CurrencyAmount[] {
  const by = new Map<string, bigint>();
  for (const l of lines) {
    if (l.amount === null || l.currency === null) continue;
    by.set(l.currency, (by.get(l.currency) ?? 0n) + l.amount);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ currency, amount: decimalText(amount) }));
}

export function computeSummary(
  classes: readonly SummaryClass[],
  lines: readonly SummaryLine[],
): CaptableSummary {
  const fd = fullyDilutedByClass(classes, lines);
  const totalFd = sumOf(fd);
  const classSummaries = classes.map((c, i): ClassSummary => {
    const own = lines.filter((l) => l.classIndex === i);
    const withShares = own.filter((l) => l.shares !== null);
    return {
      name: c.name,
      kind: c.kind,
      position: c.position,
      shares:
        withShares.length === 0 ? null : decimalText(sumOf(withShares.map((l) => l.shares ?? 0n))),
      fullyDilutedShares: decimalText(fd[i] ?? 0n),
      percentFullyDiluted: percentText(fd[i] ?? 0n, totalFd),
      amounts: amountsOf(own),
      holders: new Set(own.map(holderKey)).size,
      lines: own.length,
    };
  });

  const kindTotal = (kind: SecurityKind): bigint | null => {
    const idx = classes.map((c, i) => (c.kind === kind ? i : -1)).filter((i) => i >= 0);
    if (idx.length === 0) return null;
    return sumOf(lines.filter((l) => idx.includes(l.classIndex)).map((l) => l.shares ?? 0n));
  };
  const pool = kindTotal("option_pool");
  const options = kindTotal("option");
  const optionPool: OptionPoolSummary | null =
    pool === null && options === null
      ? null
      : {
          poolShares: pool === null ? null : decimalText(pool),
          granted: options === null ? (pool === null ? null : "0") : decimalText(options),
          available:
            pool === null
              ? null
              : decimalText(pool - (options ?? 0n) > 0n ? pool - (options ?? 0n) : 0n),
        };

  const convertibles = new Map<string, { safes: bigint; notes: bigint }>();
  for (const l of lines) {
    const kind = classes[l.classIndex]?.kind;
    if ((kind !== "safe" && kind !== "note") || l.amount === null || l.currency === null) continue;
    const entry = convertibles.get(l.currency) ?? { safes: 0n, notes: 0n };
    if (kind === "safe") entry.safes += l.amount;
    else entry.notes += l.amount;
    convertibles.set(l.currency, entry);
  }
  const convertiblesOutstanding = [...convertibles.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, v]) => ({
      currency,
      safes: decimalText(v.safes),
      notes: decimalText(v.notes),
      total: decimalText(v.safes + v.notes),
    }));

  const holders = new Set(lines.map(holderKey));
  const matched = new Set(lines.filter((l) => l.membershipId !== null).map(holderKey));
  return {
    fullyDilutedShares: decimalText(totalFd),
    classes: classSummaries,
    optionPool,
    convertiblesOutstanding,
    holderCount: holders.size,
    lineCount: lines.length,
    matchedHolders: matched.size,
    unmatchedHolders: holders.size - matched.size,
  };
}

/**
 * Each line's share of its class's fully diluted count. Lines of a share class count their own
 * shares, except an option pool, whose (available) count is split across its lines in proportion
 * to their shares — the last line takes the rounding remainder, so the parts add up exactly.
 * Convertible lines count zero.
 */
export function fullyDilutedByLine(
  classes: readonly SummaryClass[],
  lines: readonly SummaryLine[],
): bigint[] {
  const fd = fullyDilutedByClass(classes, lines);
  const out = lines.map(() => 0n);
  classes.forEach((c, ci) => {
    const idx = lines.map((l, i) => (l.classIndex === ci ? i : -1)).filter((i) => i >= 0);
    if (c.kind === "safe" || c.kind === "note") return;
    if (c.kind !== "option_pool") {
      for (const i of idx) out[i] = lines[i]?.shares ?? 0n;
      return;
    }
    const classShares = sumOf(idx.map((i) => lines[i]?.shares ?? 0n));
    const classFd = fd[ci] ?? 0n;
    if (classShares === 0n) return;
    let given = 0n;
    idx.forEach((i, n) => {
      const part =
        n === idx.length - 1 ? classFd - given : ((lines[i]?.shares ?? 0n) * classFd) / classShares;
      out[i] = part;
      given += part;
    });
  });
  return out;
}

export const totalOf = (values: readonly bigint[]): bigint => sumOf(values);

// --- the investor's summary (investorView = "summary", ORCH R2-G1) ----------------------------

/** Kind buckets an investor may see: options = granted options + the pool, together. */
export const INVESTOR_BUCKETS = [
  "common",
  "preferred",
  "options",
  "warrants",
  "convertibles",
] as const;
export type InvestorBucketKind = (typeof INVESTOR_BUCKETS)[number];

export type InvestorBucket =
  | {
      readonly kind: Exclude<InvestorBucketKind, "convertibles">;
      /** Percent of fully diluted, 1 decimal place. */
      readonly percentFullyDiluted: string;
    }
  | { readonly kind: "convertibles"; readonly present: true };

export interface InvestorSummary {
  readonly buckets: InvestorBucket[];
}

/** Fewest distinct holders *other than the viewer*, each with fully diluted > 0, a bucket needs. */
export const MIN_OTHER_HOLDERS = 3;
/** Dominance (ORCH R3-G1): suppress when the largest other holder has more than 70 % … */
export const DOMINANCE_TOP1_PERCENT = 70n;
/** … or the two largest together more than 90 % of the other holders' fully diluted. */
export const DOMINANCE_TOP2_PERCENT = 90n;

/**
 * Whether a set of other holders' fully diluted positions may be described by one figure: at
 * least three with FD > 0, none above 70 % of their sum and no two above 90 % (a figure dominated
 * by one or two holders is, to within rounding, their position).
 */
export function describable(positions: ReadonlyMap<string, bigint>): boolean {
  const values = [...positions.values()]
    .filter((v) => v > 0n)
    .sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  if (values.length < MIN_OTHER_HOLDERS) return false;
  const sum = sumOf(values);
  const [first = 0n, second = 0n] = values;
  if (first * 100n > sum * DOMINANCE_TOP1_PERCENT) return false;
  if ((first + second) * 100n > sum * DOMINANCE_TOP2_PERCENT) return false;
  return true;
}

const BUCKET_OF: Readonly<Record<SecurityKind, InvestorBucketKind>> = {
  common: "common",
  preferred: "preferred",
  option: "options",
  option_pool: "options",
  warrant: "warrants",
  safe: "convertibles",
  note: "convertibles",
};

/**
 * What `investorView: "summary"` may show an investor (ORCH R2-G1). The earlier design (class rows
 * with share counts, merged "Other" rows) could be differenced back to single holders; this one is
 * built so that one viewer cannot:
 *
 *  - rows are **kind buckets** only — common, preferred, options (granted options and the pool as
 *    one bucket, so "pool − granted" cannot isolate an optionee), warrants, convertibles;
 *  - a row carries **only** its % of fully diluted, to **1 decimal place** — no share counts, no
 *    amounts, no fully diluted total; convertibles (0 % FD) only say they exist;
 *  - a bucket is shown only when it has **≥ 3 distinct holders other than the viewer with fully
 *    diluted > 0** (distinct by member, else address, else normalised name; pool lines are
 *    unallocated shares, not holders; a 0-share line is nobody) **and is not dominated**: the
 *    largest of those holders has ≤ 70 % of their combined FD and the two largest ≤ 90 %
 *    (ORCH R3-G1 — a figure dominated by one or two holders is their position to within rounding);
 *    anything else is omitted, never folded into another row;
 *  - **complementary suppression**: the omitted share buckets' percentage is 100 − the shown ones,
 *    so the other holders of the omitted buckets, pooled, must pass the same count and dominance
 *    test (or hold nothing); otherwise the smallest shown bucket is omitted too, repeatedly;
 *  - convertibles are shown as present only with ≥ 3 other holders with an amount > 0.
 *
 * Returns `{ buckets: [] }` when no bucket can be shown (the web says "not enough holders to show
 * a breakdown"); `summary: null` is reserved for the `own_line` mode. Residual risks (≥ 3 holders colluding, differencing
 * the same bucket across snapshots over time) are documented in the README.
 */
export function investorSummary(
  classes: readonly SummaryClass[],
  lines: readonly SummaryLine[],
  /**
   * Whether a line is the viewer's: linked to them, or unlinked under one of their addresses
   * (R5). Such lines are neither counted as other holders nor pooled into the complement — the
   * viewer knows them and could subtract them. `null` for a viewer who holds nothing.
   */
  isViewers: ((line: SummaryLine) => boolean) | null,
): InvestorSummary {
  const fd = fullyDilutedByClass(classes, lines);
  const byLine = fullyDilutedByLine(classes, lines);
  const total = sumOf(fd);
  interface Entry {
    fd: bigint;
    /** Other holders' fully diluted, by distinct holder (pool lines are not holders). */
    others: Map<string, bigint>;
    /** Convertibles: other holders with an amount > 0. */
    lenders: Set<string>;
    present: boolean;
  }
  const share = new Map<InvestorBucketKind, Entry>();
  for (const b of INVESTOR_BUCKETS)
    share.set(b, { fd: 0n, others: new Map(), lenders: new Set(), present: false });
  classes.forEach((c, i) => {
    const entry = share.get(BUCKET_OF[c.kind]);
    if (entry !== undefined) entry.fd += fd[i] ?? 0n;
  });
  lines.forEach((l, i) => {
    const kind = classes[l.classIndex]?.kind;
    if (kind === undefined) return;
    const entry = share.get(BUCKET_OF[kind]);
    if (entry === undefined) return;
    entry.present = true;
    if (kind === "option_pool") return; // unallocated shares, not a holder
    if (isViewers?.(l) === true) return;
    const key = holderKey(l);
    if (kind === "safe" || kind === "note") {
      if ((l.amount ?? 0n) > 0n) entry.lenders.add(key);
      return;
    }
    entry.others.set(key, (entry.others.get(key) ?? 0n) + (byLine[i] ?? 0n));
  });
  const shareKinds = INVESTOR_BUCKETS.filter((b) => b !== "convertibles");
  const shown = new Set(
    shareKinds.filter((b) => {
      const e = share.get(b);
      return e?.present === true && describable(e.others);
    }),
  );
  // Complementary suppression (convertibles are outside the FD total): 100 − the shown buckets
  // is the omitted buckets' share, so the omitted other holders — pooled across the omitted
  // buckets — must pass the same count and dominance test, or hold nothing at all.
  for (;;) {
    const omitted = new Map<string, bigint>();
    for (const b of shareKinds) {
      if (shown.has(b)) continue;
      for (const [k, v] of share.get(b)?.others ?? []) omitted.set(k, (omitted.get(k) ?? 0n) + v);
    }
    const held = [...omitted.values()].some((v) => v > 0n);
    if (!held || describable(omitted) || shown.size === 0) break;
    const smallest = [...shown].reduce((a, b) =>
      (share.get(b)?.fd ?? 0n) < (share.get(a)?.fd ?? 0n) ? b : a,
    );
    shown.delete(smallest);
  }
  const buckets: InvestorBucket[] = [];
  for (const b of shareKinds) {
    if (!shown.has(b)) continue;
    buckets.push({
      kind: b as Exclude<InvestorBucketKind, "convertibles">,
      percentFullyDiluted: percentPlaces(share.get(b)?.fd ?? 0n, total, 1),
    });
  }
  const conv = share.get("convertibles");
  if (conv?.present === true && conv.lenders.size >= MIN_OTHER_HOLDERS)
    buckets.push({ kind: "convertibles", present: true });
  return { buckets };
}
