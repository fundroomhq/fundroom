import { scimInvalidFilter, scimInvalidPath } from "./errors.js";
import { CONTROL_RE } from "./resources.js";

/*
 * SCIM filter + attribute-path parser (RFC 7644 §3.4.2.2, §3.5.2). Pure.
 *
 * The whole grammar is parsed (every comparison operator, `pr`, `and`/`or`/`not`, parentheses,
 * value paths `emails[type eq "work"]`, sub-attributes, URN-prefixed attribute names) so a
 * well-formed filter is never refused as `invalidSyntax`; what the service can EVALUATE is a
 * subset (see the service's filter compiler), and anything outside it is `invalidFilter`.
 *
 * Attribute names are case-insensitive (RFC 7643 §2.1): `AttrPath.attr`/`sub` are kept as sent,
 * `attrKey`/`subKey` are the lower-cased forms callers match on. Keywords (`and`, `EQ`, `Pr`, …)
 * are case-insensitive. String literals are JSON strings (escapes `\" \\ \/ \b \f \n \r \t
 * \uXXXX`).
 */

export type CompareOp = "eq" | "ne" | "co" | "sw" | "ew" | "gt" | "ge" | "lt" | "le";
export type FilterValue = string | number | boolean | null;

export interface AttrPath {
  /** The schema URN when the name was URN-prefixed, lower-cased. */
  readonly schema?: string | undefined;
  readonly attr: string;
  readonly attrKey: string;
  /** `[valFilter]` on a multi-valued attribute. */
  readonly filter?: FilterNode | undefined;
  readonly sub?: string | undefined;
  readonly subKey?: string | undefined;
}

export type FilterNode =
  | {
      readonly kind: "compare";
      readonly path: AttrPath;
      readonly op: CompareOp;
      readonly value: FilterValue;
    }
  | { readonly kind: "present"; readonly path: AttrPath }
  /** `members[value eq "x"]` on its own: some element matches. */
  | { readonly kind: "has"; readonly path: AttrPath }
  | { readonly kind: "and" | "or"; readonly left: FilterNode; readonly right: FilterNode }
  | { readonly kind: "not"; readonly expr: FilterNode };

const COMPARE_OPS = new Set<string>(["eq", "ne", "co", "sw", "ew", "gt", "ge", "lt", "le"]);
const MAX_FILTER_LENGTH = 4096;
const MAX_DEPTH = 32;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_$-]*$/u;

