import { parseCsvRecords } from "@fundroom/csv";
import {
  AMOUNT_INTEGRAL_DIGITS,
  type CaptableSummary,
  computeSummary,
  IMPORT_MAX_BYTES,
  IMPORT_MAX_CLASSES,
  IMPORT_MAX_PROBLEMS,
  IMPORT_MAX_ROWS,
  IMPORT_MAX_WARNINGS,
  type ImportFormat,
  parseQuantity,
  SECURITY_KINDS,
  type SecurityKind,
  SHARES_INTEGRAL_DIGITS,
  type SnapshotSource,
  SOURCE_OF_FORMAT,
  type SummaryClass,
  type SummaryLine,
} from "./model.js";

/*
 * The CSV importer (E3.6 §8), pure: bytes in, a plan or a refusal out. The dry-run and the import
 * both call `planImport` with the same inputs, so what an admin previewed is exactly what is
 * written — there is no second parser on the write path to disagree with the first.
 *
 * Three formats share one pipeline and differ only in their header alias tables:
 *
 *  - `template` — our own CSV (columns documented in the README): exact names, `kind` required.
 *  - `carta`    — a Carta stakeholder / securities ledger export.
 *  - `pulley`   — a Pulley cap table export.
 *
 * The Carta and Pulley column names are **inferred** from their published help articles and
 * sample files, not verified against a real export (both vendors' APIs are partner-gated, so
 * these are file imports; see the README). Each field therefore accepts a ranked list of
 * aliases: the first alias present wins and any other column that also maps to the field is
 * reported as ignored, so a surprise extra column is a warning rather than a wrong number.
 *
 * Whole-file problems (size, row count, missing columns, an unreadable number) refuse the import
 * with every problem listed (up to 100). Things an admin should know but that do not change a
 * figure — an address that matches no member, an inferred security kind, a zero line skipped, a
 * "Total" row skipped — are per-row warnings on an otherwise good plan.
 */

