import type { TenantContext } from "@fundroom/db";
import type { PageDoc } from "@fundroom/module-content";
import type { BlockHydrationContext, ModuleServices } from "@fundroom/module-kit";
import type { JsonObject } from "@fundroom/ports";
import { describe, expect, it } from "vitest";
import type { Reader } from "../model.js";
import { renderUpdateEmail } from "../render/email.js";
import type { PostVersion, Send } from "../schema/updates.js";
import {
  blockHydration,
  describeError,
  EMAIL_HYDRATED_BLOCKS,
  hydrationKey,
  sectionsFor,
  sendInstant,
} from "./delivery.js";

/*
 * The send path's half of E2.4 §10 and decision D5.
 *
 * The property these tests exist for is the one nothing else in the repo would catch: **the
 * chart URL identifies an audience, never a person.** An `<img>` in an email is a tracking
 * pixel exactly when its URL identifies one reader, and this product ships none deliberately
 * (plan §15 E1.4). So two recipients who may see the same metrics must be handed a
 * byte-identical `<img src>`, and two who may not must not. Every other assertion here would
 * still pass if somebody put a recipient id in the token in six months; that one would not,
 * which is why it is spelled out twice — same audience, and different ones.
 *
 * The fake hydrators below stand in for `modules/metrics`, which this module must not import
 * (ADR-0007), so the shared-URL property is a property of the *seam* — what the send path hands
 * a hydrator and what it does with the answer — and not of metrics' arithmetic.
 *
 * **There are two of them, and the second one exists because the first cannot fail.** This file
 * used to claim that "every other assertion here would still pass if somebody put a recipient id
 * in the token in six months; that one would not". It would. The property is held by exactly one
 * line of production code — `hydrationKey`, which is the reader's kind and their sorted group ids
 * and nothing else — and a fake that mints its token *from the audience* hands two board readers
 * the same URL whether or not anything collapsed them: with the memo deleted, keyed per
 * recipient, or gone entirely, `toBe` would still be green. So `perCallHydrator` mints a URL that
 * is different on **every call**, which makes "these two readers were handed one URL" an
 * assertion about the memo key and not about the fake's arithmetic. `chartHydrator`, which mints
 * from the audience the way the real one does, keeps the other half: that gating survives, and a
 * reader admitted to fewer metrics is handed a different capability.
 */

const ctx = { workspaceId: "w1" } as unknown as TenantContext;

const ARCHIVE = "https://acme.test/updates/q3";

/** The send's own instant (`sendInstant`), which is what a run hands the hydrators. */
const AS_OF = new Date("2026-03-31T09:00:00.000Z");

/** One KPI grid: the block this path hydrates, in the section a reader's groups admit. */
const doc: PageDoc = {
  sections: [
    {
      key: "kpis",
      title: "How we are doing",
      blocks: [
        { id: "grid", type: "metric_grid", schemaVersion: 1, data: { definitionIds: ["d1"] } },
      ],
    },
  ],
} as unknown as PageDoc;

const version = { title: "Q3", doc, visibility: {} } as unknown as PostVersion;

const reader = (kind: Reader["kind"], ...groupIds: string[]): Reader => ({ kind, groupIds });

interface Recorded {
  readonly viewers: BlockHydrationContext[];
  readonly logs: { event: string; fields: Readonly<Record<string, unknown>> | undefined }[];
}

/**
 * `ModuleServices` as this path actually uses it: a hydrator registry and a log. Everything
 * else is left unbuilt on purpose — a fake that answered more than the code reads would invite
 * a test to assert against a shape nothing in production produces.
 */
function servicesWith(
  hydrate: (data: JsonObject, ctx: BlockHydrationContext) => Promise<JsonObject>,
  module = "metrics",
): { services: ModuleServices; recorded: Recorded } {
  const recorded: Recorded = { viewers: [], logs: [] };
  const services = {
    registry: {
      blockHydrators: new Map([
        [
          "metric_grid",
          {
            module,
            hydrator: {
              type: "metric_grid",
              hydrate: (data: JsonObject, c: BlockHydrationContext) => {
                recorded.viewers.push(c);
                return hydrate(data, c);
              },
            },
          },
        ],
      ]),
    },
    log: (event: string, fields?: Readonly<Record<string, unknown>>) => {
      recorded.logs.push({ event, fields });
    },
  } as unknown as ModuleServices;
  return { services, recorded };
}

