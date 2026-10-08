import {
  ApiError,
  type ApiErrorCode,
  createRoute,
  errorResponses,
  jsonBody,
  jsonResponse,
  kernel as k,
  OkSchema,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
  shareLinks as sl,
} from "@fundroom/contracts";
import type { Database, Membership, ResolvedWorkspace, TenantContext } from "@fundroom/db";
import { systemContext } from "@fundroom/db";
import {
  type LoginContext,
  type LoginResult,
  MembershipRepo,
  maskEmail,
  RATE_LIMITS,
  shareLinkRateKey,
  withMinimumDuration,
} from "@fundroom/identity";
import { issueSessionCookies, readDeviceCookie } from "@fundroom/identity/http";
import {
  type Actor,
  type AdmissionRefusal,
  createShareLinkService,
  emailRefusal,
  isShareLinkError,
  type LinkSummary,
  type ResolvedLink,
  type ShareLinkErrorCode,
  type ShareLinkService,
  tokenHash,
} from "@fundroom/share-links";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import { cookieModeOf } from "../middleware/auth.js";
import { requireOffering, requirePermission } from "../middleware/authz.js";
import { SHARE_LINKS_DISABLED_WHEN } from "../modules.js";
import { cookieBasePathOf } from "../path-mount.js";
import { canonicalResource } from "./access.js";
import { type ApiDeps, clientIp, workspaceUrl } from "./deps.js";
import { loginBody } from "./serialize.js";

/*
 * Share links (E2.3, EXECUTION_PLAN §9.3, design/05 §5, ADR-0041).
 *
 * Kernel routes behind a `required` manifest, for the sixth time, and the reason is the sharpest
 * one yet: **a share link mints a membership.** `core.share_link` is a kernel table, the binding
 * it writes (`core.share_link_visit`) is the edge `PrincipalRepo` walks to emit a `link` subject,
 * and redemption runs inside the identity package's `establishMembership` — the single code path
 * that creates a `core.membership`, applies groups and grants and bumps `acl_version`. A module
 * package owning any of that would be a module writing rows the kernel's own row security reads
 * on every request, and a module with an off switch deciding who is a member.
 *
 * Six things in this file are deliberate:
 *
 *  1. **Three public routes, keyed on the token; six admin routes, keyed on the id.** The two
 *     vocabularies never meet (contract C4). If the generic `POST /auth/otp/start` had learned to
 *     accept a link *id*, possession of that id alone would buy eligibility and the passcode
 *     would be bypassed entirely — and an id, unlike its token, ends up in URLs, logs and admin
 *     screens. So the whole ceremony hangs off the token, in the path, and `checkEligibility`'s
 *     `linkId` is reachable from nowhere else.
 *  2. **Every "no" a stranger can provoke about the link's existence is the same 404.** Unknown,
 *     revoked, paused, expired and rate-limited all collapse there (D7) — never 403, never 410,
 *     never 429. Somebody who could tell "revoked" from "never existed" could enumerate live
 *     links, and that a link *exists* is already the interesting fact about a confidential data
 *     room. The real reason stays on the row, which the admin routes below read directly, and in
 *     the `share_link.admission_refused` audit entries. `withMinimumDuration` wraps every path
 *     that branches on whether a token exists, so the timing does not answer the question the
 *     status code refuses to.
 *
 *     **A spent link is not one of those answers, and that is the fix for a real lock-out.** A
 *     link that has reached `max_uses` (or `max_views`) is still *open*: `PrincipalRepo` goes on
 *     emitting its subject for everyone it admitted (A6), so it is still granting them access.
 *     Answering 404 here meant a visitor the link had already admitted could not sign in again
 *     from a new device or after their session expired — the link had stopped letting its own
 *     people back in while still granting them everything. So `resolve` maps the token on
 *     `isOpen` and these routes serve a spent link normally.
 *
 *     The cap is not weakened, and the way it is kept is the delicate part. **Whether a new
 *     visitor may come in is never answered on the wire.** This route has an email address, so
 *     it *could* look up whether that address already holds a membership here — and must not:
 *     a reply that moved when the answer was yes would be an oracle for "has <address> been let
 *     into this room?", available to anyone ever forwarded the link, and the addresses in a
 *     private placement are exactly what a competitor wants. Instead the decision is made where
 *     it is invisible: `POST …/start` always answers the same body after the same floor, and
 *     `checkEligibility` decides *silently* whether a code is actually mailed — a returning
 *     member gets one, a stranger on a spent link does not, and the two replies are identical.
 *     The seat is then spent, or refused, by `claimUse` inside `verify`, which is the only check
 *     that holds under concurrency. A new visitor who somehow held a code would get the same 404
 *     there, having proved control of a mailbox to learn about their own membership.
 *  3. **The passcode refusal is mapped AFTER the transaction commits.** `checkPasscode` *returns*
 *     a refusal rather than throwing, because it runs in the caller's transaction and counts the
 *     attempt on the link row; throwing before the commit would roll the counter back and hand a
 *     guesser unlimited tries (contract B7). This is the one ordering in this file that is a
 *     security property rather than a style, and `passcodeRefusal` below exists to make it
 *     testable in isolation.
 *  4. **`verify` passes `linkId` through to `emailOtp.verify`.** The challenge is bound to the
 *     link (`binding_hash = sha256("share_link:" + id)`, contract D-1/O2) and the pairing is
 *     required in both directions, so a code minted by a passcode-free link A cannot be spent at
 *     link B's `verify` — which is what makes the passcode's transitive enforcement real. Drop
 *     the argument and every share-link code is rejected.
 *  5. **Every service call runs under a `system` context.** `core.share_link` has no permissive
 *     RLS policy for `external` at all (contract A4): Postgres RLS is row-level, so no policy
 *     could hand back the row while withholding `token_hash` and `passcode_hash`, and a visitor
 *     *is* an external member the moment they are admitted. Under their own context these reads
 *     would return zero rows and raise nothing — indistinguishable from "no such link". The
 *     classifier has resolved the workspace from the host or slug long before any membership
 *     exists, so `systemContext(workspace.id)` is available on the public routes too.
 *  6. **Offering mode switches these routes off, not merely the nav** (contract S4). A `none` or
 *     `informational` workspace may not issue or honour share links at all, and a compliance
 *     control that only edited a menu would be one an admin can walk around.
 *
 * Every route carries `x-requires`, checked against packages/authz/matrix/authz-matrix.yaml in CI.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const TAGS = ["share-links"];

/**
 * Duration floors for the paths that branch on whether a token exists (D7).
 *
 * `start` gets the longer one because it does strictly more work on the happy path — an HMAC, a
 * challenge row and a mail — and a floor the happy path routinely exceeded would leak the very
 * difference it exists to hide. `emailOtp.start` applies its own floor underneath this one.
 */
