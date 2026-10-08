import { describe, expect, it } from "vitest";
import { IntegrationError } from "./errors.js";
import {
  audienceAdmits,
  bookingUpdate,
  checkBookingLinkUrl,
  checkReturnPath,
  checkSecretCredentials,
  decodeBookingCursor,
  encodeBookingCursor,
  nextHealth,
  parseAccounts,
  parseAudience,
  pkceChallenge,
  resultQuery,
  stripeKeyEnvironment,
} from "./policy.js";

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof IntegrationError
      ? `${e.code}:${String(e.details["reason"] ?? "")}`
      : "other";
  }
  return "ok";
};

describe("checkBookingLinkUrl", () => {
  const hosts = ["cal.com", "app.cal.com"];
  it("accepts https on an allowed host and normalises", () => {
    expect(checkBookingLinkUrl(" https://Cal.com/acme/intro ", hosts)).toBe(
      "https://cal.com/acme/intro",
    );
    expect(checkBookingLinkUrl("https://app.cal.com/acme?x=1", hosts)).toBe(
      "https://app.cal.com/acme?x=1",
    );
  });
  it("refuses http, userinfo, a port, another host and a lookalike subdomain", () => {
    expect(code(() => checkBookingLinkUrl("http://cal.com/acme", hosts))).toBe(
      "booking_link_invalid_url:not_https",
    );
    expect(code(() => checkBookingLinkUrl("https://u:p@cal.com/acme", hosts))).toBe(
      "booking_link_invalid_url:userinfo",
    );
    expect(code(() => checkBookingLinkUrl("https://cal.com:8443/acme", hosts))).toBe(
      "booking_link_invalid_url:port",
    );
    expect(code(() => checkBookingLinkUrl("https://evil.example/cal.com", hosts))).toBe(
      "booking_link_invalid_url:host_not_allowed",
    );
    expect(code(() => checkBookingLinkUrl("https://cal.com.evil.example/x", hosts))).toBe(
      "booking_link_invalid_url:host_not_allowed",
    );
    expect(code(() => checkBookingLinkUrl("javascript:alert(1)//cal.com", hosts))).toBe(
      "booking_link_invalid_url:not_https",
    );
    expect(code(() => checkBookingLinkUrl("not a url at all", hosts))).toBe(
      "booking_link_invalid_url:not_a_url",
    );
  });
  it("a provider without hosts admits nothing", () => {
    expect(code(() => checkBookingLinkUrl("https://cal.com/acme", []))).toBe(
      "booking_link_invalid_url:host_not_allowed",
    );
  });
});

describe("audiences", () => {
  const g1 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b01";
  const g2 = "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b02";
  it("all admits everyone, groups needs an intersection", () => {
    expect(audienceAdmits({ kind: "all" }, new Set())).toBe(true);
    expect(audienceAdmits({ kind: "groups", groupIds: [g1] }, new Set([g2]))).toBe(false);
    expect(audienceAdmits({ kind: "groups", groupIds: [g1, g2] }, new Set([g2]))).toBe(true);
  });
  it("an unreadable stored audience admits nobody", () => {
    expect(parseAudience({ kind: "everyone" })).toEqual({ kind: "groups", groupIds: [] });
    expect(parseAudience(null)).toEqual({ kind: "groups", groupIds: [] });
    expect(parseAudience({ kind: "groups", groupIds: [g1, "x"] })).toEqual({
      kind: "groups",
      groupIds: [g1],
    });
  });
});

describe("bookingUpdate", () => {
  const at = new Date("2026-10-01T10:00:00Z");
  const base = {
    status: "booked" as const,
    startsAt: at,
    endsAt: null,
    inviteeName: "A",
    eventName: "Intro",
  };
  it("moves forward only", () => {
    expect(bookingUpdate(base, { ...base, status: "cancelled" })).toBe(true);
    expect(bookingUpdate({ ...base, status: "cancelled" }, base)).toBe(false);
    expect(bookingUpdate({ ...base, status: "rescheduled" }, { ...base, status: "booked" })).toBe(
      false,
    );
  });
  it("the same status applies only when something changed", () => {
    expect(bookingUpdate(base, base)).toBe(false);
    expect(bookingUpdate(base, { ...base, startsAt: new Date(at.getTime() + 3_600_000) })).toBe(
      true,
    );
  });
});

