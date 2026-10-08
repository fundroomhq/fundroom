import type { FundRoomSchemas } from "@fundroom/sdk";
import { queryOptions } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { api, call, describeError, isApiError } from "./api.js";

/*
 * Queries and types for the custom-domain kernel routes (E2.1, §9.2). One list endpoint plus
 * three mutations; the mutations all need fresh auth, which is why every screen that calls them
 * either goes through `useGuardedMutation` (admin) or has its own security step (the wizard).
 *
 * `records` is derived server-side on every read and never stored, so there is nothing to cache
 * beyond the list itself: invalidating `["domains"]` after a mutation is the whole cache story.
 */
export type CustomDomain = FundRoomSchemas["CustomDomain"];
export type CustomDomainList = FundRoomSchemas["CustomDomainList"];
export type CustomDomainStatus = CustomDomain["status"];
export type DnsInstruction = FundRoomSchemas["DnsInstruction"];
export type DnsAnswer = FundRoomSchemas["DnsAnswer"];
export type DomainAnswer = FundRoomSchemas["DomainAnswer"];

export const DOMAINS_KEY = ["domains"] as const;

export const domainsQuery = queryOptions({
  queryKey: DOMAINS_KEY,
  queryFn: () => call(api().GET("/domains")),
});

/**
 * Why the server refused a hostname, or which of the three conflicts it hit. The contract
 * spells the rejections out in `CustomDomainRejection` and puts them in `error.reason`; the
 * three conflicts share one status and are told apart the same way. They are not SDK component
 * schemas (they only ever appear inside `error.reason`), so the list is repeated here — a drift
 * shows up as a missing sentence, which the `default` below answers honestly rather than
 * silently.
 */
export const DOMAIN_ERROR_REASONS = [
  "empty",
  "not_a_hostname",
  "ip_literal",
  "wildcard",
  "too_long",
  "public_suffix",
  "reserved",
  "canonical_host",
  "canonical_subdomain",
  "duplicate",
  "workspace_already_verified",
  "claimed_elsewhere",
] as const;
export type DomainErrorReason = (typeof DOMAIN_ERROR_REASONS)[number];

function detailOf(error: unknown, key: string): string | undefined {
  if (!isApiError(error)) return undefined;
  const value = error.body.error[key];
  return typeof value === "string" ? value : undefined;
}

export function domainErrorReason(error: unknown): DomainErrorReason | undefined {
  const reason = detailOf(error, "reason");
  return DOMAIN_ERROR_REASONS.find((r) => r === reason);
}

/**
 * One sentence per reason, which is the entire point of having them: "that is an IP address"
 * and "another workspace verified that already" are different problems with different owners,
 * and a single "conflict" would make the admin guess which one they have.
 */
export function describeDomainError(error: unknown): string {
  switch (domainErrorReason(error)) {
    case "empty":
      return m.domains_error_empty();
    case "not_a_hostname":
      return m.domains_error_not_a_hostname();
    case "ip_literal":
      return m.domains_error_ip_literal();
    case "wildcard":
      return m.domains_error_wildcard();
    case "too_long":
      return m.domains_error_too_long();
    case "public_suffix":
      return m.domains_error_public_suffix();
    case "reserved":
      return m.domains_error_reserved();
    case "canonical_host":
      return m.domains_error_canonical_host();
    case "canonical_subdomain":
      return m.domains_error_canonical_subdomain();
    case "duplicate":
      return m.domains_error_duplicate();
    case "workspace_already_verified": {
      // Their own hostname, so naming it is the actionable answer rather than a tenancy leak.
      const host = detailOf(error, "hostname");
      return host === undefined
        ? m.domains_error_workspace_already_verified()
        : m.domains_error_workspace_already_verified_named({ host });
    }
    case "claimed_elsewhere":
      // Deliberately does not name the other workspace: which workspace holds a hostname is
      // not this admin's business, and the server does not tell us either.
      return m.domains_error_claimed_elsewhere();
    default:
      return describeError(error).body;
  }
}

/** True once the domain is verified, which is when a certificate may exist (decision 3). */
export function isVerified(domain: CustomDomain): boolean {
  return domain.status === "dns_ok" || domain.status === "active";
}
