import {
  AccreditationProviderError,
  type AccreditationVendorPort,
  type AccreditationVendorStartInput,
} from "@fundroom/ports";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The AccreditationVendorPort contract suite (E3.7 contract §2). Every vendor adapter runs it
 * against its own fake vendor (scripted fetch AND a real local HTTP server); the in-memory adapter
 * runs it too.
 *
 * `setup(options)` builds a fresh port + fake-vendor control per test:
 * - `credentials: "invalid"` → the port is bound to credentials the fake vendor rejects;
 * - `callbackSecret: false` → the port is bound WITHOUT its webhook secret/signing key (the fake
 *   still signs callbacks with one), so every callback must be refused.
 * `secrets` lists every credential the port was given — no error message may contain one.
 *
 * Vendor latitude the suite allows, deliberately:
 * - right after `start()` a check may answer `in_progress`, `needs_investor_action` or
 *   `under_review` — never a decision;
 * - `check()` may upgrade the ref (`providerRef` in its answer, VerifyInvestor `inv:` → `vr:`);
 *   the suite continues with the upgraded ref and expects callbacks to name it;
 * - `expiresAt` may be rounded by the vendor to a calendar date (within 36 h of what was set).
 */
export interface AccreditationContractSetupOptions {
  readonly credentials: "valid" | "invalid";
  /** Default true. */
  readonly callbackSecret?: boolean;
}

/** What each adapter's fake vendor must expose to the suite. */
export interface AccreditationFakeVendorControl {
  /** The investor completes the vendor flow and the vendor accredits them. */
  accredit(providerRef: string, options?: { readonly expiresAt?: Date }): void;
  /** The investor completes the vendor flow and the vendor decides "not accredited". */
  reject(providerRef: string): void;
  /** The attempt is canceled / withdrawn / lapses at the vendor. */
  cancel(providerRef: string): void;
  /** The vendor reports a status value the adapter has never seen. */
  unknownStatus(providerRef: string, raw: string): void;
  /** The next vendor API call fails with HTTP 429 (`rate_limited`) or 500 (`unavailable`). */
  failNext(kind: "rate_limited" | "unavailable"): void;
  /** An authentic callback naming these refs, signed with the connection's secret, dated now. */
  callback(refs: readonly string[]): { headers: Headers; rawBody: Uint8Array };
  /** The same callback signed with a wrong secret. */
  forgedCallback(refs: readonly string[]): { headers: Headers; rawBody: Uint8Array };
}

export interface AccreditationContractOptions {
  /** True when the vendor signs a timestamp (stale callbacks must be refused). */
  readonly callbackTimestamp: boolean;
  /** Default true. */
  readonly supportsEntities?: boolean;
}

export type AccreditationContractSetup = (options: AccreditationContractSetupOptions) => Promise<{
  port: AccreditationVendorPort;
  vendor: AccreditationFakeVendorControl;
  secrets: readonly string[];
  cleanup(): Promise<void>;
}>;

let seq = 0;
export function contractStartInput(
  overrides: Partial<AccreditationVendorStartInput> = {},
): AccreditationVendorStartInput {
  seq += 1;
  const tail = `${Date.now().toString(16)}${seq.toString(16)}`.padStart(12, "0").slice(-12);
  return {
    verificationId: `0190f0e0-0000-7000-8000-${tail}`,
    subject: "individual",
    email: `investor${seq}@example.com`,
    firstName: "Ada",
    lastName: "Lovelace",
    legalName: "Ada Lovelace",
    portalName: "Contract Suite Fund",
    ...overrides,
  };
}

const PENDING = ["in_progress", "needs_investor_action", "under_review"];

function isPdf(bytes: Uint8Array): boolean {
  return [0x25, 0x50, 0x44, 0x46].every((b, i) => bytes[i] === b);
}

async function caught(promise: Promise<unknown>): Promise<AccreditationProviderError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(AccreditationProviderError);
    return err as AccreditationProviderError;
  }
  throw new Error("expected an AccreditationProviderError, got a result");
}

function expectNoSecret(err: Error, secrets: readonly string[]): void {
  const text = `${err.message}\n${JSON.stringify(err)}`;
  for (const s of secrets) if (s.length >= 4) expect(text).not.toContain(s);
}

