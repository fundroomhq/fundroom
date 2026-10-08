import { createHash, generateKeyPairSync, type KeyObject, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { inclusionPath, leafHash, merkleRoot } from "../merkle.js";
import { type LogKey, logKeyFromPem, noteKeyId, signNote } from "../note.js";

/*
 * A local Rekor v2 (rekor-tiles) log for tests. It speaks the real write API — `POST
 * /api/v2/log/entries` with a `hashedRekordRequestV002`, answering a protojson
 * TransparencyLogEntry — and `GET /api/v2/checkpoint`. Entries go into a real RFC 6962 tree
 * (pre-filled with a few unrelated leaves so proofs are non-trivial), the canonicalized body is
 * the JCS form of the entry like rekor-tiles writes it, and every checkpoint is a C2SP signed
 * note signed with the log key (Ed25519 by default, as the public shards use; ECDSA P-256
 * optional), optionally with an extra cosignature from an unknown witness key.
 *
 * Like the real log it refuses pure Ed25519 (`PKIX_ED25519`) hashedrekords. It does NOT verify
 * the submitted signature against the prehashed digest (node:crypto has no prehash ECDSA verify);
 * the adapter verifies it itself, and the opt-in live test covers the real log's check.
 */

export type StubRekorMode =
  | "ok"
  | "redirect"
  | "error"
  | "hang"
  | "oversize"
  | "garbage"
  /** Answer with the inclusion proof's first hash flipped. */
  | "bad-proof"
  /** Sign the checkpoint with a different key that claims the pinned key's ID. */
  | "bad-signature"
  /** Sign the checkpoint with an unrelated log key (its own key ID). */
  | "foreign-key"
  /** Record a different digest than the one submitted. */
  | "wrong-digest";

export interface StubRekorOptions {
  readonly logKey?: "ed25519" | "ecdsa" | undefined;
  /** Checkpoint origin (= the log key's note name). Default `127.0.0.1`, the hostname of `url` (like rekor-tiles). */
  readonly origin?: string | undefined;
  /** Unrelated leaves already in the log. Default 5. */
  readonly prefill?: number | undefined;
  /** Add a cosignature line from an unknown witness key. Default true. */
  readonly witness?: boolean | undefined;
}

export interface StubRekorControl {
  mode: StubRekorMode;
}

export interface StubRekor {
  /** Base URL: `http://127.0.0.1:<port>`. */
  readonly url: string;
  readonly origin: string;
  /** The log public key to pin (PEM SPKI). */
  readonly logPublicKeyPem: string;
  /** An unrelated log key (PEM), for "untrusted" pins. */
  readonly otherLogPublicKeyPem: string;
  readonly control: StubRekorControl;
  readonly requests: () => number;
  readonly redirectTargetHits: () => number;
  /** Entries written so far (excluding the prefill). */
  readonly entries: () => number;
  close(): Promise<void>;
}

const ACCEPTED_KEY_DETAILS = new Set([
  "PKIX_RSA_PKCS1V15_2048_SHA256",
  "PKIX_RSA_PKCS1V15_3072_SHA256",
  "PKIX_RSA_PKCS1V15_4096_SHA256",
  "PKIX_ECDSA_P256_SHA_256",
  "PKIX_ECDSA_P384_SHA_384",
  "PKIX_ECDSA_P521_SHA_512",
  "PKIX_ED25519_PH",
]);

/** RFC 8785 for the plain JSON values a log entry contains (strings, objects). */
function jcs(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${jcs(obj[k])}`)
    .join(",")}}`;
}

function keyPair(type: "ed25519" | "ecdsa"): { privateKey: KeyObject; log: LogKey; pem: string } {
  const { privateKey, publicKey } =
    type === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKey, log: logKeyFromPem(pem), pem };
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > limit) throw new Error("request too large");
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function b64(value: unknown): Buffer | null {
  return typeof value === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(value)
    ? Buffer.from(value, "base64")
    : null;
}

