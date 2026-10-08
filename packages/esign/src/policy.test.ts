import { ESignProviderError } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import { ESignError } from "./errors.js";
import {
  baseUrlHost,
  checkBaseUrl,
  checkCredentials,
  credentialHint,
  credentialHints,
  decodeEnvelopeCursor,
  encodeEnvelopeCursor,
  esignCallbackUrl,
  isOpen,
  isTerminal,
  looksLikePdf,
  nextEnvelopeStatus,
  nextSignerStatus,
  nextSyncAt,
  providerDetail,
  pseudonymousSigner,
  SYNC_BACKOFF_MS,
  SYNC_MAX_AGE_MS,
  secretsToReenter,
  syncDelayMs,
  syncWindowOver,
} from "./policy.js";
import type { AssessVerdict } from "./types.js";

const MIN = 60_000;

describe("status lattice", () => {
  it("terminal rows never move", () => {
    for (const t of ["completed", "declined", "voided", "expired"] as const) {
      for (const v of [
        "sent",
        "delivered",
        "completed",
        "declined",
        "voided",
        "expired",
      ] as const) {
        expect(nextEnvelopeStatus(t, v)).toBe(t);
      }
      expect(isTerminal(t)).toBe(true);
    }
  });

  it("a vendor terminal answer wins over any open row", () => {
    for (const cur of ["draft", "sent", "delivered", "error"] as const) {
      expect(nextEnvelopeStatus(cur, "completed")).toBe("completed");
      expect(nextEnvelopeStatus(cur, "declined")).toBe("declined");
      expect(nextEnvelopeStatus(cur, "voided")).toBe("voided");
      expect(nextEnvelopeStatus(cur, "expired")).toBe("expired");
    }
  });

  it("open statuses only move forward (a stale 'sent' after 'delivered' is ignored)", () => {
    expect(nextEnvelopeStatus("sent", "delivered")).toBe("delivered");
    expect(nextEnvelopeStatus("delivered", "sent")).toBe("delivered");
    expect(nextEnvelopeStatus("sent", "sent")).toBe("sent");
    expect(nextEnvelopeStatus("draft", "sent")).toBe("sent");
  });

  it("an error row recovers to what the vendor says", () => {
    expect(nextEnvelopeStatus("error", "sent")).toBe("sent");
    expect(nextEnvelopeStatus("error", "delivered")).toBe("delivered");
  });

  it("open = sent|delivered only", () => {
    expect(isOpen("sent")).toBe(true);
    expect(isOpen("delivered")).toBe(true);
    for (const s of ["draft", "error", "completed", "voided"] as const)
      expect(isOpen(s)).toBe(false);
  });

  it("signer status is monotonic and finished stays finished", () => {
    expect(nextSignerStatus(null, "pending")).toBe("pending");
    expect(nextSignerStatus("pending", "viewed")).toBe("viewed");
    expect(nextSignerStatus("viewed", "pending")).toBe("viewed");
    expect(nextSignerStatus("viewed", "signed")).toBe("signed");
    expect(nextSignerStatus("signed", "declined")).toBe("signed");
    expect(nextSignerStatus("declined", "signed")).toBe("declined");
    expect(nextSignerStatus("viewed", undefined)).toBe("viewed");
  });
});

describe("sync backoff", () => {
  it("is 5m → 15m → 1h → 6h → 24h, then stays at 24h", () => {
    expect(SYNC_BACKOFF_MS).toEqual([5 * MIN, 15 * MIN, 60 * MIN, 360 * MIN, 1440 * MIN]);
    expect([0, 1, 2, 3, 4, 5, 50].map(syncDelayMs)).toEqual([
      5 * MIN,
      15 * MIN,
      60 * MIN,
      360 * MIN,
      1440 * MIN,
      1440 * MIN,
      1440 * MIN,
    ]);
    expect(syncDelayMs(-3)).toBe(5 * MIN);
    const t = new Date("2026-09-25T00:00:00Z");
    expect(nextSyncAt(t, 2).toISOString()).toBe("2026-09-25T01:00:00.000Z");
  });

  it("the sync window closes 60 days after sending (or creation when never sent)", () => {
    const sent = new Date("2026-01-01T00:00:00Z");
    expect(SYNC_MAX_AGE_MS).toBe(60 * 24 * 60 * MIN);
    expect(syncWindowOver(sent, sent, new Date(sent.getTime() + SYNC_MAX_AGE_MS - 1))).toBe(false);
    expect(syncWindowOver(sent, sent, new Date(sent.getTime() + SYNC_MAX_AGE_MS))).toBe(true);
    expect(syncWindowOver(null, sent, new Date(sent.getTime() + SYNC_MAX_AGE_MS))).toBe(true);
  });
});

