import type { DnsInstruction } from "@fundroom/ports";

/*
 * The two records a customer publishes (design/07 §2.2 step 2). Derived on every read, never
 * stored (E2.1 decision 4): a stored copy of the instructions goes stale the day the operator
 * moves their edge host, and the stale copy is the one the founder would paste into DNS.
 */

/**
 * TXT label for the ownership proof, and the only one a customer is ever shown. design/07 §2.2
 * named it `_seedhost-challenge` (E2.1 decision 6); the brand rename (ADR-0062, A-2) moved it
 * to `_fundroom-challenge`.
 */
export const CHALLENGE_LABEL = "_fundroom-challenge";

/**
 * The pre-rename label, still accepted by the verifier — **permanently**, not for a release or
 * two. `domains.reverify` re-checks every verified row weekly and demotes it after three
 * misses, so a verifier that stopped reading this label would take every portal set up before
 * the rename offline about three weeks later, on a record its owner did nothing wrong to keep.
 * It is never shown in instructions: it is read only after `CHALLENGE_LABEL` did not carry the
 * token (`judge()` in `service/domains.ts`), and the verdict names whichever label matched.
 */
export const LEGACY_CHALLENGE_LABEL = "_seedhost-challenge";

/**
 * Both records are `required`. The CNAME is what makes traffic arrive; the TXT is what proves
 * the person who published it controls the zone — which is why the CNAME alone is not enough
 * even though it looks like proof. A hostname delegated through a proxy can have its CNAME
 * pointed at us by anyone who runs that proxy, so the app issues no certificate until both
 * resolve.
 *
 * On an apex, `ALIAS`/`ANAME`/CNAME-flattening at the customer's DNS host satisfies the CNAME
 * row (design/07 §2.3(a)); the instruction still reads "CNAME" because that is what the
 * founder types into their provider's form.
 */
export function expectedRecords(input: {
  readonly hostname: string;
  readonly token: string;
  readonly cnameTarget: string;
}): readonly DnsInstruction[] {
  return [
    { type: "CNAME", name: input.hostname, value: input.cnameTarget, required: true },
    {
      type: "TXT",
      name: `${CHALLENGE_LABEL}.${input.hostname}`,
      value: input.token,
      required: true,
    },
  ];
}
