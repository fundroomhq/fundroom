import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  type AccreditationAdapterDefinition,
  type AccreditationCredentialField,
  type AccreditationEvidence,
  AccreditationProviderError,
  type AccreditationVendorCheck,
  type AccreditationVendorDriver,
  type AccreditationVendorMeta,
  type AccreditationVendorStartInput,
  type AccreditationVendorStartResult,
} from "@fundroom/ports";

/**
 * In-memory accreditation vendor for every package's tests (E3.7 contract §3). No sockets.
 *
 * - Credential fields: the frozen keys of the real driver (VerifyInvestor: `apiToken`,
 *   `webhookSecret`, `environment`, `portalName`; Parallel Markets: `apiKey`, `clientId`,
 *   `webhookSigningKey`, `environment`).
 * - The API secret (`apiToken` / `apiKey`) `"invalid"` makes every call throw `unauthorized`
 *   (`verifyCredentials()` included); `"unreachable"` makes every call throw `unavailable`.
 * - `start()` answers `mem:<n>` and the driver's handoff (VerifyInvestor: `invite_sent`; Parallel:
 *   `widget` built from `clientId`/`environment`); the verification starts `in_progress`.
 * - Callbacks: authentic iff header `x-memory-signature` is the hex HMAC-SHA256 of the raw body
 *   under the connection's webhook secret (`webhookSecret` / `webhookSigningKey`); without that
 *   credential nothing authenticates (polling only). Body JSON `{ refs: string[] }`.
 * - `failNext(n, code)`: the next `n` port calls (any method except `parseCallback`) throw an
 *   `AccreditationProviderError` with that code (`rate_limited`/`unavailable` retryable).
 * - `hold()`: the next port call (except `parseCallback`) blocks until released — for tests that
 *   prove no transaction is open while the vendor is being called.
 */

export const MEMORY_SIGNATURE_HEADER = "x-memory-signature";

const META: Readonly<Record<AccreditationVendorDriver, AccreditationVendorMeta>> = {
  verifyinvestor: {
    driver: "verifyinvestor",
    label: "VerifyInvestor.com",
    handoff: "invite_email",
    supportsEntities: true,
    certificate: true,
    callbackSignature: "x-memory-signature HMAC (memory vendor)",
    subProcessor: {
      name: "Memory vendor",
      purpose: "Accredited-investor verification (tests)",
      location: "In process",
      url: "https://example.invalid/memory",
    },
  },
  "parallel-markets": {
    driver: "parallel-markets",
    label: "Parallel Markets",
    handoff: "widget",
    supportsEntities: true,
    certificate: true,
    callbackSignature: "x-memory-signature HMAC (memory vendor)",
    subProcessor: {
      name: "Memory vendor",
      purpose: "Accredited-investor verification (tests)",
      location: "In process",
      url: "https://example.invalid/memory",
    },
  },
};

const FIELDS: Readonly<Record<AccreditationVendorDriver, readonly AccreditationCredentialField[]>> =
  {
    verifyinvestor: [
      { key: "apiToken", label: "API token", kind: "secret", required: true },
      { key: "webhookSecret", label: "Webhook secret", kind: "secret", required: false },
      {
        key: "environment",
        label: "Environment",
        kind: "select",
        options: ["staging", "production"],
        required: true,
      },
      { key: "portalName", label: "Portal name", kind: "text", required: false },
    ],
    "parallel-markets": [
      { key: "apiKey", label: "API key", kind: "secret", required: true },
      { key: "clientId", label: "Client id", kind: "text", required: true },
      { key: "webhookSigningKey", label: "Webhook signing key", kind: "secret", required: false },
      {
        key: "environment",
        label: "Environment",
        kind: "select",
        options: ["demo", "production"],
        required: true,
      },
    ],
  };

const API_SECRET: Readonly<Record<AccreditationVendorDriver, string>> = {
  verifyinvestor: "apiToken",
  "parallel-markets": "apiKey",
};
const WEBHOOK_SECRET: Readonly<Record<AccreditationVendorDriver, string>> = {
  verifyinvestor: "webhookSecret",
  "parallel-markets": "webhookSigningKey",
};

type ErrorCode = AccreditationProviderError["code"];

interface MemoryVerification {
  readonly providerRef: string;
  readonly input: AccreditationVendorStartInput;
  check: AccreditationVendorCheck;
  certificate: Uint8Array | null;
}

