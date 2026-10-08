import { createVerify, X509Certificate } from "node:crypto";
import type { OutboundFetch } from "@fundroom/ports";

/*
 * Amazon SNS HTTP(S) message verification (docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html).
 *
 * The body of an SNS delivery is JSON carrying its own RSA signature and the URL of the
 * certificate that made it. Everything that makes that trustworthy lives in which certificate we
 * are willing to fetch, so the rules are strict and in this order:
 *
 *  1. `TopicArn` must be one the operator listed (`SES_SNS_TOPIC_ARNS`). Anyone can create an SNS
 *     topic and subscribe our URL to it; a valid AWS signature proves only that *some* topic
 *     sent it. The region comes from this (already allow-listed) ARN.
 *  2. `SigningCertURL` must be exactly `https://sns.<that region>.amazonaws.com/SimpleNotificationService-<hex>.pem`
 *     — the one path shape SNS signs with; no port, no credentials, no query, no other path. A
 *     certificate from anywhere else is never fetched, which is what stops an attacker signing a
 *     forged body with their own key and pointing at their own cert.
 *  3. The certificate (fetched over the SSRF-guarded client, TLS-verified) must be inside its
 *     validity window; the signature over the canonical string is verified with SHA1
 *     (`SignatureVersion` 1) or SHA256 (2).
 *
 * The fetch happens *before* the signature can be checked (the certificate is what checks it),
 * so an unauthenticated body can make us fetch — but only an AWS-hosted SNS certificate URL for
 * an allow-listed topic's region. Two caches keep that from being a lever: successful
 * certificates in a small LRU (a flood of distinct `<hex>` names evicts the least recently used,
 * never the whole cache, so the genuine certificate stays hot), and failed URLs in a short
 * negative cache so the same bogus name is fetched at most once per `CERT_FAILURE_TTL_MS`.
 *  4. `Timestamp` must be within `maxAgeMs` of our clock (replay window).
 */

export type SnsMessageType =
  | "Notification"
  | "SubscriptionConfirmation"
  | "UnsubscribeConfirmation";

export interface SnsMessage {
  readonly Type: SnsMessageType;
  readonly MessageId: string;
  readonly TopicArn: string;
  readonly Message: string;
  readonly Timestamp: string;
  readonly Subject?: string | undefined;
  readonly Token?: string | undefined;
  readonly SubscribeURL?: string | undefined;
  readonly SignatureVersion: "1" | "2";
  readonly Signature: string;
  readonly SigningCertURL: string;
}

export type SnsVerifyResult =
  | { readonly ok: true; readonly message: SnsMessage; readonly region: string }
  | { readonly ok: false; readonly reason: SnsRejection };

export type SnsRejection =
  | "malformed"
  | "topic_not_allowed"
  | "cert_url_not_allowed"
  | "cert_unavailable"
  | "cert_expired"
  | "stale"
  | "bad_signature";

const TOPIC_ARN_RE = /^arn:aws(?:-[a-z]+)?:sns:([a-z0-9-]+):\d{12}:[A-Za-z0-9_-]{1,256}$/u;
const MESSAGE_TYPES = new Set([
  "Notification",
  "SubscriptionConfirmation",
  "UnsubscribeConfirmation",
]);
/** Bound the certificate LRU; SNS rotates its certificate rarely and uses one per region. */
export const CERT_CACHE_MAX = 16;
/** How long a certificate URL that failed to fetch or parse is not fetched again. */
export const CERT_FAILURE_TTL_MS = 60_000;
/** Bound the negative cache the same way. */
const CERT_FAILURE_MAX = 256;
/** The only certificate path SNS uses. */
const SNS_CERT_PATH_RE = /^\/SimpleNotificationService-[0-9a-f]{8,64}\.pem$/iu;

/** A signing-certificate URL SNS could have minted for `region`. */
export function isSnsCertUrl(raw: string, region: string): boolean {
  if (!isSnsUrl(raw, region, ".pem")) return false;
  return SNS_CERT_PATH_RE.test(new URL(raw).pathname);
}

/** Region of an SNS topic ARN, or `undefined` if it is not one. */
export function topicRegion(arn: string): string | undefined {
  return TOPIC_ARN_RE.exec(arn)?.[1];
}

/** `https://sns.<region>.amazonaws.com/…` and nothing else: no port, userinfo, query or fragment. */
export function isSnsUrl(raw: string, region: string, pathSuffix?: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === `sns.${region}.amazonaws.com` &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    (pathSuffix === undefined || (url.search === "" && url.pathname.endsWith(pathSuffix)))
  );
}

