import { brandThemeDocument } from "@fundroom/branding";
import {
  ApiError,
  createRoute,
  embed as e,
  errorResponses,
  jsonBody,
  jsonResponse,
  type OpenAPIHono,
  requestIdOf,
  sessionSecurity,
} from "@fundroom/contracts";
import {
  lockWorkspaceFacts,
  type ResolvedWorkspace,
  systemContext,
  updateWorkspaceSettingsBlock,
} from "@fundroom/db";
import {
  type EmbedSettings,
  embedFrameAncestors,
  type HandoffKey,
  normalizeEmbedOrigin,
  PREVIEW_ORIGIN_PATTERNS,
  parseWorkspaceSettings,
  WorkspaceSettingsSchema,
} from "@fundroom/domain";
import type { EmbedArtifact } from "@fundroom/embed/artifacts";
import { EMBED_ARTIFACTS, EMBED_VERSION } from "@fundroom/embed/artifacts";
import { claimIdempotencyKey } from "@fundroom/events";
import {
  completeLogin,
  cookieModeFor,
  type HandoffRejection,
  handoffWireReason,
  isAuthError,
} from "@fundroom/identity";
import { issueSessionCookies } from "@fundroom/identity/http";
import type { JsonObject } from "@fundroom/ports";
import type { Context, Hono } from "hono";
import type { AppEnv } from "../env.js";
import type { Log } from "../logger.js";
import { requirePermission } from "../middleware/authz.js";
import { pageErrorResponse } from "../middleware/errors.js";
import { cookieBasePathOf } from "../path-mount.js";
import { type ApiDeps, clientIp, workspaceUrl } from "./deps.js";

/*
 * Embed (E2.2, EXECUTION_PLAN §9.3, design/08 §1c/§6, ADR-0008/0009/0040).
 *
 * Kernel routes behind a `required` manifest, for the fifth time and on the bluntest reason yet:
 * the allow-list this file governs becomes a response *header*. `frame-ancestors` is resolved by
 * `packages/http`'s security-headers middleware before the handler runs and before module
 * enablement is consulted, so a module that owned it could be switched off — and a switched-off
 * framing control fails *open*, leaving the embed document framed by anyone. A security header
 * must not belong to something with an off switch.
 *
 * Five things in this file are deliberate:
 *
 *  1. **There is no embed key.** design/08 §1c and plan §9.3 draw `?k=pk_…`; ADR-0040 refuses it.
 *     The slug is already public (`<slug>.<canonical>`, `/w/<slug>`), so a key hides nothing and
 *     gates nothing — the workspace comes from the path — while rotating it would break every
 *     live snippet. The framing controls are `frame-ancestors` and the origin check in `web.ts`.
 *  2. **Embed origins are NOT added to CORS or CSRF.** The iframe is same-origin with the API it
 *     calls, so it needs neither, and adding them would let host-page JS make credentialed
 *     state-changing calls — precisely the host-XSS-forges-API-calls threat the iframe exists to
 *     prevent (design/08 §6). See the comment in `middleware/cors.ts`.
 *  3. **`PUT` needs step-up.** design/02 §78 lists this class of change and E2.1 followed it for
 *     custom domains: the framing allow-list decides whose page may wrap the portal in its own
 *     chrome, so a stolen session that could add an origin would be a clickjacking primitive.
 *  4. **Everything derived is derived on every read** — `frameAncestors`, the snippet URLs, the
 *     SRI value. A stored copy is wrong the moment the list, the loader build or the workspace's
 *     custom domain changes, and wrong asymmetrically: the screen would show one allow-list while
 *     the header sent another. (E1.7 for theme tokens, E2.1 for DNS records.)
 *  5. **The loader is served from memory.** `@fundroom/embed/artifacts` is a committed generated
 *     module, so there is no filesystem layout and no Docker-image assumption between the built
 *     bundle and the route that serves it, and a self-hoster gets the loader with no CDN at all
 *     (E2.2 decision 9).
 *
 * The three unauthenticated surfaces (`theme.json`, the loader, the manifest) are not OpenAPI
 * operations and are registered in `app.ts` ahead of the SPA catch-all by
 * `registerEmbedPublicRoutes`; `packages/contracts/src/embed.ts` says why.
 */
