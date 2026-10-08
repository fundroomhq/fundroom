import { isIPv4, isIPv6 } from "node:net";
import {
  hashCode,
  normalizeEmail,
  otpCode,
  otpEmail,
  sha256,
  verifyCode,
} from "@fundroom/identity";
import type { RateLimitRule } from "@fundroom/ports";
import {
  findUserIdByEmail,
  insertEmailUser,
  markEmailVerified,
} from "../operators/repos/operator-repo.js";
import { getPlan, listPlans, type Plan, type PlanLimits } from "../plans/plans.js";
import { auditPlatformChain } from "../workspaces/chains.js";
import { newWorkspaceId } from "../workspaces/placement.js";
import {
  type ProvisioningDeps,
  ProvisioningError,
  provisionWorkspaceInTx,
  withProvisioningClaim,
} from "../workspaces/provisioning.js";
import { slugInUse } from "../workspaces/repos/provisioning-repo.js";
import {
  consumeSignupChallenge,
  countSignupAttempt,
  insertSignupChallenge,
  invalidateSignupChallenges,
  lockOpenSignupChallenge,
  type SignupChallengeData,
} from "./repos/signup-repo.js";

/*
 * Self-service signup (E3.10, ADR-0058; owner: agent A), only with SIGNUP_MODE=open:
 * `POST /api/v1/signup/start` sends an email code (challenge kind `signup`, constant 250 ms floor,
 * no id in the response), `POST /api/v1/signup/verify` creates the user (if new), the workspace
 * (through `provisionWorkspace`), the owner membership, the `SIGNUP_DEFAULT_PLAN` and the ToS
 * attestation in one transaction.
 *
 * Budgets (fix round 1, R1-M2): per address, per client IP and per network (IPv4 /24, IPv6 /64,
 * and for starts also IPv6 /48 — fix round 3)
 * are checked FIRST, and only a request inside all of them touches the install-wide ceiling — so
 * one client cannot spend the global budget and lock everybody else out. The ceiling is high (a
 * last resort against a distributed flood) and hitting it logs `control_plane.signup_ceiling_hit`
 * at error level (alert on it).
 *
 * Terms (R1-L3): `start` requires `acceptTerms: true` and the `termsVersion` the applicant saw;
 * both are stored in the challenge, and `verify` writes the owner's attestation from the challenge
 * alone (`platform-terms:v<termsVersion>`, with when it was accepted). A stale version is refused
 * (409 `conflict`, `reason: terms_version`, `current`). The current version is configuration
 * (A-5: `SIGNUP_TERMS_VERSION`, `SignupDeps.termsVersion`).
 *
 * Plan (A-5): `verify` may name a plan; a public, unarchived one is used, anything else falls back
 * to the default plan silently (`signup.complete` then also records `requestedPlanId`). The
 * catalogue the applicant chooses from is `listSignupPlans`.
 *
 * What nothing here says: whether the address already has an account. `start` sends a code to
 * any address and answers the same after the same floor; `verify` finds or creates the user in the
 * same transaction as the workspace and answers the same either way (an existing user simply
 * becomes the owner of one more workspace — proving control of the address is what a sign-in
 * with an email code proves too). Nor does `start` look at the slug: availability is
 * `GET /signup/slug` (slugs are public hostnames), and a slug taken between start and verify is
 * a 409 `slug_taken` from `verify`, with nothing created.
 */

/** Signup budgets (verify + start): per address, per client IP / network, and the install ceiling. */
export const SIGNUP_BUDGETS = {
  perEmailPerHour: 5,
  startsPerIpPerHour: 10,
  startsPerNetworkPerHour: 30,
  /** IPv6 /48 (a site's whole allocation: one client can hold 65 536 /64s). */
  startsPerWideNetworkPerHour: 60,
  verifiesPerIpPerHour: 30,
  verifiesPerNetworkPerHour: 90,
  /** The last-resort ceiling, far above normal traffic; hitting it is an alert. */
  globalPerHour: 1000,
  slugChecksPerIpPerMinute: 30,
  /** A-5: `GET /signup/plans` (the public catalogue). */
  planListsPerIpPerMinute: 30,
} as const;

