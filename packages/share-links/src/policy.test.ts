import { describe, expect, it } from "vitest";
import {
  admits,
  domainOf,
  emailRefusal,
  isLive,
  isOpen,
  type LinkPolicy,
  linkPolicyPermitted,
  normalizeAddress,
  normalizeDomain,
  normalizeLinkPolicy,
  OPEN_LINK_POLICY,
  PASSCODE_LOCK_MS,
  PASSCODE_MAX_ATTEMPTS,
  passcodeLockUntil,
  passcodeVerdict,
  policyNamesAnAudience,
  type ResolvedLink,
} from "./policy.js";

const NOW = new Date("2026-09-14T12:00:00Z");
const LINK_ID = "01930000-0000-7000-8000-00000000000a";
const WS_ID = "01930000-0000-7000-8000-00000000000b";

function policy(over: Partial<LinkPolicy> = {}): LinkPolicy {
  return { domains: [], emails: [], forceWatermark: false, ...over };
}

function link(over: Partial<ResolvedLink> = {}): ResolvedLink {
  return {
    id: LINK_ID,
    workspaceId: WS_ID,
    status: "active",
    policy: policy(),
    passcodeRequired: false,
    passcodeAttempts: 0,
    passcodeLockedUntil: null,
    maxUses: null,
    uses: 0,
    maxViews: null,
    views: 0,
    expiresAt: null,
    revokedAt: null,
    ...over,
  };
}

describe("normalizeDomain", () => {
  it("strips the leading @ an admin will paste, so `@acme.com` and `acme.com` are one entry", () => {
    expect(normalizeDomain("@acme.com")).toBe("acme.com");
  });

  it("lower-cases and trims, so the stored form is the form compared against", () => {
    expect(normalizeDomain("  ACME.Com  ")).toBe("acme.com");
  });

  it("strips one trailing dot: a FQDN spelling is legitimate, and must not be a second entry", () => {
    expect(normalizeDomain("acme.com.")).toBe("acme.com");
  });

  it("refuses an empty label, because `acme..com` would otherwise have two spellings", () => {
    expect(normalizeDomain("acme..com")).toBeUndefined();
    expect(normalizeDomain(".acme.com")).toBeUndefined();
    expect(normalizeDomain("acme.com..")).toBeUndefined();
  });

  it("refuses a single-label name: `localhost` and `com` are not email domains anyone can hold", () => {
    expect(normalizeDomain("localhost")).toBeUndefined();
    expect(normalizeDomain("com")).toBeUndefined();
  });

  it("refuses characters that cannot be in a hostname, so no wildcard sneaks into the list", () => {
    expect(normalizeDomain("*.acme.com")).toBeUndefined();
    expect(normalizeDomain("acme com")).toBeUndefined();
    expect(normalizeDomain("acme_corp.com")).toBeUndefined();
  });

  it("refuses over 253 characters (RFC 1035 §2.3.4)", () => {
    expect(normalizeDomain(`${"a".repeat(250)}.com`)).toBeUndefined();
  });
});

describe("domainOf", () => {
  it("returns the normalised domain half", () => {
    expect(domainOf("Jane@ACME.com")).toBe("acme.com");
  });

  it("has no domain for an address with nothing either side of the @", () => {
    expect(domainOf("@acme.com")).toBeUndefined();
    expect(domainOf("jane@")).toBeUndefined();
    expect(domainOf("jane")).toBeUndefined();
  });
});

