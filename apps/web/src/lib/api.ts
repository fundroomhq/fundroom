import {
  createFundRoomClient,
  type ErrorCode,
  FundRoomApiError,
  type FundRoomClient,
  isErrorBody,
} from "@fundroom/sdk";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { m } from "../paraglide/messages.js";
import { isPlanFeature, planFeatureLabel } from "./plan-features.js";

/*
 * The only network layer: the typed SDK client over cookies (same origin, CSRF via Origin).
 * `call()` unwraps the envelope into `ApiFailure` (a FundRoomApiError plus the parsed
 * `Retry-After` and step-up `reason`), which every screen handles through `describeError()`
 * and `authRedirectFor()`.
 */
export class ApiFailure extends FundRoomApiError {
  constructor(
    base: FundRoomApiError,
    readonly retryAfterSeconds: number | undefined,
  ) {
    super(base.status, base.body, base.requestId);
  }
  get reason(): "level" | "fresh" | undefined {
    const r = this.body.error["reason"];
    return r === "level" || r === "fresh" ? r : undefined;
  }
}

let client: FundRoomClient | undefined;
let clientApiBase = "";

export function configureApi(apiBase: string): void {
  clientApiBase = apiBase;
  client = undefined;
}

/** Origin (+ base path) the API client talks to; `""` = same origin. */
export function apiBase(): string {
  return clientApiBase;
}

/*
 * A v4 UUID for `X-Request-Id`. `crypto.randomUUID` exists only in secure contexts, so on a
 * plain-http, non-localhost origin (an operator's first boot, a LAN test box, a DAST scanner)
 * calling it threw on every request and the SPA rendered nothing (E2.10 ZAP-03).
 * `getRandomValues` is available in every context.
 */
export function requestUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40; // version 4
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function api(): FundRoomClient {
  if (client === undefined) {
    client = createFundRoomClient({
      origin: clientApiBase,
      requestId: requestUuid,
      // Resolve `fetch` per call so tests can stub it after module load.
      fetch: (input) => globalThis.fetch(input),
    });
  }
  return client;
}

export function isApiError(error: unknown): error is FundRoomApiError {
  return error instanceof FundRoomApiError;
}

export function isCode(error: unknown, ...codes: ErrorCode[]): boolean {
  return isApiError(error) && codes.includes(error.code);
}

/** `const me = await call(api().GET("/me"))` — typed data or an `ApiFailure`. */
export async function call<T>(
  promise: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  let result: { data?: T; error?: unknown; response: Response };
  try {
    result = await promise;
  } catch (cause) {
    throw new ApiFailure(
      new FundRoomApiError(
        0,
        { error: { code: "service_unavailable", message: String(cause) } },
        undefined,
      ),
      undefined,
    );
  }
  if (result.error !== undefined || result.data === undefined) {
    const body = isErrorBody(result.error)
      ? result.error
      : { error: { code: "internal_error" as const, message: `HTTP ${result.response.status}` } };
    const retry = result.response.headers.get("retry-after");
    const retryAfterSeconds = retry !== null && /^\d+$/u.test(retry) ? Number(retry) : undefined;
    throw new ApiFailure(
      new FundRoomApiError(
        result.response.status,
        body,
        result.response.headers.get("x-request-id") ?? undefined,
      ),
      retryAfterSeconds,
    );
  }
  return result.data;
}

/**
 * A 403 `legal_acceptance_required` means the server is refusing everything until the member
 * accepts an outstanding document (ADR-0037 decision 5). The bootstrap carries what is
 * outstanding, so refreshing it is what puts the interstitial on screen — from any call, not
 * only the one the portal happened to make first.
 */
export function isLegalAcceptanceRequired(error: unknown): boolean {
  return isCode(error, "legal_acceptance_required");
}

/**
 * A 403 `sso_required`: the workspace enforces single sign-on for staff and this session did not
 * come from it (ADR-0056 decision 8). Like an outstanding acceptance, the bootstrap says so
 * (`ssoRequired`), and refreshing it is what puts the "requires single sign-on" screen up —
 * handled here and in `useGuardedMutation`, not by each screen.
 */
export function isSsoRequired(error: unknown): boolean {
  return isCode(error, "sso_required");
}

/**
 * A 403 `sso_session_restricted` (ADR-0056, FR1): this session came from the workspace's single
 * sign-on, and such a session may not change the account's global security (password, TOTP,
 * passkeys, recovery codes, other sessions and devices). Not in the SDK's `ErrorCode` union yet
 * on every build, so it is compared as a string.
 */
