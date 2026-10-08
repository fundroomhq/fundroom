import type { ESignProviderErrorCode } from "@fundroom/ports";

/**
 * The test's handle on a fake vendor (E3.5 contract §1): drive envelopes from the vendor side and
 * mint callback requests. Implemented by the in-memory adapter and by every adapter's fake server.
 */
export interface FakeVendorControl {
  complete(providerRef: string): void;
  decline(providerRef: string): void;
  voidFromVendor(providerRef: string): void;
  /** A genuine (correctly authenticated) callback for this envelope. */
  callback(
    providerRef: string,
    event: "completed" | "declined" | "viewed",
  ): { headers: Headers; body: Uint8Array };
  /** Same shape, wrong secret. */
  forgedCallback(providerRef: string): { headers: Headers; body: Uint8Array };
  /** What the vendor received, in creation order. */
  created(): readonly { providerRef: string; input: unknown }[];
}

/** The in-memory vendor adds a failure injector: the next `n` port calls throw `code`. */
export interface MemoryVendorControl extends FakeVendorControl {
  failNext(n: number, code: ESignProviderErrorCode): void;
}
