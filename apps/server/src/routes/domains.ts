import {
  ApiError,
  type ApiErrorCode,
  createRoute,
  domains as d,
  errorResponses,
  jsonBody,
  jsonResponse,
  OkSchema,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import type { Actor, CustomDomainErrorCode, CustomDomainView } from "@fundroom/custom-domains";
import { isCustomDomainError } from "@fundroom/custom-domains";
import type { Membership, TenantContext } from "@fundroom/db";
import type { DnsAnswer } from "@fundroom/ports";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/authz.js";
import type { ApiDeps } from "./deps.js";

/*
 * Custom portal domains (E2.1, EXECUTION_PLAN §9.2, design/07 §2.2–2.3, ADR-0039).
 *
 * Kernel routes behind a `required` manifest, for the fourth time and a blunter reason than
 * `access`, `compliance` and `branding` had: the hostname → workspace lookup runs in the tenant
 * classifier, before there is a tenant context or a module enablement row to consult. A module
 * package owning `core.custom_domain` would be the kernel reading a module's table on every
 * request, and switching the module off would 404 a workspace's own portal.
 *
 * Four things in this file are deliberate:
 *
 *  1. **Mutations require fresh auth.** design/02 §78 lists "changing custom domain" among the
 *     step-up actions, and rightly: the hostname a portal answers on decides where every
 *     investor's session cookie lives and where every emailed link points. A stolen session
 *     that could repoint a portal would be a phishing primitive.
 *  2. **`CustomDomainError` maps onto the codes that already exist** (`DOMAIN_ERRORS`). The
 *     three conflicts are one status with `error.reason` naming which one, the `LOGO_REJECTIONS`
 *     precedent in `branding.ts`: a client that has to branch on a new top-level code for every
 *     flavour of "no" gets a bigger vocabulary and no more information.
 *  3. **Verify is rate-limited per workspace** (`updates.dns_verify`'s numbers). The button
 *     resolves two names against somebody else's nameservers; an admin holding it down must not
 *     become a small amplifier, and the DNS answer cannot change ten times a minute anyway.
 *  4. **Everything runs in tenant context** through the service, which writes the row and its
 *     audit entry in one transaction and invalidates both caches after the commit. The host-context
 *     reads live in the lookup and the sweeps, where there is no workspace yet.
 *
 * Every route carries `x-requires`, checked against packages/authz/matrix/authz-matrix.yaml in CI.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const TAGS = ["domains"];

type Vars = AppEnv["Variables"];
interface Signed {
  readonly session: NonNullable<Vars["session"]>;
  readonly membership: Membership;
  readonly tenant: TenantContext;
  readonly workspace: NonNullable<Vars["workspace"]>;
}

function signed(c: Context<AppEnv>): Signed {
  const session = c.get("session");
  const membership = c.get("membership");
  const tenant = c.get("tenant");
  const workspace = c.get("workspace");
  if (!session || !membership || !tenant || !workspace) throw new ApiError("unauthenticated");
  return { session, membership, tenant, workspace };
}

function actorOf(c: Context<AppEnv>, s: Signed): Actor {
  return {
    membershipId: s.membership.id,
    userId: s.session.userId,
    requestId: requestIdOf(c),
    sessionId: s.session.sessionId,
  };
}

/**
 * `CustomDomainError` onto the closed set of API error codes. No new code is added, for the
 * reason `branding.ts`'s `LOGO_REJECTIONS` gives: the status plus `error.reason` already say
 * everything a client can act on, and every extra top-level code is one more thing every client
 * has to branch on forever.
 *
 * The three 409s are told apart by `error.reason`:
 *   `duplicate`                   — that hostname is already on this workspace's own list
 *   `workspace_already_verified`  — this workspace has a verified hostname; `hostname` names it
 *   `claimed_elsewhere`           — somebody else holds the verified claim, and we do not say who
 */
const DOMAIN_ERRORS: Readonly<Record<CustomDomainErrorCode, ApiErrorCode>> = {
  not_found: "not_found",
  invalid_hostname: "invalid_request",
  duplicate: "conflict",
  workspace_already_verified: "conflict",
  claimed_elsewhere: "conflict",
};

function rethrow(error: unknown): never {
  if (isCustomDomainError(error)) {
    // `reason` first, then the service's own details: `invalid_hostname` already carries a
    // `reason` (the `CustomDomainRejection` the screen has a sentence for) and that one must win,
    // because it is the more specific answer and the contract documents it in `error.reason`.
    throw new ApiError(DOMAIN_ERRORS[error.code], error.message, {
      reason: error.code,
      ...error.details,
    });
  }
  throw error;
}

const iso = (at: Date | null) => (at === null ? null : at.toISOString());

/** `DnsAnswer` with its readonly arrays copied, so the response type matches `DnsAnswerSchema`. */
function answerOf(answer: DnsAnswer | undefined | null) {
  if (answer === undefined || answer === null) return undefined;
  return {
    name: answer.name,
    type: answer.type,
    values: [...answer.values],
    rcode: answer.rcode,
    resolver: answer.resolver,
    ...(answer.chain === undefined ? {} : { chain: [...answer.chain] }),
  };
}

function domainBody(view: CustomDomainView) {
  const answer = view.answer;
  return {
    id: view.id,
    hostname: view.hostname,
    status: view.status,
    records: view.records.map((r) => ({
      type: r.type,
      name: r.name,
      value: r.value,
      required: r.required,
    })),
    answer:
      answer === null
        ? null
        : {
            cname: answerOf(answer.cname),
            txt: answerOf(answer.txt),
            a: answerOf(answer.a),
            aaaa: answerOf(answer.aaaa),
          },
    detail: view.detail,
    consecutiveFailures: view.consecutiveFailures,
    firstAttemptAt: view.firstAttemptAt.toISOString(),
    deadlineAt: view.deadlineAt.toISOString(),
    lastCheckedAt: iso(view.lastCheckedAt),
    dnsOkAt: iso(view.dnsOkAt),
    activatedAt: iso(view.activatedAt),
    createdAt: view.createdAt.toISOString(),
    updatedAt: view.updatedAt.toISOString(),
    // E3.10 (`cloudflare-saas`): the provider's own state and the extra records it asks for.
    ...(view.providerState === undefined ? {} : { providerState: view.providerState }),
    ...(view.providerRecords === undefined
      ? {}
      : {
          providerRecords: view.providerRecords.map((r) => ({
            type: r.type,
            name: r.name,
            value: r.value,
            required: r.required,
          })),
        }),
  };
}

/**
 * E3.10 FR3: with a provider that registers hostnames remotely (`cloudflare-saas`), adds and
 * removals together are capped per workspace — each one turns into provider calls (register,
 * release) drawn from the install's shared Cloudflare budget, so an add/remove loop would be one
 * tenant spending everyone's. Other drivers make no remote call and are not capped here.
 */
export const DOMAIN_CHANGE_RATE = { max: 10, windowMs: 3_600_000 } as const;

export function registerDomainsRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (p: string, extra: { readonly fresh?: boolean } = {}) =>
    requirePermission({ authz: () => deps.authz }, p, extra);

  async function limitChanges(workspaceId: string): Promise<void> {
    if (!deps.domains.pollsProvider) return;
    const limit = await deps.rateLimiter.hit(`domains.change:${workspaceId}`, DOMAIN_CHANGE_RATE);
    if (!limit.allowed) {
      throw new ApiError("rate_limited", "too many domain changes", {
        retryAfterMs: limit.retryAfterMs,
      });
    }
  }

  api.openapi(
    createRoute({
      method: "get",
      path: "/domains",
      tags: TAGS,
      summary: "The workspace's custom portal domains, with the DNS records to publish",
      description:
        "`records` is derived on every read and never stored: a copy of the instructions goes stale the day the edge host changes. `answer` is the last thing the resolvers actually said, so an operator can tell 'we looked and the record is missing' from 'we could not look'. `driver` is `manual` on an install that verifies ownership only and leaves TLS to the operator's own proxy.",
      security: sessionSecurity,
      "x-requires": "domains.read",
      middleware: [perm("domains.read")] as const,
      responses: { 200: jsonResponse(d.CustomDomainListSchema, "Domains"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const service = deps.domains;
      const rows = await service.list(s.tenant);
      return c.json(
        {
          domains: rows.map(domainBody),
          driver: service.driver as "caddy-ask" | "manual" | "cloudflare-saas",
          cnameTarget: deps.customDomainCnameTarget,
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/domains",
      tags: TAGS,
      summary: "Add a custom portal domain",
      description:
        "The hostname is normalised (IDNA → punycode, lower-cased, trailing dot stripped) and refused with `error.reason` when it is an IP literal, a wildcard, a public suffix, a reserved name, or this install's own host — accepting the last of those would be a tenant-resolution bypass. The row starts `pending` with a challenge token; nothing resolves to this workspace until DNS proves out. A second *pending* row is legal (a typo needs fixing), a second *verified* one is not: one verified hostname per workspace, because two would be two `__Host-` cookie jars rather than aliases.",
      security: sessionSecurity,
      "x-requires": "domains.manage+fresh",
      middleware: [perm("domains.manage", { fresh: true })] as const,
      request: { body: jsonBody(d.CustomDomainCreateBody) },
      responses: { 201: jsonResponse(d.CustomDomainSchema, "Added"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const { hostname } = c.req.valid("json");
      await limitChanges(s.workspace.id);
      try {
        const added = await deps.domains.add(s.tenant, { hostname, actor: actorOf(c, s) });
        return c.json(domainBody(added), 201);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/domains/{id}/verify",
      tags: TAGS,
      summary: "Look the records up in DNS now",
      description:
        "Resolves the CNAME (or the apex's address records) and the `_fundroom-challenge` TXT (or, for a domain set up before the rename, `_seedhost-challenge`) through two DoH resolvers, which must agree before anything is treated as verified. A missing record is not an error: the row stays `pending` and `detail` says what DNS answered. A `failed` row is reopened first, so the button always means something. Rate-limited to ten checks a minute per workspace.",
      security: sessionSecurity,
      "x-requires": "domains.manage+fresh",
      middleware: [perm("domains.manage", { fresh: true })] as const,
      request: { params: d.CustomDomainIdParam },
      responses: { 200: jsonResponse(d.CustomDomainSchema, "Checked"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const limit = await deps.rateLimiter.hit(`domains.verify:${s.workspace.id}`, {
        max: 10,
        windowMs: 60_000,
      });
      if (!limit.allowed) {
        throw new ApiError("rate_limited", "too many checks", {
          retryAfterMs: limit.retryAfterMs,
        });
      }
      try {
        const checked = await deps.domains.verifyNow(
          s.tenant,
          c.req.valid("param").id,
          actorOf(c, s),
        );
        return c.json(domainBody(checked), 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "delete",
      path: "/domains/{id}",
      tags: TAGS,
      summary: "Remove a custom portal domain",
      description:
        "A soft delete, which releases the hostname's claim so another workspace (or this one) can verify it later. The portal stops answering on that hostname within the lookup's 60-second cache window, and a session held on it does not carry over to the canonical origin — `__Host-` cookies are host-scoped, which is inherent to changing a domain rather than something this endpoint can smooth over.",
      security: sessionSecurity,
      "x-requires": "domains.manage+fresh",
      middleware: [perm("domains.manage", { fresh: true })] as const,
      request: { params: d.CustomDomainIdParam },
      responses: { 200: jsonResponse(OkSchema, "Removed"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      await limitChanges(s.workspace.id);
      const removed = await deps.domains.remove(s.tenant, c.req.valid("param").id, actorOf(c, s));
      if (!removed) throw new ApiError("not_found", "no such domain");
      return c.json({ ok: true as const }, 200);
    },
  );
}