/**
 * The fake metrics module. The "token" is a hash of the metrics this audience may see, which
 * is what `signChartToken` signs (§9.1: `d` is already audience-filtered at send time) — so
 * the URL is a function of the audience and of nothing else.
 */
const metricsFor = (r: BlockHydrationContext["viewer"]): { name: string; value: string }[] =>
  r.kind === "staff" || r.groupIds.includes("board")
    ? [
        { name: "ARR", value: "1240000" },
        { name: "Headcount", value: "42" },
      ]
    : [{ name: "Headcount", value: "42" }];

const chartHydrator = async (_data: JsonObject, c: BlockHydrationContext): Promise<JsonObject> => {
  const metrics = metricsFor(c.viewer);
  const token = metrics.map((m) => m.name).join("-");
  return {
    columns: 3,
    metrics: metrics.map((m) => ({
      id: m.name,
      key: m.name.toLowerCase(),
      name: m.name,
      unit: m.name === "ARR" ? "currency" : "count",
      currency: m.name === "ARR" ? "USD" : null,
      decimals: 0,
      direction: "up_good",
      latest: { periodKey: "2026-03", periodLabel: "Mar 2026", value: m.value },
      previous: null,
      sparkline: [m.value],
    })),
    chart: {
      url: `https://acme.test/api/v1/metrics/chart/${token}.png`,
      alt: `${metrics.map((m) => m.name).join(" and ")} by month, to March 2026.`,
      width: 600,
      height: 300,
    },
  };
};

/**
 * A hydrator that would hand every reader a URL of their own: one call, one nonce. Nothing in
 * the send path can tell it from the real one — which is the point. Under it, two readers can
 * only end up with the same `<img src>` if the send path collapsed them onto one hydration.
 */
function perCallHydrator(): (data: JsonObject, c: BlockHydrationContext) => Promise<JsonObject> {
  let calls = 0;
  return async (data, c) => {
    calls += 1;
    const hydrated = await chartHydrator(data, c);
    return {
      ...hydrated,
      chart: {
        url: `https://acme.test/api/v1/metrics/chart/call-${calls}.png`,
        alt: "KPIs by month, to March 2026.",
        width: 600,
        height: 300,
      },
    };
  };
}

async function emailFor(hydrate: ReturnType<typeof blockHydration>, r: Reader) {
  return renderUpdateEmail({
    title: version.title,
    sections: sectionsFor(version, r, new Map(), await hydrate(r)),
    workspaceName: "Acme",
    archiveUrl: ARCHIVE,
    unsubscribeUrl: undefined,
    postalAddress: null,
    footerNote: null,
    test: false,
  });
}

const srcOf = (html: string): string | undefined => /<img src="([^"]+)"/u.exec(html)?.[1];