export function describeAccreditationPortContract(
  name: string,
  setup: AccreditationContractSetup,
  options: AccreditationContractOptions,
): void {
  describe(`AccreditationVendorPort contract: ${name}`, () => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
      for (const c of cleanups.splice(0)) await c();
    });
    const make = async (o: AccreditationContractSetupOptions) => {
      const env = await setup(o);
      cleanups.push(() => env.cleanup());
      return env;
    };
    const started = (
      env: Awaited<ReturnType<AccreditationContractSetup>>,
      input?: Partial<AccreditationVendorStartInput>,
    ) => env.port.start(contractStartInput(input));
    /** The ref a decision is visible under (after a possible `inv:` → `vr:` style upgrade). */
    const decidedRef = async (port: AccreditationVendorPort, ref: string): Promise<string> =>
      (await port.check({ providerRef: ref })).providerRef ?? ref;

    describe("verifyCredentials", () => {
      it("resolves for valid credentials", async () => {
        const { port } = await make({ credentials: "valid" });
        await expect(port.verifyCredentials()).resolves.toBeUndefined();
      });

      it("rejects invalid credentials as unauthorized, non-retryable, without echoing them", async () => {
        const { port, secrets } = await make({ credentials: "invalid" });
        const err = await caught(port.verifyCredentials());
        expect(err.code).toBe("unauthorized");
        expect(err.retryable).toBe(false);
        expectNoSecret(err, secrets);
        const startErr = await caught(port.start(contractStartInput()));
        expect(startErr.code).toBe("unauthorized");
        expectNoSecret(startErr, secrets);
      });
    });

    describe("start + check", () => {
      it("returns a ref and a handoff, and never a decision at start", async () => {
        const env = await make({ credentials: "valid" });
        const result = await started(env);
        expect(result.providerRef.length).toBeGreaterThan(0);
        expect(result.providerRef.length).toBeLessThanOrEqual(200);
        expect(["invite_sent", "redirect", "widget"]).toContain(result.handoff.kind);
        if (result.handoff.kind === "redirect") expect(result.handoff.url).toMatch(/^https:\/\//u);
        const check = await env.port.check({ providerRef: result.providerRef });
        expect(PENDING).toContain(check.status);
        expect(check.vendorStatus.length).toBeLessThanOrEqual(100);
      });

      it.runIf(options.supportsEntities !== false)("starts an entity verification", async () => {
        const env = await make({ credentials: "valid" });
        const result = await started(env, { subject: "entity", legalName: "Acme Holdings LLC" });
        expect(result.providerRef.length).toBeGreaterThan(0);
        const check = await env.port.check({ providerRef: result.providerRef });
        expect(PENDING).toContain(check.status);
      });

      it("maps an accreditation with its expiry and decision time", async () => {
        const env = await make({ credentials: "valid" });
        const { providerRef } = await started(env);
        const expiresAt = new Date(Date.now() + 200 * 24 * 3600 * 1000);
        env.vendor.accredit(providerRef, { expiresAt });
        const check = await env.port.check({ providerRef });
        expect(check.status).toBe("accredited");
        expect(check.expiresAt).toBeInstanceOf(Date);
        expect(
          Math.abs((check.expiresAt as Date).getTime() - expiresAt.getTime()),
        ).toBeLessThanOrEqual(36 * 3600 * 1000);
        expect(check.decidedAt).toBeInstanceOf(Date);
        expect(check.vendorStatus.length).toBeGreaterThan(0);
        // The (possibly upgraded) ref keeps answering the same decision.
        const again = await env.port.check({ providerRef: check.providerRef ?? providerRef });
        expect(again.status).toBe("accredited");
      });

      it("maps a rejection", async () => {
        const env = await make({ credentials: "valid" });
        const { providerRef } = await started(env);
        env.vendor.reject(providerRef);
        const check = await env.port.check({ providerRef });
        expect(check.status).toBe("not_accredited");
        if (check.rejectionReason !== undefined) {
          expect(check.rejectionReason.length).toBeLessThanOrEqual(200);
        }
      });

      it("maps a cancellation", async () => {
        const env = await make({ credentials: "valid" });
        const { providerRef } = await started(env);
        env.vendor.cancel(providerRef);
        expect((await env.port.check({ providerRef })).status).toBe("canceled");
      });

      it("answers unknown (keeping the raw value) for a status it has never seen", async () => {
        const env = await make({ credentials: "valid" });
        const { providerRef } = await started(env);
        env.vendor.unknownStatus(providerRef, "brand_new_vendor_state");
        const check = await env.port.check({ providerRef });
        expect(check.status).toBe("unknown");
        expect(check.vendorStatus).toBe("brand_new_vendor_state");
      });

      it("refuses a ref it could never have issued", async () => {
        const env = await make({ credentials: "valid" });
        const err = await caught(env.port.check({ providerRef: "../../../etc/passwd?x=1" }));
        expect(["not_found", "invalid_request"]).toContain(err.code);
      });
    });

    describe("fetchEvidence", () => {
      it("answers null before a decision and a PDF after accreditation", async () => {
        const env = await make({ credentials: "valid" });
        const { providerRef } = await started(env);
        await expect(env.port.fetchEvidence({ providerRef })).resolves.toBeNull();
        env.vendor.accredit(providerRef);
        const ref = await decidedRef(env.port, providerRef);
        const evidence = await env.port.fetchEvidence({ providerRef: ref });
        expect(evidence).not.toBeNull();
        expect(evidence?.contentType).toBe("application/pdf");
        expect(isPdf(evidence?.bytes ?? new Uint8Array())).toBe(true);
        expect(evidence?.bytes.byteLength ?? 0).toBeLessThanOrEqual(10 * 1024 * 1024);
      });

      it("answers null for a rejected attempt", async () => {
        const env = await make({ credentials: "valid" });
        const { providerRef } = await started(env);
        env.vendor.reject(providerRef);
        const ref = await decidedRef(env.port, providerRef);
        await expect(env.port.fetchEvidence({ providerRef: ref })).resolves.toBeNull();
      });
    });

    describe("parseCallback", () => {
      const decided = async (o: AccreditationContractSetupOptions = { credentials: "valid" }) => {
        const env = await make(o);
        const { providerRef } = await started(env);
        env.vendor.accredit(providerRef);
        return { env, ref: await decidedRef(env.port, providerRef) };
      };

      it("accepts an authentic callback and returns the refs to wake", async () => {
        const { env, ref } = await decided();
        const cb = env.vendor.callback([ref]);
        const parsed = await env.port.parseCallback({ ...cb, now: new Date() });
        expect(parsed).toBeDefined();
        expect(parsed?.refs).toContain(ref);
        expect(parsed?.refs.length ?? 0).toBeLessThanOrEqual(20);
      });

      it("refuses a forged callback", async () => {
        const { env, ref } = await decided();
        await expect(
          env.port.parseCallback({ ...env.vendor.forgedCallback([ref]), now: new Date() }),
        ).resolves.toBeUndefined();
      });

      it("refuses a tampered body", async () => {
        const { env, ref } = await decided();
        const cb = env.vendor.callback([ref]);
        const rawBody = cb.rawBody.slice();
        rawBody[rawBody.length - 2] = (rawBody[rawBody.length - 2] ?? 0) ^ 0x01;
        await expect(
          env.port.parseCallback({ headers: cb.headers, rawBody, now: new Date() }),
        ).resolves.toBeUndefined();
      });

      it("refuses every callback when no webhook secret is configured", async () => {
        const { env, ref } = await decided({ credentials: "valid", callbackSecret: false });
        await expect(
          env.port.parseCallback({ ...env.vendor.callback([ref]), now: new Date() }),
        ).resolves.toBeUndefined();
      });

      it("never throws on garbage", async () => {
        const { port } = await make({ credentials: "valid" });
        const garbage = [
          { headers: new Headers(), rawBody: new Uint8Array() },
          {
            headers: new Headers({ "content-type": "application/json" }),
            rawBody: new Uint8Array([0xff, 0xfe]),
          },
          {
            headers: new Headers({
              "x-signature-sha256": "zz",
              "parallel-signature": "!!!",
              "parallel-timestamp": "not-a-number",
              "x-memory-signature": "00",
            }),
            rawBody: new TextEncoder().encode("{}"),
          },
        ];
        for (const g of garbage) {
          await expect(port.parseCallback({ ...g, now: new Date() })).resolves.toBeUndefined();
        }
      });

      it(
        options.callbackTimestamp
          ? "refuses a stale callback (signed timestamp older than 5 minutes)"
          : "has no signed timestamp: a replay is still authentic (harmless — callbacks only wake a re-check)",
        async () => {
          const { env, ref } = await decided();
          const cb = env.vendor.callback([ref]);
          const later = new Date(Date.now() + 10 * 60 * 1000);
          const parsed = await env.port.parseCallback({ ...cb, now: later });
          if (options.callbackTimestamp) expect(parsed).toBeUndefined();
          else expect(parsed?.refs).toContain(ref);
        },
      );
    });

    describe("errors", () => {
      it("maps HTTP 429 to a retryable rate_limited error", async () => {
        const env = await make({ credentials: "valid" });
        const { providerRef } = await started(env);
        env.vendor.failNext("rate_limited");
        const err = await caught(env.port.check({ providerRef }));
        expect(err.code).toBe("rate_limited");
        expect(err.retryable).toBe(true);
        expectNoSecret(err, env.secrets);
      });

      it("maps HTTP 5xx to a retryable unavailable error", async () => {
        const env = await make({ credentials: "valid" });
        const { providerRef } = await started(env);
        env.vendor.failNext("unavailable");
        const err = await caught(env.port.check({ providerRef }));
        expect(err.code).toBe("unavailable");
        expect(err.retryable).toBe(true);
        expectNoSecret(err, env.secrets);
      });

      it("a failed start carries no secret", async () => {
        const env = await make({ credentials: "valid" });
        env.vendor.failNext("unavailable");
        const err = await caught(env.port.start(contractStartInput()));
        expect(err.retryable).toBe(true);
        expectNoSecret(err, env.secrets);
      });
    });
  });
}