const ERRORS = errorResponses(400, 401, 403, 404, 409, 429, 500, 503);
const TAGS = ["embed"];

/** Five minutes: long enough to be worth a cache, short enough that a brand change shows. */
const THEME_CACHE_CONTROL = "public, max-age=300";
/** The rolling channel. An hour, then serve stale while a new build is fetched. */
const LOADER_ROLLING_CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
/** The pinned channel. The path contains the version, so the bytes can never change under it. */
const LOADER_PINNED_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * The IIFE build, which is what a snippet's `<script src>` points at and what `loaderIntegrity`
 * describes. `embed.mjs` is the same loader for a bundler; both are served, one is advertised.
 */
const LOADER_IIFE_PATH = "embed.js";

/**
 * Most handoff attempts we will verify for one workspace per minute.
 *
 * A handoff happens once per visitor per host session, so this is generous for a real site and
 * still bounds what an anonymous caller can buy: an Ed25519 verification plus, on success, a
 * session insert. Keyed on the workspace rather than the client IP because the workspace is the
 * resource being protected and the IP is attacker-supplied behind a trusted proxy (the mistake
 * E2.1 S3 recorded about the `ask` endpoint's limiter).
 */
const HANDOFF_RATE_LIMIT = { max: 60, windowMs: 60_000 } as const;

/**
 * How long a spent `jti` is remembered. Assertions live at most 60 s (E2.2 §6), so anything
 * beyond that is slack for clock skew and retries; a day costs one small row per handoff and
 * makes "this assertion was already used" an answer rather than a guess.
 */
const HANDOFF_JTI_TTL_MS = 24 * 3600_000;

interface Signed {
  readonly tenant: NonNullable<AppEnv["Variables"]["tenant"]>;
  readonly session: NonNullable<AppEnv["Variables"]["session"]>;
  readonly workspace: ResolvedWorkspace;
}

function signed(c: Context<AppEnv>): Signed {
  const tenant = c.get("tenant");
  const session = c.get("session");
  const workspace = c.get("workspace");
  if (!tenant || !session || !workspace) throw new ApiError("unauthenticated");
  return { tenant, session, workspace };
}

/** The resolved workspace, for the routes that serve anyone. */
function anyWorkspace(c: Context<AppEnv>): ResolvedWorkspace {
  const workspace = c.get("workspace");
  if (workspace === undefined) throw new ApiError("setup_required");
  return workspace;
}

function embedSettingsOf(workspace: Pick<ResolvedWorkspace, "settings">): EmbedSettings {
  return parseWorkspaceSettings(workspace.settings).embed;
}

/** The two channels the snippet can name: the rolling one, and the one an SRI value belongs to. */
/** Relative to the base (BASE_URL carries it; `workspaceUrl` resolves against BASE_URL). */
function embedLoaderPaths(): { readonly rolling: string; readonly pinned: string } {
  return {
    rolling: `/embed/v1/${LOADER_IIFE_PATH}`,
    pinned: `/embed/${EMBED_VERSION}/${LOADER_IIFE_PATH}`,
  };
}

/**
 * `EmbedSettingsSchema`: the stored block plus everything the admin screen needs derived.
 *
 * Every URL is built on the *workspace's* origin — its verified custom domain when it has one
 * (E2.1 decision 5), else `<slug>.<canonical>` — so the snippet a founder copies names one host
 * for both the `<script src>` and the iframe. A host page's CSP then needs one entry rather than
 * two, and the loader is fetched from the same origin the frame is served from.
 */
