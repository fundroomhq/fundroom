import type { TenantContext, Tx } from "@fundroom/db";
import type { BlockHydrationContext, ModuleServices } from "@fundroom/module-kit";
import { describe, expect, it } from "vitest";
import { createRoundSummaryHydrator, type RoundSummaryHydrated } from "./hydrator.js";

/*
 * The `round_summary` block.
 *
 * The assertion that matters is the negative one: **an anonymous viewer gets `{}`** — not a
 * redacted payload, not a "sign in to see this" marker, nothing. EXECUTION_PLAN §47 says no
 * offering content is reachable anonymously, and a `round_summary` on a page the public can read
 * would be a general solicitation the workspace did not choose to make. Under 506(b) that is not
 * a UI mistake.
 */

const WORKSPACE = "01920000-0000-7000-8000-000000000001";
const ROUND = "01920000-0000-7000-8000-0000000000a1";
const tenant: TenantContext = { workspaceId: WORKSPACE, actorKind: "system" };
const NOW = new Date("2026-03-15T12:00:00.000Z");

function sqlText(node: unknown, out: string[] = []): string {
  if (node === null || typeof node !== "object") return out.join("");
  const c = node as Record<string, unknown>;
  const chunks = c["queryChunks"];
  if (Array.isArray(chunks)) {
    for (const k of chunks) sqlText(k, out);
    return out.join("");
  }
  const value = c["value"];
  if (!("encoder" in c) && Array.isArray(value)) out.push(...(value as string[]));
  return out.join("");
}

const ROUND_ROW = {
  id: ROUND,
  name: "Seed 2026",
  stage: "seed",
  instrumentKind: "safe",
  status: "open",
  targetAmount: "2000000.000000",
  currency: "USD",
  minimumInvestment: "25000.000000",
  opensAt: null,
  closesAt: null,
  openedAt: NOW,
  closedAt: null,
  showProgress: true,
  summary: "Hiring and 18 months of runway.",
  createdBy: null,
  createdAt: NOW,
  updatedAt: NOW,
};

const TERMS_ROW = {
  id: "01920000-0000-7000-8000-0000000000b1",
  roundId: ROUND,
  revision: 2,
  terms: {
    kind: "safe",
    variant: "post_money",
    valuationCap: "10000000",
    mfn: false,
    proRata: false,
  },
  termsSchemaVersion: 1,
  asOf: NOW,
  disclaimerStamp: "offering-disclaimer:v3",
  supersededBy: null,
  createdBy: null,
  createdAt: NOW,
};

const COMMITMENTS = [
  { ...commitmentRow("c1", "400000.000000", "soft") },
  { ...commitmentRow("c2", "600000.000000", "signed") },
];