function asMessage(payload: unknown): SnsMessage | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  for (const k of [
    "Type",
    "MessageId",
    "TopicArn",
    "Message",
    "Timestamp",
    "Signature",
    "SigningCertURL",
  ]) {
    if (typeof p[k] !== "string") return undefined;
  }
  if (!MESSAGE_TYPES.has(p["Type"] as string)) return undefined;
  if (p["SignatureVersion"] !== "1" && p["SignatureVersion"] !== "2") return undefined;
  for (const k of ["Subject", "Token", "SubscribeURL"]) {
    if (p[k] !== undefined && p[k] !== null && typeof p[k] !== "string") return undefined;
  }
  return payload as SnsMessage;
}

/** The canonical "Key\nValue\n" string SNS signs, per message type. */
export function stringToSign(m: SnsMessage): string {
  const keys: (keyof SnsMessage)[] =
    m.Type === "Notification"
      ? [
          "Message",
          "MessageId",
          ...(typeof m.Subject === "string" ? (["Subject"] as const) : []),
          "Timestamp",
          "TopicArn",
          "Type",
        ]
      : ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"];
  return keys.map((k) => `${k}\n${String(m[k] ?? "")}\n`).join("");
}

export interface SnsVerifierOptions {
  readonly allowedTopicArns: readonly string[];
  readonly fetch: OutboundFetch;
  readonly now: () => Date;
  /** Replay window for `Timestamp`. */
  readonly maxAgeMs: number;
}

export interface SnsVerifier {
  verify(rawBody: string): Promise<SnsVerifyResult>;
}

export function createSnsVerifier(options: SnsVerifierOptions): SnsVerifier {
  const allowed = new Set(options.allowedTopicArns);
  // Map iteration order is insertion order: re-inserting on a hit makes the first key the LRU.
  const certs = new Map<string, X509Certificate>();
  const failures = new Map<string, number>();

  function failed(url: string, at: number): undefined {
    failures.delete(url);
    if (failures.size >= CERT_FAILURE_MAX) {
      const oldest = failures.keys().next().value;
      if (oldest !== undefined) failures.delete(oldest);
    }
    failures.set(url, at + CERT_FAILURE_TTL_MS);
    return undefined;
  }

  async function certificate(url: string, at: number): Promise<X509Certificate | undefined> {
    const cached = certs.get(url);
    if (cached !== undefined) {
      certs.delete(url);
      certs.set(url, cached);
      return cached;
    }
    const retryAt = failures.get(url);
    if (retryAt !== undefined) {
      if (at < retryAt) return undefined;
      failures.delete(url);
    }
    try {
      const response = await options.fetch(url, { method: "GET", headers: { accept: "*/*" } });
      if (!response.ok) {
        response.body?.cancel().catch(() => {});
        return failed(url, at);
      }
      const cert = new X509Certificate(await response.text());
      if (certs.size >= CERT_CACHE_MAX) {
        const lru = certs.keys().next().value;
        if (lru !== undefined) certs.delete(lru);
      }
      certs.set(url, cert);
      return cert;
    } catch {
      return failed(url, at);
    }
  }

  return {
    async verify(rawBody) {
      let payload: unknown;
      try {
        payload = JSON.parse(rawBody) as unknown;
      } catch {
        return { ok: false, reason: "malformed" };
      }
      const message = asMessage(payload);
      if (message === undefined) return { ok: false, reason: "malformed" };
      const region = topicRegion(message.TopicArn);
      if (region === undefined || !allowed.has(message.TopicArn)) {
        return { ok: false, reason: "topic_not_allowed" };
      }
      if (!isSnsCertUrl(message.SigningCertURL, region)) {
        return { ok: false, reason: "cert_url_not_allowed" };
      }
      const at = options.now().getTime();
      const sentAt = Date.parse(message.Timestamp);
      if (!Number.isFinite(sentAt) || at - sentAt > options.maxAgeMs || sentAt - at > 5 * 60_000) {
        return { ok: false, reason: "stale" };
      }
      const cert = await certificate(message.SigningCertURL, at);
      if (cert === undefined) return { ok: false, reason: "cert_unavailable" };
      if (at < Date.parse(cert.validFrom) || at > Date.parse(cert.validTo)) {
        return { ok: false, reason: "cert_expired" };
      }
      let valid = false;
      try {
        valid = createVerify(message.SignatureVersion === "1" ? "RSA-SHA1" : "RSA-SHA256")
          .update(stringToSign(message), "utf8")
          .verify(cert.publicKey, message.Signature, "base64");
      } catch {
        valid = false;
      }
      if (!valid) return { ok: false, reason: "bad_signature" };
      return { ok: true, message, region };
    },
  };
}
