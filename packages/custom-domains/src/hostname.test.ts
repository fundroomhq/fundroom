import { describe, expect, it } from "vitest";
import { checkHostname, normalizeHostname } from "./hostname.js";

const CANONICAL = "fundroom.app";

function reasonOf(input: string): string {
  const result = normalizeHostname(input);
  return result.ok ? `ok:${result.hostname}` : result.reason;
}

describe("normalizeHostname", () => {
  it("accepts a plain subdomain", () => {
    expect(normalizeHostname("investors.acme.com")).toEqual({
      ok: true,
      hostname: "investors.acme.com",
    });
  });

  it("accepts an apex", () => {
    expect(reasonOf("acme.com")).toBe("ok:acme.com");
  });

  it("collapses mixed case, a trailing dot and unicode onto one spelling", () => {
    const forms = ["investors.Bücher.de", "INVESTORS.BÜCHER.DE.", "  investors.bücher.de  "];
    const out = forms.map((f) => {
      const r = normalizeHostname(f);
      return r.ok ? r.hostname : `rejected:${r.reason}`;
    });
    expect(new Set(out).size).toBe(1);
    expect(out[0]).toBe("investors.xn--bcher-kva.de");
  });

  it("normalises the punycode form to itself", () => {
    expect(reasonOf("investors.xn--bcher-kva.de")).toBe("ok:investors.xn--bcher-kva.de");
  });

  it("refuses empty and whitespace-only input", () => {
    expect(reasonOf("")).toBe("empty");
    expect(reasonOf("   ")).toBe("empty");
    expect(reasonOf(".")).toBe("empty");
  });

  it("refuses wildcards", () => {
    expect(reasonOf("*.acme.com")).toBe("wildcard");
    expect(reasonOf("*")).toBe("wildcard");
  });

  it("refuses IPv4 literals in every spelling inet_aton accepts", () => {
    for (const form of ["127.0.0.1", "127.1", "0x7f.0.0.1", "2130706433", "１２７.0.0.1"]) {
      expect(reasonOf(form), form).toBe("ip_literal");
    }
  });

  it("refuses IPv6 literals bracketed and bare", () => {
    expect(reasonOf("[::1]")).toBe("ip_literal");
    expect(reasonOf("::1")).toBe("ip_literal");
    expect(reasonOf("[2001:db8::1]")).toBe("ip_literal");
  });

  it("refuses a numeric last label that is not a valid address either", () => {
    // IDNA itself refuses this one: a trailing numeric label is parsed as IPv4 and 12345
    // does not fit an octet, so it never reaches the ip_literal check.
    expect(reasonOf("acme.12345")).toBe("not_a_hostname");
    expect(reasonOf("acme.999.999.999.999")).toBe("not_a_hostname");
  });

  it("refuses a final label that does not begin with a letter, like the DB CHECK does", () => {
    /*
     * E2.1 M6. `custom_domain_hostname_format` in migration 0007 requires the final label to
     * start with `[a-z]`; this validator only refused a final label that was *entirely* numeric.
     * The gap was reachable — `q.123abc`, `test.1abc`, `foo.9bar` all passed here — and produced
     * a `23514` the route answered with a **500** where the honest answer is a 400. No IANA TLD
     * begins with a digit, and punycode begins with `x`.
     */
    expect(reasonOf("q.123abc")).toBe("not_a_hostname");
    expect(reasonOf("test.1abc")).toBe("not_a_hostname");
    expect(reasonOf("foo.9bar")).toBe("not_a_hostname");
    expect(reasonOf("acme.-com")).toBe("not_a_hostname");
    // The whole point of the CHECK regex is to accept punycode, which starts with a letter.
    expect(normalizeHostname("investors.xn--p1ai")).toEqual({
      ok: true,
      hostname: "investors.xn--p1ai",
    });
  });

  it("accepts nothing the DB CHECK would reject", () => {
    // The constraint, verbatim from `0007_custom_domains.sql`. A validator that is looser than
    // the constraint is a 500 waiting for a founder to type the right thing.
    const check = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
    const candidates = [
      "investors.acme.com",
      "q.123abc",
      "test.1abc",
      "foo.9bar",
      "a.b.c.example.org",
      "xn--80ak6aa92e.com",
      "investors.xn--p1ai",
      "ir-1.acme.co.uk",
      "9.acme.com",
    ];
    for (const candidate of candidates) {
      const result = normalizeHostname(candidate);
      if (result.ok) expect(check.test(result.hostname), candidate).toBe(true);
    }
  });

  it("refuses a host with a port or a URL around it", () => {
    expect(reasonOf("acme.com:443")).toBe("not_a_hostname");
    expect(reasonOf("https://acme.com")).toBe("not_a_hostname");
    expect(reasonOf("acme.com/investors")).toBe("not_a_hostname");
    expect(reasonOf("bob@acme.com")).toBe("not_a_hostname");
  });

  it("strips a trailing dot rather than refusing it", () => {
    expect(reasonOf("investors.acme.com.")).toBe("ok:investors.acme.com");
  });

  it("refuses an empty label", () => {
    expect(reasonOf("investors..acme.com")).toBe("not_a_hostname");
    expect(reasonOf("investors.acme.com..")).toBe("not_a_hostname");
  });

  it("refuses a label over 63 characters", () => {
    expect(reasonOf(`${"a".repeat(64)}.acme.com`)).toBe("too_long");
    expect(reasonOf(`${"a".repeat(63)}.acme.com`)).toBe(`ok:${"a".repeat(63)}.acme.com`);
  });

  it("refuses a name over 253 characters", () => {
    const label = "a".repeat(50);
    const long = `${[label, label, label, label, label].join(".")}.acme.com`;
    expect(long.length).toBeGreaterThan(253);
    expect(reasonOf(long)).toBe("too_long");
  });

  it("refuses characters that are not letters, digits or hyphens", () => {
    expect(reasonOf("under_score.acme.com")).toBe("not_a_hostname");
    expect(reasonOf("-lead.acme.com")).toBe("not_a_hostname");
    expect(reasonOf("trail-.acme.com")).toBe("not_a_hostname");
    expect(reasonOf("in vestors.acme.com")).toBe("not_a_hostname");
  });

  it("refuses reserved and special-use names", () => {
    for (const form of [
      "localhost",
      "portal.localhost",
      "portal.local",
      "portal.internal",
      "printer.home.arpa",
      "1.0.0.127.in-addr.arpa",
      "portal.test",
      "portal.invalid",
      "portal.example",
      "box.localdomain",
    ]) {
      expect(reasonOf(form), form).toBe("reserved");
    }
  });

  it("refuses a bare public suffix", () => {
    for (const form of ["com", "co.uk", "com.au", "io", "CO.UK"]) {
      expect(reasonOf(form), form).toBe("public_suffix");
    }
  });

  it("accepts a real name under a multi-label public suffix", () => {
    expect(reasonOf("investors.acme.co.uk")).toBe("ok:investors.acme.co.uk");
    expect(reasonOf("acme.co.uk")).toBe("ok:acme.co.uk");
  });

  it("refuses a single label that is not a known suffix", () => {
    expect(reasonOf("intranet")).toBe("not_a_hostname");
  });
});