export function isSsoSessionRestricted(error: unknown): boolean {
  return isApiError(error) && (error.code as string) === "sso_session_restricted";
}

/**
 * Which kind of bound session a refusal names (E3.10, ADR-0058 §5.6): `sso` for the workspace's
 * single sign-on (`sso_session_restricted`), `central` for a session the canonical host handed
 * to this workspace host (`bound_session_restricted`). Either may not touch global account state.
 */
export type SessionRestriction = "sso" | "central";

export function sessionRestrictionOf(error: unknown): SessionRestriction | undefined {
  if (isSsoSessionRestricted(error)) return "sso";
  if (isCode(error, "bound_session_restricted")) return "central";
  return undefined;
}

/**
 * Cache flag set on the first restriction refusal (its `SessionRestriction`): the security
 * screen then stands down. Older builds stored `true`, which still reads as `sso`.
 */
export const SSO_SESSION_RESTRICTED_KEY = ["auth", "sso-session-restricted"] as const;

export function createQueryClient(): QueryClient {
  let client: QueryClient | undefined;
  const queryCache = new QueryCache({
    onError: (error, query) => {
      const restriction = sessionRestrictionOf(error);
      if (restriction !== undefined) {
        client?.setQueryData(SSO_SESSION_RESTRICTED_KEY, restriction);
        return;
      }
      if (isSsoRequired(error) && query.queryKey[0] !== "bootstrap") {
        void client?.invalidateQueries({ queryKey: ["bootstrap"] });
        return;
      }
      if (isLegalAcceptanceRequired(error)) {
        void client?.invalidateQueries({ queryKey: ["bootstrap"] });
      }
    },
  });
  client = new QueryClient({
    queryCache,
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (count, error) =>
          count < 2 && !(isApiError(error) && error.status >= 400 && error.status < 500),
      },
      mutations: { retry: false },
    },
  });
  return client;
}

export interface ErrorDescription {
  title: string;
  body: string;
  requestId: string | undefined;
}

