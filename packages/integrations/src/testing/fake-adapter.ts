import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type {
  BookingEvent,
  IntegrationAdapter,
  IntegrationAuth,
  IntegrationProvider,
  IntegrationProviderMeta,
  IntegrationResult,
  KpiReadValue,
  OAuthTokenSet,
} from "@fundroom/ports";

/*
 * An in-memory vendor for kernel tests (never shipped). It behaves like the real ones where the
 * kernel cares: OAuth code exchange, ROTATING refresh tokens (a used refresh token is dead —
 * reusing it answers `unauthorized`, i.e. invalid_grant), access tokens that can be expired or
 * revoked, a KPI read, Slack channels, and a Calendly-style signed booking webhook
 * (`fake-webhook-signature: t=<unix>,v1=<hex hmac-sha256(key, "t.body")>`, 5 min tolerance).
 * Every call is counted; `gate` lets a test hold a vendor call open.
 */

export interface FakeVendorCalls {
  exchange: number;
  refresh: number;
  verify: number;
  kpi: number;
  chat: number;
  subscribe: number;
  unsubscribe: string[];
  revoke: string[];
  lastExchange?: {
    code: string;
    codeVerifier: string | null;
    query: Record<string, string>;
    redirectUri: string;
  };
}

export interface FakeVendor {
  readonly adapter: IntegrationAdapter;
  readonly calls: FakeVendorCalls;
  /** Access tokens the vendor accepts. Delete one to simulate expiry/revocation. */
  readonly accessTokens: Set<string>;
  /** Refresh tokens the vendor accepts (rotated on use). */
  readonly refreshTokens: Set<string>;
  /** Secrets (secret providers) the vendor refuses. */
  readonly refusedSecrets: Set<string>;
  /** The code the fake consent screen issues; `exchangeCode` accepts only it. */
  code: string;
  /** Access-token lifetime handed out by exchange/refresh (ms). */
  accessTtlMs: number;
  /** Delay inside `refresh` (ms), so concurrent callers overlap. */
  refreshDelayMs: number;
  /** When set, `kpi.read` / `verify` wait for it before answering. */
  gate: Promise<void> | undefined;
  /** Forces the next refresh to fail with this reason. */
  failRefresh: "unauthorized" | "transport" | undefined;
  /** Forces KPI reads to fail with this reason. */
  failKpi: "transport" | "unauthorized" | undefined;
  /** Xero-style organisation list returned on exchange. */
  accounts: { id: string; name: string }[] | undefined;
  /** Mint a token pair the vendor accepts (as if issued earlier). */
  issue(): OAuthTokenSet;
}

const token = (prefix: string) => `${prefix}_${randomBytes(12).toString("hex")}`;

const METAS: Record<IntegrationProvider, Omit<IntegrationProviderMeta, "provider">> = {
  quickbooks: {
    displayName: "QuickBooks (fake)",
    capabilities: ["kpi"],
    auth: "oauth2",
    oauth: {
      authorizeUrl: "https://fake-vendor.test/quickbooks/authorize",
      tokenUrl: "https://fake-vendor.test/quickbooks/token",
      scopes: ["com.intuit.quickbooks.accounting"],
      pkce: false,
      scopeSeparator: " ",
    },
    scopeExplanation: ["reads reports"],
    subProcessor: { name: "Fake", purpose: "KPIs", region: "US", dpaUrl: "https://fake.test/dpa" },
  },
  xero: {
    displayName: "Xero (fake)",
    capabilities: ["kpi"],
    auth: "oauth2",
    oauth: {
      authorizeUrl: "https://fake-vendor.test/xero/authorize",
      tokenUrl: "https://fake-vendor.test/xero/token",
      scopes: ["offline_access", "accounting.reports.read"],
      pkce: true,
      scopeSeparator: " ",
    },
    scopeExplanation: ["reads reports"],
    subProcessor: { name: "Fake", purpose: "KPIs", region: "NZ", dpaUrl: "https://fake.test/dpa" },
  },
  slack: {
    displayName: "Slack (fake)",
    capabilities: ["chat"],
    auth: "oauth2",
    oauth: {
      authorizeUrl: "https://fake-vendor.test/slack/authorize",
      tokenUrl: "https://fake-vendor.test/slack/token",
      scopes: ["chat:write", "channels:read"],
      pkce: false,
      scopeSeparator: ",",
    },
    scopeExplanation: ["posts notifications"],
    subProcessor: { name: "Fake", purpose: "chat", region: "US", dpaUrl: "https://fake.test/dpa" },
  },
  stripe: {
    displayName: "Stripe (fake)",
    capabilities: ["kpi"],
    auth: "secret",
    credentialFields: [
      { key: "restrictedKey", label: "Restricted key", kind: "secret", required: true },
    ],
    scopeExplanation: ["reads charges"],
    subProcessor: { name: "Fake", purpose: "KPIs", region: "US", dpaUrl: "https://fake.test/dpa" },
  },
  calendly: {
    displayName: "Calendly (fake)",
    capabilities: ["booking"],
    auth: "secret",
    credentialFields: [
      {
        key: "personalAccessToken",
        label: "Personal access token",
        kind: "secret",
        required: true,
      },
    ],
    scopeExplanation: ["receives booking events"],
    subProcessor: {
      name: "Fake",
      purpose: "booking",
      region: "US",
      dpaUrl: "https://fake.test/dpa",
    },
  },
  calcom: {
    displayName: "Cal.com (fake)",
    capabilities: ["booking"],
    auth: "secret",
    credentialFields: [],
    scopeExplanation: ["receives booking events"],
    subProcessor: {
      name: "Fake",
      purpose: "booking",
      region: "EU",
      dpaUrl: "https://fake.test/dpa",
    },
  },
};

