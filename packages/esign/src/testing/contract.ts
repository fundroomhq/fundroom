import {
  ESIGN_DRIVERS,
  type ESignEnvelopeInput,
  type ESignPort,
  ESignProviderError,
  type ESignVendorMeta,
} from "@fundroom/ports";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tinyPdf } from "./memory-adapter.js";
import type { FakeVendorControl } from "./types.js";

export type { FakeVendorControl } from "./types.js";

/**
 * The ESignPort contract suite (E3.5 contract §1). Every adapter runs it against its own fake vendor
 * (scripted fetch or a real local HTTP server); the in-memory adapter runs it too.
 *
 * `setup(options)` must build a fresh port + fake vendor per test. When `options.credentials` is
 * `"invalid"`, the port must be bound to credentials the fake vendor rejects (used by the
 * `verifyCredentials` / unauthorized cases); otherwise to valid ones.
 *
 * Vendor-specific latitude the suite allows, deliberately:
 * - right after creation the envelope may be `sent` or `delivered`;
 * - after `void()` (or a vendor-side void) `status()` either answers `voided` or throws
 *   `ESignProviderError` with code `not_found` (Documenso hard-deletes a pending document on cancel,
 *   so a voided envelope simply stops existing there);
 * - `downloadSigned` before completion must reject with an `ESignProviderError` (any code).
 */
export interface ESignContractSetupOptions {
  readonly credentials?: "valid" | "invalid";
}

export interface ESignContractOptions {
  /** Which envelope kinds to exercise; pass the adapter's `meta.supports`. Default: everything. */
  readonly supports?: Partial<ESignVendorMeta["supports"]>;
  /** A template reference the fake vendor knows (Documenso needs a numeric id). Default "contract-template". */
  readonly templateRef?: string;
  /** The role name of the template's single signer. Default "Signer". */
  readonly templateRole?: string;
}

type Setup = (options?: ESignContractSetupOptions) => Promise<{
  port: ESignPort;
  vendor: FakeVendorControl;
  cleanup(): Promise<void>;
}>;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

function isPdf(bytes: Uint8Array): boolean {
  return PDF_MAGIC.every((b, i) => bytes[i] === b);
}

let seq = 0;
function externalId(): string {
  seq += 1;
  // uuid-shaped, like core.esign_envelope.id
  const tail = `${Date.now().toString(16)}${seq.toString(16)}`.padStart(12, "0").slice(-12);
  return `0190f0e0-0000-7000-8000-${tail}`;
}

export function pdfEnvelope(overrides: Partial<ESignEnvelopeInput> = {}): ESignEnvelopeInput {
  return {
    externalId: externalId(),
    title: "Contract suite NDA",
    message: "Please sign",
    document: {
      kind: "pdf",
      filename: "nda.pdf",
      bytes: tinyPdf("Contract suite NDA"),
      fields: [
        { signerKey: "s1", kind: "signature", page: 1, x: 0.1, y: 0.8, w: 0.3, h: 0.06 },
        { signerKey: "s1", kind: "date", page: 1, x: 0.5, y: 0.8, w: 0.2, h: 0.04 },
        { signerKey: "s1", kind: "name", page: 1, x: 0.1, y: 0.9, w: 0.3, h: 0.04 },
      ],
    },
    signers: [{ signerKey: "s1", name: "Ada Lovelace", email: "ada@example.com", order: 1 }],
    redirectUrl: "https://portal.example.com/esign/done",
    embedded: true,
    ...overrides,
  };
}

export function templateEnvelope(
  templateRef: string,
  role: string,
  overrides: Partial<ESignEnvelopeInput> = {},
): ESignEnvelopeInput {
  return {
    externalId: externalId(),
    title: "Contract suite subscription agreement",
    document: {
      kind: "template",
      templateRef,
      prefill: { investor_name: "Ada Lovelace", amount: "$25,000" },
    },
    signers: [{ signerKey: "s1", name: "Ada Lovelace", email: "ada@example.com", role, order: 1 }],
    embedded: false,
    ...overrides,
  };
}

async function expectProviderError(
  promise: Promise<unknown>,
  code?: ESignProviderError["code"],
): Promise<ESignProviderError> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught, "expected an ESignProviderError").toBeInstanceOf(ESignProviderError);
  const e = caught as ESignProviderError;
  if (code !== undefined) expect(e.code).toBe(code);
  return e;
}

async function expectVoidedOrGone(port: ESignPort, providerRef: string): Promise<void> {
  try {
    const state = await port.status(providerRef);
    expect(state.status).toBe("voided");
  } catch (err) {
    expect(err).toBeInstanceOf(ESignProviderError);
    expect((err as ESignProviderError).code).toBe("not_found");
  }
}

