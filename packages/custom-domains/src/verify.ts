import { createHash, timingSafeEqual } from "node:crypto";
import type { CustomDomainRequirements, DnsAnswer } from "@fundroom/ports";
import { CHALLENGE_LABEL, LEGACY_CHALLENGE_LABEL } from "./records.js";

/*
 * The verdict (design/07 §2.2 step 3). Pure: two answers in, a decision and one sentence out.
 * The sentence is the whole reason this is not a boolean — "verification failed" tells a
 * founder nothing, while "acme.com is a CNAME to shops.myshopify.com, not edge.example.com"
 * tells them exactly which record to fix, and it is what §9.2 means by "last resolver answer
 * shown in the UI".
 */

export interface DnsVerdict {
  readonly ok: boolean;
  readonly cnameOk: boolean;
  readonly txtOk: boolean;
  /** One short operator-facing sentence naming what DNS actually said. */
  readonly detail: string;
}

function normalizeName(value: string): string {
  const lower = value.trim().toLowerCase();
  return lower.endsWith(".") ? lower.slice(0, -1) : lower;
}

/**
 * TXT values arrive quoted and, over 255 octets, chunked: `"seed" "host"`. Quotes and
 * whitespace are presentation, not content, so both are removed before comparing.
 */
function normalizeTxt(value: string): string {
  return value.replace(/["\\]/gu, "").replace(/\s+/gu, "").toLowerCase();
}

/**
 * The token is a secret proof of control, so it is compared in constant time. Digesting both
 * sides first makes the comparison length-independent — `timingSafeEqual` throws on unequal
 * lengths, and a length-leaking guard would hand an attacker the token's length for free.
 */
function tokenMatches(found: string, expected: string): boolean {
  const a = createHash("sha256").update(found).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Trim and de-fang a value we are about to quote back at an operator: it is data from
 *  somebody else's zone, and it ends up in a UI string and an audit row. */
function quoteFound(values: readonly string[]): string {
  const first = values[0] ?? "";
  const clean = first.replace(/[^\x20-\x7e]/gu, "?");
  return clean.length > 60 ? `${clean.slice(0, 60)}…` : clean;
}

function rcodeNote(answer: DnsAnswer): string | undefined {
  switch (answer.rcode) {
    case "nxdomain":
      return `${answer.name} does not exist (NXDOMAIN at ${answer.resolver})`;
    case "servfail":
      return `${answer.name} could not be resolved (SERVFAIL at ${answer.resolver}) — the zone's nameservers did not answer`;
    case "refused":
      return `${answer.resolver} refused the query for ${answer.name}`;
    case "other":
      return `no usable answer for ${answer.name} (the resolvers disagreed or could not be reached)`;
    case "ok":
      return undefined;
    default:
      return undefined;
  }
}

/** The CNAME half of the sentence, only ever built when the provider requires the CNAME. */
function cnameDetail(
  cname: DnsAnswer,
  target: string,
  cnameOk: boolean,
  chain: readonly string[],
  values: readonly string[],
): string {
  if (cnameOk) {
    const via = chain.length > 1 ? ` via ${chain.slice(0, -1).join(" → ")}` : "";
    return `${cname.name} points at ${target}${via}`;
  }
  const note = rcodeNote(cname);
  if (note !== undefined) return `${note}; expected a CNAME to ${target}`;
  if (values.length === 0) {
    return `${cname.name} has no ${cname.type} record at ${cname.resolver}; add a CNAME to ${target} (on an apex, an ALIAS/CNAME-flattening record)`;
  }
  return `${cname.name} resolves to ${values.join(", ")}, not ${target} (${cname.resolver})`;
}

/**
 * The TXT half of the sentence: the proof of control, required by every shipped provider.
 * `label` is the label the answer was looked up under — the sentence names the record that
 * actually matched, so a domain still proven by the pre-rename record is not told it has the
 * new one (which would be the cue to delete the only record that verifies it).
 */
function txtDetail(txt: DnsAnswer, txtOk: boolean, label: string): string {
  if (txtOk) {
    return label === LEGACY_CHALLENGE_LABEL
      ? `${label} TXT matches (the pre-rename label, still accepted; ${CHALLENGE_LABEL} is the current one)`
      : `${label} TXT matches`;
  }
  const note = rcodeNote(txt);
  if (note !== undefined) return note;
  if (txt.values.length === 0) return `${txt.name} has no TXT record at ${txt.resolver}`;
  return `${txt.name} returned a different token ("${quoteFound(txt.values)}") at ${txt.resolver}`;
}

/**
 * Whether a TXT answer carries the challenge token — the same test `evaluate` applies, exposed
 * so `judge()` can decide whether the legacy label is worth a lookup without building a sentence.
 * `rcode === "ok"` is part of it for the reason given in `evaluate` (E2.1 M11).
 */
export function txtCarriesToken(txt: DnsAnswer, token: string): boolean {
  const expected = normalizeTxt(token);
  return (
    txt.rcode === "ok" &&
    expected !== "" &&
    txt.values.some((value) => tokenMatches(normalizeTxt(value), expected))
  );
}

/**
 * Pure verdict from two answers. `cnameOk` tolerates a chain that ends at the target and
 * also accepts A/AAAA pointing at us (apex flattening — design/07 §2.3(a)).
 *
 * A chain is accepted wherever the target appears in it, not only as the final hop: the
 * common shape is a customer CNAME into a proxy that CNAMEs on to our edge, and traffic
 * reaching our edge is all the CNAME row has to establish. It is the TXT record, not the
 * CNAME, that proves who controls the name.
 *
 * For the apex case the caller resolves `A`/`AAAA` instead of `CNAME` and passes the edge's
 * expected address as `cnameTarget`; any answer whose type is not `CNAME` is matched against
 * `values` only, because a flattened apex has no chain to walk.
 *
 * **`requires` decides what `ok` means, and it is not optional.** `ok` used to be
 * `cnameOk && txtOk`, which silently disagreed with the `manual` provider: that driver has no
 * edge of ours to CNAME to (the operator terminates TLS themselves), so it shows the operator
 * a TXT record and nothing else — and a hostname that published exactly what it was asked for
 * then failed on a CNAME nobody mentioned, or, with no target configured, could never verify at
 * all. With the requirement passed in, a check the provider does not require is neither gated
 * on **nor mentioned in `detail`**: telling a `manual` operator their CNAME is wrong is telling
 * them to change something we have no opinion about. `cnameOk` / `txtOk` still report what DNS
 * said either way, so the UI can show the answer without it being a verdict.
 */
export function evaluate(input: {
  readonly cname: DnsAnswer;
  readonly txt: DnsAnswer;
  readonly token: string;
  readonly cnameTarget: string;
  /** What the configured provider needs proven; `provider.requires` verbatim. */
  readonly requires: CustomDomainRequirements;
  /** The label `txt` was looked up under (default `CHALLENGE_LABEL`); named in `detail`. */
  readonly txtLabel?: string | undefined;
}): DnsVerdict {
  const target = normalizeName(input.cnameTarget);
  const { cname, txt } = input;

  const values = cname.values.map(normalizeName);
  const chain = (cname.chain ?? []).map(normalizeName);
  // `rcode === "ok"` is required for a *positive* verdict (E2.1 M11). A SERVFAIL or a
  // "resolvers disagreed" answer that happens to carry a record is not an answer we are
  // entitled to act on, and this keeps the verdict consistent with `modules/updates`'
  // `lookupTxt`, which already treats anything but `ok`/`nxdomain` as "we could not look".
  // Nothing reachable without two colluding resolvers produces such an answer today; this is
  // the cheap half of defence in depth, and `cnameOk`/`txtOk` staying false is also the
  // direction the failure should point.
  const cnameOk =
    cname.rcode === "ok" && target !== "" && (values.includes(target) || chain.includes(target));

  const txtOk = txtCarriesToken(txt, input.token);

  // One clause per check the provider actually requires. A check it does not require is
  // neither gated on nor mentioned: telling a `manual` operator their CNAME is wrong is
  // telling them to fix a record this install has no opinion about.
  const details: string[] = [];
  if (input.requires.cname) details.push(cnameDetail(cname, target, cnameOk, chain, values));
  if (input.requires.txt) {
    details.push(txtDetail(txt, txtOk, input.txtLabel ?? CHALLENGE_LABEL));
  }

  const ok = (!input.requires.cname || cnameOk) && (!input.requires.txt || txtOk);
  // `details` is empty only for a provider that requires nothing, which
  // `createCustomDomainService` refuses; say something rather than emit a bare ".".
  const detail =
    details.length === 0 ? "no DNS check is required on this install." : `${details.join("; ")}.`;
  return { ok, cnameOk, txtOk, detail };
}