describe("normalizeLinkPolicy", () => {
  it("reads an absent or non-object policy as unrestricted rather than throwing", () => {
    expect(normalizeLinkPolicy(undefined)).toEqual(OPEN_LINK_POLICY);
    expect(normalizeLinkPolicy(null)).toEqual(OPEN_LINK_POLICY);
    expect(normalizeLinkPolicy("nonsense")).toEqual(OPEN_LINK_POLICY);
  });

  it("drops entries it cannot use instead of taking the whole link offline", () => {
    const p = normalizeLinkPolicy({
      domains: ["acme.com", "*.evil", 7, ""],
      emails: ["not-an-email"],
    });
    expect(p.domains).toEqual(["acme.com"]);
    expect(p.emails).toEqual([]);
  });

  it("de-duplicates after normalising, so `@ACME.com` and `acme.com.` are one entry", () => {
    expect(
      normalizeLinkPolicy({ domains: ["@ACME.com", "acme.com.", "acme.com"] }).domains,
    ).toEqual(["acme.com"]);
  });

  it("treats forceWatermark as a strict boolean: a truthy string must not turn it on by accident", () => {
    expect(normalizeLinkPolicy({ forceWatermark: true }).forceWatermark).toBe(true);
    expect(normalizeLinkPolicy({ forceWatermark: "yes" }).forceWatermark).toBe(false);
    expect(normalizeLinkPolicy({}).forceWatermark).toBe(false);
  });
});

describe("normalizeAddress", () => {
  it("trims and lower-cases, because the policy list is stored lower-cased", () => {
    expect(normalizeAddress("  Jane@Acme.COM ")).toBe("jane@acme.com");
  });
});

describe("policyNamesAnAudience", () => {
  it("is false only when neither a domain nor a named email is set", () => {
    expect(policyNamesAnAudience(policy())).toBe(false);
    expect(policyNamesAnAudience(policy({ domains: ["acme.com"] }))).toBe(true);
    expect(policyNamesAnAudience(policy({ emails: ["jane@acme.com"] }))).toBe(true);
  });
});

describe("isOpen", () => {
  it("is exactly `PrincipalRepo.listActive()`'s predicate, so revoking really removes access", () => {
    expect(isOpen(link(), NOW)).toBe(true);
    expect(isOpen(link({ status: "paused" }), NOW)).toBe(false);
    expect(isOpen(link({ status: "revoked" }), NOW)).toBe(false);
    expect(isOpen(link({ revokedAt: NOW }), NOW)).toBe(false);
    expect(isOpen(link({ expiresAt: NOW }), NOW)).toBe(false);
  });

  it("ignores the use and view caps, because a cap limits arrivals and not tenancy (A6)", () => {
    expect(isOpen(link({ maxUses: 1, uses: 1 }), NOW)).toBe(true);
    expect(isOpen(link({ maxViews: 1, views: 1 }), NOW)).toBe(true);
    expect(isLive(link({ maxUses: 1, uses: 1 }), NOW)).toBe(false);
  });
});

describe("emailRefusal", () => {
  it("asks only about the address, so a spent link can still recognise its own people", () => {
    expect(emailRefusal(policy({ domains: ["acme.com"] }), "jane@acme.com")).toBeUndefined();
    expect(emailRefusal(policy({ domains: ["acme.com"] }), "mallory@evil.test")).toBe(
      "email_not_allowed",
    );
  });
});

