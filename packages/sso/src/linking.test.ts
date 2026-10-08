import { describe, expect, it } from "vitest";
import { decideSsoLogin, type LinkFacts } from "./linking.js";

const staff = { kind: "staff", status: "active" } as const;
const facts = (f: Partial<LinkFacts>): LinkFacts => ({
  identityUserId: undefined,
  email: "alice@acme-corp.com",
  emailDomainVerified: false,
  emailUserId: undefined,
  emailUserMembership: undefined,
  identityUserMembership: undefined,
  jit: { enabled: false, role: "viewer" },
  ...f,
});

describe("SSO identity linking (decision 6)", () => {
  it("a: an existing identity signs its user in without linking", () => {
    expect(decideSsoLogin(facts({ identityUserId: "u1", identityUserMembership: staff }))).toEqual({
      kind: "login",
      userId: "u1",
      link: false,
      rule: "a",
    });
  });

  it("a wins over the email: another user's address does not redirect the login", () => {
    const d = decideSsoLogin(
      facts({
        identityUserId: "u1",
        identityUserMembership: staff,
        emailUserId: "u2",
        emailUserMembership: staff,
        emailDomainVerified: true,
      }),
    );
    expect(d).toMatchObject({ kind: "login", userId: "u1" });
  });

  it("b: a verified-domain email links the existing user", () => {
    expect(
      decideSsoLogin(
        facts({ emailDomainVerified: true, emailUserId: "u2", emailUserMembership: staff }),
      ),
    ).toEqual({ kind: "login", userId: "u2", link: true, rule: "b" });
  });

  it("b: a verified-domain email with no user is JIT only when enabled, at the capped role", () => {
    expect(decideSsoLogin(facts({ emailDomainVerified: true }))).toEqual({
      kind: "refuse",
      code: "not_provisioned",
      rule: "b",
    });
    expect(
      decideSsoLogin(facts({ emailDomainVerified: true, jit: { enabled: true, role: "editor" } })),
    ).toEqual({
      kind: "jit",
      email: "alice@acme-corp.com",
      userId: undefined,
      role: "editor",
      link: true,
    });
  });

  it("b: an existing user without a membership here is JIT-provisioned (adopted by email)", () => {
    expect(
      decideSsoLogin(
        facts({
          emailDomainVerified: true,
          emailUserId: "u2",
          jit: { enabled: true, role: "viewer" },
        }),
      ),
    ).toMatchObject({ kind: "jit", userId: "u2", link: true });
  });

  it("c: an unverified domain links only a user this workspace already has", () => {
    expect(decideSsoLogin(facts({ emailUserId: "u2", emailUserMembership: staff }))).toEqual({
      kind: "login",
      userId: "u2",
      link: true,
      rule: "c",
    });
    // An invited staff member counts (completeLogin activates the invitation).
    expect(
      decideSsoLogin(
        facts({ emailUserId: "u2", emailUserMembership: { kind: "staff", status: "invited" } }),
      ),
    ).toMatchObject({ kind: "login", rule: "c" });
  });

  it("d: anything else is unknown — even with JIT on, and even when a global user exists", () => {
    expect(decideSsoLogin(facts({ jit: { enabled: true, role: "viewer" } }))).toEqual({
      kind: "refuse",
      code: "unknown_user",
      rule: "d",
    });
    expect(decideSsoLogin(facts({ emailUserId: "u9" }))).toMatchObject({ code: "unknown_user" });
    expect(
      decideSsoLogin(
        facts({ emailUserId: "u9", emailUserMembership: { kind: "staff", status: "revoked" } }),
      ),
    ).toMatchObject({ code: "unknown_user" });
    expect(decideSsoLogin(facts({ email: undefined }))).toMatchObject({ code: "unknown_user" });
  });

  it("refuses suspended and external members whatever the rule", () => {
    for (const f of [
      facts({
        identityUserId: "u1",
        identityUserMembership: { kind: "staff", status: "suspended" },
      }),
      facts({
        emailDomainVerified: true,
        emailUserId: "u2",
        emailUserMembership: { kind: "staff", status: "suspended" },
        jit: { enabled: true, role: "viewer" },
      }),
    ]) {
      expect(decideSsoLogin(f)).toMatchObject({ kind: "refuse", code: "suspended" });
    }
    for (const f of [
      facts({
        identityUserId: "u1",
        identityUserMembership: { kind: "external", status: "active" },
      }),
      facts({
        emailUserId: "u2",
        emailUserMembership: { kind: "external", status: "active" },
      }),
      facts({
        emailDomainVerified: true,
        emailUserId: "u2",
        emailUserMembership: { kind: "external", status: "invited" },
        jit: { enabled: true, role: "viewer" },
      }),
    ]) {
      expect(decideSsoLogin(f)).toMatchObject({ kind: "refuse", code: "staff_only" });
    }
  });

  it("never JIT-provisions an identity user under someone else's (or nobody's) email", () => {
    const jit = { enabled: true, role: "viewer" } as const;
    expect(
      decideSsoLogin(
        facts({ identityUserId: "u1", emailDomainVerified: true, emailUserId: "u2", jit }),
      ),
    ).toMatchObject({ kind: "refuse", code: "not_provisioned" });
    expect(
      decideSsoLogin(facts({ identityUserId: "u1", emailDomainVerified: true, jit })),
    ).toMatchObject({ kind: "refuse", code: "not_provisioned" });
    expect(
      decideSsoLogin(
        facts({ identityUserId: "u1", emailDomainVerified: true, emailUserId: "u1", jit }),
      ),
    ).toEqual({
      kind: "jit",
      email: "alice@acme-corp.com",
      userId: "u1",
      role: "viewer",
      link: false,
    });
  });
});