/** Minimum response time of `POST /signup/start`, whatever the outcome (E3.1 lesson). */
export const SIGNUP_START_FLOOR_MS = 250;
/** Minimum response time of `POST /signup/verify` (new and existing users take the same time). */
export const SIGNUP_VERIFY_FLOOR_MS = 250;

/**
 * The `core.attestation` kind the signup writes for the new owner membership: acceptance of the
 * managed host's own terms (`<slug>:v<n>`, the ADR-0032 stamp shape). There is no workspace legal
 * document behind it — the host's terms are not a tenant document — so the version moves here.
 * A-5: the current version is configuration (`SIGNUP_TERMS_VERSION`, wired as
 * `SignupDeps.termsVersion`); these constants are only its default.
 */
export const SIGNUP_TERMS_VERSION = 1;
export const SIGNUP_TERMS_ATTESTATION_KIND = `platform-terms:v${SIGNUP_TERMS_VERSION}`;

/** How long a signup code lives, and how many wrong guesses kill it. */
export const SIGNUP_CODE_TTL_MS = 10 * 60_000;
export const SIGNUP_CODE_MAX_ATTEMPTS = 5;

export const SIGNUP_RATES = {
  startPerEmail: { max: SIGNUP_BUDGETS.perEmailPerHour, windowMs: 3_600_000 },
  startPerIp: { max: SIGNUP_BUDGETS.startsPerIpPerHour, windowMs: 3_600_000 },
  startPerNetwork: { max: SIGNUP_BUDGETS.startsPerNetworkPerHour, windowMs: 3_600_000 },
  startPerWideNetwork: { max: SIGNUP_BUDGETS.startsPerWideNetworkPerHour, windowMs: 3_600_000 },
  verifyPerIp: { max: SIGNUP_BUDGETS.verifiesPerIpPerHour, windowMs: 3_600_000 },
  verifyPerNetwork: { max: SIGNUP_BUDGETS.verifiesPerNetworkPerHour, windowMs: 3_600_000 },
  startGlobal: { max: SIGNUP_BUDGETS.globalPerHour, windowMs: 3_600_000 },
  completeGlobal: { max: SIGNUP_BUDGETS.globalPerHour, windowMs: 3_600_000 },
  slugPerIp: { max: SIGNUP_BUDGETS.slugChecksPerIpPerMinute, windowMs: 60_000 },
  plansPerIp: { max: SIGNUP_BUDGETS.planListsPerIpPerMinute, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

/**
 * Hostnames a public signup may not claim as `<slug>.<canonical>`: they read as the service's own
 * (an operator can still create one on purpose through the platform API).
 */
export const SIGNUP_RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "www",
  "w",
  "api",
  "app",
  "admin",
  "auth",
  "oauth",
  "sso",
  "saml",
  "oidc",
  "scim",
  "id",
  "identity",
  "login",
  "logout",
  "signin",
  "signup",
  "register",
  "account",
  "accounts",
  "platform",
  "operator",
  "ops",
  "console",
  "dashboard",
  "billing",
  "webhook",
  "webhooks",
  "callback",
  "embed",
  "mail",
  "email",
  "smtp",
  "imap",
  "pop",
  "pop3",
  "mx",
  "autodiscover",
  "autoconfig",
  "mta-sts",
  "dmarc",
  "dkim",
  "ns",
  "ns1",
  "ns2",
  "ns3",
  "ns4",
  "dns",
  "ftp",
  "vpn",
  "status",
  "health",
  "metrics",
  "help",
  "support",
  "docs",
  "blog",
  "static",
  "assets",
  "cdn",
  "media",
  "files",
  "download",
  "downloads",
  "security",
  "root",
  "system",
  "internal",
  "localhost",
  "test",
  "staging",
  "dev",
  "demo",
  // A-5: the edge's own records (plan §6.2).
  "portals",
  "fallback",
]);

