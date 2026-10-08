import { describe, expect, it } from "vitest";
import type { EmailBrand } from "./brand.js";
import { brandTitle, DEFAULT_ACCENT, safeBrand, TAGLINE_MAX_LENGTH } from "./brand.js";
import {
  hasTemplate,
  registerTemplate,
  renderTemplate,
  TEMPLATE_NAMES,
  TemplateError,
} from "./render.js";

const brand: EmailBrand = {
  productName: "FundRoom",
  workspaceName: "Acme",
  supportEmail: "ir@acme.test",
  accentColor: "#0a6",
  logoUrl: "https://acme.test/logo.png",
};

/** React separates adjacent text nodes with `<!-- -->`; strip them before substring checks. */
function visible(html: string): string {
  return html.replace(/<!-- -->/gu, "");
}

function assertHygiene(html: string): void {
  expect(html.toLowerCase()).not.toContain("<script");
  expect(html).not.toMatch(/src="http:\/\//u);
  expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/u);
  expect(html.length).toBeLessThan(100_000);
}

describe("templates", () => {
  it("lists every registered template", () => {
    for (const name of TEMPLATE_NAMES) expect(hasTemplate(name)).toBe(true);
    expect(hasTemplate("nope.nope")).toBe(false);
  });

  it("auth.otp carries the code, the expiry and the brand", async () => {
    const { html, text } = await renderTemplate(
      "auth.otp",
      { code: "123456", ttlMinutes: 10 },
      brand,
    );
    expect(html).toContain("123456");
    expect(visible(html)).toContain("Your sign-in code for Acme (FundRoom) is:");
    expect(visible(html)).toContain("It expires in 10 minutes and works once.");
    expect(html).toContain('src="https://acme.test/logo.png"');
    expect(html).toContain("#0a6");
    expect(html).toContain("ir@acme.test");
    expect(text).toContain("123456");
    assertHygiene(html);
  });

  it("auth.share_link_otp names what was shared and by whom, without the link itself", async () => {
    const { html, text } = await renderTemplate(
      "auth.share_link_otp",
      { code: "246810", ttlMinutes: 10, label: "Series A data room", sharedBy: "Dana" },
      brand,
    );
    expect(html).toContain("246810");
    expect(visible(html)).toContain("Dana shared Series A data room with you on Acme (FundRoom)");
    expect(visible(html)).toContain("It expires in 10 minutes and works once.");
    // The token is the secret in the URL and never belongs in mail; the code is the secret here.
    expect(html).not.toContain("/s/");
    expect(text).toContain("246810");
    assertHygiene(html);
  });

  it("auth.share_link_otp still reads as a sentence with neither a label nor a sharer", async () => {
    const { html } = await renderTemplate(
      "auth.share_link_otp",
      { code: "135790", ttlMinutes: 10 },
      brand,
    );
    expect(visible(html)).toContain("Somebody at Acme shared a private page with you");
    assertHygiene(html);
  });

  it("auth.magic_link has the link, the fallback code and the device", async () => {
    const { html } = await renderTemplate(
      "auth.magic_link",
      {
        url: "https://x/auth/link?token=t",
        code: "654321",
        ttlMinutes: 15,
        device: "Chrome on macOS",
      },
      brand,
    );
    expect(html).toContain('href="https://x/auth/link?token=t"');
    expect(html).toContain("654321");
    expect(visible(html)).toContain("Requested from: Chrome on macOS");
    expect(visible(html)).toContain("Both expire in 15 minutes and work once.");
    assertHygiene(html);
  });

  it("auth.new_device links the one-click revoke and the sessions page", async () => {
    const { html } = await renderTemplate(
      "auth.new_device",
      {
        device: "Firefox on Linux",
        whenIso: "2026-09-10T12:00:00.000Z",
        revokeUrl: "https://x/auth/sessions/revoke?token=r",
        sessionsUrl: "https://x/settings/sessions",
      },
      brand,
    );
    expect(visible(html)).toContain("Device: Firefox on Linux");
    expect(visible(html)).toContain("When: 2026-09-10T12:00:00.000Z");
    expect(html).toContain('href="https://x/auth/sessions/revoke?token=r"');
    expect(html).toContain('href="https://x/settings/sessions"');
    assertHygiene(html);
  });

  it("auth.invite names the inviter, quotes the message and states the expiry", async () => {
    const { html } = await renderTemplate(
      "auth.invite",
      {
        url: "https://x/invite/t",
        inviterName: "Dana",
        message: "Welcome aboard",
        expiresOn: "2026-09-17",
      },
      brand,
    );
    expect(visible(html)).toContain("Dana has invited you to Acme.");
    expect(html).toContain("Welcome aboard");
    expect(html).toContain("2026-09-17");
    expect(html).toContain('href="https://x/invite/t"');
    assertHygiene(html);
    const anon = await renderTemplate(
      "auth.invite",
      { url: "https://x/i", expiresOn: "2026-09-17" },
      brand,
    );
    expect(anon.html).toContain("You have been invited");
    // E3.2 / F5: a delegate invitation names the investor it would act for.
    const delegate = await renderTemplate(
      "auth.invite",
      { url: "https://x/i", expiresOn: "2026-09-17", delegateFor: "Pat Principal" },
      brand,
    );
    expect(visible(delegate.html)).toContain(
      "Pat Principal invited you to act as their delegate for Acme.",
    );
  });

  it("auth.access_request_code carries the code and says 'access', not 'sign in'", async () => {
    const { html, text } = await renderTemplate(
      "auth.access_request_code",
      { code: "042042", ttlMinutes: 10, expiresAt: "2026-09-25T12:10:00.000Z" },
      brand,
    );
    expect(html).toContain("042042");
    expect(visible(html)).toContain(
      "Somebody asked for access to Acme (FundRoom) with this email address.",
    );
    expect(visible(html)).toContain("It expires in 10 minutes and works once.");
    expect(visible(html).toLowerCase()).not.toContain("sign-in code");
    expect(text).toContain("042042");
    assertHygiene(html);
  });

  it("auth.access_request_existing links the sign-in page", async () => {
    const { html } = await renderTemplate(
      "auth.access_request_existing",
      { signInUrl: "https://x/login" },
      brand,
    );
    expect(visible(html)).toContain("This address already has access");
    expect(html).toContain('href="https://x/login"');
    assertHygiene(html);
  });

  it("auth.access_request_denied is neutral and carries no link", async () => {
    const { html } = await renderTemplate("auth.access_request_denied", {}, brand);
    expect(visible(html)).toContain(
      "Thank you for your interest in Acme. We are not able to offer you access at this time.",
    );
    expect(html).not.toMatch(/href="https:\/\/x\//u);
    assertHygiene(html);
  });

  it("notification renders paragraphs and an optional CTA", async () => {
    const { html } = await renderTemplate(
      "notification",
      {
        title: "New update",
        paragraphs: ["First.", "Second."],
        cta: { label: "Read it", url: "https://x/u/1" },
      },
      brand,
    );
    expect(html).toContain("New update");
    expect(html).toContain("First.");
    expect(html).toContain("Second.");
    expect(html).toContain('href="https://x/u/1"');
    assertHygiene(html);
  });

  it("escapes hostile brand values and drops unsafe logo/colour", async () => {
    const hostile: EmailBrand = {
      productName: 'p"roduct',
      workspaceName: '<script>alert(1)</script>"Evil"',
      logoUrl: "javascript:alert(1)",
      accentColor: "red;background:url(http://evil)",
      supportEmail: "x@y.z",
    };
    const { html } = await renderTemplate("auth.otp", { code: "111111", ttlMinutes: 5 }, hostile);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("http://evil");
    expect(html).toContain("#1d4ed8");
    expect(safeBrand(hostile).logoUrl).toBeUndefined();
    expect(brandTitle({ productName: "FundRoom" })).toBe("FundRoom");
    expect(brandTitle(brand)).toBe("Acme (FundRoom)");
  });

  it("renders the tagline under the brand name in the header", async () => {
    const { html } = await renderTemplate(
      "auth.otp",
      { code: "111111", ttlMinutes: 5 },
      { ...brand, tagline: "Private markets, plainly." },
    );
    expect(visible(html)).toContain("Private markets, plainly.");
    assertHygiene(html);
    const none = await renderTemplate("auth.otp", { code: "111111", ttlMinutes: 5 }, brand);
    expect(none.html).not.toContain("Private markets");
  });

  it("showPoweredBy:false drops only the attribution", async () => {
    const withAddress: EmailBrand = { ...brand, addressLine: "1 Main St, Springfield" };
    const on = await renderTemplate("auth.otp", { code: "1", ttlMinutes: 5 }, withAddress);
    expect(visible(on.html)).toContain("Acme investor portal, powered by FundRoom.");
    const off = await renderTemplate(
      "auth.otp",
      { code: "1", ttlMinutes: 5 },
      {
        ...withAddress,
        showPoweredBy: false,
      },
    );
    expect(visible(off.html)).not.toContain("powered by");
    expect(visible(off.html)).toContain("Acme investor portal.");
    expect(off.html).toContain("ir@acme.test");
    expect(visible(off.html)).toContain("1 Main St, Springfield");
  });

  it("safeBrand trims and caps the tagline and defaults showPoweredBy to true", () => {
    const long = "x".repeat(TAGLINE_MAX_LENGTH + 50);
    const safe = safeBrand({ productName: "p", tagline: `  ${long}  ` });
    expect(safe.tagline).toHaveLength(TAGLINE_MAX_LENGTH);
    expect(safe.showPoweredBy).toBe(true);
    expect(safeBrand({ productName: "p", tagline: "   " }).tagline).toBeUndefined();
    expect(safeBrand({ productName: "p", showPoweredBy: false }).showPoweredBy).toBe(false);
    expect(safeBrand({ productName: "p", logoUrl: "http://x/logo.png" }).logoUrl).toBeUndefined();
    expect(safeBrand({ productName: "p", logoUrl: "https://x/logo.png" }).logoUrl).toBe(
      "https://x/logo.png",
    );
    expect(safeBrand({ productName: "p", accentColor: "#gggggg" }).accentColor).toBe(
      DEFAULT_ACCENT,
    );
    expect(safeBrand({ productName: "p", accentColor: "#0a6" }).accentColor).toBe("#0a6");
  });

  it("rejects unknown templates and accepts registered ones", async () => {
    await expect(renderTemplate("nope.nope", {}, brand)).rejects.toBeInstanceOf(TemplateError);
    expect(() => registerTemplate("Bad Name", () => <never>null)).toThrow(/invalid template name/u);
  });
});

describe("templates in the recipient's language (E2.8)", () => {
  it("sets <html lang> and <body lang> and localises the chrome", async () => {
    const out = await renderTemplate(
      "auth.otp",
      { code: "123456", ttlMinutes: 10, locale: "en-XA" },
      { ...brand, showPoweredBy: true },
    );
    expect(out.html).toMatch(/<html[^>]* lang="en-XA"/u);
    expect(out.html).toMatch(/<body[^>]* lang="en-XA"/u);
    expect(visible(out.html)).toContain("123456");
    expect(visible(out.html)).not.toContain("investor portal, powered by");
    expect(visible(out.html)).toMatch(/⟦Ǫúéšţíóñš\?/u);
  });

  it("renders English with lang=en when no language is given", async () => {
    const out = await renderTemplate("auth.otp", { code: "123456", ttlMinutes: 10 }, brand);
    expect(out.html).toMatch(/<html[^>]* lang="en"/u);
    expect(visible(out.html)).toContain("Acme investor portal, powered by FundRoom.");
  });
});