const LINK_HOSTS: Partial<Record<IntegrationProvider, readonly string[]>> = {
  calendly: ["calendly.com"],
  calcom: ["cal.com", "app.cal.com"],
};

export const FAKE_SIGNATURE_HEADER = "fake-webhook-signature";

/** Signs a fake booking webhook body the way `parseWebhook` below checks it. */
export function signFakeWebhook(
  secret: string,
  body: string,
  at: Date = new Date(),
): { headers: Headers; rawBody: Uint8Array } {
  const t = Math.floor(at.getTime() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return {
    headers: new Headers({
      "content-type": "application/json",
      [FAKE_SIGNATURE_HEADER]: `t=${t},v1=${v1}`,
    }),
    rawBody: new TextEncoder().encode(body),
  };
}

/** A fake webhook body: `{events: [{externalId, status, startsAt, endsAt?, inviteeEmail, …}]}`. */
export function fakeWebhookBody(
  events: readonly Partial<Record<keyof BookingEvent, string | null>>[],
): string {
  return JSON.stringify({ events });
}

export function createFakeVendor(provider: IntegrationProvider): FakeVendor {
  const calls: FakeVendorCalls = {
    exchange: 0,
    refresh: 0,
    verify: 0,
    kpi: 0,
    chat: 0,
    subscribe: 0,
    unsubscribe: [],
    revoke: [],
  };
  const meta: IntegrationProviderMeta = { provider, ...METAS[provider] };
  const vendor: FakeVendor = {
    adapter: undefined as unknown as IntegrationAdapter,
    calls,
    accessTokens: new Set(),
    refreshTokens: new Set(),
    refusedSecrets: new Set(),
    code: token("code"),
    accessTtlMs: 60 * 60_000,
    refreshDelayMs: 0,
    gate: undefined,
    failRefresh: undefined,
    failKpi: undefined,
    accounts: undefined,
    issue() {
      const set: OAuthTokenSet = {
        accessToken: token("at"),
        refreshToken: token("rt"),
        expiresAt: new Date(Date.now() + vendor.accessTtlMs),
        scope: meta.oauth?.scopes.join(" ") ?? null,
        externalAccountId: vendor.accounts?.[0]?.id ?? "acct-1",
        ...(vendor.accounts === undefined
          ? {}
          : { extra: { accounts: JSON.stringify(vendor.accounts) } }),
      };
      vendor.accessTokens.add(set.accessToken);
      if (set.refreshToken !== null) vendor.refreshTokens.add(set.refreshToken);
      return set;
    },
  };

  const accepts = (auth: IntegrationAuth): boolean => {
    if (meta.auth === "oauth2") return vendor.accessTokens.has(auth.accessToken);
    if (vendor.refusedSecrets.has(auth.accessToken)) return false;
    // A provider with no credential (Cal.com) has nothing to refuse.
    return auth.accessToken !== "" || (meta.credentialFields ?? []).length === 0;
  };
  const wait = async () => {
    if (vendor.gate !== undefined) await vendor.gate;
  };

  const adapter: IntegrationAdapter = {
    meta,
    async verify(auth) {
      calls.verify += 1;
      await wait();
      if (!accepts(auth)) return { ok: false, reason: "unauthorized" };
      return {
        ok: true,
        value: {
          accountLabel: `Fake ${provider} ${auth.externalAccountId ?? "account"}`,
          externalAccountId: auth.externalAccountId ?? "acct-1",
        },
      };
    },
    ...(meta.auth === "oauth2"
      ? {
          async exchangeCode(input) {
            calls.exchange += 1;
            calls.lastExchange = {
              code: input.code,
              codeVerifier: input.codeVerifier,
              query: { ...input.query },
              redirectUri: input.redirectUri,
            };
            if (input.code !== vendor.code) return { ok: false, reason: "unauthorized" };
            return { ok: true, value: vendor.issue() };
          },
          async refresh(input): Promise<IntegrationResult<OAuthTokenSet>> {
            calls.refresh += 1;
            if (vendor.refreshDelayMs > 0)
              await new Promise((r) => setTimeout(r, vendor.refreshDelayMs));
            if (vendor.failRefresh !== undefined) {
              const reason = vendor.failRefresh;
              vendor.failRefresh = undefined;
              return { ok: false, reason };
            }
            if (!vendor.refreshTokens.delete(input.refreshToken)) {
              return { ok: false, reason: "unauthorized" };
            }
            return { ok: true, value: vendor.issue() };
          },
          async revoke(input) {
            calls.revoke.push(input.token);
            vendor.refreshTokens.delete(input.token);
            vendor.accessTokens.delete(input.token);
          },
        }
      : {}),
    ...(meta.capabilities.includes("kpi")
      ? {
          kpi: {
            metrics: [
              {
                key: "revenue",
                label: "Revenue",
                kind: "flow",
                unit: "currency",
                historical: true,
              },
            ],
            async read(auth, req): Promise<IntegrationResult<KpiReadValue>> {
              calls.kpi += 1;
              await wait();
              if (vendor.failKpi !== undefined) return { ok: false, reason: vendor.failKpi };
              if (!accepts(auth)) return { ok: false, reason: "unauthorized" };
              return {
                ok: true,
                value: {
                  currency: "USD",
                  series: req.metrics.map((m) => ({
                    metric: m,
                    points: [{ month: req.fromMonth, value: "100.50" }],
                  })),
                },
              };
            },
          },
        }
      : {}),
    ...(meta.capabilities.includes("chat")
      ? {
          chat: {
            async listChannels(auth) {
              calls.chat += 1;
              if (!accepts(auth)) return { ok: false, reason: "unauthorized" };
              return { ok: true, value: [{ id: "C0001", name: "general", isPrivate: false }] };
            },
            async post(auth, channelId) {
              calls.chat += 1;
              if (!accepts(auth)) return { ok: false, reason: "unauthorized" };
              if (channelId !== "C0001") return { ok: false, reason: "not_found" };
              return { ok: true, value: undefined };
            },
          },
        }
      : {}),
    ...(meta.capabilities.includes("booking")
      ? {
          booking: {
            linkHosts: LINK_HOSTS[provider] ?? [],
            parseWebhook(input) {
              const header = input.headers[FAKE_SIGNATURE_HEADER] ?? "";
              const parts = Object.fromEntries(
                header.split(",").map((p) => {
                  const i = p.indexOf("=");
                  return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
                }),
              );
              const t = Number(parts["t"]);
              const v1 = parts["v1"] ?? "";
              if (!Number.isFinite(t) || !/^[0-9a-f]{64}$/u.test(v1)) {
                return { ok: false, reason: "unauthorized" };
              }
              const body = Buffer.from(input.rawBody).toString("utf8");
              const expected = createHmac("sha256", input.secret).update(`${t}.${body}`).digest();
              if (!timingSafeEqual(expected, Buffer.from(v1, "hex"))) {
                return { ok: false, reason: "unauthorized" };
              }
              if (Math.abs(input.now.getTime() / 1000 - t) > 300) {
                return { ok: false, reason: "unauthorized" };
              }
              try {
                const parsed = JSON.parse(body) as { events?: Record<string, string | null>[] };
                const events: BookingEvent[] = (parsed.events ?? []).map((e) => ({
                  externalId: String(e["externalId"]),
                  status: (e["status"] ?? "booked") as BookingEvent["status"],
                  startsAt: new Date(String(e["startsAt"])),
                  endsAt: e["endsAt"] ? new Date(String(e["endsAt"])) : null,
                  inviteeEmail: String(e["inviteeEmail"]),
                  inviteeName: e["inviteeName"] ?? null,
                  eventName: e["eventName"] ?? null,
                }));
                return { ok: true, value: events };
              } catch {
                return { ok: false, reason: "malformed" };
              }
            },
            ...(provider === "calendly"
              ? {
                  async subscribe(auth: IntegrationAuth) {
                    calls.subscribe += 1;
                    if (!accepts(auth))
                      return { ok: false as const, reason: "unauthorized" as const };
                    return {
                      ok: true as const,
                      value: { subscriptionId: `sub-${calls.subscribe}` },
                    };
                  },
                  async unsubscribe(_auth: IntegrationAuth, id: string) {
                    calls.unsubscribe.push(id);
                  },
                }
              : {}),
          },
        }
      : {}),
  };
  (vendor as { adapter: IntegrationAdapter }).adapter = adapter;
  return vendor;
}