/**
 * Whether a public signup may never claim `slug`: a reserved name, or an IDNA A-label (`xn--…`,
 * which renders as a different — possibly lookalike — Unicode name in browsers).
 */
export function signupSlugReserved(slug: string): boolean {
  const s = slug.trim().toLowerCase();
  return SIGNUP_RESERVED_SLUGS.has(s) || s.startsWith("xn--");
}

/**
 * The rate-limit key of the client's network: IPv4 /24, IPv6 /64 (an IPv4-mapped IPv6 address
 * counts as its IPv4 address). `unknown` when there is no usable address.
 */
export function signupNetworkKey(ip: string | undefined): string {
  return networkKey(ip, 4);
}

/**
 * The IPv6 /48 of the client (fix round 3): a single site is routinely given a /48, i.e. 65 536
 * /64s, so the /64 bucket alone does not hold one client back. `undefined` for IPv4 (its /24 is
 * already the network bucket) and for an unusable address.
 */
export function signupWideNetworkKey(ip: string | undefined): string | undefined {
  const key = networkKey(ip, 3);
  return key.startsWith("v6:") ? key : undefined;
}

/** IPv4 /24, or the first `v6Groups` 16-bit groups of an IPv6 address. */
function networkKey(ip: string | undefined, v6Groups: number): string {
  if (ip === undefined) return "unknown";
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/iu.exec(ip);
  const v4 = mapped?.[1] ?? ip;
  if (isIPv4(v4)) return `v4:${v4.split(".").slice(0, 3).join(".")}`;
  if (!isIPv6(ip)) return "unknown";
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const h = head === "" ? [] : head.split(":");
  const t = tail === "" ? [] : tail.split(":");
  const groups = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  return `v6:${groups
    .slice(0, v6Groups)
    .map((g) => g.padStart(4, "0"))
    .join(":")}`;
}

export class SignupError extends Error {
  override readonly name = "SignupError";
  constructor(
    readonly code:
      | "invalid_code"
      | "too_many_attempts"
      | "rate_limited"
      | "slug_taken"
      | "not_found"
      | "invalid_request"
      | "terms_version"
      /** E3.11: the cell directory could not be asked whether the slug is free (503). */
      | "directory_unavailable",
    message: string,
    readonly details: {
      readonly retryAfterMs?: number;
      readonly attemptsLeft?: number;
      readonly current?: number;
    } = {},
  ) {
    super(message);
  }
}

export interface SignupDeps {
  /** db, audit, identity (key ring, mailer, rate limiter), hooks, seeding. */
  readonly provisioning: ProvisioningDeps;
  /** SIGNUP_DEFAULT_PLAN (checked at runtime: missing or archived → 404). */
  readonly defaultPlanId: string | undefined;
  /** A-5: the current platform terms version (`SIGNUP_TERMS_VERSION`, default 1). */
  readonly termsVersion: number;
  /**
   * A-5: whether a workspace can subscribe itself (CONTROL_PLANE=on and BILLING_DRIVER=stripe).
   * Only then is a priced plan `paid` to the applicant and a signup sent to checkout first.
   */
  readonly selfServeCheckout: boolean;
  /**
   * E3.11 (fix round 1, R2-7): whether another cell holds the slug, for the public availability
   * hint. MUST be cached and globally budgeted (the server wires `createDirectoryRouting`): the
   * question is anonymous, so an uncached directory round trip per check would let anybody drain
   * the directory pool that claims share. Answers false when it did not look (over budget,
   * directory down) — `verify` claims for real and is the authority. Absent: local only.
   */
  readonly slugHeldElsewhere?: ((slug: string) => Promise<boolean>) | undefined;
}

export interface SignupStartInput {
  readonly email: string;
  readonly companyName: string;
  readonly legalName: string;
  readonly country: string;
  readonly slug: string;
  readonly locale?: string | undefined;
  /** `true` only (the contract refuses anything else); stored in the challenge. */
  readonly acceptTerms: true;
  /** The terms version the applicant was shown; must be `SignupDeps.termsVersion`. */
  readonly termsVersion: number;
  readonly ip?: string | undefined;
}

