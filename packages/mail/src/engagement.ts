import type { MailDeliveryEvent } from "@fundroom/ports";

/*
 * Is this open or click a person, or a machine acting on the mailbox's behalf? (E2.6, design/04 §3.2)
 *
 * Opens and clicks are stored either way — an admin looking at "why does this investor show 40
 * opens?" deserves the evidence — but only human ones count toward "human opens" and hot-list
 * scores. The verdict folds four signals, strongest first:
 *
 *  1. `provider` — the ESP itself says so (Postmark's `MachineOpen`-style flags, a future SES
 *     field). The provider saw the request; we only see its summary, so it wins.
 *  2. `mpp` — Apple Mail Privacy Protection. With MPP on (the default since iOS 15), Apple's proxy
 *     fetches every remote image as soon as the message lands, whether or not anybody reads it.
 *     The proxy identifies itself as a bare `Mozilla/5.0`, or as Apple's WebKit *without* the
 *     `Version/… Safari/…` tokens a browser sends. An Apple Mail client with MPP off loads images
 *     with the same WebKit string, so this over-flags a little on purpose: counting a prefetch as
 *     interest is the error that misleads a founder, flagging a real Apple Mail open is the cheap one.
 *     Opens only — a click is a real navigation, and Safari sends its full user agent.
 *  3. `scanner` — link scanners and security gateways (Microsoft Safe Links, Proofpoint, Mimecast,
 *     Barracuda…) and generic HTTP clients. They open *and* click, usually within seconds.
 *  4. `too_fast` — a click that lands within `TOO_FAST_CLICK_MS` of the send. No reader opens a
 *     message and chooses a link that quickly; a scanner that hides its user agent does.
 *
 *  5. `unverified` — an *open* with no user agent and no provider verdict. Nothing shows a person
 *     opened it: Resend's open webhook carries neither, and an MPP prefetch or a scanner looks
 *     exactly the same. Counting it would inflate "human opens" for every Resend install, so it
 *     is stored flagged. (A click without a user agent is still a navigation and stays human
 *     unless it is too fast.) A provider that says `machine: false` has vouched for the open.
 *
 * Mail clients that fetch images *on open* through their own proxy are human opens, and must not
 * trip the scanner list: Outlook desktop (`… ms-office; MSOffice 16`, `Microsoft Office/16.0 …
 * Microsoft Outlook …`), Gmail's image proxy (`… (via ggpht.com GoogleImageProxy)` — Gmail
 * fetches when the reader opens the message, then caches, so the *first* open is real), and
 * Yahoo's `YahooMailProxy` (same model). That is why the Office tokens (`ms-office`, protocol /
 * existence discovery) are *click-only* scanner tokens: on a click they are Office's link
 * pre-check, on an open they are Outlook rendering the message for its reader.
 *
 * Pure, synchronous and total.
 */

export type EngagementReason = "provider" | "mpp" | "scanner" | "too_fast" | "unverified";

export interface EngagementVerdict {
  readonly automated: boolean;
  readonly reason: EngagementReason | null;
}

/** A click within this long after `sentAt` is a machine's. */
export const TOO_FAST_CLICK_MS = 10_000;

/** Longest link `stripLink` returns; analytics stores it per event. */
export const LINK_MAX_LENGTH = 500;

const HUMAN: EngagementVerdict = { automated: false, reason: null };

/** Apple's image proxy: a bare `Mozilla/5.0`, or Apple WebKit with no browser tokens after it. */
const MPP_BARE_RE = /^Mozilla\/5\.0$/u;
const MPP_WEBKIT_RE =
  /^Mozilla\/5\.0 \((?:Macintosh|iPhone|iPad|iPod)[^)]*\) AppleWebKit\/[\d.]+ \(KHTML, like Gecko\)(?: Mobile\/\w+)?$/u;

/**
 * Link scanners, security gateways, link-preview bots and bare HTTP clients. Matched as whole
 * words where a short token could appear inside a real browser string.
 */
