import { timingSafeEqual } from "node:crypto";
import {
  type ESignAdapterDefinition,
  type ESignArtifacts,
  type ESignConnectionConfig,
  type ESignDriver,
  type ESignEnvelopeInput,
  type ESignEnvelopeState,
  type ESignEnvelopeStatus,
  ESignProviderError,
  type ESignProviderErrorCode,
  type ESignSignerStatus,
  type ESignVendorMeta,
} from "@fundroom/ports";
import type { MemoryVendorControl } from "./types.js";

/**
 * In-memory e-sign vendor for every package's tests (E3.5 contract §1). No sockets.
 *
 * - Credentials: `apiToken` is required; the value `"invalid"` makes `verifyCredentials()` answer
 *   `unauthorized` (and every other call throw `unauthorized`).
 * - Callbacks: authentic iff header `x-memory-secret` equals the connection's `callbackSecret`
 *   (constant-time). Body is JSON `{providerRef, externalId, event}`.
 * - Artifacts: tiny valid PDFs (`%PDF-1.4`), signed + certificate; `downloadSigned` refuses a
 *   `maxBytes` below their size with `too_large` and anything not `completed` with `rejected`.
 * - `failNext(n, code)`: the next `n` port calls (any method except `parseCallback`) throw an
 *   `ESignProviderError` with that code (`rate_limited`/`unavailable` are retryable).
 */

const DISPLAY: Record<ESignDriver, string> = {
  documenso: "Documenso",
  docuseal: "DocuSeal",
  docusign: "DocuSign",
  "dropbox-sign": "Dropbox Sign",
};

const TERMINAL: ReadonlySet<ESignEnvelopeStatus> = new Set([
  "completed",
  "declined",
  "voided",
  "expired",
]);

interface MemoryEnvelope {
  readonly providerRef: string;
  readonly input: ESignEnvelopeInput;
  readonly callbackSecret: string | undefined;
  status: ESignEnvelopeStatus;
  signers: { signerKey: string; status: ESignSignerStatus; at?: Date | undefined }[];
  completedAt?: Date | undefined;
}

