import {
  createHash,
  createPublicKey,
  type KeyObject,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";

/*
 * C2SP signed notes (https://github.com/C2SP/C2SP/blob/main/signed-note.md) carrying a
 * tlog-checkpoint (`tlog-checkpoint.md`): `origin\nsize\nb64(root)\n[ext…]` + "\n" + signature
 * lines `— <name> <b64(keyID[4] || signature)>\n`.
 *
 * Key IDs and signatures, as rekor-tiles `pkg/note` produces them:
 *   - Ed25519: keyID = SHA-256(name || "\n" || 0x01 || raw 32-byte key)[:4]; signature = Ed25519
 *     over the note body (the C2SP standard; the public log2025-1 shard uses it);
 *   - ECDSA:   keyID = SHA-256(DER SPKI)[:4] (not name-bound); signature = ASN.1 ECDSA-SHA256;
 *   - RSA:     keyID = SHA-256(name || "\n" || 0xff || "PKIX-RSA-PKCS#1v1.5" || DER SPKI)[:4];
 *     signature = RSA PKCS#1 v1.5 SHA-256.
 * Signatures from keys we do not know are ignored (witness cosignatures, for instance).
 */

const EM_DASH = "—";

export interface Checkpoint {
  readonly origin: string;
  readonly size: number;
  readonly root: Uint8Array;
}

export interface NoteSignature {
  readonly name: string;
  readonly keyId: Uint8Array;
  readonly signature: Uint8Array;
}

export interface SignedNote {
  /** The signed text: every body line including its final "\n". */
  readonly body: string;
  readonly signatures: readonly NoteSignature[];
}

export class NoteError extends Error {
  override readonly name = "NoteError";
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Splits a signed note; throws `NoteError` on anything malformed. */
export function parseSignedNote(text: string): SignedNote {
  if (!text.endsWith("\n")) throw new NoteError("the note does not end with a newline");
  const split = text.lastIndexOf("\n\n");
  if (split < 0) throw new NoteError("the note has no signature block");
  const body = text.slice(0, split + 1);
  const block = text.slice(split + 2);
  const signatures: NoteSignature[] = [];
  for (const line of block.split("\n").slice(0, -1)) {
    const parts = line.split(" ");
    if (parts.length !== 3 || parts[0] !== EM_DASH) {
      throw new NoteError("a signature line is malformed");
    }
    const name = parts[1] as string;
    const b64 = parts[2] as string;
    if (name === "" || !BASE64.test(b64)) throw new NoteError("a signature line is malformed");
    const raw = Buffer.from(b64, "base64");
    if (raw.byteLength < 5) throw new NoteError("a signature is too short");
    signatures.push({
      name,
      keyId: new Uint8Array(raw.subarray(0, 4)),
      signature: new Uint8Array(raw.subarray(4)),
    });
  }
  if (signatures.length === 0) throw new NoteError("the note is unsigned");
  return { body, signatures };
}

/** Parses the checkpoint carried in a note body (origin, decimal size, base64 32-byte root). */
export function parseCheckpoint(body: string): Checkpoint {
  const lines = body.split("\n");
  const [origin, sizeText, rootText] = lines;
  if (origin === undefined || origin === "" || /\s/.test(origin)) {
    throw new NoteError("the checkpoint origin is invalid");
  }
  if (sizeText === undefined || !/^(0|[1-9][0-9]*)$/.test(sizeText)) {
    throw new NoteError("the checkpoint size is invalid");
  }
  const size = Number(sizeText);
  if (!Number.isSafeInteger(size)) throw new NoteError("the checkpoint size is too large");
  if (rootText === undefined || !BASE64.test(rootText)) {
    throw new NoteError("the checkpoint root is invalid");
  }
  const root = new Uint8Array(Buffer.from(rootText, "base64"));
  if (root.byteLength !== 32) throw new NoteError("the checkpoint root is not 32 bytes");
  return { origin, size, root };
}

export type LogKeyType = "ed25519" | "ecdsa" | "rsa";

export interface LogKey {
  readonly type: LogKeyType;
  readonly key: KeyObject;
  readonly spki: Uint8Array;
}

/** Parses a log public key (PEM SPKI). Throws on unsupported key types. */
export function logKeyFromPem(pem: string): LogKey {
  const key = createPublicKey(pem);
  const spki = new Uint8Array(key.export({ type: "spki", format: "der" }));
  switch (key.asymmetricKeyType) {
    case "ed25519":
      return { type: "ed25519", key, spki };
    case "ec":
      return { type: "ecdsa", key, spki };
    case "rsa":
      return { type: "rsa", key, spki };
    default:
      throw new Error(`unsupported log key type ${String(key.asymmetricKeyType)}`);
  }
}

/** Every PUBLIC KEY block in the given PEM texts; unparseable or unsupported ones are skipped. */
export function logKeysFromPems(pems: readonly string[]): LogKey[] {
  const out: LogKey[] = [];
  for (const text of pems) {
    const blocks = text.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g) ?? [];
    for (const block of blocks) {
      try {
        out.push(logKeyFromPem(block));
      } catch {
        // not a usable log key
      }
    }
  }
  return out;
}

function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** The 4-byte key ID of `key` signing under `name`. */
export function noteKeyId(name: string, key: LogKey): Uint8Array {
  const prefix = new TextEncoder().encode(`${name}\n`);
  switch (key.type) {
    case "ed25519":
      return sha256(prefix, Uint8Array.of(0x01), key.spki.subarray(key.spki.byteLength - 32)).slice(
        0,
        4,
      );
    case "ecdsa":
      return sha256(key.spki).slice(0, 4);
    case "rsa":
      return sha256(
        prefix,
        Uint8Array.of(0xff),
        new TextEncoder().encode("PKIX-RSA-PKCS#1v1.5"),
        key.spki,
      ).slice(0, 4);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);
}

export function verifyNoteSignature(body: string, key: LogKey, signature: Uint8Array): boolean {
  const data = Buffer.from(body, "utf8");
  try {
    return key.type === "ed25519"
      ? verifyBytes(null, data, key.key, signature)
      : verifyBytes("sha256", data, key.key, signature);
  } catch {
    return false;
  }
}

export type NoteVerdict =
  /** A pinned key signed it. */
  | { readonly status: "verified"; readonly keyType: LogKeyType }
  /** A line claims a pinned key but its signature is wrong: the note was altered. */
  | { readonly status: "failed"; readonly detail: string }
  /** No pinned key signed it (only unknown keys). */
  | { readonly status: "unverified_origin"; readonly detail: string };

/** Checks the note's signatures under `name` (the checkpoint origin) against the pinned keys. */
export function verifyNote(note: SignedNote, name: string, pinned: readonly LogKey[]): NoteVerdict {
  let claimed = false;
  for (const key of pinned) {
    const id = noteKeyId(name, key);
    for (const sig of note.signatures) {
      if (sig.name !== name || !sameBytes(sig.keyId, id)) continue;
      claimed = true;
      if (verifyNoteSignature(note.body, key, sig.signature)) {
        return { status: "verified", keyType: key.type };
      }
    }
  }
  return claimed
    ? { status: "failed", detail: "the checkpoint signature by the pinned log key is invalid" }
    : {
        status: "unverified_origin",
        detail: "the checkpoint is not signed by a pinned log key",
      };
}

/** Signs a note body (stub log + tests). `key` is the private key matching `logKey`. */
export function signNote(body: string, name: string, key: KeyObject, logKey: LogKey): string {
  const data = Buffer.from(body, "utf8");
  const signature =
    logKey.type === "ed25519" ? signBytes(null, data, key) : signBytes("sha256", data, key);
  const blob = Buffer.concat([noteKeyId(name, logKey), signature]).toString("base64");
  return `${body}\n${EM_DASH} ${name} ${blob}\n`;
}