function settingsBody(deps: ApiDeps, workspace: ResolvedWorkspace) {
  const settings = embedSettingsOf(workspace);
  const paths = embedLoaderPaths();
  const url = (path: string) =>
    workspaceUrl(deps.baseUrl, deps.tenancy, workspace, path, deps.basePath).href;
  const iife = EMBED_ARTIFACTS.find((a: EmbedArtifact) => a.path === LOADER_IIFE_PATH);
  return {
    origins: [...settings.origins],
    allowPreviewOrigins: settings.allowPreviewOrigins,
    trustHostIdentity: settings.trustHostIdentity,
    handoffKeys: settings.handoffKeys.map((k) => ({ ...k })),
    frameAncestors: [...embedFrameAncestors(settings)],
    previewOriginPatterns: [...PREVIEW_ORIGIN_PATTERNS],
    embedUrl: url(`/embed/${workspace.slug}`),
    loaderUrl: url(paths.rolling),
    loaderIntegrity: iife?.sha384 ?? "",
    loaderPinnedUrl: url(paths.pinned),
  };
}

/**
 * `HandoffRejection` onto the one API code that fits: this assertion does not authenticate you.
 *
 * The reason is narrowed on the way out. `unknown_key` and `bad_signature` both become
 * `invalid_assertion`, because telling them apart on a public, unauthenticated route is a `kid`
 * oracle: a prober learns which key ids a workspace has registered, one request at a time. The
 * precise reason still reaches `embed.handoff_rejected` in the audit log, which is where an
 * operator debugging a plugin needs it and where an attacker cannot read it. Everything else
 * passes through unchanged — `lifetime`, `audience`, `claims` and the rest describe the token the
 * caller is already holding, so naming them tells them nothing they did not mint themselves, and
 * withholding them would make a working plugin impossible to debug.
 *
 * `replayed` stays distinguishable for the same reason: it is a fact about the caller's own `jti`.
 */
function rejectHandoff(
  reason: HandoffRejection | "replayed" | "not_eligible" | "membership_expired",
): never {
  const wire =
    reason === "replayed" || reason === "not_eligible" || reason === "membership_expired"
      ? reason
      : handoffWireReason(reason);
  throw new ApiError("invalid_credential", "that handoff assertion was not accepted", {
    reason: wire,
  });
}

