import { describe, expect, it } from "vitest";
import { amzDate, signingKey, signRequest, uriEncode } from "./sigv4.js";

/*
 * AWS's published Signature Version 4 test vectors (aws-sig-v4-test-suite, and the signing-key
 * example in the IAM user guide). Credentials are AWS's documented example pair, not a secret.
 */
const CREDENTIALS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};
const NOW = new Date("2015-08-30T12:36:00Z");
const OPTS = { region: "us-east-1", service: "service", credentials: CREDENTIALS, now: NOW };

describe("sigv4", () => {
  it("derives the documented signing key", () => {
    expect(
      signingKey(
        "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        "20120215",
        "us-east-1",
        "iam",
      ).toString("hex"),
    ).toBe("f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d");
  });

  it("matches get-vanilla", () => {
    const signed = signRequest(
      { method: "GET", url: new URL("https://example.amazonaws.com/"), headers: {}, body: "" },
      OPTS,
    );
    expect(signed.canonicalRequest).toBe(
      [
        "GET",
        "/",
        "",
        "host:example.amazonaws.com",
        "x-amz-date:20150830T123600Z",
        "",
        "host;x-amz-date",
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      ].join("\n"),
    );
    expect(signed.stringToSign).toBe(
      [
        "AWS4-HMAC-SHA256",
        "20150830T123600Z",
        "20150830/us-east-1/service/aws4_request",
        "bb579772317eb040ac9ed261061d46c1f17a8133879d6129b6e1c25292927e63",
      ].join("\n"),
    );
    expect(signed.signature).toBe(
      "5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
    expect(signed.headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });

  it("matches get-vanilla-query-order-key-case (sorted query)", () => {
    const signed = signRequest(
      {
        method: "GET",
        url: new URL("https://example.amazonaws.com/?Param2=value2&Param1=value1"),
        headers: {},
        body: "",
      },
      OPTS,
    );
    expect(signed.signature).toBe(
      "b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500",
    );
  });

  it("signs the session token when there is one", () => {
    const signed = signRequest(
      { method: "GET", url: new URL("https://example.amazonaws.com/"), headers: {}, body: "" },
      { ...OPTS, credentials: { ...CREDENTIALS, sessionToken: "tok" } },
    );
    expect(signed.headers["x-amz-security-token"]).toBe("tok");
    expect(signed.authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token");
  });

  it("formats dates and encodes per RFC 3986", () => {
    expect(amzDate(new Date("2026-09-22T01:02:03.456Z"))).toBe("20260922T010203Z");
    expect(uriEncode("a b*!'()~-_.")).toBe("a%20b%2A%21%27%28%29~-_.");
  });
});
