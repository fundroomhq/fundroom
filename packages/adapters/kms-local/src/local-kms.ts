import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { KeyRing, KeyRingEntry } from "@fundroom/config";
import {
  type GeneratedDataKey,
  type KeyContext,
  KmsError,
  type KmsPort,
  type WrappedDataKey,
} from "@fundroom/ports";

/*
 * `KmsPort` over the config key ring (EXECUTION_PLAN §5.2 `kms-local`, ADR-0016, design/02
 * §4). No external KMS: the key-encryption key (KEK) for each ring entry is an HKDF sub-key
 * of that entry, so the operator rotates one ring (`SECRET_KEY_RING=v2:…,v1:…`) and the
 * `crypto.rewrap` job moves every workspace DEK to the new KEK.
 *
 * Wrapped format (bytes): `0x01 | iv(12) | ciphertext(32) | tag(16)`; AES-256-GCM.
 * AAD binds the wrap to its workspace and purpose, so a wrapped key copied into another
 * workspace's row does not unwrap. `keyRef` = `local:<ring entry id>` and is stored next to
 * the bytes (`core.workspace_key.kms_key_ref`).
 */
export const LOCAL_KMS_DRIVER = "local";
export const LOCAL_KEY_REF_PREFIX = "local:";
export const DEFAULT_KEY_PURPOSE = "workspace-dek";

const KEK_INFO = "seed-host/kms/kek/v1";
const AAD_PREFIX = "seed-host/kms/v1";
const FORMAT_VERSION = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEK_BYTES = 32;
const WRAPPED_BYTES = 1 + IV_BYTES + DEK_BYTES + TAG_BYTES;

export interface LocalKmsOptions {
  readonly keyRing: KeyRing;
}

export interface LocalKms extends KmsPort {
  readonly driver: typeof LOCAL_KMS_DRIVER;
}

const kekCache = new WeakMap<KeyRingEntry, Uint8Array>();

function kekFor(entry: KeyRingEntry): Uint8Array {
  const hit = kekCache.get(entry);
  if (hit) return hit;
  const kek = new Uint8Array(hkdfSync("sha256", entry.key, new Uint8Array(0), KEK_INFO, 32));
  kekCache.set(entry, kek);
  return kek;
}

function aadFor(context: KeyContext): Buffer {
  const purpose = context.purpose ?? DEFAULT_KEY_PURPOSE;
  return Buffer.from(`${AAD_PREFIX}\0${context.workspaceId}\0${purpose}`, "utf8");
}

/** `local:<id>` → `<id>`; anything else is not ours. */
export function parseLocalKeyRef(keyRef: string): string | undefined {
  if (!keyRef.startsWith(LOCAL_KEY_REF_PREFIX)) return undefined;
  const id = keyRef.slice(LOCAL_KEY_REF_PREFIX.length);
  return id.length > 0 ? id : undefined;
}

export function createLocalKms(options: LocalKmsOptions): LocalKms {
  const ring = options.keyRing;
  const currentKeyRef = `${LOCAL_KEY_REF_PREFIX}${ring.current.id}`;

  function wrap(plaintext: Uint8Array, context: KeyContext): WrappedDataKey {
    if (plaintext.byteLength !== DEK_BYTES) {
      throw new KmsError("backend", `data keys are ${DEK_BYTES} bytes`);
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", kekFor(ring.current), iv);
    cipher.setAAD(aadFor(context));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const wrapped = new Uint8Array(Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, ct, tag]));
    return { wrapped, keyRef: currentKeyRef };
  }

  return {
    driver: LOCAL_KMS_DRIVER,
    currentKeyRef,

    async wrapDataKey(plaintext, context) {
      return wrap(plaintext, context);
    },

    async generateDataKey(context) {
      const plaintext = new Uint8Array(randomBytes(DEK_BYTES));
      const { wrapped, keyRef } = wrap(plaintext, context);
      const out: GeneratedDataKey = { plaintext, wrapped, keyRef };
      return out;
    },

    async unwrapDataKey(wrapped, keyRef, context) {
      const id = parseLocalKeyRef(keyRef);
      if (id === undefined) {
        throw new KmsError(
          "unknown_key",
          `key reference ${JSON.stringify(keyRef)} is not a local key`,
        );
      }
      const entry = ring.get(id);
      if (!entry) {
        throw new KmsError("unknown_key", `no key ${JSON.stringify(id)} in the ring`);
      }
      if (wrapped.byteLength !== WRAPPED_BYTES || wrapped[0] !== FORMAT_VERSION) {
        throw new KmsError("unwrap_failed", "wrapped data key could not be unwrapped");
      }
      const buf = Buffer.from(wrapped.buffer, wrapped.byteOffset, wrapped.byteLength);
      const iv = buf.subarray(1, 1 + IV_BYTES);
      const ct = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + DEK_BYTES);
      const tag = buf.subarray(1 + IV_BYTES + DEK_BYTES);
      // Pinned (ASVS F-22); the fixed WRAPPED_BYTES above already makes the tag 16 bytes.
      const decipher = createDecipheriv("aes-256-gcm", kekFor(entry), iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aadFor(context));
      decipher.setAuthTag(tag);
      try {
        return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
      } catch {
        // Tamper, wrong workspace, wrong purpose or wrong key all look the same on purpose.
        throw new KmsError("unwrap_failed", "wrapped data key could not be unwrapped");
      }
    },

    needsRewrap(keyRef) {
      return keyRef !== currentKeyRef;
    },

    async healthCheck() {
      if (!ring.current || ring.current.key.byteLength < 32) {
        throw new KmsError("backend", "key ring has no usable current key");
      }
    },
  };
}