describe("checkHostname", () => {
  it("accepts an unrelated hostname", () => {
    const result = checkHostname("investors.acme.com", CANONICAL);
    expect(result).toEqual({ ok: true, hostname: "investors.acme.com" });
  });

  it("refuses the canonical host itself", () => {
    expect(checkHostname("fundroom.app", CANONICAL)).toEqual({
      ok: false,
      reason: "canonical_host",
    });
    expect(checkHostname("FundRoom.App.", CANONICAL)).toEqual({
      ok: false,
      reason: "canonical_host",
    });
  });

  it("refuses any subdomain of the canonical host", () => {
    expect(checkHostname("acme.fundroom.app", CANONICAL)).toEqual({
      ok: false,
      reason: "canonical_subdomain",
    });
    expect(checkHostname("deep.acme.fundroom.app", CANONICAL)).toEqual({
      ok: false,
      reason: "canonical_subdomain",
    });
  });

  it("is not fooled by a suffix that merely ends with the canonical host", () => {
    expect(checkHostname("notfundroom.app", CANONICAL)).toEqual({
      ok: true,
      hostname: "notfundroom.app",
    });
  });

  it("tolerates a canonical host carrying a port or mixed case", () => {
    expect(checkHostname("acme.portal.test.com", "Portal.Test.com:8443")).toEqual({
      ok: false,
      reason: "canonical_subdomain",
    });
  });

  it("still applies the plain refusals first", () => {
    expect(checkHostname("*.fundroom.app", CANONICAL)).toEqual({
      ok: false,
      reason: "wildcard",
    });
  });
});