export interface SignupVerifyInput {
  readonly email: string;
  readonly code: string;
  /** A-5: the plan the applicant chose; not public and live → the default plan. */
  readonly planId?: string | undefined;
  readonly ip?: string | undefined;
  readonly requestId?: string | undefined;
}

export interface SignupCompleted {
  readonly workspaceId: string;
  readonly slug: string;
  readonly name: string;
  readonly userId: string;
  readonly membershipId: string;
  /** The plan the workspace got (the chosen one, or the default). */
  readonly planId: string;
  /**
   * The owner should subscribe before anything else: the plan is public, has a provider price and
   * no trial, and checkout is self-serve (`SignupDeps.selfServeCheckout`). The billing page offers
   * only public plans, so a private (default) plan never lands there.
   */
  readonly checkoutFirst: boolean;
}

/** A plan as the public signup catalogue shows it (`GET /signup/plans`). */
export interface SignupPlan {
  readonly id: string;
  readonly name: string;
  readonly limits: PlanLimits;
  readonly trialDays: number;
  /** The plan has a provider price and checkout is self-serve (`selfServeCheckout`). */
  readonly paid: boolean;
}

/** Whether an applicant may choose the plan: public and unarchived. */
function signupSelectable(plan: Plan | undefined): plan is Plan {
  return plan?.public === true && plan.archivedAt === null;
}

function codeScope(email: string): string {
  return `signup:${email}`;
}

/** The rate-limiter key of an address (hashed: the limiter table holds no emails). */
function emailKey(email: string): string {
  return sha256(email).toString("hex");
}

async function floor<T>(minMs: number, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await fn();
  } finally {
    const remaining = minMs - (performance.now() - started);
    if (remaining > 0) await new Promise((res) => setTimeout(res, remaining));
  }
}

function rateLimited(retryAfterMs: number): SignupError {
  return new SignupError("rate_limited", "too many signups; try again later", { retryAfterMs });
}

/**
 * The per-client buckets (address when known, IP, network), all hit on every call, then — only
 * when every one of them admits the request — the install ceiling. Throws `rate_limited`.
 */
async function spendBudgets(
  deps: SignupDeps,
  phase: "start" | "verify",
  input: { readonly email?: string | undefined; readonly ip?: string | undefined },
): Promise<void> {
  const { identity } = deps.provisioning;
  const ipKey = sha256(input.ip ?? "unknown").toString("hex");
  const netKey = sha256(signupNetworkKey(input.ip)).toString("hex");
  const buckets: [string, RateLimitRule][] = [
    ...(input.email === undefined
      ? []
      : [
          [`signup:start:email:${emailKey(input.email)}`, SIGNUP_RATES.startPerEmail] as [
            string,
            RateLimitRule,
          ],
        ]),
    [
      `signup:${phase}:ip:${ipKey}`,
      phase === "start" ? SIGNUP_RATES.startPerIp : SIGNUP_RATES.verifyPerIp,
    ],
    [
      `signup:${phase}:net:${netKey}`,
      phase === "start" ? SIGNUP_RATES.startPerNetwork : SIGNUP_RATES.verifyPerNetwork,
    ],
  ];
  const wide = phase === "start" ? signupWideNetworkKey(input.ip) : undefined;
  if (wide !== undefined) {
    buckets.push([
      `signup:start:net48:${sha256(wide).toString("hex")}`,
      SIGNUP_RATES.startPerWideNetwork,
    ]);
  }
  // Every per-client bucket is hit on every call (no bucket's count depends on another's verdict).
  const decisions = [];
  for (const [key, rule] of buckets) decisions.push(await identity.rateLimiter.hit(key, rule));
  const refused = decisions.filter((d) => !d.allowed);
  if (refused.length > 0) throw rateLimited(Math.max(...refused.map((d) => d.retryAfterMs)));
  if (phase === "start") {
    const global = await identity.rateLimiter.hit("signup:start:global", SIGNUP_RATES.startGlobal);
    if (!global.allowed) {
      ceilingHit(deps, "start");
      throw rateLimited(global.retryAfterMs);
    }
  }
}

