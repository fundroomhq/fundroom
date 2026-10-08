import {
  constants,
  createHash,
  type KeyObject,
  timingSafeEqual,
  verify as verifySignature,
  X509Certificate,
} from "node:crypto";
import type { AnchorVerification } from "@fundroom/ports";
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";

/*
 * RFC 3161 time-stamp protocol: the request we send and the offline verification of the token a
 * TSA returns (RFC 3161 §2.4, RFC 5816, RFC 5652). Verification is done with node:crypto over the
 * exact bytes the TSA signed; pkijs/asn1js only parse.
 *
 * A token is `verified` when ALL of these hold:
 *   - it is CMS SignedData whose eContentType is id-ct-TSTInfo, with signed attributes whose
 *     content-type is id-ct-TSTInfo and whose message-digest equals the hash of the TSTInfo;
 *   - the TSTInfo imprint is SHA-256 and equals the digest;
 *   - the signer certificate (from the token, or a pinned certificate) matches the SignerInfo
 *     sid AND the ESS signing-certificate(-v2) attribute, verifies the signature, carries exactly
 *     the timeStamping extended key usage, marked critical (RFC 3161 §2.3), and was valid at genTime;
 *   - the signer certificate is pinned, or chains (signature, CA flag, validity at genTime) to a
 *     pinned certificate.
 * Every failure but the last is `failed`; a consistent token whose signer reaches no pinned
 * certificate is `unverified_origin`.
 */

export const OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
export const OID_TST_INFO = "1.2.840.113549.1.9.16.1.4";
const OID_ATTR_CONTENT_TYPE = "1.2.840.113549.1.9.3";
const OID_ATTR_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
const OID_ATTR_SIGNING_CERT = "1.2.840.113549.1.9.16.2.12";
const OID_ATTR_SIGNING_CERT_V2 = "1.2.840.113549.1.9.16.2.47";
const OID_EXT_KEY_USAGE = "2.5.29.37";
const OID_SUBJECT_KEY_ID = "2.5.29.14";
export const OID_KP_TIME_STAMPING = "1.3.6.1.5.5.7.3.8";
export const OID_SHA256 = "2.16.840.1.101.3.4.2.1";

const HASH_BY_OID: Readonly<Record<string, string>> = {
  "1.3.14.3.2.26": "sha1",
  "2.16.840.1.101.3.4.2.1": "sha256",
  "2.16.840.1.101.3.4.2.2": "sha384",
  "2.16.840.1.101.3.4.2.3": "sha512",
};

/** Signature algorithm OID → the hash it implies (undefined: take the SignerInfo digestAlgorithm). */
const SIG_HASH_BY_OID: Readonly<Record<string, string | null>> = {
  "1.2.840.113549.1.1.1": null, // rsaEncryption
  "1.2.840.113549.1.1.5": "sha1",
  "1.2.840.113549.1.1.11": "sha256",
  "1.2.840.113549.1.1.12": "sha384",
  "1.2.840.113549.1.1.13": "sha512",
  "1.2.840.113549.1.1.10": null, // RSASSA-PSS (hash from its parameters)
  "1.2.840.10045.2.1": null, // id-ecPublicKey used as a signature algorithm by some TSAs
  "1.2.840.10045.4.3.2": "sha256",
  "1.2.840.10045.4.3.3": "sha384",
  "1.2.840.10045.4.3.4": "sha512",
  "1.3.101.112": "ed25519",
};

/** A DER TimeStampReq: version 1, SHA-256 imprint, the nonce, certReq TRUE (RFC 3161 §2.4.1). */
export function buildTimeStampRequest(digest: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (digest.byteLength !== 32) throw new RangeError("the digest must be 32 bytes (SHA-256)");
  const request = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({
        algorithmId: OID_SHA256,
        algorithmParams: new asn1js.Null(),
      }),
      hashedMessage: new asn1js.OctetString({ valueHex: copy(digest) }),
    }),
    nonce: new asn1js.Integer({ valueHex: copy(nonce) }),
    certReq: true,
  });
  return new Uint8Array(request.toSchema().toBER(false));
}

/** 8 random bytes whose first byte is 0x40–0x7f: a positive, minimally encoded INTEGER. */
export function nonceFrom(random: Uint8Array): Uint8Array {
  const out = Uint8Array.from(random.subarray(0, 8));
  out[0] = ((out[0] ?? 0) & 0x3f) | 0x40;
  return out;
}

