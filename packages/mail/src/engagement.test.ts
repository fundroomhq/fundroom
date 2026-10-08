import type { MailDeliveryEvent } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import {
  classifyEngagement,
  isProviderSuppression,
  isUnsubscribeLink,
  LINK_MAX_LENGTH,
  stripLink,
  TOO_FAST_CLICK_MS,
} from "./engagement.js";

const SENT = new Date("2026-09-22T10:00:00.000Z");
const LATER = new Date("2026-09-22T11:00:00.000Z");

function event(overrides: Partial<MailDeliveryEvent>): MailDeliveryEvent {
  return {
    kind: "open",
    recipient: "a@example.com",
    messageId: "m-1",
    occurredAt: LATER,
    reason: undefined,
    provider: "test",
    ...overrides,
  };
}

const SAFARI_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";
const GMAIL_PROXY =
  "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)";

describe("classifyEngagement", () => {
  it("never flags delivery, bounce, complaint or delay events", () => {
    for (const kind of ["delivered", "bounce", "complaint", "delay"] as const) {
      expect(classifyEngagement(event({ kind, machine: true, userAgent: "curl/8" }))).toEqual({
        automated: false,
        reason: null,
      });
    }
  });

  it("trusts the provider's machine flag over everything else", () => {
    expect(classifyEngagement(event({ machine: true, userAgent: SAFARI_MAC }))).toEqual({
      automated: true,
      reason: "provider",
    });
    expect(classifyEngagement(event({ kind: "click", machine: true }))).toEqual({
      automated: true,
      reason: "provider",
    });
    expect(classifyEngagement(event({ machine: false, userAgent: CHROME_WIN })).automated).toBe(
      false,
    );
  });

  it("flags Apple Mail Privacy Protection prefetches on opens", () => {
    for (const ua of [
      "Mozilla/5.0",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
      "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)",
    ]) {
      expect(classifyEngagement(event({ userAgent: ua })), ua).toEqual({
        automated: true,
        reason: "mpp",
      });
    }
  });

  it("does not treat a real browser, Gmail's image proxy or a Safari click as MPP", () => {
    for (const ua of [SAFARI_MAC, CHROME_WIN, GMAIL_PROXY]) {
      expect(classifyEngagement(event({ userAgent: ua })).automated, ua).toBe(false);
    }
    // The MPP user agent on a click is a real navigation from an Apple client.
    expect(
      classifyEngagement(event({ kind: "click", userAgent: "Mozilla/5.0" }), { sentAt: SENT }),
    ).toEqual({ automated: false, reason: null });
  });

  it("flags link scanners and bare HTTP clients on opens and clicks", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Barracuda Sentinel)",
      "Mimecast-Link-Scanner",
      "Proofpoint URL Defense",
      "python-requests/2.32.3",
      "curl/8.7.1",
      "Go-http-client/1.1",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36",
      "Mozilla/5.0 (compatible; SomeBot/1.0)",
      "facebookexternalhit/1.1",
    ]) {
      for (const kind of ["open", "click"] as const) {
        expect(classifyEngagement(event({ kind, userAgent: ua })), `${kind} ${ua}`).toEqual({
          automated: true,
          reason: "scanner",
        });
      }
    }
  });

  it("treats Office's link pre-check user agents as scanners on clicks only", () => {
    for (const ua of [
      "Microsoft Office Protocol Discovery",
      "Microsoft Office Existence Discovery",
      "Mozilla/4.0 (compatible; ms-office; MSOffice rmj)",
    ]) {
      expect(classifyEngagement(event({ kind: "click", userAgent: ua })), ua).toEqual({
        automated: true,
        reason: "scanner",
      });
    }
  });

  it("counts opens by real mail clients and their on-open image proxies as human", () => {
    const clients: Record<string, string> = {
      "Outlook desktop (classic)": "Mozilla/4.0 (compatible; ms-office; MSOffice 16)",
      "Outlook desktop (Click-to-Run)":
        "Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.17928; Pro)",
      "Outlook for Mac":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15 Outlook/16",
      // Gmail fetches through its proxy when the reader opens the message (then caches).
      "Gmail image proxy": GMAIL_PROXY,
      "Yahoo Mail proxy":
        "YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html",
      Thunderbird:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Thunderbird/128.2.0",
      "Chrome (webmail)": CHROME_WIN,
    };
    for (const [name, ua] of Object.entries(clients)) {
      expect(classifyEngagement(event({ kind: "open", userAgent: ua })), name).toEqual({
        automated: false,
        reason: null,
      });
    }
    // Apple Mail with Privacy Protection stays automated.
    expect(classifyEngagement(event({ kind: "open", userAgent: "Mozilla/5.0" })).reason).toBe(
      "mpp",
    );
  });

  it("does not mistake a word containing 'bot' for a bot", () => {
    expect(
      classifyEngagement(event({ userAgent: `${CHROME_WIN} Robotic/1.0 Abbott` })).automated,
    ).toBe(false);
  });

  it("flags a click that lands too soon after the send", () => {
    const fast = new Date(SENT.getTime() + TOO_FAST_CLICK_MS - 1);
    const slow = new Date(SENT.getTime() + TOO_FAST_CLICK_MS);
    expect(
      classifyEngagement(event({ kind: "click", occurredAt: fast, userAgent: CHROME_WIN }), {
        sentAt: SENT,
      }),
    ).toEqual({ automated: true, reason: "too_fast" });
    expect(
      classifyEngagement(event({ kind: "click", occurredAt: slow, userAgent: CHROME_WIN }), {
        sentAt: SENT,
      }),
    ).toEqual({ automated: false, reason: null });
    // Clock skew: a click stamped before the send is instant, not human.
    expect(
      classifyEngagement(event({ kind: "click", occurredAt: new Date(SENT.getTime() - 5_000) }), {
        sentAt: SENT,
      }).reason,
    ).toBe("too_fast");
    // Without a send time there is no timing evidence.
    expect(classifyEngagement(event({ kind: "click", occurredAt: fast })).automated).toBe(false);
    // Opens are not timed: MPP and scanners are caught by user agent.
    expect(
      classifyEngagement(event({ kind: "open", occurredAt: fast, userAgent: CHROME_WIN }), {
        sentAt: SENT,
      }).automated,
    ).toBe(false);
  });

  it("flags an open with no user agent as unverified (Resend opens), but not a click", () => {
    for (const userAgent of [undefined, "", "   "]) {
      expect(classifyEngagement(event({ kind: "open", userAgent }))).toEqual({
        automated: true,
        reason: "unverified",
      });
      expect(classifyEngagement(event({ kind: "click", userAgent }), { sentAt: SENT })).toEqual({
        automated: false,
        reason: null,
      });
    }
    // A provider that vouches for the open is believed.
    expect(classifyEngagement(event({ kind: "open", machine: false }))).toEqual({
      automated: false,
      reason: null,
    });
  });
});