function ceilingHit(deps: SignupDeps, phase: "start" | "complete"): void {
  deps.provisioning.log?.("control_plane.signup_ceiling_hit", {
    level: "error",
    phase,
    max: SIGNUP_BUDGETS.globalPerHour,
  });
}

/** Whether a public signup may claim the slug right now. */
export async function signupSlugAvailable(deps: SignupDeps, slug: string): Promise<boolean> {
  const s = slug.trim().toLowerCase();
  if (signupSlugReserved(s)) return false;
  // Both questions, always, side by side (R2-7): a slug taken here and one taken in another
  // cell cost the same and answer the same `available: false` — never which, never where.
  const held = deps.slugHeldElsewhere;
  const [local, elsewhere] = await Promise.all([
    deps.provisioning.db.withHost((tx) => slugInUse(tx, s)),
    held === undefined ? Promise.resolve(false) : held(s).catch(() => false),
  ]);
  return !local && !elsewhere;
}

/**
 * Emails a signup code. Answers after `SIGNUP_START_FLOOR_MS` whatever happens; the only error is
 * `rate_limited` (the per-address and global budgets, which depend on nothing about the address).
 * A mail failure is logged, never surfaced.
 */
export async function startSignup(deps: SignupDeps, input: SignupStartInput): Promise<void> {
  const { identity } = deps.provisioning;
  const log = deps.provisioning.log;
  await floor(SIGNUP_START_FLOOR_MS, async () => {
    let email: string;
    try {
      email = normalizeEmail(input.email);
    } catch {
      throw new SignupError("invalid_request", "invalid email address");
    }
    if (input.acceptTerms !== true) {
      throw new SignupError("invalid_request", "the terms must be accepted");
    }
    if (input.termsVersion !== deps.termsVersion) {
      throw new SignupError("terms_version", "the terms changed; please review them again", {
        current: deps.termsVersion,
      });
    }
    await spendBudgets(deps, "start", { email, ip: input.ip });
    const now = identity.now?.() ?? new Date();
    const code = otpCode(6);
    const data: SignupChallengeData = {
      companyName: input.companyName.trim(),
      legalName: input.legalName.trim(),
      country: input.country.trim().toUpperCase(),
      slug: input.slug.trim().toLowerCase(),
      locale: input.locale ?? null,
      termsVersion: input.termsVersion,
      termsAcceptedAt: now.toISOString(),
    };
    await deps.provisioning.db.withHost(async (tx) => {
      await invalidateSignupChallenges(tx, email, now);
      await insertSignupChallenge(tx, {
        email,
        secretHash: hashCode(identity.keyRing, code, codeScope(email)),
        data,
        maxAttempts: SIGNUP_CODE_MAX_ATTEMPTS,
        ip: input.ip ?? null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + SIGNUP_CODE_TTL_MS),
      });
    });
    try {
      await identity.mailer.send(
        otpEmail(email, {
          productName: identity.productName,
          code,
          ttlMinutes: SIGNUP_CODE_TTL_MS / 60_000,
          ...(input.locale === undefined ? {} : { locale: input.locale }),
        }),
      );
    } catch (error) {
      log?.("control_plane.signup_mail_failed", {
        level: "warn",
        error: error instanceof Error ? error.name : "unknown",
      });
    }
  });
}

type CodeVerdict =
  | { readonly ok: true; readonly challengeId: string; readonly data: SignupChallengeData }
  | { readonly ok: false; readonly error: SignupError };