function copy(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function bytesOf(view: ArrayBuffer | Uint8Array): Uint8Array {
  return view instanceof Uint8Array ? view : new Uint8Array(view);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

/** Strips leading zero bytes so INTEGER values compare by magnitude. */
function integerHex(bytes: Uint8Array): string {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return hex(bytes.subarray(i));
}

export class TokenError extends Error {
  override readonly name = "TokenError";
}

export interface ParsedResponse {
  /** PKIStatus: 0 granted, 1 grantedWithMods, ≥ 2 refused. */
  readonly status: number;
  /** The raw DER of the timeStampToken ContentInfo, exactly as the TSA sent it. */
  readonly token: Uint8Array | null;
  readonly statusText: string | null;
}

/** Parses a TimeStampResp, keeping the token's original bytes. Throws `TokenError`. */
export function parseTimeStampResponse(bytes: Uint8Array): ParsedResponse {
  const parsed = asn1js.fromBER(bytes);
  if (parsed.offset === -1 || !(parsed.result instanceof asn1js.Sequence)) {
    throw new TokenError("the response is not a DER TimeStampResp");
  }
  if (parsed.offset !== bytes.byteLength) throw new TokenError("trailing bytes after the response");
  let resp: pkijs.TimeStampResp;
  try {
    resp = new pkijs.TimeStampResp({ schema: parsed.result });
  } catch {
    throw new TokenError("the response is not a TimeStampResp");
  }
  const status = resp.status.status;
  const text = resp.status.statusStrings
    ?.map((s) => String((s as { valueBlock?: { value?: unknown } }).valueBlock?.value ?? ""))
    .join("; ");
  const elements = parsed.result.valueBlock.value;
  const tokenElement = elements[1];
  const token =
    tokenElement === undefined ? null : new Uint8Array(tokenElement.valueBeforeDecodeView).slice();
  return { status, token, statusText: text === undefined || text === "" ? null : text };
}

interface TokenParts {
  readonly signedData: pkijs.SignedData;
  readonly signerInfo: pkijs.SignerInfo;
  readonly tstInfo: pkijs.TSTInfo;
  readonly eContent: Uint8Array;
  /** Raw DER of every certificate the token carries. */
  readonly certs: readonly Uint8Array[];
}

/** Raw DER of the `certificates [0]` set of a SignedData (asn1js keeps the original bytes). */
function rawCertificates(signedDataSchema: asn1js.Sequence): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const element of signedDataSchema.valueBlock.value) {
    if (element.idBlock.tagClass === 3 && element.idBlock.tagNumber === 0) {
      const children = (element as asn1js.Constructed).valueBlock.value ?? [];
      for (const child of children) {
        // Only plain certificates (a SEQUENCE); attribute / other certificate formats are skipped.
        if (child.idBlock.tagClass === 1 && child.idBlock.tagNumber === 16) {
          out.push(new Uint8Array(child.valueBeforeDecodeView).slice());
        }
      }
    }
  }
  return out;
}

function parseToken(token: Uint8Array): TokenParts {
  const parsed = asn1js.fromBER(token);
  if (parsed.offset === -1 || parsed.offset !== token.byteLength) {
    throw new TokenError("the token is not DER");
  }
  let contentInfo: pkijs.ContentInfo;
  try {
    contentInfo = new pkijs.ContentInfo({ schema: parsed.result });
  } catch {
    throw new TokenError("the token is not a CMS ContentInfo");
  }
  if (contentInfo.contentType !== OID_SIGNED_DATA) {
    throw new TokenError("the token is not CMS SignedData");
  }
  let signedData: pkijs.SignedData;
  try {
    signedData = new pkijs.SignedData({ schema: contentInfo.content });
  } catch {
    throw new TokenError("the token's SignedData does not parse");
  }
  if (signedData.encapContentInfo.eContentType !== OID_TST_INFO) {
    throw new TokenError("the token does not encapsulate a TSTInfo");
  }
  const eContentOctets = signedData.encapContentInfo.eContent;
  if (!eContentOctets) throw new TokenError("the token's TSTInfo is empty");
  const eContent = bytesOf(eContentOctets.getValue()).slice();
  let tstInfo: pkijs.TSTInfo;
  try {
    tstInfo = pkijs.TSTInfo.fromBER(eContent);
  } catch {
    throw new TokenError("the TSTInfo does not parse");
  }
  if (signedData.signerInfos.length !== 1) {
    throw new TokenError("a time-stamp token must have exactly one signer");
  }
  const signerInfo = signedData.signerInfos[0] as pkijs.SignerInfo;
  return {
    signedData,
    signerInfo,
    tstInfo,
    eContent,
    certs: rawCertificates(contentInfo.content as asn1js.Sequence),
  };
}

