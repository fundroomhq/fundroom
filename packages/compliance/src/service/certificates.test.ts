import type { TenantContext, Tx } from "@fundroom/db";
import { describe, expect, it, vi } from "vitest";
import {
  type CertificateIssuer,
  type IssueCertificateInput,
  issueCertificate,
} from "./certificates.js";

const NOW = new Date("2026-09-14T10:30:00.000Z");
const ctx: TenantContext = {
  workspaceId: "01920000-0000-7000-8000-00000000000a",
  actorKind: "system",
};

/**
 * A transaction that throws on any property access. With no issuer wired, nothing may touch it —
 * that is the whole claim of "acceptance behaves exactly as it does today".
 */
const forbiddenTx = new Proxy(
  {},
  {
    get() {
      throw new Error("the transaction must not be touched when no issuer is wired");
    },
  },
) as Tx;

const input: IssueCertificateInput = {
  attestationId: "01920000-0000-7000-8000-0000000000e1",
  membershipId: "01920000-0000-7000-8000-0000000000a1",
  documentId: "01920000-0000-7000-8000-0000000000d0",
  slug: "nda",
  title: "Mutual NDA",
  versionNo: 2,
  stamp: "nda:v2",
  bodySha256: "ab".repeat(32),
  acceptedAt: NOW,
  acceptanceSeq: 41,
  acceptanceHash: "cd".repeat(32),
};

describe("issueCertificate", () => {
  it("does nothing at all when no issuer is wired, so pre-E2.3 acceptance is unchanged", async () => {
    await expect(issueCertificate(undefined, ctx, forbiddenTx, input)).resolves.toBeUndefined();
  });

  it("returns the reference and digest the issuer produced when one is wired", async () => {
    const issue = vi.fn(async () => ({ reference: "cert/2026/abc", sha256: "ef".repeat(32) }));
    const issuer = { issue, fetch: vi.fn() } as unknown as CertificateIssuer;
    const tx = {} as Tx;
    await expect(issueCertificate(issuer, ctx, tx, input)).resolves.toEqual({
      reference: "cert/2026/abc",
      sha256: "ef".repeat(32),
    });
    expect(issue).toHaveBeenCalledWith(ctx, tx, input);
  });

  it("passes the acceptance audit anchor through, which is what binds the certificate to the chain", async () => {
    // Typed with the port's own signature rather than as a bare `async () => …`: the arguments
    // are what this test is about, and an argument-less mock makes `calls[0]` an empty tuple
    // that `[2]` cannot index.
    const issue = vi.fn<CertificateIssuer["issue"]>(async () => ({ reference: "r", sha256: "s" }));
    const issuer = { issue, fetch: vi.fn() } as unknown as CertificateIssuer;
    await issueCertificate(issuer, ctx, {} as Tx, input);
    const seen = issue.mock.calls[0]?.[2] as IssueCertificateInput;
    expect(seen.acceptanceSeq).toBe(41);
    expect(seen.acceptanceHash).toBe("cd".repeat(32));
    expect(seen.bodySha256).toBe("ab".repeat(32));
  });

  it("lets a failing issuer throw, so an acceptance never claims a certificate nobody stored", async () => {
    const issuer = {
      issue: async () => {
        throw new Error("storage down");
      },
      fetch: vi.fn(),
    } as unknown as CertificateIssuer;
    await expect(issueCertificate(issuer, ctx, {} as Tx, input)).rejects.toThrow("storage down");
  });
});
