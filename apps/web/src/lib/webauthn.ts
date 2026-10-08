/*
 * Lazy wrappers around @simplewebauthn/browser so the login route does not pay for the
 * library until a passkey is actually used. The server's `options` blobs are the JSON
 * forms produced by @simplewebauthn/server; the response objects go back verbatim.
 */
export type JsonRecord = Record<string, unknown>;

async function lib() {
  return import("@simplewebauthn/browser");
}

export async function webAuthnSupported(): Promise<boolean> {
  if (typeof window === "undefined" || !("PublicKeyCredential" in window)) return false;
  return (await lib()).browserSupportsWebAuthn();
}

export async function webAuthnAutofillSupported(): Promise<boolean> {
  if (typeof window === "undefined" || !("PublicKeyCredential" in window)) return false;
  return (await lib()).browserSupportsWebAuthnAutofill();
}

export async function authenticate(
  options: JsonRecord,
  useBrowserAutofill = false,
): Promise<JsonRecord> {
  const { startAuthentication } = await lib();
  const response = await startAuthentication({
    optionsJSON: options as never,
    useBrowserAutofill,
  });
  return response as unknown as JsonRecord;
}

export async function register(options: JsonRecord): Promise<JsonRecord> {
  const { startRegistration } = await lib();
  const response = await startRegistration({ optionsJSON: options as never });
  return response as unknown as JsonRecord;
}

/** Cancels a pending conditional-UI request (the library keeps one global controller). */
export async function cancelPending(): Promise<void> {
  const { WebAuthnAbortService } = await lib();
  WebAuthnAbortService.cancelCeremony();
}

export function isWebAuthnCancelled(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || error.name === "NotAllowedError")
  );
}
