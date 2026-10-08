import type { DnsAnswer, DnsRecordType, DnsResolverPort } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { dkimMatches, lookupTxt, recordsFor } from "./domains.js";

/*
 * The sending-domain resolver swap (E2.1 decision 2). E1.4 read `node:dns` through a mutable
 * module global; the lookup now goes through an injected `DnsResolverPort`, which is what these
 * tests exercise — above all the line between "nothing is published" (the verification stays
 * pending, the admin publishes and clicks again) and "we could not look" (it fails and records
 * why). Telling a founder their records are missing because a resolver was unreachable is the
 * failure this mapping exists to prevent.
 */
function resolverOf(answer: Partial<DnsAnswer>): DnsResolverPort {
  return {
    driver: "fake",
    resolve: (name: string, type: DnsRecordType) =>
      Promise.resolve({
        name,
        type,
        values: [],
        rcode: "ok",
        resolver: "1.1.1.1",
        chain: undefined,
        ...answer,
      }),
    healthCheck: () => Promise.resolve(),
  };
}

describe("lookupTxt", () => {
  it("returns the published strings", async () => {
    const dns = resolverOf({ values: ["v=dmarc1; p=none"] });
    await expect(lookupTxt(dns, "_dmarc.mail.acme.test")).resolves.toEqual(["v=dmarc1; p=none"]);
  });

  it("treats NODATA and NXDOMAIN alike as no records, not as an error", async () => {
    // E1.4's ENODATA (the name exists, no TXT) and ENOTFOUND (no such name) both meant
    // "nothing published yet"; the verification must stay pending in both cases.
    await expect(lookupTxt(resolverOf({ rcode: "ok" }), "a.test")).resolves.toEqual([]);
    await expect(lookupTxt(resolverOf({ rcode: "nxdomain" }), "a.test")).resolves.toEqual([]);
  });

  it("throws when the resolvers could not answer", async () => {
    for (const rcode of ["servfail", "refused", "other"] as const) {
      await expect(lookupTxt(resolverOf({ rcode }), "a.test")).rejects.toThrow(rcode);
    }
  });

  it("names the resolver in the failure, so the admin sees who did not answer", async () => {
    await expect(
      lookupTxt(resolverOf({ rcode: "servfail", resolver: "8.8.8.8" }), "a.test"),
    ).rejects.toThrow(/a\.test.*servfail.*8\.8\.8\.8/u);
  });

  it("asks for TXT", async () => {
    const asked: [string, DnsRecordType][] = [];
    const dns: DnsResolverPort = {
      driver: "fake",
      resolve: (name, type) => {
        asked.push([name, type]);
        return resolverOf({}).resolve(name, type);
      },
      healthCheck: () => Promise.resolve(),
    };
    await lookupTxt(dns, "sel._domainkey.mail.acme.test");
    expect(asked).toEqual([["sel._domainkey.mail.acme.test", "TXT"]]);
  });
});

describe("dkimMatches", () => {
  const expected = "v=DKIM1; k=rsa; p=MIIBIjANBgkqhk+iG9w0=";

  it("ignores quoting, whitespace and case, which is how a zone editor mangles a long TXT", () => {
    expect(dkimMatches('"v=DKIM1; k=rsa; " "p=MIIBIjANBgkqhk+iG9w0="', expected)).toBe(true);
    // The DoH adapter lower-cases TXT values; both sides are normalised the same way, so the
    // base64 still compares equal.
    expect(dkimMatches(expected.toLowerCase(), expected)).toBe(true);
  });

  it("refuses a record with a different or absent key", () => {
    expect(dkimMatches("v=DKIM1; k=rsa; p=AAAA", expected)).toBe(false);
    expect(dkimMatches("v=spf1 include:example.com ~all", expected)).toBe(false);
    expect(dkimMatches("", expected)).toBe(false);
  });
});

describe("recordsFor", () => {
  it("requires DKIM only; SPF and DMARC stay advisory", () => {
    const records = recordsFor({
      domain: "mail.acme.test",
      selector: "sh2026091abcd",
      publicKey: "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq\n-----END PUBLIC KEY-----\n",
    });
    expect(records.map((r) => [r.kind, r.name, r.required])).toEqual([
      ["dkim", "sh2026091abcd._domainkey.mail.acme.test", true],
      ["spf", "mail.acme.test", false],
      ["dmarc", "_dmarc.mail.acme.test", false],
    ]);
    expect(records[0]?.value).toBe("v=DKIM1; k=rsa; p=MIIBIjANBgkq");
  });
});
