import { createHash, randomBytes, webcrypto } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { OID_KP_TIME_STAMPING, OID_SHA256, OID_SIGNED_DATA, OID_TST_INFO } from "../tsp.js";

/*
 * A local RFC 3161 time-stamping authority for tests (the anchor adapter's, the kernel's, the
 * CLI's). It signs REAL tokens — CMS SignedData over a DER TSTInfo with content-type,
 * message-digest and ESS signing-certificate-v2 signed attributes — with an ECDSA P-256 key and a
 * freshly minted certificate (self-signed with the timeStamping EKU by default, or issued by a
 * stub root CA), so `openssl ts -verify` accepts them too. `control.mode` scripts misbehaviour.
 */

export const OID_KP_SERVER_AUTH = "1.3.6.1.5.5.7.3.1";
const OID_ATTR_CONTENT_TYPE = "1.2.840.113549.1.9.3";
const OID_ATTR_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_ATTR_SIGNING_TIME = "1.2.840.113549.1.9.5";
const OID_ATTR_SIGNING_CERT_V2 = "1.2.840.113549.1.9.16.2.47";
export const STUB_TSA_POLICY = "1.3.6.1.4.1.99999.3161.1";

export type StubTsaMode =
  /** Answer correctly. */
  | "ok"
  /** 302 to another path on the same server (an anchor must never follow it). */
  | "redirect"
  /** HTTP 500. */
  | "error"
  /** PKIStatus 2 (rejection), no token. */
  | "rejection"
  /** Granted, but no token. */
  | "granted-without-token"
  /** Not DER at all. */
  | "garbage"
  /** A body larger than any TSA answer, with a content-length. */
  | "oversize"
  /** The same, streamed without a content-length. */
  | "oversize-chunked"
  /** Never answer (the client's deadline must fire). */
  | "hang"
  /** A valid token whose nonce is not the request's. */
  | "wrong-nonce"
  /** A valid token over a different digest. */
  | "wrong-imprint";

export interface StubTsaOptions {
  /** Extended key usages of the signing certificate. Default `[timeStamping]`. */
  readonly eku?: readonly string[] | undefined;
  /** Mark the EKU extension critical. Default true (RFC 3161 §2.3). */
  readonly ekuCritical?: boolean | undefined;
  /** `self-signed` (default): one certificate, pin it. `ca`: a root CA issues the TSA cert; pin the root. */
  readonly chain?: "self-signed" | "ca" | undefined;
  /** Certificate validity. Default: one day ago → one year ahead. */
  readonly notBefore?: Date | undefined;
  readonly notAfter?: Date | undefined;
  readonly commonName?: string | undefined;
  /** Include the ESS signing-certificate-v2 attribute (RFC 5816). Default true. */
  readonly ess?: boolean | undefined;
  /** genTime source. Default `new Date()`. */
  readonly now?: (() => Date) | undefined;
}

export interface StubTsaControl {
  mode: StubTsaMode;
}

export interface StubTsa {
  /** POST endpoint: `http://127.0.0.1:<port>/tsr`. */
  readonly url: string;
  /** The PEM to pin: the self-signed TSA certificate, or the root CA. */
  readonly trustedPem: string;
  /** The TSA signing certificate itself (PEM). */
  readonly signerPem: string;
  readonly control: StubTsaControl;
  /** Requests received (any mode). */
  readonly requests: () => number;
  /** Requests that reached the `redirect` mode's target (an anchor must never follow it). */
  readonly redirectTargetHits: () => number;
  /** Signs a token directly (no HTTP): for verify-only tests. */
  issue(digest: Uint8Array, options?: { nonce?: Uint8Array | undefined }): Promise<Uint8Array>;
  close(): Promise<void>;
}

type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;
const subtle = webcrypto.subtle;