export function registerEmbedRoutes(api: OpenAPIHono<AppEnv>, deps: ApiDeps): void {
  const perm = (p: string, extra: { readonly fresh?: boolean } = {}) =>
    requirePermission({ authz: () => deps.authz }, p, extra);

  api.openapi(
    createRoute({
      method: "get",
      path: "/embed/settings",
      tags: TAGS,
      summary: "The embed configuration, with the framing allow-list and snippet URLs derived",
      description:
        "`frameAncestors` is what the `Content-Security-Policy` on `/embed/<slug>` actually sends, derived on every read rather than stored — a stored copy would let the screen claim one allow-list while the header sent another. `previewOriginPatterns` is the curated builder-preview list that `allowPreviewOrigins` adds; those wildcards are ours and are never accepted from a customer. `loaderIntegrity` belongs to `loaderPinnedUrl`, not to the rolling `loaderUrl`: an SRI value only makes sense against bytes that cannot change.",
      security: sessionSecurity,
      "x-requires": "embed.read",
      middleware: [perm("embed.read")] as const,
      responses: { 200: jsonResponse(e.EmbedSettingsSchema, "Embed settings"), ...ERRORS },
    }),
    async (c) => c.json(settingsBody(deps, signed(c).workspace), 200),
  );

  api.openapi(
    createRoute({
      method: "put",
      path: "/embed/settings",
      tags: TAGS,
      summary: "Change the embed configuration",
      description:
        "Origins are exact: an `https://` origin with no path (`http://` only on loopback, which a browser treats as a secure context). A customer-entered wildcard is refused, because `https://*.acme.com` is an instruction to trust every host anyone can put under that zone — a stale staging box, a subdomain-takeover target — and the only wildcards in the product are the curated builder-preview patterns behind `allowPreviewOrigins`. `handoffKeys` is a whole-list replace and not a delta: a key that is absent is removed. `addedAt` is stamped by the server and preserved for a key already registered under the same id and public key. Needs a fresh session: the framing allow-list decides whose page may wrap this portal in its own chrome.",
      security: sessionSecurity,
      "x-requires": "embed.manage+fresh",
      middleware: [perm("embed.manage", { fresh: true })] as const,
      request: { body: jsonBody(e.EmbedSettingsPatchBody) },
      responses: { 200: jsonResponse(e.EmbedSettingsSchema, "Embed settings"), ...ERRORS },
    }),
    async (c) => {
      const s = signed(c);
      const patch = c.req.valid("json");
      /*
       * Origins are checked here rather than by the contract schema, and named one at a time.
       *
       * `normalizeEmbedOrigin` in `@fundroom/domain` is the authority on what an origin is, and
       * `packages/contracts` keeps no `@fundroom/*` dependencies so the generated SDK builds from the
       * contract alone — so the contract bounds the length and this validates the meaning. Doing
       * it before the settings parse is what turns a refusal into a 400 naming *which* origin and
       * why, rather than the 500 a `ZodError` escaping the schema transform would produce.
       */
      for (const origin of patch.origins ?? []) {
        if (normalizeEmbedOrigin(origin) === undefined) {
          throw new ApiError(
            "invalid_request",
            "an origin must be an https:// origin with no path (http:// only on loopback); wildcards are not accepted, and the builder-preview patterns are behind allowPreviewOrigins",
            { reason: "invalid_origin", origin },
          );
        }
      }
      /*
       * The settings idiom (A-3 R2 M1, `branding.ts`): the patch is merged into the `embed` block
       * as the row-locked transaction reads it (never the request's cached copy), and only that
       * block is written (`updateWorkspaceSettingsBlock`) — a concurrent writer of any other
       * block keeps its change. Row lock first, audit last (E3.5 LX).
       */
      const next = await deps.db.withTenant(s.tenant, async (tx) => {
        const current = parseWorkspaceSettings(
          (await lockWorkspaceFacts(tx, s.workspace.id))?.settings,
        );
        const next = WorkspaceSettingsSchema.parse({
          ...current,
          embed: {
            ...current.embed,
            ...patch,
            ...(patch.handoffKeys === undefined
              ? {}
              : { handoffKeys: stampHandoffKeys(current.embed.handoffKeys, patch.handoffKeys) }),
          },
        });
        await updateWorkspaceSettingsBlock(tx, s.workspace.id, "embed", next.embed);
        await deps.audit.record(tx, s.tenant, {
          action: "embed.settings_changed",
          resourceKind: "workspace",
          resourceId: s.workspace.id,
          requestId: requestIdOf(c),
          // The whole block before and after, not the patch: an operator reading this needs to
          // see the allow-list that was in force, and a diff of "what was sent" cannot show a
          // list that shrank because a key was left out of a whole-list replace.
          diff: { before: { ...current.embed }, after: { ...next.embed } },
          meta: { fields: Object.keys(patch) },
        });
        return next;
      });
      // `frame-ancestors` and the SSR bridge list are read from the resolved workspace's
      // `settings` on every request, so a stale cached row would keep sending the old allow-list
      // to every framed page until the resolver's TTL expired.
      deps.resolver.invalidate();
      return c.json(settingsBody(deps, { ...s.workspace, settings: next }), 200);
    },
  );

  api.openapi(
    createRoute({
      method: "post",
      path: "/embed/handoff",
      tags: TAGS,
      summary: "Exchange a host-signed identity assertion for a partitioned session (public)",
      description:
        "Signed host identity handoff, off unless the workspace turned `trustHostIdentity` on. The assertion is a compact JWS signed with EdDSA (Ed25519) by a key whose *public* half is registered here — there is no secret of ours at rest, and a compromise of our database cannot mint one. The key is selected by `kid` from the registered list and never by the token's own `alg`. It is single-use (`jti`), lives at most 60 seconds, must name this workspace in `aud`, and the email in `sub` must already hold a membership: a handoff proves who the host says this is, never what they may see. The session is `auth_level` 0, so every step-up gate in the product still asks. It arrives in a POST body rather than a URL because a URL is logged, refereed, shared and kept in history.",
      "x-requires": "public",
      request: { body: jsonBody(e.HandoffBody) },
      responses: {
        200: jsonResponse(e.HandoffResultSchema, "Signed in; session cookie set"),
        ...ERRORS,
      },
    }),
    async (c) => {
      const workspace = anyWorkspace(c);
      const settings = embedSettingsOf(workspace);
      const ctx = systemContext(workspace.id);
      const ip = clientIp(c, deps.trustProxy);
      const userAgent = c.req.header("user-agent")?.slice(0, 512);
      const audit = async (
        action: "embed.handoff_accepted" | "embed.handoff_rejected",
        meta: JsonObject,
        extra: { sessionId?: string; userId?: string } = {},
      ) => {
        try {
          await deps.audit.recordDetached(ctx, {
            action,
            resourceKind: "session",
            outcome: action === "embed.handoff_accepted" ? "success" : "denied",
            actorKind: "external",
            actorMembershipId: null,
            ...(extra.userId === undefined ? {} : { actorUserId: extra.userId }),
            ...(extra.sessionId === undefined ? {} : { sessionId: extra.sessionId }),
            requestId: requestIdOf(c),
            ip,
            userAgent,
            meta,
          });
        } catch (error) {
          // Never turn a refused handoff into a 500 because the audit write failed; ops sees
          // the log line. `auth.login_failed` makes the same trade in `login.ts`.
          deps.log("embed.audit_failed", { level: "warn", action, error: String(error) });
        }
      };

      /*
       * Off by default and worth reading as what it is: while this is on, a host-site compromise
       * becomes investor impersonation in this workspace. The refusal is explicit rather than a
       * 404, because the plugin author on the other end needs to know the switch exists.
       */
      if (!settings.trustHostIdentity) {
        throw new ApiError("forbidden", "this workspace does not accept host identity handoff", {
          reason: "handoff_disabled",
        });
      }

      const limit = await deps.rateLimiter.hit(`embed.handoff:${workspace.id}`, {
        max: HANDOFF_RATE_LIMIT.max,
        windowMs: HANDOFF_RATE_LIMIT.windowMs,
      });
      if (!limit.allowed) {
        throw new ApiError("rate_limited", "too many handoff attempts", {
          retryAfterMs: limit.retryAfterMs,
        });
      }

      const verdict = await deps.handoff.verifyAssertion({
        assertion: c.req.valid("json").assertion,
        workspaceSlug: workspace.slug,
        keys: settings.handoffKeys,
        now: new Date(),
      });
      if (!verdict.ok) {
        await audit("embed.handoff_rejected", { reason: verdict.reason });
        rejectHandoff(verdict.reason);
      }

      /*
       * Single use, on `core.idempotency_key` rather than a fifth single-use table (E2.2
       * decision 7): that table already has the primary-key serialisation two concurrent
       * claimants need, a fence that admits the host actor, and a sweep. The claim happens
       * BEFORE the session is minted and in its own transaction, because `completeLogin` owns
       * the transaction the session row is written in — so the honest ordering is "spend the
       * assertion, then act on it", which fails closed: a crash between the two costs the
       * visitor one retry, where the reverse would hand a replay a second session.
       */
      const claimed = await deps.db.withTenant(ctx, (tx) =>
        claimIdempotencyKey(tx, ctx, `auth.handoff:${workspace.id}:${verdict.jti}`, {
          ttlMs: HANDOFF_JTI_TTL_MS,
        }),
      );
      if (!claimed) {
        await audit("embed.handoff_rejected", { reason: "replayed", keyId: verdict.keyId });
        rejectHandoff("replayed");
      }

      let result: Awaited<ReturnType<typeof completeLogin>>;
      try {
        result = await completeLogin(deps.identityDeps, deps.auth.sessions, {
          email: verdict.email,
          method: "host",
          // The host asserted this identity; nobody proved it to us. `AUTH_LEVEL.host` is 0, so
          // the data room's step-up and every other gate still ask (E2.2 decision 8).
          authLevel: 0,
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          embed: true,
          topSite: verdict.issuer,
          ip,
          userAgent,
          rememberDevice: false,
          // The framed session this browser already held ends when the handoff's is issued (F-12).
          replacesSessionId: c.get("session")?.sessionId,
        });
      } catch (error) {
        /*
         * `not_eligible` is the membership requirement doing its job: the host may assert any
         * address it likes, and only one that already holds a membership here signs in. It is
         * reported as a rejected assertion rather than as an enumeration-friendly "no such
         * member", and the audit event says which. `membership_expired` (E3.2) is the same
         * requirement a step later: the address is a member, but that membership has ended. The
         * host signed the assertion, so naming it tells the caller nothing it could not know, and
         * lets the plugin say "access ended" instead of "not a member".
         */
        if (
          !isAuthError(error) ||
          (error.code !== "not_eligible" && error.code !== "membership_expired")
        )
          throw error;
        await audit("embed.handoff_rejected", { reason: error.code, keyId: verdict.keyId });
        rejectHandoff(error.code);
      }

      await audit(
        "embed.handoff_accepted",
        { keyId: verdict.keyId, issuer: verdict.issuer, jti: verdict.jti },
        { sessionId: result.session.sessionId, userId: result.session.userId },
      );
      issueSessionCookies(c, {
        token: result.token,
        deviceToken: result.deviceToken,
        /*
         * `partitioned` unconditionally, not `cookieModeOf(c)`.
         *
         * The classifier now keeps `/embed/<slug>/api/*` in the embed context, so the framed
         * SPA's own call would derive the same answer — but this route is public and answers on
         * `/w/<slug>/api/v1/embed/handoff` too, where it would not. A handoff assertion is minted
         * by a host page's server and posted over the bridge: the session it buys is a
         * third-party-iframe session by construction, whichever spelling of the path it arrived
         * on. `SameSite=None; Partitioned` (CHIPS, ADR-0009) is the only recipe a browser will
         * send back from inside the frame, and `completeLogin({ embed: true })` has already
         * recorded the row as `session.context = 'partitioned'` to match.
         *
         * Under a base path (BASE_PATH or a path mount, E3.9) it is `partitioned_path_mount`:
         * `__Secure-…; Path=<public base>`, since `__Host-` forbids a non-root Path.
         */
        mode: cookieModeFor({ embed: true, basePath: cookieBasePathOf(c) }),
        basePath: cookieBasePathOf(c),
      });
      return c.json({ ok: true as const, authLevel: 0 as const }, 200);
    },
  );
}