export function describeError(error: unknown): ErrorDescription {
  if (isApiError(error)) {
    const retry = error instanceof ApiFailure ? error.retryAfterSeconds : undefined;
    const requestId = error.requestId;
    if (isSsoSessionRestricted(error)) {
      return {
        title: m.sso_login_session_restricted_title(),
        body: m.sso_login_session_restricted_body(),
        requestId,
      };
    }
    if (isCode(error, "bound_session_restricted")) {
      return {
        title: m.central_session_restricted_title(),
        body: m.central_session_restricted_error(),
        requestId,
      };
    }
    switch (error.code) {
      case "invalid_code":
        return {
          title: m.error_invalid_code_title(),
          body: m.error_invalid_code_body(),
          requestId,
        };
      case "expired":
        return { title: m.error_expired_title(), body: m.error_expired_body(), requestId };
      case "too_many_attempts":
        return {
          title: m.error_too_many_attempts_title(),
          body: m.error_too_many_attempts_body(),
          requestId,
        };
      case "rate_limited":
        return {
          title: m.error_rate_limited_title(),
          body:
            retry !== undefined
              ? m.error_rate_limited_body_retry({ seconds: String(retry) })
              : m.error_rate_limited_body(),
          requestId,
        };
      case "invalid_credential":
        return {
          title: m.error_invalid_credential_title(),
          body: m.error_invalid_credential_body(),
          requestId,
        };
      case "password_policy": {
        // The server names the rule it applied (`details.issue`); its `message` is English
        // prose for logs, so the SPA says it in the reader's language instead.
        const issue = (error.body.error["details"] as { issue?: unknown } | undefined)?.issue;
        return {
          title: m.error_password_policy_title(),
          body:
            issue === "too_long"
              ? m.error_password_policy_too_long()
              : issue === "too_short"
                ? m.error_password_policy_too_short({ min: 12 })
                : m.error_password_policy_body(),
          requestId,
        };
      }
      case "password_breached":
        return {
          title: m.error_password_breached_title(),
          body: m.error_password_breached_body(),
          requestId,
        };
      case "breach_check_unavailable":
        // E3.2 F-21: HIBP is unreachable and the install runs AUTH_HIBP_FAIL_MODE=closed.
        return {
          title: m.error_breach_check_unavailable_title(),
          body: m.error_breach_check_unavailable_body(),
          requestId,
        };
      case "binding_mismatch":
        return {
          title: m.error_binding_mismatch_title(),
          body: m.error_binding_mismatch_body(),
          requestId,
        };
      case "unauthenticated":
        return {
          title: m.error_unauthenticated_title(),
          body: m.error_unauthenticated_body(),
          requestId,
        };
      case "step_up_required":
        return { title: m.error_step_up_title(), body: m.error_step_up_body(), requestId };
      case "forbidden":
        return { title: m.error_forbidden_title(), body: m.error_forbidden_body(), requestId };
      case "not_found":
      case "workspace_not_found":
        return { title: m.error_not_found_title(), body: m.error_not_found_body(), requestId };
      case "service_unavailable":
        return {
          title: error.status === 0 ? m.error_offline() : m.error_unavailable_title(),
          body: m.error_unavailable_body(),
          requestId,
        };
      case "validation_failed":
        return { title: m.error_validation_title(), body: m.error_validation_body(), requestId };
      case "setup_required":
        return {
          title: m.error_setup_required_title(),
          body: m.error_setup_required_body(),
          requestId,
        };
      case "legal_acceptance_required":
        return {
          title: m.error_legal_acceptance_title(),
          body: m.error_legal_acceptance_body(),
          requestId,
        };
      case "sso_required":
        return {
          title: m.sso_login_required_title(),
          body: m.sso_login_required_error_body(),
          requestId,
        };
      case "membership_expired":
        // The code was right; the membership it would open has passed its expiry (E3.2).
        return {
          title: m.error_membership_expired_title(),
          body: m.error_membership_expired_body(),
          requestId,
        };
      case "delegates_disabled":
        // E3.2: the workspace does not let investors add their own delegates.
        return {
          title: m.error_delegates_disabled_title(),
          body: m.error_delegates_disabled_body(),
          requestId,
        };
      case "delegate_limit_reached":
        return {
          title: m.error_delegate_limit_reached_title(),
          body: m.error_delegate_limit_reached_body(),
          requestId,
        };
      case "conflict":
        return { title: m.error_conflict_title(), body: m.error_conflict_body(), requestId };
      case "view_as_read_only":
        // Staff viewing the portal as an investor: reads work, anything that would act or
        // download as them is refused (E2.7).
        return {
          title: m.error_view_as_read_only_title(),
          body: m.error_view_as_read_only_body(),
          requestId,
        };
      case "accreditation_unavailable":
        // Nothing of the investor's is missing: the company has not published the questionnaire
        // they would be certifying against, so the copy points at the company, not at them.
        return {
          title: m.error_accreditation_unavailable_title(),
          body: m.error_accreditation_unavailable_body(),
          requestId,
        };
      // Workspace export (E2.8).
      case "export_running":
        return {
          title: m.error_export_running_title(),
          body: m.error_export_running_body(),
          requestId,
        };
      case "export_not_ready":
        return {
          title: m.error_export_not_ready_title(),
          body: m.error_export_not_ready_body(),
          requestId,
        };
      case "export_expired":
        return {
          title: m.error_export_expired_title(),
          body: m.error_export_expired_body(),
          requestId,
        };
      // Search (E2.8).
      case "search_query_invalid":
        return {
          title: m.error_search_query_invalid_title(),
          body: m.error_search_query_invalid_body(),
          requestId,
        };
      // Managed hosting (E3.10). A plan limit names what ran out and how much the plan allows.
      // A-3: a plan can also leave out a module or a feature; that is "not on your plan", not
      // a limit reached.
      case "plan_limit":
        return { title: planLimitTitle(error), body: planLimitBody(error), requestId };
      case "workspace_unavailable":
        return {
          title: m.error_workspace_unavailable_title(),
          // E3.11: a move to another cell is planned downtime, not a suspension to settle.
          body:
            detailOf(error, "reason") === "relocation"
              ? m.error_workspace_unavailable_relocation_body()
              : m.error_workspace_unavailable_body(),
          requestId,
        };
      case "billing_manual":
        return {
          title: m.error_billing_manual_title(),
          body: m.error_billing_manual_body(),
          requestId,
        };
      case "billing_unavailable":
        return {
          title: m.error_billing_unavailable_title(),
          body: m.error_billing_unavailable_body(),
          requestId,
        };
      case "slug_taken":
        return { title: m.error_slug_taken_title(), body: m.error_slug_taken_body(), requestId };
      case "version_conflict":
        return {
          title: m.error_version_conflict_title(),
          body: m.error_version_conflict_body(),
          requestId,
        };
      // AI assist (E3.12): starting a request, or turning it on without an acknowledgement.
      case "ai_unavailable":
        return {
          title: m.error_ai_unavailable_title(),
          body: m.error_ai_unavailable_body(),
          requestId,
        };
      case "ai_disabled":
        return {
          title: m.error_ai_disabled_title(),
          body:
            detailOf(error, "reason") === "budget_below_minimum"
              ? m.error_ai_disabled_budget_below_minimum()
              : m.error_ai_disabled_body(),
          requestId,
        };
      case "ai_acknowledgement_required":
        return {
          title: m.error_ai_acknowledgement_required_title(),
          body: m.error_ai_acknowledgement_required_body(),
          requestId,
        };
      case "ai_rate_limited":
        return {
          title: m.error_ai_rate_limited_title(),
          body:
            retry !== undefined
              ? m.error_rate_limited_body_retry({ seconds: String(retry) })
              : m.error_ai_rate_limited_body(),
          requestId,
        };
      case "ai_busy":
        return { title: m.error_ai_busy_title(), body: m.error_ai_busy_body(), requestId };
      case "ai_budget_exhausted":
        return {
          title: m.error_ai_budget_exhausted_title(),
          body: m.error_ai_budget_exhausted_body(),
          requestId,
        };
      // Forensic leak tracing (E3.13): the "Trace a leak" dialog on a data-room document.
      case "forensic_image_invalid":
        return {
          title: m.error_forensic_image_invalid_title(),
          body: m.error_forensic_image_invalid_body(),
          requestId,
        };
      case "forensic_no_marks":
        return {
          title: m.error_forensic_no_marks_title(),
          body: m.error_forensic_no_marks_body(),
          requestId,
        };
      case "forensic_alignment_failed":
        return {
          title: m.error_forensic_alignment_failed_title(),
          body: m.error_forensic_alignment_failed_body(),
          requestId,
        };
      case "forensic_too_many_candidates":
        return {
          title: m.error_forensic_too_many_candidates_title(),
          body: m.error_forensic_too_many_candidates_body(),
          requestId,
        };
      case "forensic_busy":
        return {
          title: m.error_forensic_busy_title(),
          body: m.error_forensic_busy_body(),
          requestId,
        };
      case "forensic_rate_limited":
        return {
          title: m.error_forensic_rate_limited_title(),
          body:
            retry !== undefined
              ? m.error_forensic_rate_limited_body_retry({
                  count: Math.max(1, Math.ceil(retry / 60)),
                })
              : m.error_forensic_rate_limited_body(),
          requestId,
        };
      default:
        return { title: m.error_generic_title(), body: m.error_generic_body(), requestId };
    }
  }
  return { title: m.error_generic_title(), body: m.error_generic_body(), requestId: undefined };
}