describe("the chart URL in an update email", () => {
  it("is one URL for two recipients in the same audience, because the memo key says so", async () => {
    // Driven through a hydrator that mints a *different* URL on every call, so this assertion
    // fails the moment `hydrationKey` stops collapsing two readers of one audience — which is
    // the line, and the only line, that holds D5 up.
    const { services, recorded } = servicesWith(perCallHydrator());
    const hydrate = blockHydration(services, ctx, doc, new Set(["metrics"]), AS_OF);

    const ada = await emailFor(hydrate, reader("external", "board"));
    const grace = await emailFor(hydrate, reader("external", "board"));

    // D5: the token names the set of metrics an audience may see, never the reader. Two people
    // on the board list fetch one URL, so an open says "somebody on the board", never "Ada".
    expect(srcOf(ada.html)).toBeDefined();
    expect(srcOf(ada.html)).toBe(srcOf(grace.html));
    expect(recorded.viewers).toHaveLength(1);
    // And the same fact stated against the key itself: two board readers are one audience.
    expect(hydrationKey(reader("external", "board"))).toBe(
      hydrationKey(reader("external", "board")),
    );
  });

  it("is a different URL across audiences, and gating survives it", async () => {
    // This half wants the audience-shaped hydrator: what is being asserted is that a reader
    // admitted to fewer metrics is handed a different capability *and* fewer numbers.
    const { services } = servicesWith(chartHydrator);
    const hydrate = blockHydration(services, ctx, doc, new Set(["metrics"]), AS_OF);

    const ada = await emailFor(hydrate, reader("external", "board"));
    const lin = await emailFor(hydrate, reader("external", "angels"));

    expect(srcOf(lin.html)).not.toBe(srcOf(ada.html));
    expect(ada.html).toContain("ARR");
    expect(lin.html).not.toContain("ARR");
  });

  it("resolves once per audience, not once per recipient (C4)", async () => {
    const { services, recorded } = servicesWith(chartHydrator);
    const hydrate = blockHydration(services, ctx, doc, new Set(["metrics"]), AS_OF);

    await hydrate(reader("external", "board"));
    await hydrate(reader("external", "board"));
    // Group order is not identity: the same two groups in the other order is the same audience.
    await hydrate(reader("external", "angels", "board"));
    await hydrate(reader("external", "board", "angels"));
    await hydrate(reader("external", "angels"));

    expect(recorded.viewers.length).toBe(3);
  });

  it("keys staff apart from an external reader in no group", () => {
    // Both carry an empty group list — `deliver` builds a staff reader that way — but staff see
    // every metric and an unaffiliated external sees only what is published to everyone. Keyed
    // on the sorted groups alone they would collide and the first delivered would decide what
    // the other saw.
    expect(hydrationKey(reader("staff"))).not.toBe(hydrationKey(reader("external")));
    expect(hydrationKey(reader("external", "b", "a"))).toBe(
      hydrationKey(reader("external", "a", "b")),
    );
  });

  it("carries no membership id into the hydrator", async () => {
    const { services, recorded } = servicesWith(chartHydrator);
    await blockHydration(
      services,
      ctx,
      doc,
      new Set(["metrics"]),
      AS_OF,
    )(reader("external", "board"));
    // A per-person fact inside a per-audience memo is the bug that would make the URL a pixel.
    expect(recorded.viewers[0]?.viewer.membershipId).toBeUndefined();
  });

  it("hands the hydrator the send's instant rather than a clock reading", async () => {
    const { services, recorded } = servicesWith(chartHydrator);
    await blockHydration(
      services,
      ctx,
      doc,
      new Set(["metrics"]),
      AS_OF,
    )(reader("external", "board"));
    // The chart token carries an `asOf` (§9.1). Stamped from `now()` inside the hydrator it is a
    // function of *when a recipient was reached*, at millisecond precision — so a send resumed
    // half an hour after a crash would hand the rest of one audience a different URL. Coming
    // down from here, it is a function of the send.
    expect((recorded.viewers[0] as { asOf?: Date } | undefined)?.asOf).toEqual(AS_OF);
  });
});

describe("the instant a send renders as of", () => {
  it("is the send row's created_at, which a retry cannot move", () => {
    // `started_at` is stamped on the `queued → running` transition and is null before it;
    // `finished_at` does not exist while the send is running; `created_at` is written once at
    // insert and is not in `SendRepo.update`'s patch type, so nothing can rewrite it.
    const s = {
      createdAt: new Date("2026-03-31T09:00:00.000Z"),
      startedAt: new Date("2026-03-31T09:00:31.000Z"),
      finishedAt: null,
    } as unknown as Send;
    expect(sendInstant(s)).toEqual(new Date("2026-03-31T09:00:00.000Z"));
    expect(sendInstant(s)).not.toEqual(s.startedAt);
  });
});

describe("turning a thrown value into a string", () => {
  it("never throws, whatever was thrown", () => {
    // `String(error)` — what this file used to spell inline — is a `TypeError` on a symbol and
    // on a null-prototype object, and a narrowing that throws inside a `catch` turns a failure
    // meant to degrade into one that stops the send.
    const nullProto = Object.create(null) as object;
    const hostile = {
      toString: () => {
        throw new Error("no");
      },
    };
    expect(() => describeError(Symbol("boom"))).not.toThrow();
    expect(() => describeError(nullProto)).not.toThrow();
    expect(() => describeError(hostile)).not.toThrow();
    expect(describeError(null)).toBe("null");
    expect(describeError(undefined)).toBe("undefined");
    expect(describeError(new Error("plain"))).toBe("plain");
    expect(describeError("bare string")).toBe("bare string");
    expect(describeError(nullProto)).toBe("[object Object]");
  });
});

