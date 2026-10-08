import { domainToASCII } from "node:url";

/*
 * Hostname normalisation is a security boundary, not input validation (EXECUTION_PLAN §9.2
 * "Host headers not matching a verified domain … are rejected before tenant resolution",
 * design/07 §2.2 step 6). The same string is written to `core.custom_domain.hostname` and
 * later looked up from a request's `Host` header. If the two spellings normalise
 * differently, whoever controls the difference picks which workspace a request resolves to
 * — so every accepted hostname is reduced to exactly one canonical ASCII form here, and
 * anything that cannot be reduced unambiguously is refused rather than repaired.
 */

export type CustomDomainRejection =
  | "empty"
  | "not_a_hostname"
  | "ip_literal"
  | "wildcard"
  | "too_long"
  | "public_suffix"
  | "reserved"
  | "canonical_host"
  | "canonical_subdomain";

export type HostnameCheck =
  | { readonly ok: true; readonly hostname: string }
  | { readonly ok: false; readonly reason: CustomDomainRejection };

/** DNS wire limits (RFC 1035 §2.3.4): 63 octets per label, 253 for the presentation form. */
const MAX_LABEL = 63;
const MAX_TOTAL = 253;

/**
 * Names that must never resolve to a workspace: loopback and the special-use zones
 * (RFC 6761, RFC 8375, RFC 2606). A cert can never be issued for them, and accepting one
 * would let a workspace claim a name that means something else on every machine in the
 * building.
 */
const RESERVED_SUFFIXES = [
  "localhost",
  "local",
  "internal",
  "home.arpa",
  "arpa",
  "test",
  "invalid",
  "example",
  "localdomain",
  "onion",
] as const;

/**
 * A deliberately short, static public-suffix list — enough to catch the mistake this guards
 * against (an admin typing `com` or `co.uk` and claiming every hostname underneath it),
 * without taking on the Public Suffix List as a dependency that has to be refreshed. It is
 * a *safety net*, not an authority: a suffix missing from it is still refused by the
 * canonical-host and TXT-ownership checks that actually protect tenant resolution, because
 * nobody can publish `_fundroom-challenge` under a TLD they do not run.
 */
const PUBLIC_SUFFIXES: ReadonlySet<string> = new Set([
  // single-label
  "com",
  "net",
  "org",
  "edu",
  "gov",
  "mil",
  "int",
  "io",
  "dev",
  "app",
  "co",
  "ai",
  "sh",
  "so",
  "gg",
  "me",
  "tv",
  "cc",
  "xyz",
  "info",
  "biz",
  "site",
  "online",
  "cloud",
  "page",
  "eu",
  "uk",
  "de",
  "fr",
  "nl",
  "es",
  "it",
  "se",
  "no",
  "dk",
  "fi",
  "is",
  "ch",
  "at",
  "be",
  "pl",
  "cz",
  "sk",
  "pt",
  "ie",
  "gr",
  "ro",
  "hu",
  "bg",
  "hr",
  "si",
  "lt",
  "lv",
  "ee",
  "lu",
  "us",
  "ca",
  "mx",
  "br",
  "ar",
  "cl",
  "pe",
  "uy",
  "au",
  "nz",
  "jp",
  "kr",
  "cn",
  "hk",
  "tw",
  "sg",
  "my",
  "th",
  "ph",
  "vn",
  "in",
  "id",
  "il",
  "ae",
  "sa",
  "tr",
  "ru",
  "ua",
  "za",
  "ng",
  "ke",
  "eg",
  "ma",
  // multi-label
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "net.uk",
  "com.au",
  "net.au",
  "org.au",
  "edu.au",
  "co.nz",
  "net.nz",
  "org.nz",
  "co.za",
  "org.za",
  "com.br",
  "net.br",
  "co.jp",
  "or.jp",
  "ne.jp",
  "ac.jp",
  "co.kr",
  "co.in",
  "net.in",
  "org.in",
  "com.mx",
  "com.ar",
  "com.co",
  "co.il",
  "com.cn",
  "com.tw",
  "com.hk",
  "com.sg",
  "com.my",
  "com.tr",
  "com.ua",
  "com.pl",
  "com.es",
  "com.pt",
]);

/**
 * WHATWG URL's "ends in a number" test, and the only thing standing between an IPv4 literal
 * and a stored hostname. `domainToASCII` does **not** normalise IPv4 spellings — it performs
 * IDNA and nothing else, so `127.1` and `2130706433` come back out of it unchanged. That is
 * precisely why the test is written on the last label rather than on a dotted-quad shape: a
 * trailing decimal or `0x…` label is never a real TLD, and it is how every IPv4 spelling ends
 * (`127.0.0.1`, `127.1`, `2130706433`, `0x7f.0.0.1`). Matching dotted quads instead would let
 * the short and integer forms straight through.
 */
function endsInNumber(labels: readonly string[]): boolean {
  const last = labels.at(-1) ?? "";
  if (/^[0-9]+$/u.test(last)) return true;
  return /^0[xX][0-9a-fA-F]*$/u.test(last);
}

function reject(reason: CustomDomainRejection): HostnameCheck {
  return { ok: false, reason };
}