const SCANNER_RE = new RegExp(
  [
    String.raw`\bbot\b`,
    "bot/",
    "crawler",
    "spider",
    "scanner",
    "barracuda",
    "mimecast",
    "proofpoint",
    "urldefense",
    "safelinks",
    "ironport",
    "messagelabs",
    "symantec",
    "trendmicro",
    "trend micro",
    "forcepoint",
    "fortiguard",
    "sophos",
    "cisco",
    "zscaler",
    "headlesschrome",
    "phantomjs",
    "python-requests",
    "python-urllib",
    "aiohttp",
    String.raw`\bcurl/`,
    String.raw`\bwget/`,
    "go-http-client",
    "okhttp",
    String.raw`\bjava/`,
    "apache-httpclient",
    "libwww-perl",
    "node-fetch",
    "axios/",
    "undici",
    "facebookexternalhit",
    "slackbot",
    "linkedinbot",
    "twitterbot",
    "whatsapp",
    "skypeuripreview",
  ].join("|"),
  "iu",
);

/**
 * Office's link pre-checks: a scanner on a click, but Outlook desktop's own user agent on an
 * image fetch (an open), so matched for clicks only.
 */
const CLICK_ONLY_SCANNER_RE =
  /microsoft office protocol discovery|microsoft office existence discovery|\bms-office\b/iu;

export interface ClassifyOptions {
  /** When the message was accepted by the provider (`core.mail_message.sent_at`). */
  readonly sentAt?: Date | undefined;
}

export function classifyEngagement(
  event: Pick<MailDeliveryEvent, "kind" | "machine" | "userAgent" | "occurredAt">,
  options: ClassifyOptions = {},
): EngagementVerdict {
  if (event.kind !== "open" && event.kind !== "click") return HUMAN;
  if (event.machine === true) return { automated: true, reason: "provider" };

  const ua = event.userAgent?.trim();
  if (ua !== undefined && ua.length > 0) {
    if (event.kind === "open" && (MPP_BARE_RE.test(ua) || MPP_WEBKIT_RE.test(ua))) {
      return { automated: true, reason: "mpp" };
    }
    if (SCANNER_RE.test(ua)) return { automated: true, reason: "scanner" };
    if (event.kind === "click" && CLICK_ONLY_SCANNER_RE.test(ua)) {
      return { automated: true, reason: "scanner" };
    }
  } else if (event.kind === "open" && event.machine !== false) {
    return { automated: true, reason: "unverified" };
  }

  if (event.kind === "click" && options.sentAt !== undefined) {
    const elapsed = event.occurredAt.getTime() - options.sentAt.getTime();
    // A click stamped *before* the send is clock skew between us and the provider, not a
    // time machine; treat it as instant.
    if (elapsed < TOO_FAST_CLICK_MS) return { automated: true, reason: "too_fast" };
  }
  return HUMAN;
}

export interface StripLinkOptions {
  /**
   * Origins that are this product's own (the instance base URL, the workspace's host). A link on
   * any *other* origin is reduced to its origin: a third-party path can carry anything (a Google
   * Docs id, a Calendly slug, a signed S3 key), and "they clicked the link to docs.google.com"
   * is all analytics needs. When omitted every origin keeps its (redacted) path — callers
   * re-stripping an already-stripped link rely on that being idempotent.
   */
  readonly ownOrigins?: readonly string[] | undefined;
}

/** Path segments of this product's routes that carry a bearer token or a personal action. */
const TOKEN_ROUTE_SEGMENT = "s";
const UNSUBSCRIBE_SEGMENT = "unsubscribe";
const API_SEGMENT = "api";
/** A long opaque segment (base64url/hex, letters *and* digits): a token, whatever route it is on. */
const OPAQUE_SEGMENT_RE = /^(?=[A-Za-z0-9_-]*[0-9])(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}$/u;
const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function lowerSegment(segment: string): string {
  try {
    return decodeURIComponent(segment).toLowerCase();
  } catch {
    return segment.toLowerCase();
  }
}