describe("credential hints", () => {
  it("masks secrets, showing the last four only for long values", () => {
    expect(credentialHint({ kind: "secret" }, "api_1234567890abcd")).toBe("••••abcd");
    expect(credentialHint({ kind: "secret" }, "short-secret")).toBe("••••");
    expect(credentialHint({ kind: "secret" }, "  api_1234567890abcd  ")).toBe("••••abcd");
  });

  it("masks PEM keys by their base64 body, never the armour", () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAxyz\nabcdEFGH1234wxyz\n-----END RSA PRIVATE KEY-----\n`;
    expect(credentialHint({ kind: "pem" }, pem)).toBe("PEM ••••wxyz");
    expect(credentialHint({ kind: "pem" }, "-----BEGIN X-----\nab\n-----END X-----")).toBe(
      "PEM ••••",
    );
  });

  it("shows text and select values (not secret), capped at 64", () => {
    expect(credentialHint({ kind: "select" }, "demo")).toBe("demo");
    expect(credentialHint({ kind: "text" }, "x".repeat(80))).toBe(`${"x".repeat(61)}…`);
  });

  it("builds hints only for fields that have a value", () => {
    const fields = [
      { key: "apiToken", label: "API token", kind: "secret", required: true },
      {
        key: "env",
        label: "Env",
        kind: "select",
        options: ["demo", "production"],
        required: false,
      },
      { key: "accountId", label: "Account", kind: "text", required: false },
    ] as const;
    expect(credentialHints(fields, { apiToken: "tok_abcdefghijklmnop", env: "demo" })).toEqual({
      apiToken: "••••mnop",
      env: "demo",
    });
  });
});

describe("checkCredentials", () => {
  const fields = [
    { key: "apiToken", label: "API token", kind: "secret", required: true },
    { key: "env", label: "Env", kind: "select", options: ["demo", "production"], required: true },
    { key: "accountId", label: "Account", kind: "text", required: false },
  ] as const;

  it("accepts a complete form and trims values", () => {
    expect(checkCredentials(fields, { apiToken: " t ", env: "demo" })).toEqual({
      apiToken: "t",
      env: "demo",
    });
  });

  it("refuses unknown keys, missing required fields and bad options", () => {
    const reason = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(ESignError);
        return (e as ESignError).details["reason"];
      }
      return "none";
    };
    expect(reason(() => checkCredentials(fields, { apiToken: "t", env: "demo", x: "1" }))).toBe(
      "unknown_field",
    );
    expect(reason(() => checkCredentials(fields, { env: "demo" }))).toBe("missing_field");
    expect(reason(() => checkCredentials(fields, { apiToken: "t", env: "staging" }))).toBe(
      "invalid_option",
    );
    expect(
      reason(() => checkCredentials(fields, { apiToken: "x".repeat(20_000), env: "demo" })),
    ).toBe("field_too_long");
  });

  it("A5: clears an optional stored secret; refuses clearing a required one, unknown keys and clear+value", () => {
    const withOpt = [
      ...fields,
      { key: "hmac", label: "HMAC", kind: "secret", required: false },
    ] as const;
    const stored = { apiToken: "old", env: "demo", hmac: "h1" };
    expect(checkCredentials(withOpt, { env: "demo" }, stored)).toEqual({
      apiToken: "old",
      env: "demo",
      hmac: "h1",
    });
    expect(checkCredentials(withOpt, { env: "demo" }, stored, ["hmac"])).toEqual({
      apiToken: "old",
      env: "demo",
    });
    const reason = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as ESignError).details["reason"];
      }
      return "none";
    };
    expect(reason(() => checkCredentials(withOpt, { env: "demo" }, stored, ["apiToken"]))).toBe(
      "cannot_clear_required",
    );
    expect(
      reason(() => checkCredentials(withOpt, { env: "demo", hmac: "new" }, stored, ["hmac"])),
    ).toBe("clear_conflict");
    expect(reason(() => checkCredentials(withOpt, { env: "demo" }, stored, ["zzz"]))).toBe(
      "unknown_field",
    );
  });

  it("A4: secretsToReenter lists stored secrets left blank and not cleared", () => {
    const withOpt = [
      ...fields,
      { key: "hmac", label: "HMAC", kind: "secret", required: false },
      { key: "pem", label: "PEM", kind: "pem", required: false },
    ] as const;
    const stored = { apiToken: "old", env: "demo", hmac: "h1", accountId: "a" };
    expect(secretsToReenter(withOpt, { env: "demo" }, stored)).toEqual(["apiToken", "hmac"]);
    expect(secretsToReenter(withOpt, { apiToken: "new" }, stored, ["hmac"])).toEqual([]);
    expect(secretsToReenter(withOpt, {}, undefined)).toEqual([]);
  });

  it("keeps a stored secret when the form leaves it blank (same driver), never a text field", () => {
    expect(
      checkCredentials(
        fields,
        { apiToken: "", env: "production" },
        { apiToken: "old", env: "demo", accountId: "acc" },
      ),
    ).toEqual({ apiToken: "old", env: "production" });
  });
});

describe("base URL rules", () => {
  const assess =
    (exempt: boolean | "blocked") =>
    (url: string | URL): AssessVerdict =>
      exempt === "blocked"
        ? { ok: false, code: "blocked_address", message: "private address 10.0.0.1" }
        : { ok: true, url: new URL(url), exempt };
  const reasonOf = (raw: string, a: (u: string | URL) => AssessVerdict) => {
    try {
      checkBaseUrl(raw, a);
      return "ok";
    } catch (e) {
      return (e as ESignError).details["reason"];
    }
  };

  it("normalises an https origin (with or without a path prefix)", () => {
    expect(checkBaseUrl("https://sign.example.com/", assess(false))).toBe(
      "https://sign.example.com",
    );
    expect(checkBaseUrl(" https://sign.example.com/docuseal/ ", assess(false))).toBe(
      "https://sign.example.com/docuseal",
    );
    expect(baseUrlHost("https://sign.example.com:8443/x")).toBe("sign.example.com:8443");
  });

  it("requires https unless the host is allow-listed (exempt)", () => {
    expect(reasonOf("http://sign.example.com", assess(false))).toBe("https_required");
    expect(reasonOf("http://documenso.lan:3000", assess(true))).toBe("ok");
    expect(reasonOf("ftp://documenso.lan", assess(true))).toBe("https_required");
  });

  it("refuses what the guard refuses, without echoing its message", () => {
    let err: ESignError | undefined;
    try {
      checkBaseUrl("https://10.0.0.1", assess("blocked"));
    } catch (e) {
      err = e as ESignError;
    }
    expect(err?.details).toMatchObject({ reason: "base_url_not_allowed", rule: "blocked_address" });
    expect(err?.message).not.toContain("10.0.0.1");
  });

  it("refuses credentials, query strings, fragments and garbage", () => {
    expect(reasonOf("https://user:pw@sign.example.com", assess(false))).toBe("invalid_base_url");
    expect(reasonOf("https://sign.example.com/?a=1", assess(false))).toBe("invalid_base_url");
    expect(reasonOf("https://sign.example.com/#x", assess(false))).toBe("invalid_base_url");
    expect(reasonOf("not a url", assess(false))).toBe("invalid_base_url");
  });
});

describe("misc", () => {
  it("builds the callback URL on the base origin", () => {
    expect(
      esignCallbackUrl(
        new URL("https://app.example.com/some/path"),
        "0199a000-0000-7000-8000-000000000001",
      ),
    ).toBe("https://app.example.com/webhooks/esign/0199a000-0000-7000-8000-000000000001");
  });

  it("round-trips a keyset cursor and refuses tampering", () => {
    const c = {
      createdAt: new Date("2026-09-25T12:00:00.123Z"),
      id: "0199a000-0000-7000-8000-000000000001",
    };
    const raw = encodeEnvelopeCursor(c);
    expect(decodeEnvelopeCursor(raw)).toEqual(c);
    expect(decodeEnvelopeCursor(`${raw}x`)).toBeUndefined();
    expect(decodeEnvelopeCursor("")).toBeUndefined();
    expect(
      decodeEnvelopeCursor(Buffer.from("2026-09-25|nope").toString("base64url")),
    ).toBeUndefined();
  });

  it("checks the %PDF- magic strictly", () => {
    expect(looksLikePdf(new TextEncoder().encode("%PDF-1.7\n..."))).toBe(true);
    expect(looksLikePdf(new TextEncoder().encode(" %PDF-1.7"))).toBe(false);
    expect(looksLikePdf(new TextEncoder().encode("<html>"))).toBe(false);
    expect(looksLikePdf(new Uint8Array())).toBe(false);
  });

  it("describes a provider error without a query string", () => {
    const d = providerDetail(
      new ESignProviderError("GET https://x/api?token=secret failed", "unavailable", true, 503),
    );
    expect(d).toContain("unavailable (503)");
    expect(d).not.toContain("secret");
  });

  it("pseudonymises on the row id, never the old value", () => {
    expect(pseudonymousSigner("0199a000-0000-7000-8000-000000000001")).toEqual({
      name: "Erased signer",
      email: "erased+0199a000-0000-7000-8000-000000000001@erased.invalid",
    });
  });
});