export function describeESignPortContract(
  name: string,
  setup: Setup,
  options: ESignContractOptions = {},
): void {
  const supports = {
    templates: true,
    pdf: true,
    embeddedSigning: true,
    void: true,
    ...options.supports,
  };
  const templateRef = options.templateRef ?? "contract-template";
  const templateRole = options.templateRole ?? "Signer";
  /** Prefer a pdf envelope for the lifecycle cases; fall back to a template one. */
  const anyEnvelope = (overrides: Partial<ESignEnvelopeInput> = {}): ESignEnvelopeInput =>
    supports.pdf ? pdfEnvelope(overrides) : templateEnvelope(templateRef, templateRole, overrides);

  describe(`ESignPort contract: ${name}`, () => {
    let ctx: Awaited<ReturnType<Setup>>;

    beforeEach(async () => {
      ctx = await setup({ credentials: "valid" });
    });
    afterEach(async () => {
      await ctx.cleanup();
    });

    const create = async (
      input: ESignEnvelopeInput = anyEnvelope(),
    ): Promise<{ providerRef: string; input: ESignEnvelopeInput }> => {
      const { providerRef } = await ctx.port.createEnvelope(input);
      return { providerRef, input };
    };

    it("names a known driver", () => {
      expect(ESIGN_DRIVERS).toContain(ctx.port.driver);
    });

    describe("verifyCredentials", () => {
      it("answers ok for valid credentials", async () => {
        const result = await ctx.port.verifyCredentials();
        expect(result.ok).toBe(true);
      });

      it("answers unauthorized (without throwing) for rejected credentials", async () => {
        const bad = await setup({ credentials: "invalid" });
        try {
          const result = await bad.port.verifyCredentials();
          expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
          await expectProviderError(bad.port.status("1"), "unauthorized");
        } finally {
          await bad.cleanup();
        }
      });
    });

    describe("createEnvelope", () => {
      it.runIf(supports.pdf)("creates a pdf envelope and sends our externalId", async () => {
        const { providerRef, input } = await create(pdfEnvelope());
        expect(typeof providerRef).toBe("string");
        expect(providerRef.length).toBeGreaterThan(0);
        const received = ctx.vendor.created().find((c) => c.providerRef === providerRef);
        expect(received, "vendor saw the envelope").toBeDefined();
        expect(JSON.stringify(received?.input)).toContain(input.externalId);
      });

      it.runIf(supports.templates)(
        "creates a template envelope with prefill + role and sends our externalId",
        async () => {
          const input = templateEnvelope(templateRef, templateRole);
          const { providerRef } = await create(input);
          const received = ctx.vendor.created().find((c) => c.providerRef === providerRef);
          expect(received).toBeDefined();
          const json = JSON.stringify(received?.input);
          expect(json).toContain(input.externalId);
          expect(json).toContain("Ada Lovelace");
          expect(json).toContain("$25,000");
        },
      );

      it("gives distinct envelopes distinct providerRefs", async () => {
        const a = await create();
        const b = await create();
        expect(a.providerRef).not.toBe(b.providerRef);
      });
    });

    describe("status", () => {
      it("starts sent (or delivered) with the signer pending/viewed", async () => {
        const { providerRef } = await create();
        const state = await ctx.port.status(providerRef);
        expect(["sent", "delivered"]).toContain(state.status);
        const s1 = state.signers.find((s) => s.signerKey === "s1");
        expect(s1).toBeDefined();
        expect(["pending", "viewed"]).toContain(s1?.status);
        expect(state.completedAt).toBeUndefined();
      });

      it("moves sent → completed with the signer signed", async () => {
        const { providerRef } = await create();
        ctx.vendor.complete(providerRef);
        const state = await ctx.port.status(providerRef);
        expect(state.status).toBe("completed");
        expect(state.signers.find((s) => s.signerKey === "s1")?.status).toBe("signed");
        expect(state.completedAt).toBeInstanceOf(Date);
      });

      it("moves sent → declined with the signer declined", async () => {
        const { providerRef } = await create();
        ctx.vendor.decline(providerRef);
        const state = await ctx.port.status(providerRef);
        expect(state.status).toBe("declined");
        expect(state.signers.find((s) => s.signerKey === "s1")?.status).toBe("declined");
      });

      it("reports a vendor-side void as voided (or gone)", async () => {
        const { providerRef } = await create();
        ctx.vendor.voidFromVendor(providerRef);
        await expectVoidedOrGone(ctx.port, providerRef);
      });
    });

    describe("signingUrl", () => {
      it.runIf(supports.embeddedSigning)(
        "returns an absolute URL for an embedded envelope's signer",
        async () => {
          const { providerRef } = await create(anyEnvelope({ embedded: true }));
          const url = await ctx.port.signingUrl(
            providerRef,
            "s1",
            "https://portal.example.com/back",
          );
          expect(url).toBeDefined();
          expect(() => new URL(url as string)).not.toThrow();
        },
      );
    });

    describe("downloadSigned", () => {
      it("returns the signed PDF once completed", async () => {
        const { providerRef } = await create();
        ctx.vendor.complete(providerRef);
        const artifacts = await ctx.port.downloadSigned(providerRef, { maxBytes: 5 * 1024 * 1024 });
        expect(isPdf(artifacts.document)).toBe(true);
        if (artifacts.certificate !== undefined) expect(isPdf(artifacts.certificate)).toBe(true);
      });

      it("refuses an artifact over maxBytes with too_large", async () => {
        const { providerRef } = await create();
        ctx.vendor.complete(providerRef);
        await expectProviderError(
          ctx.port.downloadSigned(providerRef, { maxBytes: 16 }),
          "too_large",
        );
      });

      it("rejects before completion", async () => {
        const { providerRef } = await create();
        await expectProviderError(ctx.port.downloadSigned(providerRef, { maxBytes: 5_000_000 }));
      });
    });

    describe.runIf(supports.void)("void", () => {
      it("voids an open envelope", async () => {
        const { providerRef } = await create();
        await ctx.port.void(providerRef, "contract suite");
        await expectVoidedOrGone(ctx.port, providerRef);
      });
    });

    describe("parseCallback", () => {
      it.each(["completed", "declined", "viewed"] as const)(
        "accepts a genuine %s callback and names the envelope",
        async (event) => {
          const { providerRef, input } = await create();
          if (event === "completed") ctx.vendor.complete(providerRef);
          if (event === "declined") ctx.vendor.decline(providerRef);
          const parsed = await ctx.port.parseCallback(ctx.vendor.callback(providerRef, event));
          expect(parsed).toBeDefined();
          expect(typeof parsed?.event).toBe("string");
          expect(
            parsed?.providerRef === providerRef || parsed?.externalId === input.externalId,
          ).toBe(true);
        },
      );

      it("rejects a forged callback", async () => {
        const { providerRef } = await create();
        await expect(ctx.port.parseCallback(ctx.vendor.forgedCallback(providerRef))).resolves.toBe(
          undefined,
        );
      });

      it("rejects a truncated body", async () => {
        const { providerRef } = await create();
        const genuine = ctx.vendor.callback(providerRef, "completed");
        const body = genuine.body.slice(0, Math.max(1, Math.floor(genuine.body.byteLength / 2)));
        await expect(ctx.port.parseCallback({ headers: genuine.headers, body })).resolves.toBe(
          undefined,
        );
      });

      it("rejects an empty body", async () => {
        const { providerRef } = await create();
        const genuine = ctx.vendor.callback(providerRef, "completed");
        await expect(
          ctx.port.parseCallback({ headers: genuine.headers, body: new Uint8Array() }),
        ).resolves.toBe(undefined);
      });

      it("rejects a request without the authentication headers", async () => {
        const { providerRef } = await create();
        const genuine = ctx.vendor.callback(providerRef, "completed");
        await expect(
          ctx.port.parseCallback({
            headers: new Headers({ "content-type": "application/json" }),
            body: genuine.body,
          }),
        ).resolves.toBe(undefined);
      });

      it("never throws on garbage", async () => {
        const { providerRef } = await create();
        const genuine = ctx.vendor.callback(providerRef, "completed");
        const garbage = [
          new Uint8Array([0xff, 0xfe, 0x00, 0x7b, 0x22]),
          new TextEncoder().encode("null"),
          new TextEncoder().encode("[]"),
          new TextEncoder().encode('{"event":'),
          new TextEncoder().encode(`"${"x".repeat(4096)}"`),
        ];
        for (const body of garbage) {
          await expect(ctx.port.parseCallback({ headers: genuine.headers, body })).resolves.toBe(
            undefined,
          );
        }
        const weirdHeaders = new Headers();
        genuine.headers.forEach((value, key) => {
          weirdHeaders.set(key, `${value}é`.slice(0, 3));
        });
        await expect(
          ctx.port.parseCallback({ headers: weirdHeaders, body: genuine.body }),
        ).resolves.toBe(undefined);
      });
    });
  });
}
