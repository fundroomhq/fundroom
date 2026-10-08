import { expectedRecords } from "@fundroom/custom-domains";
import type { CustomDomainProviderPort, DnsInstruction } from "@fundroom/ports";

/*
 * Caddy on-demand TLS (design/07 §2.1, EXECUTION_PLAN §9.2). The default provider for every
 * install, and the reason custom domains need no per-domain configuration anywhere: Caddy
 * asks us about a hostname during the TLS handshake (`on_demand_tls { ask … }`), we answer
 * 200 for `dns_ok|active`, and ACME issues the certificate on the spot.
 */

export interface CaddyAskProviderOptions {
  /**
   * Hostname customers CNAME to. On a self-hosted install this is the canonical host itself;
   * on a managed host it is the dedicated edge name (design/07 §2.2's
   * `<slug>.customers.fundroom.app`).
   */
  readonly cnameTarget: string;
}

export function createCaddyAskProvider(options: CaddyAskProviderOptions): CustomDomainProviderPort {
  // Refused at construction rather than tolerated: with this driver `evaluate` gates on the
  // CNAME, and an empty target makes `cnameOk` permanently false — every domain on the install
  // would collect DNS instructions telling the founder to "CNAME to " and then fail at 72 h
  // with nothing wrong in their zone. A startup error naming the variable is the only honest
  // failure mode. (The container defaults the target to the canonical host, so reaching this
  // means the operator set the variable to something blank.)
  const cnameTarget = options.cnameTarget.trim();
  if (cnameTarget === "") {
    throw new Error(
      "caddy-ask needs a CNAME target: set CUSTOM_DOMAIN_CNAME_TARGET to the hostname customers " +
        "should CNAME at (or leave it unset to use this install's canonical host). Use the " +
        "`manual` driver if this install verifies ownership only.",
    );
  }

  return {
    driver: "caddy-ask",

    // Both checks: this provider issues the certificate, so it has to know the handshake will
    // reach us (CNAME) *and* that whoever published the record controls the name (TXT). A CNAME
    // alone is not proof — anyone running a proxy a hostname is delegated to can point it here.
    requires: { cname: true, txt: true },

    // activate/deactivate are deliberate no-ops: the `ask` endpoint IS the mechanism. There
    // is nothing to register, because the row's status is what `ask` reads — and nothing to
    // tear down, because a removed row makes the next handshake fail on its own. A provider
    // that had to push a hostname to an edge (Cloudflare for SaaS, a Traefik HTTP provider)
    // is exactly what these two hooks exist for.
    async activate() {
      return await Promise.resolve();
    },

    async deactivate() {
      return await Promise.resolve();
    },

    instructions(input): readonly DnsInstruction[] {
      return expectedRecords({ ...input, cnameTarget });
    },
  };
}
