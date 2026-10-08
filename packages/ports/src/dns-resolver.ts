/**
 * DNS resolution for domain verification (EXECUTION_PLAN §9.2 "custom domains",
 * design/07 §2.2 step 3, E2.1 decision 7). Default adapter `@fundroom/dns-doh` talks the
 * JSON DoH API to IP-literal endpoints (1.1.1.1, 8.8.8.8) so no system resolver — and no
 * local cache, no split-horizon view, no `/etc/hosts` — sits between us and the customer's
 * zone, and requires two endpoints to agree before it reports a positive answer.
 *
 * Used by the custom-domain verify jobs and by the `updates` module's sending-domain
 * checks, which previously read `node:dns` directly.
 */
export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT";

/** One resolver's answer for one question. `values` are joined TXT strings / hostnames /
 *  addresses, lower-cased and trailing-dot-stripped. */
export interface DnsAnswer {
  readonly name: string;
  readonly type: DnsRecordType;
  /** Empty when the name exists but has no record of this type (NODATA). */
  readonly values: readonly string[];
  /** `"nxdomain"` when the name does not exist; `"ok"` otherwise. */
  readonly rcode: "ok" | "nxdomain" | "servfail" | "refused" | "other";
  /** Which resolver answered, for the "last resolver answer" the UI shows. */
  readonly resolver: string;
  /** The CNAME chain walked, if any, outermost first. */
  readonly chain?: readonly string[] | undefined;
}

export interface DnsResolverPort {
  readonly driver: string;
  /** Never throws for a DNS-level problem; a transport failure is `rcode: "other"`. */
  resolve(name: string, type: DnsRecordType): Promise<DnsAnswer>;
  healthCheck(): Promise<void>;
}