function toPem(der: ArrayBuffer | Uint8Array, label = "CERTIFICATE"): string {
  const b64 = Buffer.from(der instanceof Uint8Array ? der : new Uint8Array(der)).toString("base64");
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)?.join("\n")}\n-----END ${label}-----\n`;
}

function name(cn: string): pkijs.RelativeDistinguishedNames {
  return new pkijs.RelativeDistinguishedNames({
    typesAndValues: [
      new pkijs.AttributeTypeAndValue({
        type: "2.5.4.10",
        value: new asn1js.Utf8String({ value: "fundroom test" }),
      }),
      new pkijs.AttributeTypeAndValue({
        type: "2.5.4.3",
        value: new asn1js.Utf8String({ value: cn }),
      }),
    ],
  });
}

function positiveSerial(): asn1js.Integer {
  const bytes = randomBytes(12);
  bytes[0] = ((bytes[0] ?? 0) & 0x3f) | 0x40;
  return new asn1js.Integer({
    valueHex: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + 12),
  });
}

interface Minted {
  readonly cert: pkijs.Certificate;
  readonly der: Uint8Array;
}

async function mintCertificate(input: {
  subject: string;
  issuer: { name: string; key: CryptoKey } | null;
  publicKey: CryptoKey;
  signingKey: CryptoKey;
  ca: boolean;
  eku: readonly string[] | null;
  ekuCritical?: boolean;
  notBefore: Date;
  notAfter: Date;
}): Promise<Minted> {
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = positiveSerial();
  cert.subject = name(input.subject);
  cert.issuer = name(input.issuer?.name ?? input.subject);
  cert.notBefore.value = input.notBefore;
  cert.notAfter.value = input.notAfter;
  await cert.subjectPublicKeyInfo.importKey(input.publicKey);
  const extensions: pkijs.Extension[] = [];
  extensions.push(
    new pkijs.Extension({
      extnID: "2.5.29.19",
      critical: true,
      extnValue: new pkijs.BasicConstraints({ cA: input.ca }).toSchema().toBER(false),
    }),
  );
  // keyUsage: digitalSignature (leaf) / keyCertSign + cRLSign (CA)
  const usage = new Uint8Array([input.ca ? 0x06 : 0x80]);
  extensions.push(
    new pkijs.Extension({
      extnID: "2.5.29.15",
      critical: true,
      extnValue: new asn1js.BitString({
        valueHex: usage.buffer,
        unusedBits: input.ca ? 1 : 7,
      }).toBER(false),
    }),
  );
  const spki = cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView;
  extensions.push(
    new pkijs.Extension({
      extnID: "2.5.29.14",
      extnValue: new asn1js.OctetString({
        valueHex: createHash("sha1").update(spki).digest(),
      }).toBER(false),
    }),
  );
  if (input.eku !== null) {
    extensions.push(
      new pkijs.Extension({
        extnID: "2.5.29.37",
        critical: input.ekuCritical ?? true,
        extnValue: new pkijs.ExtKeyUsage({ keyPurposes: [...input.eku] }).toSchema().toBER(false),
      }),
    );
  }
  cert.extensions = extensions;
  await cert.sign(input.signingKey, "SHA-256");
  const der = new Uint8Array(cert.toSchema(true).toBER(false));
  return { cert: pkijs.Certificate.fromBER(der), der };
}

async function ecKeyPair(): Promise<CryptoKeyPair> {
  return (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
}

async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > limit) throw new Error("request too large");
    chunks.push(chunk as Buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export async function startStubTsa(options: StubTsaOptions = {}): Promise<StubTsa> {
  const now = options.now ?? (() => new Date());
  const notBefore = options.notBefore ?? new Date(Date.now() - 86_400_000);
  const notAfter = options.notAfter ?? new Date(Date.now() + 365 * 86_400_000);
  const commonName = options.commonName ?? "fundroom stub TSA";
  const tsaKeys = await ecKeyPair();
  let caMinted: Minted | null = null;
  let tsa: Minted;
  if (options.chain === "ca") {
    const caKeys = await ecKeyPair();
    caMinted = await mintCertificate({
      subject: "fundroom stub TSA root",
      issuer: null,
      publicKey: caKeys.publicKey,
      signingKey: caKeys.privateKey,
      ca: true,
      eku: null,
      notBefore,
      notAfter,
    });
    tsa = await mintCertificate({
      subject: commonName,
      issuer: { name: "fundroom stub TSA root", key: caKeys.privateKey },
      publicKey: tsaKeys.publicKey,
      signingKey: caKeys.privateKey,
      ca: false,
      eku: options.eku ?? [OID_KP_TIME_STAMPING],
      ekuCritical: options.ekuCritical ?? true,
      notBefore,
      notAfter,
    });
  } else {
    tsa = await mintCertificate({
      subject: commonName,
      issuer: null,
      publicKey: tsaKeys.publicKey,
      signingKey: tsaKeys.privateKey,
      ca: false,
      eku: options.eku ?? [OID_KP_TIME_STAMPING],
      ekuCritical: options.ekuCritical ?? true,
      notBefore,
      notAfter,
    });
  }

  async function sign(
    imprint: Uint8Array,
    nonce: Uint8Array | undefined,
    includeCerts: boolean,
  ): Promise<Uint8Array> {
    const tstInfo = new pkijs.TSTInfo({
      version: 1,
      policy: STUB_TSA_POLICY,
      messageImprint: new pkijs.MessageImprint({
        hashAlgorithm: new pkijs.AlgorithmIdentifier({
          algorithmId: OID_SHA256,
          algorithmParams: new asn1js.Null(),
        }),
        hashedMessage: new asn1js.OctetString({ valueHex: imprint.slice().buffer }),
      }),
      serialNumber: positiveSerial(),
      genTime: new Date(Math.floor(now().getTime() / 1000) * 1000),
      accuracy: new pkijs.Accuracy({ seconds: 1 }),
      ...(nonce ? { nonce: new asn1js.Integer({ valueHex: nonce.slice().buffer }) } : {}),
    });
    const eContent = tstInfo.toSchema().toBER(false);
    const essCertIdV2 = new asn1js.Sequence({
      value: [
        new asn1js.Sequence({
          value: [
            new asn1js.Sequence({
              value: [
                new asn1js.OctetString({ valueHex: createHash("sha256").update(tsa.der).digest() }),
              ],
            }),
          ],
        }),
      ],
    });
    const signedData = new pkijs.SignedData({
      version: 3,
      encapContentInfo: new pkijs.EncapsulatedContentInfo({
        eContentType: OID_TST_INFO,
        eContent: new asn1js.OctetString({ valueHex: eContent }),
      }),
      signerInfos: [
        new pkijs.SignerInfo({
          version: 1,
          sid: new pkijs.IssuerAndSerialNumber({
            issuer: tsa.cert.issuer,
            serialNumber: tsa.cert.serialNumber,
          }),
          signedAttrs: new pkijs.SignedAndUnsignedAttributes({
            type: 0,
            attributes: [
              new pkijs.Attribute({
                type: OID_ATTR_CONTENT_TYPE,
                values: [new asn1js.ObjectIdentifier({ value: OID_TST_INFO })],
              }),
              new pkijs.Attribute({
                type: OID_ATTR_SIGNING_TIME,
                values: [new asn1js.UTCTime({ valueDate: now() })],
              }),
              new pkijs.Attribute({
                type: OID_ATTR_MESSAGE_DIGEST,
                values: [
                  new asn1js.OctetString({
                    valueHex: createHash("sha256").update(new Uint8Array(eContent)).digest(),
                  }),
                ],
              }),
              ...(options.ess === false
                ? []
                : [new pkijs.Attribute({ type: OID_ATTR_SIGNING_CERT_V2, values: [essCertIdV2] })]),
            ],
          }),
        }),
      ],
      ...(includeCerts ? { certificates: caMinted ? [tsa.cert, caMinted.cert] : [tsa.cert] } : {}),
    });
    await signedData.sign(tsaKeys.privateKey, 0, "SHA-256");
    const contentInfo = new pkijs.ContentInfo({
      contentType: OID_SIGNED_DATA,
      content: signedData.toSchema(true),
    });
    return new Uint8Array(contentInfo.toSchema().toBER(false));
  }

  function response(status: number, token: Uint8Array | null): Uint8Array {
    const parts: asn1js.BaseBlock[] = [
      new asn1js.Sequence({ value: [new asn1js.Integer({ value: status })] }),
    ];
    if (token) parts.push(asn1js.fromBER(token).result);
    return new Uint8Array(new asn1js.Sequence({ value: parts }).toBER(false));
  }

  const control: StubTsaControl = { mode: "ok" };
  let requests = 0;
  let redirectTargetHits = 0;
  const hanging = new Set<ServerResponse>();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requests += 1;
    if (req.url === "/elsewhere") {
      redirectTargetHits += 1;
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST" || req.url !== "/tsr") {
      res.writeHead(404).end();
      return;
    }
    const mode = control.mode;
    if (mode === "hang") {
      hanging.add(res);
      return;
    }
    if (mode === "redirect") {
      res.writeHead(302, { location: "/elsewhere" }).end();
      return;
    }
    if (mode === "error") {
      res.writeHead(500, { "content-type": "text/plain" }).end("boom");
      return;
    }
    if (mode === "oversize") {
      const body = Buffer.alloc(1024 * 1024, 0x30);
      res.writeHead(200, {
        "content-type": "application/timestamp-reply",
        "content-length": body.byteLength,
      });
      res.end(body);
      return;
    }
    if (mode === "oversize-chunked") {
      res.writeHead(200, { "content-type": "application/timestamp-reply" });
      for (let i = 0; i < 64; i++) res.write(Buffer.alloc(16 * 1024, 0x30));
      res.end();
      return;
    }
    if (mode === "garbage") {
      res.writeHead(200, { "content-type": "application/timestamp-reply" }).end("not der");
      return;
    }
    if (req.headers["content-type"] !== "application/timestamp-query") {
      res.writeHead(415).end();
      return;
    }
    const body = await readBody(req);
    let request: pkijs.TimeStampReq;
    try {
      request = pkijs.TimeStampReq.fromBER(body);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const send = (bytes: Uint8Array) => {
      res.writeHead(200, { "content-type": "application/timestamp-reply" });
      res.end(Buffer.from(bytes));
    };
    if (mode === "rejection") return send(response(2, null));
    if (mode === "granted-without-token") return send(response(0, null));
    if (request.messageImprint.hashAlgorithm.algorithmId !== OID_SHA256) {
      return send(response(2, null));
    }
    let imprint = new Uint8Array(request.messageImprint.hashedMessage.valueBlock.valueHexView);
    if (mode === "wrong-imprint")
      imprint = new Uint8Array(createHash("sha256").update(imprint).digest());
    let nonce = request.nonce ? new Uint8Array(request.nonce.valueBlock.valueHexView) : undefined;
    if (mode === "wrong-nonce" && nonce) {
      nonce = nonce.slice();
      nonce[nonce.length - 1] = ((nonce[nonce.length - 1] ?? 0) + 1) & 0xff;
    }
    send(response(0, await sign(imprint, nonce, request.certReq === true)));
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
    url: `http://127.0.0.1:${port}/tsr`,
    trustedPem: toPem(caMinted ? caMinted.der : tsa.der),
    signerPem: toPem(tsa.der),
    control,
    requests: () => requests,
    redirectTargetHits: () => redirectTargetHits,
    issue: (digest, opts) => sign(digest, opts?.nonce, true),
    async close() {
      for (const res of hanging) res.destroy();
      hanging.clear();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