interface CertInfo {
  readonly der: Uint8Array;
  readonly node: X509Certificate;
  readonly pkijs: pkijs.Certificate;
}

function certInfo(der: Uint8Array): CertInfo | null {
  try {
    return { der, node: new X509Certificate(der), pkijs: pkijs.Certificate.fromBER(der) };
  } catch {
    return null;
  }
}

/** Parses a PEM bundle (any number of CERTIFICATE blocks) into certificates; junk is skipped. */
export function certificatesFromPems(pems: readonly string[]): CertInfo[] {
  const out: CertInfo[] = [];
  for (const pem of pems) {
    const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    for (const block of blocks) {
      const body = block.replace(/-----(BEGIN|END) CERTIFICATE-----/g, "").replace(/\s+/g, "");
      const info = certInfo(new Uint8Array(Buffer.from(body, "base64")));
      if (info) out.push(info);
    }
  }
  return out;
}

function signedAttribute(signerInfo: pkijs.SignerInfo, oid: string): pkijs.Attribute | undefined {
  return signerInfo.signedAttrs?.attributes.find((a) => a.type === oid);
}

function matchesSid(signerInfo: pkijs.SignerInfo, cert: CertInfo): boolean {
  const sid = signerInfo.sid as unknown;
  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    return (
      cert.pkijs.issuer.isEqual(sid.issuer) && cert.pkijs.serialNumber.isEqual(sid.serialNumber)
    );
  }
  // [0] SubjectKeyIdentifier
  const block = sid as asn1js.BaseBlock & {
    valueBlock: { valueHexView?: Uint8Array; value?: asn1js.BaseBlock[] };
  };
  const keyId = block.idBlock.isConstructed
    ? (block.valueBlock.value?.[0] as { valueBlock: { valueHexView: Uint8Array } } | undefined)
        ?.valueBlock.valueHexView
    : block.valueBlock.valueHexView;
  if (keyId === undefined) return false;
  const ski = cert.pkijs.extensions?.find((e) => e.extnID === OID_SUBJECT_KEY_ID);
  if (ski) {
    const parsed = asn1js.fromBER(ski.extnValue.valueBlock.valueHexView);
    if (parsed.offset !== -1 && parsed.result instanceof asn1js.OctetString) {
      return equalBytes(new Uint8Array(parsed.result.valueBlock.valueHexView), keyId);
    }
  }
  const spkiBits = cert.pkijs.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView;
  return equalBytes(new Uint8Array(createHash("sha1").update(spkiBits).digest()), keyId);
}

/** ESS signing-certificate(-v2): the hash of the signer certificate the TSA committed to. */
function essCertHash(signerInfo: pkijs.SignerInfo): { hash: string; value: Uint8Array } | null {
  const v2 = signedAttribute(signerInfo, OID_ATTR_SIGNING_CERT_V2);
  const v1 = signedAttribute(signerInfo, OID_ATTR_SIGNING_CERT);
  const attr = v2 ?? v1;
  if (!attr) return null;
  const signingCertificate = attr.values[0] as asn1js.Sequence | undefined;
  const certs = signingCertificate?.valueBlock.value[0] as asn1js.Sequence | undefined;
  const first = certs?.valueBlock.value[0] as asn1js.Sequence | undefined;
  if (!first || !(first instanceof asn1js.Sequence)) return null;
  const parts = first.valueBlock.value;
  let hash = v2 ? "sha256" : "sha1";
  let index = 0;
  if (v2 && parts[0] instanceof asn1js.Sequence) {
    const algorithm = new pkijs.AlgorithmIdentifier({ schema: parts[0] });
    const named = HASH_BY_OID[algorithm.algorithmId];
    if (named === undefined) return null;
    hash = named;
    index = 1;
  }
  const octets = parts[index];
  if (!(octets instanceof asn1js.OctetString)) return null;
  return { hash, value: new Uint8Array(octets.valueBlock.valueHexView) };
}

