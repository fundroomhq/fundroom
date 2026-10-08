import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeHostname } from "@fundroom/custom-domains";
import type { DnsAnswer } from "@fundroom/ports";

/*
 * SSO email-domain ownership (ADR-0056 decision 6): an admin proves a domain with a DNS TXT
 * record `_fundroom-sso.<domain>` = `fundroom-sso=<token>`; only a verified domain lets an IdP's
 * email claim link to an existing account or JIT-provision a new one. A verified domain belongs to
 * one workspace per install (partial unique index); a pending claim is exclusive to nobody
 * (ADR-0039: a squatter's pending row must not block the real owner).
 */

/** The record an admin is told to publish (A-2: renamed from `_seedhost-sso` / `seedhost-sso=`). */
export const SSO_TXT_LABEL = "_fundroom-sso";
export const SSO_TXT_PREFIX = "fundroom-sso=";
/**
 * The pre-rename label and value prefix, accepted **permanently** and never shown. A pending
 * domain added before the rename was told to publish these, and the token stored in the row is
 * only the random part, so the same proof can be recognised under either spelling. Any of the
 * four combinations (either label, either prefix) carrying this row's token proves the domain:
 * both labels sit under the domain being claimed, so publishing either takes control of its zone.
 */
export const LEGACY_SSO_TXT_LABEL = "_seedhost-sso";
export const LEGACY_SSO_TXT_PREFIX = "seedhost-sso=";
/** Every value prefix that may carry the token, current first. */
const TXT_PREFIXES = [SSO_TXT_PREFIX, LEGACY_SSO_TXT_PREFIX] as const;
/** Most domains one workspace may hold (verified or pending). */
export const SSO_MAX_DOMAINS = 50;

export type SsoDomainCheck =
  | { readonly ok: true; readonly domain: string }
  | { readonly ok: false; readonly reason: string };

/**
 * An admin-typed email domain, normalised the way custom domains are (IDNA → punycode,
 * lower-case, trailing dot stripped) and refused when it is a public suffix, a reserved name, an
 * IP literal or a wildcard. A leading `@` is tolerated (people paste `@acme.com`).
 */
export function normalizeSsoDomain(input: string): SsoDomainCheck {
  const raw = input.trim().replace(/^@/u, "");
  const checked = normalizeHostname(raw);
  if (!checked.ok) return { ok: false, reason: checked.reason };
  return { ok: true, domain: checked.hostname };
}

/** A fresh verification token: 32 base64url characters (192 bits). */
export function newDomainToken(): string {
  return randomBytes(24).toString("base64url");
}

export function txtName(domain: string): string {
  return `${SSO_TXT_LABEL}.${domain}`;
}

/** Where a pre-rename admin may have published the proof; looked up only after `txtName`. */
export function legacyTxtName(domain: string): string {
  return `${LEGACY_SSO_TXT_LABEL}.${domain}`;
}

export function txtValue(token: string): string {
  return `${SSO_TXT_PREFIX}${token}`;
}

/** TXT values arrive quoted and possibly chunked; quotes and whitespace are presentation. */
function normalizeTxt(value: string): string {
  return value.replace(/["\\]/gu, "").replace(/\s+/gu, "");
}

function sameSecret(a: string, b: string): boolean {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

/**
 * Whether a TXT answer carries the expected value, and one operator-facing sentence when not.
 * The token comparison is constant-time; what DNS said is quoted back de-fanged and bounded.
 * The value may use either prefix (`fundroom-sso=` or the pre-rename `seedhost-sso=`), and the
 * sentence names `answer.name`, i.e. the label the answer was looked up under.
 */
export function evaluateTxt(
  answer: DnsAnswer,
  token: string,
): { readonly ok: boolean; readonly detail: string } {
  if (answer.rcode !== "ok") {
    const why =
      answer.rcode === "nxdomain"
        ? "does not exist"
        : answer.rcode === "servfail"
          ? "could not be resolved (SERVFAIL)"
          : "could not be resolved (the resolvers disagreed or could not be reached)";
    return { ok: false, detail: `${answer.name} ${why}` };
  }
  const values = answer.values.map(normalizeTxt);
  // Every (value, prefix) pair is compared, without stopping early, so the time taken does not
  // say which prefix (if any) a published value used.
  let matched = false;
  for (const prefix of TXT_PREFIXES) {
    const expected = `${prefix}${token}`;
    for (const v of values) if (sameSecret(v, expected)) matched = true;
  }
  if (matched) {
    return { ok: true, detail: `${answer.name} carries the verification record` };
  }
  const ours = values.filter((v) =>
    TXT_PREFIXES.some((prefix) => v.toLowerCase().startsWith(prefix)),
  );
  if (ours.length > 0) {
    return {
      ok: false,
      detail: `${answer.name} has an SSO verification record, but not this workspace's token`,
    };
  }
  return {
    ok: false,
    detail:
      values.length === 0
        ? `${answer.name} has no TXT record`
        : `${answer.name} has no SSO verification record`,
  };
}

/** The domain part of a (normalised) email address, or undefined. */
export function emailDomain(email: string | undefined): string | undefined {
  if (email === undefined) return undefined;
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return undefined;
  return email.slice(at + 1).toLowerCase();
}