/** Checks the code in its own committed transaction (a wrong guess must stay counted). */
async function checkCode(
  deps: SignupDeps,
  email: string,
  code: string,
  now: Date,
): Promise<CodeVerdict> {
  const { identity } = deps.provisioning;
  return deps.provisioning.db.withHost(async (tx): Promise<CodeVerdict> => {
    const challenge = await lockOpenSignupChallenge(tx, email, now);
    if (challenge === undefined) {
      return { ok: false, error: new SignupError("invalid_code", "the code is wrong or expired") };
    }
    const attempts = await countSignupAttempt(tx, challenge.id);
    if (attempts > challenge.maxAttempts) {
      await consumeSignupChallenge(tx, challenge.id, now);
      return {
        ok: false,
        error: new SignupError("too_many_attempts", "too many wrong codes; start again"),
      };
    }
    if (!verifyCode(identity.keyRing, code.trim(), codeScope(email), challenge.secretHash)) {
      return {
        ok: false,
        error: new SignupError("invalid_code", "the code is wrong or expired", {
          attemptsLeft: Math.max(0, challenge.maxAttempts - attempts),
        }),
      };
    }
    return { ok: true, challengeId: challenge.id, data: challenge.data as SignupChallengeData };
  });
}

/**
 * Finishes a signup: in ONE host transaction the code is consumed, the user found or created, and
 * the workspace provisioned with the verified user as its active staff owner, the default plan,
 * the terms attestation and every hook — then `signup.complete` on the platform chain. A taken
 * slug (unique index, also under a race) is `slug_taken` with nothing created and the code left
 * unspent. The caller mints the session.
 */