const RESOLVE_FLOOR_MS = 120;
const START_FLOOR_MS = 250;

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

/**
 * The workspace a *public* link route is acting in. There is no session and no membership here,
 * only what the tenant classifier resolved from the host or the slug — which is exactly enough,
 * because `systemContext` is what the share-link service requires (A4) and the visitor supplies
 * no identity until the OTP verifies.
 */
function anyWorkspace(c: Context<AppEnv>): ResolvedWorkspace {
  const workspace = c.get("workspace");
  if (workspace === undefined) throw new ApiError("setup_required");
  return workspace;
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
 * `ShareLinkError` onto the closed set of API error codes (contract S9/B6). No new code is
 * added, for the reason `domains.ts`'s `DOMAIN_ERRORS` and `branding.ts`'s `LOGO_REJECTIONS`
 * give: the status plus `error.reason` already say everything a client can act on, and every
 * extra top-level code is one more thing every client has to branch on for ever.
 *
 * The two offering-mode refusals are 403s told apart by `error.reason`, and both carry
 * `error.offeringStatus` so the admin screen can render the server's refusal rather than
 * re-deriving Rule 506's audience rule in the browser.
 */
const LINK_ERRORS: Readonly<Record<ShareLinkErrorCode, ApiErrorCode>> = {
  not_found: "not_found",
  validation_failed: "validation_failed",
  conflict: "conflict",
  forbidden: "forbidden",
  unsupported: "unsupported",
  links_not_permitted: "forbidden",
  audience_too_open: "forbidden",
};

function rethrow(error: unknown): never {
  if (isShareLinkError(error)) {
    throw new ApiError(LINK_ERRORS[error.code], error.message, {
      reason: error.code,
      ...error.details,
    });
  }
  throw error;
}

/**
 * What an *unauthenticated* caller is told when admission refuses.
 *
 * Only two things are ever distinguishable, and both only to somebody who already holds a
 * resolvable token, so neither reveals whether a link exists:
 *
 *  - the three passcode answers, because a visitor who cannot be told their passcode is wrong
 *    cannot use the link at all; and
 *  - `email_not_allowed`, which is reachable only *after* the passcode has been satisfied.
 *
 * Everything else — including `not_found` itself — is the one 404.
 */
export function admissionError(refusal: AdmissionRefusal): ApiError {
  switch (refusal) {
    case "passcode_required":
      return new ApiError("forbidden", "this link needs a passcode", { reason: refusal });
    case "passcode_wrong":
      return new ApiError("forbidden", "that passcode is not right", { reason: refusal });
    case "passcode_locked":
      return new ApiError("too_many_attempts", "too many passcode attempts; try again later", {
        reason: refusal,
      });
    case "email_not_allowed":
      return new ApiError("forbidden", "that address is not on this link's list", {
        reason: refusal,
      });
    default:
      return notFound();
  }
}

/** The single answer for every question about a link's existence (D7). */
function notFound(): ApiError {
  return new ApiError("not_found", "no such link");
}

/**
 * Runs `checkPasscode` in its own transaction and **returns** the refusal.
 *
 * This function is the whole of contract B7 and it is extracted so it can be tested without a
 * route. `checkPasscode` counts the attempt on `core.share_link` inside the transaction it is
 * handed; a caller that turned the refusal into an exception *before* the commit would roll that
 * counter back with it and hand a guesser unlimited tries. The OTP flow can afford to throw
 * because it commits the attempt in a transaction of its own first
 * (`packages/identity/src/services/email-otp.ts`); this one cannot, so the transaction closes
 * here and the throw happens in the caller.
 */
export async function passcodeRefusal(
  db: Pick<Database, "withTenant">,
  ctx: TenantContext,
  links: Pick<ShareLinkService, "checkPasscode">,
  linkId: string,
  passcode: string,
): Promise<AdmissionRefusal | undefined> {
  return db.withTenant(ctx, (tx) => links.checkPasscode(ctx, tx, linkId, passcode));
}

/**
 * The masked address a link is allowed to reveal before admission (D7).
 *
 * Only for a link that names **exactly one** address: then the hint answers "which of my
 * addresses was this sent to?" for the person it was sent to, and tells a holder of a leaked URL
 * nothing they could not already guess from the fact that they were forwarded it. A link naming
 * twenty contacts would be a directory, so it reveals none of them.
 */
export function emailHintOf(link: ResolvedLink): string | undefined {
  const only = link.policy.emails.length === 1 ? link.policy.emails[0] : undefined;
  return only === undefined ? undefined : maskEmail(only);
}

function linkBody(link: LinkSummary) {
  return {
    id: link.id,
    label: link.label,
    status: link.status,
    policy: {
      domains: [...link.policy.domains],
      emails: [...link.policy.emails],
      forceWatermark: link.policy.forceWatermark,
    },
    grants: link.grants.map((g) => ({
      resource: {
        kind: g.resource.kind,
        id: g.resource.id,
        ...(g.resource.path === undefined ? {} : { path: g.resource.path }),
      },
      capabilities: [...g.capabilities],
      ...(g.validUntil === undefined ? {} : { validUntil: g.validUntil }),
    })),
    groupIds: [...link.groupIds],
    passcodeRequired: link.passcodeRequired,
    maxUses: link.maxUses,
    uses: link.uses,
    maxViews: link.maxViews,
    views: link.views,
    expiresAt: link.expiresAt?.toISOString() ?? null,
    createdBy: link.createdBy,
    createdAt: link.createdAt.toISOString(),
    revokedAt: link.revokedAt?.toISOString() ?? null,
    visits: link.visits,
  };
}

/**
 * Where a visitor opens the link. On the workspace's **own** origin — its verified custom domain
 * when it has one — because that is where the session cookie will live and where the emailed
 * code has to be spent (E2.1 decision 5).
 */
export function shareLinkUrl(deps: ApiDeps, workspace: ResolvedWorkspace, token: string): string {
  return workspaceUrl(deps.baseUrl, deps.tenancy, workspace, `/s/${token}`, deps.basePath).href;
}

/** The login context for a link visitor. `embed` matters: a framed portal needs a partitioned cookie. */
function loginContextOf(c: Context<AppEnv>, deps: ApiDeps, rememberDevice: boolean): LoginContext {
  const ws = anyWorkspace(c);
  return {
    workspaceId: ws.id,
    workspaceName: ws.name,
    ip: clientIp(c, deps.trustProxy),
    userAgent: c.req.header("user-agent")?.slice(0, 512),
    embed: c.get("embed") === true,
    topSite: undefined,
    deviceToken: readDeviceCookie(c, cookieModeOf(c)),
    rememberDevice,
    // The session this browser already held (resolved from its cookie) ends when the link's
    // login issues a new one (F-12, ASVS 7.2.4).
    replacesSessionId: c.get("session")?.sessionId,
  };
}

function finishLogin(c: Context<AppEnv>, result: LoginResult, rememberDevice: boolean) {
  const mode = cookieModeOf(c);
  const maxAgeSeconds = rememberDevice
    ? Math.max(60, Math.floor((result.session.absoluteExpiresAt.getTime() - Date.now()) / 1000))
    : undefined;
  issueSessionCookies(c, {
    token: result.token,
    deviceToken: result.deviceToken,
    mode,
    basePath: cookieBasePathOf(c),
    ...(maxAgeSeconds === undefined ? {} : { maxAgeSeconds }),
  });
  return c.json(loginBody(result), 200);
}

export function registerLinkRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (p: string, extra: { readonly fresh?: boolean } = {}) =>
    requirePermission({ authz: () => deps.authz }, p, extra);
  /*
   * The offering-mode guard, mounted on every route in this file including the public three.
   *
   * It is a middleware rather than a check inside each handler because it has to run *before*
   * anything reads the link: a `none` workspace must answer 404 to a visitor holding a perfectly
   * good token, and it must do so without the timing difference a post-read check would leave.
   */
  const offering = () => requireOffering(SHARE_LINKS_DISABLED_WHEN);

  /**
   * One service per app, built lazily so `generateOpenApiDocument()` can register these routes
   * against a `stubDeps()` proxy that throws on every property access.
   */
  let service: ShareLinkService | undefined;
  const links = (): ShareLinkService =>
    (service ??= createShareLinkService({
      audit: deps.audit,
      // The operator's ring, and the only thing it is used for here is HMACing a passcode: the
      // token is a plain digest, because 256 bits of entropy has no dictionary behind it.
      keyRing: deps.identityDeps.keyRing,
      // Contract S3/B10: a grant naming a resource kind no module registered can never be
      // satisfied by anybody, so it is refused at mint time rather than written as a grant that
      // silently grants nothing. Read lazily — the registry is merged at boot, but this closure
      // is built at registration time.
      resourceKinds: () => Object.keys(deps.registry.resourceKinds),
      log: (event, fields) => deps.log(event, { ...fields }),
    }));

  // --- the public three: token in the path, no session, no membership --------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/links/{token}",
      tags: TAGS,
      summary: "Resolve a share link (public). Never consumes it",
      description:
        "Answers `404` — the same as an unknown path — for a token that is unknown, revoked, paused or expired, because a caller who could tell those apart could enumerate live links, and that a link *exists* is already the interesting fact about a confidential data room. A link that has spent its `maxUses` or `maxViews` still resolves: a cap limits how many people may come in, not how long the ones who did may stay, and the people it already admitted have to be able to sign in again from a new device. Whether a *new* visitor may still be admitted is never answered here. On success it returns the workspace's name, whether a passcode is needed, and a masked address hint **only** when the link names exactly one contact. It never returns the name of what the link points at: admission happens before anyone is inside. The call does not consume a use or a view.",
      "x-requires": "public",
      middleware: [offering()] as const,
      request: { params: sl.ShareLinkTokenParams },
      responses: { 200: jsonResponse(sl.ShareLinkResolutionSchema, "Resolved"), ...ERRORS },
    }),
    async (c) => {
      const workspace = anyWorkspace(c);
      const ctx = systemContext(workspace.id);
      const token = c.req.valid("param").token;
      const link = await withMinimumDuration(RESOLVE_FLOOR_MS, async () => {
        // Keyed on the token's digest rather than on the caller's claimed IP: behind the shipped
        // Caddy, `TRUST_PROXY=true` takes the first `X-Forwarded-For` hop, which is
        // attacker-supplied, so an IP bucket is a bucket the attacker chooses (D7). Hashing
        // first means a known and an unknown token are limited identically, so the limit itself
        // is not an oracle — and the refusal is the same 404 as everything else here.
        const limit = await deps.rateLimiter.hit(
          shareLinkRateKey("resolve", tokenHash(token).toString("hex")),
          RATE_LIMITS.shareLinkResolve,
        );
        if (!limit.allowed) return undefined;
        return deps.db.withTenant(ctx, (tx) => links().resolve(ctx, tx, token));
      });
      if (link === undefined) throw notFound();
      const hint = emailHintOf(link);
      return c.json(
        {
          valid: true as const,
          requiresPasscode: link.passcodeRequired,
          workspaceName: workspace.name,
          ...(hint === undefined ? {} : { emailHint: hint }),
        },
        200,
      );
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/links/{token}/start",
      tags: TAGS,
      summary: "Check the passcode, check the address, and send a sign-in code (public)",
      description:
        "The link's own admission controls in order: the passcode (counted on the link row, locked after five wrong tries), then the domain allowlist and named-contact list, then the ordinary email OTP — the *same* OTP, bound to this link so the code cannot be spent against another one. The reply is identical for an address the link admits and one it does not, and identical whether or not a mail was sent, with a minimum duration so the timing does not answer what the body refuses to. On a link whose `maxUses` are spent the reply is identical again: a visitor the link already admitted is mailed a code so they can sign in from a new device, a new one is not, and nothing on the wire says which happened, because an endpoint that said would answer 'has this address been let into this room?' for anyone ever forwarded the link. A wrong passcode is told apart, because a visitor who cannot be told their passcode is wrong cannot use the link; it is reachable only by somebody who already holds a resolvable token, so it reveals nothing about which links exist.",
      "x-requires": "public",
      middleware: [offering()] as const,
      request: { params: sl.ShareLinkTokenParams, body: jsonBody(sl.ShareLinkStartBody) },
      responses: { 200: jsonResponse(sl.ShareLinkStartResultSchema, "Code sent"), ...ERRORS },
    }),
    async (c) => {
      const workspace = anyWorkspace(c);
      const ctx = systemContext(workspace.id);
      const token = c.req.valid("param").token;
      const body = c.req.valid("json");

      /*
       * The refusal is computed inside the duration floor and *thrown* outside it, so that a
       * refused call takes as long as an accepted one. `admit` returns either the link or the
       * ApiError to raise; it never throws, because a throw would escape the floor.
       */
      const outcome = await withMinimumDuration(
        START_FLOOR_MS,
        async (): Promise<ResolvedLink | ApiError> => {
          const link = await deps.db.withTenant(ctx, (tx) => links().resolve(ctx, tx, token));
          if (link === undefined) return notFound();

          if (link.passcodeRequired) {
            // Per link, on top of the row's own attempt counter and lockout. The row is the hard
            // stop; this only blunts the rate at which a guesser reaches it. Over the limit is
            // the same answer a lockout gives, not a 429 that would confirm the link exists.
            const limit = await deps.rateLimiter.hit(
              shareLinkRateKey("passcode", link.id),
              RATE_LIMITS.shareLinkPasscode,
            );
            if (!limit.allowed) return admissionError("passcode_locked");
            // B7: the attempt is counted in this transaction and the transaction COMMITS here.
            // Mapping the refusal to a response before the commit would roll the counter back.
            const refusal = await passcodeRefusal(
              deps.db,
              ctx,
              links(),
              link.id,
              body.passcode ?? "",
            );
            if (refusal !== undefined) return admissionError(refusal);
          }

          /*
           * The **policy** half of admission, and deliberately only that half.
           *
           * `ShareLinkService.admits` is policy *plus* `isLive`, i.e. the caps — and it is the
           * right question for "may somebody new come in?". It is the wrong question here,
           * because this route cannot yet tell a new visitor from a returning one and must not
           * try: the only way to tell is to look the address up as a membership, and a refusal
           * that moved when the address was already a member would turn this endpoint into an
           * oracle for "has <address> been let into this room?" — answerable by anyone who was
           * ever forwarded the link. (See the block comment above this route.)
           *
           * So the caps are not decided here at all. They are decided one layer down, where the
           * answer is invisible: `emailOtp.start` calls `checkEligibility`, which admits an
           * address that already holds a live membership, or that `ShareLinkService.admitsEmail`
           * (policy **and** `isLive`) still admits — and which sends nothing, with the same body
           * and the same duration, when neither holds. A returning visitor gets their code; a
           * new one on a spent link gets the identical reply and no mail. The seat itself is
           * then spent or refused by `claimUse` at `verify`, the one check that holds under
           * concurrency.
           *
           * `email_not_allowed` stays distinguishable, because a visitor who cannot be told the
           * link is not for their address cannot use the link — and it is reachable only after
           * the passcode, on a link that resolved, so it reveals nothing about which links exist.
           */
          const refusal = emailRefusal(link.policy, body.email);
          if (refusal !== undefined) return admissionError(refusal);
          return link;
        },
      );
      if (outcome instanceof ApiError) throw outcome;

      /*
       * The ordinary email OTP, verbatim — with `linkId`, which puts
       * `sha256("share_link:" + id)` in `core.auth_challenge.binding_hash` (contract D-1). That
       * binding is what makes the passcode's transitive enforcement real: without it a code
       * minted by a passcode-free link A could be spent at link B's `verify`, which never sees a
       * passcode. `start` is the only place `checkEligibility` is ever given a `linkId`.
       */
      const r = await deps.auth.emailOtp.start({
        email: body.email,
        ip: clientIp(c, deps.trustProxy),
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        linkId: outcome.id,
      });
      return c.json({ status: r.status, emailHint: r.emailHint, ttlMinutes: r.ttlMinutes }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/links/{token}/verify",
      tags: TAGS,
      summary: "Spend the code, become a member of this workspace (public)",
      description:
        "Verifies the code **against this link** and completes the login: a `core.membership` with `kind=external`, `role=investor` and `source=link:<id>`, the `core.share_link_visit` binding the evaluator reads, the link's target groups and grants, and an `acl_version` bump. The code is bound to the link that minted it in both directions — a bound code fails where no link is named and an unbound one fails where a link is — so possession of a code from an open link buys nothing at a passcode-protected one. `auth_level` is 1: email OTP, never 0, which is reserved for host-asserted identity.",
      "x-requires": "public",
      middleware: [offering()] as const,
      request: { params: sl.ShareLinkTokenParams, body: jsonBody(sl.ShareLinkVerifyBody) },
      responses: { 200: jsonResponse(k.LoginResponse, "Signed in; session cookie set"), ...ERRORS },
    }),
    async (c) => {
      const workspace = anyWorkspace(c);
      const ctx = systemContext(workspace.id);
      const token = c.req.valid("param").token;
      const body = c.req.valid("json");
      const link = await withMinimumDuration(RESOLVE_FLOOR_MS, () =>
        deps.db.withTenant(ctx, (tx) => links().resolve(ctx, tx, token)),
      );
      if (link === undefined) throw notFound();
      const r = await deps.auth.emailOtp.verify({
        email: body.email,
        code: body.code,
        ...loginContextOf(c, deps, body.rememberDevice),
        // Both halves of D-1: `emailOtp.verify` refuses a challenge whose `binding_hash` does not
        // pair with this link, and `completeLogin` uses the same id to create the membership with
        // `source=link:<id>`, write the visit row and apply the link's groups and grants. Omit it
        // and every share-link code is rejected as a wrong binding.
        linkId: link.id,
      });
      return finishLogin(c, r, body.rememberDevice);
    },
  );

  // --- the admin surface: id in the path, behind share-links.* --------------------------------
  api.openapi(
    createRoute({
      method: "get",
      path: "/links",
      tags: TAGS,
      summary: "The workspace's share links",
      description:
        "Never the token and never the passcode — the row keeps only digests of both, and this keeps neither. `uses` counts distinct memberships admitted and `views` distinct view *sessions*; `visits` is how many of those memberships still hold a live binding. Note what `paused` means: it stops emitting the link's subject, so it suspends access for everyone the link already admitted, not merely new admissions. An exhausted link is the other way round — it admits nobody new but keeps working for the people already inside, so revoking is how access is taken away.",
      security: sessionSecurity,
      "x-requires": "share-links.read",
      middleware: [offering(), perm("share-links.read")] as const,
      request: { query: sl.ShareLinkListQuery },
      responses: { 200: jsonResponse(sl.ShareLinkListSchema, "Share links"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const q = c.req.valid("query");
      // A4: staff hold a permissive policy on `core.share_link`, so the caller's own tenant
      // context is enough here — unlike the public routes, which have no membership at all.
      const rows = await deps.db.withTenant(s.tenant, (tx) =>
        links().list(s.tenant, tx, {
          ...(q.status === undefined ? {} : { status: q.status }),
          includeRevoked: q.includeRevoked === "true",
          limit: q.limit,
        }),
      );
      return c.json({ links: rows.map(linkBody) }, 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/links",
      tags: TAGS,
      summary: "Mint a share link",
      description:
        "Returns the plaintext token **once**; the column holds its sha256 and nothing can show it again. The offering status decides both whether links may be issued at all and what shape they may take: `none` and `informational` refuse outright (`error.reason: links_not_permitted`), and under `506b` a link must name its audience — a domain allowlist or a list of addresses — because an 'any verified email' link is general solicitation, which Rule 506(b) does not permit (`error.reason: audience_too_open`). Domains do not match subdomains: `acme.com` admits `jane@acme.com` and refuses `jane@mail.acme.com`. A grant naming a resource kind no module registered is refused with `unsupported`; one naming a resource that does not exist in this workspace is 404 `unknown_resource`. A grant's `path` is derived from the resource (a folder's own path, so a folder link covers everything filed below it; none for a document), so send `{kind, id}`: a `path` that is not the derived one is 400 `resource_path_mismatch`. Needs a fresh session: a link is a standing invitation to a data room.",
      security: sessionSecurity,
      "x-requires": "share-links.manage+fresh",
      middleware: [offering(), perm("share-links.manage", { fresh: true })] as const,
      request: { body: jsonBody(sl.ShareLinkCreateBody) },
      responses: { 200: jsonResponse(sl.ShareLinkCreatedSchema, "Created"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const body = c.req.valid("json");
      try {
        const minted = await deps.db.withTenant(s.tenant, async (tx) => {
          // A link grant is a rule like any other, so it is canonicalised the way a direct or
          // invite grant is (review R1-A1/A2, pen test P1-03): the resource must exist in this
          // workspace (another tenant's id is the same 404 as one nobody minted), and the rule's
          // path is derived from the row — a folder's own path, so the link covers the folder's
          // documents too — never taken from the client. A client path that is not the derived one
          // is 400 `resource_path_mismatch`: a real folder id filed under `r` would otherwise
          // share the whole data room.
          const grants = [];
          for (const g of body.grants)
            grants.push({
              ...g,
              resource: await canonicalResource(
                tx,
                s.tenant,
                deps.registry.resourceKinds,
                g.resource,
              ),
            });
          return links().mint(s.tenant, tx, {
            label: body.label,
            ...(body.policy === undefined ? {} : { policy: body.policy }),
            grants,
            groupIds: body.groupIds,
            ...(body.passcode === undefined ? {} : { passcode: body.passcode }),
            ...(body.maxUses === undefined ? {} : { maxUses: body.maxUses }),
            ...(body.maxViews === undefined ? {} : { maxViews: body.maxViews }),
            ...(body.expiresAt === undefined ? {} : { expiresAt: new Date(body.expiresAt) }),
            actor: actorOf(c, s),
          });
        });
        return c.json(
          {
            link: linkBody(minted.link),
            token: minted.token,
            url: shareLinkUrl(deps, s.workspace, minted.token),
          },
          200,
        );
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "get",
      path: "/links/{id}/visits",
      tags: TAGS,
      summary: "Who came in through this link",
      description:
        "The memberships this link admitted, newest binding first, with how many view sessions each has spent. A binding that was revoked individually is still listed, with `revokedAt` set: the record of who was let in is evidence and does not disappear when access does.",
      security: sessionSecurity,
      "x-requires": "share-links.read",
      middleware: [offering(), perm("share-links.read")] as const,
      request: { params: sl.ShareLinkIdParams },
      responses: { 200: jsonResponse(sl.ShareLinkVisitListSchema, "Visits"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const id = c.req.valid("param").id;
      try {
        const body = await deps.db.withTenant(s.tenant, async (tx) => {
          const visits = await links().visits(s.tenant, tx, id);
          const names = await new MembershipRepo(s.tenant, tx).namesFor(
            visits.map((v) => v.membershipId),
          );
          return visits.map((v) => {
            const n = names.get(v.membershipId);
            return {
              membershipId: v.membershipId,
              displayName: n?.displayName ?? "",
              email: n?.email ?? null,
              firstSeenAt: v.firstSeenAt.toISOString(),
              lastSeenAt: v.lastSeenAt.toISOString(),
              views: v.views,
              revokedAt: v.revokedAt?.toISOString() ?? null,
            };
          });
        });
        return c.json({ visits: body }, 200);
      } catch (error) {
        rethrow(error);
      }
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/links/{id}/pause",
      tags: TAGS,
      summary: "Stop a link without ending it",
      description:
        "Reversible, and wider than it looks: a paused link stops emitting its subject, so everyone it has already admitted loses the access it granted, not merely new visitors. To a visitor holding the URL it is indistinguishable from revoked. `resume` puts it back.",
      security: sessionSecurity,
      "x-requires": "share-links.manage",
      middleware: [offering(), perm("share-links.manage")] as const,
      request: { params: sl.ShareLinkIdParams },
      responses: { 200: jsonResponse(sl.ShareLinkSchema, "Paused"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      return pauseBody(c, s, c.req.valid("param").id, true);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/links/{id}/resume",
      tags: TAGS,
      summary: "Let a paused link admit and grant again",
      security: sessionSecurity,
      "x-requires": "share-links.manage",
      middleware: [offering(), perm("share-links.manage")] as const,
      request: { params: sl.ShareLinkIdParams },
      responses: { 200: jsonResponse(sl.ShareLinkSchema, "Resumed"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      return pauseBody(c, s, c.req.valid("param").id, false);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/links/{id}/revoke",
      tags: TAGS,
      summary: "End a link, and choose what happens to the people it let in",
      description:
        "One write stops the link: `PrincipalRepo` stops emitting its subject and `acl_version` is bumped, so within this node the change is immediate and across nodes it is bounded by the five-second version re-read — which is what we claim rather than a number we do not deliver. `revokeMemberships` is a separate decision, defaults to **false**, and does less than its name suggests on purpose: it cuts the link's bindings, so the access *this link* gave ends, and it never ends a membership — the people it let in are members now, hold their own sessions, and may have access from groups and grants that have nothing to do with this link. Ending a membership is the membership-revocation path, a different decision with a different confirmation. Revoking twice is a no-op rather than a conflict — moving `revoked_at` forward would lie about when sharing actually stopped. Needs a fresh session.",
      security: sessionSecurity,
      "x-requires": "share-links.manage+fresh",
      middleware: [offering(), perm("share-links.manage", { fresh: true })] as const,
      request: { params: sl.ShareLinkIdParams, body: jsonBody(sl.ShareLinkRevokeBody) },
      responses: { 200: jsonResponse(OkSchema, "Revoked"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const id = c.req.valid("param").id;
      const body = c.req.valid("json");
      try {
        await deps.db.withTenant(s.tenant, (tx) =>
          links().revoke(s.tenant, tx, {
            linkId: id,
            actor: actorOf(c, s),
            revokeVisitors: body.revokeMemberships,
          }),
        );
      } catch (error) {
        rethrow(error);
      }
      // D8's in-process half: the bump inside the transaction makes every node re-read within
      // five seconds; this drops the caches built from the old version so this node is immediate.
      deps.authz.invalidate(s.workspace.id);
      return c.json({ ok: true as const }, 200);
    },
  );

  /**
   * Pause and resume are one operation with a boolean, and the `acl_version` bump inside the
   * service is the point: a pause that only hid the row from the admin list would go on
   * admitting people and go on granting the ones it already admitted.
   */
  async function pauseBody(c: Context<AppEnv>, s: Signed, id: string, paused: boolean) {
    try {
      const link = await deps.db.withTenant(s.tenant, (tx) =>
        links().setPaused(s.tenant, tx, id, paused),
      );
      deps.authz.invalidate(s.workspace.id);
      return c.json(linkBody(link), 200);
    } catch (error) {
      rethrow(error);
    }
  }
}
