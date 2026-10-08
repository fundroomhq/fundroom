import { createHash, createHmac } from "node:crypto";

/*
 * AWS Signature Version 4, header form (docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv.html).
 *
 * Hand-rolled on `node:crypto` because the alternative is the AWS SDK: a large transitive tree,
 * a credential-provider chain that probes the instance metadata endpoint (169.254.169.254 — an
 * SSRF shape the outbound guard exists to refuse) and a global HTTP client. SES needs one signed
 * POST and one signed GET; this file is the whole of it, and `sigv4.test.ts` pins it to AWS's
 * published test vectors.
 */

export interface AwsCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** STS session token; sent as `x-amz-security-token` and signed. */
  readonly sessionToken?: string | undefined;
}

export interface SignableRequest {
  readonly method: string;
  readonly url: URL;
  /** Header names are case-insensitive; they are lower-cased for signing. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface SignOptions {
  readonly region: string;
  readonly service: string;
  readonly credentials: AwsCredentials;
  readonly now: Date;
}

const sha256Hex = (data: string): string => createHash("sha256").update(data, "utf8").digest("hex");
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data, "utf8").digest();

/** RFC 3986 unreserved characters stay; everything else is `%XX`, upper-case hex. */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `20150830T123600Z` */
export function amzDate(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
}

/** kSigning = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request") */
export function signingKey(secret: string, date: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function canonicalUri(url: URL): string {
  // Non-S3 services: each segment URI-encoded (the path is already percent-encoded by `URL`,
  // so decode first to encode exactly once more — AWS's "double encoding" rule).
  const path = url.pathname === "" ? "/" : url.pathname;
  return path
    .split("/")
    .map((segment) => uriEncode(uriEncode(decodeURIComponent(segment))))
    .join("/");
}

function canonicalQuery(url: URL): string {
  const pairs = [...url.searchParams.entries()].map(
    ([k, v]) => [uriEncode(k), uriEncode(v)] as const,
  );
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

export interface SignedParts {
  readonly canonicalRequest: string;
  readonly stringToSign: string;
  readonly signature: string;
  readonly authorization: string;
  /** Every header to send: the caller's, plus `host`, `x-amz-date` and the session token. */
  readonly headers: Record<string, string>;
}

export function signRequest(request: SignableRequest, options: SignOptions): SignedParts {
  const stamp = amzDate(options.now);
  const date = stamp.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers)) {
    headers[name.toLowerCase()] = value;
  }
  headers["host"] = request.url.host;
  headers["x-amz-date"] = stamp;
  if (options.credentials.sessionToken !== undefined) {
    headers["x-amz-security-token"] = options.credentials.sessionToken;
  }
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names
    .map((n) => `${n}:${(headers[n] ?? "").trim().replace(/\s+/gu, " ")}\n`)
    .join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalUri(request.url),
    canonicalQuery(request.url),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(request.body),
  ].join("\n");
  const scope = `${date}/${options.region}/${options.service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signature = createHmac(
    "sha256",
    signingKey(options.credentials.secretAccessKey, date, options.region, options.service),
  )
    .update(stringToSign, "utf8")
    .digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  headers["authorization"] = authorization;
  return { canonicalRequest, stringToSign, signature, authorization, headers };
}
