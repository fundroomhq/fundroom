import type {
  AccreditationVerificationPort,
  AccreditationVerificationState,
} from "@fundroom/ports";

/*
 * The "a person decides" verifier (E2.5 decision D6, design/04 §1.6): the founder's own staff
 * read the investor's evidence — a tax return, a bank letter, a lawyer's or accountant's
 * attestation — and record the decision. It is the only driver FundRoom ships, and for a
 * self-hoster it is usually the only one that exists: verification bureaus cost money per
 * investor and a seed round has twenty of them.
 *
 * Every method answers `pending`, and that is the whole adapter rather than a stub. Rule 506(c)
 * requires the *issuer* to take reasonable steps to verify; an adapter that answered `verified`
 * would be asserting on the issuer's behalf that those steps were taken, which is precisely the
 * claim that is not the software's to make. `requires` says so out loud so the flow above can
 * arrange the two things a human decision needs — somewhere to put the evidence, and an admin
 * queue — instead of polling `check` for ever waiting for an answer that never comes from here.
 */
export interface ManualAccreditationProviderOptions {
  readonly log?: ((event: string, fields?: Readonly<Record<string, unknown>>) => void) | undefined;
}

/** Frozen so a caller cannot hand a mutated copy of "this is pending" to the next caller. */
const PENDING: AccreditationVerificationState = Object.freeze({ status: "pending" as const });

export function createManualAccreditationProvider(
  options: ManualAccreditationProviderOptions = {},
): AccreditationVerificationPort {
  let announced = false;
  /** One line per process, not per investor: an admin queue is a configuration, not an incident. */
  const announce = (event: string, fields: Readonly<Record<string, unknown>>): void => {
    if (announced) return;
    announced = true;
    options.log?.(event, fields);
  };
  return {
    driver: "manual",

    // Both true, and they are the adapter's contract with the round module: an investor whose
    // path is `verification_required` must be offered an upload, and the resulting row waits in
    // a staff queue. A driver that could decide on its own would set both to false.
    requires: { evidenceUpload: true, adminDecision: true },

    async start(input) {
      announce("accreditation.manual", {
        workspaceId: input.workspaceId,
        reason:
          "ACCREDITATION_DRIVER=manual: verifications wait for a staff decision on the uploaded evidence",
      });
      return await Promise.resolve(PENDING);
    },

    // Nothing to poll: the decision is made by a person against the `round.verification` row, not
    // by a remote service that could have moved on since `start`. Answering `pending` rather than
    // throwing keeps a generic "refresh this verification" caller correct against every driver.
    async check() {
      return await Promise.resolve(PENDING);
    },
  };
}