describe("stripLink", () => {
  it("keeps origin and path of http(s) links only", () => {
    expect(stripLink("https://example.com/deck?token=secret#p2")).toBe("https://example.com/deck");
    expect(stripLink("http://user:pw@Example.com:8080/a/b/")).toBe("http://example.com:8080/a/b/");
    expect(stripLink("https://example.com")).toBe("https://example.com/");
  });

  it("refuses everything that is not an http(s) URL", () => {
    for (const bad of [
      "mailto:a@example.com",
      "javascript:alert(1)",
      "ftp://example.com/x",
      "not a url",
      "",
      undefined,
      null,
    ]) {
      expect(stripLink(bad), String(bad)).toBeNull();
    }
  });

  it("redacts this product's token routes, under any base path or workspace prefix", () => {
    const own = { ownOrigins: ["https://app.example.com", "https://investors.acme.com"] };
    const token = "8Zr2Qk9v_TdM1sXpLb0HgC3nWyRfE6uJaZoP4iKtQvA";
    const cases: [string, string][] = [
      [`https://investors.acme.com/s/${token}`, "https://investors.acme.com/s/:token"],
      [
        `https://app.example.com/w/acme/s/${token}/page/2`,
        "https://app.example.com/w/acme/s/:token",
      ],
      [
        `https://investors.acme.com/api/v1/metrics/chart/${token}.png`,
        "https://investors.acme.com/api/:redacted",
      ],
      [
        "https://investors.acme.com/api/v1/updates/unsubscribe?token=x",
        "https://investors.acme.com/api/:redacted",
      ],
      ["https://investors.acme.com/unsubscribe?token=x", "https://investors.acme.com/unsubscribe"],
      [`https://investors.acme.com/unsubscribe/${token}`, "https://investors.acme.com/unsubscribe"],
      [`https://investors.acme.com/invite/${token}`, "https://investors.acme.com/invite/:token"],
      // Resource ids and ordinary words are kept.
      [
        "https://investors.acme.com/updates/0192a5c4-1b2c-7d3e-8f40-123456789abc",
        "https://investors.acme.com/updates/0192a5c4-1b2c-7d3e-8f40-123456789abc",
      ],
      ["https://investors.acme.com/data-room/q3", "https://investors.acme.com/data-room/q3"],
    ];
    for (const [input, expected] of cases) {
      expect(stripLink(input, own), input).toBe(expected);
      // Without ownOrigins the same redaction applies, and re-stripping is idempotent.
      expect(stripLink(input), input).toBe(expected);
      expect(stripLink(expected, own), expected).toBe(expected);
    }
  });

  it("reduces a link on a foreign origin to its origin", () => {
    const own = { ownOrigins: ["https://investors.acme.com"] };
    expect(stripLink("https://docs.google.com/document/d/1AbC_secretDocId/edit", own)).toBe(
      "https://docs.google.com",
    );
    expect(stripLink("https://calendly.com/founder/30min", own)).toBe("https://calendly.com");
    // A subdomain of our own host is not our origin.
    expect(stripLink("https://evil.investors.acme.com/x", own)).toBe(
      "https://evil.investors.acme.com",
    );
    expect(stripLink("https://investors.acme.com/deck", own)).toBe(
      "https://investors.acme.com/deck",
    );
  });

  it("caps the stored link length", () => {
    const long = `https://example.com/${"a".repeat(1_000)}?q=1`;
    const out = stripLink(long);
    expect(out).toHaveLength(LINK_MAX_LENGTH);
    expect(out?.startsWith("https://example.com/aaa")).toBe(true);
  });
});

describe("isUnsubscribeLink", () => {
  it("recognises unsubscribe paths on any origin", () => {
    for (const url of [
      "https://investors.acme.com/unsubscribe?token=x",
      "https://app.example.com/api/v1/updates/unsubscribe?token=x",
      "https://esp.example/Unsubscribe/abc",
      "https://investors.acme.com/unsubscribe",
    ]) {
      expect(isUnsubscribeLink(url), url).toBe(true);
    }
    for (const url of ["https://investors.acme.com/deck", "not a url", undefined, null]) {
      expect(isUnsubscribeLink(url), String(url)).toBe(false);
    }
  });
});

describe("isProviderSuppression", () => {
  it("is a hard bounce whose reason carries the provider_suppressed: prefix", () => {
    expect(
      isProviderSuppression({
        kind: "bounce",
        bounceType: "hard",
        reason: "provider_suppressed:OnAccountSuppressionList",
      }),
    ).toBe(true);
    expect(isProviderSuppression({ kind: "bounce", bounceType: "hard", reason: "550" })).toBe(
      false,
    );
    expect(
      isProviderSuppression({
        kind: "bounce",
        bounceType: "soft",
        reason: "provider_suppressed:x",
      }),
    ).toBe(false);
  });
});