function commitmentRow(id: string, amount: string, status: string) {
  return {
    id,
    roundId: ROUND,
    membershipId: null,
    organizationId: null,
    contactId: null,
    displayName: "Somebody",
    amount,
    status,
    note: null,
    interestSubmissionId: null,
    signedDocumentId: null,
    wiredAt: null,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

interface HarnessOptions {
  readonly round?: Record<string, unknown> | null | undefined;
  readonly terms?: Record<string, unknown> | null | undefined;
  readonly disclaimer?: boolean | undefined;
}

function harness(options: HarnessOptions = {}) {
  const logs: { event: string; fields?: Record<string, unknown> | undefined }[] = [];
  const contexts: TenantContext[] = [];
  const tx = {
    async execute(query: unknown) {
      const text = sqlText(query);
      if (text.includes("FROM round.round")) {
        return { rows: options.round === null ? [] : [{ ...ROUND_ROW, ...options.round }] };
      }
      if (text.includes("FROM round.terms")) {
        return { rows: options.terms === null ? [] : [{ ...TERMS_ROW, ...options.terms }] };
      }
      if (text.includes("FROM round.commitment")) return { rows: COMMITMENTS };
      throw new Error(`unexpected statement: ${text.trim().slice(0, 80)}`);
    },
  };
  return {
    db: {
      withTenant: <T>(ctx: TenantContext, fn: (tx: Tx) => Promise<T>) => {
        contexts.push(ctx);
        return fn(tx as unknown as Tx);
      },
    },
    legal: {
      async resolveDisclaimer() {
        return options.disclaimer === false
          ? undefined
          : {
              documentId: "doc",
              slug: "offering-disclaimer",
              title: "Important information",
              versionNo: 3,
              body: "Not an offer to sell.",
              bodySha256: "abc",
              effectiveAt: NOW,
            };
      },
    },
    now: () => NOW,
    log: (event: string, fields?: Record<string, unknown>) => logs.push({ event, fields }),
    __logs: logs,
    __contexts: contexts,
  } as unknown as ModuleServices;
}

const logsOf = (s: ModuleServices) =>
  (s as unknown as { __logs: { event: string; fields?: Record<string, unknown> }[] }).__logs;
const contextsOf = (s: ModuleServices) =>
  (s as unknown as { __contexts: TenantContext[] }).__contexts;

const viewerCtx = (kind: "anonymous" | "external" | "staff"): BlockHydrationContext =>
  ({ tenant, viewer: { kind, groupIds: [] }, facts: {} }) as unknown as BlockHydrationContext;

const hydrate = (services: ModuleServices, ctx: BlockHydrationContext) =>
  createRoundSummaryHydrator(services).hydrate({}, ctx) as unknown as Promise<
    Partial<RoundSummaryHydrated>
  >;

describe("round_summary hydration", () => {
  it("gives an anonymous viewer nothing at all, and says so in the log", async () => {
    /*
     * Not a redacted payload and not a marker: an empty object. A section is only reachable
     * anonymously when its rule is `public` and the workspace allows public sections, so the
     * anonymous viewer is an exact proxy for "this is a public section being read by the
     * public" — which is what §R asks to be refused.
     */
    const services = harness();
    expect(await hydrate(services, viewerCtx("anonymous"))).toEqual({});
    expect(logsOf(services)[0]?.event).toBe("round.summary_refused");
    expect(logsOf(services)[0]?.fields).toMatchObject({ reason: "anonymous_viewer" });
  });

  it("reads nothing at all for an anonymous viewer", async () => {
    // The refusal is before the query, so a public page carrying the block costs no database
    // work and cannot leak through a timing difference either.
    const services = harness();
    await hydrate(services, viewerCtx("anonymous"));
    expect(contextsOf(services)).toEqual([]);
  });

  it("gives a member the round, the terms, the disclaimer and the progress", async () => {
    const payload = await hydrate(harness(), viewerCtx("external"));
    expect(payload.round).toEqual({
      id: ROUND,
      name: "Seed 2026",
      stage: "seed",
      instrumentKind: "safe",
      status: "open",
      currency: "USD",
      targetAmount: "2000000.00",
      minimumInvestment: "25000.00",
    });
    expect(payload.terms).toMatchObject({ kind: "safe", valuationCap: "10000000" });
    expect(payload.disclaimer).toEqual({
      stamp: "offering-disclaimer:v3",
      title: "Important information",
      body: "Not an offer to sell.",
    });
    expect(payload.progress).toMatchObject({ currency: "USD", committed: "600000.00" });
  });

  it("carries no internal fields: no created_by, no summary prose, no revision ids", async () => {
    const payload = await hydrate(harness(), viewerCtx("external"));
    expect(Object.keys(payload.round ?? {}).sort()).toEqual([
      "currency",
      "id",
      "instrumentKind",
      "minimumInvestment",
      "name",
      "stage",
      "status",
      "targetAmount",
    ]);
  });

  it("honours showProgress for a member", async () => {
    // E2.5 D8: the absence *is* the setting, so the field is `null` rather than missing.
    const payload = await hydrate(
      harness({ round: { showProgress: false } }),
      viewerCtx("external"),
    );
    expect(payload.progress).toBeNull();
    expect(payload.round).toBeDefined();
  });

  it("shows staff the figures whatever showProgress says", async () => {
    // The admin preview is where the decision is checked; hiding them there would hide the
    // thing being decided.
    const payload = await hydrate(harness({ round: { showProgress: false } }), viewerCtx("staff"));
    expect(payload.progress).toMatchObject({ total: "1000000.00" });
  });

  it("folds the buckets in a system context, because commitments are staff-only in RLS", async () => {
    const services = harness();
    await hydrate(services, viewerCtx("external"));
    // The round and its terms are read as the viewer; only the roll-up goes off-fence, and only
    // the three aggregate figures come back.
    expect(contextsOf(services).map((c) => c.actorKind)).toEqual(["system", "system"]);
  });

  it("gives an empty payload when the workspace has no round to show", async () => {
    // A workspace with the module on and nothing open or closed renders an empty block, not a
    // broken one: `unavailable: hydration_failed` would make the renderer apologise.
    expect(await hydrate(harness({ round: null }), viewerCtx("external"))).toEqual({});
  });

  it("renders without terms and without a disclaimer rather than failing", async () => {
    const payload = await hydrate(
      harness({ terms: null, disclaimer: false }),
      viewerCtx("external"),
    );
    expect(payload.terms).toBeNull();
    expect(payload.disclaimer).toBeNull();
    expect(payload.round).toBeDefined();
  });

  it("drops a revision whose stored body no longer validates", async () => {
    // One unreadable row must not take the page down for everybody, and it is unreadable
    // exactly when somebody needs the screen in order to fix it.
    const payload = await hydrate(
      harness({ terms: { terms: { kind: "safe", variant: "sideways" } } }),
      viewerCtx("external"),
    );
    expect(payload.terms).toBeNull();
    expect(payload.round).toBeDefined();
  });
});