/**
 * The stored key list for a whole-list replace, `addedAt` preserved where the key is unchanged.
 *
 * Identity is (id, public key), not id alone: re-pointing a `kid` at different bytes is a new
 * key however it is spelled, and dating it from the row it replaced would make the audit trail
 * claim the new key had been trusted since before it existed.
 */
export function stampHandoffKeys(
  current: readonly HandoffKey[],
  next: readonly { id: string; publicKey: string; label: string }[],
  now = new Date(),
): HandoffKey[] {
  const previous = new Map(current.map((k) => [`${k.id}\u0000${k.publicKey}`, k.addedAt]));
  const addedAt = now.toISOString();
  return next.map((k) => ({
    id: k.id,
    publicKey: k.publicKey,
    label: k.label,
    addedAt: previous.get(`${k.id}\u0000${k.publicKey}`) ?? addedAt,
  }));
}

// --- the unauthenticated surfaces -------------------------------------------------------------

export interface EmbedPublicRoutesOptions {
  readonly basePath: string;
}

/**
 * `theme.json`, the loader and the SRI manifest. Registered in `app.ts` **ahead of the SPA
 * catch-all** (`${basePath}/*`), which would otherwise swallow all three and answer an HTML
 * document to a `<script src>`.
 *
 * Cache-Control is set by each handler and survives: the `asset` header profile deliberately
 * sets no default, and `securityHeaders` only fills one in when the response carries none.
 */
