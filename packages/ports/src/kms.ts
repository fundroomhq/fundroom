/**
 * Key management (EXECUTION_PLAN §5.2 `KmsPort`, §10, ADR-0016). Envelope encryption: the
 * KMS holds the key-encryption key (KEK); the kernel generates one data-encryption key (DEK)
 * per workspace, stores it wrapped in `core.workspace_key`, and encrypts objects with a
 * per-object key derived from the DEK (`@fundroom/crypto`). Default adapter
 * `@fundroom/kms-local` wraps under a sub-key of the config key ring; AWS KMS, GCP KMS and
 * Vault Transit implement the same surface.
 *
 * `keyRef` names the KEK a wrapped key was produced with (`local:v2`, `aws:arn:…`) and is
 * recorded next to the wrapped bytes so rotation can find what to rewrap. The context is
 * bound into the wrap as additional authenticated data: a wrapped key copied between
 * workspaces does not unwrap.
 */
export interface KeyContext {
  readonly workspaceId: string;
  /** Distinguishes uses of the same KEK; default `workspace-dek`. */
  readonly purpose?: string | undefined;
}

export interface GeneratedDataKey {
  /** 32 bytes; never persisted, never logged. */
  readonly plaintext: Uint8Array;
  readonly wrapped: Uint8Array;
  readonly keyRef: string;
}

export interface WrappedDataKey {
  readonly wrapped: Uint8Array;
  readonly keyRef: string;
}

export type KmsErrorCode = "unknown_key" | "unwrap_failed" | "backend";

export class KmsError extends Error {
  override readonly name = "KmsError";
  constructor(
    readonly code: KmsErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
  }
}

export interface KmsPort {
  readonly driver: string;
  /** The KEK new wraps use. */
  readonly currentKeyRef: string;
  generateDataKey(context: KeyContext): Promise<GeneratedDataKey>;
  /** Wraps an existing key under `currentKeyRef`; the rewrap job uses it after rotation. */
  wrapDataKey(plaintext: Uint8Array, context: KeyContext): Promise<WrappedDataKey>;
  unwrapDataKey(wrapped: Uint8Array, keyRef: string, context: KeyContext): Promise<Uint8Array>;
  /** True when a key wrapped under `keyRef` should be rewrapped under `currentKeyRef`. */
  needsRewrap(keyRef: string): boolean;
  /** Cheap probe for `/readyz` (ring present, remote KMS reachable). */
  healthCheck(): Promise<void>;
}
