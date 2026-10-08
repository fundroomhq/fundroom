import { z } from "zod";
import type { VerificationStatus } from "../model.js";
import { verificationExpiry } from "../model.js";

/*
 * The pure rules of a vendor-settled accreditation verification (E3.7, ADR-0055): no database,
 * no clock of its own, no vendor. The services in `vendor.ts` call these with `services.now()`,
 * and the unit tests pin them without a harness.
 */

/** Minutes, then hours, then a day; daily after the schedule runs out (contract §5). */
export const SYNC_BACKOFF_MS = [
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
] as const;
const DAY_MS = 86_400_000;
/** A pending vendor verification is polled for at most this long, then left to an admin. */
export const POLL_LIFETIME_DAYS = 120;
/** How long a claimed row is leased to the sync job it was handed to (a dead job re-queues). */
export const SYNC_LEASE_MS = 10 * 60_000;
/** A vendor answer with no expiry stands this long (contract §0). */
export const VENDOR_DEFAULT_VALID_DAYS = 90;
/** Starts retried this many times (`check_attempts` counts them) before the row gives up. */
export const START_ATTEMPTS = 3;

/** When the next check after `attempts` completed checks is due. */
export function nextCheckAt(now: Date, attempts: number): Date {
  const delay = attempts < SYNC_BACKOFF_MS.length ? SYNC_BACKOFF_MS[attempts] : DAY_MS;
  return new Date(now.getTime() + (delay ?? DAY_MS));
}

/** Whether a verification opened at `createdAt` has been polled for long enough. */
export function pollingExhausted(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() >= POLL_LIFETIME_DAYS * DAY_MS;
}

/**
 * The expiry a vendor `accredited` answer stands until (contract §0): the vendor's own
 * `expiresAt`, clamped into `(decidedAt, decidedAt + 12 months]`; no expiry → `decidedAt + 90
 * days`. `"expired"` when the result is not in the future — a vendor answer that has already run
 * out must not verify anybody. A vendor `decidedAt` in the future is read as now.
 */
export function vendorExpiry(input: {
  readonly expiresAt?: Date | undefined;
  readonly decidedAt?: Date | undefined;
  readonly now: Date;
}): { readonly decidedAt: Date; readonly expiresAt: Date } | "expired" {
  const now = input.now;
  const reported = input.decidedAt;
  const decidedAt =
    reported !== undefined && !Number.isNaN(reported.getTime()) && reported <= now ? reported : now;
  const ceiling = verificationExpiry("third_party", decidedAt);
  const given = input.expiresAt;
  let expiresAt =
    given !== undefined && !Number.isNaN(given.getTime())
      ? given
      : new Date(decidedAt.getTime() + VENDOR_DEFAULT_VALID_DAYS * DAY_MS);
  if (expiresAt > ceiling) expiresAt = ceiling;
  if (expiresAt <= decidedAt || expiresAt <= now) return "expired";
  return { decidedAt, expiresAt };
}

/**
 * First and last name for a vendor from a display name. The first word is the first name and
 * the rest the last name; one word is a first name alone; something that looks like an address
 * (the display-name fallback when a person never set a name) is no name at all.
 */
export function splitName(displayName: string | null | undefined): {
  readonly firstName?: string;
  readonly lastName?: string;
} {
  const name = (displayName ?? "").trim();
  if (name.length === 0 || name.includes("@")) return {};
  const words = name.split(/\s+/u);
  const first = (words[0] ?? "").slice(0, 100);
  const rest = words.slice(1).join(" ").slice(0, 100);
  return rest.length === 0 ? { firstName: first } : { firstName: first, lastName: rest };
}

/**
 * Whether the investor may start a (re)verification now: nothing pending, and the latest one is
 * absent, rejected, expired, or verified but inside the reminder window (or past its expiry).
 */
export function canRenew(input: {
  readonly latest:
    | {
        readonly status: VerificationStatus;
        readonly expiresAt: Date | null;
      }
    | undefined;
  readonly pending: boolean;
  readonly reminderDays: number;
  readonly now: Date;
}): boolean {
  if (input.pending) return false;
  const latest = input.latest;
  if (latest === undefined) return true;
  if (latest.status === "rejected" || latest.status === "expired") return true;
  if (latest.status === "verified") {
    if (latest.expiresAt === null) return false;
    return latest.expiresAt.getTime() - input.now.getTime() <= input.reminderDays * DAY_MS;
  }
  return false;
}

// --- the stored handoff -----------------------------------------------------------------------

const Str = (max: number) => z.string().min(1).max(max);

/** `round.verification.handoff` (schema version 1): an `AccreditationHandoff`. */
export const StoredHandoffSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("upload") }).strict(),
  z.object({ kind: z.literal("invite_sent") }).strict(),
  z
    .object({
      kind: z.literal("redirect"),
      url: z
        .string()
        .max(2000)
        .refine((u) => {
          try {
            return new URL(u).protocol === "https:";
          } catch {
            return false;
          }
        }, "an https URL"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("widget"),
      sdk: z.literal("parallel-markets"),
      config: z
        .object({
          clientId: Str(200),
          environment: z.enum(["demo", "production"]),
          requiredEntityId: Str(200),
          email: Str(320),
          firstName: Str(100).optional(),
          lastName: Str(100).optional(),
          entityType: z.enum(["self", "business"]),
        })
        .strict(),
    })
    .strict(),
]);
export type StoredHandoff = z.infer<typeof StoredHandoffSchema>;
export type WidgetHandoff = Extract<StoredHandoff, { kind: "widget" }>;