/** A minimal, structurally valid one-page PDF whose page shows `label`. */
export function memoryCertificatePdf(label: string): Uint8Array {
  const safe = label.replace(/[()\\\r\n]/gu, " ");
  const stream = `BT /F1 12 Tf 72 720 Td (${safe}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

/** Hex HMAC-SHA256 of `body` under `secret` — the memory vendor's callback signature. */
export function memorySignature(secret: string, body: Uint8Array): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/** What a test drives the memory vendor with. */
export interface MemoryAccreditationVendor {
  readonly driver: AccreditationVendorDriver;
  /** The vendor decides `accredited` (default expiry: 90 days from the vendor clock). */
  accredit(ref: string, options?: { readonly expiresAt?: Date | undefined }): void;
  reject(ref: string, reason?: string): void;
  cancel(ref: string): void;
  /** Replaces the whole `check()` answer for `ref`. */
  setStatus(ref: string, check: AccreditationVendorCheck): void;
  /** The certificate `fetchEvidence(ref)` returns (`null` = none). Default: a tiny PDF once accredited. */
  certificate(ref: string, bytes: Uint8Array | null): void;
  /** A callback body naming `refs`. */
  callbackBody(refs: readonly string[]): Uint8Array;
  /** A signed callback request (`x-memory-signature` under `secret`) naming `refs`. */
  callbackRequest(
    refs: readonly string[],
    secret: string,
  ): { readonly headers: Headers; readonly rawBody: Uint8Array };
  /** The next `n` port calls (not `parseCallback`) throw `code`. */
  failNext(n: number, code: ErrorCode): void;
  /**
   * The next port call (not `parseCallback`) blocks: `reached` resolves when it is waiting,
   * `release()` lets it continue.
   */
  hold(): { readonly reached: Promise<void>; release(): void };
  /** Every `start()` input, oldest first. */
  started(): readonly AccreditationVendorStartInput[];
  /** The credentials each port was created with, oldest first. */
  configs(): readonly Readonly<Record<string, string>>[];
  /** Counts of port calls by method. */
  calls(): Readonly<Record<string, number>>;
  setNow(now: () => Date): void;
  reset(): void;
}

export function createMemoryAccreditationAdapter(
  driver: AccreditationVendorDriver = "verifyinvestor",
): {
  readonly definition: AccreditationAdapterDefinition;
  readonly vendor: MemoryAccreditationVendor;
} {
  const verifications = new Map<string, MemoryVerification>();
  const startedLog: AccreditationVendorStartInput[] = [];
  const configLog: Record<string, string>[] = [];
  const callCounts: Record<string, number> = {};
  let seq = 0;
  let failures: { remaining: number; code: ErrorCode } = { remaining: 0, code: "unavailable" };
  let pendingHold: { reached: () => void; gate: Promise<void> } | undefined;
  let clock: () => Date = () => new Date();

  const find = (ref: string): MemoryVerification => {
    const v = verifications.get(ref);
    if (v === undefined) {
      throw new AccreditationProviderError(
        "memory vendor: no such verification",
        "not_found",
        false,
        404,
      );
    }
    return v;
  };

  const enter = async (method: string, credentials: Readonly<Record<string, string>>) => {
    callCounts[method] = (callCounts[method] ?? 0) + 1;
    if (pendingHold !== undefined) {
      const h = pendingHold;
      pendingHold = undefined;
      h.reached();
      await h.gate;
    }
    const secret = credentials[API_SECRET[driver]];
    if (secret === "invalid") {
      throw new AccreditationProviderError(
        "memory vendor: bad credentials",
        "unauthorized",
        false,
        401,
      );
    }
    if (secret === "unreachable") {
      throw new AccreditationProviderError("memory vendor: unreachable", "unavailable", true);
    }
    if (failures.remaining > 0) {
      failures = { ...failures, remaining: failures.remaining - 1 };
      const retryable = failures.code === "rate_limited" || failures.code === "unavailable";
      throw new AccreditationProviderError(
        `memory vendor: injected ${failures.code}`,
        failures.code,
        retryable,
      );
    }
  };

  const definition: AccreditationAdapterDefinition = {
    meta: META[driver],
    credentialFields: FIELDS[driver],
    create(config) {
      const credentials = { ...config.credentials };
      configLog.push(credentials);
      return {
        driver,
        async verifyCredentials() {
          await enter("verifyCredentials", credentials);
        },
        async start(input): Promise<AccreditationVendorStartResult> {
          await enter("start", credentials);
          seq += 1;
          const providerRef = `mem:${seq}`;
          startedLog.push({ ...input });
          verifications.set(providerRef, {
            providerRef,
            input: { ...input },
            check: { status: "in_progress", vendorStatus: "in_progress" },
            certificate: null,
          });
          if (driver === "parallel-markets") {
            const env = credentials["environment"] === "production" ? "production" : "demo";
            return {
              providerRef,
              handoff: {
                kind: "widget",
                sdk: "parallel-markets",
                config: {
                  clientId: credentials["clientId"] ?? "",
                  environment: env,
                  requiredEntityId: providerRef,
                  email: input.email,
                  ...(input.firstName === undefined ? {} : { firstName: input.firstName }),
                  ...(input.lastName === undefined ? {} : { lastName: input.lastName }),
                  entityType: input.subject === "entity" ? "business" : "self",
                },
              },
              vendorStatus: "in_progress",
            };
          }
          return { providerRef, handoff: { kind: "invite_sent" }, vendorStatus: "in_progress" };
        },
        async check({ providerRef }) {
          await enter("check", credentials);
          return { ...find(providerRef).check };
        },
        async fetchEvidence({ providerRef }): Promise<AccreditationEvidence | null> {
          await enter("fetchEvidence", credentials);
          const v = find(providerRef);
          if (v.certificate === null) return null;
          return { contentType: "application/pdf", bytes: v.certificate };
        },
        async parseCallback({ headers, rawBody }) {
          const secret = credentials[WEBHOOK_SECRET[driver]];
          const given = headers.get(MEMORY_SIGNATURE_HEADER);
          if (secret === undefined || secret === "" || given === null) {
            // Same cost as a refused signature (no timing tell for a connection without a secret).
            memorySignature(randomBytes(32).toString("hex"), rawBody);
            return undefined;
          }
          const expected = Buffer.from(memorySignature(secret, rawBody), "utf8");
          const got = Buffer.from(given.trim().toLowerCase(), "utf8");
          if (got.length !== expected.length) {
            timingSafeEqual(expected, expected);
            return undefined;
          }
          if (!timingSafeEqual(got, expected)) return undefined;
          try {
            const body = JSON.parse(Buffer.from(rawBody).toString("utf8")) as { refs?: unknown };
            const refs = Array.isArray(body.refs)
              ? body.refs.filter((r): r is string => typeof r === "string").slice(0, 20)
              : [];
            return { refs };
          } catch {
            return undefined;
          }
        },
      };
    },
  };

  const decide = (ref: string, check: AccreditationVendorCheck) => {
    find(ref).check = check;
  };

  const vendor: MemoryAccreditationVendor = {
    driver,
    accredit(ref, options) {
      const at = clock();
      const v = find(ref);
      v.check = {
        status: "accredited",
        vendorStatus: driver === "verifyinvestor" ? "accredited" : "current",
        decidedAt: at,
        expiresAt: options?.expiresAt ?? new Date(at.getTime() + 90 * 24 * 60 * 60_000),
        assertion: "income",
      };
      if (v.certificate === null) v.certificate = memoryCertificatePdf(`certificate ${ref}`);
    },
    reject(ref, reason) {
      decide(ref, {
        status: "not_accredited",
        vendorStatus: driver === "verifyinvestor" ? "not_accredited" : "rejected",
        decidedAt: clock(),
        ...(reason === undefined ? {} : { rejectionReason: reason }),
      });
    },
    cancel(ref) {
      decide(ref, { status: "canceled", vendorStatus: "canceled" });
    },
    setStatus(ref, check) {
      decide(ref, { ...check });
    },
    certificate(ref, bytes) {
      find(ref).certificate = bytes;
    },
    callbackBody(refs) {
      return new TextEncoder().encode(JSON.stringify({ refs: [...refs] }));
    },
    callbackRequest(refs, secret) {
      const rawBody = vendor.callbackBody(refs);
      return {
        headers: new Headers({
          "content-type": "application/json",
          [MEMORY_SIGNATURE_HEADER]: memorySignature(secret, rawBody),
        }),
        rawBody,
      };
    },
    failNext(n, code) {
      failures = { remaining: n, code };
    },
    hold() {
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const reachedP = new Promise<void>((r) => {
        reached = r;
      });
      pendingHold = { reached, gate };
      return { reached: reachedP, release };
    },
    started: () => [...startedLog],
    configs: () => [...configLog],
    calls: () => ({ ...callCounts }),
    setNow(now) {
      clock = now;
    },
    reset() {
      verifications.clear();
      startedLog.length = 0;
      configLog.length = 0;
      for (const k of Object.keys(callCounts)) delete callCounts[k];
      failures = { remaining: 0, code: "unavailable" };
      pendingHold = undefined;
    },
  };

  return { definition, vendor };
}