/**
 * Normalises and validates a hostname an admin typed: IDNA → punycode, lower-case, trailing
 * dot stripped, per-label and total length checked. The returned `hostname` is the only
 * spelling that is ever stored or compared; callers must not re-derive their own.
 */
export function normalizeHostname(input: string): HostnameCheck {
  const raw = input.trim();
  if (raw === "") return reject("empty");

  // A wildcard is refused rather than expanded: we verify and serve one exact name, and a
  // stored `*.acme.com` would silently claim every future subdomain including ones the
  // customer later delegates elsewhere.
  if (raw.includes("*")) return reject("wildcard");

  // IPv6 (bracketed or bare) before IDNA, which drops both forms on the floor and would
  // otherwise surface as the vaguer `not_a_hostname`.
  if (raw.includes("[") || raw.includes("]")) return reject("ip_literal");
  if (raw.includes(":")) {
    return /^[0-9a-fA-F:.]+$/u.test(raw) ? reject("ip_literal") : reject("not_a_hostname");
  }
  if (raw.includes("/") || raw.includes("@") || raw.includes("?") || raw.includes("#")) {
    return reject("not_a_hostname");
  }

  // Strip the root label. A trailing dot is a legitimate FQDN spelling, so it is removed
  // rather than refused — but only ever one, `a..` is malformed.
  const rootless = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (rootless === "") return reject("empty");
  // `a..` had two: the second is an empty label, and normalising it away would let one
  // hostname have two spellings that both store as `a`.
  if (rootless.endsWith(".")) return reject("not_a_hostname");

  const ascii = domainToASCII(rootless);
  if (ascii === "") return reject("not_a_hostname");
  // `domainToASCII` keeps a trailing dot and can emit one from an odd unicode form.
  const hostname = ascii.endsWith(".") ? ascii.slice(0, -1) : ascii;
  if (hostname === "") return reject("empty");

  if (hostname.length > MAX_TOTAL) return reject("too_long");

  const labels = hostname.split(".");
  // Post-IDNA, because IDNA mapping folds fullwidth digits: `１２７.0.0.1` arrives here as
  // `127.0.0.1`, and checking only the input would have waved it through.
  if (endsInNumber(labels)) return reject("ip_literal");

  for (const label of labels) {
    if (label === "") return reject("not_a_hostname");
    if (label.length > MAX_LABEL) return reject("too_long");
    // LDH only. `domainToASCII` happily passes underscores and leading hyphens through;
    // neither is a legal hostname and neither can appear in a certificate's SAN.
    if (!/^[a-z0-9-]+$/u.test(label)) return reject("not_a_hostname");
    if (label.startsWith("-") || label.endsWith("-")) return reject("not_a_hostname");
  }
  // The final label must *begin* with a letter, which is stricter than `endsInNumber` above and
  // deliberately identical to `custom_domain_hostname_format` in migration 0007 (E2.1 M6). A TLD
  // that starts with a digit does not exist — IANA has never delegated one, and `xn--` punycode
  // starts with `x` — and the divergence was reachable: `q.123abc`, `test.1abc` and `foo.9bar`
  // passed this validator and then raised a CHECK violation the route answered with a 500. When
  // a validator and a constraint disagree, the constraint wins by definition; the honest place to
  // say no is here, with a 400.
  const last = labels.at(-1) ?? "";
  if (!/^[a-z]/u.test(last)) return reject("not_a_hostname");

  for (const suffix of RESERVED_SUFFIXES) {
    if (hostname === suffix || hostname.endsWith(`.${suffix}`)) return reject("reserved");
  }

  if (PUBLIC_SUFFIXES.has(hostname)) return reject("public_suffix");
  const twoLabel = labels.slice(-2).join(".");
  if (labels.length === 2 && PUBLIC_SUFFIXES.has(twoLabel)) return reject("public_suffix");
  // A single label that is not a known TLD is still not a routable name.
  if (labels.length === 1) return reject("not_a_hostname");

  return { ok: true, hostname };
}

/** The canonical host may arrive with a port (`localhost:3000` in dev) or mixed case. */
function canonicalize(canonicalHost: string): string {
  const host = canonicalHost.trim().toLowerCase().split(":")[0] ?? "";
  const rootless = host.endsWith(".") ? host.slice(0, -1) : host;
  return domainToASCII(rootless) || rootless;
}

/**
 * `normalizeHostname` plus the refusals that depend on where *we* live. The canonical host
 * and anything under it already route through the slug classifier, so a `core.custom_domain`
 * row for one would give a workspace a second, contradictory answer for a hostname that
 * already belongs to someone — a tenant-resolution bypass, not a duplicate. Caller passes
 * the canonical host (`config.canonicalHost`).
 */
export function checkHostname(input: string, canonicalHost: string): HostnameCheck {
  const result = normalizeHostname(input);
  if (!result.ok) return result;

  const canonical = canonicalize(canonicalHost);
  if (canonical === "") return result;
  if (result.hostname === canonical) return reject("canonical_host");
  if (result.hostname.endsWith(`.${canonical}`)) return reject("canonical_subdomain");

  return result;
}