/** A minimal, structurally valid one-page PDF whose page shows `label` (base-14 Helvetica). */
export function tinyPdf(label: string): Uint8Array {
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

function sameSecret(given: string | null, expected: string | undefined): boolean {
  if (given === null || expected === undefined || expected.length === 0) return false;
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}

export function createMemoryESignAdapter(driver: ESignDriver = "documenso"): {
  readonly definition: ESignAdapterDefinition;
  readonly vendor: MemoryVendorControl;
} {
  const envelopes = new Map<string, MemoryEnvelope>();
  const createdLog: { providerRef: string; input: unknown }[] = [];
  let seq = 0;
  let failures: { remaining: number; code: ESignProviderErrorCode } = {
    remaining: 0,
    code: "unavailable",
  };
  let clock: () => Date = () => new Date();

  const maybeFail = (): void => {
    if (failures.remaining <= 0) return;
    failures = { ...failures, remaining: failures.remaining - 1 };
    const retryable = failures.code === "rate_limited" || failures.code === "unavailable";
    throw new ESignProviderError(
      `memory vendor: injected ${failures.code}`,
      failures.code,
      retryable,
    );
  };

  const find = (providerRef: string): MemoryEnvelope => {
    const env = envelopes.get(providerRef);
    if (env === undefined) {
      throw new ESignProviderError("memory vendor: no such envelope", "not_found", false, 404);
    }
    return env;
  };

  const transition = (
    providerRef: string,
    status: ESignEnvelopeStatus,
    signerStatus?: ESignSignerStatus,
  ): void => {
    const env = find(providerRef);
    if (TERMINAL.has(env.status)) return;
    env.status = status;
    const at = clock();
    if (signerStatus !== undefined) {
      env.signers = env.signers.map((s) => ({ ...s, status: signerStatus, at }));
    }
    if (status === "completed") env.completedAt = at;
  };

  const meta: ESignVendorMeta = {
    driver,
    displayName: DISPLAY[driver],
    selfHostable: driver === "documenso" || driver === "docuseal",
    baseUrl: { required: false, default: "https://memory.esign.test" },
    supports: { templates: true, pdf: true, embeddedSigning: true, void: true },
    callbackSecret: "ours",
    subProcessor: {
      name: `${DISPLAY[driver]} (memory)`,
      purpose: "Electronic signature of documents (test double)",
      region: "test",
      dpaUrl: "https://memory.esign.test/dpa",
      certifications: [],
    },
  };

  const callbackRequest = (
    providerRef: string,
    event: string,
    secret: string,
  ): { headers: Headers; body: Uint8Array } => {
    const env = envelopes.get(providerRef);
    const body = new TextEncoder().encode(
      JSON.stringify({ providerRef, externalId: env?.input.externalId, event }),
    );
    return {
      headers: new Headers({ "content-type": "application/json", "x-memory-secret": secret }),
      body,
    };
  };

  const definition: ESignAdapterDefinition = {
    meta,
    credentialFields: [{ key: "apiToken", label: "API token", kind: "secret", required: true }],
    create(config: ESignConnectionConfig, deps) {
      clock = deps.now;
      const unauthorized = config.credentials["apiToken"] === "invalid";
      const guard = (): void => {
        maybeFail();
        if (unauthorized) {
          throw new ESignProviderError("memory vendor: unauthorized", "unauthorized", false, 401);
        }
      };
      return {
        driver,
        async verifyCredentials() {
          maybeFail();
          if (
            config.credentials["apiToken"] === undefined ||
            config.credentials["apiToken"] === ""
          ) {
            return { ok: false, reason: "misconfigured", detail: "apiToken missing" };
          }
          if (unauthorized) return { ok: false, reason: "unauthorized" };
          return { ok: true, account: "memory-account" };
        },
        async createEnvelope(input) {
          guard();
          for (const env of envelopes.values()) {
            if (env.input.externalId === input.externalId) return { providerRef: env.providerRef };
          }
          seq += 1;
          const providerRef = `mem_${driver}_${seq}`;
          envelopes.set(providerRef, {
            providerRef,
            input,
            callbackSecret: config.callbackSecret,
            status: "sent",
            signers: input.signers.map((s) => ({ signerKey: s.signerKey, status: "pending" })),
          });
          createdLog.push({ providerRef, input });
          return { providerRef };
        },
        async status(providerRef): Promise<ESignEnvelopeState> {
          guard();
          const env = find(providerRef);
          return {
            status: env.status,
            signers: env.signers.map((s) => ({ ...s })),
            ...(env.completedAt === undefined ? {} : { completedAt: env.completedAt }),
          };
        },
        async signingUrl(providerRef, signerKey, returnUrl) {
          guard();
          const env = find(providerRef);
          if (TERMINAL.has(env.status)) return undefined;
          const url = new URL(
            `https://memory.esign.test/sign/${encodeURIComponent(providerRef)}/${encodeURIComponent(signerKey)}`,
          );
          url.searchParams.set("return", returnUrl);
          return url.toString();
        },
        async downloadSigned(providerRef, limits): Promise<ESignArtifacts> {
          guard();
          const env = find(providerRef);
          if (env.status !== "completed") {
            throw new ESignProviderError(
              "memory vendor: envelope not completed",
              "rejected",
              false,
              409,
            );
          }
          const document = tinyPdf(`Signed: ${env.input.title}`);
          const certificate = tinyPdf(`Certificate: ${env.input.externalId}`);
          if (document.byteLength + certificate.byteLength > limits.maxBytes) {
            throw new ESignProviderError("memory vendor: artifact too large", "too_large", false);
          }
          return { document, certificate };
        },
        async void(providerRef) {
          guard();
          const env = find(providerRef);
          if (TERMINAL.has(env.status)) {
            throw new ESignProviderError(
              "memory vendor: envelope is terminal",
              "rejected",
              false,
              409,
            );
          }
          env.status = "voided";
        },
        async parseCallback(request) {
          try {
            if (!sameSecret(request.headers.get("x-memory-secret"), config.callbackSecret)) {
              return undefined;
            }
            if (request.body.byteLength === 0) return undefined;
            const parsed: unknown = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(request.body),
            );
            if (typeof parsed !== "object" || parsed === null) return undefined;
            const o = parsed as Record<string, unknown>;
            if (typeof o["event"] !== "string") return undefined;
            return {
              event: o["event"],
              ...(typeof o["providerRef"] === "string" ? { providerRef: o["providerRef"] } : {}),
              ...(typeof o["externalId"] === "string" ? { externalId: o["externalId"] } : {}),
            };
          } catch {
            return undefined;
          }
        },
      };
    },
  };

  const vendor: MemoryVendorControl = {
    complete: (ref) => transition(ref, "completed", "signed"),
    decline: (ref) => transition(ref, "declined", "declined"),
    voidFromVendor: (ref) => transition(ref, "voided"),
    callback(ref, event) {
      const env = find(ref);
      if (event === "viewed" && env.status === "sent") {
        env.status = "delivered";
        env.signers = env.signers.map((s) => ({ ...s, status: "viewed", at: clock() }));
      }
      return callbackRequest(ref, event, env.callbackSecret ?? "");
    },
    forgedCallback(ref) {
      const env = envelopes.get(ref);
      return callbackRequest(ref, "completed", `forged-${env?.callbackSecret ?? "x"}`);
    },
    created: () => createdLog.slice(),
    failNext(n, code) {
      failures = { remaining: n, code };
    },
  };

  return { definition, vendor };
}