function signatureVerifies(signerInfo: pkijs.SignerInfo, cert: CertInfo): boolean {
  const signedAttrs = signerInfo.signedAttrs;
  if (!signedAttrs) return false;
  const data = bytesOf(signedAttrs.encodedValue); // already re-tagged as SET OF (0x31)
  const signature = new Uint8Array(signerInfo.signature.valueBlock.valueHexView);
  const sigOid = signerInfo.signatureAlgorithm.algorithmId;
  if (!(sigOid in SIG_HASH_BY_OID)) return false;
  const implied = SIG_HASH_BY_OID[sigOid];
  const digestHash = HASH_BY_OID[signerInfo.digestAlgorithm.algorithmId];
  const key: KeyObject = cert.node.publicKey;
  try {
    if (implied === "ed25519") return verifySignature(null, data, key, signature);
    if (sigOid === "1.2.840.113549.1.1.10") {
      const params = new pkijs.RSASSAPSSParams({
        schema: signerInfo.signatureAlgorithm.algorithmParams,
      });
      const hash = HASH_BY_OID[params.hashAlgorithm.algorithmId];
      if (hash === undefined) return false;
      return verifySignature(
        hash,
        data,
        { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: params.saltLength },
        signature,
      );
    }
    const hash = implied ?? digestHash;
    if (hash === undefined) return false;
    return verifySignature(hash, data, key, signature);
  } catch {
    return false;
  }
}

function validAt(cert: X509Certificate, at: Date): boolean {
  return cert.validFromDate.getTime() <= at.getTime() && at.getTime() <= cert.validToDate.getTime();
}

/** Does `cert` reach a pinned certificate through `pool` (signature + CA flag + validity at `at`)? */
function chainsToPinned(
  cert: CertInfo,
  pool: readonly CertInfo[],
  pinned: readonly CertInfo[],
  at: Date,
  depth = 0,
): boolean {
  if (pinned.some((p) => equalBytes(p.der, cert.der))) return true;
  if (depth >= 6) return false;
  for (const issuer of pool) {
    if (equalBytes(issuer.der, cert.der)) continue;
    if (!issuer.node.ca || !validAt(issuer.node, at)) continue;
    let ok = false;
    try {
      ok = cert.node.checkIssued(issuer.node) && cert.node.verify(issuer.node.publicKey);
    } catch {
      ok = false;
    }
    if (ok && chainsToPinned(issuer, pool, pinned, at, depth + 1)) return true;
  }
  return false;
}

function subjectCn(cert: X509Certificate): string {
  const cn = cert.subject.split("\n").find((line) => line.startsWith("CN="));
  return cn ? cn.slice(3) : cert.subject.replace(/\n/g, ", ");
}

export interface TokenFacts {
  readonly genTime: Date;
  readonly serialHex: string;
  readonly nonceHex: string | null;
  readonly policy: string;
  readonly signer: string;
}

export type TokenVerification = AnchorVerification & { readonly facts?: TokenFacts };

/**
 * Verifies a DER time-stamp token over `digest` against the pinned PEMs. Offline, never throws.
 */