export function registerEmbedPublicRoutes(
  app: Hono<AppEnv>,
  options: EmbedPublicRoutesOptions,
): void {
  const { basePath } = options;

  /*
   * The workspace's theme as a DTCG document, for the loader's `theme` bridge message and for a
   * host page that wants the tokens before the frame has loaded.
   *
   * CORS-open and credential-free: a host page on any origin may read it, and there is nothing
   * here a visitor to the portal's own sign-in page cannot already see (E1.7 made `GET
   * /branding/theme` public for exactly that reason). `Access-Control-Allow-Origin: *` and
   * credentials are mutually exclusive by specification, which is the property that makes this
   * safe to open — a browser will not attach the session cookie to a `*` request.
   */
  app.get(`${basePath}/embed/:slug/theme.json`, (c) => {
    const workspace = c.get("workspace");
    if (workspace === undefined) {
      return pageErrorResponse(c, new ApiError("setup_required", "no workspace here"));
    }
    return c.json(brandThemeDocument(parseWorkspaceSettings(workspace.settings).branding), 200, {
      "Cache-Control": THEME_CACHE_CONTROL,
      "Access-Control-Allow-Origin": "*",
      "X-Content-Type-Options": "nosniff",
    });
  });

  /*
   * The loader, from the committed generated module rather than from disk.
   *
   * `Access-Control-Allow-Origin: *` because `embed.mjs` is imported as a module by host
   * bundlers and a cross-origin module script is a CORS request — a classic `<script src>` is
   * not, but serving one channel that works and one that silently does not would be worse than
   * opening both. The bytes are public and carry no session, so there is nothing to protect.
   */
  const artifact = (path: string, cacheControl: string) => (c: Context<AppEnv>) => {
    const found = EMBED_ARTIFACTS.find((a: EmbedArtifact) => a.path === path);
    if (found === undefined) {
      return pageErrorResponse(c, new ApiError("not_found", "no such loader artifact"));
    }
    const etag = `"${found.sha384}"`;
    const headers = {
      "Cache-Control": cacheControl,
      "Content-Type": found.contentType,
      "Access-Control-Allow-Origin": "*",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    };
    const inm = c.req.header("if-none-match");
    if (inm !== undefined && matchesArtifactEtag(inm, found.sha384))
      return c.body(null, 304, headers);
    return c.body(found.code, 200, headers);
  };

  // `manifest.json` is one of the artifacts (the generator emits it beside the two bundles), so
  // it is served by the same loop rather than assembled here: one source of SRI values, and a
  // manifest that cannot disagree with the bytes it describes.
  for (const a of EMBED_ARTIFACTS) {
    // Rolling: the channel a snippet names, so a fix reaches every live embed without anybody
    // editing their site. An hour of freshness, a day of serving stale while we revalidate.
    app.get(`${basePath}/embed/v1/${a.path}`, artifact(a.path, LOADER_ROLLING_CACHE_CONTROL));
    // Pinned: the version is in the path, so the bytes behind it can never change and a year of
    // `immutable` is honest. This is the URL an SRI value belongs to.
    app.get(
      `${basePath}/embed/${EMBED_VERSION}/${a.path}`,
      artifact(a.path, LOADER_PINNED_CACHE_CONTROL),
    );
  }
}

