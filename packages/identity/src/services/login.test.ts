import type { Invite, Membership } from "@fundroom/db";
import { describe, expect, it } from "vitest";
import { decideEligibility, type EligibilityFacts, loginAccessEnded } from "./login.js";

/*
 * Who may be sent a sign-in code (design/05 §4.4 "invite-only"), and — since E2.3 — who may be
 * admitted by a share link. `checkEligibility` fetches; this decides, and this is the rule that
 * stands between a workspace's OTP endpoint and an open mailer.
 */
const USER = "01920000-0000-7000-8000-000000000001";

function membership(status: Membership["status"]): Membership {
  return { id: "01920000-0000-7000-8000-0000000000a1", status } as Membership;
}

const INVITE = { id: "01920000-0000-7000-8000-0000000000c1" } as Invite;

function facts(over: Partial<EligibilityFacts> = {}): EligibilityFacts {
  return {
    userId: USER,
    membership: undefined,
    invite: undefined,
    linkAdmits: undefined,
    ...over,
  };
}

describe("decideEligibility", () => {
  it("admits an existing member", () => {
    const out = decideEligibility(facts({ membership: membership("active") }));
    expect(out.eligible).toBe(true);
    expect(out.membership?.status).toBe("active");
  });

  it("admits an invited member who has not signed in yet, and a dormant one", () => {
    expect(decideEligibility(facts({ membership: membership("invited") })).eligible).toBe(true);
    expect(decideEligibility(facts({ membership: membership("dormant") })).eligible).toBe(true);
  });

  it("refuses a revoked or suspended member even though a row exists", () => {
    expect(decideEligibility(facts({ membership: membership("revoked") })).eligible).toBe(false);
    expect(decideEligibility(facts({ membership: membership("suspended") })).eligible).toBe(false);
  });

  it("admits a pending invitation and hands it back so the flow can accept it", () => {
    const out = decideEligibility(facts({ invite: INVITE }));
    expect(out.eligible).toBe(true);
    expect(out.invite).toBe(INVITE);
  });

  it("refuses an address with no membership and no invitation", () => {
    expect(decideEligibility(facts()).eligible).toBe(false);
  });

  it("admits an address a share link's own policy names (E2.3)", () => {
    const out = decideEligibility(facts({ linkAdmits: true }));
    expect(out.eligible).toBe(true);
    // No membership and no invite: the link is the whole eligibility, and the caller creates the
    // membership from it.
    expect(out.membership).toBeUndefined();
    expect(out.invite).toBeUndefined();
  });

  it("refuses an address the named link does not admit", () => {
    expect(decideEligibility(facts({ linkAdmits: false })).eligible).toBe(false);
  });

  it("does NOT widen eligibility when no link was named: `undefined` is not `false`", () => {
    // The load-bearing case. `linkAdmits: undefined` means nobody asked about a link — an ordinary
    // `/auth/otp/start`. If that were treated as anything other than "no third source", every
    // workspace's OTP endpoint would mail a code to any address a stranger typed.
    expect(decideEligibility(facts({ linkAdmits: undefined })).eligible).toBe(false);
  });

  it("lets a membership win over a link, so a link never downgrades who somebody already is", () => {
    const out = decideEligibility(facts({ membership: membership("active"), linkAdmits: true }));
    expect(out.membership?.status).toBe("active");
  });

  it("lets an invitation win over a link, so the invited role and grants are the ones applied", () => {
    const out = decideEligibility(facts({ invite: INVITE, linkAdmits: true }));
    expect(out.invite).toBe(INVITE);
  });

  it("carries the user id through every branch, including the refusals", () => {
    for (const f of [
      facts(),
      facts({ linkAdmits: true }),
      facts({ invite: INVITE }),
      facts({ membership: membership("active") }),
    ]) {
      expect(decideEligibility(f).userId).toBe(USER);
    }
  });
});

describe("loginAccessEnded (E3.2: refuse a sign-in whose membership has expired)", () => {
  const NOW = new Date("2026-09-25T12:00:00Z");
  const past = { expiresAt: new Date("2026-09-25T11:59:59Z") };
  const exactlyNow = { expiresAt: NOW };
  const future = { expiresAt: new Date("2026-09-26T00:00:00Z") };
  const open = { expiresAt: null };

  it("refuses a named workspace whose membership is past (or at) its expiry", () => {
    expect(loginAccessEnded({ scope: "workspace", membership: past }, NOW)).toBe(true);
    expect(loginAccessEnded({ scope: "workspace", membership: exactlyNow }, NOW)).toBe(true);
  });

  it("admits a live, open-ended or absent workspace membership (an invite or link decides then)", () => {
    expect(loginAccessEnded({ scope: "workspace", membership: future }, NOW)).toBe(false);
    expect(loginAccessEnded({ scope: "workspace", membership: open }, NOW)).toBe(false);
    expect(loginAccessEnded({ scope: "workspace", membership: undefined }, NOW)).toBe(false);
  });

  it("refuses the canonical host only when every membership has expired", () => {
    expect(loginAccessEnded({ scope: "host", memberships: [past] }, NOW)).toBe(true);
    expect(loginAccessEnded({ scope: "host", memberships: [past, exactlyNow] }, NOW)).toBe(true);
    expect(loginAccessEnded({ scope: "host", memberships: [past, future] }, NOW)).toBe(false);
    expect(loginAccessEnded({ scope: "host", memberships: [past, open] }, NOW)).toBe(false);
  });

  it("admits a host login with no memberships at all, exactly as before", () => {
    expect(loginAccessEnded({ scope: "host", memberships: [] }, NOW)).toBe(false);
  });
});