/** Characters that end a bare token (attribute name, keyword, literal). */
function isDelimiter(ch: string): boolean {
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === "(" ||
    ch === ")" ||
    ch === "[" ||
    ch === "]" ||
    ch === '"'
  );
}

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(
    private readonly src: string,
    private readonly error: (detail: string) => Error,
  ) {}

  done(): boolean {
    this.skipWs();
    return this.pos >= this.src.length;
  }

  private skipWs(): void {
    while (this.pos < this.src.length && /\s/u.test(this.src[this.pos] ?? "")) this.pos++;
  }

  private peekChar(): string | undefined {
    this.skipWs();
    return this.src[this.pos];
  }

  /** A bare token (no whitespace/brackets/quotes), without consuming it. */
  private peekWord(): string {
    this.skipWs();
    let end = this.pos;
    while (end < this.src.length && !isDelimiter(this.src[end] ?? "")) end++;
    return this.src.slice(this.pos, end);
  }

  private readWord(): string {
    const w = this.peekWord();
    this.pos += w.length;
    return w;
  }

  private expect(ch: string): void {
    if (this.peekChar() !== ch) throw this.error(`expected '${ch}' at position ${this.pos}`);
    this.pos++;
  }

  parseFilter(): FilterNode {
    if (++this.depth > MAX_DEPTH) throw this.error("filter nests too deeply");
    let left = this.parseAnd();
    while (this.peekWord().toLowerCase() === "or") {
      this.readWord();
      left = { kind: "or", left, right: this.parseAnd() };
    }
    this.depth--;
    return left;
  }

  private parseAnd(): FilterNode {
    let left = this.parseUnary();
    while (this.peekWord().toLowerCase() === "and") {
      this.readWord();
      left = { kind: "and", left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): FilterNode {
    const ch = this.peekChar();
    if (ch === undefined) throw this.error("unexpected end of filter");
    if (ch === "(") {
      this.pos++;
      const inner = this.parseFilter();
      this.expect(")");
      return inner;
    }
    const word = this.peekWord();
    if (word.toLowerCase() === "not") {
      const save = this.pos;
      this.readWord();
      if (this.peekChar() === "(") {
        this.pos++;
        const inner = this.parseFilter();
        this.expect(")");
        return { kind: "not", expr: inner };
      }
      this.pos = save; // an attribute literally called `not`
    }
    return this.parseAttrExpr();
  }

  private parseAttrExpr(): FilterNode {
    const path = this.parsePath(true);
    const opWord = this.peekWord();
    const op = opWord.toLowerCase();
    if (path.filter !== undefined && path.sub === undefined) {
      // `members[value eq "x"]` stands alone unless an operator follows.
      if (!COMPARE_OPS.has(op) && op !== "pr") return { kind: "has", path };
    }
    if (op === "pr") {
      this.readWord();
      return { kind: "present", path };
    }
    if (!COMPARE_OPS.has(op)) {
      throw this.error(`expected an operator after '${path.attr}', got '${opWord}'`);
    }
    this.readWord();
    return { kind: "compare", path, op: op as CompareOp, value: this.parseValue() };
  }

  private parseValue(): FilterValue {
    const ch = this.peekChar();
    if (ch === '"') return this.parseString();
    const word = this.readWord();
    const lower = word.toLowerCase();
    if (lower === "true") return true;
    if (lower === "false") return false;
    if (lower === "null") return null;
    if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(word)) return Number(word);
    throw this.error(`invalid comparison value '${word}'`);
  }

  private parseString(): string {
    const start = this.pos;
    this.pos++; // opening quote
    while (this.pos < this.src.length) {
      const c = this.src[this.pos];
      if (c === "\\") {
        this.pos += 2;
        continue;
      }
      if (c === '"') {
        this.pos++;
        const raw = this.src.slice(start, this.pos);
        let value: string;
        try {
          value = JSON.parse(raw) as string;
        } catch {
          throw this.error("invalid string escape");
        }
        // NUL (which Postgres refuses) and other control characters, raw or escaped.
        if (CONTROL_RE.test(value)) throw this.error("control characters in a string");
        return value;
      }
      this.pos++;
    }
    throw this.error("unterminated string");
  }

  /**
   * `[urn:…:]attr[.sub]`, or `attr[valFilter][.sub]` when `allowFilter`.
   */
  parsePath(allowFilter: boolean): AttrPath {
    this.skipWs();
    const start = this.pos;
    let end = start;
    while (end < this.src.length && !isDelimiter(this.src[end] ?? "")) end++;
    const token = this.src.slice(start, end);
    this.pos = end;
    if (token.length === 0) throw this.error(`expected an attribute at position ${start}`);
    const named = splitName(token, this.error);
    if (this.src[this.pos] === "[") {
      if (!allowFilter) throw this.error("a value filter is not allowed here");
      if (named.sub !== undefined) throw this.error("a value filter must follow the attribute");
      this.pos++;
      if (++this.depth > MAX_DEPTH) throw this.error("filter nests too deeply");
      const filter = this.parseFilter();
      this.depth--;
      this.expect("]");
      let sub: string | undefined;
      if (this.src[this.pos] === ".") {
        this.pos++;
        const s = this.pos;
        while (this.pos < this.src.length && !isDelimiter(this.src[this.pos] ?? "")) this.pos++;
        sub = this.src.slice(s, this.pos);
        if (!NAME_RE.test(sub)) throw this.error(`invalid sub-attribute '${sub}'`);
      }
      return {
        ...named,
        filter,
        ...(sub === undefined ? {} : { sub, subKey: sub.toLowerCase() }),
      };
    }
    return named;
  }
}

/** Splits `urn:…:User:name.givenName` / `name.givenName` / `userName`. */
function splitName(token: string, error: (d: string) => Error): AttrPath {
  let schema: string | undefined;
  let rest = token;
  if (token.toLowerCase().startsWith("urn:")) {
    const i = token.lastIndexOf(":");
    schema = token.slice(0, i).toLowerCase();
    rest = token.slice(i + 1);
  }
  const parts = rest.split(".");
  if (parts.length > 2 || parts.some((p) => !NAME_RE.test(p))) {
    throw error(`invalid attribute name '${token}'`);
  }
  const attr = parts[0] as string;
  const sub = parts[1];
  return {
    ...(schema === undefined ? {} : { schema }),
    attr,
    attrKey: attr.toLowerCase(),
    ...(sub === undefined ? {} : { sub, subKey: sub.toLowerCase() }),
  };
}

/** Parses a `filter` query parameter. Throws `ScimError` 400 `invalidFilter`. */
export function parseFilter(input: string): FilterNode {
  if (input.length > MAX_FILTER_LENGTH) throw scimInvalidFilter("filter is too long");
  const p = new Parser(input, scimInvalidFilter);
  const node = p.parseFilter();
  if (!p.done()) throw scimInvalidFilter("unexpected text after the filter");
  return node;
}

/** Parses a PATCH `path` (`emails[type eq "work"].value`, `members[value eq "…"]`, URN names). */
export function parsePath(input: string): AttrPath {
  if (input.length > MAX_FILTER_LENGTH) throw scimInvalidPath("path is too long");
  const p = new Parser(input.trim(), scimInvalidPath);
  const path = p.parsePath(true);
  if (!p.done()) throw scimInvalidPath(`invalid path '${input}'`);
  return path;
}

/**
 * An attribute name inside a path-less PATCH value object (`"name.givenName"`,
 * `"urn:…:enterprise:2.0:User:employeeNumber"`, `"active"`). No value filters.
 */
export function parseAttrName(input: string): AttrPath {
  return splitName(input, scimInvalidPath);
}

/** Case-insensitive schema-URN match. */
export function schemaIs(path: AttrPath, urn: string): boolean {
  return path.schema === undefined || path.schema === urn.toLowerCase();
}