export function parseHandoff(value: unknown): StoredHandoff | undefined {
  const parsed = StoredHandoffSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * What the investor is told about how to continue: the stored handoff without the widget config
 * (a widget is a link to the handoff page instead). A manual row from before 0005 carries no
 * stored handoff and is an upload while it is pending.
 */
export function myHandoff(
  row: {
    readonly provider: string;
    readonly status: VerificationStatus;
    readonly handoff: unknown;
  },
  handoffUrl: string,
):
  | { kind: "upload" }
  | { kind: "invite_sent" }
  | { kind: "redirect"; url: string }
  | { kind: "widget"; url: string }
  | null {
  if (row.status !== "pending") return null;
  const stored = parseHandoff(row.handoff);
  if (stored === undefined) return row.provider === "manual" ? { kind: "upload" } : null;
  switch (stored.kind) {
    case "widget":
      return { kind: "widget", url: handoffUrl };
    case "redirect":
      return { kind: "redirect", url: stored.url };
    default:
      return { kind: stored.kind };
  }
}

// --- the handoff page -------------------------------------------------------------------------

export const PARALLEL_SDK_URL = "https://app.parallelmarkets.com/sdk/v2/parallel.js";

/** The handoff page's own Content-Security-Policy (contract §5; style-src widened, see below). */
export function handoffCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}' https://app.parallelmarkets.com`,
    "frame-src https://app.parallelmarkets.com https://demo.parallelmarkets.com",
    "connect-src https://*.parallelmarkets.com",
    // Parallel's SDK injects its own <style> elements; a nonce here would make browsers ignore
    // 'unsafe-inline'. The page carries no user-controlled markup (its config is script-safe JSON).
    "style-src 'unsafe-inline' https://app.parallelmarkets.com",
    "img-src https://*.parallelmarkets.com data:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** JSON that is safe inside a `<script>` element: no `<`, `>`, `&` or line separators survive. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/&/gu, "\\u0026")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

/**
 * The page that runs Parallel Markets' JS SDK for the investor's pending verification.
 *
 * Nothing the investor does here is POSTed to us: once the SDK reports the investor connected
 * the page links back to the portal, and the server learns the outcome by polling the vendor
 * (or from its callback, which is itself only a wake-up). The config travels as JSON in a
 * nonce'd `application/json` script element — never interpolated into script text — so a name
 * cannot close the element or become code.
 */
export function handoffPage(input: {
  readonly nonce: string;
  readonly handoff: WidgetHandoff;
  readonly portalUrl: string;
  readonly providerLabel: string;
}): string {
  const nonce = escapeHtml(input.nonce);
  const c = input.handoff.config;
  const config = {
    clientId: c.clientId,
    environment: c.environment,
    requiredEntityId: c.requiredEntityId,
    email: c.email,
    firstName: c.firstName ?? null,
    lastName: c.lastName ?? null,
    entityType: c.entityType,
  };
  const label = escapeHtml(input.providerLabel);
  const portal = escapeHtml(input.portalUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Verify your accredited status</title>
<style nonce="${nonce}">
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:2rem 1rem;background:#fff;color:#1a1a1a;line-height:1.5}
main{max-width:36rem;margin:0 auto}
button{font:inherit;padding:.6rem 1.2rem;border-radius:.4rem;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;cursor:pointer}
a{color:inherit;text-decoration:underline}
[hidden]{display:none}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111;border-color:#eee}}
</style>
</head>
<body>
<main>
<h1>Verify your accredited status</h1>
<p>Your verification is handled by ${label}. Continue with them to confirm your accredited-investor status.</p>
<p><button type="button" id="start" disabled>Continue with ${label}</button></p>
<p id="done" hidden>Thank you. ${label} is reviewing your information; we will let you know when it is decided.</p>
<p id="failed" hidden>The verification service could not be loaded. Please try again later.</p>
<p><a href="${portal}">Back to the portal</a></p>
</main>
<script type="application/json" id="handoff-config" nonce="${nonce}">${scriptJson(config)}</script>
<script src="${PARALLEL_SDK_URL}" nonce="${nonce}"></script>
<script nonce="${nonce}">
(function () {
  var cfg = JSON.parse(document.getElementById("handoff-config").textContent);
  var start = document.getElementById("start");
  var P = window.Parallel;
  if (!P) { document.getElementById("failed").hidden = false; return; }
  P.init({ client_id: cfg.clientId, environment: cfg.environment, flow_type: "overlay",
    scopes: ["profile", "accreditation_status"], force_accreditation_check: true });
  P.subscribe("auth.statusChange", function (r) {
    if (r && r.status === "connected") { document.getElementById("done").hidden = false; start.hidden = true; }
  });
  start.disabled = false;
  start.addEventListener("click", function () {
    var opts = { email: cfg.email, expected_entity_type: cfg.entityType, required_entity_id: cfg.requiredEntityId };
    if (cfg.firstName) opts.first_name = cfg.firstName;
    if (cfg.lastName) opts.last_name = cfg.lastName;
    P.login(opts);
  });
})();
</script>
</body>
</html>
`;
}
