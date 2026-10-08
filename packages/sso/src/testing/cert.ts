import { generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

/*
 * A self-signed X.509 certificate for test IdPs, built with node:crypto and a few lines of DER —
 * no fixture key material in the repository (gitleaks), no extra dependency. Test-only.
 */

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), len(value.length), value]);
}

const seq = (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts));

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)];
  for (const p of parts.slice(2)) {
    const stack: number[] = [p & 0x7f];
    let v = p >> 7;
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    out.push(...stack);
  }
  return tlv(0x06, Buffer.from(out));
}

function integer(bytes: Buffer): Buffer {
  const b = (bytes[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return tlv(0x02, b);
}

function utcTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, "ascii"));
}

function name(cn: string): Buffer {
  return seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn, "utf8")))));
}

export interface TestCertificate {
  readonly certPem: string;
  readonly keyPem: string;
  readonly privateKey: KeyObject;
}

export function selfSignedCertificate(
  options: {
    readonly commonName?: string;
    readonly bits?: number;
    readonly notBefore?: Date;
    readonly notAfter?: Date;
  } = {},
): TestCertificate {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: options.bits ?? 2048,
  });
  const algorithm = seq(oid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00]));
  const subject = name(options.commonName ?? "fundroom test IdP");
  const notBefore = options.notBefore ?? new Date(Date.now() - 60 * 60_000);
  const notAfter = options.notAfter ?? new Date(Date.now() + 365 * 24 * 60 * 60_000);
  const serial = randomBytes(8);
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(serial),
    algorithm,
    subject,
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, privateKey);
  const der = seq(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const body =
    der
      .toString("base64")
      .match(/.{1,64}/gu)
      ?.join("\n") ?? "";
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    privateKey,
  };
}