/** `If-None-Match` is a list, may be weak, and `*` matches anything we hold. */
function matchesArtifactEtag(header: string, value: string): boolean {
  return header
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || t.replace(/^W\//u, "").replace(/"/gu, "") === value);
}

// --- the rejected-framing audit ---------------------------------------------------------------

/** One refused embed document, as `web.ts`'s origin check observed it. */
export interface EmbedOriginRejection {
  readonly workspaceId: string;
  /** The initiator's origin, already normalised and lower-cased. */
  readonly origin: string;
  readonly requestId?: string | undefined;
  readonly ip?: string | undefined;
}

export type EmbedOriginAudit = (rejection: EmbedOriginRejection) => void;

/**
 * Records `embed.origin_rejected`, **throttled per (workspace, origin)** (E2.2 §5, plan §15
 * "origin checks + audit of rejections").
 *
 * The throttle is the point, not an optimisation. The audit log is hash-chained per workspace:
 * every row links to the previous one, so writes to a workspace's chain serialise, and an
 * unauthenticated request that can append to it is a remote way to both grow that table and
 * queue up behind every real audit write in the workspace. A single disallowed page embedding
 * the portal would otherwise write one row per visitor per page view.
 *
 * The cache is bounded and clears when full — the `BRAND_CACHE_MAX` / `LOOKUP_CACHE_MAX`
 * pattern (see `packages/custom-domains/src/service/lookup.ts`), which is O(1), keeps no LRU
 * bookkeeping on a request path, and costs at most one extra audit row per live (workspace,
 * origin) pair after a clear. Keys are attacker-supplied — the origin comes from a `Referer` —
 * so a size cap and not only a TTL is what closes the memory-pressure vector.
 *
 * Fire-and-forget by contract: the document has already been refused, and an audit write must
 * never be able to fail or slow the page that refused it.
 */
export interface EmbedOriginAuditOptions {
  readonly audit: Pick<ApiDeps["audit"], "recordDetached">;
  readonly log: Log;
  /** One row per (workspace, origin) per window. Default 10 minutes. */
  readonly windowMs?: number | undefined;
  /** Ceiling on remembered pairs. Default 1 000. */
  readonly max?: number | undefined;
  readonly now?: (() => Date) | undefined;
}

export const EMBED_REJECTION_WINDOW_MS = 10 * 60_000;
export const EMBED_REJECTION_CACHE_MAX = 1_000;

export function createEmbedOriginAudit(options: EmbedOriginAuditOptions): EmbedOriginAudit {
  const windowMs = options.windowMs ?? EMBED_REJECTION_WINDOW_MS;
  const max = options.max ?? EMBED_REJECTION_CACHE_MAX;
  const now = options.now ?? (() => new Date());
  const seen = new Map<string, number>();

  return (rejection) => {
    const key = `${rejection.workspaceId}\u0000${rejection.origin}`;
    const t = now().getTime();
    const until = seen.get(key);
    if (until !== undefined && until > t) return;
    if (seen.size >= max) seen.clear();
    seen.set(key, t + windowMs);
    void options.audit
      .recordDetached(systemContext(rejection.workspaceId), {
        action: "embed.origin_rejected",
        resourceKind: "workspace",
        resourceId: rejection.workspaceId,
        outcome: "denied",
        actorKind: "system",
        actorMembershipId: null,
        actorUserId: null,
        requestId: rejection.requestId,
        ip: rejection.ip,
        meta: { origin: rejection.origin, throttleWindowMs: windowMs },
      })
      .catch((error: unknown) => {
        options.log("embed.origin_rejected_audit_failed", {
          level: "warn",
          workspaceId: rejection.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  };
}