describe("credentials", () => {
  const fields = [
    { key: "restrictedKey", label: "Key", kind: "secret" as const, required: true },
    { key: "note", label: "Note", kind: "text" as const, required: false },
  ];
  it("refuses unknown and missing fields, picks the first secret as the token", () => {
    expect(code(() => checkSecretCredentials(fields, { other: "x" }))).toBe(
      "validation_failed:unknown_field",
    );
    expect(code(() => checkSecretCredentials(fields, { note: "x" }))).toBe(
      "validation_failed:field_required",
    );
    expect(checkSecretCredentials(fields, { restrictedKey: " rk_test_1 " })).toEqual({
      credentials: { restrictedKey: "rk_test_1" },
      accessToken: "rk_test_1",
    });
    expect(checkSecretCredentials([], {})).toEqual({ credentials: {}, accessToken: "" });
  });
  it("Stripe takes restricted keys only; the prefix decides the environment", () => {
    expect(code(() => stripeKeyEnvironment("sk_live_abc"))).toBe(
      "integration_secret_key_refused:secret_key",
    );
    expect(code(() => stripeKeyEnvironment("sk_test_abc"))).toBe(
      "integration_secret_key_refused:secret_key",
    );
    expect(code(() => stripeKeyEnvironment("pk_live_abc"))).toBe(
      "integration_credentials_rejected:malformed",
    );
    expect(stripeKeyEnvironment("rk_live_abc")).toBe("production");
    expect(stripeKeyEnvironment("rk_test_abc")).toBe("sandbox");
  });
});

describe("nextHealth", () => {
  const active = { status: "active" as const, consecutiveFailures: 0 };
  it("three failures degrade, success resets", () => {
    const f = { kind: "failure" as const, reason: "transport" as const };
    const one = nextHealth(active, f);
    const two = nextHealth(one, f);
    const three = nextHealth(two, f);
    expect([one.status, two.status, three.status]).toEqual(["active", "active", "degraded"]);
    expect(three.lastError).toMatch(/^transport:/u);
    const ok = nextHealth(three, { kind: "success" });
    expect(ok).toMatchObject({ status: "active", consecutiveFailures: 0, lastError: null });
  });
  it("a refused token needs reauth, and a transient failure does not lift it", () => {
    const r = nextHealth(active, { kind: "reauth" });
    expect(r.status).toBe("reauth_required");
    expect(nextHealth(r, { kind: "failure", reason: "transport" }).status).toBe("reauth_required");
  });
  it("neutral changes nothing", () => {
    expect(nextHealth(active, { kind: "neutral" })).toMatchObject({
      success: false,
      failure: false,
    });
  });
});

describe("small helpers", () => {
  it("return paths stay inside /admin", () => {
    expect(checkReturnPath(undefined)).toBe("/admin/integrations");
    expect(checkReturnPath("/admin/metrics/sources")).toBe("/admin/metrics/sources");
    expect(checkReturnPath("https://evil.example/")).toBe("/admin/integrations");
    expect(checkReturnPath("//evil.example/admin/")).toBe("/admin/integrations");
    expect(checkReturnPath("/admin//evil.example")).toBe("/admin/integrations");
  });
  it("result query carries no free text", () => {
    expect(resultQuery("xero", "error", "denied")).toBe(
      "integration=xero&result=error&reason=denied",
    );
  });
  it("cursor round trip; junk is refused", () => {
    const row = {
      startsAt: new Date("2026-09-26T10:00:00Z"),
      id: "0192f1a0-5c3e-7d2a-9a3b-1f2e3d4c5b01",
    };
    expect(decodeBookingCursor(encodeBookingCursor(row))).toEqual(row);
    expect(decodeBookingCursor("garbage")).toBeUndefined();
  });
  it("PKCE S256 (RFC 7636 appendix B)", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
  it("accounts are bounded and tolerant", () => {
    expect(parseAccounts('[{"id":"t1","name":"Acme"},{"id":""},{"name":"x"},7]')).toEqual([
      { id: "t1", name: "Acme" },
    ]);
    expect(parseAccounts("{")).toEqual([]);
    expect(parseAccounts(undefined)).toEqual([]);
  });
});