export const IMPORT_FIELDS = [
  "holder_name",
  "holder_email",
  "class",
  "kind",
  "shares",
  "amount",
  "currency",
  "issued_on",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Normalised header → field, per format, in precedence order (first present wins). */
export const HEADER_ALIASES: Readonly<
  Record<ImportFormat, Readonly<Record<ImportField, readonly string[]>>>
> = {
  template: {
    holder_name: ["holder_name"],
    holder_email: ["holder_email"],
    class: ["class"],
    kind: ["kind"],
    shares: ["shares"],
    amount: ["amount"],
    currency: ["currency"],
    issued_on: ["issued_on"],
  },
  // INFERRED (not verified against a real export): Carta "Stakeholder ledger" / "Securities
  // ledger" CSV.
  carta: {
    holder_name: ["stakeholder_name", "stakeholder", "holder_name", "name"],
    holder_email: ["stakeholder_email", "email", "email_address", "holder_email"],
    class: ["share_class", "security_class", "share_class_name", "stock_class", "class"],
    kind: ["security_type", "type", "class_type"],
    shares: [
      "quantity_outstanding",
      "outstanding_quantity",
      "outstanding",
      "shares_outstanding",
      "outstanding_shares",
      "quantity",
      "shares",
      "quantity_issued",
    ],
    amount: ["principal", "principal_amount", "investment_amount", "cash_paid", "amount"],
    currency: ["currency", "currency_code"],
    issued_on: ["issue_date", "date_issued", "issued_on", "grant_date"],
  },
  // INFERRED (not verified against a real export): Pulley "Cap table export" CSV.
  pulley: {
    holder_name: ["stakeholder", "stakeholder_name", "investor_name", "holder_name", "name"],
    holder_email: ["stakeholder_email", "email", "email_address", "holder_email"],
    class: ["share_class", "security_class", "share_class_name", "instrument", "class"],
    kind: ["security_type", "instrument_type", "type"],
    shares: ["shares", "number_of_shares", "shares_outstanding", "outstanding_shares", "quantity"],
    amount: ["investment_amount", "principal", "amount_invested", "cash_invested", "amount"],
    currency: ["currency", "currency_code"],
    issued_on: ["issue_date", "grant_date", "issued_on", "date"],
  },
};

/** A header cell as a key: lower case, every run of non-alphanumerics one `_`, trimmed. */
export function normalizeHeader(cell: string): string {
  return cell
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

export interface ImportProblem {
  readonly line: number | null;
  readonly column: string | null;
  readonly code: string;
  readonly message: string;
}

export type ImportRefusalReason =
  | "empty"
  | "too_large"
  | "too_many_rows"
  | "missing_columns"
  | "duplicate_column"
  | "invalid_rows";

export interface PlannedLine {
  /** 1-based physical line of the CSV. */
  readonly line: number;
  readonly classIndex: number;
  readonly holderName: string;
  readonly holderEmail: string | null;
  readonly membershipId: string | null;
  readonly shares: bigint | null;
  readonly amount: bigint | null;
  readonly currency: string | null;
  /** `YYYY-MM-DD`. */
  readonly issuedOn: string | null;
}

export interface ImportPlan {
  readonly format: ImportFormat;
  readonly source: SnapshotSource;
  /** Data records read (after the header; blank lines are not records). */
  readonly rows: number;
  readonly classes: readonly SummaryClass[];
  readonly lines: readonly PlannedLine[];
  readonly warnings: readonly ImportProblem[];
  readonly summary: CaptableSummary;
  readonly matched: number;
  readonly unmatched: number;
}

export type PlanResult =
  | { readonly ok: true; readonly plan: ImportPlan }
  | {
      readonly ok: false;
      readonly reason: ImportRefusalReason;
      readonly problems: readonly ImportProblem[];
    };

export interface PlanInput {
  readonly format: ImportFormat;
  readonly csv: string;
  /**
   * Live members by lower-cased address. Built by the caller from live memberships only; a
   * member whose erasure is pending is left out of it.
   */
  readonly members: ReadonlyMap<string, string>;
  /** Default currency for an amount whose row names none. */
  readonly defaultCurrency?: string | undefined;
}

const KIND_WORDS: Readonly<Record<string, SecurityKind>> = {
  common: "common",
  common_stock: "common",
  common_shares: "common",
  ordinary: "common",
  ordinary_shares: "common",
  preferred: "preferred",
  preferred_stock: "preferred",
  preferred_shares: "preferred",
  preference_shares: "preferred",
  option_pool: "option_pool",
  pool: "option_pool",
  available_for_grant: "option_pool",
  unallocated: "option_pool",
  option: "option",
  options: "option",
  stock_option: "option",
  stock_options: "option",
  option_grant: "option",
  iso: "option",
  nso: "option",
  warrant: "warrant",
  warrants: "warrant",
  safe: "safe",
  safes: "safe",
  note: "note",
  notes: "note",
  convertible_note: "note",
  convertible_notes: "note",
  convertible: "note",
};

/** A kind column's value as a kind, or `undefined` when it names none we know. */
export function kindFromWord(value: string): SecurityKind | undefined {
  const k = normalizeHeader(value);
  if ((SECURITY_KINDS as readonly string[]).includes(k)) return k as SecurityKind;
  return KIND_WORDS[k];
}

/** A kind guessed from a class name ("Series A Preferred", "2021 Stock Plan", "Post-money SAFE"). */
export function kindFromClassName(name: string): SecurityKind | undefined {
  const n = name.toLowerCase();
  if (/\bsafes?\b/u.test(n)) return "safe";
  if (/convertible|\bnotes?\b/u.test(n)) return "note";
  if (/warrant/u.test(n)) return "warrant";
  if (/\bpool\b|available|unallocated|unissued|reserved/u.test(n)) return "option_pool";
  if (/option|\besop\b|\biso\b|\bnso\b|incentive|stock plan|equity plan/u.test(n)) return "option";
  if (/preferred|preference|\bseries\b|\bseed\b/u.test(n)) return "preferred";
  if (/common|ordinary|founder/u.test(n)) return "common";
  return undefined;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const TOTAL_ROW_RE = /^(grand\s+)?totals?:?$/iu;

/**
 * Currency symbols and spaces are formatting, not data. A comma is accepted **only** as a
 * thousands separator — groups of exactly three digits, with any `.` fraction after the last
 * group (`1,234,567.89`). Anything else with a comma (`1,5`, European `1.234,5`) is ambiguous:
 * stripping the comma would silently turn 1,5 into 15, so the row is refused instead.
 */
export function cleanNumber(raw: string): string | "ambiguous" {
  const s = raw.replace(/[\s$€£¥]/gu, "").replace(/^(?:USD|EUR|GBP)/iu, "");
  if (!s.includes(",")) return s;
  if (!/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d*)?$/u.test(s)) return "ambiguous";
  return s.replace(/,/gu, "");
}

function isRealDate(y: number, m: number, d: number): boolean {
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    y >= 1900 &&
    y <= 2200 &&
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD`, `YYYY/MM/DD` or US `M/D/YYYY` (what Carta and Pulley write) → `YYYY-MM-DD`. */
export function parseDate(raw: string): string | undefined {
  const s = raw.trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[T ].*)?$/u.exec(s);
  if (m !== null) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isRealDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : undefined;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(s);
  if (m !== null) {
    const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
    return isRealDate(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : undefined;
  }
  return undefined;
}

class ProblemList {
  readonly items: ImportProblem[] = [];
  total = 0;
  constructor(private readonly cap: number) {}
  add(line: number | null, column: string | null, code: string, message: string): void {
    this.total += 1;
    if (this.items.length < this.cap) this.items.push({ line, column, code, message });
  }
  finish(): ImportProblem[] {
    if (this.total <= this.items.length) return this.items;
    return [
      ...this.items,
      {
        line: null,
        column: null,
        code: "truncated",
        message: `${this.total - this.items.length} more not shown`,
      },
    ];
  }
}

const refuse = (reason: ImportRefusalReason, problems: ImportProblem[]): PlanResult => ({
  ok: false,
  reason,
  problems,
});

export function planImport(input: PlanInput): PlanResult {
  const { format, csv, members } = input;
  const defaultCurrency = input.defaultCurrency ?? "USD";
  if (Buffer.byteLength(csv, "utf8") > IMPORT_MAX_BYTES) {
    return refuse("too_large", [
      {
        line: null,
        column: null,
        code: "too_large",
        message: `the CSV is larger than ${IMPORT_MAX_BYTES} bytes`,
      },
    ]);
  }
  const records = parseCsvRecords(csv);
  const header = records[0];
  if (header === undefined || records.length < 2) {
    return refuse("empty", [
      { line: null, column: null, code: "empty", message: "the CSV has no data rows" },
    ]);
  }
  const data = records.slice(1);
  if (data.length > IMPORT_MAX_ROWS) {
    return refuse("too_many_rows", [
      {
        line: null,
        column: null,
        code: "too_many_rows",
        message: `the CSV has ${data.length} rows; at most ${IMPORT_MAX_ROWS} are accepted`,
      },
    ]);
  }

  // --- header -----------------------------------------------------------------------------
  const warnings = new ProblemList(IMPORT_MAX_WARNINGS);
  const normalized = header.cells.map(normalizeHeader);
  const aliases = HEADER_ALIASES[format];
  const columnOf = new Map<ImportField, number>();
  for (const field of IMPORT_FIELDS) {
    const candidates = aliases[field];
    let chosen: string | undefined;
    for (const alias of candidates) {
      const hits = normalized.flatMap((h, i) => (h === alias ? [i] : []));
      if (hits.length === 0) continue;
      if (chosen === undefined) {
        if (hits.length > 1) {
          return refuse("duplicate_column", [
            {
              line: header.line,
              column: header.cells[hits[1] ?? 0] ?? alias,
              code: "duplicate_column",
              message: `more than one column is named "${alias}"`,
            },
          ]);
        }
        chosen = alias;
        columnOf.set(field, hits[0] ?? 0);
      } else {
        for (const i of hits) {
          warnings.add(
            header.line,
            header.cells[i] ?? alias,
            "column_ignored",
            `column "${header.cells[i]}" also looks like ${field}; "${header.cells[columnOf.get(field) ?? 0]}" was used`,
          );
        }
      }
    }
  }
  const missing: ImportProblem[] = [];
  const need = (field: ImportField) => {
    if (!columnOf.has(field))
      missing.push({
        line: header.line,
        column: aliases[field][0] ?? field,
        code: "missing_column",
        message: `no column for ${field} (expected one of: ${aliases[field].join(", ")})`,
      });
  };
  need("holder_name");
  need("class");
  if (format === "template") need("kind");
  if (!columnOf.has("shares") && !columnOf.has("amount")) {
    missing.push({
      line: header.line,
      column: aliases.shares[0] ?? "shares",
      code: "missing_column",
      message: `no column for shares or amount (expected one of: ${[...aliases.shares, ...aliases.amount].join(", ")})`,
    });
  }
  if (missing.length > 0) return refuse("missing_columns", missing);

  // --- rows -------------------------------------------------------------------------------
  const problems = new ProblemList(IMPORT_MAX_PROBLEMS);
  const classes: SummaryClass[] = [];
  const classIndex = new Map<string, number>();
  const lines: PlannedLine[] = [];
  const warnedEmails = new Set<string>();
  const columnName = (field: ImportField) => header.cells[columnOf.get(field) ?? -1] ?? field;
  const cell = (cells: readonly string[], field: ImportField): string => {
    const i = columnOf.get(field);
    return i === undefined ? "" : (cells[i] ?? "").trim();
  };

  for (const rec of data) {
    const { cells, line } = rec;
    const name = cell(cells, "holder_name");
    if (TOTAL_ROW_RE.test(name) || (name === "" && TOTAL_ROW_RE.test(cell(cells, "class")))) {
      warnings.add(line, null, "total_row_skipped", "a totals row was skipped");
      continue;
    }
    let bad = false;
    const fail = (field: ImportField | null, code: string, message: string) => {
      bad = true;
      problems.add(line, field === null ? null : columnName(field), code, message);
    };

    if (name.length === 0) fail("holder_name", "holder_name_missing", "the holder has no name");
    else if (name.length > 200)
      fail("holder_name", "holder_name_too_long", "the holder name is longer than 200 characters");

    const className = cell(cells, "class");
    if (className.length === 0) fail("class", "class_missing", "the row names no class");
    else if (className.length > 120)
      fail("class", "class_too_long", "the class name is longer than 120 characters");

    // kind: the column (template: required and must be valid), else inferred from the class name.
    const kindRaw = cell(cells, "kind");
    let kind: SecurityKind | undefined;
    if (kindRaw.length > 0) kind = kindFromWord(kindRaw);
    if (kind === undefined && format === "template") {
      fail(
        "kind",
        "kind_invalid",
        kindRaw.length === 0
          ? "the row has no kind"
          : `"${kindRaw}" is not one of ${SECURITY_KINDS.join(", ")}`,
      );
    }
    if (kind === undefined && format !== "template" && className.length > 0) {
      kind = kindFromClassName(className) ?? kindFromClassName(kindRaw);
      if (kind === undefined) {
        kind = "common";
        warnings.add(
          line,
          columnName("class"),
          "kind_assumed",
          `could not tell what kind of security "${className}" is; treated as common`,
        );
      } else if (kindRaw.length > 0) {
        warnings.add(
          line,
          columnName("kind"),
          "kind_inferred",
          `"${kindRaw}" is not a known security type; "${className}" read as ${kind}`,
        );
      }
    }

    const readQuantity = (field: "shares" | "amount"): bigint | null | "bad" => {
      const raw = cell(cells, field);
      if (raw.length === 0 || raw === "-") return null;
      const cleaned = cleanNumber(raw);
      if (cleaned === "ambiguous") {
        fail(
          field,
          `${field}_ambiguous`,
          `"${raw}" is ambiguous: use a comma only between groups of three digits and a point for decimals`,
        );
        return "bad";
      }
      const value = parseQuantity(
        cleaned,
        field === "shares" ? SHARES_INTEGRAL_DIGITS : AMOUNT_INTEGRAL_DIGITS,
      );
      if (value === undefined) {
        fail(field, `${field}_invalid`, `"${raw}" is not a number (or too large for the column)`);
        return "bad";
      }
      if (value < 0n) {
        fail(field, `${field}_negative`, `"${raw}" is negative`);
        return "bad";
      }
      return value;
    };
    const shares = readQuantity("shares");
    const amount = readQuantity("amount");

    let currency: string | null = null;
    const currencyRaw = cell(cells, "currency").toUpperCase();
    if (currencyRaw.length > 0) {
      if (/^[A-Z]{3}$/u.test(currencyRaw)) currency = currencyRaw;
      else fail("currency", "currency_invalid", `"${currencyRaw}" is not an ISO 4217 code`);
    }

    let email: string | null = cell(cells, "holder_email");
    if (email.length === 0) email = null;
    else if (!EMAIL_RE.test(email) || email.length > 320) {
      warnings.add(
        line,
        columnName("holder_email"),
        "email_invalid",
        "the address is not valid; it was left out",
      );
      email = null;
    }

    let issuedOn: string | null = null;
    const dateRaw = cell(cells, "issued_on");
    if (dateRaw.length > 0) {
      issuedOn = parseDate(dateRaw) ?? null;
      if (issuedOn === null)
        warnings.add(
          line,
          columnName("issued_on"),
          "date_invalid",
          `"${dateRaw}" is not a date (YYYY-MM-DD or M/D/YYYY); it was left out`,
        );
    }

    if (bad || kind === undefined || shares === "bad" || amount === "bad") continue;

    const isConvertible = kind === "safe" || kind === "note";
    if (shares === null && amount === null) {
      fail(null, "quantity_missing", "the row has neither shares nor an amount");
      continue;
    }
    if (isConvertible && amount === null) {
      fail("amount", "amount_missing", `a ${kind} needs an amount (its principal)`);
      continue;
    }
    if (!isConvertible && shares === null) {
      fail("shares", "shares_missing", `a ${kind} line needs a number of shares`);
      continue;
    }
    if ((shares ?? 0n) === 0n && (amount ?? 0n) === 0n) {
      warnings.add(line, null, "zero_line_skipped", "a line with nothing outstanding was skipped");
      continue;
    }
    if (amount !== null && currency === null) {
      currency = defaultCurrency;
      warnings.add(
        line,
        columnName("currency"),
        "currency_assumed",
        `no currency given; ${defaultCurrency} assumed`,
      );
    }

    let ci = classIndex.get(className);
    if (ci === undefined) {
      if (classes.length >= IMPORT_MAX_CLASSES) {
        fail("class", "too_many_classes", `more than ${IMPORT_MAX_CLASSES} classes`);
        continue;
      }
      ci = classes.length;
      classes.push({ name: className, kind, position: ci });
      classIndex.set(className, ci);
    } else if (classes[ci]?.kind !== kind) {
      fail(
        "kind",
        "class_kind_conflict",
        `class "${className}" is ${classes[ci]?.kind} on an earlier row and ${kind} here`,
      );
      continue;
    }

    const membershipId = email === null ? null : (members.get(email.toLowerCase()) ?? null);
    if (email !== null && membershipId === null && !warnedEmails.has(email.toLowerCase())) {
      warnedEmails.add(email.toLowerCase());
      warnings.add(
        line,
        columnName("holder_email"),
        "email_unmatched",
        "no live member has this address; the line is not linked to anybody's portal",
      );
    }
    lines.push({
      line,
      classIndex: ci,
      holderName: name,
      holderEmail: email,
      membershipId,
      shares,
      amount,
      currency: amount === null ? null : currency,
      issuedOn,
    });
  }

  if (problems.total > 0) return refuse("invalid_rows", problems.finish());
  if (lines.length === 0) {
    return refuse("empty", [
      { line: null, column: null, code: "empty", message: "the CSV has no importable rows" },
    ]);
  }
  const summaryLines: SummaryLine[] = lines;
  const summary = computeSummary(classes, summaryLines);
  const matched = lines.filter((l) => l.membershipId !== null).length;
  return {
    ok: true,
    plan: {
      format,
      source: SOURCE_OF_FORMAT[format],
      rows: data.length,
      classes,
      lines,
      warnings: warnings.finish(),
      summary,
      matched,
      unmatched: lines.length - matched,
    },
  };
}