export async function verifySignup(
  deps: SignupDeps,
  input: SignupVerifyInput,
): Promise<SignupCompleted> {
  const { identity } = deps.provisioning;
  return floor(SIGNUP_VERIFY_FLOOR_MS, async () => {
    let email: string;
    try {
      email = normalizeEmail(input.email);
    } catch {
      throw new SignupError("invalid_code", "the code is wrong or expired");
    }
    // Per client first (a guesser spends its own budget), before the code is even looked at.
    await spendBudgets(deps, "verify", { ip: input.ip });
    const now = identity.now?.() ?? new Date();
    const verdict = await checkCode(deps, email, input.code, now);
    if (!verdict.ok) throw verdict.error;
    const { data } = verdict;
    // The acceptance is the challenge's: a code issued without it (or for other terms) is refused
    // here, before anything is written — the challenge stays open, but can only ever be refused
    // again until it expires or a new start replaces it.
    if (data.termsVersion !== deps.termsVersion || typeof data.termsAcceptedAt !== "string") {
      throw new SignupError("terms_version", "the terms changed; please review them again", {
        current: deps.termsVersion,
      });
    }
    if (signupSlugReserved(data.slug)) {
      throw new SignupError("slug_taken", `the address "${data.slug}" is taken`);
    }
    const defaultPlanId = deps.defaultPlanId;
    if (defaultPlanId === undefined) throw new SignupError("not_found", "signup is not available");
    // The chosen plan when the applicant may choose it, else (silently) the default. A default
    // that is missing is the operator's problem: the same plain 404 as signup being closed (an
    // archived one is refused by provisioning below, to the same effect).
    const requestedPlanId = input.planId;
    const requested =
      requestedPlanId === undefined || requestedPlanId === defaultPlanId
        ? undefined
        : await deps.provisioning.db.withHost((tx) => getPlan(tx, requestedPlanId));
    const defaultPlan = () => deps.provisioning.db.withHost((tx) => getPlan(tx, defaultPlanId));
    const plan = signupSelectable(requested) ? requested : await defaultPlan();
    if (plan === undefined) throw new SignupError("not_found", "signup is not available");
    const budget = await identity.rateLimiter.hit(
      "signup:complete:global",
      SIGNUP_RATES.completeGlobal,
    );
    if (!budget.allowed) {
      ceilingHit(deps, "complete");
      throw rateLimited(budget.retryAfterMs);
    }

    const actor = {
      kind: "system",
      source: "signup",
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    } as const;
    // One workspace id for every attempt: a retry on the default plan (below) re-claims the slug
    // in the directory as the SAME workspace, which `claimSlug` treats as idempotent (or revives
    // once released) — a fresh id would find the first claim still reserved whenever its
    // best-effort release failed, and answer `slug_taken`.
    const workspaceId = newWorkspaceId();
    const provisionOn = async (
      plan: Plan,
    ): Promise<{
      completed: SignupCompleted;
      result: Awaited<ReturnType<typeof provisionWorkspaceInTx>>;
    }> => {
      // E3.11: the slug is claimed in the cell directory before the transaction opens (and
      // released if it rolls back); a claim refused there is the same `slug_taken`.
      const planId = plan.id;
      const claimInput = {
        slug: data.slug,
        name: data.companyName,
        legalName: data.legalName,
        country: data.country,
        ownerEmail: email,
        planId,
        workspaceId,
        actor,
      };
      try {
        return await withProvisioningClaim(deps.provisioning, claimInput, (workspaceId) =>
          deps.provisioning.db.withHost(async (tx) => {
            if (!(await consumeSignupChallenge(tx, verdict.challengeId, now))) {
              throw new SignupError("invalid_code", "the code is wrong or expired");
            }
            let userId = await findUserIdByEmail(tx, email);
            const newUser = userId === undefined;
            if (userId === undefined) userId = await insertEmailUser(tx, email, now);
            else await markEmailVerified(tx, email, now);
            const result = await provisionWorkspaceInTx(tx, deps.provisioning, {
              workspaceId,
              slug: data.slug,
              name: data.companyName,
              legalName: data.legalName,
              country: data.country,
              ownerEmail: email,
              planId,
              ...(data.locale === null ? {} : { locale: data.locale }),
              actor,
              owner: {
                kind: "member",
                userId,
                attestationKind: `platform-terms:v${data.termsVersion}`,
                attestationData: {
                  termsVersion: data.termsVersion,
                  acceptedAt: data.termsAcceptedAt,
                },
              },
            });
            await auditPlatformChain(tx, deps.provisioning.audit, actor, {
              action: "signup.complete",
              resourceKind: "workspace",
              resourceId: result.workspace.id,
              meta: {
                workspaceId: result.workspace.id,
                slug: result.workspace.slug,
                planId,
                ...(requestedPlanId === undefined || requestedPlanId === planId
                  ? {}
                  : { requestedPlanId }),
                newUser,
                terms: `platform-terms:v${data.termsVersion}`,
              },
            });
            return {
              result,
              completed: {
                workspaceId: result.workspace.id,
                slug: result.workspace.slug,
                name: result.workspace.name,
                userId,
                membershipId: result.ownerMembershipId as string,
                planId,
                checkoutFirst:
                  deps.selfServeCheckout &&
                  signupSelectable(plan) &&
                  plan.billingPriceRef !== null &&
                  plan.trialDays === 0,
              },
            };
          }),
        );
      } catch (error) {
        if (error instanceof ProvisioningError) {
          if (error.reason === "slug_taken") {
            throw new SignupError("slug_taken", error.message);
          }
          if (error.reason === "directory_unavailable") {
            throw new SignupError("directory_unavailable", error.message);
          }
          // The chosen plan was archived since it was read: the default, like any other plan the
          // applicant may not have (the code is still unspent — that transaction rolled back).
          if (error.reason === "plan_unavailable" && plan.id !== defaultPlanId) {
            const fallback = await defaultPlan();
            if (fallback !== undefined) return provisionOn(fallback);
          }
          // A missing or archived default plan, or no cell to place it on: the operator's problem,
          // and the same plain 404 as signup being closed.
          throw new SignupError("not_found", "signup is not available");
        }
        throw error;
      }
    };
    const { completed, result } = await provisionOn(plan);
    await result.afterCommit();
    return completed;
  });
}

/** The plans a public signup offers (public and unarchived, catalogue order), for `GET /signup/plans`. */
export async function listSignupPlans(deps: SignupDeps): Promise<readonly SignupPlan[]> {
  const plans = await deps.provisioning.db.withHost((tx) => listPlans(tx, { publicOnly: true }));
  return plans.filter(signupSelectable).map((p) => ({
    id: p.id,
    name: p.name,
    limits: p.limits,
    trialDays: p.trialDays,
    paid: deps.selfServeCheckout && p.billingPriceRef !== null,
  }));
}
