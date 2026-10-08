/**
 * Custom portal domains (EXECUTION_PLAN §9.2, design/07 §2.1 "proxy choice", ADR-0039).
 * The provider is the thing that makes a verified hostname serve HTTPS. Default adapter
 * `@fundroom/domain-caddy-ask`, where `activate`/`deactivate` are deliberately no-ops
 * because Caddy's on-demand `ask` endpoint is the whole mechanism; alternatives register
 * the hostname with an edge (`@fundroom/domain-manual` leaves that to the operator).
 *
 * Verification itself is not the provider's job — it is `DnsResolverPort` plus the pure
 * `@fundroom/custom-domains` state machine — so a provider needs no DNS credentials.
 */
import type { SubProcessorMeta } from "./residency.js";

/**
 * Which DNS checks this provider needs to pass before a hostname counts as verified.
 *
 * It is declared rather than implied because the two are not the same question. The TXT
 * challenge proves **control of the name**; the CNAME proves **traffic arrives at our edge**.
 * A provider that terminates TLS itself (`manual`) has no edge of ours to point at, so
 * requiring a CNAME there would show the operator a TXT record, accept it, and then fail the
 * domain on a record nobody asked for — and with no CNAME target configured at all it could
 * never verify. `caddy-ask` needs both, because it issues a certificate and must know the
 * handshake will actually reach it.
 *
 * `txt` is effectively always `true`: it is the only proof of control there is, and
 * `createCustomDomainService` refuses a provider that sets it `false` rather than let an
 * install verify a hostname on no evidence. It is a field anyway so the shape stays one
 * exhaustive record per check — adding a third check is then a compile error in every
 * provider, which is the property the `ok = cnameOk && txtOk` bug lacked.
 */
export interface CustomDomainRequirements {
  /** The hostname must resolve to (or chain through) the configured CNAME target. */
  readonly cname: boolean;
  /** The `_fundroom-challenge` TXT record (or the pre-rename `_seedhost-challenge`, still
   *  accepted) must carry the challenge token. */
  readonly txt: boolean;
}

export interface CustomDomainProviderPort {
  readonly driver: string;
  /**
   * E3.11: the third party this adapter sends tenant data to, for the residency page and the
   * DPA's sub-processor list. `null` = none (the operator's own infrastructure); absent = the
   * adapter does not say (test doubles).
   */
  readonly subProcessor?: SubProcessorMeta | null | undefined;
  /**
   * What verification must establish for this provider. Passed straight to
   * `evaluate()` in `@fundroom/custom-domains`, so `instructions()`'s `required` flags and
   * the verdict cannot drift apart: a record this says nothing about must be `required: false`,
   * and one it names must be `required: true`.
   */
  readonly requires: CustomDomainRequirements;
  /** Called when a domain reaches `dns_ok`. `caddy-ask` is a no-op: the `ask` endpoint *is*
   *  the mechanism. `cloudflare-saas` (E3.10) registers the custom hostname with Cloudflare and
   *  may return the extra DCV / ownership records Cloudflare asks for, and `ref` — its own id for
   *  the hostname, which the caller stores and hands back to `status` / `deactivate`. */
  activate(
    hostname: string,
    context?: ProviderCallContext,
    // biome-ignore lint/suspicious/noConfusingVoidType: providers without extra records return nothing
  ): Promise<void | {
    readonly records?: readonly DnsInstruction[];
    readonly ref?: string | undefined;
  }>;
  /**
   * E3.10: the provider's own view of the hostname, for a provider that issues certificates
   * itself (`cloudflare-saas`). When present, the verify job moves `dns_ok → active` only once
   * this says `active`; `records` are shown to the admin next to our own instructions. Absent
   * (`caddy-ask`, `manual`): DNS verification alone decides, as before.
   *
   * `ref` is what `activate` (or an earlier `status`) returned, when the caller has one. A provider
   * that cannot find the hostname by a search must THROW (the answer is "unknown", not `failed`):
   * a listing that has not caught up with a create is not the provider saying no.
   */
  status?(
    hostname: string,
    ref?: string,
    context?: ProviderCallContext,
  ): Promise<CustomDomainProviderStatus>;
  /**
   * Called when a domain is removed or demoted; `ref` as for `status`. Throwing means "try again
   * later" — the caller retries until this resolves (already gone counts as done).
   */
  deactivate(hostname: string, ref?: string, context?: ProviderCallContext): Promise<void>;
  /**
   * E3.10 FR3: charges a provider with a call budget for ONE call up front, so that call can then
   * be made (`context.admitted`) while the caller holds a database transaction the budget's own
   * store must not wait behind. Throws when over budget. Absent: nothing to charge.
   */
  admit?(context: ProviderCallContext): Promise<void>;
  /** What the admin UI must tell the operator to create. */
  instructions(input: { hostname: string; token: string }): readonly DnsInstruction[];
}

/**
 * Who a provider call is for (E3.10 FR3), so a provider with a call budget (`cloudflare-saas`) can
 * keep one workspace from spending the install's share and keep admin clicks from starving the
 * background sweep. Providers without a budget ignore it.
 */
export interface ProviderCallContext {
  readonly workspaceId?: string | undefined;
  /** `background` = the verify sweep and the release job; `interactive` = an admin's request. */
  readonly priority?: "background" | "interactive" | undefined;
  /** The single call this context is used for was already charged by `admit`. */
  readonly admitted?: boolean | undefined;
}

/** `CustomDomainProviderPort.status` (E3.10). */
export interface CustomDomainProviderStatus {
  readonly state: "pending" | "active" | "failed";
  /** A short, operator-facing reason (never a credential). */
  readonly detail: string | null;
  readonly records: readonly DnsInstruction[];
  /** The provider's id for the hostname, when the answer came with one (to store for next time). */
  readonly ref?: string | undefined;
}

export interface DnsInstruction {
  readonly type: "CNAME" | "TXT" | "A";
  readonly name: string;
  readonly value: string;
  /**
   * True when verification actually gates on this record. It is not a presentation hint: a
   * `required: false` row is advisory guidance the verdict ignores (the `manual` driver's
   * routing CNAME), and a row verification checks must never be spelled `false`.
   */
  readonly required: boolean;
}