export async function startStubRekor(options: StubRekorOptions = {}): Promise<StubRekor> {
  const origin = options.origin ?? "127.0.0.1";
  const log = keyPair(options.logKey ?? "ed25519");
  const other = keyPair(options.logKey ?? "ed25519");
  const witness = keyPair("ed25519");
  const witnessName = "witness.stub.fundroom.test";
  const leaves: Uint8Array[] = [];
  for (let i = 0; i < (options.prefill ?? 5); i++) leaves.push(leafHash(randomBytes(64)));
  const prefill = leaves.length;
  const control: StubRekorControl = { mode: "ok" };
  let requests = 0;
  let redirectTargetHits = 0;
  const hanging = new Set<ServerResponse>();

  function checkpoint(mode: StubRekorMode): string {
    const root = merkleRoot(leaves);
    const body = `${origin}\n${leaves.length}\n${Buffer.from(root).toString("base64")}\n`;
    let note: string;
    if (mode === "bad-signature") {
      // The pinned key's ID, another key's signature.
      const forged = signNote(body, origin, other.privateKey, other.log);
      const blob = forged.trimEnd().split(" ").pop() as string;
      const raw = Buffer.from(blob, "base64");
      Buffer.from(noteKeyId(origin, log.log)).copy(raw, 0);
      note = `${body}\n— ${origin} ${raw.toString("base64")}\n`;
    } else if (mode === "foreign-key") {
      note = signNote(body, origin, other.privateKey, other.log);
    } else {
      note = signNote(body, origin, log.privateKey, log.log);
    }
    if (options.witness ?? true) {
      const cosig = signNote(body, witnessName, witness.privateKey, witness.log);
      note += cosig.slice(body.length + 1);
    }
    return note;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requests += 1;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.url === "/elsewhere") {
      redirectTargetHits += 1;
      res.writeHead(404).end();
      return;
    }
    if (req.method === "GET" && req.url === "/api/v2/checkpoint") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(checkpoint(control.mode));
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/v2/log/entries") {
      res.writeHead(404).end();
      return;
    }
    const mode = control.mode;
    if (mode === "hang") {
      hanging.add(res);
      return;
    }
    if (mode === "redirect") {
      res.writeHead(307, { location: "/elsewhere" }).end();
      return;
    }
    if (mode === "error") return json(503, { code: 14, message: "unavailable" });
    if (mode === "oversize") {
      res.writeHead(200, { "content-type": "application/json" });
      for (let i = 0; i < 160; i++) res.write(" ".repeat(8 * 1024));
      res.end("{}");
      return;
    }
    if (mode === "garbage") {
      res.writeHead(201, { "content-type": "application/json" }).end("<html>");
      return;
    }
    let request: Record<string, unknown>;
    try {
      request = (await readJson(req)) as Record<string, unknown>;
    } catch {
      return json(400, { code: 3, message: "invalid JSON" });
    }
    const hr = request["hashedRekordRequestV002"] as Record<string, unknown> | undefined;
    const signature = hr?.["signature"] as Record<string, unknown> | undefined;
    const verifier = signature?.["verifier"] as Record<string, unknown> | undefined;
    const publicKey = verifier?.["publicKey"] as Record<string, unknown> | undefined;
    const digest = b64(hr?.["digest"]);
    const content = b64(signature?.["content"]);
    const rawBytes = b64(publicKey?.["rawBytes"]);
    const keyDetails = verifier?.["keyDetails"];
    if (!digest || !content || !rawBytes || typeof keyDetails !== "string") {
      return json(400, { code: 3, message: "invalid hashedrekord request" });
    }
    if (!ACCEPTED_KEY_DETAILS.has(keyDetails)) {
      return json(400, {
        code: 3,
        message: `unsupported signing algorithm ${keyDetails} for hashedrekord`,
      });
    }
    if (digest.byteLength !== 32) return json(400, { code: 3, message: "digest length" });
    const recorded =
      mode === "wrong-digest" ? createHash("sha256").update(digest).digest() : digest;
    const body = Buffer.from(
      jcs({
        apiVersion: "0.0.2",
        kind: "hashedrekord",
        spec: {
          hashedRekordV002: {
            data: { algorithm: "SHA2_256", digest: recorded.toString("base64") },
            signature: {
              content: content.toString("base64"),
              verifier: { keyDetails, publicKey: { rawBytes: rawBytes.toString("base64") } },
            },
          },
        },
      }),
    );
    const index = leaves.length;
    leaves.push(leafHash(body));
    const path = inclusionPath(index, leaves).map((h) => Buffer.from(h));
    if (mode === "bad-proof" && path[0]) path[0][0] = (path[0][0] ?? 0) ^ 0x01;
    const root = merkleRoot(leaves);
    json(201, {
      logIndex: String(index),
      logId: { keyId: Buffer.from(noteKeyId(origin, log.log)).toString("base64") },
      kindVersion: { kind: "hashedrekord", version: "0.0.2" },
      integratedTime: "0",
      inclusionPromise: null,
      inclusionProof: {
        logIndex: String(index),
        rootHash: Buffer.from(root).toString("base64"),
        treeSize: String(leaves.length),
        hashes: path.map((h) => h.toString("base64")),
        checkpoint: { envelope: checkpoint(mode) },
      },
      canonicalizedBody: body.toString("base64"),
    });
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    origin,
    logPublicKeyPem: log.pem,
    otherLogPublicKeyPem: other.pem,
    control,
    requests: () => requests,
    redirectTargetHits: () => redirectTargetHits,
    entries: () => leaves.length - prefill,
    async close() {
      for (const res of hanging) res.destroy();
      hanging.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