describe("a KPI block that cannot be hydrated", () => {
  it("degrades to the archive link and the send continues", async () => {
    const { services, recorded } = servicesWith(async () => {
      throw new Error("chart token could not be minted");
    });
    const hydrate = blockHydration(services, ctx, doc, new Set(["metrics"]), AS_OF);

    const mail = await emailFor(hydrate, reader("external", "board"));

    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("View the KPIs on the web");
    expect(mail.text).toContain(`View the KPIs on the web: ${ARCHIVE}`);
    expect(recorded.logs).toContainEqual(
      expect.objectContaining({
        event: "updates.block_hydration_failed",
        fields: expect.objectContaining({ level: "warn", module: "metrics" }),
      }),
    );
  });

  it("degrades when the providing module is switched off in this workspace", async () => {
    const { services, recorded } = servicesWith(chartHydrator);
    const hydrate = blockHydration(services, ctx, doc, new Set<string>(), AS_OF);

    const mail = await emailFor(hydrate, reader("external", "board"));

    expect(recorded.viewers).toHaveLength(0);
    expect(mail.html).toContain("View the KPIs on the web");
  });
});

describe("a hydration failure on the pathological path", () => {
  /*
   * The two ways a `metric_grid` hydration can fail *without* a hydrator's ordinary `throw`
   * being caught, both of which used to be able to stop a send outright.
   */

  it("survives a throw value that String() refuses to convert", async () => {
    // `throw Object.create(null)` is a legal throw, and `String(error)` on it is a `TypeError`
    // — thrown from inside the `catch` that was supposed to be degrading the failure. The
    // assertion that pins the fix is the *shape* of the log: only the per-block guard names the
    // block and its module, so if the narrowing throws again this line stops being reached.
    const { services, recorded } = servicesWith(async () => {
      throw Object.create(null) as Error;
    });
    const hydrate = blockHydration(services, ctx, doc, new Set(["metrics"]), AS_OF);

    const mail = await emailFor(hydrate, reader("external", "board"));

    expect(mail.html).toContain("View the KPIs on the web");
    expect(recorded.logs).toContainEqual(
      expect.objectContaining({
        event: "updates.block_hydration_failed",
        fields: expect.objectContaining({
          level: "warn",
          blockType: "metric_grid",
          module: "metrics",
          error: "[object Object]",
        }),
      }),
    );
  });

  it("does not memoise a rejection as that audience's permanent answer", async () => {
    /*
     * A rejection from *outside* the per-block guard — here the log sink itself throwing, which
     * is reachable because the guard's `catch` logs. It used to be memoised, so every recipient
     * in that audience failed identically, their rows stayed `queued`, and each of the five
     * retries re-ran the same pill; and it was awaited outside `deliver`'s `try`, so it did not
     * fail those recipients, it abandoned the send.
     */
    let hydrations = 0;
    let logThrows = true;
    const recorded: Recorded = { viewers: [], logs: [] };
    const services = {
      registry: {
        blockHydrators: new Map([
          [
            "metric_grid",
            {
              module: "metrics",
              hydrator: {
                type: "metric_grid",
                hydrate: async (data: JsonObject, c: BlockHydrationContext) => {
                  recorded.viewers.push(c);
                  hydrations += 1;
                  if (hydrations === 1) throw new Error("chart token could not be minted");
                  return chartHydrator(data, c);
                },
              },
            },
          ],
        ]),
      },
      log: (event: string, fields?: Readonly<Record<string, unknown>>) => {
        recorded.logs.push({ event, fields });
        if (logThrows) {
          logThrows = false;
          throw new Error("the log sink is down");
        }
      },
    } as unknown as ModuleServices;
    const hydrate = blockHydration(services, ctx, doc, new Set(["metrics"]), AS_OF);

    // Ada's delivery degrades to the archive link rather than throwing out of `deliver`.
    const ada = await emailFor(hydrate, reader("external", "board"));
    expect(ada.html).toContain("View the KPIs on the web");

    // And the next reader of the same audience gets a fresh attempt, not the pill again.
    const grace = await emailFor(hydrate, reader("external", "board"));
    expect(hydrations).toBe(2);
    expect(srcOf(grace.html)).toBeDefined();
  });
});

describe("which blocks the send path hydrates", () => {
  it("is metric_grid only", () => {
    // `document_list` is deliberately absent: it resolves per-viewer grants and session-bound
    // gates, and this path has neither a membership id nor `RequestFacts` to give it.
    expect([...EMAIL_HYDRATED_BLOCKS]).toEqual(["metric_grid"]);
  });
});
