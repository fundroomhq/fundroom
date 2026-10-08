import { describe, expect, it } from "vitest";
import {
  canRenew,
  escapeHtml,
  handoffCsp,
  handoffPage,
  myHandoff,
  nextCheckAt,
  parseHandoff,
  pollingExhausted,
  scriptJson,
  splitName,
  vendorExpiry,
  type WidgetHandoff,
} from "./vendor-rules.js";

const NOW = new Date("2026-03-15T12:00:00.000Z");
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);

describe("the polling schedule", () => {
  it("is 5m, 15m, 1h, 6h, 1d, then daily", () => {
    const minutes = [0, 1, 2, 3, 4, 5, 9].map(
      (n) => (nextCheckAt(NOW, n).getTime() - NOW.getTime()) / 60_000,
    );
    expect(minutes).toEqual([5, 15, 60, 360, 1440, 1440, 1440]);
  });

  it("stops after 120 days", () => {
    expect(pollingExhausted(at(-119), NOW)).toBe(false);
    expect(pollingExhausted(at(-120), NOW)).toBe(true);
  });
});

describe("a vendor expiry", () => {
  it("is the vendor's, when it is inside twelve months of the decision", () => {
    expect(vendorExpiry({ decidedAt: at(-2), expiresAt: at(88), now: NOW })).toEqual({
      decidedAt: at(-2),
      expiresAt: at(88),
    });
  });

  it("is clamped to twelve months after the decision", () => {
    const got = vendorExpiry({ decidedAt: NOW, expiresAt: at(1000), now: NOW });
    expect(got).toEqual({ decidedAt: NOW, expiresAt: new Date("2027-03-15T12:00:00.000Z") });
  });

  it("is 90 days after the decision when the vendor gives none", () => {
    expect(vendorExpiry({ decidedAt: at(-10), now: NOW })).toEqual({
      decidedAt: at(-10),
      expiresAt: at(80),
    });
  });

  it("reads a decision dated in the future (or missing) as now", () => {
    expect(vendorExpiry({ decidedAt: at(5), expiresAt: at(30), now: NOW })).toEqual({
      decidedAt: NOW,
      expiresAt: at(30),
    });
    expect(vendorExpiry({ now: NOW })).toEqual({ decidedAt: NOW, expiresAt: at(90) });
  });

  it("never verifies an answer that has already run out", () => {
    expect(vendorExpiry({ decidedAt: at(-100), expiresAt: at(-1), now: NOW })).toBe("expired");
    expect(vendorExpiry({ decidedAt: at(-100), now: NOW })).toBe("expired");
    // clamped to decidedAt + 12 months, which is already past
    expect(vendorExpiry({ decidedAt: at(-400), expiresAt: at(30), now: NOW })).toBe("expired");
    expect(vendorExpiry({ decidedAt: at(-1), expiresAt: at(-1), now: NOW })).toBe("expired");
  });
});

describe("a name for the vendor", () => {
  it("splits the first word from the rest", () => {
    expect(splitName("Jane Q  Investor")).toEqual({ firstName: "Jane", lastName: "Q Investor" });
    expect(splitName("Cher")).toEqual({ firstName: "Cher" });
  });

  it("sends none for an address or nothing", () => {
    expect(splitName("jane@example.com")).toEqual({});
    expect(splitName("  ")).toEqual({});
    expect(splitName(null)).toEqual({});
  });
});

describe("whether an investor may renew", () => {
  const base = { pending: false, reminderDays: 14, now: NOW };
  it("is yes with nothing, a rejection or an expiry on file", () => {
    expect(canRenew({ ...base, latest: undefined })).toBe(true);
    expect(canRenew({ ...base, latest: { status: "rejected", expiresAt: null } })).toBe(true);
    expect(canRenew({ ...base, latest: { status: "expired", expiresAt: at(-1) } })).toBe(true);
  });

  it("is no while one is pending", () => {
    expect(canRenew({ ...base, pending: true, latest: undefined })).toBe(false);
  });

  it("is yes for a verification inside the reminder window, no far from expiry", () => {
    expect(canRenew({ ...base, latest: { status: "verified", expiresAt: at(14) } })).toBe(true);
    expect(canRenew({ ...base, latest: { status: "verified", expiresAt: at(15) } })).toBe(false);
    expect(canRenew({ ...base, latest: { status: "verified", expiresAt: at(-1) } })).toBe(true);
  });
});