/**
 * This product's token routes, wherever they sit under a base path or a `/w/<slug>` prefix:
 *  - `…/s/<token>` (share links, E2.3) → `…/s/:token`
 *  - `…/api/…` (every API route: chart images `/api/v1/metrics/chart/<token>.png`, the
 *    one-click unsubscribe endpoint, anything a future email links to) → `…/api/:redacted`
 *  - `…/unsubscribe…` → `…/unsubscribe`
 *  - any other long opaque segment → `:token` (uuids are resource ids and are kept).
 */
function redactPath(pathname: string): string {
  const out: string[] = [];
  const segments = pathname.split("/").slice(1);
  for (let i = 0; i < segments.length; i++) {
    const raw = segments[i] ?? "";
    const seg = lowerSegment(raw);
    if (seg === API_SEGMENT) {
      out.push(API_SEGMENT, ":redacted");
      break;
    }
    if (seg === UNSUBSCRIBE_SEGMENT) {
      out.push(UNSUBSCRIBE_SEGMENT);
      break;
    }
    if (seg === TOKEN_ROUTE_SEGMENT && i + 1 < segments.length) {
      out.push(TOKEN_ROUTE_SEGMENT, ":token");
      break;
    }
    out.push(OPAQUE_SEGMENT_RE.test(raw) && !UUID_SEGMENT_RE.test(raw) ? ":token" : raw);
  }
  return `/${out.join("/")}`;
}

/**
 * Is this a click on an unsubscribe link? Such a click is the recipient *leaving*, not engaging:
 * the kernel drops it at ingest instead of publishing it as a click (and analytics filters it
 * again). Any `unsubscribe` path segment, on any origin, counts.
 */
export function isUnsubscribeLink(url: string | undefined | null): boolean {
  if (typeof url !== "string" || url.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.pathname
    .split("/")
    .some((segment) => lowerSegment(segment).startsWith(UNSUBSCRIBE_SEGMENT));
}

/**
 * `MailDeliveryEvent.reason` prefix adapters use for "the provider refused this recipient from
 * its own suppression list" (Resend `email.suppressed`, Postmark `SubscriptionChange`, SES
 * `OnAccountSuppressionList`). Adapters spell it out themselves (they depend on ports only).
 */
export const PROVIDER_SUPPRESSED_PREFIX = "provider_suppressed:";

/** A hard bounce that is really the provider's own suppression list speaking. */
export function isProviderSuppression(
  event: Pick<MailDeliveryEvent, "kind" | "bounceType" | "reason">,
): boolean {
  return (
    event.kind === "bounce" &&
    event.bounceType === "hard" &&
    typeof event.reason === "string" &&
    event.reason.startsWith(PROVIDER_SUPPRESSED_PREFIX)
  );
}

/**
 * The part of a clicked URL that is safe and useful to store: `origin + pathname` of an http(s)
 * URL, at most `LINK_MAX_LENGTH` characters. The query and fragment are dropped because that is
 * where tokens, signed parameters and personal data live (a magic link, `?email=`); credentials
 * in the authority are dropped by `origin`. Tokens that live in the *path* are redacted too (see
 * `redactPath`: share links, API routes, unsubscribe), and a link on an origin that is not one of
 * `ownOrigins` keeps its origin only. Anything else — a `mailto:`, a `javascript:`, text that is
 * not a URL — is `null`.
 */
export function stripLink(
  url: string | undefined | null,
  options: StripLinkOptions = {},
): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const own =
    options.ownOrigins === undefined ||
    options.ownOrigins.some((origin) => sameOrigin(origin, parsed.origin));
  const link = own ? `${parsed.origin}${redactPath(parsed.pathname)}` : parsed.origin;
  return link.length > LINK_MAX_LENGTH ? link.slice(0, LINK_MAX_LENGTH) : link;
}

function sameOrigin(candidate: string, origin: string): boolean {
  try {
    return new URL(candidate).origin === origin;
  } catch {
    return false;
  }
}