describe("isLive", () => {
  it("is true for an active, unexpired, uncapped link", () => {
    expect(isLive(link(), NOW)).toBe(true);
  });

  it("is false while paused: a pause must stop admitting, not merely hide the row", () => {
    expect(isLive(link({ status: "paused" }), NOW)).toBe(false);
  });

  it("is false once revoked, by status and by timestamp independently", () => {
    expect(isLive(link({ status: "revoked" }), NOW)).toBe(false);
    expect(isLive(link({ revokedAt: NOW }), NOW)).toBe(false);
  });

  it("expires at the instant named, not a millisecond later", () => {
    expect(isLive(link({ expiresAt: new Date(NOW.getTime() + 1) }), NOW)).toBe(true);
    expect(isLive(link({ expiresAt: NOW }), NOW)).toBe(false);
    expect(isLive(link({ expiresAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(false);
  });

  it("is spent when uses have reached max_uses, because `uses` counts those already admitted", () => {
    expect(isLive(link({ maxUses: 2, uses: 1 }), NOW)).toBe(true);
    expect(isLive(link({ maxUses: 2, uses: 2 }), NOW)).toBe(false);
    expect(isLive(link({ maxUses: 2, uses: 3 }), NOW)).toBe(false);
  });

  it("is spent when views have reached max_views", () => {
    expect(isLive(link({ maxViews: 1, views: 0 }), NOW)).toBe(true);
    expect(isLive(link({ maxViews: 1, views: 1 }), NOW)).toBe(false);
  });

  it("ignores a null cap: null means unlimited, not zero", () => {
    expect(isLive(link({ maxUses: null, uses: 9000 }), NOW)).toBe(true);
  });
});

describe("admits", () => {
  it("admits any address when neither a domain nor an email is named", () => {
    expect(admits(link(), "anyone@wherever.test", NOW)).toBeUndefined();
  });

  it("collapses every liveness refusal into not_found, so none can be told from the others", () => {
    const cases: readonly Partial<ResolvedLink>[] = [
      { status: "paused" },
      { status: "revoked" },
      { revokedAt: NOW },
      { expiresAt: NOW },
      { maxUses: 1, uses: 1 },
      { maxViews: 1, views: 1 },
    ];
    for (const over of cases) {
      expect(admits(link(over), "jane@acme.com", NOW)).toBe("not_found");
    }
  });

  it("prefers not_found over email_not_allowed: a dead link must not confirm its own policy", () => {
    const dead = link({ status: "revoked", policy: policy({ domains: ["acme.com"] }) });
    expect(admits(dead, "mallory@evil.test", NOW)).toBe("not_found");
  });

  it("admits an address whose domain is on the list, whatever its case or padding", () => {
    const l = link({ policy: policy({ domains: ["acme.com"] }) });
    expect(admits(l, "jane@acme.com", NOW)).toBeUndefined();
    expect(admits(l, "  Jane@ACME.Com ", NOW)).toBeUndefined();
  });

  it("refuses a lookalike domain: `evil-acme.com` is not a suffix of anything we allowed", () => {
    const l = link({ policy: policy({ domains: ["acme.com"] }) });
    expect(admits(l, "mallory@evil-acme.com", NOW)).toBe("email_not_allowed");
  });

  it("refuses a domain the allowed one is a prefix of: `acme.com.evil.net` is a different zone", () => {
    const l = link({ policy: policy({ domains: ["acme.com"] }) });
    expect(admits(l, "mallory@acme.com.evil.net", NOW)).toBe("email_not_allowed");
  });

  it("refuses a subdomain of an allowed domain, deliberately: `acme.com` is not `*.acme.com`", () => {
    const l = link({ policy: policy({ domains: ["acme.com"] }) });
    expect(admits(l, "jane@mail.acme.com", NOW)).toBe("email_not_allowed");
  });

  it("refuses the parent of an allowed subdomain, so `mail.acme.com` does not widen to acme.com", () => {
    const l = link({ policy: policy({ domains: ["mail.acme.com"] }) });
    expect(admits(l, "jane@acme.com", NOW)).toBe("email_not_allowed");
  });

  it("admits a named email even when its domain is not on the domain list", () => {
    const l = link({ policy: policy({ domains: ["acme.com"], emails: ["bob@gmail.test"] }) });
    expect(admits(l, "bob@gmail.test", NOW)).toBeUndefined();
    expect(admits(l, "carol@gmail.test", NOW)).toBe("email_not_allowed");
  });

  it("admits a domain match even when a named-email list is also set (the two are a union)", () => {
    const l = link({ policy: policy({ domains: ["acme.com"], emails: ["bob@gmail.test"] }) });
    expect(admits(l, "jane@acme.com", NOW)).toBeUndefined();
  });

  it("refuses an address that is not an address at all, rather than reading it as unrestricted", () => {
    const l = link();
    expect(admits(l, "not-an-email", NOW)).toBe("email_not_allowed");
    expect(admits(l, "@acme.com", NOW)).toBe("email_not_allowed");
    expect(admits(l, "", NOW)).toBe("email_not_allowed");
  });

  it("never asks for the passcode: that is proof held by the browser, not a property of the email", () => {
    const l = link({ passcodeRequired: true, policy: policy({ domains: ["acme.com"] }) });
    expect(admits(l, "jane@acme.com", NOW)).toBeUndefined();
  });
});

describe("passcodeVerdict", () => {
  const base = { required: true, supplied: "hunter2", matches: false, attempts: 1 } as const;

  it("is satisfied when the link carries no passcode", () => {
    expect(
      passcodeVerdict({ ...base, required: false, supplied: undefined, lockedUntil: null }, NOW),
    ).toBeUndefined();
  });

  it("asks for the passcode when nothing was typed, without calling that a wrong guess", () => {
    expect(passcodeVerdict({ ...base, supplied: undefined, lockedUntil: null }, NOW)).toBe(
      "passcode_required",
    );
    expect(passcodeVerdict({ ...base, supplied: "", lockedUntil: null }, NOW)).toBe(
      "passcode_required",
    );
  });

  it("answers locked before it looks at the guess, so a correct guess cannot clear a lockout", () => {
    const locked = new Date(NOW.getTime() + 1);
    expect(passcodeVerdict({ ...base, matches: true, lockedUntil: locked }, NOW)).toBe(
      "passcode_locked",
    );
  });

  it("releases the lock at the instant it expires, not a millisecond later", () => {
    expect(passcodeVerdict({ ...base, matches: true, lockedUntil: NOW }, NOW)).toBeUndefined();
    expect(
      passcodeVerdict({ ...base, matches: true, lockedUntil: new Date(NOW.getTime() + 1) }, NOW),
    ).toBe("passcode_locked");
  });

  it("accepts a match", () => {
    expect(passcodeVerdict({ ...base, matches: true, lockedUntil: null }, NOW)).toBeUndefined();
  });

  it("is a plain wrong answer while attempts remain", () => {
    expect(
      passcodeVerdict({ ...base, attempts: PASSCODE_MAX_ATTEMPTS - 1, lockedUntil: null }, NOW),
    ).toBe("passcode_wrong");
  });

  it("locks on the attempt that spends the last one, so the cap is a cap and not a suggestion", () => {
    expect(
      passcodeVerdict({ ...base, attempts: PASSCODE_MAX_ATTEMPTS, lockedUntil: null }, NOW),
    ).toBe("passcode_locked");
  });
});

describe("passcodeLockUntil", () => {
  it("locks for PASSCODE_LOCK_MS from the attempt that earned it", () => {
    expect(passcodeLockUntil(NOW).getTime()).toBe(NOW.getTime() + PASSCODE_LOCK_MS);
  });
});

describe("linkPolicyPermitted", () => {
  const open = policy();
  const byDomain = policy({ domains: ["acme.com"] });
  const byEmail = policy({ emails: ["jane@acme.com"] });

  it("refuses every link under `none`: the portal is a private room, not an offering", () => {
    for (const p of [open, byDomain, byEmail]) {
      expect(linkPolicyPermitted("none", p)).toEqual({
        code: "links_not_permitted",
        status: "none",
      });
    }
  });

  it("refuses every link under `informational`, whatever its audience", () => {
    for (const p of [open, byDomain, byEmail]) {
      expect(linkPolicyPermitted("informational", p)).toEqual({
        code: "links_not_permitted",
        status: "informational",
      });
    }
  });

  it("refuses an unrestricted link under 506(b): an any-email link is general solicitation", () => {
    expect(linkPolicyPermitted("506b", open)).toEqual({
      code: "audience_too_open",
      status: "506b",
    });
  });

  it("permits a 506(b) link that names a domain allowlist", () => {
    expect(linkPolicyPermitted("506b", byDomain)).toBeUndefined();
  });

  it("permits a 506(b) link that names individual contacts", () => {
    expect(linkPolicyPermitted("506b", byEmail)).toBeUndefined();
  });

  it("does not let forceWatermark stand in for an audience under 506(b)", () => {
    expect(linkPolicyPermitted("506b", policy({ forceWatermark: true }))).toEqual({
      code: "audience_too_open",
      status: "506b",
    });
  });

  it("permits any shape under 506(c), where public solicitation is the point", () => {
    for (const p of [open, byDomain, byEmail]) {
      expect(linkPolicyPermitted("506c", p)).toBeUndefined();
    }
  });

  it("permits any shape under non_us, where the US exemptions do not apply", () => {
    for (const p of [open, byDomain, byEmail]) {
      expect(linkPolicyPermitted("non_us", p)).toBeUndefined();
    }
  });
});