export function verifyTimeStampToken(
  digest: Uint8Array,
  token: Uint8Array,
  pinnedPems: readonly string[],
): TokenVerification {
  const failed = (detail: string): TokenVerification => ({ status: "failed", detail });
  if (digest.byteLength !== 32) return failed("the digest is not 32 bytes");
  let parts: TokenParts;
  try {
    parts = parseToken(token);
  } catch (error) {
    return failed(error instanceof TokenError ? error.message : "the token does not parse");
  }
  const { signerInfo, tstInfo, eContent } = parts;

  // The imprint: SHA-256 of exactly our digest.
  if (tstInfo.messageImprint.hashAlgorithm.algorithmId !== OID_SHA256) {
    return failed("the token's imprint is not SHA-256");
  }
  const imprint = new Uint8Array(tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView);
  if (!equalBytes(imprint, digest)) return failed("the token's imprint does not match the digest");

  // Signed attributes: content-type and message-digest bind the TSTInfo.
  if (!signerInfo.signedAttrs) return failed("the token has no signed attributes");
  const contentType = signedAttribute(signerInfo, OID_ATTR_CONTENT_TYPE)?.values[0] as
    | asn1js.ObjectIdentifier
    | undefined;
  if (!(contentType instanceof asn1js.ObjectIdentifier)) {
    return failed("the token's content-type attribute is missing");
  }
  if (contentType.valueBlock.toString() !== OID_TST_INFO) {
    return failed("the token's content-type attribute is not TSTInfo");
  }
  const digestHash = HASH_BY_OID[signerInfo.digestAlgorithm.algorithmId];
  if (digestHash === undefined) return failed("the token uses an unsupported digest algorithm");
  const messageDigest = signedAttribute(signerInfo, OID_ATTR_MESSAGE_DIGEST)?.values[0] as
    | asn1js.OctetString
    | undefined;
  if (!(messageDigest instanceof asn1js.OctetString)) {
    return failed("the token's message-digest attribute is missing");
  }
  const expectedDigest = new Uint8Array(createHash(digestHash).update(eContent).digest());
  if (!equalBytes(new Uint8Array(messageDigest.valueBlock.valueHexView), expectedDigest)) {
    return failed("the token's message-digest does not match its TSTInfo");
  }

  // The signer: in the token (certReq) or pinned; must match the sid AND the ESS attribute.
  const tokenCerts = parts.certs.map(certInfo).filter((c): c is CertInfo => c !== null);
  const pinned = certificatesFromPems(pinnedPems);
  const ess = essCertHash(signerInfo);
  if (!ess) return failed("the token has no ESS signing-certificate attribute");
  const candidates = [...tokenCerts, ...pinned].filter((c) => matchesSid(signerInfo, c));
  const signer = candidates.find((c) =>
    equalBytes(new Uint8Array(createHash(ess.hash).update(c.der).digest()), ess.value),
  );
  if (!signer) {
    return failed(
      candidates.length === 0
        ? "the token's signer certificate is not available"
        : "the signer certificate does not match the ESS signing-certificate attribute",
    );
  }
  if (!signatureVerifies(signerInfo, signer)) return failed("the token's signature is invalid");

  const eku = signer.pkijs.extensions?.find((e) => e.extnID === OID_EXT_KEY_USAGE);
  const purposes = (eku?.parsedValue as pkijs.ExtKeyUsage | undefined)?.keyPurposes ?? [];
  if (!purposes.includes(OID_KP_TIME_STAMPING)) {
    return failed("the signer certificate lacks the timeStamping extended key usage");
  }
  // RFC 3161 §2.3: the TSA certificate MUST carry exactly one EKU, id-kp-timeStamping, critical.
  // (Sigstore, FreeTSA and DigiCert signer certificates all do — checked live 2026-10-01.) Without
  // this a pinned root that also issues multi-purpose certificates could mint "trusted" time.
  if (purposes.length !== 1 || eku?.critical !== true) {
    return failed(
      "the signer certificate's extended key usage must be exactly timeStamping, marked critical",
    );
  }
  const genTime = tstInfo.genTime;
  if (!(genTime instanceof Date) || Number.isNaN(genTime.getTime())) {
    return failed("the token has no valid genTime");
  }
  if (!validAt(signer.node, genTime)) {
    return failed("the signer certificate was not valid at the token's genTime");
  }

  const facts: TokenFacts = {
    genTime,
    serialHex: integerHex(new Uint8Array(tstInfo.serialNumber.valueBlock.valueHexView)),
    nonceHex: tstInfo.nonce
      ? integerHex(new Uint8Array(tstInfo.nonce.valueBlock.valueHexView))
      : null,
    policy: tstInfo.policy,
    signer: subjectCn(signer.node),
  };
  const pool = [...tokenCerts, ...pinned];
  if (!chainsToPinned(signer, pool, pinned, genTime)) {
    return {
      status: "unverified_origin",
      detail: `signed by "${facts.signer}", which does not chain to a pinned certificate`,
      facts,
    };
  }
  return {
    status: "verified",
    anchoredAt: genTime.toISOString(),
    detail: `time-stamped by "${facts.signer}" (serial ${facts.serialHex})`,
    facts,
  };
}

export function nonceHexOf(nonce: Uint8Array): string {
  return integerHex(nonce);
}
