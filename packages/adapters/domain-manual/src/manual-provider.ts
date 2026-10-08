import { CHALLENGE_LABEL } from "@fundroom/custom-domains";
import type { CustomDomainProviderPort, DnsInstruction } from "@fundroom/ports";

/*
 * The "we only verify" provider (design/07 §2.1: `manual` — "self-hoster terminates TLS
 * themselves, we only verify"). For an operator who already runs nginx, Traefik,
 * cert-manager or a CDN in front of the app and issues certificates there. FundRoom still
 * needs proof that the workspace controls the hostname before it will resolve a `Host`
 * header to that workspace, so the TXT challenge stays — it is what stops one workspace from
 * claiming another customer's domain — but there is no on-demand TLS to hand off to, so
 * `activate`/`deactivate` have nothing to do either.
 */

/** Shown next to the records in the admin UI, because the shape of `DnsInstruction` cannot
 *  carry it: with this driver FundRoom never obtains a certificate. */
export const MANUAL_TLS_NOTICE =
  "This install verifies domain ownership only: point the hostname at your own reverse " +
  "proxy and issue the TLS certificate there. FundRoom will not request one. " +
  "Verification checks the TXT record and nothing else — where the hostname routes is yours " +
  "to decide, so any CNAME shown below is guidance, not a requirement.";

export interface ManualProviderOptions {
  /**
   * Where the operator's edge lives, if they want the UI to suggest it. Omitted by default:
   * with `manual` the DNS usually already points at the operator's own proxy, and inventing
   * a CNAME row would tell the founder to break a working setup.
   */
  readonly cnameTarget?: string | undefined;
}

export function createManualProvider(
  options: ManualProviderOptions = {},
): CustomDomainProviderPort {
  return {
    driver: "manual",

    // TXT only, and this is the whole point of the driver. `manual` means the operator
    // terminates TLS on their own edge, so there is no hostname of ours to CNAME at: with
    // `cname: true` a founder would publish exactly the TXT record the screen asked for and
    // then fail verification on a CNAME nobody mentioned — or, with no target configured at
    // all, never verify at any point in the future. What FundRoom needs before it will route
    // a `Host` header to a workspace is proof of *control of the name*, which is exactly what
    // the challenge is. Routing is the operator's business.
    requires: { cname: false, txt: true },

    async activate() {
      return await Promise.resolve();
    },

    async deactivate() {
      return await Promise.resolve();
    },

    instructions(input): readonly DnsInstruction[] {
      const txt: DnsInstruction = {
        type: "TXT",
        name: `${CHALLENGE_LABEL}.${input.hostname}`,
        value: input.token,
        required: true,
      };
      const target = options.cnameTarget?.trim() ?? "";
      if (target === "") return [txt];
      // Genuinely advisory, and now truthfully so: `requires.cname` is false, so the verdict
      // never looks at this record. It is a hint about where to route, and the operator's proxy
      // may just as well be reached by an A record, an internal name or a load balancer we know
      // nothing about. MANUAL_TLS_NOTICE says as much next to the table.
      return [
        txt,
        {
          type: "CNAME",
          name: input.hostname,
          value: target,
          required: false,
        },
      ];
    },
  };
}
