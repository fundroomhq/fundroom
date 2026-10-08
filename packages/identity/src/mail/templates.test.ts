import { describe, expect, it } from "vitest";
import {
  describeUserAgent,
  factorChangeEmail,
  inviteEmail,
  magicLinkEmail,
  newDeviceEmail,
  otpEmail,
  shareLinkEmail,
} from "./templates.js";

describe("auth email templates", () => {
  it("OTP email carries the code and expiry only", () => {
    const m = otpEmail("a@example.com", {
      productName: "FundRoom",
      workspaceName: "Acme",
      code: "123456",
      ttlMinutes: 10,
    });
    expect(m.to).toBe("a@example.com");
    expect(m.subject).toContain("123456");
    expect(m.text).toContain("Acme (FundRoom)");
    expect(m.text).toContain("10 minutes");
    expect(m.tags).toEqual(["auth", "otp"]);
    expect(m.template).toEqual({ name: "auth.otp", props: { code: "123456", ttlMinutes: 10 } });
  });

  it("share-link email carries the code, the workspace id and nothing else about the link", () => {
    const m = shareLinkEmail("pat@fund.test", {
      productName: "FundRoom",
      workspaceName: "Acme",
      workspaceId: "01920000-0000-7000-8000-00000000000a",
      code: "246810",
      ttlMinutes: 10,
      label: "Series A data room",
      sharedBy: "Dana",
    });
    expect(m.subject).toContain("246810");
    expect(m.text).toContain("Dana shared Series A data room with you on Acme (FundRoom)");
    expect(m.text).toContain("10 minutes");
    // `workspaceId` is what lets the E1.7 brand resolver find the workspace's branding.
    expect(m.workspaceId).toBe("01920000-0000-7000-8000-00000000000a");
    expect(m.tags).toEqual(["auth", "share-link"]);
    expect(m.template?.name).toBe("auth.share_link_otp");
  });

  it("share-link email names no token, because the code is the secret in the message", () => {
    const m = shareLinkEmail("pat@fund.test", {
      productName: "FundRoom",
      code: "246810",
      ttlMinutes: 10,
    });
    expect(m.text).not.toMatch(/https?:\/\//u);
    expect(m.text).toContain("Somebody at FundRoom shared a private page with you");
  });

  it("share-link email props stay JSON-safe, so identity never imports React", () => {
    const m = shareLinkEmail("pat@fund.test", {
      productName: "FundRoom",
      code: "246810",
      ttlMinutes: 10,
      label: "Series A data room",
    });
    expect(JSON.parse(JSON.stringify(m.template?.props))).toEqual({
      code: "246810",
      ttlMinutes: 10,
      label: "Series A data room",
    });
  });

  it("magic-link email offers the code as a fallback", () => {
    const m = magicLinkEmail("a@example.com", {
      productName: "FundRoom",
      url: "https://x/auth/link?token=t",
      code: "654321",
      ttlMinutes: 15,
      device: "Chrome on macOS",
    });
    expect(m.text).toContain("https://x/auth/link?token=t");
    expect(m.text).toContain("654321");
    expect(m.text).toContain("Requested from: Chrome on macOS");
    expect(m.template?.name).toBe("auth.magic_link");
    expect(m.template?.props).toMatchObject({ url: "https://x/auth/link?token=t", code: "654321" });
  });

  it("new-device email links the one-click revoke", () => {
    const m = newDeviceEmail("a@example.com", {
      productName: "FundRoom",
      device: "Firefox on Linux",
      when: new Date("2026-09-10T12:00:00Z"),
      revokeUrl: "https://x/auth/sessions/revoke?token=r",
      sessionsUrl: "https://x/settings/sessions",
    });
    expect(m.text).toContain("Firefox on Linux");
    expect(m.text).toContain("revoke?token=r");
    expect(m.text).toContain("2026-09-10T12:00:00.000Z");
    expect(m.template?.name).toBe("auth.new_device");
    expect(m.template?.props["whenIso"]).toBe("2026-09-10T12:00:00.000Z");
    expect(JSON.parse(JSON.stringify(m.template?.props))).toEqual(m.template?.props);
  });

  it("invite email names the template with a date-only expiry", () => {
    const m = inviteEmail("a@example.com", {
      productName: "FundRoom",
      workspaceName: "Acme",
      url: "https://x/invite/t",
      inviterName: "Dana",
      expiresAt: new Date("2026-09-17T09:00:00Z"),
    });
    expect(m.text).toContain("Dana has invited you to Acme.");
    expect(m.template).toEqual({
      name: "auth.invite",
      props: {
        url: "https://x/invite/t",
        inviterName: "Dana",
        message: undefined,
        expiresOn: "2026-09-17",
      },
    });
  });

  it("a delegate invitation names the investor it acts for (F5: consent by information)", () => {
    const m = inviteEmail("a@example.com", {
      productName: "FundRoom",
      workspaceName: "Acme",
      url: "https://x/invite/t",
      inviterName: "Pat",
      expiresAt: new Date("2026-09-17T09:00:00Z"),
      delegateFor: "Pat Principal",
    });
    expect(m.text).toContain("Pat Principal invited you to act as their delegate for Acme.");
    expect(m.text).not.toContain("has invited you to Acme");
    expect(m.template?.props).toMatchObject({ delegateFor: "Pat Principal" });
  });

  it("carries the workspace id only when the flow resolved one", () => {
    // E1.7: `workspaceId` is what the composition root's brand resolver keys on. A host-level
    // sign-in has resolved no workspace, and leaving the field undefined there is the point:
    // the resolver then renders the instance brand instead of another workspace's.
    const scoped = [
      otpEmail("a@example.com", {
        productName: "FundRoom",
        workspaceId: "ws_1",
        workspaceName: "Acme",
        code: "123456",
        ttlMinutes: 10,
      }),
      magicLinkEmail("a@example.com", {
        productName: "FundRoom",
        workspaceId: "ws_1",
        url: "https://x/auth/link?token=t",
        code: "654321",
        ttlMinutes: 15,
      }),
      newDeviceEmail("a@example.com", {
        productName: "FundRoom",
        workspaceId: "ws_1",
        device: "Firefox on Linux",
        when: new Date("2026-09-10T12:00:00Z"),
        revokeUrl: "https://x/auth/sessions/revoke?token=r",
        sessionsUrl: "https://x/settings/sessions",
      }),
      inviteEmail("a@example.com", {
        productName: "FundRoom",
        workspaceId: "ws_1",
        workspaceName: "Acme",
        url: "https://x/invite/t",
        expiresAt: new Date("2026-09-17T09:00:00Z"),
      }),
    ];
    expect(scoped.map((m) => m.workspaceId)).toEqual(["ws_1", "ws_1", "ws_1", "ws_1"]);
    const hostLevel = otpEmail("a@example.com", {
      productName: "FundRoom",
      code: "123456",
      ttlMinutes: 10,
    });
    expect(hostLevel.workspaceId).toBeUndefined();
  });

  it("describeUserAgent is coarse and never echoes the raw string", () => {
    const ua =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
    expect(describeUserAgent(ua)).toBe("Chrome on macOS");
    expect(describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Safari/605.1")).toBe(
      "Safari on iOS",
    );
    expect(describeUserAgent("Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Firefox/130.0")).toBe(
      "Firefox on Linux",
    );
    expect(describeUserAgent(undefined)).toBe("Unknown device");
    expect(describeUserAgent("curl/8.0")).toBe("Browser");
  });
});

describe("auth email templates in the recipient's language (E2.8)", () => {
  const brand = { productName: "FundRoom", workspaceName: "Acme", workspaceId: "w1" };
  const isPseudo = (s: string) => s.startsWith("⟦") && s.includes("⟧");

  it("renders subject and every sentence through the catalogue, leaving codes and URLs alone", () => {
    const otp = otpEmail("a@b.test", { ...brand, code: "123456", ttlMinutes: 10, locale: "en-XA" });
    expect(isPseudo(otp.subject)).toBe(true);
    expect(otp.subject).toContain("123456");
    expect(otp.text).toMatch(/^ {4}123456$/mu);
    expect(otp.template?.props).toMatchObject({ locale: "en-XA" });
    const magic = magicLinkEmail("a@b.test", {
      ...brand,
      url: "https://acme.test/x?y=1",
      code: "654321",
      ttlMinutes: 15,
      locale: "en-XA",
    });
    expect(magic.text).toContain("    https://acme.test/x?y=1");
    for (const line of magic.text
      .split("\n")
      .filter((l) => l.trim() !== "" && !l.startsWith("    "))) {
      expect(isPseudo(line), line).toBe(true);
    }
  });

  it("keeps English props exactly as before when no language was chosen", () => {
    const invite = inviteEmail("a@b.test", {
      ...brand,
      url: "https://acme.test/i",
      expiresAt: new Date("2026-01-02T00:00:00Z"),
    });
    expect(invite.template?.props).not.toHaveProperty("locale");
    expect(invite.subject).toBe("You're invited to Acme");
  });

  it("pluralises the expiry with Intl.PluralRules", () => {
    expect(otpEmail("a@b.test", { ...brand, code: "1", ttlMinutes: 1 }).text).toContain(
      "It expires in 1 minute and works once.",
    );
    expect(shareLinkEmail("a@b.test", { ...brand, code: "1", ttlMinutes: 5 }).text).toContain(
      "It expires in 5 minutes and works once.",
    );
  });

  it("falls back to English for a language the catalogue does not have", () => {
    const d = newDeviceEmail("a@b.test", {
      ...brand,
      device: "Firefox on Linux",
      when: new Date("2026-01-02T00:00:00Z"),
      revokeUrl: "https://r",
      sessionsUrl: "https://s",
      locale: "fr",
    });
    expect(d.subject).toBe("New sign-in to Acme (FundRoom)");
    expect(d.text).toContain("    Device: Firefox on Linux\n    When:   2026-01-02T00:00:00.000Z");
  });
});

describe("factorChangeEmail (P2-01 security notice)", () => {
  const base = {
    productName: "FundRoom",
    workspaceName: "Acme",
    workspaceId: "01920000-0000-7000-8000-00000000000a",
    device: "Firefox on Linux",
    when: new Date("2026-01-02T00:00:00Z"),
    sessionsUrl: "https://acme.test/settings/security",
  };

  it("says what changed, from where, and links to the sessions page via the notification template", () => {
    const m = factorChangeEmail("a@b.test", {
      ...base,
      change: "totp_disabled",
      signedOutOthers: 2,
    });
    expect(m.subject).toBe("Security notice: your sign-in methods for Acme (FundRoom) changed");
    expect(m.text).toContain(
      "The authenticator app was removed from your Acme (FundRoom) account.",
    );
    expect(m.text).toContain("From: Firefox on Linux, at 2026-01-02T00:00:00.000Z.");
    expect(m.text).toContain("2 other sessions were signed out");
    expect(m.text).toContain("https://acme.test/settings/security");
    expect(m.workspaceId).toBe(base.workspaceId);
    expect(m.tags).toEqual(["auth", "security-notice"]);
    expect(m.template?.name).toBe("notification");
    expect(m.template?.props).toMatchObject({
      title: "Your sign-in methods changed",
      cta: { label: "Review sessions and sign-in methods", url: base.sessionsUrl },
    });
  });

  it("has a sentence for every change and leaves the sign-out line out when nobody was signed out", () => {
    for (const change of [
      "totp_enabled",
      "totp_disabled",
      "passkey_added",
      "passkey_removed",
      "password_set",
      "password_changed",
      "password_removed",
      "recovery_codes_regenerated",
    ] as const) {
      const m = factorChangeEmail("a@b.test", { ...base, change, signedOutOthers: 0 });
      expect(m.text).not.toContain("auth.factor.");
      expect(m.text).not.toContain("signed out");
    }
    expect(
      factorChangeEmail("a@b.test", { ...base, change: "passkey_added", signedOutOthers: 1 }).text,
    ).toContain("1 other session was signed out");
  });
});