const widget: WidgetHandoff = {
  kind: "widget",
  sdk: "parallel-markets",
  config: {
    clientId: "client-1",
    environment: "demo",
    requiredEntityId: "VXNlcjox",
    email: "jane@example.com",
    firstName: "Jane",
    lastName: "</script><script>alert(1)</script>",
    entityType: "self",
  },
};

describe("the investor's handoff", () => {
  it("never carries the widget config: a widget is a link to the handoff page", () => {
    const got = myHandoff(
      { provider: "parallel-markets", status: "pending", handoff: widget },
      "https://x/h",
    );
    expect(got).toEqual({ kind: "widget", url: "https://x/h" });
  });

  it("is an upload for a manual row, nothing once decided or before a vendor start", () => {
    expect(myHandoff({ provider: "manual", status: "pending", handoff: null }, "u")).toEqual({
      kind: "upload",
    });
    expect(myHandoff({ provider: "manual", status: "verified", handoff: null }, "u")).toBeNull();
    expect(
      myHandoff({ provider: "verifyinvestor", status: "pending", handoff: null }, "u"),
    ).toBeNull();
    expect(
      myHandoff(
        { provider: "verifyinvestor", status: "pending", handoff: { kind: "invite_sent" } },
        "u",
      ),
    ).toEqual({ kind: "invite_sent" });
  });

  it("refuses a stored redirect that is not https", () => {
    expect(parseHandoff({ kind: "redirect", url: "javascript:alert(1)" })).toBeUndefined();
    expect(parseHandoff({ kind: "redirect", url: "https://vendor.example/x" })).toBeDefined();
    expect(parseHandoff({ kind: "widget", sdk: "other", config: {} })).toBeUndefined();
  });
});

describe("the handoff page", () => {
  it("sends exactly the contract's CSP, with the nonce twice", () => {
    expect(handoffCsp("abc=")).toBe(
      "default-src 'none'; script-src 'nonce-abc=' https://app.parallelmarkets.com; " +
        "frame-src https://app.parallelmarkets.com https://demo.parallelmarkets.com; " +
        "connect-src https://*.parallelmarkets.com; style-src 'unsafe-inline' https://app.parallelmarkets.com; " +
        "img-src https://*.parallelmarkets.com data:; base-uri 'none'; form-action 'none'; " +
        "frame-ancestors 'none'",
    );
  });

  it("cannot be broken out of by a name: the config is script-safe JSON", () => {
    const html = handoffPage({
      nonce: "n0nce",
      handoff: widget,
      portalUrl: 'https://acme.example/round"><script>',
      providerLabel: "Parallel Markets",
    });
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script\\u003e\\u003cscript\\u003ealert(1)");
    expect(html).toContain('href="https://acme.example/round&quot;&gt;&lt;script&gt;"');
    // Every script and style element carries the nonce.
    const tags = html.match(/<(script|style)\b[^>]*>/gu) ?? [];
    expect(tags.length).toBe(4);
    for (const tag of tags) expect(tag).toContain('nonce="n0nce"');
    // The JSON parses back to the config (no email or name lost to escaping).
    const json =
      /<script type="application\/json" id="handoff-config" nonce="n0nce">(.*?)<\/script>/su.exec(
        html,
      )?.[1];
    expect(JSON.parse(json ?? "null")).toMatchObject({
      clientId: "client-1",
      lastName: "</script><script>alert(1)</script>",
      requiredEntityId: "VXNlcjox",
    });
  });

  it("escapes what goes into HTML and into script JSON", () => {
    expect(escapeHtml(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
    expect(scriptJson({ a: "<>&\u2028\u2029" })).toBe(
      '{"a":"\\u003c\\u003e\\u0026\\u2028\\u2029"}',
    );
  });
});