/**
 * A 402 `plan_limit` carries `limit` (which quota) and `max` (what the plan allows) beside the
 * code — or, since A-3, `limit: "module" | "feature"` and the `module` / `feature` the plan
 * leaves out — spread into the envelope, or under `details` from an older server; either is read.
 */
/** One field of a refusal's `details` (or spread into the envelope). */
function detailOf(error: FundRoomApiError, key: string): unknown {
  const envelope = error.body.error as Record<string, unknown>;
  const nested = envelope["details"];
  const source =
    typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : envelope;
  return source[key] ?? envelope[key];
}

/**
 * A-3: a 402 `plan_limit` for a module or feature the plan leaves out (`limit: "module" |
 * "feature"`, no `max`) — "not on your plan" rather than a quota reached. Who changes the plan
 * depends on the install (Billing or the host), so these sentences stop at what is missing and
 * `ErrorAlert` adds the way to a plan change (`PlanChangeHint`).
 */
export function isPlanEntitlementRefusal(error: unknown): boolean {
  if (!isCode(error, "plan_limit") || !(error instanceof FundRoomApiError)) return false;
  const limit = detailOf(error, "limit");
  return limit === "module" || limit === "feature";
}

/** The module or feature a refusal names, by name; `undefined` for one this build does not know. */
function notIncluded(
  error: FundRoomApiError,
): { module: string } | { feature: string } | undefined {
  const limit = detailOf(error, "limit");
  if (limit === "module") {
    const module = detailOf(error, "module");
    return typeof module === "string" && module !== "" ? { module } : undefined;
  }
  if (limit === "feature") {
    const feature = detailOf(error, "feature");
    return isPlanFeature(feature) ? { feature: planFeatureLabel(feature) } : undefined;
  }
  return undefined;
}

/** Titles name what is missing: toasts that show only the title still say which. */
function planLimitTitle(error: FundRoomApiError): string {
  const limit = detailOf(error, "limit");
  if (limit !== "module" && limit !== "feature") return m.error_plan_limit_title();
  const what = notIncluded(error);
  if (what === undefined) return m.plan_feature_notice_title();
  return "module" in what
    ? m.error_plan_limit_module_title(what)
    : m.error_plan_limit_feature_title(what);
}

function planLimitBody(error: FundRoomApiError): string {
  const limit = detailOf(error, "limit");
  if (limit === "module" || limit === "feature") {
    const what = notIncluded(error);
    // A name this build does not know (a newer server): no quota wording, no "Billing" — the
    // way to a plan change follows (`PlanChangeHint`).
    if (what === undefined) return m.error_plan_limit_unknown();
    return "module" in what ? m.error_plan_limit_module(what) : m.error_plan_limit_feature(what);
  }
  const raw = detailOf(error, "max");
  const max = typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
  if (max === undefined) return m.error_plan_limit_body();
  switch (limit) {
    case "staffSeats":
      return m.error_plan_limit_staff_seats({ max });
    case "investorSeats":
      return m.error_plan_limit_investor_seats({ max });
    case "customDomains":
      return m.error_plan_limit_custom_domains({ max });
    case "storageBytes":
      return m.error_plan_limit_storage();
    default:
      return m.error_plan_limit_body();
  }
}

export type AuthRedirect =
  | { to: "/login"; search: { returnTo: string } }
  | { to: "/auth/step-up"; search: { returnTo: string; reason: "level" | "fresh" } };

/** Where a signed-in screen should send the user for this error, if anywhere. */
export function authRedirectFor(error: unknown, returnTo: string): AuthRedirect | undefined {
  if (!isApiError(error)) return undefined;
  if (error.code === "unauthenticated") return { to: "/login", search: { returnTo } };
  if (error.code === "step_up_required") {
    const reason = error instanceof ApiFailure ? (error.reason ?? "level") : "level";
    return { to: "/auth/step-up", search: { returnTo, reason } };
  }
  return undefined;
}

/*
 * Post-login return path: the SPA half of F-02 (ASVS 3.7.2), mirroring the server's
 * `safeReturnPath` (apps/server/src/routes/auth.ts). A prefix check is not enough: URL parsing
 * turns `/\evil.com` and `/<TAB>/evil.com` into `//evil.com`, and `/.//evil.com` normalises to it.
 * So a backslash, whitespace or control character refuses the value outright, as does an encoded
 * slash or backslash right after the leading one; what is left must resolve on a placeholder
 * origin and stay there, and only the normalised path + query + fragment is returned.
 */
const RETURN_ORIGIN = "https://return-to.invalid";

function hasUnsafeReturnChar(raw: string): boolean {
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x20 || (cp >= 0x7f && cp <= 0xa0) || ch === "\\" || /\s/u.test(ch)) return true;
    if (cp >= 0x200b && cp <= 0x200f) return true;
    if (cp === 0xfeff) return true;
  }
  return false;
}

/** Same-origin path only: no scheme, no protocol-relative, no backslash or whitespace tricks. */
export function safeReturnTo(value: string | undefined, fallback = "/"): string {
  if (value === undefined || value === "" || value.length > 2048) return fallback;
  if (!value.startsWith("/") || value.startsWith("//")) return fallback;
  if (hasUnsafeReturnChar(value)) return fallback;
  if (/^\/%(?:5c|2f)/iu.test(value)) return fallback;
  let url: URL;
  try {
    url = new URL(value, RETURN_ORIGIN);
  } catch {
    return fallback;
  }
  if (url.origin !== RETURN_ORIGIN) return fallback;
  const path = url.pathname;
  if (!path.startsWith("/") || path.startsWith("//")) return fallback;
  // Re-checked after normalisation (E2.10 R1-06): `/./%2Fevil.com` becomes `/%2Fevil.com`.
  if (/%(?:2f|5c)/iu.test(path.slice(1).split("/")[0] ?? "")) return fallback;
  return `${path}${url.search}${url.hash}`;
}
